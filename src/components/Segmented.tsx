import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

/** Single-choice control: a white (light) / fill (dark) track with the
 *  selected option in the active purple. Text options, icon-only options
 *  (give a `title`), or both. Inner radius 6 = track radius 8 - 2px inset.
 *
 *  The standard single select (2026-11-23): 32px track, icon segments 28 x
 *  26px with a 16px icon (2026-11-24: 28 wide so a segment with the 2px
 *  inset each side spans 32px, the icon buttons' size; 26 square, wider
 *  ones and a flush, no-inset track were compared and dropped) (or `content`, e.g. a stroke dot or a sticker
 *  thumbnail). A `value` matching no option shows no pill (nothing
 *  selected: a custom stroke width, a sticker search).
 *
 *  The purple is one pill behind the buttons that slides to the picked
 *  option (2026-11-22, the one animation Jasper asked for here). It is
 *  measured from the active button, so options of different widths work.
 *
 *  The on-accent colour follows the pill (2026-11-23, iOS-style): the
 *  buttons are always grey; a second, white copy of the options lies on
 *  top, clipped to exactly where the pill is, and the clip slides with it.
 *  So an icon or label is white only where it's over purple, at every
 *  moment of the slide (it used to turn white at once and flash on the
 *  white track in light mode before the pill arrived). */
/** Equal columns as wide as the widest option: an auto-sized grid's `1fr`
 *  columns each take the largest item's width. */
const EQUAL_ROW = 'inline-grid grid-flow-col auto-cols-fr'

export function Segmented<K extends string>({ value, onChange, options, stretch, equal, pillColor }: {
  value: K
  onChange: (k: K) => void
  /** Fill the row: the track takes the full width and the options share it
   *  equally (the History panel's tabs, 2026-11-23). */
  stretch?: boolean
  /** Every option as wide as the widest (2026-11-23, the History panel's
   *  tabs: "Edit History" rendered ~15px narrower than "Recent Images"),
   *  like macOS's segmented controls; the track hugs them. */
  equal?: boolean
  /** The pill's colour instead of the accent (the capture overlay: the clip
   *  type's blue / pink, 2026-11-24). A CSS colour. */
  pillColor?: string
  /** `square`: a short text option (the Dashboard's "All") the same
   *  size as an icon segment, its word centred (2026-11-24). */
  /** `tip`: a tooltip for a labelled option, which otherwise gets none
   *  (the capture overlay's how-to hints, 2026-11-24). */
  /** `disabled`: shown but can't be picked (grey, no hover), so the row
   *  keeps its shape (the capture overlay's Scroll in Video, 2026-11-24).
   *  aria-disabled, not `disabled`, so its tooltip still shows. */
  options: { key: K; label?: string; icon?: string; title?: string; tip?: string; content?: ReactNode; square?: boolean; disabled?: boolean }[]
}) {
  const buttons = useRef(new Map<K, HTMLButtonElement>())
  const trackRef = useRef<HTMLDivElement>(null)
  /** The pill, px from the track's padding edge; `track` is that box's width
   *  (for the white layer's clip). */
  const [pill, setPill] = useState<{ left: number; width: number; track: number } | null>(null)
  // No slide on the first placement: the pill appears where it belongs.
  const placed = useRef(false)

  useLayoutEffect(() => {
    const el = buttons.current.get(value)
    if (!el) { setPill(null); return }
    const place = () => setPill({ left: el.offsetLeft, width: el.offsetWidth, track: trackRef.current?.clientWidth ?? 0 })
    place()
    // Labels can change width (font load, text change): follow them.
    const ro = new ResizeObserver(place)
    ro.observe(el)
    if (trackRef.current) ro.observe(trackRef.current)
    return () => ro.disconnect()
  }, [value])

  useLayoutEffect(() => {
    if (pill && !placed.current) {
      const id = requestAnimationFrame(() => { placed.current = true })
      return () => cancelAnimationFrame(id)
    }
  }, [pill])

  return (
    <div ref={trackRef} className={`relative h-8 ${stretch ? 'flex w-full items-center' : equal ? EQUAL_ROW : 'inline-flex items-center'} p-0.5 rounded-lg bg-elevated border border-line`}>
      {pill && (
        <span
          aria-hidden
          className={`segmented-pill absolute top-0.5 bottom-0.5 left-0 rounded-md bg-accent ${
            placed.current ? 'segmented-pill-slide' : ''
          }`}
          style={{ width: pill.width, transform: `translateX(${pill.left}px)`, ...(pillColor ? { background: pillColor } : null) }}
        />
      )}
      {options.map(({ key, label, icon, title, tip, content, square, disabled }) => {
        const active = value === key
        return (
          <button
            key={key}
            ref={el => { if (el) buttons.current.set(key, el); else buttons.current.delete(key) }}
            onClick={() => { if (!disabled) onChange(key) }}
            aria-disabled={disabled || undefined}
            data-key={key}
            data-tip={tip ?? (label ? undefined : title)}
            aria-label={title ?? label}
            aria-pressed={active}
            className={`relative h-full inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium ${
              stretch ? 'flex-1 px-2' : label && !square ? 'px-2' : 'w-7'
            } ${disabled ? 'text-fg-disabled' : active ? 'text-fg-secondary' : 'text-fg-secondary hover:text-fg'}`}
          >
            {content ?? (icon && <Icon name={icon} className="text-[16px]" />)}
            {label}
          </button>
        )
      })}
      {/* The white copy over the pill (see above): the same row laid out
          the same way, on-accent, clipped to the pill's box (2px in top and
          bottom, its 6px corners), the clip sliding with the pill. Not
          interactive; hidden from assistive tech. */}
      {pill && (
        <div
          aria-hidden
          className={`absolute inset-0 p-0.5 ${equal && !stretch ? EQUAL_ROW : 'flex items-center'} text-on-accent pointer-events-none ${placed.current ? 'segmented-clip-slide' : ''}`}
          style={{ clipPath: `inset(2px ${Math.max(0, pill.track - pill.left - pill.width)}px 2px ${pill.left}px round 6px)` }}
        >
          {options.map(({ key, label, icon, content, square }) => (
            <span
              key={key}
              className={`h-full inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium ${stretch ? 'flex-1 px-2' : `flex-shrink-0 ${label && !square ? 'px-2' : 'w-7'}`}`}
            >
              {content ?? (icon && <Icon name={icon} className="text-[16px]" />)}
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
