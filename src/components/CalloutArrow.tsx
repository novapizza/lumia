import { useId } from 'react'

/** The gap between a callout and the control that opened it (its source),
 *  in px (STYLEGUIDE › Callouts and menus). 12 since 2026-11-26 (7 before):
 *  more room between them, the triangle lengthened to bridge it. */
export const CALLOUT_GAP = 12

/** How far short of the source the triangle's tip ends (px): 4 since
 *  2026-11-26 (2 before), a little air between them. */
const TIP_SHORT = 4
/** The triangle's base (px): 16 since 2026-11-26 (11.3, the old 8px square
 *  turned 45°, before). */
const BASE = 16

/** A callout's triangle (2026-11-26; an 8px square turned 45° before, which
 *  could only stick out 5px): drawn in the box's fill with its two outer
 *  edges in the box's line, its base laid over the box's 1px inset ring
 *  edge (`ring-1 ring-inset ring-line`, 2026-11-26; a border before) so
 *  the edge opens under it. The triangle's edges are inset too: 1px inside
 *  the outline, so the outline is the fill's and the tip lands exactly (a
 *  centred line stuck out 0.5px, and its mitred point ~0.75px past the
 *  tip). It sticks out CALLOUT_GAP − TIP_SHORT, so the tip ends TIP_SHORT
 *  short of the source however far the box sits.
 *  `side`: the box's edge it sits on ('top' for a box below its source).
 *  `centre`: the tip's x from the box's left edge. A child of the box or of
 *  a wrapper the size of the box; with a full-bleed child that paints over
 *  the ring (the Background panel), the ring is an overlay and the triangle
 *  needs a z-index above it. */
export function CalloutArrow({ side, centre, className = '' }: {
  side: 'top' | 'bottom'
  centre: number
  className?: string
}) {
  // useId's colons / guillemets aren't safe inside url(#…).
  const clipId = 'callout-arrow-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const h = CALLOUT_GAP - TIP_SHORT
  // One extra px for the row over the box's edge.
  const H = h + 1
  const fill = side === 'bottom'
    ? `0,0 ${BASE},0 ${BASE / 2},${H}`
    : `0,${H} ${BASE},${H} ${BASE / 2},0`
  const edges = side === 'bottom'
    ? `0,0 ${BASE / 2},${H} ${BASE},0`
    : `0,${H} ${BASE / 2},0 ${BASE},${H}`
  return (
    <svg
      aria-hidden="true"
      width={BASE}
      height={H}
      viewBox={`0 0 ${BASE} ${H}`}
      className={`absolute pointer-events-none ${className}`}
      style={{
        left: centre - BASE / 2,
        // Its first row over the box's 1px edge, 1px in from the outline.
        ...(side === 'bottom' ? { top: 'calc(100% - 1px)' } : { bottom: 'calc(100% - 1px)' }),
      }}
    >
      <defs>
        <clipPath id={clipId}><polygon points={fill} /></clipPath>
      </defs>
      <polygon points={fill} fill="var(--color-elevated)" />
      {/* A 2px line on the outline, clipped to the triangle: the inner 1px
          is the inset edge. */}
      <polyline points={edges} fill="none" stroke="var(--color-line)" strokeWidth={2} clipPath={`url(#${clipId})`} />
    </svg>
  )
}
