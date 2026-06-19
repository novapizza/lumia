import { createHmac, createHash } from 'crypto'
import { net } from 'electron'
import { createReadStream } from 'fs'
import { readFile, stat, open } from 'fs/promises'
import type { UploadResult } from '../types'

function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function getSigningKey(secretKey: string, datestamp: string, region: string, service: string): Buffer {
  const kDate    = hmacSha256('AWS4' + secretKey, datestamp)
  const kRegion  = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

type NetResponse = {
  ok: boolean
  status: number
  headers: Record<string, string>
  text: () => Promise<string>
}

function netFetch(url: string, opts: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<NetResponse> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: opts.method, useSessionCookies: false })

    for (const [k, v] of Object.entries(opts.headers)) {
      req.setHeader(k, v)
    }

    req.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        // Chromium lowercases header names; normalise so callers can read e.g.
        // the multipart part ETag without guessing the casing.
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : (v as string)
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers,
          text: async () => body
        })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** RFC-3986 percent-encoding for SigV4 canonical query strings. encodeURIComponent
 *  leaves !'()* unescaped; SigV4 requires every reserved character encoded. */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** Canonical (and URL-ready) query string: keys sorted, key + value RFC-3986
 *  encoded, joined with '&'. The identical string is used in both the request
 *  URL and the SigV4 canonical request, so the signature can never drift from
 *  what the server canonicalises. */
function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map(k => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`).join('&')
}

const EMPTY_PAYLOAD_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function buildSigV4(opts: {
  method: string
  host: string
  path: string // encoded path starting with '/'
  canonicalQuery?: string // pre-built canonical query string (no leading '?')
  payloadHash: string
  accessKeyId: string
  secretAccessKey: string
  contentType?: string
}): { headers: Record<string, string>; amzdate: string } {
  const { method, host, path, canonicalQuery = '', payloadHash, accessKeyId, secretAccessKey, contentType } = opts
  const now        = new Date()
  const datestamp  = now.toISOString().slice(0, 10).replace(/-/g, '')
  const amzdate    = datestamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z'
  const region     = 'auto'
  const service    = 's3'

  const canonicalHeaders =
    (contentType ? `content-type:${contentType}\n` : '') +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`
  const signedHeaders = (contentType ? 'content-type;' : '') + 'host;x-amz-content-sha256;x-amz-date'

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, credentialScope, sha256hex(canonicalRequest)].join('\n')

  const signingKey = getSigningKey(secretAccessKey, datestamp, region, service)
  const signature  = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date':           amzdate,
    'Authorization':         authorization,
  }
  if (contentType) headers['Content-Type'] = contentType
  return { headers, amzdate }
}

/** Accepts either a base64 data URL (backwards-compatible image path) or a
 *  pre-decoded buffer + content-type (used for video uploads). */
export type R2UploadInput =
  | { dataUrl: string }
  | { buffer: Buffer; contentType: string; ext: string; keyPrefix?: string }

// Decode an image data URL, deriving content-type + extension from the actual
// `data:image/<type>` prefix (png/jpeg/webp) rather than assuming PNG — a JPEG
// dataUrl was previously stored with a .png key and image/png content-type.
function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; contentType: string; ext: string } {
  const mime = /^data:(image\/(png|jpeg|webp))/.exec(dataUrl)?.[1] ?? 'image/png'
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  return { buffer: Buffer.from(base64, 'base64'), contentType: mime, ext }
}

