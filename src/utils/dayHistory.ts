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
