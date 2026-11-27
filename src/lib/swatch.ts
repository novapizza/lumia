/** Colour swatches, one look everywhere (Jasper, 2026-11-26): the image
 *  toolbar, the Background panel, the recording toolbar's drawing row and
 *  Settings › Appearance.
 *
 *  24px circle, a see-through `line` edge, the selection an accent ring 1px
 *  out. The colour fills inside the border only; under the border lies the
 *  framed buttons' `elevated` fill, so the edge reads as it does on a button
 *  whatever the swatch's colour (over the colour itself it tinted it, and
 *  all but vanished on saturated swatches).
 *
 *  One definition (Jasper, 2026-11-27): the swatch, its 1.5px selection ring
 *  and the row's 6px gap all come from here; no row sets its own. */

/** The ground a swatch row sits on: the selection ring's 1px offset is
 *  drawn in it. */
export type SwatchGround = 'toolbar' | 'elevated'

// Full class names, so Tailwind finds them.
const OFFSET: Record<SwatchGround, string> = {
  toolbar: 'ring-offset-toolbar',
  elevated: 'ring-offset-elevated',
}

/** A row of swatches: 6px apart (`gap-1.5`). Add the row's own layout
 *  (`flex-wrap justify-center`, `flex-shrink-0`) beside it. */
export const SWATCH_ROW = 'flex items-center gap-1.5'

/** How far a selected swatch's ring reaches past the swatch, in px: the 1px
 *  offset plus the 1.5px ring. For anything placed against a selected
 *  swatch (Settings' Custom colour callout). */
export const SWATCH_RING_OUT = 2.5

export function swatchClass(selected: boolean, ground: SwatchGround = 'toolbar'): string {
  return `relative w-6 h-6 rounded-full border border-line flex-shrink-0 flex items-center justify-center overflow-hidden ${
    selected ? `ring-[1.5px] ring-accent ring-offset-1 ${OFFSET[ground]}` : ''
  }`
}

/** The swatch's `background`: the colour (or gradient) inside the border,
 *  `elevated` under it. */
export function swatchFill(fill: string): string {
  const layer = fill.includes('gradient(') ? fill : `linear-gradient(${fill}, ${fill})`
  return `${layer} padding-box, linear-gradient(var(--color-elevated), var(--color-elevated)) border-box`
}
