import { useEffect, useRef, useState } from 'react'
import { fieldToPick, pickToField, toRgb255, type FieldKind } from '../../shared/theme-colors'
import { Icon } from './Icon'
import { ICON_BUTTON } from './button-classes'
import { CalloutArrow, CALLOUT_GAP } from './CalloutArrow'
import { SWATCH_RING_OUT } from '../lib/swatch'

/** Chromium's EyeDropper (2026-11-25): a colour from anywhere on screen,
 *  the image in the editor included. Null when cancelled (Esc). */
async function pickFromScreen(): Promise<string | null> {
  const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
  if (!ED) return null
  try {
    const { sRGBHex } = await new ED().open()
    if (sRGBHex.startsWith('#')) return sRGBHex.toLowerCase()
    const m = sRGBHex.match(/\d+/g)
    return m ? '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('') : null
  } catch {
    return null
  }
}
const HAS_EYEDROPPER = typeof window !== 'undefined' && 'EyeDropper' in window

/* The Custom picker for Settings › Appearance (2026-11-22; replaced the
   system colour panel, which offered colours the theme then quietly pulled
   into its band). It holds only colours that can be had: a field of tint
   strength (left → right) by brightness (top = lightest) inside the band,
   at the hue chosen on the strip below. Every point is drawn as the colour
   it gives, so what you see is what you pick. A release saves.
   The image editor's Custom colour uses it too (2026-11-24, replacing the
   system colour panel there as well): kind `free`, any colour (HSV), shown
   `bare` inside the toolbar's callout, which positions and closes it. */

const FIELD_W = 200
const FIELD_H = 120
const STRIP_H = 12
/** Half the knobs' 12px (w-3). */
const KNOB_R = 6
/** The box's inside padding (p-2.5), when it draws its own box. */
const PAD = 10
/** Field canvas resolution, smoothed up by the browser: each point runs
 *  the clamp, and the accent's (a brightness search per point) costs ~20×
 *  a base's, so it draws coarser to keep hue dragging smooth. */
const RES: Record<FieldKind, number> = { accent: 0.25, light: 0.5, dark: 0.5, free: 1 }

