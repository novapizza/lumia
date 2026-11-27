import { app, nativeImage } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync, unlinkSync, renameSync } from 'fs'
import type { HistoryItem } from './types'

// History previews live as small JPEG files under userData/thumbnails/ and
// reach the renderer as lumia-media:// URLs. They used to be inlined into
// history.json as data URLs, which meant ~16 KB of base64 per row parsed on
// every read, shipped whole to the Dashboard on every mount, and decoded up
// front by Chromium (data: images are exempt from loading="lazy"). As files
// the JSON stays small and only thumbnails scrolled into view get fetched.

// 960 px: sharp on Retina for the largest Dashboard card, which shows a
// 4:3 crop of a 16:9 capture (matches THUMBNAIL_WIDTH in src/lib/video-frame.ts).
export const THUMB_MAX_WIDTH = 960
const THUMB_JPEG_QUALITY = 80

let dir: string | null = null
function thumbnailDir(): string {
  if (!dir) {
    dir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function thumbnailPathFor(file: string): string {
  return join(thumbnailDir(), file)
}

/** URL the renderer can put straight into <img src>; served by the
 *  lumia-media protocol handler in index.ts (home directory and save
 *  folders only, isAllowedPath). `v` is when the file was written, from the
 *  row (`thumbnailStamp` / `stripStamp`, row-stamps.ts): a rewritten
 *  thumbnail gets a new URL, so the renderer reloads it instead of showing
 *  its cached copy. No file access here (2026-11-27; it used to stat the
 *  file for its modified time, for every row of every day read). A row
 *  from before the stamps has none and gets 0 until its file is next
 *  written. */
export function thumbnailUrlFor(file: string, stamp?: number): string {
  return `lumia-media://stream/?path=${encodeURIComponent(thumbnailPathFor(file))}&v=${stamp ?? 0}`
}

// When each file was written this session, for the row's stamp: the row is
// saved right after the write, and HistoryStore puts the time on it then.
const written = new Map<string, number>()
/** When `file` was last written this session (undefined: not since launch). */
export function writtenAt(file: string): number | undefined {
  return written.get(file)
}

// One file per row, `<id>.<ext>`, overwritten on every rewrite (an
// annotation save after each edit, 2026-11-23). It used to get a new name
// per write (id + a stamp) with the old file deleted, so any view still
// holding the old address showed a broken image (the editor's Recent
// list); now the address stays valid and the URL's `v` busts the cache.
// Rows still on a stamped name move to the fixed one on their next write
// (`replace` is unlinked then).
function fileNameFor(id: string | undefined, ext: string): string {
  return id ? `${id}.${ext}` : `${randomUUID()}.${ext}`
}

function commit(file: string, bytes: Buffer, replace?: string): string | undefined {
  try {
    // Written beside it, then swapped in: a reader never gets half a file.
    const target = thumbnailPathFor(file)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
    // Always later than the last one, so two writes in one millisecond
    // still give two addresses.
    written.set(file, Math.max(Date.now(), (written.get(file) ?? 0) + 1))
  } catch (err) {
    console.error('[thumbnail] write failed', err)
    return undefined
  }
  if (replace && replace !== file) {
    try { unlinkSync(thumbnailPathFor(replace)) } catch { /* already gone */ }
  }
  return file
}

/** Downscale + JPEG-encode a NativeImage and write it. Returns the file name
 *  for `HistoryItem.thumbnailFile`, or undefined on failure (the row then
 *  simply renders without a preview). */
export function writeThumbnail(id: string | undefined, img: Electron.NativeImage, replace?: string): string | undefined {
  try {
    if (img.isEmpty()) return undefined
    const { width } = img.getSize()
    const resized = width > THUMB_MAX_WIDTH ? img.resize({ width: THUMB_MAX_WIDTH, quality: 'good' }) : img
    return commit(fileNameFor(id, 'jpg'), resized.toJPEG(THUMB_JPEG_QUALITY), replace)
  } catch (err) {
    console.error('[thumbnail] encode failed', err)
    return undefined
  }
}

/** Same, for callers that only hold a data URL (renderer-supplied frames). */
export function writeThumbnailFromDataUrl(id: string | undefined, dataUrl: string | undefined, replace?: string): string | undefined {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return undefined
  try {
    return writeThumbnail(id, nativeImage.createFromDataURL(dataUrl), replace)
  } catch {
    return undefined
  }
}

/** Migration helper: persist an already-thumbnail-sized data URL byte for
 *  byte (no decode / re-encode), keeping its container. */
export function writeThumbnailBytesFromDataUrl(id: string, dataUrl: string): string | undefined {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,/.exec(dataUrl)
  if (!m) return undefined
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  return commit(fileNameFor(id, ext), Buffer.from(dataUrl.slice(m[0].length), 'base64'))
}

// A recording's filmstrip for the video editor's trim bar (2026-11-27): one
// small WebP beside the thumbnail, `<id>-strip.webp`, 20 tiles of 214x120
// side by side (src/lib/filmstrip.ts), about 15 KB. The recorder sends it
// with the thumbnail; older recordings get theirs from a renderer
// (`filmstrip:save`). Written as it comes, no decode here.
/** Largest strip accepted: ten times a real one. */
const STRIP_MAX_BYTES = 1024 * 1024

/** Save a strip a renderer made. Returns the file name for
 *  `HistoryItem.stripFile`, or undefined when it isn't a WebP data URL, is
 *  too big, or can't be written. */
export function writeStripFromDataUrl(id: string, dataUrl: string | undefined): string | undefined {
  const head = 'data:image/webp;base64,'
  if (!dataUrl || !dataUrl.startsWith(head)) return undefined
  // base64: 4 characters per 3 bytes
  if ((dataUrl.length - head.length) * 3 / 4 > STRIP_MAX_BYTES) return undefined
  const bytes = Buffer.from(dataUrl.slice(head.length), 'base64')
  // RIFF....WEBP
  if (bytes.length < 16 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return undefined
  return commit(`${id}-strip.webp`, bytes)
}

/** The strip's address for the renderer, or undefined when the row has
 *  none. By the row, not the disk: a file deleted outside Lumia is found
 *  when the window fails to load it (`history:fileGone`). */
export function stripUrlFor(item: HistoryItem): string | undefined {
  return item.stripFile ? thumbnailUrlFor(item.stripFile, item.stripStamp) : undefined
}

/** Whether a row has a card preview (or it's a legacy row with the
 *  picture inline). By the row, like the strip. */
export function hasThumbnail(item: HistoryItem): boolean {
  return !!item.thumbnailFile || !!item.thumbnailUrl?.startsWith('data:')
}

/** Renderer view of a row: derive `thumbnailUrl` from `thumbnailFile`. Rows
 *  that still carry a legacy inline data URL pass through unchanged. */
export function resolveThumbnailUrl<T extends HistoryItem>(item: T): T {
  return item.thumbnailFile ? { ...item, thumbnailUrl: thumbnailUrlFor(item.thumbnailFile, item.thumbnailStamp) } : item
}

/** Toast hero-image source for a row — the file when we have one, else the
 *  legacy inline data URL. */
export function thumbnailNotifyOpts(item: HistoryItem): { thumbnailPath?: string; thumbnailDataUrl?: string } {
  return item.thumbnailFile
    ? { thumbnailPath: thumbnailPathFor(item.thumbnailFile) }
    : { thumbnailDataUrl: item.thumbnailUrl }
}
