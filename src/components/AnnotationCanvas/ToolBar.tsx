import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalloutArrow, CALLOUT_GAP } from '../CalloutArrow'
import { CustomSwatchIcon } from '../CustomSwatchIcon'
import { swatchClass, swatchFill, SWATCH_ROW } from '../../lib/swatch'
import { DRAW_TOOLS, EXTRA_TOOLS, SELECT_TOOLS, COLORS, STROKE_PRESETS, type Tool, type ToolDef } from './tools'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { ColorPicker } from '../ColorPicker'
import { ICON_BUTTON, DANGER_ICON_BUTTON } from '../button-classes'
import { OnStrip } from '../OnStrip'
import { DEFAULT_ANNOTATION_COLOR } from '../../../shared/annotation'
import { bindingText, type Keymap } from '../../lib/editor-keys'

const isMac = navigator.platform.toLowerCase().includes('mac')

/** A tool's tooltip with its key from the key map (Settings › Hotkeys),
 *  e.g. "Brush (B)" (2026-11-24). Just the name when it has no key. Shared
 *  with the recording toolbar. */
export function toolTip(label: string, id: string, keymap?: Keymap): string {
  const b = keymap?.[`tool:${id}`]
  return b ? `${label} (${bindingText(b, isMac)})` : label
}

interface Props {
  tool: Tool
  setTool: (t: Tool) => void
  /** The selected shape's kind, if any: its options show instead of the
   *  tool's. */
  selectedType?: Tool | null

