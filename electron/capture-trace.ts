/**
 * Hotkey → overlay-visible timeline for image captures. One log line per
 * capture session, e.g.
 *
 *   [capture-trace] region 142ms · hide 0 · freeze 88 · send 2 · reveal 140 (d1 139, d2 140)
 *
 * Marks are ms since `traceBegin()`. Cheap enough to leave on: a handful of
 * performance.now() calls per capture and one console line.
 */
let session: { label: string; t0: number; marks: [string, number][]; pending: number } | null = null

export function traceBegin(label: string): void {
  session = { label, t0: performance.now(), marks: [], pending: 0 }
}

export function traceMark(name: string): void {
  if (session) session.marks.push([name, Math.round(performance.now() - session.t0)])
}

/** Expect `n` more traceMark()s (one per overlay reveal) before the line is
 *  printed by traceSettle(). */
export function traceExpect(n: number): void {
  if (session) session.pending += n
}

/** Record one awaited event; flushes the line once every expected event has
 *  landed. */
export function traceSettle(name: string): void {
  if (!session) return
  traceMark(name)
  if (--session.pending <= 0) traceFlush()
}

export function traceFlush(): void {
  if (!session) return
  const s = session
  session = null
  const total = Math.round(performance.now() - s.t0)
  console.log(`[capture-trace] ${s.label} ${total}ms · ${s.marks.map(([n, t]) => `${n} ${t}`).join(' · ')}`)
}
