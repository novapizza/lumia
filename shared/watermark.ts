/* The capture watermark's numbers (the mark and the name "Lumia", bottom
   left), in one place for the two things that draw it: electron/watermark.ts
   stamps images, src/windows/recorder-host/RecorderHost.tsx stamps every
   recorded frame. They used to be written out in both (2026-11-27). */

/** Height on screen, in points: × the display's scale factor in pixels. */
export const WATERMARK_PT = 12
/** Distance from the corner, in points. */
export const WATERMARK_MARGIN_PT = 6
export const WATERMARK_OPACITY = 0.1
/** At most this share of the image's width / height. */
export const WATERMARK_MAX_W = 0.5
export const WATERMARK_MAX_H = 0.3
/** Smaller than this (px) and it's left off. */
export const WATERMARK_MIN_PX = 10
/** Ink for a corner of this brightness (0 to 255, Rec. 709 luma): dark ink
 *  from mid-grey up. */
export const WATERMARK_INK_THRESHOLD = 128
