import { app, nativeImage } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import type { HistoryItem } from './types'

// History previews live as small JPEG files under userData/thumbnails/ and
// reach the renderer as lumia-media:// URLs. They used to be inlined into
// history.json as data URLs, which meant ~16 KB of base64 per row parsed on
// every read, shipped whole to the Dashboard on every mount, and decoded up
// front by Chromium (data: images are exempt from loading="lazy"). As files
// the JSON stays small and only thumbnails scrolled into view get fetched.

const THUMB_MAX_WIDTH = 300
const THUMB_JPEG_QUALITY = 60

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
 *  lumia-media protocol handler in index.ts (homedir-sandboxed). */
export function thumbnailUrlFor(file: string): string {
  return `lumia-media://stream/?path=${encodeURIComponent(thumbnailPathFor(file))}`
}

// File names embed the row id plus a write stamp: rewriting a thumbnail (an
// annotation save) yields a new URL, so the renderer never shows a stale
// cached image; the caller passes the previous name as `replace` so it gets
// unlinked once the new file is safely written.
function fileNameFor(id: string | undefined, ext: string): string {
  return `${id || randomUUID()}-${Date.now().toString(36)}.${ext}`
}

function commit(file: string, bytes: Buffer, replace?: string): string | undefined {
  try {
    writeFileSync(thumbnailPathFor(file), bytes)
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

/** Renderer view of a row: derive `thumbnailUrl` from `thumbnailFile`. Rows
 *  that still carry a legacy inline data URL pass through unchanged. */
export function resolveThumbnailUrl<T extends HistoryItem>(item: T): T {
  return item.thumbnailFile ? { ...item, thumbnailUrl: thumbnailUrlFor(item.thumbnailFile) } : item
}

/** Toast hero-image source for a row — the file when we have one, else the
 *  legacy inline data URL. */
export function thumbnailNotifyOpts(item: HistoryItem): { thumbnailPath?: string; thumbnailDataUrl?: string } {
  return item.thumbnailFile
    ? { thumbnailPath: thumbnailPathFor(item.thumbnailFile) }
    : { thumbnailDataUrl: item.thumbnailUrl }
}
