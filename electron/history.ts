import Store from 'electron-store'
import { unlink } from 'fs/promises'
import { resolve, normalize } from 'path'
import { homedir } from 'os'
import type { HistoryItem } from './types'
import { thumbnailPathFor, writeThumbnailBytesFromDataUrl } from './thumbnail'

export class HistoryStore {
  private store: Store<{ items: HistoryItem[]; cleanupVersion?: number }>
  // In-memory cache of the items array for this instance. Populated lazily on
  // first read and kept in sync on every write, so repeated getAll/get within
  // one instance don't re-parse history.json each time. NOTE: this cache is
  // per-instance — two HistoryStore instances exist (WorkflowEngine + the IPC
  // layer) and do NOT share it, so each only trusts writes made through itself.
  // That's acceptable here because each instance always writes through its own
  // store.set (which refreshes its cache) before any await, so its cache never
  // lags its own mutations. Cross-instance staleness was already possible with
  // the previous read-from-disk approach (conf has no shared cache either).
  private cache: HistoryItem[] | null = null

  constructor() {
    this.store = new Store<{ items: HistoryItem[]; cleanupVersion?: number }>({
      name: 'history',
      defaults: { items: [] },
      // A corrupted history.json should reset to empty rather than crash the
      // app at first read.
      clearInvalidConfig: true
    })
    this.migrateInlineThumbnails()
  }

  // One-time: rows written before thumbnails moved to files carry the JPEG
  // inline as a data URL (~16 KB each — 2.5 MB of history.json for 150 rows,
  // parsed on every read and shipped whole to the Dashboard on every mount).
  // Write each one out byte for byte (no re-encode) and keep just the file
  // name. A row whose write fails keeps its data URL, which the renderer
  // still displays. Synchronous and cheap (~0.2 ms/row), so it runs in the
  // constructor before anything can read or write the store.
  private migrateInlineThumbnails(): void {
    const items = this.readItems()
    let moved = 0
    const migrated = items.map(it => {
      if (it.thumbnailFile || !it.thumbnailUrl?.startsWith('data:')) return it
      const file = writeThumbnailBytesFromDataUrl(it.id, it.thumbnailUrl)
      if (!file) return it
      moved++
      const next: HistoryItem = { ...it, thumbnailFile: file }
      delete next.thumbnailUrl
      return next
    })
    if (moved > 0) {
      this.setItems(migrated)
      console.log(`[history] moved ${moved} inline thumbnail(s) to files`)
    }
  }

  // Read the items array, preferring the in-memory cache. The cached array is
  // returned directly (not cloned) for read speed; callers must not mutate it
  // in place — they go through setItems for writes.
  private readItems(): HistoryItem[] {
    if (this.cache === null) this.cache = this.store.get('items')
    return this.cache
  }

  // Single write path: persist to disk and refresh the cache in lockstep.
  private setItems(items: HistoryItem[]): void {
    this.store.set('items', items)
    this.cache = items
  }

  getAll(): HistoryItem[] {
    return [...this.readItems()].sort((a, b) => b.timestamp - a.timestamp)
  }

  add(item: HistoryItem) {
    const items = [...this.readItems()]
    items.unshift(item)
    // Keep last 1000 items. At ~4 KB per item (thumbnail-only) that caps
    // history.json at ~4 MB — still trivial to read/write on every call.
    if (items.length > 1000) {
      // Evicted rows still have app-managed artifacts (annotated sidecars) on
      // disk — drop those, mirroring delete/prune. We do NOT unlink filePath
      // originals here: those live under ~/Pictures/Lumia and belong to the
      // user, not the app's eviction policy.
      const evicted = items.splice(1000)
      void Promise.all(evicted.map(it => this.unlinkItemFiles(it, { originals: false })))
    }
    this.setItems(items)
  }

  async delete(id: string): Promise<boolean> {
    const items = this.readItems()
    const victim = items.find(i => i.id === id)
    if (!victim) return false
    // Write the kept list BEFORE awaiting unlinks so the store write doesn't
    // span an await — otherwise a concurrent add() landing during the unlink
    // window would be clobbered by a stale snapshot. Explicit user delete is
    // allowed to remove the original too.
    this.setItems(items.filter(i => i.id !== id))
    await this.unlinkItemFiles(victim, { originals: true })
    return true
  }

  // Bulk delete in a single read → filter → write so N concurrent single
  // deletes can't race and resurrect orphans. The store write happens before
  // any await (same reasoning as delete()), then victim files are unlinked.
  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const idSet = new Set(ids)
    const items = this.readItems()
    const kept: HistoryItem[] = []
    const victims: HistoryItem[] = []
    for (const it of items) (idSet.has(it.id) ? victims : kept).push(it)
    if (victims.length === 0) return 0
    this.setItems(kept)
    await Promise.all(victims.map(it => this.unlinkItemFiles(it, { originals: true })))
    return victims.length
  }

  update(id: string, patch: Partial<HistoryItem>): HistoryItem | null {
    const items = [...this.readItems()]
    const idx = items.findIndex(i => i.id === id)
    if (idx < 0) return null
    const updated = { ...items[idx], ...patch }
    items[idx] = updated
    this.setItems(items)
    return updated
  }

  // Drops items older than `days` days. `days <= 0` means keep forever (no-op).
  // Returns the number of items removed. Unlinks each pruned item's source +
  // annotated-sidecar files so retention cleanup mirrors the manual delete
  // button — without this, history.json shrinks but disk bloat persists.
  async pruneOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const items = this.readItems()
    const kept: HistoryItem[] = []
    const pruned: HistoryItem[] = []
    for (const it of items) (it.timestamp >= cutoff ? kept : pruned).push(it)
    if (pruned.length === 0) return 0
    // Write kept list before awaiting unlinks so the store.set no longer spans
    // the await — closes the race with a concurrent add().
    this.setItems(kept)
    await Promise.all(pruned.map(it => this.unlinkItemFiles(it, { originals: true })))
    return pruned.length
  }

  // One-time data reset for upgrade paths where on-disk formats changed
  // enough that carrying the old history forward is worse than starting
  // fresh (e.g. thumbnail payload switched from full dataUrls to JPEGs,
  // annotation sidecar model added, settings shape reworked). Guarded by a
  // `cleanupVersion` marker in history.json so it only runs once per bump:
  // bump the target to rerun on the next release. Fresh installs hit this
  // path too but trivially — no items to unlink, just seals the marker.
  async runStartupCleanup(targetVersion: number): Promise<number> {
    const current = (this.store.get('cleanupVersion') as number | undefined) ?? 0
    if (current >= targetVersion) return 0
    const items = this.readItems()
    this.setItems([])
    this.store.set('cleanupVersion', targetVersion)
    // Startup cleanup only resets the app's own metadata + artifacts. It must
    // NEVER delete filePath originals under ~/Pictures/Lumia — a future version
    // bump would otherwise mass-delete the user's screenshot library.
    await Promise.all(items.map(it => this.unlinkItemFiles(it, { originals: false })))
    return items.length
  }

  // Shared file cleanup for delete + prune + eviction + startup. Bounded to the
  // user's home directory so a tampered history entry can't coax us into
  // unlinking system files; ENOENT is swallowed because the goal state (file
  // gone) is already achieved. `originals` gates whether the user's original
  // capture (filePath, under ~/Pictures/Lumia) is removed: only explicit user
  // delete + retention prune opt in; eviction and startup cleanup do not.
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
