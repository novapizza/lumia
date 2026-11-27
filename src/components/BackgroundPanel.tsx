import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { CalloutArrow, CALLOUT_GAP } from './CalloutArrow'
import { createPortal } from 'react-dom'
import { Segmented } from './Segmented'
import type { CanvasFrame } from './AnnotationCanvas/Canvas'
import { ColorPicker } from './ColorPicker'
import { CustomSwatchIcon } from './CustomSwatchIcon'
import { swatchClass, swatchFill, SWATCH_ROW } from '../lib/swatch'
import { Icon } from './Icon'
import { ICON_BUTTON } from './button-classes'
import { isLight } from '../lib/is-light'
import { CaretDivider } from './CaretDivider'

/* ── Types ── */

export interface GradientDef {
  angle: number
  stops: Array<{ offset: number; color: string }>
}

export interface BgSettings {
  type: 'none' | 'gradient' | 'solid'
  /** A preset, or -1 for the custom gradient (2026-11-25). */
  /** The preset in use, and the one a cleared Custom goes back to. */
  gradientIndex: number
  /** Custom gradient (2026-11-25): in use, and its two colours (start, end;
   *  135° like the presets), null until one is made or after a clear. */
  gradientIsCustom: boolean
  customGradient: string[] | null
  /** The preset drawn the other way round (2026-11-25, Flip). Picking
   *  another preset resets it. */
  gradientFlipped: boolean
  /** The preset colour in use, and the one a cleared Custom goes back to. */
  solidColor: string
  /** Solid's Custom colour (2026-11-25): in use, and the colour (null until
   *  one is made or after a clear). */
  solidIsCustom: boolean
  customSolid: string | null
  /** Image pixels of background showing around the image. */
  /** Background around the image, % of its longer side (2026-11-25;
   *  image pixels, 0 to 400, before). */
  padding: number
  /** Drop shadow under the image, 0 to 100 (shadowOf). */
  shadow: number
  /** The picture's shape: 'auto' (the image plus even padding) or 'w:h'.
   *  ('original', the image's own shape, tried 2026-11-25 and dropped.) */
  ratio: string
  /** Where the image sits when the ratio adds space: t/m/b + l/c/r. */
  alignment: string
}
// Inset, auto-balance and corners (a copy of CleanShot X's Background
// tool, never wired up) dropped 2026-11-25; shadow, ratio and alignment
// dropped and back the same day, now drawn. A radius was tried the same
// day and removed.

export const DEFAULT_BG: BgSettings = {
  type: 'none',
  gradientIndex: 3,
  gradientIsCustom: false,
  customGradient: null,
  gradientFlipped: false,
  solidColor: '#000000',
  solidIsCustom: false,
  customSolid: null,
  padding: 5,
  shadow: 40,
  ratio: 'auto',
  alignment: 'mc',
}

/** The drop shadow for a strength 0 to 100, in image pixels: it falls
 *  further and softer as it grows, up to 65% black (the old getShadowCSS). */
export function shadowOf(strength: number): { offsetY: number; blur: number; alpha: number } | null {
  if (strength <= 0) return null
  return { offsetY: strength / 4, blur: strength * 1.2, alpha: Math.min(strength / 120, 0.65) }
}

/* ── Presets ── */

// Seven, like Solid's colours (2026-11-25; ten before, half of them the
// same colours flipped or a shade off, then five): orange to red, purple to
// pink, dark slate, teal to indigo, indigo to purple, lime to green, light
// silver (the dark slate's light twin).
export const GRADIENT_PRESETS: GradientDef[] = [
  { angle: 135, stops: [{ offset: 0, color: '#f5af19' }, { offset: 1, color: '#f12711' }] },
  { angle: 135, stops: [{ offset: 0, color: '#a855f7' }, { offset: 1, color: '#ec4899' }] },
  { angle: 135, stops: [{ offset: 0, color: '#1e293b' }, { offset: 0.5, color: '#334155' }, { offset: 1, color: '#1e293b' }] },
  { angle: 135, stops: [{ offset: 0, color: '#2dd4bf' }, { offset: 0.5, color: '#67e8f9' }, { offset: 1, color: '#818cf8' }] },
  { angle: 135, stops: [{ offset: 0, color: '#4f46e5' }, { offset: 0.5, color: '#7c3aed' }, { offset: 1, color: '#a855f7' }] },
  { angle: 135, stops: [{ offset: 0, color: '#84cc16' }, { offset: 1, color: '#10b981' }] },
  { angle: 135, stops: [{ offset: 0, color: '#f1f5f9' }, { offset: 1, color: '#cbd5e1' }] },
]

