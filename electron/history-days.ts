import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryItem } from './types'

/**
 * Capture history stored as one JSON file per local day plus a stats file
 * (design/HISTORY-BY-DAY.md):
 *
 *   <root>/history/YYYY-MM-DD.json   { items: HistoryItem[] }, newest first
 *   <root>/history_stat.json         totals + per-day counts, newest day first
 *
 * Node `fs` only (no Electron), so it runs under `node --test`. Every write is
 * synchronous and atomic (tmp file + rename), day file first, then stats.
 */

export interface DayStat { day: string; total: number; screenshot: number; recording: number }

export interface HistoryStats {
  version: 1
  cleanupVersion: number
  total: number
  screenshot: number
  recording: number
  days: DayStat[]
}

const STATS_VERSION = 1
/** Parsed day files kept in memory (most recently used). */
const DAY_CACHE_SIZE = 30

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// Windows antivirus / indexers lock files for a moment; electron-store's
// writer retried these too.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Write JSON to `<path>.tmp`, fsync it, then rename it over `path`,
 *  retrying the rename while the target is briefly locked. `rename` is
 *  injectable for tests. */
export function writeJsonAtomic(path: string, data: unknown, rename: (from: string, to: string) => void = renameSync): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || !code || !RETRY_CODES.has(code)) throw err
      sleepSync(25 * attempt)
    }
  }
}

const byNewest = (a: HistoryItem, b: HistoryItem) => b.timestamp - a.timestamp

function statFor(day: string, items: HistoryItem[]): DayStat {
  let screenshot = 0
  let recording = 0
  for (const it of items) (it.type === 'recording' ? recording++ : screenshot++)
  return { day, total: items.length, screenshot, recording }
}

export class DayHistory {
  private readonly dir: string
  private readonly statsPath: string
  private stats: HistoryStats
  private readonly cache = new Map<string, HistoryItem[]>()
  private readonly idDay = new Map<string, string>()
  /** Days whose file couldn't be read or moved aside: never written this
   *  session, so the file's content survives for a later look. */
  private readonly blocked = new Set<string>()
  /** Stats were rebuilt over day files that hold rows: the cleanup marker is
   *  unknown, but rows in day files always come from a build after the switch
   *  to day files, so the startup reset must not run (cleanupIfBelow). */
  private rebuiltOverData = false

  constructor(rootDir: string) {
    this.dir = join(rootDir, 'history')
    this.statsPath = join(rootDir, 'history_stat.json')
    this.stats = { version: STATS_VERSION, cleanupVersion: 0, total: 0, screenshot: 0, recording: 0, days: [] }
    // Never throw out of here: a failure would stop the app from finishing
    // startup. History then shows empty and writes will throw (and log).
    try {
      mkdirSync(this.dir, { recursive: true })
      const saved = this.readStatsFile()
      if (saved) {
        this.stats = saved
        this.reconcile()
      } else {
        this.stats = this.rebuildStats(0)
        this.rebuiltOverData = this.stats.total > 0
      }
    } catch (err) {
      console.error('[history] could not open history, starting empty', err)
    }
  }

  /** One-time reset for upgrades (`runStartupCleanup`): when the stored
   *  cleanup version is below `target`, empty all history and return the
   *  removed rows; otherwise return []. Skipped when the stats had to be
   *  rebuilt over existing rows (see `rebuiltOverData`). */
  cleanupIfBelow(target: number): HistoryItem[] {
    if (this.stats.cleanupVersion >= target) return []
    if (this.rebuiltOverData) {
      this.stats.cleanupVersion = target
      this.writeStats()
      return []
    }
    return this.reset(target)
  }

  get cleanupVersion(): number {
    return this.stats.cleanupVersion
  }

  /**
   * Repairs stats left behind by a crash between a day write and the stats
   * write, without reading every day file: recounts only day files modified
   * at or after the stats file (same-second writes count, since some file
   * systems store whole seconds) and day files the stats don't list, and
   * drops listed days whose file is gone.
   */
  reconcile(): void {
    const statsTime = existsSync(this.statsPath) ? statSync(this.statsPath).mtimeMs : 0
    const files = new Set(this.listDayFiles())
    const listed = new Set(this.stats.days.map(d => d.day))
    let changed = false
    const days = this.stats.days.filter(d => {
      if (files.has(d.day)) return true
      changed = true
      return false
    })
    for (const day of files) {
      if (listed.has(day) && statSync(this.dayPath(day)).mtimeMs < statsTime) continue
      this.cache.delete(day)
      const fresh = statFor(day, this.readDay(day))
      const i = days.findIndex(d => d.day === day)
      const old = i >= 0 ? days[i] : null
      if (old && old.total === fresh.total && old.screenshot === fresh.screenshot && old.recording === fresh.recording) continue
      if (i >= 0) days.splice(i, 1)
      if (fresh.total > 0) days.push(fresh)
      changed = true
    }
    if (changed) {
      this.applyDays(days)
      this.writeStats()
    }
  }

