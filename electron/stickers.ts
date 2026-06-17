import { app, ipcMain, net } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

// Public base URL of the bucket that hosts `stickers.json` + the category PNG
// folders. Non-secret (reads are public), so a baked-in default keeps the
// feature working even without an .env entry; an env override lets us point at
// a staging/custom domain without a code change.
const STICKERS_BASE_URL = (
  import.meta.env.MAIN_VITE_STICKERS_BASE_URL ||
  'https://pub-eff91c9d9f9d4519b9734b2bbe278923.r2.dev'
).replace(/\/$/, '')

const NET_TIMEOUT_MS = 20_000
const MAX_BYTES = 8 * 1024 * 1024 // a sticker PNG is tens of KB; this is a sane guard
const MANIFEST_TTL_MS = 60 * 60 * 1000 // re-fetch the catalog at most hourly

type FetchResult = { status: number; buffer: Buffer }

/** Plain HTTPS GET via Electron's net stack (main process → no CORS, no creds).
 *  Buffers the body with a size cap + timeout, mirroring electron/wallpapers.ts. */
function netGet(url: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', useSessionCookies: false })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { req.abort() } catch { /* ignore */ }
      reject(new Error('Sticker request timed out'))
    }, NET_TIMEOUT_MS)
    req.on('response', res => {
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BYTES) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { req.abort() } catch { /* ignore */ }
          reject(new Error('Sticker response exceeded size cap'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) })
      })
      res.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err) } })
    })
    req.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err) } })
    req.end()
  })
}

// ── Manifest (in-memory cache with TTL) ─────────────────────────────────────
let manifestCache: { value: unknown; at: number } | null = null

async function loadManifest(force = false): Promise<unknown> {
  if (!force && manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.value
  }
  // r2.dev sends no Cache-Control (only ETag/Last-Modified), so Chromium's net
  // stack caches stickers.json heuristically and won't see new uploads for a
  // long time — even across restarts. A per-fetch cache-busting query param
  // forces a fresh copy. The in-memory TTL above still bounds how often we hit
  // the network; per-sticker PNGs (immutable paths) stay disk-cached as before.
  const { status, buffer } = await netGet(`${STICKERS_BASE_URL}/stickers.json?cb=${Date.now()}`)
  if (status !== 200) throw new Error(`Manifest fetch failed (HTTP ${status})`)
  const value = JSON.parse(buffer.toString('utf8'))
  manifestCache = { value, at: Date.now() }
  return value
}

// ── Per-sticker bytes (disk cache → data URL) ───────────────────────────────
// Loading remote images straight into the canvas would taint it and break
// canvas.toDataURL() (used for Save/Copy/Upload). Instead we fetch bytes here,
// cache them on disk, and hand the renderer a same-origin data URL — no taint,
// and previously-fetched stickers keep working offline.
const CACHE_DIR = join(app.getPath('userData'), 'sticker-cache')

/** Reject anything that could escape the cache dir or the base URL. Relative,
 *  forward-slashed paths only — exactly what the manifest contains. */
function isSafeRelPath(p: string): boolean {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    !p.startsWith('/') &&
    !p.includes('..') &&
    !p.includes('\\') &&
    !/^[a-z]+:/i.test(p) // no scheme (http:, file:, …)
  )
}

const memCache = new Map<string, string>() // relPath → data URL (session-hot)

async function fetchSticker(relPath: string): Promise<string> {
  if (!isSafeRelPath(relPath)) throw new Error('Invalid sticker path')
  const hot = memCache.get(relPath)
  if (hot) return hot

  // Disk cache key: hash the rel path so nested folders flatten to one file.
  const cacheFile = join(CACHE_DIR, createHash('sha1').update(relPath).digest('hex') + '.png')
  try {
    const cached = await readFile(cacheFile)
    const dataUrl = `data:image/png;base64,${cached.toString('base64')}`
    memCache.set(relPath, dataUrl)
    return dataUrl
  } catch { /* cache miss — fetch below */ }

  const { status, buffer } = await netGet(`${STICKERS_BASE_URL}/${relPath}`)
  if (status !== 200) throw new Error(`Sticker fetch failed (HTTP ${status})`)
  await mkdir(CACHE_DIR, { recursive: true }).catch(() => {})
  await writeFile(cacheFile, buffer).catch(() => {})
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
  memCache.set(relPath, dataUrl)
  return dataUrl
}

export function setupStickers(): void {
  ipcMain.handle('stickers:manifest', async (_e, opts?: { force?: boolean }) => {
    try {
      const manifest = await loadManifest(opts?.force)
      return { ok: true, manifest }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to load sticker manifest' }
    }
  })

  ipcMain.handle('stickers:fetch', async (_e, relPath: string) => {
    try {
      const dataUrl = await fetchSticker(relPath)
      return { ok: true, dataUrl }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to load sticker' }
    }
  })
}
