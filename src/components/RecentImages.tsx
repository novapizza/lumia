import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Segmented } from './Segmented'
import { ICON_BUTTON, BARE_ICON_BUTTON } from './button-classes'
import { OnStrip } from './OnStrip'
import { layerIcon, layerName, layerOrder, type StepObject } from '../lib/edit-steps'
import { resolveStickerUrl } from './AnnotationCanvas/Canvas'
import { clipSource, KIND_ICON, SourceText } from './HistoryListRow'
import type { HistoryItem } from '../types'

/* Recent images in the image editor (2026-11-23): the editor's only
   sidebar became a panel floating at the canvas's right, like the toolbar
   (inset edge, 20px in), over the image. A pop-up over the toolbar with its
   triangle on the History button (a thumbnail grid, then a menu-style
   list) was tried side by side and dropped. */

export interface RecentImage {
  id: string
  thumbnailUrl: string
  name: string
  timestamp: number
  captureMode?: HistoryItem['captureMode']
  source?: HistoryItem['source']
}

/** The row's title (2026-11-23): where the image came from, as in the
 *  Dashboard ("Region", "Screen", or app / window title); the file name
 *  only for captures with no source recorded (before 2026-11-21). */
function Title({ item }: { item: RecentImage }) {
  const src = clipSource(item as HistoryItem)
  const hasSource = src.mode === 'region' || src.mode === 'screen' || src.parts.length > 0
  // The capture type's icon first, as in the list rows (2026-11-23): 14px,
  // fg-tertiary, 6px before the text.
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {src.mode && <Icon name={KIND_ICON[src.mode]} className="text-[14px] shrink-0 text-fg-tertiary" />}
      <span className="min-w-0 truncate">{hasSource ? <SourceText {...src} /> : item.name}</span>
    </span>
  )
}

interface Common {
  items: RecentImage[]
  /** The image on the canvas: marked, and a click on it does nothing. */
  currentId?: string
  onPick: (item: RecentImage) => void
  onClose: () => void
  /** "2h ago" style label. */
  timeLabel: (ts: number) => string
}

/** Esc and a press outside close it; a press on the History button is left
 *  to its own click (a toggle). */