  getStats(): HistoryStats {
    return structuredClone(this.stats)
  }

  getDays(days: string[]): Record<string, HistoryItem[]> {
    const out: Record<string, HistoryItem[]> = {}
    for (const day of days) out[day] = [...this.readDay(day)]
    return out
  }

  get(id: string): HistoryItem | null {
    const day = this.locate(id)
    return day ? this.readDay(day).find(i => i.id === id) ?? null : null
  }

  getRecent(limit: number, type?: HistoryItem['type']): HistoryItem[] {
    const out: HistoryItem[] = []
    for (const d of this.stats.days) {
      if (out.length >= limit) break
      if (type && d[type] === 0) continue
      for (const it of this.readDay(d.day)) {
        if (type && it.type !== type) continue
        out.push(it)
        if (out.length >= limit) break
      }
    }
    return out
  }

  add(item: HistoryItem): string {
    const day = dayKey(item.timestamp)
    const items = [item, ...this.readDay(day).filter(i => i.id !== item.id)].sort(byNewest)
    this.writeDay(day, items)
    return day
  }

  update(id: string, patch: Partial<HistoryItem>): { item: HistoryItem; day: string } | null {
    const day = this.locate(id)
    if (!day) return null
    const items = [...this.readDay(day)]
    const idx = items.findIndex(i => i.id === id)
    if (idx < 0) return null
    // A row never changes day: its timestamp is fixed.
    const item: HistoryItem = { ...items[idx], ...patch, timestamp: items[idx].timestamp }
    items[idx] = item
    this.writeDay(day, items)
    return { item, day }
  }

  deleteMany(ids: string[]): { removed: HistoryItem[]; days: string[] } {
    const byDay = new Map<string, Set<string>>()
    for (const id of ids) {
      const day = this.locate(id)
      if (!day) continue
      if (!byDay.has(day)) byDay.set(day, new Set())
      byDay.get(day)!.add(id)
    }
    const removed: HistoryItem[] = []
    for (const [day, set] of byDay) {
      const kept: HistoryItem[] = []
      for (const it of this.readDay(day)) (set.has(it.id) ? removed : kept).push(it)
      this.writeDay(day, kept)
    }
    return { removed, days: [...byDay.keys()] }
  }

  /** Removes rows older than `cutoffMs`: whole days before the cutoff's day,
   *  and the older rows of the cutoff's own day. */
  pruneOlderThan(cutoffMs: number): { removed: HistoryItem[]; days: string[] } {
    const cutoffDay = dayKey(cutoffMs)
    const removed: HistoryItem[] = []
    const touched: string[] = []
    for (const { day } of [...this.stats.days]) {
      if (day > cutoffDay) continue
      const items = this.readDay(day)
      const kept = day < cutoffDay ? [] : items.filter(i => i.timestamp >= cutoffMs)
      if (kept.length === items.length) continue
      removed.push(...items.filter(i => !kept.includes(i)))
      this.writeDay(day, kept)
      touched.push(day)
    }
    return { removed, days: touched }
  }

  /** Empties all history and records `cleanupVersion`. Returns the removed rows. */
  reset(cleanupVersion: number): HistoryItem[] {
    const removed: HistoryItem[] = []
    for (const { day } of [...this.stats.days]) {
      removed.push(...this.readDay(day))
      this.writeDay(day, [])
    }
    this.stats.cleanupVersion = cleanupVersion
    this.writeStats()
    return removed
  }

  /** Merges rows from the old single-file history. A row whose id is already
   *  stored keeps the stored copy, so running it twice adds nothing. */
  importLegacy(items: HistoryItem[], cleanupVersion: number): { added: number; days: string[] } {
    // Record the legacy cleanup version first: every day write below also
    // writes the stats, so a failure partway must not leave a version on
    // disk that would make the next startup reset the rows already moved.
    this.stats.cleanupVersion = Math.max(this.stats.cleanupVersion, cleanupVersion)
    const byDay = new Map<string, HistoryItem[]>()
    for (const it of items) {
      const day = dayKey(it.timestamp)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(it)
    }
    let added = 0
    const touched: string[] = []
    for (const [day, incoming] of byDay) {
      const existing = this.readDay(day)
      const have = new Set(existing.map(i => i.id))
      const fresh: HistoryItem[] = []
      for (const it of incoming) {
        if (have.has(it.id) || this.idDay.has(it.id)) continue
        have.add(it.id)
        fresh.push(it)
      }
      if (fresh.length === 0) continue
      this.writeDay(day, [...existing, ...fresh].sort(byNewest))
      added += fresh.length
      touched.push(day)
    }
    this.stats.cleanupVersion = Math.max(this.stats.cleanupVersion, cleanupVersion)
    this.writeStats()
    return { added, days: touched }
  }

