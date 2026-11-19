import { existsSync, readFileSync, unlinkSync } from 'fs'
import { unlink } from 'fs/promises'
import { join, resolve, normalize } from 'path'
import { homedir } from 'os'
import type { HistoryItem } from './types'
import { thumbnailPathFor, writeThumbnailBytesFromDataUrl } from './thumbnail'
import { DayHistory, dayKey, type HistoryStats } from './history-days'

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
  private readonly store: DayHistory
  private readonly listeners: ((days: string[]) => void)[] = []

  constructor(userDataDir: string) {
    this.store = new DayHistory(userDataDir)
    this.migrateLegacyFile(join(userDataDir, 'history.json'))
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

  add(item: HistoryItem): void {
    this.emit([this.store.add(item)])
  }

  update(id: string, patch: Partial<HistoryItem>): HistoryItem | null {
    const res = this.store.update(id, patch)
    if (!res) return null
    this.emit([res.day])
    return res.item
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

  // Shared file cleanup for delete + prune + startup. Bounded to the user's
  // home directory so a tampered history entry can't coax us into unlinking
  // system files; ENOENT is swallowed because the goal state (file gone) is
  // already achieved. `originals` gates whether the user's original capture
  // (filePath, under ~/Pictures/Lumia) is removed: only explicit user delete
  // + retention prune opt in; startup cleanup does not.
  private async unlinkItemFiles(item: HistoryItem, opts: { originals: boolean }): Promise<void> {
    const paths = [
      opts.originals ? item.filePath : undefined,
      item.annotatedFilePath,
      // Thumbnails are app-managed artifacts — dropped in every mode.
      item.thumbnailFile ? thumbnailPathFor(item.thumbnailFile) : undefined,
    ].filter((p): p is string => !!p)
    for (const p of paths) {
      try {
        const resolved = resolve(normalize(p))
        if (resolved.startsWith(homedir())) await unlink(resolved)
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
