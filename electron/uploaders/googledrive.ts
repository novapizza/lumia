import { net } from 'electron'
import { open, stat } from 'fs/promises'
import type { UploadResult } from '../types'
import { localTimestamp } from '../utils'

const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

/** Returns true if the string looks like a real Drive file ID (not a folder
 *  name). Drive IDs are long, base64url-ish, and — crucially for telling them
 *  apart from human folder names — they're never all-letters. Real IDs reliably
 *  mix in digits, '-' and '_'; ordinary folder names like
 *  "CompanyScreenshotsArchive" are pure alphabetic CamelCase. So in addition to
 *  the length + charset check we require at least one non-letter character,
 *  which keeps long folder names from being mistaken for IDs (→ Drive 404). */
function looksLikeDriveId(s: string): boolean {
  return s.length >= 25 && /^[a-zA-Z0-9_-]+$/.test(s) && /[0-9_-]/.test(s)
}

/** Escape a value for use inside a single-quoted Drive query string literal.
 *  Drive's query syntax requires '\' and "'" to be backslash-escaped; without
 *  this a folder name containing an apostrophe produces a malformed query
 *  (HTTP 400). */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Find folder by name, returns its ID or null when no such folder exists.
 *  Throws on an API error so the caller doesn't mistake a transient/400 failure
 *  for "folder not found" and create a duplicate folder. */
async function findFolderByName(name: string, accessToken: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${escapeDriveQueryValue(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Folder lookup failed: HTTP ${res.status}: ${text}`)
  }
  const json = await res.json() as { files: { id: string }[] }
  return json.files[0]?.id ?? null
}

/** Create a folder and return its ID */
async function createFolder(name: string, accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create folder: ${text}`)
  }
  const json = await res.json() as { id: string }
  return json.id
}

export async function uploadToGoogleDrive(
  imageData: string,
  accessToken: string,
  folderId?: string,
  options?: { filename?: string; mimeType?: string }
): Promise<UploadResult> {
  if (!accessToken) {
    return { destination: 'google-drive', success: false, error: 'No access token — please connect Google Drive in Settings' }
  }

  // If folderId looks like a folder name (not a Drive ID), resolve it
  let resolvedFolderId = folderId
  if (folderId && !looksLikeDriveId(folderId)) {
    try {
      const found = await findFolderByName(folderId, accessToken)
      resolvedFolderId = found ?? await createFolder(folderId, accessToken)
    } catch (err) {
      return { destination: 'google-drive', success: false, error: `Folder error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  const mimeType = options?.mimeType ?? 'image/png'
  const ts = localTimestamp()
  const ext = mimeType.startsWith('video/webm') ? 'webm'
            : mimeType.startsWith('video/mp4') ? 'mp4'
            : mimeType === 'image/jpeg' ? 'jpg'
            : 'png'
  const filename = options?.filename ?? `capture-${ts}.${ext}`
  const base64 = imageData.replace(/^data:[^;]+;base64,/, '')

  // Build multipart/related body per Google Drive API v3
  const metadata: Record<string, unknown> = {
    name: filename,
    mimeType
  }
  if (resolvedFolderId) {
    metadata.parents = [resolvedFolderId]
  }

  const boundary = '----LumiaDriveBoundary'
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${base64}\r\n` +
    `--${boundary}--`

  const response = await fetch(GOOGLE_DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  })

  if (!response.ok) {
    const text = await response.text()
    return { destination: 'google-drive', success: false, error: `HTTP ${response.status}: ${text}` }
  }

  const json = await response.json() as { id: string; name: string }
  const viewUrl = `https://drive.google.com/file/d/${json.id}/view`

  return { destination: 'google-drive', success: true, url: viewUrl }
}

/** PUT a file to a URL, streaming it from disk through Electron's net stack
 *  with a known Content-Length. The body is written one bounded chunk at a
 *  time, awaiting each write's flush callback for backpressure — so a large
 *  recording never lands in memory (peak ≈ one chunk), unlike a `body: buffer`
 *  fetch which holds the whole file plus an undici copy. */
async function netPutFile(
  url: string,
  headers: Record<string, string>,
  filePath: string,
  size: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const req = net.request({ url, method: 'PUT', useSessionCookies: false })
  for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
  req.setHeader('Content-Length', String(size))

  // A connection error must be able to unblock a write we're awaiting — the
  // flush callback never fires once the socket is gone, so without this the
  // upload would hang forever on a mid-transfer network drop. `failed` rejects
  // on 'error'; it carries its own .catch so it never leaks an unhandled
  // rejection when nothing happens to be racing it.
  let failConnection: ((e: Error) => void) | null = null
  const failed = new Promise<never>((_, rej) => { failConnection = rej })
  failed.catch(() => { /* consumed via Promise.race below, or never rejected */ })

  // Attach response/error handlers synchronously, before any body is written.
  const responsePromise = new Promise<{ ok: boolean; status: number; body: string }>((resolve, reject) => {
    req.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      res.on('error', reject)
    })
    req.on('error', err => { reject(err); failConnection?.(err) })
  })

  const CHUNK = 1024 * 1024
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let position = 0
    while (position < size) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, position)
      if (bytesRead <= 0) break
      position += bytesRead
      // Copy out the slice: buf is reused for the next read, and the flush
      // callback only guarantees the chunk was accepted, not that the source
      // bytes are no longer referenced.
      const chunk = Buffer.from(buf.subarray(0, bytesRead))
      // write()'s flush callback (3rd arg) is the only backpressure signal —
      // Electron's ClientRequest.write returns void, not the usual boolean.
      // Race it against `failed` so a connection drop rejects instead of hangs.
      await Promise.race([
        new Promise<void>(res => req.write(chunk, undefined, () => res())),
        failed,
      ])
    }
    req.end()
  } catch (err) {
    try { req.abort() } catch { /* already gone */ }
    responsePromise.catch(() => { /* aborted — don't leak an unhandled rejection */ })
    throw err
  } finally {
    await fh.close()
  }

  return responsePromise
}

