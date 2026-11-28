import { useEffect, useState } from 'react'

/** Line width of the recording border in px. The main process grows the
 *  border window by the same amount on every side (computeBorderBounds in
 *  electron/video.ts), so the line sits just outside the recorded area. */
export const RECORDING_BORDER_WIDTH = 2
/** Dash length and the gap it aims for; each side spreads its gaps evenly. */
const DASH = 8
const GAP = 8

/** The dash pattern for one side: every side starts and ends with a dash,
 *  so each corner is a closed L (2026-11-24: a CSS dashed border let the
 *  browser place the pattern and corners could fall in a gap). */
function dashArray(length: number): string {
  const n = Math.max(2, Math.round((length + GAP) / (DASH + GAP)))
  const gap = Math.max(0, (length - n * DASH) / (n - 1))
  return `${DASH} ${gap}`
}

/** Dashed border around the recording area, in the video colour (the clip
 *  type's pink, as on the cards and the capture overlay; 2026-11-24, was a
 *  3px red CSS dashed border). Dashed, not solid, so live annotation
 *  strokes inside the area can't be mistaken for it. Covers the whole
 *  window. */
export default function RecordingBorder() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })

  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      document.body.style.background = ''
      document.documentElement.style.background = ''
    }
  }, [])

  const { w, h } = size
  const s = RECORDING_BORDER_WIDTH
  const half = s / 2
  const line = { stroke: 'var(--color-kind-video)', strokeWidth: s, strokeLinecap: 'butt' as const }
  return (
    <svg className="fixed inset-0 pointer-events-none" width={w} height={h} aria-hidden>
      {/* Top and bottom run the full width, left and right the full height,
          so their first and last dashes overlap into a corner. */}
      <line x1={0} y1={half} x2={w} y2={half} strokeDasharray={dashArray(w)} {...line} />
      <line x1={0} y1={h - half} x2={w} y2={h - half} strokeDasharray={dashArray(w)} {...line} />
      <line x1={half} y1={0} x2={half} y2={h} strokeDasharray={dashArray(h)} {...line} />
      <line x1={w - half} y1={0} x2={w - half} y2={h} strokeDasharray={dashArray(h)} {...line} />
    </svg>
  )
}
