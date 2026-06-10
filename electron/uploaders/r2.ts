import { createHmac, createHash } from 'crypto'
import { net } from 'electron'
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

function netFetch(url: string, opts: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
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
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
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

const EMPTY_PAYLOAD_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function buildSigV4(opts: {
  method: string
  host: string
  path: string // encoded path starting with '/'
  payloadHash: string
  accessKeyId: string
  secretAccessKey: string
  contentType?: string
}): { headers: Record<string, string>; amzdate: string } {
  const { method, host, path, payloadHash, accessKeyId, secretAccessKey, contentType } = opts
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

  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
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
