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

export interface RandomWallpaperPick {
  /** Opaque id, echoed back in the response so the renderer knows which
   *  category was actually rolled (for chip highlighting). */
  id: string
  /** Editorial topic slug — preferred when present because Unsplash topics are
   *  curated by their editorial team, giving consistently higher quality than
   *  free-text search. */
  topic?: string
  /** Free-text fallback when there's no editorial topic that matches. */
  query?: string
}

export interface RandomWallpaperOptions {
  /** User's selected categories. One is picked at random per call — rotating
   *  across refreshes is what gives variety, not blending per-call. */
  picks: RandomWallpaperPick[]
  /** Number of photos to fetch in the single random call. Default 6. */
  count?: number
  /** Default 'landscape' — desktop wallpapers are overwhelmingly landscape so
   *  it's the right baseline. Caller can pass 'portrait'/'squarish' if added
   *  to the UI later. */
  orientation?: 'landscape' | 'portrait' | 'squarish'
  /** When true (default) we hit Unsplash's `featured=true` pool first — only
   *  editorially-curated photos. If that pool returns fewer than half the
   *  requested count (niche topics can come up short), we retry without it
   *  to fill the grid. */
  preferFeatured?: boolean
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
 * Fetch random wallpapers from ONE randomly-picked category in the user's
 * favorites list. Variety across refreshes comes from rotating which pick
 * gets used, not from blending categories within one call.
 *
 * Quality strategy:
 *   - Prefer `topics` (editorial-curated slugs) over free-text `query`.
 *   - Hit `featured=true` first — Unsplash's editorial-photo pool.
 *   - `content_filter=high` for safety, `orientation=landscape` for desktops.
 *   - If `featured=true` returns fewer than half the requested count (niche
 *     topics can come up short), retry once without it to fill the grid.
 *
 * /photos/random returns a single object when called without `count`, but
 * always an array when `count` is set. We always pass `count`, so the response
 * is uniformly an array.
 */
export async function getRandomWallpapers(
  opts: RandomWallpaperOptions
): Promise<{ photos: UnsplashPhoto[]; pickId: string }> {
  const picks = (opts.picks ?? []).filter(p => p && (p.topic || p.query))
  if (picks.length === 0) {
    throw new UnsplashError(0, 'No categories selected')
  }
  const count = Math.max(1, Math.min(30, opts.count ?? 6))
  const orientation = opts.orientation ?? 'landscape'
  const preferFeatured = opts.preferFeatured ?? true
  const pick = picks[Math.floor(Math.random() * picks.length)]

  // `topics` (slug) wins over `query` per Unsplash semantics — they're
  // mutually exclusive on /photos/random. Topics are curated, query is search.
  const sourceParams: Record<string, string | number | undefined> = pick.topic
    ? { topics: pick.topic }
    : { query: pick.query }

  const baseParams = {
    ...sourceParams,
    count,
    orientation,
    content_filter: 'high',
  }

  let data = await unsplashGet<RawPhoto[]>('/photos/random', {
    ...baseParams,
    ...(preferFeatured ? { featured: 'true' } : {}),
  })
  let arr = Array.isArray(data) ? data : [data]

  // Featured pool can be too thin for niche topics — retry without it so the
  // grid actually fills up. Only retries when we *opted into* featured.
  if (preferFeatured && arr.length < Math.ceil(count / 2)) {
    data = await unsplashGet<RawPhoto[]>('/photos/random', baseParams)
    arr = Array.isArray(data) ? data : [data]
  }

  return { photos: arr.map(normalizePhoto), pickId: pick.id }
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

/**
 * Cap on how many JPGs we keep under userData/wallpapers/. Each file is
 * ~3–6 MB at full-res, so 20 ≈ 60–120 MB ceiling. Tuned to be invisible in
 * normal use but bounded enough that a heavy user setting hundreds of
 * wallpapers doesn't fill their disk.
 */
const WALLPAPER_CACHE_KEEP = 20

/**
 * Best-effort cleanup of older wallpapers under userData/wallpapers/. Sorts
 * files by mtime descending and unlinks anything past the keep cap. The
 * currently-applied file is filtered out by path as a second line of defense
 * so we never yank the file the OS just started displaying — even though
 * setDesktopWallpaper refreshes its mtime first, which alone should keep it
 * at the top of the sort.
 *
 * Failures are swallowed: a stale prune shouldn't bubble up and fail an
 * already-successful apply.
 */
async function pruneWallpapersDir(keep: number, currentFile: string): Promise<void> {
  try {
    const dir = getWallpapersDir()
    const names = await fs.readdir(dir)
    if (names.length <= keep) return
    const stats = await Promise.all(
      names.map(async name => {
        const full = join(dir, name)
        try {
          const s = await fs.stat(full)
          return { full, mtime: s.mtimeMs, isFile: s.isFile() }
        } catch {
          return null
        }
      })
    )
    const files = stats
      .filter((s): s is { full: string; mtime: number; isFile: boolean } => !!s && s.isFile)
      .sort((a, b) => b.mtime - a.mtime)
    const toDelete = files.slice(keep).filter(f => f.full !== currentFile)
    await Promise.all(toDelete.map(f => fs.unlink(f.full).catch(() => undefined)))
  } catch (err) {
    console.warn('[wallpapers] prune failed', err)
  }
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
  // Refresh mtime on a cache-hit re-apply so the pruner sees this file as
  // recently used and keeps it at the top of the LRU. Without this, applying
  // an older cached wallpaper would leave its mtime pointing back to the
  // original download timestamp and the pruner could delete the very file
  // we just told the OS to render.
  const now = new Date()
  await fs.utimes(filePath, now, now).catch(() => undefined)
  void pruneWallpapersDir(WALLPAPER_CACHE_KEEP, filePath)
  // Per Unsplash API guidelines, ping the download endpoint when the user
  // actually uses the photo (setting as wallpaper qualifies). Fire-and-
  // forget — `trackWallpaperDownload` already swallows its own errors so a
  // tracking failure can't fail the apply that already succeeded.
  if (photo.links?.downloadLocation) {
    void trackWallpaperDownload(photo.links.downloadLocation)
  }
  return { filePath }
}