  // ── internals ──

  private dayPath(day: string): string {
    return join(this.dir, `${day}.json`)
  }

  /** Day file contents (cached). Missing file → []. */
  private readDay(day: string): HistoryItem[] {
    const hit = this.cache.get(day)
    if (hit) {
      this.cache.delete(day)
      this.cache.set(day, hit)
      return hit
    }
    const path = this.dayPath(day)
    let items: HistoryItem[] = []
    if (this.blocked.has(day)) return []
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown }
        if (!Array.isArray(parsed?.items)) throw new Error('day file has no items array')
        items = parsed.items as HistoryItem[]
      } catch (err) {
        // Never overwrite a file we couldn't read: move it aside so its
        // content survives, and treat the day as empty. If it can't be
        // moved either, leave it and never write that day this session.
        const aside = join(this.dir, `${day}.corrupt-${Date.now()}.json`)
        try {
          renameSync(path, aside)
          console.error('[history] unreadable day file, moved to', aside, err)
        } catch (moveErr) {
          console.error('[history] unreadable day file left in place, not writing it', path, err, moveErr)
          this.blocked.add(day)
          return []
        }
      }
    }
    this.remember(day, items)
    return items
  }

  private remember(day: string, items: HistoryItem[]): void {
    this.cache.delete(day)
    this.cache.set(day, items)
    for (const it of items) this.idDay.set(it.id, day)
    while (this.cache.size > DAY_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value as string
      this.cache.delete(oldest)
    }
  }

  /** Which day holds `id`: the id map, else day files newest first. */
  private locate(id: string): string | null {
    const known = this.idDay.get(id)
    if (known) return known
    for (const d of this.stats.days) {
      if (this.cache.has(d.day)) continue // already in idDay if present
      if (this.readDay(d.day).some(i => i.id === id)) return d.day
    }
    return null
  }

  /** Persist one day (empty → delete its file), then the stats. */
  private writeDay(day: string, items: HistoryItem[]): void {
    if (this.blocked.has(day)) throw new Error(`[history] day ${day} is unreadable, not writing it`)
    const path = this.dayPath(day)
    const previous = this.cache.get(day) ?? []
    if (items.length === 0) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      writeJsonAtomic(path, { items })
    }
    for (const it of previous) if (this.idDay.get(it.id) === day) this.idDay.delete(it.id)
    this.remember(day, items)
    this.setDayStat(statFor(day, items))
    this.writeStats()
  }

  private setDayStat(stat: DayStat): void {
    const days = this.stats.days.filter(d => d.day !== stat.day)
    if (stat.total > 0) days.push(stat)
    this.applyDays(days)
  }

  private applyDays(days: DayStat[]): void {
    days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    const sum = (k: 'total' | 'screenshot' | 'recording') => days.reduce((n, d) => n + d[k], 0)
    this.stats = {
      version: STATS_VERSION,
      cleanupVersion: this.stats?.cleanupVersion ?? 0,
      total: sum('total'),
      screenshot: sum('screenshot'),
      recording: sum('recording'),
      days,
    }
  }

  private writeStats(): void {
    writeJsonAtomic(this.statsPath, this.stats)
  }

  private readStatsFile(): HistoryStats | null {
    if (!existsSync(this.statsPath)) return null
    try {
      const s = JSON.parse(readFileSync(this.statsPath, 'utf8')) as HistoryStats
      return s?.version === STATS_VERSION && Array.isArray(s.days) ? s : null
    } catch {
      return null
    }
  }

  /** Count every day file from scratch and write the stats. */
  private rebuildStats(cleanupVersion: number): HistoryStats {
    this.stats = { version: STATS_VERSION, cleanupVersion, total: 0, screenshot: 0, recording: 0, days: [] }
    const days: DayStat[] = []
    for (const day of this.listDayFiles()) {
      const items = this.readDay(day)
      if (items.length > 0) days.push(statFor(day, items))
    }
    this.applyDays(days)
    this.writeStats()
    return this.stats
  }

  private listDayFiles(): string[] {
    return readdirSync(this.dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10))
  }
}
