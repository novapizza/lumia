import type React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

/** (2026-11-25, final) A 1px line (line-subtle, like the divider
 *  under the colours) with a ^ in it under the active swatch, pointing up
 *  at it, so the options below read as that colour's. Measures the swatch
 *  marked `data-active-swatch` (or `selector`) in the panel after every
 *  render. Shared since 2026-11-25: Settings › Wallpapers' categories band. */
export function CaretDivider({ panelRef, open = true, selector = '[data-active-swatch]', fill = 'var(--color-toolbar)' }: {
  panelRef: React.RefObject<HTMLDivElement | null>
  open?: boolean
  /** The element the ^ points at, looked up inside `panelRef`. */
  selector?: string
  /** The band's fill under the line and inside the ^ (a level below what
   *  the band sits in: toolbar in the Background panel, content in a
   *  Settings group). */
  fill?: string
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [geo, setGeo] = useState<{ w: number; x: number | null }>({ w: 0, x: null })
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const box = svg.getBoundingClientRect()
    const el = panelRef.current?.querySelector(selector)
    const r = el?.getBoundingClientRect()
    const x = r ? Math.round(r.left + r.width / 2 - box.left) : null
    const w = Math.round(box.width)
    if (x !== geo.x || w !== geo.w) setGeo({ w, x })
  })
  const H = 6, C = 5 // height; the caret's half-width and height
  const y = H - 0.5
  return (
    // Folded, the line fades out over 50ms, starting 130ms into the 200ms
    // fold (2026-11-25); it's back at once when the band opens.
    <svg
      ref={svgRef}
      aria-hidden="true"
      width="100%"
      height={H}
      className={`block overflow-visible ${open
        ? 'opacity-100'
        : 'opacity-0 transition-opacity duration-50 delay-[130ms] ease-out motion-reduce:transition-none'}`}
    >
      {/* The line, the band's toolbar fill under it while open. */}
      {open && <rect x={0} y={y} width={geo.w} height={H - y} fill={fill} />}
      <line x1={0} y1={y} x2={geo.w} y2={y} stroke="var(--color-line-subtle)" strokeWidth={1} />
      {/* The ^, filled with the band's colour (covering the line under it),
          rising and sinking with the band (scaleY from the line). */}
      {geo.x !== null && (
        <g
          className="transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${open ? 1 : 0})`, transformOrigin: `0 ${y}px`, transformBox: 'view-box' }}
        >
          <polygon points={`${geo.x - C},${H} ${geo.x},${y - C} ${geo.x + C},${H}`} fill={fill} />
          <polyline points={`${geo.x - C},${y} ${geo.x},${y - C} ${geo.x + C},${y}`} fill="none" stroke="var(--color-line-subtle)" strokeWidth={1} />
        </g>
      )}
    </svg>
  )
}
