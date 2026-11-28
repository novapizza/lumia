import { ipcMain, nativeImage } from 'electron'
import { existsSync } from 'fs'
import type { HistoryStore } from './history'
import type { HistoryItem } from './types'
import { getSettings, setSetting } from './settings'
import { THUMB_MAX_WIDTH, thumbnailPathFor, writeThumbnail, writeThumbnailFromDataUrl, hasThumbnail } from './thumbnail'

/**
 * One-time re-render of history thumbnails at THUMB_MAX_WIDTH (they used to
 * be 300 px for screenshots, 480–640 px for recordings, which looks soft on
 * the 4:3 Dashboard cards). Screenshots are redrawn here from their files;
 * recordings need a video decoder, so the renderer grabs their frames
 * (src/lib/refresh-thumbnails.ts) and hands them back over IPC. When both
 * passes finish, settings.thumbnailVersion = TARGET_VERSION and this never
 * runs again.
 *
 * A row counts as done when its thumbnail is wider than the old maximum, so
 * a pass interrupted by quitting resumes where it stopped.
 */
// 3, not 2: a dev build marked 2 after a recording pass whose frame grabs
// all failed (tainted canvas), so 2 doesn't mean done.
const TARGET_VERSION = 3
const OLD_MAX_WIDTH = 640
/** Launches the recordings' pass may fail on before it's called done anyway
 *  (2026-11-27): a recording whose frame can't be read (a broken file) would
 *  otherwise keep the whole refresh, and its scan of every thumbnail, coming
 *  back on every launch for good. Its row just keeps its old preview. */
const MAX_TRIES = 3

function thumbWidth(item: HistoryItem): number {
  if (!item.thumbnailFile) return 0
  try {
    return nativeImage.createFromPath(thumbnailPathFor(item.thumbnailFile)).getSize().width
  } catch {
    return 0
  }
}

/** Rows whose thumbnail is still at an old size and whose source file
 *  exists. Each row's thumbnail is decoded to read its width, so the scan
 *  gives the main process back every few rows (it used to run through all
 *  of history in one go, a visible stall with many images). */
async function pending(store: HistoryStore, type: HistoryItem['type']): Promise<HistoryItem[]> {
  const days = store.getStats().days.filter(d => d[type] > 0).map(d => d.day)
  const out: HistoryItem[] = []
  let n = 0
  for (const day of days) {
    for (const it of store.getDays([day])[day] ?? []) {
      if (it.type !== type) continue
      if (++n % 10 === 0) await new Promise(r => setImmediate(r))
      const src = it.annotatedFilePath || it.filePath
      if (!src || !existsSync(src)) continue
      // A recording with no preview at all isn't an old, small one to
      // redo: the main window makes it (src/lib/strip-jobs.ts), in its own
      // order and not while recording. Listed here too, both would decode it.
      if (type === 'recording' && !hasThumbnail(it)) continue
      if (thumbWidth(it) > OLD_MAX_WIDTH) continue
      out.push(it)
    }
  }
  return out
}

let screenshotsDone = false
let recordingsDone = false

function maybeFinish(): void {
  if (screenshotsDone && recordingsDone) {
    setSetting('thumbnailVersion', TARGET_VERSION)
    console.log('[thumbnail] refresh complete')
  }
}

/** Redraw screenshot thumbnails from their files, one per tick so the main
 *  process stays responsive. */
async function refreshScreenshots(store: HistoryStore): Promise<void> {
  const rows = await pending(store, 'screenshot')
  let n = 0
  for (const it of rows) {
    await new Promise(r => setTimeout(r, 15))
    const src = it.annotatedFilePath || it.filePath!
    const img = nativeImage.createFromPath(src)
    if (img.isEmpty()) continue
    if (img.getSize().width <= thumbWidth(it)) continue // source no wider: nothing to gain
    const file = writeThumbnail(it.id, img, it.thumbnailFile)
    if (file) { store.update(it.id, { thumbnailFile: file }); n++ }
  }
  console.log(`[thumbnail] refreshed ${n} screenshot thumbnail(s) at ${THUMB_MAX_WIDTH}px`)
  screenshotsDone = true
  maybeFinish()
}

export function setupThumbnailRefresh(store: HistoryStore): void {
  const needed = getSettings().thumbnailVersion < TARGET_VERSION

  // Recordings: the renderer asks for the list, grabs a frame per row and
  // sends each back, then reports the pass done.
  ipcMain.handle('thumbnails:pending-recordings', async () => {
    if (!needed) return []
    return (await pending(store, 'recording')).map(it => ({
      id: it.id,
      // A trimmed copy starts at its own 0; an original uses the frame new
      // recordings use (a quarter in).
      path: it.annotatedFilePath || it.filePath!,
      trimmed: !!it.annotatedFilePath,
    }))
  })
  ipcMain.handle('thumbnails:set-recording', (_e, id: string, dataUrl: string) => {
    const it = store.get(id)
    if (!it || it.type !== 'recording') return false
    const file = writeThumbnailFromDataUrl(id, dataUrl, it.thumbnailFile)
    if (!file) return false
    store.update(id, { thumbnailFile: file })
    return true
  })
  ipcMain.handle('thumbnails:recordings-done', (_e, allOk: boolean) => {
    if (!allOk) {
      // Some frames failed: again next launch, a few times at most.
      const tries = (getSettings().thumbnailRefreshTries ?? 0) + 1
      setSetting('thumbnailRefreshTries', tries)
      if (tries < MAX_TRIES) return
      console.log(`[thumbnail] recordings still without a new thumbnail after ${tries} launches, leaving them`)
    }
    recordingsDone = true
    maybeFinish()
  })

  if (!needed) return
  setTimeout(() => {
    refreshScreenshots(store).catch(err => console.error('[thumbnail] screenshot refresh failed', err))
  }, 3000)
}