export async function uploadToR2(
  input: string | R2UploadInput,
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
  publicUrlBase?: string
): Promise<UploadResult> {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return { destination: 'r2', success: false, error: 'R2 credentials are not configured' }
  }

  // Normalise input: legacy string arg is treated as an image dataUrl.
  let buffer: Buffer
  let contentType: string
  let ext: string
  let keyPrefix = 'captures'
  if (typeof input === 'string') {
    ({ buffer, contentType, ext } = decodeImageDataUrl(input))
  } else if ('dataUrl' in input) {
    ({ buffer, contentType, ext } = decodeImageDataUrl(input.dataUrl))
  } else {
    buffer = input.buffer
    contentType = input.contentType
    ext = input.ext
    if (input.keyPrefix) keyPrefix = input.keyPrefix
  }

  const payloadHash = sha256hex(buffer)
  // Content-addressable key — identical bytes always map to the same URL, so
  // re-uploading the same file reuses the original object instead of creating
  // a duplicate.
  const key  = `${keyPrefix}/${payloadHash}.${ext}`
  const host = `${accountId}.r2.cloudflarestorage.com`
  const path = `/${bucket}/${key}`
  const url  = `https://${host}${path}`

  const publicUrl = publicUrlBase
    ? `${publicUrlBase.replace(/\/$/, '')}/${key}`
    : undefined

  try {
    // Cheap HEAD — if the object already exists, skip the PUT entirely.
    const headSig = buildSigV4({
      method: 'HEAD', host, path, payloadHash: EMPTY_PAYLOAD_SHA,
      accessKeyId, secretAccessKey,
    })
    const head = await netFetch(url, { method: 'HEAD', headers: headSig.headers })
    if (head.ok) {
      return { destination: 'r2', success: true, url: publicUrl }
    }

    const putSig = buildSigV4({
      method: 'PUT', host, path, payloadHash,
      accessKeyId, secretAccessKey, contentType,
    })
    const response = await netFetch(url, {
      method: 'PUT',
      headers: putSig.headers,
      body: buffer,
    })

    if (!response.ok) {
      const text = await response.text()
      return { destination: 'r2', success: false, error: `HTTP ${response.status}: ${text}` }
    }

    return { destination: 'r2', success: true, url: publicUrl }
  } catch (err) {
    return { destination: 'r2', success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── File uploads (recordings) — streamed + parallel multipart ───────────────
// The buffer path above held the whole file (plus an HTTP-layer copy) in RAM
// and pushed it over a single TCP stream — a 150 MB recording spiked memory to
// ~1 GB and never saturated the link. uploadFileToR2 streams from disk and, for
// anything bigger than MULTIPART_THRESHOLD, fans the parts across
// PART_CONCURRENCY connections. Peak memory is PART_SIZE × PART_CONCURRENCY,
// independent of file size.

// Multipart parts must be ≥5 MB (all but the last). 16 MB keeps small images on
// the cheaper single-PUT path while every real recording goes multipart.
const MULTIPART_THRESHOLD = 16 * 1024 * 1024
const PART_SIZE = 8 * 1024 * 1024
const PART_CONCURRENCY = 6

/** SHA-256 a file by streaming — yields the content-addressable key without
 *  ever holding the whole file in memory. */
function streamSha256Hex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(filePath)
    rs.on('error', reject)
    rs.on('data', (d) => hash.update(d as Buffer))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Initiate → upload parts in parallel → complete. Aborts the upload on any
 *  failure so R2 doesn't retain (and bill for) orphaned parts. Throws on error;
 *  the caller maps that to an UploadResult. */
async function multipartUpload(args: {
  filePath: string
  size: number
  host: string
  path: string
  baseUrl: string
  contentType: string
  accessKeyId: string
  secretAccessKey: string
}): Promise<void> {
  const { filePath, size, host, path, baseUrl, contentType, accessKeyId, secretAccessKey } = args

  // 1. Initiate.
  const initQuery = canonicalQuery({ uploads: '' })
  const initSig = buildSigV4({
    method: 'POST', host, path, canonicalQuery: initQuery,
    payloadHash: EMPTY_PAYLOAD_SHA, accessKeyId, secretAccessKey, contentType,
  })
  const initRes = await netFetch(`${baseUrl}?${initQuery}`, { method: 'POST', headers: initSig.headers })
  if (!initRes.ok) throw new Error(`multipart init HTTP ${initRes.status}: ${await initRes.text()}`)
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await initRes.text())?.[1]
  if (!uploadId) throw new Error('multipart init returned no UploadId')

  try {
    const partCount = Math.ceil(size / PART_SIZE)
    const etags = new Array<string>(partCount)
    const fh = await open(filePath, 'r')
    try {
      // Worker pool: each worker grabs the next part index, positional-reads
      // just that slice (concurrent pread on one handle is safe), uploads it,
      // and records its ETag. Memory stays at PART_SIZE × PART_CONCURRENCY.
      let nextPart = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = nextPart++
          if (i >= partCount) return
          const start = i * PART_SIZE
          const len = Math.min(PART_SIZE, size - start)
          const buf = Buffer.allocUnsafe(len)
          await fh.read(buf, 0, len, start)
          const partNumber = i + 1
          const q = canonicalQuery({ partNumber: String(partNumber), uploadId })
          const sig = buildSigV4({
            method: 'PUT', host, path, canonicalQuery: q,
            payloadHash: sha256hex(buf), accessKeyId, secretAccessKey,
          })
          const res = await netFetch(`${baseUrl}?${q}`, { method: 'PUT', headers: sig.headers, body: buf })
          if (!res.ok) throw new Error(`multipart part ${partNumber} HTTP ${res.status}: ${await res.text()}`)
          const etag = res.headers['etag']
          if (!etag) throw new Error(`multipart part ${partNumber} returned no ETag`)
          etags[i] = etag
        }
      }
      await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, () => worker()))
    } finally {
      await fh.close()
    }

    // 3. Complete — parts must be listed in order, so index off the array.
    const xml = '<CompleteMultipartUpload>' +
      etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>'
    const xmlBuf = Buffer.from(xml, 'utf8')
    const q = canonicalQuery({ uploadId })
    const sig = buildSigV4({
      method: 'POST', host, path, canonicalQuery: q,
      payloadHash: sha256hex(xmlBuf), accessKeyId, secretAccessKey, contentType: 'application/xml',
    })
    const res = await netFetch(`${baseUrl}?${q}`, { method: 'POST', headers: sig.headers, body: xmlBuf })
    const body = await res.text()
    // S3/R2 can return 200 with an <Error> body for CompleteMultipartUpload, so
    // a 2xx alone isn't proof of success.
    if (!res.ok || /<Error>/.test(body)) throw new Error(`multipart complete HTTP ${res.status}: ${body}`)
  } catch (err) {
    try {
      const q = canonicalQuery({ uploadId })
      const sig = buildSigV4({
        method: 'DELETE', host, path, canonicalQuery: q,
        payloadHash: EMPTY_PAYLOAD_SHA, accessKeyId, secretAccessKey,
      })
      await netFetch(`${baseUrl}?${q}`, { method: 'DELETE', headers: sig.headers })
    } catch { /* best-effort abort */ }
    throw err
  }
}

