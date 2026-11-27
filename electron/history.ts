import { existsSync, readFileSync, unlinkSync } from 'fs'
import { EditHistoryStore } from './edit-history'
import { unlink } from 'fs/promises'
import { join, resolve, normalize } from 'path'
import type { HistoryItem } from './types'
import { isAllowedPath } from './capture-folder'
import { thumbnailPathFor, writeThumbnailBytesFromDataUrl, writtenAt } from './thumbnail'
import { withStamps } from './row-stamps'
import { dayHistoryFor, forgetDayHistory, dayKey, type DayHistory, type HistoryStats } from './history-days'

/**
 * Capture history: one file per day plus history_stat.json (storage in
 * history-days.ts, design in design/HISTORY-BY-DAY.md). This class adds the
 * Electron-side parts: migrating the old single history.json, unlinking a
 * row's files on delete / prune, and telling listeners which days changed.
 *
 * One instance for the whole app (created in index.ts, shared through
 * getHistoryStore() and passed to WorkflowEngine), so its caches never go
 * stale against another copy.
 */
export class HistoryStore {
  private store: DayHistory
  private readonly listeners: ((days: string[]) => void)[] = []

  /** Saved image-editor edit steps, removed with their row (2026-11-23). */
  readonly editHistory: EditHistoryStore

  /** The folder the current history lives in (useRoot). */
  private root: string
  /** For a file saved into an earlier save folder (a recording that began
   *  before the folder changed): that folder's history root, else null. */
  private rootForFile: ((filePath: string) => string | null) | null = null

  constructor(userDataDir: string) {
    this.root = userDataDir
    this.store = dayHistoryFor(userDataDir)
    this.editHistory = new EditHistoryStore(userDataDir)
    this.migrateLegacyFile(join(userDataDir, 'history.json'))
  }

  /** Read and write another history from here on: the save folder's
   *  (folder-history.ts, Settings › General › Save to). A fresh one is
   *  marked with the current cleanup version so the startup reset
   *  (runStartupCleanup) never empties it. The caller tells the window. */
  useRoot(root: string, stampVersion?: number): void {
    // Opened and stamped before it's used: if its folder can't be written,
    // this throws and the current history stays.
    const next = dayHistoryFor(root)
    try {
      if (stampVersion != null) next.importLegacy([], stampVersion)
    } catch (err) {
      forgetDayHistory(root)
      throw err
    }
    this.store = next
    this.root = root
  }

  setRootForFile(fn: (filePath: string) => string | null): void {
    this.rootForFile = fn
  }

  /** Add one row (moved from another folder's history); true once it's
   *  stored, false when that id is here already. */
  addRow(item: HistoryItem, cleanupVersion: number): boolean {
    // Already here (a move stopped halfway before): not stored again, so the
    // caller puts its files back.
    if (this.store.get(item.id)) return false
    try {
      const { days } = this.store.importLegacy([withStamps(item, writtenAt)], cleanupVersion)
      this.emit(days)
    } catch (err) {
      // Half written (the day file without the stats): take it out again, so
      // the caller's rollback leaves no row pointing at moved-back files.
      try { this.store.deleteMany([item.id]) } catch { /* nothing to undo */ }
      throw err
    }
    return this.store.get(item.id) != null
  }

  /** Every row of the current history. */
  allRows(): HistoryItem[] {
    return Object.values(this.store.getDays(this.store.getStats().days.map(d => d.day))).flat()
  }

  /** Add rows found in or moved to the save folder; ids already there are
   *  skipped. */
  addMany(items: HistoryItem[], cleanupVersion: number): number {
    const { added, days } = this.store.importLegacy(items.map(it => withStamps(it, writtenAt)), cleanupVersion)
    this.emit(days)
    return added
  }

  /** Called after every write with the day keys that changed. */
  onChange(listener: (days: string[]) => void): void {
    this.listeners.push(listener)
  }

  getStats(): HistoryStats {
    return this.store.getStats()
  }

  getDays(days: string[]): Record<string, HistoryItem[]> {
    return this.store.getDays(days)
  }

  get(id: string): HistoryItem | null {
    return this.store.get(id)
  }

  getRecent(limit: number, type?: HistoryItem['type']): HistoryItem[] {
    return this.store.getRecent(limit, type)
  }

  // Every write below puts the time a thumbnail or strip was written on its
  // row (withStamps): that's the version in the file's address.
  add(item: HistoryItem): void {
    item = withStamps(item, writtenAt)
    // A file written to an earlier save folder belongs to that folder's
    // history, not the one switched to while it was being made.
    const other = item.filePath ? this.rootForFile?.(item.filePath) : null
    if (other && other !== this.root) {
      dayHistoryFor(other).add(item)
      return
    }
    this.emit([this.store.add(item)])
  }

  update(id: string, patch: Partial<HistoryItem>): HistoryItem | null {
    const res = this.store.update(id, withStamps(patch, writtenAt))
    if (!res) return null
    this.emit([res.day])
    return res.item
  }