  color: string
  setColor: (c: string) => void
  strokeWidth: number
  setStrokeWidth: (w: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  zoomLevel: number
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  historyOpen: boolean
  onToggleHistory: () => void
  /** Tools to hide. */
  disabledTools?: Tool[]
  /** The Sticker button (2026-11-26, a toggle like History; a tool before):
   *  shown when `onToggleStickers` is given, on while the sticker sidebar
   *  is open (the Editor renders it). */
  stickersOpen?: boolean
  onToggleStickers?: () => void
  /** The editor's keys, for the tools' tooltips. */
  keymap?: Keymap
}

/** The image editor's floating toolbar (2026-11-23, design/IMAGE-EDITOR.md):
 *  the same box as the video trim bar (bg-toolbar, border-line, rounded-lg,
 *  10px padding), placed by the Editor. One row: tools (a segmented
 *  control, selected = accent), colours, stroke, Undo / Redo / Clear, then
 *  zoom and History at the right end. Framed 32px buttons and the hover
 *  rules; no glass, no transitions, no opacity for disabled. */
export default function AnnotationToolBar({
  tool, setTool, selectedType,
  color, setColor,
  strokeWidth, setStrokeWidth,
  canUndo, canRedo, onUndo, onRedo, onClear,
  zoomLevel, onZoomIn, onZoomOut, onZoomReset,
  historyOpen, onToggleHistory,
  disabledTools = [],
  stickersOpen = false, onToggleStickers,
  keymap,
}: Props) {
  const tools: ToolDef[] = [...SELECT_TOOLS, ...DRAW_TOOLS, ...EXTRA_TOOLS].filter(t => !disabledTools.includes(t.id))

  const rootRef = useRef<HTMLDivElement>(null)
  const stickerBtnRef = useRef<HTMLButtonElement>(null)

  // Options follow the tool (2026-11-23): only what the current tool, or the
  // selected shape's kind, uses. Pen, Arrow, Rectangle, Ellipse: colours and
  // line width. Text: colours and size (the same setting sets its font).
  // Blur: strength only (the same setting sets its radius). Sticker, and
  // Cursor with nothing selected: none.
  const optionsOf = selectedType && selectedType !== 'none' ? selectedType : tool
  const showColours = ['pen', 'highlighter', 'arrow', 'rect', 'ellipse', 'text'].includes(optionsOf)
  const strokeKind: 'line' | 'size' | 'strength' | null =
    optionsOf === 'text' ? 'size' : optionsOf === 'blur' ? 'strength'
    : ['pen', 'highlighter', 'arrow', 'rect', 'ellipse'].includes(optionsOf) ? 'line' : null
  const hasOptions = showColours || strokeKind !== null

  // The layout (2026-11-23): the first of these steps that keeps at least
  // the unrelated gap (40px) between the drawing cluster's end and zoom,
  // with the current tool's options. Everything is measured (2026-11-24,
  // nothing hand-counted): the toolbar, its padding, the cluster's gap, the
  // tools, zoom and the edit group, plus the swatches, the size control and
  // a callout button from an invisible copy that is always rendered (the
  // real ones are hidden in the narrower steps). GAP is shared with the
  // markup.
  // The order (Jasper, 2026-11-26), each step only when the one before
  // doesn't fit:
  //   1. size and colours inline;
  //   2. the size folds into its Size button (the size in a callout);
  //   3. the colours fold into their Palette button too;
  //   4. zoom drops its % (− and + only);
  //   5. size and colours merge into the More (⋯) button;
  //   6. the tools fold into one button showing the current tool.
  // The % comes back in any step where it fits again: every step is tried
  // with it first. A tool without a size or colours skips their steps.
  const toolsRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLDivElement>(null)
  const clusterRef = useRef<HTMLDivElement>(null)
  const measureSwatchesRef = useRef<HTMLDivElement>(null)
  const measureSizeRef = useRef<HTMLDivElement>(null)
  const measureBtnRef = useRef<HTMLButtonElement>(null)
  const [sizes, setSizes] = useState({ bar: 0, pad: 0, clusterGap: 0, tools: 0, zoom: 0, edit: 0, swatches: 0, size: 0, btn: 0 })
  // Whether the % showed last time (zoom is measured as shown), and the
  // width the % part takes (measured while shown).
  const pctShownRef = useRef(true)
  const pctRef = useRef<HTMLSpanElement>(null)
  const pctWRef = useRef(46)
  // The same for the tools' Segmented (folded away in the last steps).
  const segShownRef = useRef(true)
  const segRef = useRef<HTMLSpanElement>(null)
  const segWRef = useRef(228)
  useLayoutEffect(() => {
    const els = [rootRef.current, toolsRef.current, zoomRef.current, editRef.current, clusterRef.current, measureSwatchesRef.current, measureSizeRef.current, measureBtnRef.current]
    if (els.some(e => !e)) return
    const measure = () => {
      if (pctRef.current && pctRef.current.offsetWidth > 0) pctWRef.current = pctRef.current.offsetWidth
      if (segRef.current && segRef.current.offsetWidth > 0) segWRef.current = segRef.current.offsetWidth
      const root = getComputedStyle(rootRef.current!)
      setSizes({
        bar: rootRef.current!.offsetWidth,
        pad: parseFloat(root.paddingLeft) + parseFloat(root.paddingRight),
        clusterGap: parseFloat(getComputedStyle(clusterRef.current!).columnGap) || 0,
        tools: toolsRef.current!.offsetWidth,
        zoom: zoomRef.current!.offsetWidth,
        edit: editRef.current!.offsetWidth,
        swatches: measureSwatchesRef.current!.offsetWidth,
        size: measureSizeRef.current!.offsetWidth,
        btn: measureBtnRef.current!.offsetWidth,
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    els.forEach(e => ro.observe(e!))
    return () => ro.disconnect()
  }, [])
  // The unrelated gap: 40px, the AppBar's (2026-11-23; 25px and a gap
  // worked out from the widths tried): zoom ↔ undo, and the least the
  // drawing cluster keeps from zoom before the layout narrows. In the
  // narrowest layout zoom drops its % (− and + only) to make room.
  const GAP = 40
  const MIN_GAP = GAP, RIGHT_GAP = GAP
  // Zoom's width with and without its %, whatever shows now.
  const zoomFull = sizes.zoom + (pctShownRef.current ? 0 : pctWRef.current)
  const zoomBare = zoomFull - pctWRef.current
  // The tools group's width with the Segmented, and folded to one button.
  const toolsFull = sizes.tools + (segShownRef.current ? 0 : segWRef.current - sizes.btn)
  const toolsFolded = toolsFull - segWRef.current + sizes.btn
  const fits = (coloursW: number, sizeW: number, pct: boolean, folded: boolean) =>
    sizes.pad + (folded ? toolsFolded : toolsFull) + (coloursW ? sizes.clusterGap + coloursW : 0) + (sizeW ? sizes.clusterGap + sizeW : 0)
      + MIN_GAP + (pct ? zoomFull : zoomBare) + RIGHT_GAP + sizes.edit <= sizes.bar
  const sizeW = strokeKind ? sizes.size : 0
  // size / colours: inline or folded into their own button; merged: both
  // in the More button.
  type Step = { size: 'inline' | 'button'; colours: 'inline' | 'button'; merged: boolean; pct: boolean; folded: boolean }
  const hasSize = !!strokeKind
  const stages: Omit<Step, 'pct'>[] = [{ size: 'inline', colours: 'inline', merged: false, folded: false }]
  if (hasSize) stages.push({ size: 'button', colours: 'inline', merged: false, folded: false })
  if (showColours) stages.push({ size: hasSize ? 'button' : 'inline', colours: 'button', merged: false, folded: false })
  const last = stages[stages.length - 1]
  const merged = hasSize && showColours ? { ...last, merged: true } : null
  const end = merged ?? last
  const all: Step[] = [
    // Before the merge only the last stage tries without the %: the % goes
    // after the colours have folded.
    ...stages.map(st => ({ ...st, pct: true })),
    { ...last, pct: false },
    ...(merged ? [{ ...merged, pct: true }, { ...merged, pct: false }] : []),
    { ...end, folded: true, pct: true },
    { ...end, folded: true, pct: false },
  ]
  const coloursOf = (st: Step) => !showColours ? 0 : st.merged || st.colours === 'button' ? sizes.btn : sizes.swatches
  const sizeOf = (st: Step) => !hasSize || st.merged ? 0 : st.size === 'button' ? sizes.btn : sizeW
  const step: Step = sizes.bar === 0
    ? all[0]
    : all.find(st => fits(coloursOf(st), sizeOf(st), st.pct, st.folded)) ?? all[all.length - 1]
  pctShownRef.current = step.pct
  segShownRef.current = !step.folded
  const toolsBtnRef = useRef<HTMLButtonElement>(null)
  const currentTool = tools.find(t => t.id === tool)
  const showPct = step.pct

  // The steps come from the measured widths above, not fixed breakpoints.
  // The right-hand group (zoom, edit, History) always shows. The callout:
  // like the sticker panel, 7px above the toolbar, its triangle on the
  // button; a press outside or Esc closes it, the button toggles it.
  const sizeBtnRef = useRef<HTMLButtonElement>(null)
  const paletteBtnRef = useRef<HTMLButtonElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const calloutRef = useRef<HTMLDivElement>(null)
  // 'custom': the Custom colour picker on its own, from the Custom swatch in
  // the toolbar (2026-11-24). From a Custom swatch inside the Palette / More
  // callout the picker opens in that callout instead, above its row
  // (`pickerOpen`), so the colours stay in view.
  const [callout, setCallout] = useState<{ kind: 'size' | 'palette' | 'options' | 'custom' | 'tools'; x: number; bottom: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => { if (!callout) setPickerOpen(false) }, [callout])
  const [calloutLeft, setCalloutLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!callout) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (calloutRef.current?.contains(t) || sizeBtnRef.current?.contains(t) || paletteBtnRef.current?.contains(t) || moreBtnRef.current?.contains(t) || toolsBtnRef.current?.contains(t)) return
      // The toolbar's Custom swatch toggles its picker itself.
      if (callout.kind === 'custom' && (t as Element).closest?.('[data-custom-swatch]')) return
      setCallout(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setCallout(null) } }
    // A window resize closes it (2026-11-26), like the Upload menu: it's
    // placed once, from where its button was.
    const onResize = () => setCallout(null)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [callout])
  // Its options gone (another tool, a deselect): the callout goes too.
  useEffect(() => {
    if (!callout) return
    // The tools callout goes when the tools unfold.
    if (callout.kind === 'tools') { if (!step.folded) setCallout(null); return }
    if (!hasOptions || (callout.kind === 'size' && !strokeKind) || ((callout.kind === 'custom' || callout.kind === 'palette') && !showColours)) setCallout(null)
  }, [callout, hasOptions, showColours, strokeKind, step.folded])
  // Centred over its button, kept inside the toolbar's ends (2026-11-26;
  // 8px inside the window before, which slid it under a pinned sidebar:
  // the toolbar's ends already stop short of the sidebars). Wider than the
  // toolbar, its left end wins.
  useLayoutEffect(() => {
    const el = calloutRef.current
    if (!callout || !el) { setCalloutLeft(null); return }
    const w = el.offsetWidth
    const bar = rootRef.current?.getBoundingClientRect()
    const lo = bar ? bar.left : 8
    const hi = bar ? bar.right - w : window.innerWidth - 8 - w
    setCalloutLeft(Math.max(lo, Math.min(callout.x - w / 2, hi)))
  }, [callout, pickerOpen])
  // 7px from its button, the callout's source (2026-11-23, as the video
  // bar's time bubbles from their handle): the button sits 10px inside the
  // toolbar, so the callout overlaps the toolbar by 3px and its triangle's
  // tip ends 2px above the button (it touched the toolbar's edge).
  const toggleCallout = (kind: 'size' | 'palette' | 'options' | 'custom' | 'tools', btn: HTMLElement | null) => {
    if (callout?.kind === kind) { setCallout(null); return }
    const b = btn?.getBoundingClientRect()
    if (!b) return
    // Height from the toolbar, not the button (2026-11-25): the 32px
    // controls' top is 10px inside it, so 7px above that is 3px into the
    // toolbar, the sticker panel's height too. Measured from the Custom
    // swatch (24px, 4px lower) it sat 4px low.
    const bar = rootRef.current?.getBoundingClientRect()
    const top = bar ? bar.top + 10 : b.top
    setCallout({ kind, x: b.left + b.width / 2, bottom: window.innerHeight - top + CALLOUT_GAP })
  }

  // Swatches styled like Settings' (ColorSwatches, 2026-11-23): 24px
  // circles with a see-through line edge (line-strong until 2026-11-25), the pick an accent ring 1px
  // out; Custom is the elevated fill with a + until a colour off the palette
  // is in use, then that colour, ringed. Custom opens our own picker
  // (2026-11-24; the system colour panel before), Settings' ColorPicker with
  // the `free` field: any colour is fine for drawings.
  const inPalette = (c: string) => (COLORS as readonly string[]).includes(c.toLowerCase())
  // Which swatch is picked follows where the colour came from, not only its
  // value (2026-11-23): one set in the picker keeps Custom picked even
  // when it lands exactly on a palette colour (it jumped to that swatch).
  // Other changes (a palette click, a selected shape's colour mirrored in)
  // pick Custom only for colours off the palette.
  const fromPanelRef = useRef(false)
  const [isCustom, setIsCustom] = useState(() => !inPalette(color))
  // The custom colour is remembered: picking a palette colour keeps it in
  // the Custom swatch, with a pencil while it isn't the one in use; a click
  // takes it back and opens the picker on it. Kept per viewer in
  // localStorage, so it survives closing the editor.
  const [customColor, setCustomColor] = useState<string | null>(() => {
    try { return localStorage.getItem(CUSTOM_KEY) } catch { return null }
  })
  const rememberCustom = (c: string) => {
    setCustomColor(c)
    try { localStorage.setItem(CUSTOM_KEY, c) } catch { /* not remembered */ }
  }
  useEffect(() => {
    const custom = fromPanelRef.current || !inPalette(color)
    fromPanelRef.current = false
    setIsCustom(custom)
    if (custom && color.toLowerCase() !== customColor?.toLowerCase()) rememberCustom(color)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color])
  // The last palette colour in use, for the Custom swatch's clear.
  const lastPaletteRef = useRef<string | null>(inPalette(color) ? color : null)
  useEffect(() => { if (!isCustom && inPalette(color)) lastPaletteRef.current = color.toLowerCase() }, [isCustom, color])
  const pickFromPanel = (c: string) => {
    fromPanelRef.current = true
    setColor(c)
    // Same value as now (e.g. Custom re-picked on a palette colour): no
    // colour change to react to, so mark it here.
    if (c.toLowerCase() === color.toLowerCase()) { fromPanelRef.current = false; setIsCustom(true); rememberCustom(c) }
  }
  // A click on Custom picks it at once, on the colour the picker opens on
  // (the one in use if it's already Custom, else the remembered one, else
  // the current colour), as Settings' Custom swatch does; a second click
  // closes the picker.
  const toggleCustom = (btn: HTMLElement, inCallout: boolean) => {
    // In use (2026-11-25): the × clears the custom colour, forgets it and
    // goes back to the palette colour in use before it (the palette's first
    // only when there was none); the picker closes.
    if (isCustom) {
      setCustomColor(null)
      try { localStorage.removeItem(CUSTOM_KEY) } catch { /* nothing kept */ }
      setIsCustom(false)
      setColor(lastPaletteRef.current ?? COLORS[0])
      if (inCallout) setPickerOpen(false); else if (callout?.kind === 'custom') setCallout(null)
      return
    }
    if (inCallout ? pickerOpen : callout?.kind === 'custom') {
      if (inCallout) setPickerOpen(false); else setCallout(null)
      return
    }
    pickFromPanel(isCustom ? color : customColor ?? color)
    if (inCallout) setPickerOpen(true); else toggleCallout('custom', btn)
  }
  // Swatches: the one look (lib/swatch.ts); in a callout the ground is
  // elevated, in the toolbar toolbar.
  const swatches = (onPick?: () => void, inCallout = false) => {
    const customOpen = inCallout ? pickerOpen : callout?.kind === 'custom'
    const ground = inCallout ? 'elevated' : 'toolbar'
    return (
    <>
      {COLORS.map(c => (
        <button
          key={c}
          type="button"
          // A palette click always picks the palette swatch, also when the
          // colour equals the custom one (no colour change to react to).
          onClick={() => { setIsCustom(false); setColor(c); onPick?.() }}
          data-tip={COLOR_NAMES[c] ?? c}
          aria-label={COLOR_NAMES[c] ?? c}
          aria-pressed={!isCustom && color.toLowerCase() === c}
          className={swatchClass(!isCustom && color.toLowerCase() === c, ground)}
          style={{ background: swatchFill(c) }}
        />
      ))}
      <button
        type="button"
        data-custom-swatch=""
        data-tip={customOpen ? undefined : isCustom ? 'Clear' : 'Custom'}
        aria-label={isCustom ? 'Clear custom colour' : 'Custom colour'}
        aria-expanded={customOpen}
        aria-pressed={isCustom}
        className={swatchClass(isCustom, ground)}
        style={{ background: swatchFill(isCustom ? color : customColor ?? 'var(--color-elevated)') }}
        onClick={e => toggleCustom(e.currentTarget, inCallout)}
      >
        {/* + / pencil / × (CustomSwatchIcon, 2026-11-25): in use, the ×
            and a click clears the custom colour. */}
        <CustomSwatchIcon state={isCustom ? 'clear' : customColor ? 'edit' : 'add'} on={isCustom ? color : customColor ?? undefined} />
      </button>
    </>
    )
  }

  // Stroke: the standard single select (2026-11-23), a dot per width; a
  // custom width (from a picked shape) selects none. Shared with the
  // recording toolbar (StrokeControl below).
  const strokeControl = strokeKind && <StrokeControl kind={strokeKind} value={strokeWidth} onChange={setStrokeWidth} />

  // The tools (the standard single select): in the toolbar, or in the
  // tools callout when folded (a pick closes it).
  const toolsControl = (
    <Segmented<Tool>
      value={tool}
      onChange={t => { setTool(t); if (callout?.kind === 'tools') setCallout(null) }}
      options={tools.map(t => ({ key: t.id, icon: t.icon, title: t.label, tip: toolTip(t.label, t.id, keymap) }))}
    />
  )

  return (
    // What collapses goes by the toolbar's own width (2026-11-23), not the
    // window's (the docked History panel
    // narrows it without narrowing the window, and the groups overlapped).
    // Edge drawn inside (ring-inset), as on the video trim bar.
    // 10px padding all round, as the video control bar (16px top and bottom
    // tried, 2026-11-23).
    <div ref={rootRef} data-tip-center="" className="relative flex items-center p-2.5 rounded-lg bg-toolbar ring-1 ring-inset ring-line select-none" style={{ gap: GAP }}>

      {/* Measuring copies (2026-11-24): the swatches, the current size
          control and a callout button, always rendered so the layout steps
          can use their real widths while the real ones are collapsed.
          Invisible, out of the flow, not focusable or clickable (inert). */}
      <div aria-hidden inert className="absolute left-0 top-0 invisible pointer-events-none flex items-start">
        <div ref={measureSwatchesRef} className={`${SWATCH_ROW} flex-shrink-0`}>{swatches()}</div>
        <div ref={measureSizeRef} className="flex-shrink-0">{strokeKind && strokeControl}</div>
        <CalloutButton btnRef={measureBtnRef} className="inline-flex flex-shrink-0" icon="palette" label="" open={false} onClick={() => {}} />
      </div>

      {/* Tools and their options as one cluster, 12px apart (gap-3,
          2026-11-23): what you draw and how it looks belong together; the
          other groups stay GAP (40px) off. */}
      <div ref={clusterRef} className="flex-1 min-w-0 flex items-center gap-3">
      {/* The Sticker button at the toolbar's left end, then the tools
          (2026-11-26: a toggle like History, it was the last tool), 12px
          apart. Measured together (toolsRef). */}
      <div ref={toolsRef} className="flex-shrink-0 flex items-center gap-3">
      {onToggleStickers && (
        // data-sticker-button: a press on it is left to this toggle (the
        // sidebar's outside-press close).
        <span data-sticker-button="" className="inline-flex">
          <CalloutButton
            btnRef={stickerBtnRef}
            className="inline-flex"
            icon="add_reaction"
            label={toolTip('Sticker', 'sticker', keymap)}
            open={stickersOpen}
            onClick={onToggleStickers}
          />
        </span>
      )}
      {step.folded ? (
        // Folded (the last steps): one button with the current tool's icon;
        // the tools in a callout.
        <CalloutButton
          btnRef={toolsBtnRef}
          className="inline-flex"
          icon={currentTool?.icon ?? 'arrow_selector_tool'}
          label="Tools"
          open={callout?.kind === 'tools'}
          onClick={() => toggleCallout('tools', toolsBtnRef.current)}
        />
      ) : (
        <span ref={segRef} className="inline-flex">{toolsControl}</span>
      )}
      </div>

      {/* Colours and stroke. data-style-controls: the Canvas text box keeps
          editing when focus lands here (a colour or stroke pick is an edit
          of the text being typed). */}
      {/* Colours and stroke, collapsing by the toolbar's width (above).
          p-1 -m-1: room for the picked swatch's ring (3px out) inside the
          clip, which only bites past the narrowest layout. */}
      <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden p-1 -m-1" data-style-controls="">
        {/* Size first, then colour (2026-11-23); each folds into its own
            button, the size first, then both merge into More (2026-11-26,
            see the steps above). */}
        {!step.merged && step.size === 'inline' && strokeKind && <div>{strokeControl}</div>}
        <CalloutButton
          btnRef={sizeBtnRef}
          className={!step.merged && step.size === 'button' && strokeKind ? 'inline-flex' : 'hidden'}
          icon="line_weight"
          label="Size"
          open={callout?.kind === 'size'}
          onClick={() => toggleCallout('size', sizeBtnRef.current)}
        />
        {!step.merged && step.colours === 'inline' && showColours && <div className={SWATCH_ROW}>{swatches()}</div>}
        <CalloutButton
          btnRef={paletteBtnRef}
          className={!step.merged && step.colours === 'button' && showColours ? 'inline-flex' : 'hidden'}
          icon="palette"
          label="Colour"
          open={callout?.kind === 'palette'}
          onClick={() => toggleCallout('palette', paletteBtnRef.current)}
        />
        <CalloutButton
          btnRef={moreBtnRef}
          className={step.merged && hasOptions ? 'inline-flex' : 'hidden'}
          icon="more_horiz"
          label="Colour and stroke"
          open={callout?.kind === 'options'}
          onClick={() => toggleCallout('options', moreBtnRef.current)}
        />
      </div>
      </div>

      {/* The right side: zoom, then the edit group, the unrelated gap apart
          (GAP, worked out above; 40px and 25px tried): the same as the least
          the drawing cluster keeps from zoom. */}
      <div className="flex items-center flex-shrink-0" style={{ gap: GAP }}>
      {/* Zoom on its own (2026-11-23): it only changes the view, so it
          stands apart from the edit actions. */}
      <div ref={zoomRef} className="flex items-center flex-shrink-0">
        {/* Zoom as one group (2026-11-23): one framed box like a segmented
            control's track (32px, 2px inset), its three parts sized like
            segments (28px icon parts, the % text part), grey turning fg
            under the pointer as segments do. Not a select: nothing stays
            picked. */}
        {/* py-0.5 only (2026-11-23): no side padding, so the − and + cells
            run from the border to their divider and their icons sit exactly
            centred (with px-0.5 they were 1px toward the middle). */}
        <div role="group" aria-label="Zoom" className="h-8 inline-flex items-center py-0.5 rounded-lg bg-elevated border border-line">
          <button type="button" onClick={onZoomOut} className={ZOOM_PART} data-tip="Zoom out" aria-label="Zoom out">
            <Icon name="remove" className="text-[16px]" />
          </button>
          <span aria-hidden className={ZOOM_DIVIDER} />
          {/* The %, with its divider; left out in steps 3 and 5
              (2026-11-23), where ⌘0 / double-click still reset the zoom. */}
          {showPct && (
            <span ref={pctRef} className="flex items-center self-stretch">
              {/* As wide as "100%" whatever the value (a hidden "100%" in
                  the same grid cell sets the width), so the parts never
                  shift while zooming; only 1000%+ widens it. */}
              <button type="button" onClick={onZoomReset} className={`${ZOOM_PART} px-1.5 text-xs font-medium tabular-nums`} data-tip="Reset zoom" aria-label="Reset zoom">
                <span className="inline-grid justify-items-center">
                  <span className="invisible [grid-area:1/1]" aria-hidden>100%</span>
                  <span className="[grid-area:1/1]">{Math.round(zoomLevel * 100)}%</span>
                </span>
              </button>
              <span aria-hidden className={ZOOM_DIVIDER} />
            </span>
          )}
          <button type="button" onClick={onZoomIn} className={ZOOM_PART} data-tip="Zoom in" aria-label="Zoom in">
            <Icon name="add" className="text-[16px]" />
          </button>
        </div>
      </div>

      {/* Undo, Redo, Clear edits and History as one related group, 12px
          apart (gap-3, 2026-11-23): History lists the steps Undo and Redo
          walk. */}
      <div ref={editRef} className="flex items-center gap-3 flex-shrink-0">
        <button type="button" onClick={onUndo} disabled={!canUndo} className={ICON_BUTTON} data-tip="Undo" aria-label="Undo">
          <Icon name="undo" className="text-[16px]" />
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} className={ICON_BUTTON} data-tip="Redo" aria-label="Redo">
          <Icon name="redo" className="text-[16px]" />
        </button>
        <button
          type="button"
          onClick={onClear}
          className={CLEAR_BUTTON}
          data-tip="Clear edits"
          aria-label="Clear all edits"
        >
          {/* Eraser (2026-11-23; the trash can read as deleting the image). */}
          <Icon name="cleaning_services" className="text-[16px]" />
        </button>
        {/* History: on while its panel is open, shown like Select in select
            mode (a 3px accent strip on the bottom edge, masked inside the
            border; the icon stays grey). */}
        <button
          type="button"
          onClick={onToggleHistory}
          data-history=""
          aria-pressed={historyOpen}
          className={`${ICON_BUTTON} group/on relative`}
          data-tip="History"
          aria-label="Recent images"
        >
          <Icon name="history" className="text-[16px]" />
          {historyOpen && <OnStrip />}
        </button>
      </div>

      </div>

      {/* The callout for the collapsed colours (and stroke), or the Custom picker. */}
      {callout && (
        <div
          ref={calloutRef}
          data-style-controls=""
          className="fixed z-[100]"
          style={{ left: calloutLeft ?? -9999, bottom: callout.bottom }}
        >
          <CalloutArrow side="bottom" centre={callout.x - (calloutLeft ?? 0)} className="z-10" />
          {/* One row (2026-11-23): (More) the size, then the colours, 12px
              apart like in the toolbar. The Custom picker: alone ('custom'),
              or above the row, at its right end over the Custom swatch. */}
          <div className="rounded-lg bg-elevated ring-1 ring-inset ring-line p-2.5 flex flex-col gap-3">
            {(callout.kind === 'custom' || pickerOpen) && (
              <div className="self-end">
                <ColorPicker
                  kind="free"
                  bare
                  initial={color}
                  onPreview={pickFromPanel}
                  onPick={pickFromPanel}
                  onClose={() => setCallout(null)}
                  label="colour"
                />
              </div>
            )}
            {callout.kind === 'tools' && toolsControl}
            {/* The Size callout: a pick closes it, as a tool pick does. */}
            {callout.kind === 'size' && strokeKind && (
              <StrokeControl kind={strokeKind} value={strokeWidth} onChange={w => { setStrokeWidth(w); setCallout(null) }} />
            )}
            {/* The Palette callout: a colour pick closes it. */}
            {callout.kind === 'palette' && showColours && (
              <div className={SWATCH_ROW}>{swatches(() => setCallout(null), true)}</div>
            )}
            {callout.kind === 'options' && (
              <div className="flex items-center gap-3">
                {strokeKind && strokeControl}
                {showColours && <div className={SWATCH_ROW}>{swatches(undefined, true)}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const CUSTOM_KEY = 'lumia:annotation-custom-color'


export const COLOR_NAMES: Record<string, string> = {
  [DEFAULT_ANNOTATION_COLOR]: 'Red', '#fe860f': 'Orange', '#fbda1b': 'Yellow', '#40d872': 'Green',
  '#2896f5': 'Blue', '#822dda': 'Purple', '#ffffff': 'White', '#000000': 'Black',
}

/** A part of the zoom group: a segment's size (28 x 26px, 6px corners). */
const ZOOM_PART = 'h-full min-w-7 inline-flex items-center justify-center rounded-md text-fg-secondary hover:text-fg'

/** Between the zoom group's parts (2026-11-23): a 1px border running the
 *  group's full height, from its top edge to its bottom edge (through the
 *  2px top and bottom inset), in line-subtle, a step lighter than the
 *  group's line edge (2026-11-23; line tried), so the box reads as three
 *  joined cells. (A short centred line tried first.) */
const ZOOM_DIVIDER = 'w-px self-stretch -my-0.5 bg-line-subtle flex-shrink-0'

/** A toolbar button that opens a callout (Palette, More): ICON_BUTTON, the
 *  on state while its callout is open (the 3px accent strip on its bottom
 *  edge, as on History), no tooltip then. */
function CalloutButton({ btnRef, className, icon, label, open, onClick }: {
  btnRef: React.RefObject<HTMLButtonElement | null>
  className: string
  icon: string
  label: string
  open: boolean
  onClick: () => void
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      onClick={onClick}
      aria-pressed={open}
      aria-label={label}
      data-tip={open ? undefined : label}
      // ICON_BUTTON without its own display: `className` says when it shows.
      className={`${ICON_BUTTON.replace('inline-flex ', '')} group/on relative ${className}`}
    >
      <Icon name={icon} className="text-[16px]" />
      {open && <OnStrip />}
    </button>
  )
}

/** Clear edits: the eraser, grey at rest and danger-text under the pointer
 *  like every delete button (DANGER_ICON_BUTTON, shared with the recording
 *  toolbar since 2026-11-27; red at rest from 2026-11-23 until then). */
const CLEAR_BUTTON = DANGER_ICON_BUTTON

const STROKE_NAMES = ['Small', 'Medium', 'Large']

/** The stroke / size / strength control (the standard single select,
 *  2026-11-23): a growing dot per line width, an "A" per text size, a blur
 *  per blur strength. A width off the presets (a picked shape's) selects
 *  none. Used by the image editor's toolbar and the recording's. */
export function StrokeControl({ kind, value, onChange }: {
  kind: 'line' | 'size' | 'strength'
  value: number
  onChange: (w: number) => void
}) {
  return (
    <Segmented<string>
      value={String(value)}
      onChange={k => onChange(Number(k))}
      options={STROKE_PRESETS.map((w, i) => ({
        key: String(w),
        // Named for what it sets: the line, the text's size, the blur.
        title: kind === 'size' ? `${STROKE_NAMES[i]} text`
          : kind === 'strength' ? `${['Light', 'Medium', 'Strong'][i]} blur`
          : `${w}px`,
        // Text sizes show as an "A" at three sizes (2026-11-23); blur
        // strengths as one 10px dot, sharper to blurrier; line widths as a
        // growing dot.
        content: kind === 'strength'
          // The blur it applies, at 100% zoom (2026-11-23): the canvas
          // blurs with a radius of 2 x the setting in image pixels (4, 8,
          // 16), on screen that / the pixel ratio; a stack blur's radius is
          // about twice a CSS blur's deviation, so halved.
          ? <span className="w-2.5 h-2.5 rounded-full bg-current" style={{ filter: `blur(${Math.max(2, Math.round(w * 2)) / (window.devicePixelRatio || 1) / 2}px)` }} />
          : kind === 'size'
          // The A's step like the dots (4 : 6 : 10), the largest 16px.
          ? <span className="font-semibold leading-none" style={{ fontSize: 16 * (w + 2) / (STROKE_PRESETS[STROKE_PRESETS.length - 1] + 2) }}>A</span>
          : <span className="rounded-full bg-current" style={{ width: w + 2, height: w + 2 }} />,
      }))}
    />
  )
}