/** Upload a file already on disk to R2 — the path used for recordings (and any
 *  history item with a source file). Streams the content-addressable hash, does
 *  a cheap HEAD dedup, then either a single PUT (small files) or a parallel
 *  multipart upload (large files). */
export async function uploadFileToR2(
  filePath: string,
  opts: { contentType: string; ext: string; keyPrefix?: string },
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
  publicUrlBase?: string,
): Promise<UploadResult> {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return { destination: 'r2', success: false, error: 'R2 credentials are not configured' }
  }

  try {
    const size = (await stat(filePath)).size
    const fileHash = await streamSha256Hex(filePath)
    const keyPrefix = opts.keyPrefix ?? 'captures'
    const key  = `${keyPrefix}/${fileHash}.${opts.ext}`
    const host = `${accountId}.r2.cloudflarestorage.com`
    const path = `/${bucket}/${key}`
    const baseUrl = `https://${host}${path}`
    const publicUrl = publicUrlBase ? `${publicUrlBase.replace(/\/$/, '')}/${key}` : undefined

    // Cheap HEAD — identical bytes already uploaded → skip the transfer.
    const headSig = buildSigV4({
      method: 'HEAD', host, path, payloadHash: EMPTY_PAYLOAD_SHA, accessKeyId, secretAccessKey,
    })
    const head = await netFetch(baseUrl, { method: 'HEAD', headers: headSig.headers })
    if (head.ok) return { destination: 'r2', success: true, url: publicUrl }

    if (size <= MULTIPART_THRESHOLD) {
      const buffer = await readFile(filePath)
      const putSig = buildSigV4({
        method: 'PUT', host, path, payloadHash: fileHash,
        accessKeyId, secretAccessKey, contentType: opts.contentType,
      })
      const res = await netFetch(baseUrl, { method: 'PUT', headers: putSig.headers, body: buffer })
      if (!res.ok) return { destination: 'r2', success: false, error: `HTTP ${res.status}: ${await res.text()}` }
      return { destination: 'r2', success: true, url: publicUrl }
    }

    await multipartUpload({
      filePath, size, host, path, baseUrl,
      contentType: opts.contentType, accessKeyId, secretAccessKey,
    })
    return { destination: 'r2', success: true, url: publicUrl }
  } catch (err) {
    return { destination: 'r2', success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
