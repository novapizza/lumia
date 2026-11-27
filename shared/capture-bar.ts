/* Where the capture overlay's mode bar and the recording toolbar's bar sit
   under the top of a display. One number for both (main computes it per
   display, sends it to the overlay's page and places the toolbar's window
   by it), so the toolbar always lands where the mode bar was. */

/** The bar's top where there's no menu bar to line up with. */
export const BAR_TOP_DEFAULT = 32

/** The bar's top edge in px under the display's top (Jasper, 2026-11-27).
 *  macOS: right at the menu bar's bottom edge, so the bar starts where a
 *  window pressed against the menu bar starts (30 on his displays, about 38
 *  on a display with a notch; it was a fixed 32, 2px under his menu bar).
 *  The menu bar's height is the gap between the display and its work area.
 *  A display whose work area starts at its top (a menu bar that hides
 *  itself) and every display on Windows keep 32. */
export function captureBarTop(
  display: { bounds: { y: number }; workArea: { y: number } },
  platform: string,
): number {
  if (platform !== 'darwin') return BAR_TOP_DEFAULT
  const menuBar = Math.round(display.workArea.y - display.bounds.y)
  return menuBar > 0 ? menuBar : BAR_TOP_DEFAULT
}
