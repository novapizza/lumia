import { stat, readdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { HistoryItem } from './types'

// Follow renames (2026-11-27): a file renamed or moved in Finder / Explorer
// keeps its identity, so its row follows it instead of showing Missing.
// Each row remembers a fingerprint of its original and of its edited /
// trimmed copy: the drive, the file's inode (macOS) or file id (Windows)
// and its size. When a path is gone, the folders Lumia knows are searched
// for a file with that fingerprint. The size guards against an inode reused
// by a new file after a delete. Saved the first time Lumia sees the file,
// so older rows join in once their day is read. No Electron imports
// (unit-tested).

/** "dev:ino:size", exact (bigint stat: Windows file ids pass 2^53), or null
 *  when the file isn't there. */
export async function fileKeyOf(path: string): Promise<string | null> {
  const s = await statOf(path)
  return s ? keyFrom(s) : null
}

type BigStats = Awaited<ReturnType<typeof bigStat>>
const bigStat = (path: string) => stat(path, { bigint: true })
async function statOf(path: string): Promise<BigStats | null> {
  try { return await bigStat(path) } catch { return null }
}
function keyFrom(s: BigStats): string | null {
  // ino 0: a drive without file ids (some exFAT / network mounts), where
  // every same-size file would look alike.
  if (!s.isFile() || s.ino === 0n) return null
  return `${s.dev}:${s.ino}:${s.size}`
}

/** Fingerprints of the files in a folder, read once per folder and pass,
 *  with each file's creation time. */
export class FolderIndex {
  private readonly folders = new Map<string, Promise<Map<string, { path: string; born: number }>>>()

  async find(dir: string, key: string): Promise<{ path: string; born: number } | null> {
    let index = this.folders.get(dir)
    if (!index) {
      index = this.read(dir)
      this.folders.set(dir, index)
    }
    return (await index).get(key) ?? null
  }

  private async read(dir: string): Promise<Map<string, { path: string; born: number }>> {
    const out = new Map<string, { path: string; born: number }>()
    let names: string[]
    try { names = await readdir(dir) } catch { return out }
    await Promise.all(names.map(async name => {
      const p = join(dir, name)
      // One stat for both the fingerprint and the creation time.
      const s = await statOf(p)
      const key = s && keyFrom(s)
      if (!s || !key) return
      out.set(key, { path: p, born: Number(s.birthtimeMs) })
    }))
    return out
  }
}

/** Whether a file is there, and its fingerprint, from one stat. Only "no
 *  such file" counts as gone: a transient error (a drive waking, no
 *  permission) or a file without a usable fingerprint (ino 0) is still
 *  there. */
async function probe(path: string): Promise<{ there: boolean; key: string | null }> {
  try {
    return { there: true, key: keyFrom(await bigStat(path)) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { there: code !== 'ENOENT' && code !== 'ENOTDIR', key: null }
  }
}

/** A renamed original was made when it was captured; a file made well
 *  after that is a new file that reused a freed file id, not the original. */
const BORN_SLACK_MS = 10 * 60 * 1000

export interface Relinked {
  /** The row with followed paths and fresh fingerprints. */
  item: HistoryItem
  /** What changed, to save; empty when nothing did. */
  patch: Partial<HistoryItem>
  /** The original is gone and couldn't be found. */
  missing: boolean
}

/** Check a row's files: fingerprint the ones that are there, look for the
 *  ones that aren't in their folder and in `extraDirs` (the save folder). */
export async function relinkRow(row: HistoryItem, index: FolderIndex, extraDirs: string[] = []): Promise<Relinked> {
  const patch: Partial<HistoryItem> = {}
  let missing = false
  const follow = async (path: string, key: string | undefined, bornBy?: number): Promise<{ path: string; key: string } | null> => {
    if (!key) return null
    for (const dir of [dirname(path), ...extraDirs.filter(d => d !== dirname(path))]) {
      const found = await index.find(dir, key)
      if (!found) continue
      if (bornBy !== undefined && found.born > 0 && found.born > bornBy) continue
      return { path: found.path, key }
    }
    return null
  }

  if (row.filePath) {
    const { there, key } = await probe(row.filePath)
    if (there) {
      if (key && key !== row.fileKey) patch.fileKey = key
    } else {
      const moved = await follow(row.filePath, row.fileKey, row.timestamp + BORN_SLACK_MS)
      if (moved) {
        patch.filePath = moved.path
        // The name shown is the file's name.
        if (row.name === basename(row.filePath)) patch.name = basename(moved.path)
      } else {
        missing = true
      }
    }
  }
  if (row.annotatedFilePath) {
    const { there, key } = await probe(row.annotatedFilePath)
    if (there) {
      if (key && key !== row.annotatedFileKey) patch.annotatedFileKey = key
    } else {
      const moved = await follow(row.annotatedFilePath, row.annotatedFileKey)
      if (moved) patch.annotatedFilePath = moved.path
    }
  }
  return { item: { ...row, ...patch }, patch, missing }
}