/**
 * Upload a file on disk (typically a video recording) using Google Drive's
 * resumable upload protocol. Multipart upload caps out at 5 MB, which most
 * screen recordings exceed, so we always use resumable here.
 *
 * Flow: POST metadata to start a session and read the upload URL out of the
 * Location header, then stream the bytes to that URL in a single PUT. Drive's
 * resumable protocol is sequential by design (one ordered session), so we don't
 * parallelise it — but streaming from disk keeps memory flat regardless of size,
 * which is what blew up before (the whole file sat in a Buffer + an undici copy).
 */
export async function uploadFileToGoogleDrive(
  filePath: string,
  contentType: string,
  filename: string,
  accessToken: string,
  folderId?: string
): Promise<UploadResult> {
  if (!accessToken) {
    return { destination: 'google-drive', success: false, error: 'No access token — please connect Google Drive in Settings' }
  }

  let resolvedFolderId = folderId
  if (folderId && !looksLikeDriveId(folderId)) {
    try {
      const found = await findFolderByName(folderId, accessToken)
      resolvedFolderId = found ?? await createFolder(folderId, accessToken)
    } catch (err) {
      return { destination: 'google-drive', success: false, error: `Folder error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  const size = (await stat(filePath)).size
  const metadata: Record<string, unknown> = { name: filename, mimeType: contentType }
  if (resolvedFolderId) metadata.parents = [resolvedFolderId]

  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify(metadata),
  })
  if (!initRes.ok) {
    const text = await initRes.text()
    return { destination: 'google-drive', success: false, error: `Upload init failed: HTTP ${initRes.status}: ${text}` }
  }
  const sessionUrl = initRes.headers.get('Location')
  if (!sessionUrl) {
    return { destination: 'google-drive', success: false, error: 'Upload init returned no session URL' }
  }

  const put = await netPutFile(sessionUrl, { 'Content-Type': contentType }, filePath, size)
  if (!put.ok) {
    return { destination: 'google-drive', success: false, error: `HTTP ${put.status}: ${put.body}` }
  }

  const json = JSON.parse(put.body) as { id: string; name: string }
  return { destination: 'google-drive', success: true, url: `https://drive.google.com/file/d/${json.id}/view` }
}

/**
 * Exchange an authorization code for tokens using Google OAuth2.
 */
export async function exchangeGoogleAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token exchange failed: ${text}`)
  }

  const json = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt: Date.now() + json.expires_in * 1000
  }
}

/**
 * Revoke a Google OAuth token (access or refresh). Revoking a refresh token also
 * invalidates all access tokens derived from it. Best-effort: returns without
 * throwing on network failure.
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  if (!token) return
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
}

/**
 * Refresh an expired access token.
 */
export async function refreshGoogleToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token refresh failed: ${text}`)
  }

  const json = await response.json() as { access_token: string; expires_in: number }

  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  }
}