export function ColorPicker({ kind, initial, onPreview, onPick, onClose, label, bare = false, sourceFromRight = 12 }: {
  kind: FieldKind
  /** The colour it opens on (the current pick, or the default). */
  initial: string
  /** Every move (the Custom swatch follows it). */
  onPreview: (hex: string) => void
  /** A release: save. */
  onPick: (hex: string) => void
  onClose: () => void
  label: string
  /** Only the field and the strip: the host draws the box around it and
   *  closes it (click outside, Esc). */
  bare?: boolean
  /** Its own box: how far the source's centre (the Custom swatch) sits
   *  from the box's right edge, where the triangle points (px). */
  sourceFromRight?: number
}) {
  // Opens on `initial` only; later changes to it come from this picker.
  const [start] = useState(() => pickToField(kind, initial))
  const [hue, setHue] = useState(start.h)
  const [pos, setPos] = useState({ x: start.x, y: start.y })
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = fieldToPick(kind, pos.x, pos.y, hue)

  // The field for the current hue.
  useEffect(() => {
    const cv = fieldRef.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const w = cv.width, h = cv.height
    const img = ctx.createImageData(w, h)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const [r, g, b] = toRgb255(fieldToPick(kind, (i + 0.5) / w, (j + 0.5) / h, hue))
      const k = (j * w + i) * 4
      img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [kind, hue])

  // The hue strip at full tint strength and the current brightness, so the
  // hues read even for a pale base. Free: the pure hues (full saturation and
  // brightness), which a dark pick would turn black.
  useEffect(() => {
    const cv = stripRef.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const w = cv.width
    const img = ctx.createImageData(w, 1)
    for (let i = 0; i < w; i++) {
      const [r, g, b] = toRgb255(fieldToPick(kind, 1, kind === 'free' ? 0 : pos.y, ((i + 0.5) / w) * 360))
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [kind, pos.y])

  // Click outside, Esc or a window resize closes, like every callout
  // (bare: the host does).
  useEffect(() => {
    if (bare) return
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, bare])

  // The eyedropper (2026-11-25), only on the full-spectrum picker (`free`):
  // the theme pickers hold colours inside a band, which a screen pick would
  // leave. The pick moves the field and strip to it and saves.
  const eyedropOn = kind === 'free' && HAS_EYEDROPPER
  const stripW = eyedropOn ? FIELD_W - 32 - 8 : FIELD_W
  const eyedrop = async () => {
    const hex = await pickFromScreen()
    if (!hex) return
    const f = pickToField(kind, hex)
    setHue(f.h)
    setPos({ x: f.x, y: f.y })
    onPreview(hex)
    onPick(hex)
  }

  // Drag on the field or the strip; the release saves. A release can go
  // missing (let go over the AppBar's window-drag area, or outside the
  // window): a move with no button held, a cancel or a lost capture also
  // ends the drag, at the last position, so the picker never follows a
  // pointer that isn't pressed (2026-11-22).
  const drag = (target: 'field' | 'strip') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let x = pos.x, y = pos.y, h = hue
    let done = false
    const place = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect()
      // The strip's knob stays inside the strip (2026-11-25): its centre
      // runs from KNOB_R in from one end to KNOB_R in from the other, and
      // the pointer moves the centre; the field's knob still reaches the
      // edges.
      const fx = target === 'strip'
        ? Math.min(1, Math.max(0, (ev.clientX - r.left - KNOB_R) / (r.width - 2 * KNOB_R)))
        : Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
      const fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
      if (target === 'field') { x = fx; y = fy; setPos({ x, y }) } else { h = fx * 360; setHue(h) }
      onPreview(fieldToPick(kind, x, y, h))
    }
    const end = () => {
      if (done) return
      done = true
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
      window.removeEventListener('pointermove', check)
      onPick(fieldToPick(kind, x, y, h))
    }
    const move = (ev: PointerEvent) => {
      if (ev.buttons === 0) { end(); return }
      place(ev)
    }
    const check = (ev: PointerEvent) => { if (ev.buttons === 0) end() }
    place(e)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
    // Capture can be dropped without lostpointercapture reaching us; the
    // window still sees the next move and its empty buttons.
    window.addEventListener('pointermove', check)
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Custom ${label}`}
      // Bare: focusable (not a Tab stop), so a press on the field takes focus
      // here instead of nowhere, and the editor's text entry sees focus land
      // in its style controls and stays open.
      tabIndex={bare ? -1 : undefined}
      // Its own box (2026-11-26): a callout under the swatch, right edges
      // flush, the triangle on the swatch, the inset line edge. CALLOUT_GAP
      // from the source's visible edge: the Custom swatch wears its selection
      // ring while the picker is open (SWATCH_RING_OUT), so 12 + 2.5 below the swatch
      // (it was 12 from the swatch, 9 from the ring).
      className={bare ? 'flex flex-col gap-2 outline-none' : 'absolute top-full right-0 z-[100] p-2.5 rounded-lg bg-elevated ring-1 ring-inset ring-line flex flex-col gap-2'}
      style={bare ? undefined : { marginTop: CALLOUT_GAP + SWATCH_RING_OUT }}
    >
      {/* `centre` from the box's left edge: the box is FIELD_W + 2 PAD wide
          (the edge is a ring, inside the padding). */}
      {!bare && <CalloutArrow side="top" centre={FIELD_W + 2 * PAD - sourceFromRight} />}
      <div className="relative" style={{ width: FIELD_W, height: FIELD_H }}>
        <canvas
          ref={fieldRef}
          width={FIELD_W * RES[kind]}
          height={FIELD_H * RES[kind]}
          onPointerDown={drag('field')}
          aria-label="Strength and brightness"
          // The edge on the option buttons' elevated fill (2026-11-25, as
          // the Background panel's swatches), so the see-through line
          // renders like a button's on any ground (the panel's band is
          // toolbar).
          className="block w-full h-full rounded-md border border-line bg-elevated"
        />
        <span
          className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white ring-1 ring-black/40 pointer-events-none"
          style={{ left: pos.x * FIELD_W, top: pos.y * FIELD_H, background: current }}
        />
      </div>
      {/* The hue strip, with the eyedropper at its left end on the
          full-spectrum picker (2026-11-25, 8px apart; a row under it
          before), the strip shortened so the two fill the field's width. */}
      <div className="flex items-center gap-2" style={{ width: FIELD_W }}>
      {eyedropOn && (
          <button
            type="button"
            onClick={() => void eyedrop()}
            className={ICON_BUTTON}
            data-tip="Pick"
            aria-label="Pick a colour from the screen"
          >
            <Icon name="colorize" className="text-[16px]" />
          </button>
      )}
      <div className="relative" style={{ width: stripW, height: STRIP_H }}>
        <canvas
          ref={stripRef}
          width={Math.round(stripW / 2)}
          height={1}
          onPointerDown={drag('strip')}
          aria-label="Hue"
          className="block w-full h-full rounded-full border border-line bg-elevated"
        />
        <span
          className="absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white ring-1 ring-black/40 pointer-events-none"
          // Inside the strip: the hue picked sits under the knob's left edge
          // at the start, its middle halfway, its right edge at the end.
          style={{ left: KNOB_R + (hue / 360) * (stripW - 2 * KNOB_R) }}
        />
      </div>
      </div>
    </div>
  )
}
