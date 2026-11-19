import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayStat, HistoryItem, HistoryStats } from '../../types'
import { DayGenerations } from '../../utils/dayHistory'

export type HistoryFilter = 'all' | 'screenshot' | 'recording'

/** Wait before retrying a day load that failed. */
const RETRY_MS = 2000

/**
 * Capture history for the Dashboard, a day at a time
 * (design/HISTORY-BY-DAY.md). `stats` comes from history_stat.json and drives
 * every count; `rows` holds only the days that are loaded. Days are loaded
 * and dropped by DaySections as the user scrolls; main pushes
 * `history:changed` after every write, which refetches the stats and reloads
 * the changed days that are loaded (dropped days stay dropped).
 *
 * A change bumps the day's counter (DayGenerations); a load or refresh
 * result for a day whose counter moved while it was in flight is stale and
 * is fetched again instead of shown.
 */
export function useDayHistory(filter: HistoryFilter) {
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [rows, setRows] = useState<Map<string, HistoryItem[]>>(() => new Map())
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const inFlight = useRef(new Set<string>())
  const gens = useRef(new DayGenerations())

  const fetchStats = useCallback(async () => {
    try {
      const s = await window.electronAPI?.getHistoryStats()
      if (s) setStats(s)
      return s ?? null
    } catch (err) {
      console.error('[history] stats failed', err)
      return null
    }
  }, [])

  const loadDays = useCallback(async (days: string[]): Promise<void> => {
    const want = days.filter(d => !rowsRef.current.has(d) && !inFlight.current.has(d))
    if (want.length === 0) return
    want.forEach(d => inFlight.current.add(d))
    const started = gens.current.snapshot(want)
    let retry: string[] = []
    try {
      const res = await window.electronAPI?.getHistoryDays(want)
      const stale = new Set(gens.current.stale(started))
      retry = want.filter(d => stale.has(d))
      setRows(prev => {
        const next = new Map(prev)
        for (const d of want) if (!stale.has(d)) next.set(d, res?.[d] ?? [])
        return next
      })
    } catch (err) {
      console.error('[history] loading days failed, retrying', want, err)
      setTimeout(() => { loadDays(want) }, RETRY_MS)
    } finally {
      want.forEach(d => inFlight.current.delete(d))
    }
    if (retry.length) await loadDays(retry)
  }, [])

  const dropDays = useCallback((days: string[]) => {
    setRows(prev => {
      if (!days.some(d => prev.has(d))) return prev
      const next = new Map(prev)
      for (const d of days) next.delete(d)
      return next
    })
  }, [])

  /** `days` changed in main (default: every loaded day). Refetch the stats,
   *  then reload those that are loaded. Days that no longer exist are
   *  removed; loads already in flight for them come back stale and retry. */
  const refresh = useCallback(async (days?: string[]) => {
    const changed = days ?? [...rowsRef.current.keys()]
    gens.current.bump(changed)
    const s = await fetchStats()
    if (!s) return
    const alive = new Set(s.days.map(d => d.day))
    const targets = changed.filter(d => rowsRef.current.has(d) && alive.has(d))
    const started = gens.current.snapshot(targets)
    let res: Record<string, HistoryItem[]> | undefined = {}
    try {
      if (targets.length) res = await window.electronAPI?.getHistoryDays(targets)
    } catch (err) {
      console.error('[history] refreshing days failed', targets, err)
      return
    }
    // A newer change to a day supersedes this result; its own refresh applies.
    const stale = new Set(gens.current.stale(started))
    setRows(prev => {
      const next = new Map(prev)
      for (const d of prev.keys()) if (!alive.has(d)) next.delete(d)
      for (const d of targets) if (prev.has(d) && !stale.has(d)) next.set(d, res?.[d] ?? [])
      return next
    })
  }, [fetchStats])

  useEffect(() => {
    fetchStats()
    const off = window.electronAPI?.onHistoryChanged(({ days }) => { refresh(days) })
    return () => { off?.() }
  }, [fetchStats, refresh])

  /** Days that have captures for the current filter, newest first. */
  const days: DayStat[] = useMemo(
    () => (stats?.days ?? []).filter(d => (filter === 'all' ? d.total : d[filter]) > 0),
    [stats, filter],
  )

  return { stats, days, rows, loadDays, dropDays, refresh }
}
