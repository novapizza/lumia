/** Thin bar along the bottom of the main window, on every screen (moved out
 *  of the Dashboard, 2026-11-20). Like the AppBar at the top (bg-elevated),
 *  so content scrolls up to it instead of being cut off at the bare window
 *  edge. An edge line along its top, inside the bar, added to its height
 *  (pt-px) so the sign-off sits exactly centred below the line: 15px
 *  (final 2026-11-23; 14px under the line, the 8px text 3px from each).
 *  17px tried; 16px left it 0.5px off. Holds a small centred sign-off.
 *
 *  The line (2026-11-23): at 15px it crosses the window's rounded bottom
 *  corners, where the system's own see-through window outline curves in,
 *  so a straight line either stacked on that outline (a bright dot) or
 *  stopped short of it (a gap). Its ends are masked along the corner's
 *  circle. macOS doesn't tell web content its
 *  corner radius: WINDOW_RADIUS was set by eye with a slider on Jasper's
 *  Mac (macOS 27, 2026-11-23). Other macOS versions may differ (macOS 26
 *  enlarged the corners); reading it at runtime is noted as a later option. */
const BAR_H = 15
const WINDOW_RADIUS = 21.1

// The corner circle's centre, from the line's own box: R in from the side,
// R up from the window's bottom (the bar's bottom, BAR_H below the line);
// the cut on the corner's own curve (radius R), as it looked right while
// tuning (a 1px-inside cut tried after, didn't match).
const R = WINDOW_RADIUS
const CUT = `circle ${R}px at`
const CY = `${BAR_H - R}px`
const LINE_MASK = [
  `radial-gradient(${CUT} ${R}px ${CY}, #000 calc(100% - 0.5px), transparent 100%)`,
  `radial-gradient(${CUT} calc(100% - ${R}px) ${CY}, #000 calc(100% - 0.5px), transparent 100%)`,
  'linear-gradient(#000, #000)',
].join(', ')
const LINE_MASK_SIZE = `100% 100%, 100% 100%, calc(100% - ${2 * R}px) 100%`

export function BottomBar() {
  return (
    <div className="relative z-10 h-[15px] pt-px flex-shrink-0 flex items-center justify-center bg-elevated">
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-line pointer-events-none"
        style={{
          maskImage: LINE_MASK,
          WebkitMaskImage: LINE_MASK,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskSize: LINE_MASK_SIZE,
          WebkitMaskSize: LINE_MASK_SIZE,
          maskPosition: '0 0, 0 0, center',
          WebkitMaskPosition: '0 0, 0 0, center',
        }}
      />
      {/* Lumia is built by devs in Hanoi and Jasper in Berlin. */}
      <p className="text-[8px] leading-none text-fg-faint select-none">Made with love by devs in Hanoi and a pixel pusher in Berlin</p>
    </div>
  )
}
