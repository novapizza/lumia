import { app, net } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import { join } from 'path'

const UNSPLASH_API = 'https://api.unsplash.com'

export interface UnsplashUser {
  name: string
  username: string
  link: string
}

export interface UnsplashPhoto {
  id: string
  description: string | null
  width: number
  height: number
  color: string | null
  blurHash: string | null
  urls: {
    raw: string
    full: string
    regular: string
    small: string
    thumb: string
  }
  links: {
    html: string
    downloadLocation: string
  }
  user: UnsplashUser
}

export interface UnsplashListResult {
  photos: UnsplashPhoto[]
  total: number
  totalPages: number
}

export interface WallpaperListOptions {
  query?: string
  page?: number
  perPage?: number
  orientation?: 'landscape' | 'portrait' | 'squarish'
  topic?: string
}

interface RawPhoto {
  id: string
  description: string | null
  alt_description: string | null
  width: number
  height: number
  color: string | null
  blur_hash: string | null
  urls: { raw: string; full: string; regular: string; small: string; thumb: string }
  links: { html: string; download_location: string }
  user: { name: string; username: string; links: { html: string } }
}

class UnsplashError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'UnsplashError'
  }
}

function getAccessKey(): string {
  const key = import.meta.env.MAIN_VITE_UNSPLASH_ACCESS_KEY
  if (!key) {
    throw new UnsplashError(0, 'Unsplash access key is not configured (MAIN_VITE_UNSPLASH_ACCESS_KEY)')
  }
  return key
}

function netGetJson(url: string, accessKey: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', useSessionCookies: false })
    req.setHeader('Authorization', `Client-ID ${accessKey}`)
    req.setHeader('Accept-Version', 'v1')
    req.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function unsplashGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const accessKey = getAccessKey()
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') search.set(k, String(v))
  }
  const qs = search.toString()
  const url = `${UNSPLASH_API}${path}${qs ? `?${qs}` : ''}`

  const { status, body } = await netGetJson(url, accessKey)
  if (status < 200 || status >= 300) {
    let msg = `Unsplash request failed (HTTP ${status})`
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) msg = parsed.errors.join('; ')
    } catch { /* ignore parse errors — keep default message */ }
    throw new UnsplashError(status, msg)
  }
  return JSON.parse(body) as T
}

function normalizePhoto(raw: RawPhoto): UnsplashPhoto {
  return {
    id: raw.id,
    description: raw.description ?? raw.alt_description ?? null,
    width: raw.width,
    height: raw.height,
    color: raw.color,
    blurHash: raw.blur_hash,
    urls: raw.urls,
    links: { html: raw.links.html, downloadLocation: raw.links.download_location },
    user: { name: raw.user.name, username: raw.user.username, link: raw.user.links.html },
  }
}

/**
 * Lumia clamps Unsplash's `per_page` (capped at 30 by the API) to keep grid
 * loads predictable. Higher pages help large screens; lower ones reduce
 * bandwidth on first paint.
 */
export const WALLPAPER_PER_PAGE_DEFAULT = 24

export async function listWallpapers(opts: WallpaperListOptions = {}): Promise<UnsplashListResult> {
  const perPage = Math.max(1, Math.min(30, opts.perPage ?? WALLPAPER_PER_PAGE_DEFAULT))
  const page = Math.max(1, opts.page ?? 1)

  // Search endpoint when a query/topic is supplied; /photos endpoint for the
  // editorial feed. The two return slightly different shapes, normalised below.
  if (opts.query && opts.query.trim().length > 0) {
    const data = await unsplashGet<{ results: RawPhoto[]; total: number; total_pages: number }>(
      '/search/photos',
      { query: opts.query.trim(), page, per_page: perPage, orientation: opts.orientation }
    )
    return {
      photos: data.results.map(normalizePhoto),
      total: data.total,
      totalPages: data.total_pages,
    }
  }

  if (opts.topic && opts.topic.trim().length > 0) {
    const list = await unsplashGet<RawPhoto[]>(
      `/topics/${encodeURIComponent(opts.topic.trim())}/photos`,
      { page, per_page: perPage, orientation: opts.orientation }
    )
    return { photos: list.map(normalizePhoto), total: list.length, totalPages: page }
  }

  const list = await unsplashGet<RawPhoto[]>(
    '/photos',
    { page, per_page: perPage, order_by: 'popular' }
  )
  return { photos: list.map(normalizePhoto), total: list.length, totalPages: page }
}