  /** Save row changes the window doesn't need to hear about: the file
   *  fingerprints and followed paths (file-relink.ts), read and sent along
   *  in the same response. One write per day, however many rows. */
  updateQuietMany(patches: { id: string; patch: Partial<HistoryItem> }[]): void {
    if (patches.length > 0) this.store.updateMany(patches.map(p => ({ id: p.id, patch: withStamps(p.patch, writtenAt) })))
  }

  /** Explicit user delete: also removes the original capture file. */
  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany([id])) > 0
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    // The day files are written synchronously before any await, so a
    // concurrent add() can't be lost to a stale snapshot.
    const { removed, days } = this.store.deleteMany(ids)
    this.emit(days)
    await Promise.all(removed.map(it => this.unlinkItemFiles(it, { originals: true })))
    return removed.length
  }

  /** Drop rows whose original is gone (Clear missing), leaving their edited
   *  or trimmed copy on disk: it can be the only file left of the user's
   *  work (2026-11-27). */
  async forgetMissing(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const { removed, days } = this.store.deleteMany(ids)
    this.emit(days)
    await Promise.all(removed.map(it => this.unlinkItemFiles(it, { originals: false, copies: false })))
    return removed.length
  }

  // Drops items older than `days` days. `days <= 0` means keep forever (no-op).
  // Unlinks each pruned item's source + sidecar files, like the manual delete.
  async pruneOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const res = this.store.pruneOlderThan(cutoff)
    this.emit(res.days)
    await Promise.all(res.removed.map(it => this.unlinkItemFiles(it, { originals: true })))
    return res.removed.length
  }

  // One-time data reset for upgrade paths where on-disk formats changed
  // enough that carrying the old history forward is worse than starting
  // fresh. Guarded by `cleanupVersion` in history_stat.json so it only runs
  // once per bump. Never deletes the user's original captures.
  async runStartupCleanup(targetVersion: number): Promise<number> {
    const removed = this.store.cleanupIfBelow(targetVersion)
    if (removed.length === 0) return 0
    this.emit([...new Set(removed.map(it => dayKey(it.timestamp)))])
    await Promise.all(removed.map(it => this.unlinkItemFiles(it, { originals: false })))
    return removed.length
  }

  private emit(days: string[]): void {
    if (days.length === 0) return
    for (const l of this.listeners) {
      try { l(days) } catch (err) { console.error('[history] change listener failed', err) }
    }
  }

  /**
   * First launch after the switch to day files: move the rows of the old
   * electron-store history.json into day files, then delete it (the capture
   * files in ~/Pictures/Lumia are the real data, no backup is kept). On any
   * error the file stays and the next launch retries; rows already moved
   * are skipped by id. Runs in the constructor, before any IPC is set up.
   */
  private migrateLegacyFile(path: string): void {
    if (!existsSync(path)) return
    try {
      const legacy = JSON.parse(readFileSync(path, 'utf8')) as { items?: HistoryItem[]; cleanupVersion?: number }
      const rows = moveInlineThumbnails(Array.isArray(legacy.items) ? legacy.items : [])
      const { added } = this.store.importLegacy(rows, legacy.cleanupVersion ?? 0)
      unlinkSync(path)
      console.log(`[history] moved ${added} row(s) from history.json to day files`)
    } catch (err) {
      console.error('[history] migrating history.json failed, will retry next launch', err)
    }
  }

  // Shared file cleanup for delete + prune + startup. Bounded to the home
  // directory and the save folders (isAllowedPath) so a tampered history
  // entry can't coax us into unlinking system files; ENOENT is swallowed
  // because the goal state (file gone) is already achieved. `originals`
  // gates whether the user's original capture (filePath, in the save folder)
  // is removed: only explicit user delete + retention prune opt in; startup
  // cleanup does not.
  private async unlinkItemFiles(item: HistoryItem, opts: { originals: boolean; copies?: boolean }): Promise<void> {
    const paths = [
      opts.originals ? item.filePath : undefined,
      opts.copies === false ? undefined : item.annotatedFilePath,
      // Thumbnails are app-managed artifacts — dropped in every mode.
      item.thumbnailFile ? thumbnailPathFor(item.thumbnailFile) : undefined,
      item.stripFile ? thumbnailPathFor(item.stripFile) : undefined,
    ].filter((p): p is string => !!p)
    await this.editHistory.remove(item.id)
    for (const p of paths) {
      try {
        const resolved = resolve(normalize(p))
        if (isAllowedPath(resolved)) await unlink(resolved)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('[history] failed to unlink', p, err)
        }
      }
    }
  }
}

// Rows written before thumbnails moved to files carry the JPEG inline as a
// data URL. Write each one out byte for byte (no re-encode) and keep just the
// file name, so day files never carry data URLs. A row whose write fails
// keeps its data URL, which the renderer still displays.
function moveInlineThumbnails(items: HistoryItem[]): HistoryItem[] {
  return items.map(it => {
    if (it.thumbnailFile || !it.thumbnailUrl?.startsWith('data:')) return it
    const file = writeThumbnailBytesFromDataUrl(it.id, it.thumbnailUrl)
    if (!file) return it
    const next: HistoryItem = { ...it, thumbnailFile: file }
    delete next.thumbnailUrl
    return next
  })
}