function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, off = false) {
  useEffect(() => {
    if (off) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (ref.current?.contains(t) || t.closest?.('[data-history]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ref, onClose, off])
}

function Empty() {
  return (
    <div className="flex flex-col items-center py-10 gap-2">
      <Icon name="collections" className="text-[24px] text-fg-tertiary" />
      <p className="text-xs font-medium text-fg-secondary text-center px-4">Your recent images show here</p>
    </div>
  )
}

/** One row of History › Edits: a step's name and icon, and the shape it
 *  touched (lib/edit-steps.ts) for the preview and the canvas highlight. */
export interface EditStepRow {
  label: string
  icon: string
  shape?: StepObject
  /** A picture for the tile instead (the Original row: the image itself). */
  image?: string
}

const PREVIEW_W = 36
const PREVIEW_H = 36
const PREVIEW_PAD = 4

/** A marked row (selected layer, current step, open image): the Dashboard list view's
 *  selected outline, an inset accent ring (1px, 2026-11-24; 2px before, here and on the Dashboard) over the row's edge and no fill
 *  (2026-11-24; an elevated fill with a line edge before). */
function Mark() {
  return <span aria-hidden className="absolute -inset-px z-10 rounded-lg ring-(length:--selection-ring) ring-inset ring-accent pointer-events-none" />
}

/** The step's shape drawn small (2026-11-23): fitted into a 36 x 36 tile (2026-11-24, the Recent tab's square; it was 40 x 28) on
 *  the clip area's fill with an inset line edge, in its own colour, lines
 *  1.5px whatever the scale. Text shows its words; a sticker or a step
 *  without one shape (Original, Cleared, several at once) shows the step's
 *  icon instead. */
// Memoised (2026-11-23): a Layers drag re-renders the list on every pointer
// move, and the shapes don't change meanwhile (same objects), so each row
// keeps its preview instead of rebuilding it.
const ShapePreview = memo(function ShapePreview({ shape, icon, image }: { shape?: StepObject; icon: string; image?: string }) {
  const tile = 'relative w-9 h-9 shrink-0 rounded-md bg-content overflow-hidden'
  const edge = <span className="absolute inset-0 rounded-md ring-1 ring-inset ring-line pointer-events-none" />
  if (image) {
    return <span className={`${tile} block`}><img src={image} className="w-full h-full object-cover" draggable={false} alt="" />{edge}</span>
  }
  // A sticker shows itself (2026-11-26; its step icon before), fitted
  // inside the tile with the shapes' padding.
  if (shape?.type === 'sticker' && shape.src) {
    return <span className={`${tile} block`}><StickerThumb src={shape.src} icon={icon} />{edge}</span>
  }
  const svg = shape && shape.type !== 'sticker' ? previewSvg(shape) : null
  if (!svg) {
    return <span className={`${tile} flex items-center justify-center text-fg-tertiary`}><Icon name={icon} className="text-[16px]" />{edge}</span>
  }
  return <span className={`${tile} block`}>{svg}{edge}</span>
})

/** A sticker's picture for its preview tile, through the canvas's sticker
 *  cache (the canvas has it already, so no extra fetch); the step icon
 *  until it's there or if it fails. */
function StickerThumb({ src, icon }: { src: string; icon: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    resolveStickerUrl(src).then(u => { if (alive) setUrl(u) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [src])
  if (url) return <img src={url} className="absolute inset-0 w-full h-full object-contain p-1" draggable={false} alt="" />
  if (failed) return <span className="absolute inset-0 flex items-center justify-center text-fg-tertiary"><Icon name={icon} className="text-[16px]" /></span>
  return null
}

function previewSvg(o: StepObject) {
  // The shape's box in image units.
  let x0: number, y0: number, x1: number, y1: number
  if ((o.type === 'pen' || o.type === 'highlighter' || o.type === 'arrow') && o.points && o.points.length >= 2) {
    const xs = o.points.filter((_, i) => i % 2 === 0), ys = o.points.filter((_, i) => i % 2 === 1)
    x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys)
  } else if (o.type === 'ellipse') {
    const rx = Math.abs(o.radiusX ?? 0), ry = Math.abs(o.radiusY ?? 0)
    x0 = (o.x ?? 0) - rx; x1 = (o.x ?? 0) + rx; y0 = (o.y ?? 0) - ry; y1 = (o.y ?? 0) + ry
  } else if (o.type === 'text') {
    return (
      <span className="absolute inset-0 flex items-center px-1 text-[9px] font-semibold leading-none truncate" style={{ color: o.color }}>
        {o.text || 'T'}
      </span>
    )
  } else {
    const w = o.width ?? 0, h = o.height ?? 0
    x0 = Math.min(o.x ?? 0, (o.x ?? 0) + w); x1 = Math.max(o.x ?? 0, (o.x ?? 0) + w)
    y0 = Math.min(o.y ?? 0, (o.y ?? 0) + h); y1 = Math.max(o.y ?? 0, (o.y ?? 0) + h)
  }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0)
  const k = Math.min((PREVIEW_W - 2 * PREVIEW_PAD) / bw, (PREVIEW_H - 2 * PREVIEW_PAD) / bh)
  const ox = (PREVIEW_W - bw * k) / 2 - x0 * k, oy = (PREVIEW_H - bh * k) / 2 - y0 * k
  const X = (v: number) => v * k + ox, Y = (v: number) => v * k + oy
  const blur = o.type === 'blur' || !!o.isBlur
  // The line follows the shape's thickness (2026-11-24; it was 1.5px for
  // all): 0.15px per stroke point (0.35 was too heavy at this size), 0.5 to
  // 3px, so the presets 2 / 4 / 8 read 0.5 / 0.6 / 1.2px (0.5px is one
  // device pixel at 2x). A blur's dashed box keeps 1.5px.
  const lineW = blur ? 1.5 : Math.min(3, Math.max(0.5, (o.strokeWidth ?? 4) * 0.15))
  const stroke = { stroke: blur ? 'var(--color-fg-secondary)' : o.color, strokeWidth: lineW, fill: 'none', vectorEffect: 'non-scaling-stroke' as const, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  let body: React.ReactNode
  if ((o.type === 'pen' || o.type === 'highlighter') && o.points) {
    // One pass, and only points at least a pixel apart in the preview (a
    // long stroke has thousands; the tile is 36 x 36). The old builder
    // copied its list for every point: quadratic, and run per row on every
    // pointer move of a Layers drag (2026-11-23).
    const pts: string[] = []
    let lx = NaN, ly = NaN
    const last = o.points.length - 2
    for (let i = 0; i + 1 < o.points.length; i += 2) {
      const px = X(o.points[i]), py = Y(o.points[i + 1])
      if (i !== 0 && i !== last && Math.abs(px - lx) < 1 && Math.abs(py - ly) < 1) continue
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`)
      lx = px; ly = py
    }
    body = <polyline points={pts.join(' ')} {...stroke} />
  } else if (o.type === 'arrow' && o.points && o.points.length >= 4) {
    const [ax, ay, bx, by] = [X(o.points[0]), Y(o.points[1]), X(o.points[o.points.length - 2]), Y(o.points[o.points.length - 1])]
    const ang = Math.atan2(by - ay, bx - ax), hl = 4 + lineW
    const h1 = [bx - hl * Math.cos(ang - 0.5), by - hl * Math.sin(ang - 0.5)]
    const h2 = [bx - hl * Math.cos(ang + 0.5), by - hl * Math.sin(ang + 0.5)]
    body = <><line x1={ax} y1={ay} x2={bx} y2={by} {...stroke} /><polyline points={`${h1[0]},${h1[1]} ${bx},${by} ${h2[0]},${h2[1]}`} {...stroke} /></>
  } else if (o.type === 'ellipse') {
    body = <ellipse cx={X(o.x ?? 0)} cy={Y(o.y ?? 0)} rx={bw * k / 2} ry={bh * k / 2} {...stroke} />
  } else {
    body = <rect x={X(x0)} y={Y(y0)} width={bw * k} height={bh * k} rx={1} {...stroke} strokeDasharray={blur ? '4 3' : undefined} />
  }
  return <svg width={PREVIEW_W} height={PREVIEW_H} className="absolute inset-0" aria-hidden>{body}</svg>
}

/** The Layers tab (2026-11-23, design/LAYERS-TAB.md): the shapes front to
 *  back, blurs among them in their real place (a blur blurs what's under
 *  it; new blurs start at the bottom). A click selects (⌘ / Ctrl adds or
 *  removes), a drag moves the shape anywhere in the order, the eye hides
 *  or shows it. Rows jump into place (no motion); a
 *  2px accent line marks the drop spot. */
function LayersList({ layers, selectedIds, onSelect, onReorder, onToggleHidden, onHover }: {
  /** The drawing, back to front (as drawn). */
  layers: StepObject[]
  selectedIds: string[]
  onSelect: (id: string, toggle: boolean) => void
  /** The drawing in its new order, back to front. */
  onReorder: (ids: string[]) => void
  onToggleHidden: (id: string, hidden: boolean) => void
  onHover: (id: string | null) => void
}) {
  // The dropped order (front to back) until the drawing comes back in it:
  // the canvas reports its new order a render after the drop, and showing
  // the old one in between flashed every moved row's thumbnail
  // (2026-11-23).
  const [pending, setPending] = useState<string[] | null>(null)
  const ordered = layerOrder(layers)
  const pendingFits = !!pending && pending.length === ordered.length && ordered.every(o => pending.includes(o.id))
  const rows = pendingFits ? [...ordered].sort((a, b) => pending!.indexOf(a.id) - pending!.indexOf(b.id)) : ordered
  useEffect(() => {
    if (!pending) return
    // Arrived (or the drawing changed some other way): let go.
    if (!pendingFits || ordered.every((o, i) => o.id === pending[i])) setPending(null)
  }, [layers]) // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement>(null)
  // The row being pressed / dragged. While dragged it leaves the list (the
  // rows below close up) and an empty slot opens where the ghost hovers:
  // `slot` indexes the list without it. `top`: the ghost's top in the
  // list's content (follows the pointer).
  const press = useRef<{ id: string; y: number; grab: number; dragging: boolean } | null>(null)
  const [drag, setDrag] = useState<{ id: string; slot: number; top: number } | null>(null)

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center py-10 gap-2">
        <Icon name="layers" className="text-[24px] text-fg-tertiary" />
        <p className="text-xs font-medium text-fg-secondary text-center px-4">Your drawings show here</p>
      </div>
    )
  }

  /** The slot under the ghost's middle, anywhere in the list (blurs too,
   *  2026-11-23). Rows are 50px with 4px between (h-12.5, gap-1; 50px like Recent's, 2026-11-24) under the
   *  list's 8px padding: a 54px pitch. Worked out from the numbers, not
   *  the DOM, since the rows move while dragging. */
  const PITCH = 54, PAD = 8, ROW = 50
  const slotAt = (top: number) => {
    const slot = Math.floor((top + ROW / 2 - PAD + (PITCH - ROW) / 2) / PITCH)
    return Math.max(0, Math.min(rows.length - 1, slot))
  }

  const drop = (id: string, slot: number) => {
    const moved = rows.find(r => r.id === id)
    if (!moved) return
    const next = rows.filter(r => r.id !== id)
    next.splice(slot, 0, moved)
    if (next.every((r, i) => r.id === rows[i].id)) return
    setPending(next.map(r => r.id))
    // Back to front again.
    onReorder([...next].reverse().map(r => r.id))
  }

  // What the list shows: every row, or while dragging the others with an
  // empty slot (null) where the dragged one would land.
  const shown: (StepObject | null)[] = drag
    ? (() => { const r: (StepObject | null)[] = rows.filter(o => o.id !== drag.id); r.splice(drag.slot, 0, null); return r })()
    : rows

  return (
    <div
      ref={listRef}
      className={`flex-1 w-0 min-w-full overflow-y-auto p-2 flex flex-col gap-1 relative ${drag ? 'cursor-grabbing' : ''}`}
      onPointerLeave={() => { if (!press.current) onHover(null) }}
      onPointerMove={e => {
        const p = press.current
        if (!p) return
        if (!p.dragging && Math.abs(e.clientY - p.y) < 4) return
        p.dragging = true
        const list = listRef.current!
        const top = e.clientY - list.getBoundingClientRect().top + list.scrollTop - p.grab
        setDrag({ id: p.id, slot: slotAt(top), top })
      }}
      onPointerUp={e => {
        const p = press.current
        press.current = null
        if (!p) return
        if (p.dragging) { if (drag) drop(p.id, drag.slot); setDrag(null); return }
        onSelect(p.id, e.metaKey || e.ctrlKey)
      }}
      onPointerCancel={() => { press.current = null; setDrag(null) }}
    >
      {shown.map(o => {
        // The open slot: empty space the size of a row.
        if (!o) return <div key="__slot__" aria-hidden className="h-12.5 shrink-0" />
        const selected = selectedIds.includes(o.id)
        const hidden = !!o.hidden
        return (
          <div key={o.id} className="relative">
            {/* The eye ends --pad in, under the pin: list p-2 + 1px border
                + (--pad - 9px). */}
            <div
              data-layer-id={o.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onPointerDown={e => {
                if (e.button !== 0) return
                press.current = { id: o.id, y: e.clientY, grab: e.clientY - e.currentTarget.getBoundingClientRect().top, dragging: false }
                listRef.current?.setPointerCapture(e.pointerId)
              }}
              onPointerEnter={() => { if (!press.current) onHover(o.id) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(o.id, e.metaKey || e.ctrlKey) } }}
              className={`w-full h-12.5 flex items-center gap-2.5 pl-1.5 pr-[calc(var(--pad)-9px)] rounded-lg border border-transparent hover-overlay text-left text-[11px] font-medium select-none ${
                selected ? 'text-fg' : hidden ? 'text-fg-disabled' : 'text-fg-secondary'
              }`}
            >
              {selected && <Mark />}
              {/* The drag handle (2026-11-26): the whole row drags, the
                  grip says so; the open hand over it (closed while a row is
                  dragged, on the list). 6px to the thumbnail. */}
              <span aria-hidden className="w-4 -mr-1 shrink-0 flex justify-center text-fg-tertiary cursor-grab"><Icon name="drag_indicator" className="text-[16px]" /></span>
              <span className={`flex shrink-0 ${hidden ? 'grayscale' : ''}`}><ShapePreview shape={o} icon={layerIcon(o)} /></span>
              <span className="flex-1 min-w-0 truncate">{layerName(o)}</span>
              <button
                type="button"
                onPointerDown={e => e.stopPropagation()}
                onPointerUp={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onToggleHidden(o.id, !hidden) }}
                className={BARE_ICON_BUTTON}
                data-tip={hidden ? 'Show' : 'Hide'}
                aria-label={hidden ? `Show ${layerName(o)}` : `Hide ${layerName(o)}`}
              >
                <Icon name={hidden ? 'visibility_off' : 'visibility'} className="text-[16px]" />
              </button>
            </div>
          </div>
        )
      })}
      {/* The ghost (2026-11-23): the dragged row, following the pointer
          over the list, in the selected-row look. Solid, no shadow. The
          rows jump to make room (no motion). */}
      {drag && (() => {
        const o = rows.find(r => r.id === drag.id)
        if (!o) return null
        return (
          <div
            aria-hidden
            className="absolute left-2 right-2 h-12.5 flex items-center gap-2.5 pl-1.5 pr-[calc(var(--pad)-9px)] rounded-lg border bg-elevated border-line-strong text-fg text-[11px] font-medium pointer-events-none select-none z-10"
            style={{ top: drag.top }}
          >
            <span className="w-4 -mr-1 shrink-0 flex justify-center text-fg-tertiary"><Icon name="drag_indicator" className="text-[16px]" /></span>
            <span className={`flex shrink-0 ${o.hidden ? 'grayscale' : ''}`}><ShapePreview shape={o} icon={layerIcon(o)} /></span>
            <span className="flex-1 min-w-0 truncate">{layerName(o)}</span>
            <span className="w-8 h-8 flex-shrink-0 inline-flex items-center justify-center text-fg-secondary">
              <Icon name={o.hidden ? 'visibility_off' : 'visibility'} className="text-[16px]" />
            </span>
          </div>
        )
      })()}
    </div>
  )
}

/** The History panel (2026-11-23): floating at the canvas's right, like the
 *  floating toolbar: bg-toolbar with an inset line edge, rounded-lg, 20px in
 *  from the top and right, ending 7px above the toolbar. Two tabs (the
 *  standard Segmented): Edits, the open image's steps (newest at the top,
 *  a click jumps there, later steps greyed until the next edit drops them),
 *  and Images, the recent images (rows like the Dashboard's list rows). */
export function HistoryPanel({ tab, onTab, steps, cursor, onStep, onHoverStep, items, currentId, onPick, onClose, timeLabel, pinned, onPin, layers, selectedIds, onSelectLayer, onReorderLayers, onToggleLayerHidden }: Common & {
  tab: 'layers' | 'edits' | 'images'
  onTab: (t: 'layers' | 'edits' | 'images') => void
  /** Layers tab: the drawing back to front, the selected shapes, and what a
   *  click / drag / eye does. */
  layers: StepObject[]
  selectedIds: string[]
  onSelectLayer: (id: string, toggle: boolean) => void
  onReorderLayers: (ids: string[]) => void
  onToggleLayerHidden: (id: string, hidden: boolean) => void
  /** Oldest first; the first is the original (or the earliest kept). */
  steps: EditStepRow[]
  cursor: number
  onStep: (index: number) => void
  /** The shape under the pointer's row (its id), for the canvas highlight. */
  onHoverStep: (shapeId: string | null) => void
  /** Pinned (2026-11-23): a click outside or Esc doesn't close it, and it
   *  opens with the editor. */
  pinned: boolean
  onPin: (pinned: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose, pinned)
  // "5m ago" sublines re-render on every clock minute while Recent shows.
  const [, setMinute] = useState(0)
  useEffect(() => {
    if (tab !== 'images') return
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      setMinute(m => m + 1)
      interval = setInterval(() => setMinute(m => m + 1), 60000)
    }, 60000 - (Date.now() % 60000))
    return () => { clearTimeout(first); if (interval) clearInterval(interval) }
  }, [tab])
  return (
    <div
      ref={ref}
      data-history-panel=""
      // Contents 10px in, pinned or not (it stays a floating frame).
      style={{ '--pad': '10px' } as React.CSSProperties}
      role="dialog"
      aria-label="History"
      // Floating: over the canvas at its right, ending above the toolbar
      // (its 24px + 52px + the 7px callout gap), rounded, inset edge.
      // Pinned (2026-11-23): docked as a sidebar at the window's right, the
      // full height under the AppBar, a line edge on its left; the canvas
      // and toolbar make room (the Editor puts it beside the canvas).
      // A fixed 200px wide either way (2026-11-23; it sized itself to its
      // header and a hidden date row before). Names and titles end in an
      // ellipsis; the lists take that width (w-0 min-w-full).
      // One element in both places, so pinning glides: top, right, bottom
      // and the corners transition (200ms, the Segmented pill's easing; none
      // under reduced motion). Docked edge: a line inside its left side.
      // Pinned (2026-11-24) it stays where it floats (--mx from the side,
      // its frame and corners) and only grows down to the toolbar's bottom
      // edge (--my above the bottom bar); the toolbar moves left of it.
      className={`absolute z-30 w-[200px] flex flex-col bg-toolbar overflow-hidden right-(--mx) rounded-lg ring-1 ring-inset ring-line transition-[top,bottom] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
        !pinned
          // --my under the AppBar; the bottom 7px above the 52px toolbar.
          ? 'top-(--my) bottom-[calc(var(--my)+59px)]'
          : 'top-(--my) bottom-(--my)'
      }`}
    >
      {/* Pin left, tabs right, both --pad (10px) in from the edges. */}
      <div className="flex items-center justify-between gap-2 h-12 px-(--pad) flex-shrink-0 border-b border-line">
        {/* Pin first, tabs at the right (2026-11-24; the other way round
            the day before; its close button was removed then: History, Esc
            or a press outside close it). A framed button with the standard
            on state while pinned (2026-11-27, Jasper: the accent strip, one
            icon for on and off; it was a filled box with a second icon). */}
        <button
          onClick={() => onPin(!pinned)}
          aria-pressed={pinned}
          className={`${ICON_BUTTON} group/on relative`}
          data-tip={pinned ? 'Unpin' : 'Pin'}
          aria-label={pinned ? 'Unpin history' : 'Pin history to the side'}
        >
          <Icon name="pin" className="text-[16px]" />
          {pinned && <OnStrip />}
        </button>
        <div className="flex-shrink-0">
          <Segmented<'layers' | 'edits' | 'images'>
            equal
            value={tab}
            onChange={onTab}
            // Icons with one-word tooltips (2026-11-23, Layers first; the
            // tabs were the words "Edits" / "Recent" before).
            options={[
              { key: 'layers', icon: 'layers', title: 'Layers' },
              { key: 'edits', icon: 'edit_history', title: 'Edits' },
              { key: 'images', icon: 'list_clock', title: 'Recent' },
            ]}
          />
        </div>
      </div>
      {tab === 'layers' ? (
        <LayersList
          layers={layers}
          selectedIds={selectedIds}
          onSelect={onSelectLayer}
          onReorder={onReorderLayers}
          onToggleHidden={onToggleLayerHidden}
          onHover={onHoverStep}
        />
      ) : tab === 'edits' ? (
        <div className="flex-1 w-0 min-w-full overflow-y-auto p-2 flex flex-col gap-1" onPointerLeave={() => onHoverStep(null)}>
          {steps.map((step, i) => ({ step, i })).reverse().map(({ step, i }) => {
            const current = i === cursor
            const undone = i > cursor
            return (
              <button
                key={i}
                type="button"
                aria-current={current || undefined}
                onClick={() => onStep(i)}
                onPointerEnter={() => onHoverStep(step.shape?.id ?? null)}
                className={`w-full h-12.5 flex items-center gap-2.5 px-1.5 rounded-lg border border-transparent hover-overlay text-left text-[11px] font-medium ${
                  current ? 'text-fg' : undone ? 'text-fg-disabled' : 'text-fg-secondary'
                }`}
              >
                {current && <Mark />}
                {/* Undone steps: the preview in greyscale and faded to 40% (2026-11-24;
                    greyscale only before), so it recedes like the fg-disabled label. */}
                <span className={`flex shrink-0 ${undone ? 'grayscale opacity-40' : ''}`}><ShapePreview shape={step.shape} icon={step.icon} image={step.image} /></span>
                <Icon name={step.icon} className="text-[14px] shrink-0" />
                <span className="flex-1 min-w-0 truncate">{step.label}</span>
              </button>
            )
          })}
        </div>
      ) : (
      <div className="flex-1 w-0 min-w-full overflow-y-auto p-2 flex flex-col gap-1">
        {items.length === 0 ? <Empty /> : items.map(item => {
          const current = item.id === currentId
          return (
            <button
              key={item.id}
              type="button"
              aria-current={current || undefined}
              onClick={() => { if (!current) onPick(item) }}
              className={`relative w-full flex items-center gap-2.5 p-1.5 rounded-lg border border-transparent text-left ${current ? '' : 'hover-overlay'}`}
            >
              {current && <Mark />}
              {/* The other tabs' tile (2026-11-27: content well, inset line
                  edge; it had a border of its own). No thumbnail saved: the
                  tile with the image icon. */}
              <ShapePreview icon="image" image={item.thumbnailUrl || undefined} />
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-medium text-fg"><Title item={item} /></span>
                <span className="block text-[10px] font-medium tabular-nums whitespace-nowrap text-fg-secondary mt-0.5">{timeLabel(item.timestamp)}</span>
              </span>
            </button>
          )
        })}
      </div>
      )}
    </div>
  )
}
