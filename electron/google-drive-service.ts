// Bridges the pure HTTP uploaders in `uploaders/googledrive` with the app's
// settings store: refreshes the access token if it's about to expire, falls
// back to the user's default Drive folder, and surfaces every failure as an
// `UploadResult` so callers (workflow engine, video IPC) can render errors
// inline without try/catch boilerplate.
import type { UploadResult } from './types'
import { getSettings, setSetting } from './settings'
import {
  refreshGoogleToken,
  uploadToGoogleDrive,
  uploadFileToGoogleDrive,
} from './uploaders/googledrive'

type Resolved<T> = { value: T } | { error: string }

// Shared in-flight refresh so concurrent uploads don't each fire a token
// refresh (Google rate-limits and the extra requests are wasteful). The first
// caller to need a refresh kicks it off; others await the same promise.
let inFlightRefresh: Promise<{ accessToken: string; expiresAt: number }> | null = null

function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  if (!inFlightRefresh) {
    const clientId = import.meta.env.MAIN_VITE_GDRIVE_CLIENT_ID
    const clientSecret = import.meta.env.MAIN_VITE_GDRIVE_CLIENT_SECRET
    inFlightRefresh = refreshGoogleToken(clientId, clientSecret, refreshToken)
      .then(refreshed => {
        setSetting('googleDriveAccessToken', refreshed.accessToken)
        setSetting('googleDriveTokenExpiresAt', refreshed.expiresAt)
        return refreshed
      })
      .finally(() => { inFlightRefresh = null })
  }
  return inFlightRefresh
}

// `force` bypasses the expiry check to refresh a token the server has revoked
// out from under us (surfaces as a 401 before the local expiry lapses).
async function ensureAccessToken(force = false): Promise<Resolved<string>> {
  const settings = getSettings()
  const { googleDriveAccessToken, googleDriveRefreshToken, googleDriveTokenExpiresAt } = settings

  if (googleDriveRefreshToken && (force || Date.now() >= googleDriveTokenExpiresAt - 60_000)) {
    try {
      const refreshed = await refreshAccessToken(googleDriveRefreshToken)
      return { value: refreshed.accessToken }
    } catch (err) {
      return { error: `Token refresh failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { value: googleDriveAccessToken }
}

// True when an UploadResult failed specifically because the access token was
// rejected (401) — the cue to force a single refresh-and-retry.
function isAuthError(result: UploadResult): boolean {
  return !result.success && /HTTP 401\b/.test(result.error ?? '')
}

function resolveFolder(folderId?: string): Resolved<string> {
  const folder = folderId || getSettings().googleDriveFolderId
  if (!folder) return { error: 'No Drive folder selected — choose one in Settings → Google Drive.' }
  return { value: folder }
}

function fail(error: string): UploadResult {
  return { destination: 'google-drive', success: false, error }
}

/** Upload an image data URL via multipart upload (≤5 MB). */
export async function uploadImageDataUrlToDrive(imageData: string, folderId?: string): Promise<UploadResult> {
  const token = await ensureAccessToken()
  if ('error' in token) return fail(token.error)
  const folder = resolveFolder(folderId)
  if ('error' in folder) return fail(folder.error)
  const result = await uploadToGoogleDrive(imageData, token.value, folder.value)
  if (!isAuthError(result)) return result
  // Server-revoked token — force one refresh and retry before giving up.
  const retryToken = await ensureAccessToken(true)
  if ('error' in retryToken) return fail(retryToken.error)
  return uploadToGoogleDrive(imageData, retryToken.value, folder.value)
}

/** Upload an arbitrary file buffer (used for video recordings) via the
 *  resumable upload protocol so it isn't capped at 5 MB. */
export async function uploadFileBufferToDrive(
  buffer: Buffer,
  contentType: string,
  filename: string,
  folderId?: string
): Promise<UploadResult> {
  const token = await ensureAccessToken()
  if ('error' in token) return fail(token.error)
  const folder = resolveFolder(folderId)
  if ('error' in folder) return fail(folder.error)
  const result = await uploadFileToGoogleDrive(buffer, contentType, filename, token.value, folder.value)
  if (!isAuthError(result)) return result
  // Server-revoked token — force one refresh and retry before giving up.
  const retryToken = await ensureAccessToken(true)
  if ('error' in retryToken) return fail(retryToken.error)
  return uploadFileToGoogleDrive(buffer, contentType, filename, retryToken.value, folder.value)
}
