// Helpers for the Dashboard's day sections. No imports, so `node --test`
// can load this file directly (tests/day-history-ui.test.ts).

const DAY_MS = 86_400_000

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Header for a day key (`YYYY-MM-DD`): Today, Yesterday, the weekday within
 *  the last week, otherwise the date (with the year when it isn't this year). */
export function dayLabel(day: string, now: Date): string {
  const date = parseDay(day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((today.getTime() - date.getTime()) / DAY_MS)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  })
}

/** Height of a day section before its rows are loaded: header plus
 *  `ceil(count / columns)` rows with gaps between them. */
export function estimateDayHeight(count: number, columns: number, rowHeight: number, gap: number, headerHeight: number): number {
  const rows = Math.ceil(count / Math.max(1, columns))
  return headerHeight + rows * rowHeight + Math.max(rows - 1, 0) * gap
}

export interface MeasuredDay { height: number; count: number; width: number }

/** Height for an unloaded day: its last measured height when the count it
 *  showed and the container width are unchanged, else the estimate. */
export function placeholderHeight(measured: MeasuredDay | undefined, count: number, width: number, estimate: () => number): number {
  return measured && measured.count === count && measured.width === width ? measured.height : estimate()
}

/** Per-day change counters. A day load or refresh snapshots the counters of
 *  its days; a `history:changed` bumps them, and a result whose snapshot no
 *  longer matches is stale and must not be shown. */
export class DayGenerations {
  private readonly gens = new Map<string, number>()

  bump(days: string[]): void {
    for (const d of days) this.gens.set(d, (this.gens.get(d) ?? 0) + 1)
  }

  snapshot(days: string[]): Map<string, number> {
    return new Map(days.map(d => [d, this.gens.get(d) ?? 0]))
  }

  /** Days whose counter moved since `snapshot`. */
  stale(snapshot: Map<string, number>): string[] {
    return [...snapshot].filter(([d, g]) => (this.gens.get(d) ?? 0) !== g).map(([d]) => d)
  }
}

// ── The Dashboard's place, kept while the editor or Settings is open ──
// The Dashboard unmounts for those pages and used to come back at the top.
// Its place is remembered as a clip and where that clip sat, not as a
// scroll offset: days load a few at a time, so offsets don't carry over.

export interface ClipBox { id: string; top: number; bottom: number; left: number; right: number }

/** Where the Dashboard was: the anchor point (a clip's centre, or the
 *  middle line when no clip showed) sat `offset` px under the scroll area's
 *  top, `dayFraction` of the way down its day. */
export type PlaceAnchor = { top: true } | { id?: string; day: string; offset: number; dayFraction: number }

/** The clip to remember the place by: `prefer` (the one just opened) while
 *  any of it shows, so it comes back exactly where it was clicked; else the
 *  one nearest the middle of the area, by height first, then (in the grid)
 *  by how near the centre column. Null when no clip is in view. */
export function pickAnchorClip(clips: ClipBox[], area: { top: number; bottom: number; left: number; right: number }, prefer?: string | null): ClipBox | null {
  const inView = clips.filter(c => c.bottom > area.top && c.top < area.bottom)
  const opened = prefer ? inView.find(c => c.id === prefer) : undefined
  if (opened) return opened
  const midY = (area.top + area.bottom) / 2
  const midX = (area.left + area.right) / 2
  let best: { clip: ClipBox; dy: number; dx: number } | null = null
  for (const clip of inView) {
    const dy = Math.abs((clip.top + clip.bottom) / 2 - midY)
    const dx = Math.abs((clip.left + clip.right) / 2 - midX)
    if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) best = { clip, dy, dx }
  }
  return best?.clip ?? null
}

/** How far to scroll to put the anchor back: its clip's centre at the old
 *  height, or, when the clip is gone, the same point of its day. Null when
 *  neither is there (or the place was the top). */
export function placeDelta(
  anchor: PlaceAnchor,
  areaTop: number,
  clip: { top: number; bottom: number } | undefined,
  section: { top: number; height: number } | undefined,
): number | null {
  if ('top' in anchor) return null
  if (clip) return (clip.top + clip.bottom) / 2 - areaTop - anchor.offset
  if (section) return section.top + section.height * anchor.dayFraction - areaTop - anchor.offset
  return null
}
