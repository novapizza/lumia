/** The on state of a framed button (STYLEGUIDE › Buttons and controls): a
 *  straight 3px accent strip along its bottom edge, inside the frame and
 *  masked to its inner shape (8px corners minus the 1px border), so it never
 *  covers the border at the corners. The icon keeps its colour; no fill.
 *
 *  The button needs `relative`, and `group/on` so the strip steps to
 *  accent-text-hover with it under the pointer. */
export function OnStrip() {
  return (
    <span className="absolute inset-0 overflow-hidden rounded-[7px] pointer-events-none">
      <span className="absolute inset-x-0 bottom-0 h-[3px] bg-accent group-hover/on:bg-accent-text-hover" />
    </span>
  )
}
