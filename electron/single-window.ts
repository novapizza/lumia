// Does a captured area show one window only? (2026-11-23) Region and screen
// captures name their source only then: a region inside one window, a
// screen filled by one window, or (2026-11-24) one window with bare desktop
// around it gets that window's app and title; several windows keep "Region"
// / "Screen" (marked multiple), bare desktop alone keeps them too.
// Pure, no Electron (unit-tested in tests/single-window.test.ts).

export interface Rect { x: number; y: number; width: number; height: number }

/** Pixels a drag may miss a window's edge by, or a window in front may poke
 *  into the area, and still count (hand-dragged edges, Windows' invisible
 *  resize borders). */
const SLACK = 4

/**
 * The index of the one window the area shows, in `wins` (front to back), or
 * -1. That window is the frontmost one holding the whole area (give or take
 * SLACK), and no window in front of it may reach into the area.
 * For a whole screen pass the display's work area: a maximized window fills
 * it, a full-screen app covers it.
 */
export function singleWindowIndex(wins: Rect[], area: Rect, slack = SLACK): number {
  const holds = (w: Rect) =>
    w.x <= area.x + slack && w.y <= area.y + slack &&
    w.x + w.width >= area.x + area.width - slack &&
    w.y + w.height >= area.y + area.height - slack
  // The area minus the slack, so a window that only touches its edge
  // doesn't count as in front of it.
  const inner = {
    x: area.x + slack, y: area.y + slack,
    width: area.width - 2 * slack, height: area.height - 2 * slack,
  }
  const reaches = (w: Rect) =>
    w.x < inner.x + inner.width && w.x + w.width > inner.x &&
    w.y < inner.y + inner.height && w.y + w.height > inner.y

  const i = wins.findIndex(holds)
  if (i < 0) return -1
  for (let j = 0; j < i; j++) if (reaches(wins[j])) return -1
  return i
}

/** `r` minus `cut`: up to four rects. */
function subtract(r: Rect, cut: Rect): Rect[] {
  const x0 = Math.max(r.x, cut.x), y0 = Math.max(r.y, cut.y)
  const x1 = Math.min(r.x + r.width, cut.x + cut.width), y1 = Math.min(r.y + r.height, cut.y + cut.height)
  if (x1 <= x0 || y1 <= y0) return [r]
  const out: Rect[] = []
  if (y0 > r.y) out.push({ x: r.x, y: r.y, width: r.width, height: y0 - r.y })
  if (y1 < r.y + r.height) out.push({ x: r.x, y: y1, width: r.width, height: r.y + r.height - y1 })
  if (x0 > r.x) out.push({ x: r.x, y: y0, width: x0 - r.x, height: y1 - y0 })
  if (x1 < r.x + r.width) out.push({ x: x1, y: y0, width: r.x + r.width - x1, height: y1 - y0 })
  return out
}

/**
 * The windows that show in the area (indices into `wins`, front to back):
 * some part of the window inside the area isn't covered by a window in
 * front of it. Windows hidden behind another don't count; bare desktop
 * counts as none. Exact (2026-11-24; a 9×9 point sample missed a small
 * window between its points).
 */
export function visibleWindowIndices(wins: Rect[], area: Rect): number[] {
  const out: number[] = []
  for (let i = 0; i < wins.length; i++) {
    // The window's part of the area…
    const w = wins[i]
    const x0 = Math.max(area.x, w.x), y0 = Math.max(area.y, w.y)
    const x1 = Math.min(area.x + area.width, w.x + w.width), y1 = Math.min(area.y + area.height, w.y + w.height)
    if (x1 <= x0 || y1 <= y0) continue
    let rest: Rect[] = [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }]
    // …minus every window in front of it.
    for (let j = 0; j < i && rest.length; j++) rest = rest.flatMap(r => subtract(r, wins[j]))
    if (rest.some(r => r.width > 0 && r.height > 0)) out.push(i)
  }
  return out
}

/** How many windows show in the area (see visibleWindowIndices). Tells
 *  "several windows" ("Region / Multiple") from one window plus desktop. */
export function visibleWindowCount(wins: Rect[], area: Rect): number {
  return visibleWindowIndices(wins, area).length
}