export async function getWallpaper(id: string): Promise<UnsplashPhoto> {
  const raw = await unsplashGet<RawPhoto>(`/photos/${encodeURIComponent(id)}`)
  return normalizePhoto(raw)
}

/**
 * Per Unsplash API guidelines, hitting the download_location endpoint counts as
 * an official "download" — required when the user picks a photo to actually
 * use. This call returns a fresh URL but Lumia ignores it; we keep the user on
 * the canonical `urls.full` for setting wallpapers. Errors here are non-fatal.
 */
export async function trackWallpaperDownload(downloadLocation: string): Promise<void> {
  try {
    const accessKey = getAccessKey()
    await netGetJson(downloadLocation, accessKey)
  } catch (err) {
    console.warn('[wallpapers] download tracking failed', err)
  }
}

export function isUnsplashConfigured(): boolean {
  return Boolean(import.meta.env.MAIN_VITE_UNSPLASH_ACCESS_KEY)
}

// ── Set as Wallpaper ─────────────────────────────────────────────────────

function getWallpapersDir(): string {
  return join(app.getPath('userData'), 'wallpapers')
}

async function ensureWallpapersDir(): Promise<string> {
  const dir = getWallpapersDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Download a Unsplash image to userData/wallpapers/{id}.jpg. Returns the
 * absolute path. If the file already exists with non-zero size we treat it as
 * a cache hit and skip the network call — Unsplash photo URLs are
 * content-stable, so a re-download would just spend bandwidth.
 *
 * Always uses `urls.full` per the user's preference (high quality at the cost
 * of a few MB per photo).
 */
export async function downloadWallpaper(photo: UnsplashPhoto): Promise<string> {
  const dir = await ensureWallpapersDir()
  const filePath = join(dir, `${photo.id}.jpg`)

  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 0) return filePath
  } catch {
    // missing — fall through to download
  }

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const req = net.request({ url: photo.urls.full, method: 'GET', useSessionCookies: false, redirect: 'follow' })
    req.on('response', res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Wallpaper download failed (HTTP ${res.statusCode})`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })

  await fs.writeFile(filePath, buffer)
  return filePath
}

/**
 * Apply the given local image file as the desktop wallpaper. v1: same image
 * on every connected display.
 *
 * Windows: SystemParametersInfoW(SPI_SETDESKWALLPAPER) via koffi. The flags
 *   SPIF_UPDATEINIFILE | SPIF_SENDCHANGE persist the change in the user's
 *   profile and broadcast WM_SETTINGCHANGE so Explorer repaints immediately.
 *
 * macOS: osascript drives "System Events" to set every desktop's picture.
 *   Sandboxed — no entitlement required since we're calling osascript from a
 *   helper process, not poking the WindowServer ourselves.
 */
async function setWallpaperWindows(filePath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const SystemParametersInfoW = user32.func(
    'bool __stdcall SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, str16 pvParam, uint32_t fWinIni)'
  )
  const SPI_SETDESKWALLPAPER = 0x0014
  const SPIF_UPDATEINIFILE = 0x01
  const SPIF_SENDCHANGE    = 0x02
  const ok = SystemParametersInfoW(
    SPI_SETDESKWALLPAPER,
    0,
    filePath,
    SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
  )
  if (!ok) throw new Error('SystemParametersInfoW returned false')
}

async function setWallpaperMac(filePath: string): Promise<void> {
  // POSIX path is what `set picture` expects on macOS.
  const script = `tell application "System Events" to set picture of every desktop to "${filePath.replace(/"/g, '\\"')}"`
  await new Promise<void>((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString().trim() || err.message))
      } else {
        resolve()
      }
    })
  })
}

export async function setDesktopWallpaper(photo: UnsplashPhoto): Promise<{ filePath: string }> {
  const filePath = await downloadWallpaper(photo)
  if (process.platform === 'win32') {
    await setWallpaperWindows(filePath)
  } else if (process.platform === 'darwin') {
    await setWallpaperMac(filePath)
  } else {
    throw new Error(`Setting wallpaper is not supported on ${process.platform}`)
  }
  return { filePath }
}
