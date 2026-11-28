/* What the Dashboard hands to its next self (2026-11-27). It unmounts while
   the editor or Settings is open and used to come back empty and at the
   top. Kept here, in memory only: the days it had loaded, so the first
   frame back is already drawn, and where it was (utils/dayHistory.ts,
   PlaceAnchor). Each is taken once; a reload of the window starts fresh. */
import type { HistoryItem, HistoryStats } from '../types'
import type { MeasuredDay, PlaceAnchor } from '../utils/dayHistory'

export interface KeptHistory {
  stats: HistoryStats | null
  rows: Map<string, HistoryItem[]>
}
export interface KeptPlace {
  /** Filter and view it was measured in; another one starts at the top. */
  key: string
  anchor: PlaceAnchor
  /** Heights of days that had been dropped from memory. */
  measured: [string, MeasuredDay][]
}

let history: KeptHistory | null = null
let place: KeptPlace | null = null
let opened: string | null = null
/** The next Dashboard starts at the top with nothing handed over. */
let fresh = false

/** A new capture or recording opened the editor (main sent the window
 *  there, also from its notification): Back should show the new clip,
 *  which sits at the top, not the place from before (Jasper, 2026-11-27).
 *  Drops what's kept and whatever the Dashboard keeps as it leaves, until
 *  the next one has started. Its days are loaded anew, so the new clip is
 *  in the first clips shown rather than popping in. */
export function dashboardStartsAtTop(): void {
  fresh = true
  history = null
  place = null
  opened = null
}

export function keepHistory(kept: KeptHistory): void { if (!fresh) history = kept }
export function takeHistory(): KeptHistory | null {
  const kept = history
  history = null
  return kept
}

export function keepPlace(kept: KeptPlace): void { if (!fresh) place = kept }
/** Taken last when a Dashboard starts (its sections mount after its
 *  history), so this is where a fresh start ends. */
export function takePlace(key: string): KeptPlace | null {
  const kept = place
  place = null
  fresh = false
  return kept && kept.key === key ? kept : null
}

/** A clip deleted from the editor (2026-11-27): out of the kept days, so
 *  the Dashboard coming back never draws it (it did for a frame, and its
 *  thumbnail, already gone, failed to load). Its day stands in for the
 *  place, as for any clip deleted meanwhile; the reload fixes the counts. */
export function forgetClip(id: string): void {
  if (!history) return
  const rows = new Map<string, HistoryItem[]>()
  for (const [day, items] of history.rows) rows.set(day, items.filter(i => i.id !== id))
  history = { ...history, rows }
}

/** The clip being opened in the editor: the place is remembered by it. */
export function noteOpenedClip(id: string): void { opened = id }
export function takeOpenedClip(): string | null {
  const id = opened
  opened = null
  return id
}
