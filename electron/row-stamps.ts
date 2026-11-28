/* When a row's preview and filmstrip files were written (no Electron here:
   unit-tested).

   A thumbnail keeps its file name when it's rewritten (thumbnail.ts), so
   its address needs a version for the window to reload it. That version
   used to be the file's modified time, read with a stat for every row of
   every day shown. Now it's on the row: `thumbnailStamp` / `stripStamp`,
   the time of the write, put there when the row is saved with the file's
   name (2026-11-27). Reading a day costs no file access for them. */
import type { HistoryItem } from './types'

const FIELDS = [
  ['thumbnailFile', 'thumbnailStamp'],
  ['stripFile', 'stripStamp'],
] as const

/** `patch` (or a whole new row) with its stamps set: a file named in it
 *  gets the time it was written this session (`writtenAt`), when there is
 *  one; a file taken off the row takes its stamp along. A row saved again
 *  with the same, unwritten file keeps the stamp it has. */
export function withStamps<T extends Partial<HistoryItem>>(patch: T, writtenAt: (file: string) => number | undefined): T {
  let out = patch
  for (const [file, stamp] of FIELDS) {
    if (!(file in patch)) continue
    const name = patch[file]
    if (!name) { out = { ...out, [stamp]: undefined }; continue }
    const at = writtenAt(name)
    if (at !== undefined) out = { ...out, [stamp]: at }
  }
  return out
}