// Seven, one row with Custom (2026-11-25; 24 before: each hue twice, full
// and pale, plus greys): black, dark grey, red, amber, green, blue, violet.
const PLAIN_COLORS = [
  '#000000', '#374151', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6',
]


/* ── Helpers ── */

export function gradientToCSS(g: GradientDef): string {
  return `linear-gradient(${g.angle}deg, ${g.stops.map(s => `${s.color} ${s.offset * 100}%`).join(', ')})`
}

export function drawGradientOnCanvas(
  ctx: CanvasRenderingContext2D,
  g: GradientDef,
  w: number,
  h: number,
) {
  const rad = ((g.angle - 90) * Math.PI) / 180
  const diag = Math.sqrt(w * w + h * h) / 2
  const cx = w / 2
  const cy = h / 2
  const grad = ctx.createLinearGradient(
    cx - Math.cos(rad) * diag,
    cy - Math.sin(rad) * diag,
    cx + Math.cos(rad) * diag,
    cy + Math.sin(rad) * diag,
  )
  g.stops.forEach(s => grad.addColorStop(s.offset, s.color))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

/** The gradient in use: a preset, or the custom one. */
/** The custom gradient's colours (two, or three from an edited preset),
 *  evenly spaced. */
export function customGradientDef(colors: string[]): GradientDef {
  return { angle: 135, stops: colors.map((color, i) => ({ offset: i / Math.max(1, colors.length - 1), color })) }
}
/** A preset, flipped when asked: the same stops the other way round. */
function presetOf(bg: BgSettings): GradientDef {
  const g = GRADIENT_PRESETS[bg.gradientIndex] ?? GRADIENT_PRESETS[0]
  return bg.gradientFlipped
    ? { ...g, stops: g.stops.map(st => ({ ...st, offset: 1 - st.offset })).reverse() }
    : g
}
export function gradientOf(bg: BgSettings): GradientDef {
  return bg.gradientIsCustom && bg.customGradient ? customGradientDef(bg.customGradient) : presetOf(bg)
}
/** The solid colour in use: the custom one, or the preset. */
export function solidOf(bg: BgSettings): string {
  return bg.solidIsCustom && bg.customSolid ? bg.customSolid : bg.solidColor
}
/** What a new Custom starts from. */
const NEW_CUSTOM_GRADIENT = ['#7440d5', '#2dd4bf']
const NEW_CUSTOM_SOLID = '#7440d5'

export function getBackgroundCSS(bg: BgSettings): string {
  if (bg.type === 'gradient') return gradientToCSS(gradientOf(bg))
  if (bg.type === 'solid') return solidOf(bg)
  return 'radial-gradient(circle, #18181b 0%, #09090b 100%)'
}


/** The canvas frame for these settings, or none (no fill, or no padding). */
export function frameOf(bg: BgSettings): CanvasFrame | undefined {
  if (bg.type === 'none') return undefined
  const [rw, rh] = bg.ratio.split(':').map(Number)
  return {
    padding: bg.padding,
    ratio: rw > 0 && rh > 0 ? rw / rh : null,
    alignX: ({ l: 0, c: 0.5, r: 1 } as Record<string, number>)[bg.alignment[1]] ?? 0.5,
    alignY: ({ t: 0, m: 0.5, b: 1 } as Record<string, number>)[bg.alignment[0]] ?? 0.5,
    shadow: shadowOf(bg.shadow),
    css: getBackgroundCSS(bg),
    paint: (ctx, w, h) => {
      if (bg.type === 'gradient') drawGradientOnCanvas(ctx, gradientOf(bg), w, h)
      else { ctx.fillStyle = solidOf(bg); ctx.fillRect(0, 0, w, h) }
    },
  }
}

/* ── Component ── */

/* Restyled 2026-11-25 (page review): a callout under the editor's
   Background button, like the Upload menu (STYLEGUIDE › Callouts and
   menus): solid elevated box, line edge, 10px padding, a 5px triangle at
   the button, 7px from it. Single selects are Segmented, swatches are the
   toolbar's circles, the slider is a native range drawn flat (`.flat-range`
   in index.css). It was a 280px glass sidebar with scale-on-hover
   swatches, a checkbox and uppercase labels. Only the fill and Padding
   are left (2026-11-25). */

const PANEL_W = 264

const RATIOS = ['auto', '16:9', '4:3', '1:1', '9:16'] as const
/** Top / middle / bottom × left / centre / right, row by row. */
const ALIGNMENTS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
const ARROW = 8

interface Props {
  bg: BgSettings
  onChange: Dispatch<SetStateAction<BgSettings>>
  /** The Background button: the callout hangs under it, and a press on it
   *  is left to its own click (which closes the panel, a toggle). */
  anchorEl: HTMLElement
  onClose: () => void
}

export default function BackgroundPanel({ bg, onChange, anchorEl, onClose }: Props) {
  const set = <K extends keyof BgSettings>(key: K, val: BgSettings[K]) =>
    onChange(prev => ({ ...prev, [key]: val }))

  // The custom gradient: which colour the picker edits (null: none open).
  const custom = bg.gradientIsCustom
  // The active colour's options (2026-11-25): a click on the active preset
  // gradient folds them away, another click (or another swatch) opens them.
  // Not on Custom, whose click clears it.
  const [optionsOpen, setOptionsOpen] = useState(true)
  const bandOpen = bg.type === 'solid' || custom || optionsOpen
  const pickPreset = (i: number) => {
    if (!custom && bg.gradientIndex === i) { setOptionsOpen(o => !o); return }
    setOptionsOpen(true)
    onChange(p => ({ ...p, gradientIndex: i, gradientIsCustom: false, gradientFlipped: false }))
  }
  const [editStop, setEditStop] = useState<number | null>(custom ? 0 : null)
  const setStop = (i: number, hex: string) =>
    onChange(prev => {
      const next = [...(prev.customGradient ?? NEW_CUSTOM_GRADIENT)]
      next[i] = hex
      return { ...prev, customGradient: next }
    })
  const pickSolid = (hex: string) => onChange(p => ({ ...p, customSolid: hex }))
  // The Custom swatches (2026-11-25, CustomSwatchIcon): + with no custom
  // colour, a pencil while it isn't in use (a click takes it back), × while
  // it is (a click clears it and goes back to the preset in use before).
  const toggleCustomGradient = () => {
    setOptionsOpen(true)
    if (custom) {
      onChange(p => ({ ...p, gradientIsCustom: false, customGradient: null }))
      setEditStop(null)
    } else {
      onChange(p => ({ ...p, gradientIsCustom: true, customGradient: p.customGradient ?? NEW_CUSTOM_GRADIENT }))
      setEditStop(0)
    }
  }
  const toggleCustomSolid = () => onChange(p => p.solidIsCustom
    ? { ...p, solidIsCustom: false, customSolid: null }
    : { ...p, solidIsCustom: true, customSolid: p.customSolid ?? NEW_CUSTOM_SOLID })
  // The icon in black or white, whichever reads on the gradient's middle.
  const customLight = !!bg.customGradient && bg.customGradient.every(isLight)
  // A preset's two actions (2026-11-25): Flip draws it the other way round;
  // Edit loads its colours, as drawn, into a new custom gradient (replacing
  // the custom one) and opens it.
  const flipPreset = () => onChange(p => ({ ...p, gradientFlipped: !p.gradientFlipped }))
  const editPreset = () => {
    onChange(p => ({ ...p, gradientIsCustom: true, customGradient: presetOf(p).stops.map(st => st.color) }))
    setEditStop(0)
  }

  const ref = useRef<HTMLDivElement>(null)
  // Placed like the Upload menu: centred under the button when the window
  // allows, else kept 8px inside it; above the button when there's no room.
  const [pos, setPos] = useState<{ top: number; left: number; side: 'below' | 'above'; arrowLeft: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const anchor = anchorEl.getBoundingClientRect()
      const { width, height } = el.getBoundingClientRect()
      const EDGE = 8, GAP = CALLOUT_GAP
      const below = anchor.bottom + GAP
      const side = below + height <= window.innerHeight - EDGE ? 'below' : 'above'
      const top = side === 'below' ? below : Math.max(EDGE, anchor.top - GAP - height)
      const centre = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(EDGE, centre - width / 2), window.innerWidth - EDGE - width)
      const arrowLeft = Math.min(width - 16, Math.max(8, centre - left - ARROW / 2))
      setPos({ top, left, side, arrowLeft })
    }
    place()
  }, [anchorEl])
  // A window resize closes it (2026-11-26; it followed its button before),
  // like the Upload menu and the toolbar's callouts. Its own effect, so a
  // new onClose never re-places it.
  useEffect(() => {
    window.addEventListener('resize', onClose)
    return () => window.removeEventListener('resize', onClose)
  }, [onClose])

  // A press outside or Esc closes it (Callouts and menus).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorEl.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, anchorEl])

  // Swatches: the one look (lib/swatch.ts), on the panel's elevated ground.
  const swatch = (selected: boolean) => swatchClass(selected, 'elevated')

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Background"
      className="fixed z-[100] rounded-lg bg-elevated flex flex-col"
      style={pos ? { top: pos.top, left: pos.left, width: PANEL_W } : { top: 0, left: 0, width: PANEL_W, visibility: 'hidden' }}
    >
      {/* The inset edge as an overlay (2026-11-26; a border before), over
          the full-width options band that would cover a ring on the box;
          the triangle above it, to open it. */}
      <span aria-hidden className="absolute inset-0 z-10 rounded-lg ring-1 ring-inset ring-line pointer-events-none" />
      {pos && <CalloutArrow side={pos.side === 'below' ? 'top' : 'bottom'} centre={pos.arrowLeft + ARROW / 2} className="z-20" />}

      {/* Top: the fill kind and its swatches. */}
      <div className="px-2.5 pt-2.5 flex flex-col gap-3">
        <Segmented<BgSettings['type']>
          value={bg.type}
          onChange={t => set('type', t)}
          stretch
          options={[{ key: 'none', label: 'None' }, { key: 'gradient', label: 'Gradient' }, { key: 'solid', label: 'Solid' }]}
        />

        {/* The fills of the picked kind; the swatches' 6px gap like the
            toolbar's. */}
        {bg.type === 'gradient' && (
          <div className={`${SWATCH_ROW} flex-wrap justify-center`}>
            {GRADIENT_PRESETS.map((g, i) => (
              <button
                key={i}
                type="button"
                onClick={() => pickPreset(i)}
                aria-expanded={!custom && bg.gradientIndex === i ? optionsOpen : undefined}
                aria-label={`Gradient ${i + 1}`}
                aria-pressed={!custom && bg.gradientIndex === i}
                data-active-swatch={!custom && bg.gradientIndex === i ? '' : undefined}
                className={swatch(!custom && bg.gradientIndex === i)}
                style={{ background: onEdgeBase(gradientToCSS(i === bg.gradientIndex ? presetOf(bg) : g)) }}
              />
            ))}
            {/* Custom (2026-11-25), like the toolbar's Custom colour: +, then
                the custom gradient with a pencil, × while in use; picked, its
                two colours show below. */}
            <button
              type="button"
              onClick={toggleCustomGradient}
              data-tip={custom ? 'Clear' : 'Custom'}
              aria-label={custom ? 'Clear custom gradient' : 'Custom gradient'}
              aria-pressed={custom}
              data-active-swatch={custom ? '' : undefined}
              className={swatch(custom)}
              style={{ background: onEdgeBase(bg.customGradient ? gradientToCSS(customGradientDef(bg.customGradient)) : 'var(--color-elevated)') }}
            >
              <CustomSwatchIcon state={custom ? 'clear' : bg.customGradient ? 'edit' : 'add'} on={customLight ? '#ffffff' : '#000000'} />
            </button>
          </div>
        )}

        {bg.type === 'solid' && (
          <div className={`${SWATCH_ROW} flex-wrap justify-center`}>
            {PLAIN_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => onChange(p => ({ ...p, solidColor: c, solidIsCustom: false }))}
                aria-label={c}
                aria-pressed={!bg.solidIsCustom && bg.solidColor === c}
                data-active-swatch={!bg.solidIsCustom && bg.solidColor === c ? '' : undefined}
                className={swatch(!bg.solidIsCustom && bg.solidColor === c)}
                style={{ background: onEdgeBase(c) }}
              />
            ))}
            {/* Custom (2026-11-25), as on the Gradient tab: +, pencil, ×;
                picked, the picker shows below. */}
            <button
              type="button"
              onClick={toggleCustomSolid}
              data-tip={bg.solidIsCustom ? 'Clear' : 'Custom'}
              aria-label={bg.solidIsCustom ? 'Clear custom colour' : 'Custom colour'}
              aria-pressed={bg.solidIsCustom}
              data-active-swatch={bg.solidIsCustom ? '' : undefined}
              className={swatch(bg.solidIsCustom)}
              style={{ background: onEdgeBase(bg.customSolid ?? 'var(--color-elevated)') }}
            >
              <CustomSwatchIcon state={bg.solidIsCustom ? 'clear' : bg.customSolid ? 'edit' : 'add'} on={bg.customSolid ?? undefined} />
            </button>
          </div>
        )}
      </div>

      {/* (2026-11-25, final) The active colour's options in a band
          a level down (toolbar), from the line with the ^ under the active
          swatch to the line above the picture settings. */}
      {/* Folding (2026-11-25, Jasper's named animation): the band's height
          glides open and shut (grid rows 0fr ↔ 1fr, 200ms like the History
          panel's docking), the ^ rising and sinking with it; folded, only
          the plain line is left. Off under reduced motion. */}
      {(bg.type === 'gradient' || (bg.type === 'solid' && bg.solidIsCustom && !!bg.customSolid)) ? (
        <div className="mt-3">
          <CaretDivider panelRef={ref} open={bandOpen} />
          <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${bandOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
          <div className="bg-toolbar border-b border-line-subtle px-2.5 py-2.5 flex flex-col gap-3">
          {/* (2026-11-25, final) A preset picked shows the gradient
              in use as a bar, its actions (Flip, Edit) beside it, so they read
              as acting on it. */}
          {bg.type === 'gradient' && !custom && (
            <div className="flex items-center gap-3">
              <div
                aria-hidden="true"
                // Inset line edge over the buttons' elevated fill
                // (onEdgeBase), so it renders like theirs.
                className="flex-1 h-8 rounded-lg border border-line"
                style={{ background: onEdgeBase(gradientToCSS(presetOf(bg))) }}
              />
              <button type="button" onClick={flipPreset} className={ICON_BUTTON} data-tip="Flip" aria-label="Flip gradient">
                <Icon name="swap_horiz" className="text-[16px]" />
              </button>
              <button type="button" onClick={editPreset} className={ICON_BUTTON} data-tip="Edit" aria-label="Edit gradient">
                <Icon name="pencil" className="text-[16px]" />
              </button>
            </div>
          )}

          {/* The custom gradient's colours (Start, End; Middle too from an
              edited three-colour preset): a click picks which one the picker
              below changes (the ring marks it). */}
          {bg.type === 'gradient' && custom && bg.customGradient && (
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center justify-center gap-3">
                {(bg.customGradient.length === 3 ? ['Start', 'Middle', 'End'] : ['Start', 'End']).map((name, i) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setEditStop(i)}
                    aria-pressed={editStop === i}
                    className="group/stop flex items-center gap-1.5 text-xs font-medium text-fg-secondary hover:text-fg"
                  >
                    <span className={swatchClass(editStop === i, 'toolbar')} style={{ background: onEdgeBase(bg.customGradient![i]) }} />
                    {name}
                  </button>
                ))}
              </div>
              {editStop !== null && (
                <ColorPicker
                  key={editStop}
                  kind="free"
                  bare
                  initial={bg.customGradient[editStop]}
                  onPreview={hex => setStop(editStop, hex)}
                  onPick={hex => setStop(editStop, hex)}
                  onClose={() => setEditStop(null)}
                  label={editStop === 0 ? 'start colour' : editStop === bg.customGradient.length - 1 ? 'end colour' : 'middle colour'}
                />
              )}
            </div>
          )}
          {bg.type === 'solid' && bg.solidIsCustom && bg.customSolid && (
            <div className="flex justify-center">
              <ColorPicker
                kind="free"
                bare
                initial={bg.customSolid}
                onPreview={pickSolid}
                onPick={pickSolid}
                onClose={() => {}}
                label="colour"
              />
            </div>
          )}

          </div>
          </div>
          </div>
        </div>
      ) : bg.type !== 'none' && (
        // No options (a preset solid): only the line above the settings.
        <div aria-hidden="true" className="mt-3 h-px bg-line-subtle" />
      )}

      {/* Bottom: the picture settings (none without a fill). */}
      {bg.type !== 'none' ? (
      <div className="p-2.5 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Slider label="Padding" value={bg.padding} min={0} max={50} unit="%" onChange={v => set('padding', v)} />
          <Slider label="Shadow" value={bg.shadow} min={0} max={100} onChange={v => set('shadow', v)} />
        </div>

        {/* Ratio in one row (2026-11-25; caption above before), like Alignment. */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-fg-secondary">Ratio</span>
          <Segmented<typeof RATIOS[number]>
            value={bg.ratio as typeof RATIOS[number]}
            onChange={r => set('ratio', r)}
            options={RATIOS.map(r => ({ key: r, label: r === 'auto' ? 'Auto' : r }))}
          />
        </div>

        {/* Alignment only matters when a ratio adds space. */}
        {bg.ratio !== 'auto' && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-fg-secondary">Alignment</span>
            {/* A 3×3 single select: a segmented track in a grid, the picked
                cell in the accent like a segment. Not one of the
                single-select grids of framed options (STYLEGUIDE › Buttons
                and controls): it keeps a segmented track's 2px gaps. */}
            <div role="radiogroup" aria-label="Alignment" className="grid grid-cols-3 gap-0.5 p-0.5 rounded-lg border border-line">
              {ALIGNMENTS.map(a => {
                const on = bg.alignment === a
                return (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`${{ t: 'Top', m: 'Middle', b: 'Bottom' }[a[0]]} ${{ l: 'left', c: 'centre', r: 'right' }[a[1]]}`}
                    onClick={() => set('alignment', a)}
                    className={`group/al w-6 h-6 rounded-md flex items-center justify-center ${on ? 'bg-accent' : ''}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-on-accent' : 'bg-fg-tertiary group-hover/al:bg-fg'}`} />
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      ) : <div className="pb-2.5" />}
    </div>,
    document.body,
  )
}

/** A fill for a swatch or the preview bar: the swatches' own (lib/swatch.ts),
 *  the colour or gradient inside the border, elevated under it. */
const onEdgeBase = swatchFill

/* ── Sub-components ── */

/** Label, a flat range (accent fill up to the knob), the value. */
function Slider({ label, value, min, max, unit = '', onChange }: {
  label: string
  value: number
  min: number
  max: number
  /** After the value, no space ("5%"). */
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[72px] flex-shrink-0 text-xs font-medium text-fg-secondary">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={e => onChange(Number(e.target.value))}
        className="flat-range flex-1 min-w-0"
        style={{ '--range-pct': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
      <span className="w-8 flex-shrink-0 text-right text-[11px] font-medium text-fg-secondary tabular-nums">{value}{unit}</span>
    </div>
  )
}
