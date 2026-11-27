import { createHash, randomUUID } from 'crypto'
import { readdir, stat, rename, copyFile, unlink, access, mkdir } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import { isInside, pathKey } from './path-rules'
export { pathKey } from './path-rules'
import { nativeImage } from 'electron'
import { dayHistoryFor, type DayHistory } from './history-days'
import { DEFAULT_CAPTURE_FOLDER } from './capture-folder'
export { isSuitableSaveFolder } from './capture-folder'
import { writeThumbnail } from './thumbnail'
import type { HistoryItem } from './types'

// History per save folder (Settings › General › Save to, 2026-11-27): the
// Dashboard shows the files of the current folder. The default folder keeps
// the history under userData/history; every other folder gets its own under
// userData/history-folders/<hash>/, so switching back brings its rows back.

/** Where the history of `folder` lives. */
export function historyRootFor(userDataDir: string, folder: string): string {
  const abs = resolve(folder)
  if (pathKey(abs) === pathKey(DEFAULT_CAPTURE_FOLDER)) return userDataDir
  const key = pathKey(abs)
  return join(userDataDir, 'history-folders', createHash('sha1').update(key).digest('hex').slice(0, 16))
}

/** Every row of a history. */
export function allRows(history: DayHistory | { getStats: DayHistory['getStats']; getDays: DayHistory['getDays'] }): HistoryItem[] {
  const days = history.getStats().days.map(d => d.day)
  return Object.values(history.getDays(days)).flat()
}

/** Lumia's own file names: capture-/recording- and the local time, maybe a
 *  "-2" a move added. Edited (-annotated) and trimmed (-trimmed-) copies
 *  belong to their original's row and are left out. */
const LUMIA_FILE = /^(capture|recording)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.(png|jpe?g|webm)$/i

/** Rows for Lumia files in `dir` that `rows` doesn't have yet (the folder
 *  was used by another Lumia, or files were put there in Finder). Images get
 *  a thumbnail now. A recording needs a video decoder for its preview, so
 *  it comes without one here and gets it, with its filmstrip, when its day
 *  is first read (the strip pass in index.ts, 2026-11-27; until then such
 *  recordings kept blank cards for good); its length the same way
 *  (queueDurationBackfill). */
export async function scanForNewFiles(dir: string, rows: HistoryItem[]): Promise<HistoryItem[]> {
  const known = new Set<string>()
  for (const r of rows) {
    if (r.filePath) known.add(pathKey(r.filePath))
    if (r.annotatedFilePath) known.add(pathKey(r.annotatedFilePath))
  }
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const found: HistoryItem[] = []
  let n = 0
  for (const name of names) {
    // Thumbnails are made on the main process: let it breathe.
    if (++n % 20 === 0) await new Promise(r => setImmediate(r))
    const m = LUMIA_FILE.exec(name)
    if (!m) continue
    const filePath = join(dir, name)
    if (known.has(pathKey(filePath))) continue
    let timestamp = new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime()
    if (!Number.isFinite(timestamp)) {
      try { timestamp = (await stat(filePath)).mtimeMs } catch { continue }
    }
    const id = randomUUID()
    const isVideo = m[1].toLowerCase() === 'recording'
    let thumbnailFile: string | undefined
    if (!isVideo) {
      try { thumbnailFile = writeThumbnail(id, nativeImage.createFromPath(filePath)) } catch { /* no preview */ }
    }
    found.push({ id, timestamp, name, filePath, thumbnailFile, type: isVideo ? 'recording' : 'screenshot', uploads: [] })
  }
  return found
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

/** `name` in `dir`, with "-2", "-3"… before the extension when taken. */
async function freeName(dir: string, name: string, taken: Set<string>): Promise<string> {
  const ext = extname(name)
  const stem = basename(name, ext)
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem}-${i}${ext}`)
    if (!taken.has(candidate) && !(await exists(candidate))) {
      taken.add(candidate)
      return candidate
    }
  }
}

/** Move a file; across drives (EXDEV) copy then delete, and a failed copy
 *  or delete leaves nothing behind at `to`. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  try {
    await copyFile(from, to)
    await unlink(from)
  } catch (err) {
    await unlink(to).catch(() => {})
    throw err
  }
}

/** Move the rows of the history at `fromRoot` (the save folder `fromDir`)
 *  into the current history, with their files that are in `fromDir` (an
 *  original, its edited or trimmed copy) moved to `toDir`. A path outside
 *  `fromDir` (a workflow's Save step wrote it elsewhere) stays as it is.
 *  Row by row, so a stop or crash midway loses nothing: a row's files move
 *  (rolled back if one fails), then the row is added to the current history
 *  (`addRow`, which says whether it's stored), and only then removed from
 *  the old one. A file that's already gone (a cloud-only row) gets the new
 *  folder's path, where a restore will put it. */
export async function moveRows(fromRoot: string, fromDir: string, toDir: string, addRow: (row: HistoryItem) => boolean): Promise<{ moved: number; failed: number }> {
  // Names handed out in this run, so two rows never get the same one (a
  // missing file's name isn't on disk to be seen).
  const taken = new Set<string>()
  await mkdir(toDir, { recursive: true })
  const from = dayHistoryFor(fromRoot)
  let moved = 0
  let failed = 0
  for (const row of allRows(from)) {
    const done: { from: string; to: string }[] = []
    try {
      const next: HistoryItem = { ...row }
      for (const key of ['filePath', 'annotatedFilePath'] as const) {
        const p = row[key]
        if (!p || !isInside(fromDir, p)) continue
        const to = await freeName(toDir, basename(p), taken)
        if (await exists(p)) {
          await moveFile(p, to)
          done.push({ from: p, to })
        }
        next[key] = to
      }
      if (!addRow(next)) throw new Error('not stored')
    } catch (err) {
      for (const d of done.reverse()) await moveFile(d.to, d.from).catch(() => {})
      failed++
      console.warn('[folder-history] could not move', row.filePath, (err as Error).message)
      continue
    }
    // Stored in the current history with its files moved: from here nothing
    // rolls back (the new row points at the moved files). A failed removal
    // only leaves a stale copy of the row in the old folder's history.
    moved++
    try {
      from.deleteMany([row.id])
    } catch (err) {
      console.warn('[folder-history] moved, but the old row stays', row.filePath, (err as Error).message)
    }
  }
  return { moved, failed }
}

/** How many rows the history at `root` holds. */
export function rowCount(root: string): number {
  return dayHistoryFor(root).getStats().total
}
