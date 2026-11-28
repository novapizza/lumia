import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Path,
  Rect,
  Shape,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import useImage from 'use-image'
import type Konva from 'konva'
import { useHistory } from '../../hooks/useHistory'
import { useRoleColors } from '../../hooks/useRoleColors'
import { type Tool, isFreehand, HIGHLIGHTER_WIDTH, HIGHLIGHTER_OPACITY } from './tools'
import { codeToKey, defaultKeymap, isHoldDown, isHoldKeyEvent, isModifierBinding, matchesBinding, type Keymap } from '../../lib/editor-keys'

/** The theme roles the canvas draws its own controls in. */
const CANVAS_ROLES = ['accent', 'elevated', 'elevated-hover', 'line-strong', 'danger-text', 'danger-text-hover'] as const

/** The delete handle (screen px): a normal icon button's size, 32px round
 *  a 16px icon (8px padding, 2026-11-23; 20px with an X, then 24px round a
 *  14px trash tried), its centre 20.25px right and up from the selection's
 *  corner, so its edge clears the 8px corner anchor's tip by 7px, the
 *  callout gap. */
const DELETE_R = 16
// Angle step a Shift-drawn line or arrow snaps to (0°, 15°, 30°, …).
const SHIFT_SNAP_DEG = 15
const DELETE_ICON = 16
/** Zoom ceiling, 300% of actual size (Jasper, 2026-11-23). */
const MAX_ZOOM = 3
const DELETE_OFFSET = 20.25
/** Extra, invisible hit area round the delete handle (screen px). */
const DELETE_HIT_PAD = 4
/** Lucide Trash2 (24-unit box), drawn on the delete handle. */
const TRASH_PATH = 'M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6'

export type { Tool }

/** Pluggable background source for the annotation stage. */
export type CanvasBackground =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'video'; element: HTMLVideoElement | null; naturalWidth: number; naturalHeight: number }

export interface DrawObject {
  id: string
  type: Tool
  points?: number[]
  x?: number; y?: number
  width?: number; height?: number
  radiusX?: number; radiusY?: number
  text?: string
  color: string
  strokeWidth: number
  fill?: string
  isBlur?: boolean
  /** Sticker only: relative R2 path (e.g. "cat-stickers/01-love.png"). Resolved
   *  to a same-origin data URL via the main process so the canvas can be
   *  exported without cross-origin tainting. */
  src?: string
  /** Hidden in the Layers tab (2026-11-23): not drawn, so not clickable and
   *  not in any export; kept in the drawing and saved. */
  hidden?: boolean
}

/** Style of the currently selected shape, reported through
 *  `onSelectionChange` so the toolbar can mirror it; toolbar edits then flow
 *  back onto the selection through the `color` / `strokeWidth` props. */
export interface SelectionInfo {
  id: string
  type: Tool
  color: string
  strokeWidth: number
}

// ── Sticker image resolution ────────────────────────────────────────────────
/** A new sticker's width on screen (CSS px) at the zoom it's placed at
 *  (2026-11-26): 1.5x its cell in the sticker panel. */
const STICKER_SCREEN_W = 120

// Sticker bytes are fetched + disk-cached in the main process and returned as
// data URLs (loading remote URLs straight into Konva would taint the canvas and
// break toDataURL on Save/Copy/Upload). Memoise the per-path promise so the same
// sticker placed twice, or replayed from history, only crosses IPC once.
const stickerUrlCache = new Map<string, Promise<string>>()
// Exported for the History panel's sticker thumbnails (2026-11-26).
export function resolveStickerUrl(relPath: string): Promise<string> {
  let p = stickerUrlCache.get(relPath)
  if (!p) {
    p = window.electronAPI.stickersFetch(relPath).then(r => {
      if (r.ok) return r.dataUrl
      throw new Error(r.error)
    })
    // Drop a rejected entry so a later render can retry instead of caching the
    // failure forever.
    p.catch(() => { stickerUrlCache.delete(relPath) })
    stickerUrlCache.set(relPath, p)
  }
  return p
}

/** Renders one sticker as a draggable/resizable Konva image. Split into its own
 *  component because resolving the src → data URL needs hooks (useState/useImage)
 *  that can't run inside the renderObj loop. */
function StickerImage({
  obj, selectable, interactive, onLoaded,
}: {
  obj: DrawObject
  selectable: boolean
  interactive: Record<string, unknown>
  onLoaded?: () => void
}) {
  const [src, setSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!obj.src) return
    let alive = true
    resolveStickerUrl(obj.src).then(url => { if (alive) setSrc(url) }).catch(() => {})
    return () => { alive = false }
  }, [obj.src])
  const [img] = useImage(src ?? '')
  // Notify once the bitmap is ready so the parent can (re)attach the Transformer
  // to a node that didn't exist when the sticker was first placed/selected.
  useEffect(() => { if (img) onLoaded?.() }, [img, onLoaded])
  if (!img) return null
  return (
    <KonvaImage
      id={obj.id}
      image={img}
      x={obj.x}
      y={obj.y}
      width={obj.width}
      height={obj.height}
      draggable={selectable}
      {...interactive}
    />
  )
}

/** Imperative handle exposed to parent via ref. */
export interface CanvasHandle {
  undo: () => void
  redo: () => void
  clear: () => void
  canUndo: boolean
  canRedo: boolean
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  zoomLevel: number
  /** Snapshot the current composite (background + annotations) as a PNG data URL.
   *  Resolution follows the source's natural pixel dimensions. */
  toDataURL: () => string
  /** A small JPEG of the image with its drawings, at most `maxWidth` image
   *  pixels wide: a live thumbnail (Recent images, 2026-11-23). A few ms. */
  toPreviewDataURL: (maxWidth: number) => string
  /** Same composite as a fresh canvas. Useful for feeding MediaRecorder during
   *  video export (canvas.captureStream). */
  toCanvas: () => HTMLCanvasElement | null
  /** Render ONLY the annotations (no background) to a fresh canvas at natural
   *  resolution. Lets callers composite annotations on top of arbitrary frames
   *  — used by the video exporter to paint annotations only during the freeze
   *  phase while letting raw video frames flow through otherwise. */
  toAnnotationsCanvas: () => HTMLCanvasElement | null
  /** Current list of annotation shapes — plain data, JSON-serializable. Used
   *  by history persistence so annotations survive across Editor sessions. */
  getObjects: () => DrawObject[]
  /** Append shapes programmatically as a single undo step. Caller-provided
   *  ids are replaced with fresh canvas-namespaced ones so Konva node lookup
   *  stays consistent. */
  addObjects: (objs: Omit<DrawObject, 'id'>[]) => void
  /** Place a sticker centred on the image (sized to ~30% of natural width,
   *  aspect preserved) and select it. `src` is the manifest-relative path;
   *  `aspect` is naturalWidth/naturalHeight of the sticker artwork. */
  addSticker: (opts: { src: string; aspect: number; at?: { clientX: number; clientY: number } }) => void
  /** The size, in screen px at the current zoom, a sticker of this aspect
   *  lands at (the drag ghost, 2026-11-26). */
  stickerScreenSize: (aspect: number) => { w: number; h: number }
  /** Jump to an undo step (History › Edits). */
  goToStep: (index: number) => void
  /** Layers tab (2026-11-23): select these shapes (hidden ones skipped), or
   *  with `toggle` add / remove them from the selection. */
  selectShapes: (ids: string[], toggle?: boolean) => void
  /** Layers tab: the drawing in a new order (back to front, every id once).
   *  Not an undo step: every step takes the new order. */
  reorderShapes: (ids: string[]) => void
  /** Layers tab: hide or show a shape. Not an undo step: every step takes
   *  the new visibility. */
  setShapeHidden: (id: string, hidden: boolean) => void
}

/** A background frame around the image (the editor's Background panel,
 *  2026-11-25): `padding` % of the image's longer side on every side, `css` paints it on
 *  screen, `paint` into the exported PNG. */
export interface CanvasFrame {
  /** Percent of the image's longer side (2026-11-25; image pixels at first),
   *  so it looks the same on a small capture and a big Retina one. */
  padding: number
  /** A drop shadow under the image, image pixels (null: none). */
  shadow: { offsetY: number; blur: number; alpha: number } | null
  /** The whole picture's width / height (null: the image plus padding). A
   *  fixed ratio adds background on one axis. ('original', the image's own
   *  shape, was tried 2026-11-25 and dropped for this.) */
  ratio: number | null
  /** Where the image sits in that extra space: 0 start, 0.5 middle, 1 end. */
  alignX: number
  alignY: number
  css: string
  paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
}

/** The framed picture for an image `w` × `h`, image pixels: its size and
 *  where the image sits in it (left / top margin). Shared by the export
 *  and the on-screen frame so they always agree. */
export function framePadding(frame: CanvasFrame, w: number, h: number) {
  return Math.round(Math.max(0, frame.padding) / 100 * Math.max(w, h))
}

export function frameLayout(frame: CanvasFrame, w: number, h: number) {
  const p = framePadding(frame, w, h)
  let width = w + 2 * p
  let height = h + 2 * p
  const ratio = frame.ratio
  if (ratio) {
    if (width / height < ratio) width = Math.round(height * ratio)
    else height = Math.round(width / ratio)
  }
  const x = p + Math.round((width - w - 2 * p) * frame.alignX)
  const y = p + Math.round((height - h - 2 * p) * frame.alignY)
  return { width, height, x, y }
}

interface Props {
  background: CanvasBackground
  /** Image only: draws the frame behind the image and bakes it into
   *  `onExport` / `toDataURL` (Copy, Save, Upload). Shapes stay in image
   *  coordinates. */
  frame?: CanvasFrame
  tool: Tool
  color: string
  strokeWidth: number
  /** Optional: if provided, hitting Enter/clicking an action button writes the
   *  composite PNG here. Video callers should prefer the `toDataURL` ref method. */
  onExport?: (dataUrl: string) => void
  exportTrigger?: number
  /** `userEdited` is true once a genuine user edit has landed (false during
   *  the mount-time replay of `initialObjects`) so the parent can tell real
   *  edits from rehydration without comparing object counts. */
  onHistoryChange?: (canUndo: boolean, canRedo: boolean, userEdited?: boolean) => void
  onZoomChange?: (zoom: number) => void
  /** Fires when the selection changes (null = nothing selected) with the
   *  selected shape's style. While a shape is selected, changes to the
   *  `color` / `strokeWidth` props restyle it (one undo step per gesture). */
  onSelectionChange?: (selection: SelectionInfo | null) => void
  /** Every selected shape's id, on each selection change (the Layers tab
   *  marks those rows). */
  onSelectedIdsChange?: (ids: string[]) => void
  /** Disable pointer-driven drawing (used by video mode while the video is
   *  actively playing — lets users watch without accidental strokes). */
  readOnly?: boolean
  /** Seed the annotation layer on mount with previously persisted shapes.
   *  Each shape is replayed as a separate commit, so native Undo walks back
   *  through them one at a time — same UX as if the user had just drawn
   *  them. Only read at mount; later changes are ignored so parent
   *  re-renders don't clobber in-progress edits. */
  initialObjects?: DrawObject[]
  /** The view to open on (zoom + pan, 2026-11-23: the editor remembers it
   *  per image). Only read at mount. */
  initialView?: { zoom: number; pan: { x: number; y: number } }
  /** Fires when the zoom or pan changes. */
  onViewChange?: (view: { zoom: number; pan: { x: number; y: number } }) => void
  /** Saved undo steps to open with (History › Edits, 2026-11-23), in place of
   *  replaying `initialObjects` shape by shape. Only read at mount. */
  initialSteps?: { steps: DrawObject[][]; cursor: number; dropped?: number }
  /** Fires on every change to the undo steps: all kept steps (oldest
   *  first), the one shown, and how many old ones fell off the end. */
  onStepsChange?: (steps: DrawObject[][], cursor: number, dropped: number) => void
  /** A shape to point out (History › Edits, the step under the pointer):
   *  outlined in the accent while set, if it's on the canvas. */
  highlightId?: string | null
  /** Settings › Hold key to pan (default off): on, the pan key + drag
   *  pans. Off, the pan key does nothing and the Cursor tool is the hand: a
   *  drag from anywhere but a shape pans, a click there deselects, no
   *  selection box (2026-11-24). */
  keyToDrag?: boolean
  /** The image editor's keys (src/lib/editor-keys.ts, changeable in
   *  Settings › Hotkeys, 2026-11-24); the canvas reads `pan`, `constrain`
   *  and `delete`. Defaults when left out. */
  keymap?: Keymap
  /** The recording's live drawing layer (2026-11-24): the same canvas as
   *  the editor's, over the screen being recorded. No zoom, no panning (no
   *  wheel, no double-click reset, no hand, no Space or right-drag); Cursor
   *  doesn't pan. Use with a `video` background without an element, sized
   *  to the display in device pixels, so 100% is actual size. */
  live?: boolean
  /** With `live`: whether the layer needs the clicks now (the pointer on a
   *  shape or the delete button, a selection, the text box, a selection box
   *  being drawn). The rest of the time Cursor lets them through to the
   *  recorded app. */
  onInteractiveChange?: (interactive: boolean) => void
  /** Fires when a stroke starts or ends (`drawing`) and when the text-entry
   *  box opens or closes (`typing`): the image editor fades its toolbar
   *  while either is on (2026-11-25). */
  onActivityChange?: (activity: { drawing: boolean; typing: boolean }) => void
}

let idCounter = 0
const uid = () => `obj-${++idCounter}-${Date.now()}`

// Pan can drift the stage off-screen if unconstrained. Keep at least this many
// pixels of the stage edge visible inside the container so the canvas never
// disappears entirely.
const PAN_MIN_VISIBLE = 80

// Stroke-width slider doubles as the blur-intensity control when the blur
// tool is selected. Map slider value (1–20) to a CSS blur radius in px.
function blurRadiusFromStrokeWidth(sw: number | undefined): number {
  return Math.max(2, Math.round((sw ?? 6) * 2))
}

function clampPan(
  pan: { x: number; y: number },
  containerW: number,
  containerH: number,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (containerW + stageW) / 2 - PAN_MIN_VISIBLE)
  const maxY = Math.max(0, (containerH + stageH) / 2 - PAN_MIN_VISIBLE)
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  }
}

const AnnotationCanvas = forwardRef<CanvasHandle, Props>(
  function AnnotationCanvas(
    { background, frame, tool, color, strokeWidth, onExport, exportTrigger = 0, onHistoryChange, onZoomChange, onSelectionChange, onSelectedIdsChange, readOnly = false, initialObjects, initialView, onViewChange, initialSteps, onStepsChange, highlightId, keyToDrag = false, keymap, live = false, onInteractiveChange, onActivityChange },
    ref,
  ) {
    // ── Background ────────────────────────────────────────────────────────────
    const imageDataUrl = background.kind === 'image' ? background.dataUrl : ''
    const [bgImage] = useImage(imageDataUrl)
    // Blur tool re-uses the stroke-width slider as a blur-intensity control.
    // We cache one pre-blurred canvas per radius so dragging the slider only
    // costs a single CSS-filter pass per new value, not one per mouse move.

    // For video: repaint the Konva layer on every new frame. The KonvaImage's
    // `image` prop keeps the same HTMLVideoElement reference, so React/Konva
    // won't redraw on their own — we have to call batchDraw() imperatively.
    useEffect(() => {
      if (background.kind !== 'video' || !background.element) return
      const video = background.element
      const anyVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
        cancelVideoFrameCallback?: (id: number) => void
      }
      if (typeof anyVideo.requestVideoFrameCallback === 'function') {
        let id = 0
        const onFrame = () => {
          layerRef.current?.batchDraw()
          id = anyVideo.requestVideoFrameCallback!(onFrame)
        }
        id = anyVideo.requestVideoFrameCallback!(onFrame)
        return () => anyVideo.cancelVideoFrameCallback?.(id)
      }
      // Fallback: RAF loop while the video is actually playing.
      let raf = 0
      const tick = () => {
        if (!video.paused && !video.ended) layerRef.current?.batchDraw()
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(raf)
    }, [background])

    const stageRef     = useRef<Konva.Stage>(null)
    const layerRef     = useRef<Konva.Layer>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [isDrawing, setIsDrawing] = useState(false)
    // Bumped each time a sticker bitmap finishes loading — used as a Transformer
    // effect dependency so selection handles attach to stickers that mount
    // asynchronously (after their data URL resolves over IPC).
    const [stickerLoadTick, setStickerLoadTick] = useState(0)
    const bumpStickerTick = useCallback(() => setStickerLoadTick(t => t + 1), [])
    // Mirrors `isDrawing` but drives the commit guard. Both the Stage's
    // onMouseUp and the window-level mouseup fallback fire for the same
    // gesture with no re-render between them, so the React `isDrawing` state
    // is still `true` for both — gating the commit on this ref (flipped
    // synchronously) ensures the shape lands exactly once.
    const isDrawingRef = useRef(false)
    const [currentObj, setCurrentObj] = useState<DrawObject | null>(null)
    const drawStart = useRef({ x: 0, y: 0 })
    // Selection (2026-11-23: several shapes at once): drag a box on empty
    // canvas with Cursor (Shift / ⌘ adds), ⌘-click (Ctrl on Windows) adds or
    // removes one. `selectedId` is the single selection, for what only makes
    // sense for one shape (text editing, the tool-switch rule).
    const [selectedIds, setSelectedIds] = useState<string[]>([])
    const selectedId = selectedIds.length === 1 ? selectedIds[0] : null
    const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), [])
    const selectedIdsRef = useRef(selectedIds)
    selectedIdsRef.current = selectedIds
    const selKey = selectedIds.join(',')
    // The selection box being dragged (Cursor on empty canvas), in layer
    // units; `add` when Shift or ⌘ was held (adds to the selection).
    const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(null)
    const marqueeRef = useRef(marquee)
    // The stage's positioned wrapper: presses inside it are the stage's own.
    const stageWrapRef = useRef<HTMLDivElement>(null)
    marqueeRef.current = marquee
    /** A shape's box in layer (image) units. (A blur is a plain box shape
     *  since 2026-11-23, so it needs no special case any more.) */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const boxOf = (_id: string, node: Konva.Node, layer: Konva.Container) =>
      node.getClientRect({ relativeTo: layer as any })
    // Position of the per-shape delete handle (the red X) in layer
    // coordinates. Tracked separately from selectedId so the X follows the
    // shape live during drag/transform without going through the React
    // commit cycle on every mousemove.
    const [deleteHandle, setDeleteHandle] = useState<{ x: number; y: number } | null>(null)
    // The selection frame and the delete handle in the theme's roles
    // (2026-11-23; they were #b6a0ff, the old dark accent, and a red circle
    // with a white ring and a shadow).
    const role = useRoleColors(CANVAS_ROLES)
    const [deleteHover, setDeleteHover] = useState(false)
    // A handle that goes away (Delete key, deselect) never reports the
    // pointer leaving it.
    useEffect(() => { if (!deleteHandle) setDeleteHover(false) }, [deleteHandle])
    // Konva node ref for the delete handle so drag/transform can reposition it
    // imperatively without a React re-render of the whole canvas per mousemove.
    const deleteHandleRef = useRef<Konva.Group>(null)
    // Open text-entry box. `editingId` set → re-editing an existing text
    // object in place (its Konva node is hidden meanwhile) instead of adding a
    // new one on commit.
    type TextEntry = { x: number; y: number; screenX: number; screenY: number; editingId?: string }
    const [textInput, setTextInput] = useState<TextEntry | null>(null)
    const textInputRef = useRef<HTMLTextAreaElement>(null)
    const [textValue, setTextValue] = useState('')
    // Mirrors for handlers that must read the open entry synchronously
    // (flushing it before a new one opens) without re-binding per keypress.
    const textEntryRef = useRef<TextEntry | null>(null)
    useEffect(() => { textEntryRef.current = textInput }, [textInput])
    const textValueRef = useRef('')
    useEffect(() => { textValueRef.current = textValue }, [textValue])
    // Set while a click that opens a new entry is being handled, so the blur
    // of the previous textarea doesn't double-commit / close the new entry.
    const skipBlurCommitRef = useRef(false)
    // Set when a Konva double-click begins a text edit so the container's DOM
    // dblclick (zoom reset) fired by the same gesture is ignored.
    const suppressDblClickZoomResetRef = useRef(false)
    const trRef = useRef<Konva.Transformer>(null)
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

    // ── Zoom ──────────────────────────────────────────────────────────────────
    const [userZoom, setUserZoom] = useState(() => initialView ? Math.max(0.1, Math.min(initialView.zoom, MAX_ZOOM)) : 1)
    // The ceiling is dynamic (see `maxZoom` below, kept in a ref so the
    // long-lived wheel handler and the []-dep zoom callbacks read the latest
    // value without re-binding).
    const maxZoomRef = useRef(Number.POSITIVE_INFINITY)
    const clampZoom = (z: number) => Math.max(0.1, Math.min(z, maxZoomRef.current))
    const zoomIn  = useCallback(() => setUserZoom(z => clampZoom(z + 0.1)), [])
    const zoomOut = useCallback(() => setUserZoom(z => clampZoom(z - 0.1)), [])
    const zoomReset = useCallback(() => { setUserZoom(1); setPanOffset({ x: 0, y: 0 }) }, [])
    // Latest userZoom for handlers in long-lived effects (wheel, mousedown).
    const userZoomRef = useRef(1)
    useEffect(() => { userZoomRef.current = userZoom }, [userZoom])

    // ── Pan (right-click drag, Space+left-click drag, cursor-tool left-drag on
    // empty canvas, two-finger touchpad swipe) ──
    const [panOffset, setPanOffset] = useState(() => initialView?.pan ?? { x: 0, y: 0 })
    const panOffsetRef = useRef(panOffset)
    useEffect(() => { panOffsetRef.current = panOffset }, [panOffset])
    const [isPanningState, setIsPanningState] = useState(false)
    const isPanning = useRef(false)
    const panStart  = useRef({ x: 0, y: 0 })
    // Space-bar held → cursor flips to grab and left-click starts pan (Figma
    // convention). Ref so the mousedown handler sees the latest value without
    // re-binding listeners on every keypress.
    const [dragKeyHeld, setDragKeyHeld] = useState(false)
    const dragKeyHeldRef = useRef(false)
    useEffect(() => { dragKeyHeldRef.current = dragKeyHeld }, [dragKeyHeld])
    // Latest tool for the long-lived pan mousedown handler (cursor-tool
    // left-drag pan) without re-binding listeners on every tool switch.
    const toolRef = useRef(tool)
    useEffect(() => { toolRef.current = tool }, [tool])
    // Cursor is the hand (Hold key to pan off). Ref for the pan handler.
    const handMode = !keyToDrag && tool === 'none' && !readOnly && !live
    const handModeRef = useRef(handMode)
    handModeRef.current = handMode
    const keyToDragRef = useRef(keyToDrag)
    keyToDragRef.current = keyToDrag
    const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'
    const keys = keymap ?? defaultKeymap('image', isMac)
    const keysRef = useRef(keys)
    keysRef.current = keys
    // Plain (non-modifier) keys down right now, by binding name, for hold
    // keys that aren't modifiers (Space, a letter).
    const heldKeysRef = useRef(new Set<string>())
    // Where a hand drag started, to tell a click (deselect) from a pan.
    const handPressRef = useRef<{ x: number; y: number } | null>(null)

    // ── History ───────────────────────────────────────────────────────────────
    const {
      state: objects,
      set: commitObjects,
      undo,
      redo,
      canUndo,
      canRedo,
      goTo,
      load: loadSteps,
      mapAll: mapAllSteps,
      steps: historySteps,
      cursor: historyCursor,
      dropped: historyDropped,
    } = useHistory<DrawObject[]>([])

    // Rehydrate persisted annotations by replaying each shape as its own
    // commit — Undo then walks back through them one-at-a-time, identical to
    // the session that created them. Guarded by a ref so StrictMode's double
    // effect invocation doesn't double-push the stack.
    const replayedRef = useRef(false)
    // Flipped true the first time a genuine user edit lands (draw, drag,
    // transform, text, delete, clear, programmatic add, undo/redo). Stays false
    // during the mount-time replay of `initialObjects` so the Editor can tell a
    // real edit apart from rehydration without relying on object-count diffs
    // (which miss same-length edits like dragging a single Text).
    const userEditedRef = useRef(false)
    useEffect(() => {
      if (replayedRef.current) return
      replayedRef.current = true
      // Saved steps (History › Edits) win over a shape-by-shape replay.
      if (initialSteps && initialSteps.steps.length > 0) {
        loadSteps(initialSteps.steps, initialSteps.cursor, initialSteps.dropped ?? 0)
        return
      }
      if (!initialObjects || initialObjects.length === 0) return
      for (let i = 0; i < initialObjects.length; i++) {
        commitObjects(initialObjects.slice(0, i + 1))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const objectsRef = useRef(objects)
    useEffect(() => { objectsRef.current = objects }, [objects])



    // Notify parent on every commit. Depending on `canUndo`/`canRedo` alone
    // would miss changes where those booleans don't toggle — e.g. after the
    // first shape lands `canUndo` stays `true`, so every subsequent shape
    // would be invisible to the parent and the Editor's debounced save would
    // never be scheduled.
    useEffect(() => {
      onHistoryChange?.(canUndo, canRedo, userEditedRef.current)
    }, [objects, canUndo, canRedo, onHistoryChange])
    // The undo steps for History › Edits (and their saving).
    const stepCount = historySteps.length
    useEffect(() => {
      onStepsChange?.([...historySteps], historyCursor, historyDropped)
      // historySteps is mutated in place: its length, the cursor and the
      // shown objects say when it changed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [objects, stepCount, historyCursor, historyDropped, onStepsChange])

    // ── Container sizing ──────────────────────────────────────────────────────
    // Measured before the first paint (2026-11-23): the observer reports
    // only after it, so a first frame at { w: 0 } placed the stage centred
    // on the container's left edge and a wide image's right half flashed
    // there before it jumped into place.
    useLayoutEffect(() => {
      const el = containerRef.current
      if (!el) return
      setContainerSize({ w: el.clientWidth, h: el.clientHeight })
      const ro = new ResizeObserver(entries => {
        const { width, height } = entries[0].contentRect
        setContainerSize({ w: width, h: height })
      })
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    // Focus text input — delayed to prevent Konva mouseUp stealing focus
    useEffect(() => {
      if (textInput && textInputRef.current) {
        const t = setTimeout(() => {
          const el = textInputRef.current
          if (!el) return
          el.focus()
          const n = el.value.length
          el.setSelectionRange(n, n)
        }, 50)
        return () => clearTimeout(t)
      }
    }, [textInput])

    // ── Natural dimensions ────────────────────────────────────────────────────
    const naturalW = background.kind === 'image'
      ? (bgImage?.width  ?? 800)
      : (background.naturalWidth  || 800)
    const naturalH = background.kind === 'image'
      ? (bgImage?.height ?? 600)
      : (background.naturalHeight || 600)

    // Base scale (2026-11-23): actual size, whatever the window. 100% zoom
    // is one image pixel per screen pixel (CSS px = image px / dpr), so a
    // capture opens as big as it was on screen; larger than the window, it
    // pans. (It used to fit the window, with 100% meaning "fitted".)
    const baseScale = 1 / (window.devicePixelRatio || 1)

    const scale = baseScale * userZoom

    // Max zoom: bounded by Chromium's hard canvas caps rather than a fixed
    // percentage. The Stage's canvas spans the whole zoomed image (not just
    // the visible viewport), and Chromium silently blanks a canvas past
    // 65,535 px on a side or ~268M px² of backing-buffer area (CSS px ×
    // devicePixelRatio, since Konva renders buffers at dpr× the CSS size).
    // Stay under both with headroom; floor at 1 so 100% is always reachable.
    // And never past 300% (Jasper, 2026-11-23): the stage's canvas spans the
    // whole zoomed image, so higher zoom made every redraw lag.
    const maxZoom = useMemo(() => {
      const dpr = window.devicePixelRatio || 1
      const maxSide = 60_000 / dpr
      const maxArea = 240_000_000 / (dpr * dpr)
      const w = naturalW * baseScale
      const h = naturalH * baseScale
      return Math.max(1, Math.min(MAX_ZOOM, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h))))
    }, [naturalW, naturalH, baseScale])
    useEffect(() => {
      maxZoomRef.current = maxZoom
      // Pull the zoom back down if the ceiling dropped below it (e.g. the
      // window grew → baseScale grew → the stage hits the canvas cap sooner).
      setUserZoom(z => Math.min(z, maxZoom))
    }, [maxZoom])

    useEffect(() => { onZoomChange?.(userZoom) }, [userZoom, onZoomChange])
    useEffect(() => { onViewChange?.({ zoom: userZoom, pan: panOffset }) }, [userZoom, panOffset, onViewChange])

    // Wheel handling:
    //   • Ctrl/Cmd+wheel and trackpad pinch (Chromium translates pinch
    //     → ctrlKey+wheel) → zoom anchored at cursor.
    //   • Plain mouse wheel → zoom (image-editor convention; mouse users
    //     have no other obvious zoom gesture).
    //   • Plain trackpad two-finger swipe → pan (trackpad users can't
    //     right-click, so wheel is their only pan gesture).
    //
    // Mouse-vs-trackpad detection uses Chromium's non-standard
    // `wheelDeltaY` property: a mouse wheel notch always reports a
    // signed multiple of 120 (Windows WHEEL_DELTA constant) — typical
    // values ±120, ±240, ±360. Trackpad swipes produce arbitrary values
    // that almost never land on a clean 120 multiple. This signal is
    // structural rather than statistical, so it doesn't misfire on fast
    // wheel rolls or fast trackpad flicks the way pure-magnitude or
    // event-frequency heuristics do.
    //
    // Type cast: `wheelDeltaY` is non-standard / deprecated but
    // available in all Chromium versions (which is what Electron uses).
    useEffect(() => {
      const el = containerRef.current
      if (!el || live) return
      const onWheel = (e: WheelEvent) => {
        e.preventDefault()

        const lineHeight = 16
        const rawDy = e.deltaMode === 1 ? e.deltaY * lineHeight : e.deltaY
        const rawDx = e.deltaMode === 1 ? e.deltaX * lineHeight : e.deltaX
        const wheelDelta = (e as unknown as { wheelDeltaY?: number }).wheelDeltaY ?? 0
        const isMouseWheelLike =
          rawDx === 0 &&
          wheelDelta !== 0 &&
          Math.abs(wheelDelta) >= 120 &&
          Math.abs(wheelDelta) % 120 === 0
        const shouldZoom = e.ctrlKey || e.metaKey || isMouseWheelLike

        if (shouldZoom) {
          const rect = el.getBoundingClientRect()
          const mx = e.clientX - rect.left
          const my = e.clientY - rect.top
          const pan = panOffsetRef.current

          setUserZoom(prevZoom => {
            // Trackpad pinch sends small deltaY (~5-15) per event at high
            // frequency; mouse wheel sends ~100 per notch. Use a higher
            // coefficient so pinch feels snappy, but clamp the magnitude so
            // a single mouse-wheel notch still maps to ~14% zoom.
            const clampedDy = Math.sign(rawDy) * Math.min(30, Math.abs(rawDy))
            const factor = Math.exp(-clampedDy * 0.005)
            const nextZoom = clampZoom(prevZoom * factor)
            if (nextZoom === prevZoom) return prevZoom

            const prevScale = baseScale * prevZoom
            const nextScale = baseScale * nextZoom
            const prevStageW = naturalW * prevScale
            const prevStageH = naturalH * prevScale
            const nextStageW = naturalW * nextScale
            const nextStageH = naturalH * nextScale
            const prevLeft = (rect.width  - prevStageW) / 2 + pan.x
            const prevTop  = (rect.height - prevStageH) / 2 + pan.y

            const imgX = (mx - prevLeft) / prevScale
            const imgY = (my - prevTop)  / prevScale

            const newPanX = mx - (rect.width  - nextStageW) / 2 - imgX * nextScale
            const newPanY = my - (rect.height - nextStageH) / 2 - imgY * nextScale
            const clamped = clampPan({ x: newPanX, y: newPanY }, rect.width, rect.height, nextStageW, nextStageH)
            setPanOffset(clamped)
            panOffsetRef.current = clamped

            return nextZoom
          })
          return
        }

        // Trackpad two-finger swipe — pan. Shift+vertical swipe → horizontal
        // pan (matches every native scrollbar).
        const useShiftSwap = e.shiftKey && rawDx === 0
        const panDx = useShiftSwap ? rawDy : rawDx
        const panDy = useShiftSwap ? 0     : rawDy
        const rect = el.getBoundingClientRect()
        const stageW = naturalW * baseScale * userZoomRef.current
        const stageH = naturalH * baseScale * userZoomRef.current
        setPanOffset(prev => clampPan({ x: prev.x - panDx, y: prev.y - panDy }, rect.width, rect.height, stageW, stageH))
      }
      el.addEventListener('wheel', onWheel, { passive: false })
      return () => el.removeEventListener('wheel', onWheel)
    }, [baseScale, naturalW, naturalH])

    // Double-click to reset zoom + pan
    useEffect(() => {
      const el = containerRef.current
      if (!el || live) return
      const onDblClick = (e: MouseEvent) => {
        // Double-clicking inside the text box (word-select) must not yank the
        // view — the box lives inside this container so the event bubbles here.
        if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return
        // Double-clicking a text shape opens in-place editing (Konva fires its
        // own dblclick first, from the same mouseup) — don't also reset zoom.
        if (suppressDblClickZoomResetRef.current) {
          suppressDblClickZoomResetRef.current = false
          return
        }
        setUserZoom(1)
        setPanOffset({ x: 0, y: 0 })
      }
      el.addEventListener('dblclick', onDblClick)
      return () => el.removeEventListener('dblclick', onDblClick)
    }, [])

    // Mouse-drag to pan. Triggers:
    //   • Right-click drag (legacy fallback)
    //   • Space-bar held + left-click drag (Figma / Photoshop convention)
    // Uses capture phase so Konva doesn't also start drawing on the same gesture.
    useEffect(() => {
      const el = containerRef.current
      if (!el || live) return
      const onMouseDown = (e: MouseEvent) => {
        const rightClick    = e.button === 2
        const spaceLeftDrag = e.button === 0 && dragKeyHeldRef.current
        // Hand (Hold key to pan off): a left press anywhere but on a shape, a
        // Transformer handle, the delete handle or the text box pans.
        let handDrag = false
        if (e.button === 0 && handModeRef.current && !(e.target as HTMLElement).closest?.('textarea')) {
          const stage = stageRef.current
          const r = stage?.container().getBoundingClientRect()
          const onNode = !!(stage && r) && !!stage.getIntersection({ x: e.clientX - r.left, y: e.clientY - r.top })
          handDrag = !onNode
        }
        // Cursor's drag on empty canvas no longer pans (2026-11-23): it draws
        // a selection box. Space (any tool), right-drag and the hand pan.
        if (!rightClick && !spaceLeftDrag && !handDrag) return
        handPressRef.current = handDrag ? { x: e.clientX, y: e.clientY } : null
        e.preventDefault()
        e.stopPropagation()
        isPanning.current = true
        setIsPanningState(true)
        // Read the latest pan from the ref so this effect doesn't need
        // panOffset in its deps — otherwise it re-binds all window listeners
        // on every pan mousemove (panOffset updates per frame).
        const pan = panOffsetRef.current
        panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      }
      const onMouseMove = (e: MouseEvent) => {
        if (!isPanning.current) return
        const rect = el.getBoundingClientRect()
        const stageW = naturalW * baseScale * userZoomRef.current
        const stageH = naturalH * baseScale * userZoomRef.current
        setPanOffset(clampPan(
          { x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y },
          rect.width, rect.height, stageW, stageH,
        ))
      }
      const onMouseUp = (e: MouseEvent) => {
        if (!isPanning.current) return
        isPanning.current = false
        setIsPanningState(false)
        // A hand press that didn't move is a click on empty canvas: deselect
        // (Shift / ⌘ keep the selection, as with the selection box).
        const hp = handPressRef.current
        handPressRef.current = null
        if (hp && Math.hypot(e.clientX - hp.x, e.clientY - hp.y) < 3 && !(e.shiftKey || e.metaKey || e.ctrlKey)) setSelectedIds([])
      }
      const onContextMenu = (e: MouseEvent) => e.preventDefault()

      el.addEventListener('mousedown', onMouseDown, true)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      el.addEventListener('contextmenu', onContextMenu)
      return () => {
        el.removeEventListener('mousedown', onMouseDown, true)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        el.removeEventListener('contextmenu', onContextMenu)
      }
    }, [naturalW, naturalH, baseScale])

    // Re-clamp panOffset whenever the stage or container resizes (zoom button,
    // window resize, image swap). Without this, zooming out leaves the stage
    // partially off-screen because the pan bounds shrink with stage size.
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      // Not before the image (and so its real size) is known: the 800 x 600
      // placeholder would clamp a remembered pan (initialView) away.
      if (background.kind === 'image' && !bgImage) return
      const stageW = naturalW * baseScale * userZoom
      const stageH = naturalH * baseScale * userZoom
      setPanOffset(prev => clampPan(prev, el.clientWidth, el.clientHeight, stageW, stageH))
    }, [userZoom, baseScale, naturalW, naturalH, containerSize, background.kind, bgImage])

    // Pan-key tracking (the `pan` key, Space by default). Window-level so the
    // key works anywhere on the canvas. Skipped while typing in an input so
    // text annotation isn't broken. Only with Settings › Hold key to pan on.
    // Also keeps `heldKeysRef` (plain keys down) for the hold keys.
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        const k = codeToKey(e.code)
        if (k) heldKeysRef.current.add(k)
        const pan = keysRef.current.pan
        if (e.repeat || !keyToDragRef.current || !isHoldKeyEvent(pan, e, isMac)) return
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        // Space would scroll / press a focused button, a letter would type,
        // Alt alone would focus the menu bar on Windows. Ctrl, Cmd and Shift
        // are left alone (chords).
        if (!isModifierBinding(pan) || pan === 'Alt') e.preventDefault()
        setDragKeyHeld(true)
      }
      const onKeyUp = (e: KeyboardEvent) => {
        const k = codeToKey(e.code)
        if (k) heldKeysRef.current.delete(k)
        if (!isHoldKeyEvent(keysRef.current.pan, e, isMac)) return
        setDragKeyHeld(false)
      }
      const onBlur = () => { heldKeysRef.current.clear(); setDragKeyHeld(false) }
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup',   onKeyUp)
      window.addEventListener('blur',    onBlur)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup',   onKeyUp)
        window.removeEventListener('blur',    onBlur)
      }
    // isMac never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const stageWidth  = Math.round(naturalW * scale)
    const stageHeight = Math.round(naturalH * scale)
    // The stage's place, snapped to device pixels (2026-11-25), so the
    // Background frame drawn behind it lines up on every side: unsnapped,
    // the two rounded separately and a 1px frame showed only at the right
    // and bottom.
    const dpr = window.devicePixelRatio || 1
    const snapPx = (v: number) => Math.round(v * dpr) / dpr
    const stageLeft = snapPx((containerSize.w - stageWidth) / 2 + panOffset.x)
    const stageTop  = snapPx((containerSize.h - stageHeight) / 2 + panOffset.y)
    // The frame's width in CSS px, whole device pixels, at least one when
    // there is padding; around the image's exact size (the stage can be up
    // to half a pixel bigger from the rounding above).
    const padPx = frame ? framePadding(frame, naturalW, naturalH) : 0
    const framePx = padPx > 0
      ? Math.max(1, Math.round(padPx * scale * dpr)) / dpr
      : 0
    // A frame shows with padding or a ratio (a ratio alone adds background
    // on one axis), images only.
    const frameOn = !!frame && background.kind === 'image' && (padPx > 0 || frame.ratio !== null)
    // Its margins on screen, CSS px: the padding part in whole device
    // pixels (framePx), the ratio's extra space on top of it.
    const frameBox = (() => {
      if (!frameOn || !frame) return null
      const lay = frameLayout(frame, naturalW, naturalH)
      const p = padPx
      const margin = (m: number) => framePx + snapPx((m - p) * scale)
      const left = margin(lay.x)
      const top = margin(lay.y)
      const right = margin(lay.width - naturalW - lay.x)
      const bottom = margin(lay.height - naturalH - lay.y)
      const w = snapPx(naturalW * scale)
      const h = snapPx(naturalH * scale)
      return { left: stageLeft - left, top: stageTop - top, width: left + w + right, height: top + h + bottom }
    })()

    // Prepare the stage for a natural-resolution export and return a restore
    // fn. Two concerns handled here:
    //   1. Selection chrome — detach the purple Transformer frame and hide the
    //      red X delete handle so neither bakes into the PNG. (Previously only
    //      toAnnotationsCanvas did this, so Copy/Save/Upload captured the UI.)
    //   2. Zoom independence — the stage is reset to baseScale (zoom = 1)
    //      for the export, so it's always drawn at 100%. Strokes and arrow
    //      heads are in image units since 2026-11-23 (they scale with the
    //      stage), so this is what keeps the zoom out of the PNG. Geometry is
    //      unaffected because pixelRatio compensates 1:1 (see below).
    const prepareExport = useCallback((stage: Konva.Stage): (() => void) => {
      const tr = trRef.current
      const handle = stage.findOne('#__delete_handle__')
      const highlight = stage.findOne('#__highlight__')
      const prevTrNodes = tr?.nodes() ?? []
      const prevHandle = handle?.visible() ?? true
      const prevHighlight = highlight?.visible() ?? true
      highlight?.visible(false)
      const prevScaleX = stage.scaleX()
      const prevScaleY = stage.scaleY()
      tr?.nodes([])
      handle?.visible(false)
      stage.scale({ x: baseScale, y: baseScale })
      // Arrowhead size is rendered as `base/scale` image units so it reads as
      // constant screen px while editing. That ties it to the live zoom, so
      // re-derive each arrow's pointer size against baseScale during export to
      // keep the rasterised arrowhead zoom-independent. Restored afterwards.
      const arrowRestores: Array<() => void> = []
      const denom = baseScale > 0 ? baseScale : 1
      for (const obj of objectsRef.current) {
        if (obj.type !== 'arrow') continue
        const node = stage.findOne('#' + obj.id) as Konva.Arrow | undefined
        if (!node) continue
        const prevLen = node.pointerLength()
        const prevWid = node.pointerWidth()
        const size = Math.max(8, obj.strokeWidth * 3) / denom
        node.pointerLength(size)
        node.pointerWidth(size)
        arrowRestores.push(() => { node.pointerLength(prevLen); node.pointerWidth(prevWid) })
      }
      stage.batchDraw()
      return () => {
        if (tr && prevTrNodes.length > 0) tr.nodes(prevTrNodes)
        handle?.visible(prevHandle)
        highlight?.visible(prevHighlight)
        for (const r of arrowRestores) r()
        stage.scale({ x: prevScaleX, y: prevScaleY })
        stage.batchDraw()
      }
    }, [baseScale])

    // With the stage neutralised to baseScale, the export must capture the
    // baseScale-sized region (naturalW*baseScale × naturalH*baseScale) — NOT
    // the stage's zoomed width/height props, which Konva would use by default.
    // pixelRatio=1/baseScale then maps that region back to the image's natural
    // pixel dimensions. The explicit rect makes the output zoom-independent in
    // both resolution AND stroke thickness.
    const exportRect = useCallback(() => {
      const r = baseScale > 0 ? baseScale : scale
      return {
        x: 0,
        y: 0,
        width: Math.round(naturalW * r),
        height: Math.round(naturalH * r),
        pixelRatio: 1 / r,
      }
    }, [baseScale, scale, naturalW, naturalH])

    // ── Composite snapshot (current background + annotations at natural res) ──
    const toDataURL = useCallback((): string => {
      const stage = stageRef.current
      if (!stage || !bgImage) return ''
      const restore = prepareExport(stage)
      let out: string
      if (frameOn && frame) {
        // The frame (2026-11-25): a bigger canvas (padding on every side,
        // widened or heightened to the ratio), painted with the background,
        // the image composite on top where the alignment puts it.
        const inner = stage.toCanvas(exportRect())
        const lay = frameLayout(frame, inner.width, inner.height)
        const c = document.createElement('canvas')
        c.width = lay.width
        c.height = lay.height
        const ctx = c.getContext('2d')!
        frame.paint(ctx, c.width, c.height)
        // The shadow follows the image's alpha, so a window capture's
        // transparent corners cast none.
        ctx.save()
        if (frame.shadow) {
          ctx.shadowColor = `rgba(0,0,0,${frame.shadow.alpha})`
          ctx.shadowBlur = frame.shadow.blur
          ctx.shadowOffsetY = frame.shadow.offsetY
        }
        ctx.drawImage(inner, lay.x, lay.y)
        ctx.restore()
        out = c.toDataURL('image/png')
      } else {
        out = stage.toDataURL({ mimeType: 'image/png', ...exportRect() })
      }
      restore()
      return out
    }, [bgImage, exportRect, prepareExport, frame, frameOn])

    const toPreviewDataURL = useCallback((maxWidth: number): string => {
      const stage = stageRef.current
      if (!stage || !bgImage) return ''
      const rect = exportRect()
      const restore = prepareExport(stage)
      const out = stage.toDataURL({
        ...rect,
        mimeType: 'image/jpeg',
        quality: 0.8,
        pixelRatio: Math.min(rect.pixelRatio, maxWidth / Math.max(1, rect.width)),
      })
      restore()
      return out
    }, [bgImage, exportRect, prepareExport])

    const toCanvas = useCallback((): HTMLCanvasElement | null => {
      const stage = stageRef.current
      if (!stage || !bgImage) return null
      const restore = prepareExport(stage)
      const out = stage.toCanvas(exportRect())
      restore()
      return out
    }, [bgImage, exportRect, prepareExport])

    const toAnnotationsCanvas = useCallback((): HTMLCanvasElement | null => {
      const stage = stageRef.current
      if (!stage) return null
      // Temporarily hide the background node so the export contains only the
      // annotation shapes. Selection chrome + zoom are neutralised via the
      // shared helper.
      const bg = stage.findOne('#__bg__')
      const prevBg = bg?.visible() ?? true
      const restore = prepareExport(stage)
      bg?.visible(false)
      stage.batchDraw()
      const out = stage.toCanvas(exportRect())
      bg?.visible(prevBg)
      restore()
      return out
    }, [exportRect, prepareExport])

    const getObjects = useCallback((): DrawObject[] => objectsRef.current, [])

    // User-initiated Clear: commit an empty state instead of resetting the
    // history stack. That way the parent's `onHistoryChange` sees `canUndo`
    // flip to `true` (so the Editor's debounced save fires and the sidecar
    // PNG + thumbnail get regenerated from the original image), and the user
    // can undo the clear to recover the shapes if it was accidental.
    const clearViaCommit = useCallback(() => {
      userEditedRef.current = true
      commitObjects([])
    }, [commitObjects])

    // Programmatic append: one history entry covers the whole batch so a
    // single Undo removes them all together.
    const addObjects = useCallback((objs: Omit<DrawObject, 'id'>[]) => {
      if (objs.length === 0) return
      userEditedRef.current = true
      const stamped: DrawObject[] = objs.map(o => ({ ...o, id: uid() }))
      commitObjects([...objectsRef.current, ...stamped])
    }, [commitObjects])

    // A sticker's size on the image (natural px), for addSticker and the
    // drag ghost (stickerScreenSize, at the current zoom).
    const stickerSize = useCallback((aspectIn: number) => {
      const aspect = aspectIn > 0 ? aspectIn : 1   // naturalWidth / naturalHeight
      // STICKER_SCREEN_W wide on screen at the current zoom (2026-11-26; 15%
      // of the image's width before, far too big on a full-screen capture),
      // capped to a fit box of 80% of the image in each axis. `maxFitW` is
      // the widest the sticker can be while honouring its aspect AND staying
      // inside that box (capping width alone let tall stickers spill past
      // the top / bottom of a short image).
      const fitW = naturalW * 0.8
      const fitH = naturalH * 0.8
      const maxFitW = Math.min(fitW, fitH * aspect)
      const w = Math.max(1, Math.round(Math.min(maxFitW, STICKER_SCREEN_W / (scale || 1))))
      const h = Math.max(1, Math.round(w / aspect))
      return { w, h }
    }, [naturalW, naturalH, scale])
    const stickerScreenSize = useCallback((aspect: number) => {
      const { w, h } = stickerSize(aspect)
      return { w: w * scale, h: h * scale }
    }, [stickerSize, scale])
    // Place a sticker centred on the image (or on a drop point), its own
    // aspect preserved, then select it so the user can immediately
    // drag/resize. Lives here (not the Editor) because the natural
    // dimensions and selection state are local to the canvas.
    const addSticker = useCallback((opts: { src: string; aspect: number; at?: { clientX: number; clientY: number } }) => {
      const { w, h } = stickerSize(opts.aspect)
      // Centred on the image, or (dropped, 2026-11-23) on the drop point,
      // kept inside the image.
      let x = Math.round((naturalW - w) / 2)
      let y = Math.round((naturalH - h) / 2)
      const stage = stageRef.current
      if (opts.at && stage) {
        const r = stage.container().getBoundingClientRect()
        const cx = (opts.at.clientX - r.left) / scale, cy = (opts.at.clientY - r.top) / scale
        x = Math.round(Math.min(Math.max(0, cx - w / 2), naturalW - w))
        y = Math.round(Math.min(Math.max(0, cy - h / 2), naturalH - h))
      }
      const id = uid()
      userEditedRef.current = true
      commitObjects([
        ...objectsRef.current,
        { id, type: 'sticker', src: opts.src, x, y, width: w, height: h, color: '#000000', strokeWidth: 0 },
      ])
      setSelectedId(id)
    }, [commitObjects, stickerSize, scale, naturalW, naturalH])

    // Undo/redo are user actions too — flip the edit latch so the parent's
    // debounced save fires for them (otherwise undoing the only edit back to
    // the baseline length would look like rehydration and skip the save).
    const undoUser = useCallback(() => { userEditedRef.current = true; undo() }, [undo])
    const redoUser = useCallback(() => { userEditedRef.current = true; redo() }, [redo])
    const goToStepUser = useCallback((i: number) => { userEditedRef.current = true; goTo(i) }, [goTo])

    // ── Layers tab (2026-11-23) ─────────────────────────────────────────────
    const selectShapes = useCallback((ids: string[], toggle = false) => {
      const shown = ids.filter(id => objectsRef.current.some(o => o.id === id && !o.hidden))
      setSelectedIds(prev => toggle
        ? [...prev.filter(id => !shown.includes(id)), ...shown.filter(id => !prev.includes(id))]
        : shown)
    }, [])
    // Order and visibility aren't undo steps (2026-11-23): they're written
    // into every step (mapAllSteps), so undo / redo / a step jump keep them.
    const reorderShapes = useCallback((ids: string[]) => {
      const cur = objectsRef.current
      if (ids.length !== cur.length || ids.every((id, i) => cur[i].id === id)) return
      if (new Set(ids).size !== ids.length || !cur.every(o => ids.includes(o.id))) return
      const rank = new Map(ids.map((id, i) => [id, i]))
      userEditedRef.current = true
      // In each step the shapes this order knows take its order, in the
      // places they hold; shapes only other steps have keep their places.
      mapAllSteps(step => {
        const slots = step.flatMap((o, i) => (rank.has(o.id) ? [i] : []))
        const known = slots.map(i => step[i]).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
        const next = [...step]
        slots.forEach((slot, k) => { next[slot] = known[k] })
        return next
      })
    }, [mapAllSteps])
    const setShapeHidden = useCallback((id: string, hidden: boolean) => {
      const o = objectsRef.current.find(x => x.id === id)
      if (!o || !!o.hidden === hidden) return
      userEditedRef.current = true
      mapAllSteps(step => step.map(x => {
        if (x.id !== id) return x
        const { hidden: _drop, ...rest } = x
        return hidden ? { ...rest, hidden: true } : rest
      }))
      if (hidden) setSelectedIds(prev => prev.filter(s => s !== id))
    }, [mapAllSteps])
    // A shape that ends up hidden (an undo, a step jump) leaves the selection.
    useEffect(() => {
      setSelectedIds(prev => {
        const next = prev.filter(id => objects.some(o => o.id === id && !o.hidden))
        return next.length === prev.length ? prev : next
      })
    }, [objects])

    // Expose imperative handle to parent
    useImperativeHandle(ref, () => ({
      undo: undoUser, redo: redoUser, clear: clearViaCommit, canUndo, canRedo,
      zoomIn, zoomOut, zoomReset, zoomLevel: userZoom,
      toDataURL, toPreviewDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects, addSticker, stickerScreenSize,
      goToStep: goToStepUser, selectShapes, reorderShapes, setShapeHidden,
    }), [undoUser, redoUser, clearViaCommit, canUndo, canRedo, zoomIn, zoomOut, zoomReset, userZoom, toDataURL, toPreviewDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects, addSticker, stickerScreenSize, goToStepUser, selectShapes, reorderShapes, setShapeHidden])

    // ── Export trigger (legacy path — kept for Editor's workflow buttons) ────
    useEffect(() => {
      if (exportTrigger > 0 && stageRef.current && onExport) {
        onExport(toDataURL())
      }
    }, [exportTrigger, onExport, toDataURL])

    // ── Transformer attachment ────────────────────────────────────────────────
    // A text being edited in place stays selected (so toolbar color / size
    // changes apply to it and the toolbar mirrors it) but its Konva node is
    // hidden behind the textarea — no frame around an invisible node.
    useEffect(() => {
      const tr = trRef.current
      if (!tr) return
      const stage = stageRef.current
      const ids = selectedIds.filter(id => id !== textInput?.editingId)
      if (!stage || ids.length === 0) { tr.nodes([]); tr.getLayer()?.batchDraw(); return }
      // Several shapes: one frame round them all (Konva's Transformer
      // spans its nodes; dragging one moves them together).
      tr.nodes(ids.map(id => stage.findOne('#' + id)).filter((n): n is Konva.Node => !!n))
      tr.getLayer()?.batchDraw()
    }, [selKey, objects, stickerLoadTick, textInput])

    // Switching tools drops the selection — except when the new tool is the
    // selected shape's own kind. Selecting a shape makes the Editor switch to
    // that tool (`onSelectionChange` → `setTool`), and that switch must not
    // undo the selection it was caused by; a user picking the matching tool by
    // hand keeps it too. `selectedId` is read from this render's closure on
    // purpose: the effect should fire on tool changes only, not on selection
    // changes.
    useEffect(() => {
      if (tool === 'none') return
      const sel = selectedId ? objectsRef.current.find(o => o.id === selectedId) : undefined
      if (sel && sel.type === tool) return
      setSelectedId(null)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tool])

    // ── Selection ↔ toolbar style ─────────────────────────────────────────────
    // Report the selected shape's style. Keyed on the id only — a style change
    // coming *from* the toolbar re-renders with the same selection and must
    // not echo back into the toolbar.
    const onSelectionChangeRef = useRef(onSelectionChange)
    useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])
    const onSelectedIdsChangeRef = useRef(onSelectedIdsChange)
    useEffect(() => { onSelectedIdsChangeRef.current = onSelectedIdsChange }, [onSelectedIdsChange])
    useEffect(() => {
      const cb = onSelectionChangeRef.current
      if (!cb) return
      const first = selectedIdsRef.current[0]
      const obj = first ? objectsRef.current.find(o => o.id === first) : undefined
      cb(obj ? { id: obj.id, type: obj.type, color: obj.color, strokeWidth: obj.strokeWidth } : null)
      onSelectedIdsChangeRef.current?.(selectedIdsRef.current)
    }, [selKey])

    // Toolbar color / stroke-width changes while a shape is selected restyle
    // that shape (the toolbar was just synced to it, so the user is editing
    // what they see). Text follows too: its size derives from strokeWidth.
    // Consecutive tweaks to the same shape with no other commit in between
    // coalesce into one undo step — dragging the stroke slider is one
    // gesture, not twenty. Coalescing is detected by array identity: any
    // other commit (draw, drag, undo) replaces the objects array.
    const prevStyleRef = useRef({ color, strokeWidth })
    const styleCoalesceRef = useRef<{ id: string; result: DrawObject[] } | null>(null)
    useEffect(() => {
      const prev = prevStyleRef.current
      prevStyleRef.current = { color, strokeWidth }
      if (prev.color === color && prev.strokeWidth === strokeWidth) return
      // Every selected shape that carries a style (stickers don't).
      const ids = new Set(selectedIds)
      const targets = objectsRef.current.filter(o => ids.has(o.id) && o.type !== 'sticker')
      if (targets.length === 0) return
      const changed = targets.some(o => o.color !== color || o.strokeWidth !== strokeWidth)
      if (!changed) return
      userEditedRef.current = true
      const coalesce = styleCoalesceRef.current?.id === selKey
        && styleCoalesceRef.current.result === objectsRef.current
      const result = objectsRef.current.map(o => (ids.has(o.id) && o.type !== 'sticker' ? { ...o, color, strokeWidth } : o))
      styleCoalesceRef.current = { id: selKey, result }
      commitObjects(result, { replace: coalesce })
    }, [color, strokeWidth, selKey, commitObjects])

    // Track the top-right corner of the selected shape so the delete handle
    // (small red X next to the Transformer) follows the shape during drag /
    // transform without needing to wait for the next React render. The initial
    // placement seeds React state (so the handle mounts); subsequent live
    // updates during drag/transform move the Konva node directly via its ref,
    // avoiding a full canvas re-render on every mousemove.
    useEffect(() => {
      const ids = selectedIds.filter(id => id !== textInput?.editingId)
      const stage = stageRef.current
      if (ids.length === 0 || !stage) { setDeleteHandle(null); return }
      const nodes = ids.map(id => stage.findOne('#' + id)).filter((n): n is Konva.Node => !!n)
      const layer = nodes[0]?.getLayer() ?? null
      if (nodes.length === 0 || !layer) { setDeleteHandle(null); return }
      // At the top-right of all of them (the frame round the selection).
      const compute = () => {
        let right = -Infinity, top = Infinity
        nodes.forEach((n, i) => {
          const b = boxOf(ids[i], n, layer)
          right = Math.max(right, b.x + b.width); top = Math.min(top, b.y)
        })
        return { x: right, y: top }
      }
      setDeleteHandle(compute())
      const update = () => {
        const p = compute()
        const handle = deleteHandleRef.current
        if (handle) {
          // The 12/scale offset mirrors the React-rendered placement below
          // (x={deleteHandle.x + 12/scale}) so the imperative move lands the
          // handle in exactly the same spot, just without a React re-render.
          handle.position({ x: p.x + DELETE_OFFSET / scale, y: p.y - DELETE_OFFSET / scale })
          handle.getLayer()?.batchDraw()
        } else {
          setDeleteHandle(p)
        }
      }
      nodes.forEach(n => n.on('dragmove.deletehandle transform.deletehandle', update))
      return () => {
        nodes.forEach(n => n.off('dragmove.deletehandle transform.deletehandle'))
      }
    // boxOf reads objects, already a dependency. stickerLoadTick: a sticker's
    // node only mounts once its picture has loaded, after it's placed and
    // selected; without it a new sticker got no delete button (2026-11-26).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selKey, objects, baseScale, scale, textInput, stickerLoadTick])

    // ── Keyboard: the `delete` key (Delete / Backspace) removes the selection ─
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (matchesBinding(keysRef.current.delete, e, isMac) && selectedIds.length > 0) {
          e.preventDefault()
          userEditedRef.current = true
          const ids = new Set(selectedIds)
          commitObjects(prev => prev.filter(o => !ids.has(o.id)))
          setSelectedIds([])
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [selKey, commitObjects])

    // ── Select / move while drawing ───────────────────────────────────────────
    // In a drawing/text tool, pressing on an existing shape never draws:
    // release without dragging = select it (Text tool on a text = edit it);
    // dragging = Konva moves it (every committed shape is draggable) and it
    // becomes the selection on release. New shapes start on empty canvas only
    // — the ShareX / Snagit convention.
    //
    // Konva decides what is a drag (its own 3 px threshold): onDragStart
    // clears the press, so a press still pending at mouseup was a click. While
    // Konva drags, the Stage receives no mousemove at all and nothing here
    // touches React state — the drag stays a bare Konva drag (no re-render,
    // no Transformer) until the mouse is released.
    const pendingPressRef = useRef<{ objId: string } | null>(null)
    // Shape under the cursor — drives the pointer/move cursor that hints
    // "click to select" while a drawing tool is active.
    const [hoverId, setHoverId] = useState<string | null>(null)

    // Walk up from an event target to the node carrying an object id (blur's
    // inner Image is nested in its Group). Transformer anchors, the delete
    // handle and the background never resolve to an object.
    const objectIdFromTarget = useCallback((node: Konva.Node | null): string | null => {
      let n: Konva.Node | null = node
      while (n && n.getClassName() !== 'Layer' && n.getClassName() !== 'Stage') {
        const id = n.id()
        if (id && objectsRef.current.some(o => o.id === id)) return id
        n = n.getParent()
      }
      return null
    }, [])

    // Begin a new shape of the active tool at `pos` (image coordinates).
    const startDrawing = useCallback((pos: { x: number; y: number }) => {
      setIsDrawing(true)
      isDrawingRef.current = true
      drawStart.current = pos
      penTrailRef.current = [pos.x, pos.y]
      lastDrawPosRef.current = pos
      const base: DrawObject = { id: uid(), type: tool, color, strokeWidth }
      if (isFreehand(tool)) {
        setCurrentObj({ ...base, points: [pos.x, pos.y] })
      } else if (tool === 'rect' || tool === 'blur') {
        setCurrentObj({ ...base, x: pos.x, y: pos.y, width: 0, height: 0 })
      } else if (tool === 'ellipse') {
        setCurrentObj({ ...base, x: pos.x, y: pos.y, radiusX: 0, radiusY: 0 })
      } else if (tool === 'arrow') {
        setCurrentObj({ ...base, points: [pos.x, pos.y, pos.x, pos.y] })
      }
    }, [tool, color, strokeWidth])

    // ── Text entry ────────────────────────────────────────────────────────────
    const commitText = useCallback(
      (entry: TextEntry, value: string) => {
        if (entry.editingId) {
          const id = entry.editingId
          const cur = objectsRef.current.find(o => o.id === id)
          // Object gone (undo) or text unchanged → no undo step.
          if (!cur || (cur.text ?? '') === value) return
          userEditedRef.current = true
          // Emptying an existing text deletes it (Escape cancels instead).
          commitObjects(prev => value.trim()
            ? prev.map(o => (o.id === id ? { ...o, text: value } : o))
            : prev.filter(o => o.id !== id))
          return
        }
        if (!value.trim()) return
        userEditedRef.current = true
        commitObjects(prev => [
          ...prev,
          { id: uid(), type: 'text' as Tool, x: entry.x, y: entry.y, text: value, color, strokeWidth },
        ])
      },
      [commitObjects, color, strokeWidth],
    )

    // Open the text box. If one is already open its content is committed first
    // — the textarea's blur would otherwise fire after the new entry's state
    // is set and clobber it (the old flow lost the first text that way).
    const openTextEntry = useCallback(
      (entry: TextEntry, initialValue: string) => {
        if (textEntryRef.current) {
          commitText(textEntryRef.current, textValueRef.current)
          skipBlurCommitRef.current = true
          setTimeout(() => { skipBlurCommitRef.current = false }, 0)
        }
        setTextInput(entry)
        setTextValue(initialValue)
      },
      [commitText],
    )

    // Re-edit an existing text object in place: double-click it with the
    // cursor tool, or click it while the Text tool is active.
    const beginTextEdit = useCallback(
      (obj: DrawObject) => {
        if (readOnly || obj.type !== 'text') return
        const x = obj.x ?? 0
        const y = obj.y ?? 0
        // Editing keeps (or takes) the selection: the toolbar syncs to this
        // text and its color / size edits land on it live while typing. The
        // Transformer and delete handle hide themselves for the edited text.
        setSelectedId(obj.id)
        openTextEntry({ x, y, screenX: x * scale, screenY: y * scale, editingId: obj.id }, obj.text ?? '')
      },
      [openTextEntry, readOnly, scale],
    )

    // ── Drawing handlers ──────────────────────────────────────────────────────
    const handleMouseDown = useCallback(
      (e: Konva.KonvaEventObject<MouseEvent>) => {
        pendingPressRef.current = null
        if (readOnly || e.evt.button === 2) return
        if (tool === 'none') {
          // Space held: the container pans; nothing else.
          if (dragKeyHeldRef.current || handModeRef.current) return
          // Empty canvas (the image counts, it doesn't listen): start a
          // selection box; a press that doesn't move just deselects.
          if (e.target === e.target.getStage()) {
            const raw = e.target.getStage()!.getPointerPosition()!
            const p = { x: raw.x / scale, y: raw.y / scale }
            const add = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey
            setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, add })
          }
          return
        }
        // Transformer anchors and the delete handle handle their own presses.
        if (e.target.getParent()?.getClassName() === 'Transformer') return
        const dh = deleteHandleRef.current
        if (dh && (e.target === dh || dh.isAncestorOf(e.target))) return

        const raw = e.target.getStage()!.getPointerPosition()!
        const pos = { x: raw.x / scale, y: raw.y / scale }

        // Only Cursor selects and moves shapes (2026-11-23): a drawing tool
        // draws, also when the press lands on a shape. One exception: the
        // Text tool on a text re-opens it for editing (decided on release).
        const hitId = objectIdFromTarget(e.target)
        if (hitId && tool === 'text' && objectsRef.current.find(o => o.id === hitId)?.type === 'text') {
          pendingPressRef.current = { objId: hitId }
          return
        }

        // Empty canvas: drop the selection, then draw / place text.
        setSelectedId(null)
        if (tool === 'text') {
          openTextEntry({ x: pos.x, y: pos.y, screenX: raw.x, screenY: raw.y }, '')
          return
        }
        startDrawing(pos)
      },
      [tool, scale, readOnly, openTextEntry, startDrawing, objectIdFromTarget],
    )

    // Every point the pointer passed in the current pen stroke, kept while
    // Shift shows it as a straight line so releasing Shift brings it back.
    const penTrailRef = useRef<number[]>([])
    // Last pointer position of the current drawing (image coordinates), for
    // reshaping on a Shift press without a pointer move.
    const lastDrawPosRef = useRef({ x: 0, y: 0 })

    // Reshape the shape being drawn for the pointer at `pos`. With Shift held,
    // Pen draws one straight line from its start and both it and Arrow snap
    // to SHIFT_SNAP_DEG steps; Rect, Blur and Ellipse keep equal sides (square, circle).
    const updateDrawing = useCallback((pos: { x: number; y: number }, shift: boolean) => {
      const s = drawStart.current
      setCurrentObj(prev => {
        if (!prev) return null
        if (isFreehand(prev.type) || prev.type === 'arrow') {
          let end = pos
          if (shift) {
            const dx = pos.x - s.x, dy = pos.y - s.y
            const step = SHIFT_SNAP_DEG * Math.PI / 180
            const a = Math.round(Math.atan2(dy, dx) / step) * step
            // Project the pointer onto the snapped direction so the end
            // follows the pointer along it.
            const len = dx * Math.cos(a) + dy * Math.sin(a)
            end = { x: s.x + len * Math.cos(a), y: s.y + len * Math.sin(a) }
          }
          if (isFreehand(prev.type) && !shift) return { ...prev, points: [...penTrailRef.current] }
          return { ...prev, points: [s.x, s.y, end.x, end.y] }
        }
        let dx = pos.x - s.x, dy = pos.y - s.y
        if (shift) {
          const side = Math.max(Math.abs(dx), Math.abs(dy))
          dx = Math.sign(dx || 1) * side
          dy = Math.sign(dy || 1) * side
        }
        if (prev.type === 'rect' || prev.type === 'blur') {
          return {
            ...prev,
            x: Math.min(s.x, s.x + dx),
            y: Math.min(s.y, s.y + dy),
            width: Math.abs(dx),
            height: Math.abs(dy),
          }
        }
        if (prev.type === 'ellipse') {
          return {
            ...prev,
            radiusX: Math.abs(dx) / 2,
            radiusY: Math.abs(dy) / 2,
            x: s.x + dx / 2,
            y: s.y + dy / 2,
          }
        }
        return prev
      })
    }, [])

    const handleMouseMove = useCallback(
      (e: Konva.KonvaEventObject<MouseEvent>) => {
        // A selection box follows the pointer from a window listener (below),
        // also outside the image.
        if (marqueeRef.current) return
        if (pendingPressRef.current) {
          // Pressed on a shape, Konva hasn't started dragging it yet: never
          // draw. A button released off-stage voids the press.
          if (!(e.evt.buttons & 1)) pendingPressRef.current = null
          return
        }
        if (!isDrawing || !currentObj) return
        const raw = e.target.getStage()!.getPointerPosition()!
        const pos = { x: raw.x / scale, y: raw.y / scale }
        if (isFreehand(currentObj.type)) penTrailRef.current.push(pos.x, pos.y)
        lastDrawPosRef.current = pos
        updateDrawing(pos, isHoldDown(keysRef.current.constrain, e.evt, heldKeysRef.current, isMac))
      },
      [isDrawing, currentObj, scale, updateDrawing],
    )

    // The straight-line key (`constrain`, Shift by default) pressed or
    // released mid-drag reshapes the drawing at once, without waiting for the
    // pointer to move.
    useEffect(() => {
      if (!isDrawing) return
      const onKey = (e: KeyboardEvent) => {
        if (e.repeat || !isHoldKeyEvent(keysRef.current.constrain, e, isMac)) return
        updateDrawing(lastDrawPosRef.current, e.type === 'keydown')
      }
      window.addEventListener('keydown', onKey)
      window.addEventListener('keyup', onKey)
      return () => {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('keyup', onKey)
      }
    }, [isDrawing, updateDrawing])

    const MIN_SHAPE_SIZE = 4
    const isTrivialShape = (obj: DrawObject) => {
      if (isFreehand(obj.type)) return (obj.points?.length ?? 0) < 4
      if (obj.type === 'arrow') {
        const p = obj.points ?? []
        return p.length < 4 || (Math.abs(p[2] - p[0]) < MIN_SHAPE_SIZE && Math.abs(p[3] - p[1]) < MIN_SHAPE_SIZE)
      }
      if (obj.type === 'rect' || obj.type === 'blur') {
        return Math.abs(obj.width ?? 0) < MIN_SHAPE_SIZE || Math.abs(obj.height ?? 0) < MIN_SHAPE_SIZE
      }
      if (obj.type === 'ellipse') {
        return (obj.radiusX ?? 0) < MIN_SHAPE_SIZE / 2 || (obj.radiusY ?? 0) < MIN_SHAPE_SIZE / 2
      }
      return false
    }

    const handleMouseUp = useCallback(() => {
      // A selection box: every shape it touches is selected (Finder);
      // Shift / ⌘ add them to the selection. Under 3px on screen it was a
      // click on empty canvas: deselect (unless adding).
      const m = marqueeRef.current
      if (m) {
        marqueeRef.current = null
        setMarquee(null)
        const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1)
        const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0)
        if (Math.max(w, h) * scale < 3) { if (!m.add) setSelectedIds([]); return }
        const stage = stageRef.current
        const layer = stage?.getLayers()[0]
        if (!stage || !layer) return
        const hit = objectsRef.current.filter(o => {
          const node = stage.findOne('#' + o.id)
          if (!node) return false
          const b = boxOf(o.id, node, layer)
          return b.x <= x + w && b.x + b.width >= x && b.y <= y + h && b.y + b.height >= y
        }).map(o => o.id)
        setSelectedIds(prev => m.add ? [...prev, ...hit.filter(id => !prev.includes(id))] : hit)
        return
      }
      const pending = pendingPressRef.current
      if (pending) {
        pendingPressRef.current = null
        const obj = objectsRef.current.find(o => o.id === pending.objId)
        if (obj) {
          if (toolRef.current === 'text' && obj.type === 'text') beginTextEdit(obj)
          else setSelectedId(obj.id)
        }
        return
      }
      // Guard against the double-fire: the Stage's onMouseUp and the
      // window-level mouseup fallback both call this for one gesture with no
      // re-render in between. The ref is flipped synchronously here so the
      // second call bails before committing the shape a second time.
      if (!isDrawingRef.current) return
      isDrawingRef.current = false
      if (!isDrawing || !currentObj) return
      setIsDrawing(false)
      if (isTrivialShape(currentObj)) { setCurrentObj(null); return }
      userEditedRef.current = true
      // A new blur goes to the bottom of the order, under everything; the
      // rest go on top (2026-11-23).
      commitObjects(prev => currentObj.type === 'blur' ? [currentObj, ...prev] : [...prev, currentObj])
      setCurrentObj(null)
    // boxOf reads refs; scale for the click-vs-drag threshold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDrawing, currentObj, commitObjects, beginTextEdit, scale])

    // Global mouseup so a shape still commits if the pointer exits the stage
    useEffect(() => {
      if (!isDrawing) return
      const onUp = (e: MouseEvent) => {
        if (e.button !== 0) return
        handleMouseUp()
      }
      window.addEventListener('mouseup', onUp)
      return () => window.removeEventListener('mouseup', onUp)
    }, [isDrawing, handleMouseUp])

    // Window point → image coordinates (may lie outside the image).
    const clientToImage = useCallback((clientX: number, clientY: number) => {
      const r = stageRef.current?.container().getBoundingClientRect()
      if (!r) return { x: 0, y: 0 }
      return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale }
    }, [scale])

    // Cursor's selection box can start anywhere in the canvas area, not only
    // on the image (2026-11-24). Presses on the image start it in
    // handleMouseDown; this takes the rest of the area.
    const handleAreaMouseDown = useCallback((e: React.MouseEvent) => {
      if (readOnly || tool !== 'none' || e.button !== 0 || dragKeyHeldRef.current || handModeRef.current) return
      if (stageWrapRef.current?.contains(e.target as Node)) return
      const p = clientToImage(e.clientX, e.clientY)
      const add = e.shiftKey || e.metaKey || e.ctrlKey
      setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, add })
    }, [readOnly, tool, clientToImage])

    // While a selection box is open it follows the pointer anywhere in the
    // window and closes on release, wherever that happens.
    const marqueeOn = marquee !== null
    useEffect(() => {
      if (!marqueeOn) return
      const onMove = (e: MouseEvent) => {
        if (!(e.buttons & 1)) return
        const p = clientToImage(e.clientX, e.clientY)
        setMarquee(m => (m ? { ...m, x1: p.x, y1: p.y } : m))
      }
      const onUp = (e: MouseEvent) => {
        if (e.button !== 0) return
        handleMouseUp()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }, [marqueeOn, clientToImage, handleMouseUp])

    // Bake a Konva node's transient transform (drag offset + resize scale)
    // back into the persisted DrawObject geometry, then zero the node so the
    // next render — driven purely by the data — reproduces the same result
    // without double-applying. Without this, drag/resize of non-Text shapes
    // lived only on the node and was lost when the canvas re-rendered or the
    // annotations were re-serialized.
    // Write dragged / transformed nodes back into their objects, in one
    // commit (one undo step), however many moved together (a group of
    // selected shapes, 2026-11-23).
    const bakeNodesIntoObjects = useCallback((entries: { id: string; node: Konva.Node }[]) => {
      if (entries.length === 0) return
      userEditedRef.current = true
      const plans = new Map(entries.map(({ id, node }) => {
        // node.x()/y() is the node's full position. For shapes rendered
        // WITHOUT an x/y prop (pen, arrow: points are absolute and the node
        // sits at the origin) it's the drag offset; for shapes WITH an x/y
        // prop (rect, ellipse, text, sticker, the blur placeholder) it's the
        // new absolute position.
        const obj = objectsRef.current.find(o => o.id === id)
        const isOriginAnchored = isFreehand(obj?.type) || obj?.type === 'arrow'
        return [id, { node, nx: node.x(), ny: node.y(), sx: node.scaleX(), sy: node.scaleY(), isOriginAnchored }] as const
      }))
      commitObjects(prev => prev.map(o => {
        const p = plans.get(o.id)
        if (!p) return o
        const { nx, ny, sx, sy } = p
        if (isFreehand(o.type) || o.type === 'arrow') {
          const pts = o.points ?? []
          return { ...o, points: pts.map((v, i) => i % 2 === 0 ? nx + v * sx : ny + v * sy) }
        }
        if (o.type === 'blur') {
          // Rendered from its top-left with a positive size (see renderObj);
          // a flip during a resize turns the scale negative: keep the box
          // normalised.
          const w = Math.abs(o.width ?? 0) * sx, h = Math.abs(o.height ?? 0) * sy
          return { ...o, x: w < 0 ? nx + w : nx, y: h < 0 ? ny + h : ny, width: Math.abs(w), height: Math.abs(h) }
        }
        if (o.type === 'rect' || o.type === 'sticker') {
          return { ...o, x: nx, y: ny, width: (o.width ?? 0) * sx, height: (o.height ?? 0) * sy }
        }
        if (o.type === 'ellipse') {
          return { ...o, x: nx, y: ny, radiusX: (o.radiusX ?? 0) * sx, radiusY: (o.radiusY ?? 0) * sy }
        }
        if (o.type === 'text') return { ...o, x: nx, y: ny }
        return o
      }))
      // Reset the node transforms: the committed data encodes them. Scale
      // always (no scale prop resets it); origin-anchored nodes also back
      // to the origin, or the offset would apply twice.
      plans.forEach(({ node, isOriginAnchored }) => {
        node.scale({ x: 1, y: 1 })
        if (isOriginAnchored) node.position({ x: 0, y: 0 })
      })
    }, [commitObjects])
    const bakeNodeIntoObject = useCallback((id: string, node: Konva.Node) => bakeNodesIntoObjects([{ id, node }]), [bakeNodesIntoObjects])
    // A drag or transform of a selected group ends with one event per node
    // (transform) or one for the node held (drag): bake the whole group once.
    const groupBakedRef = useRef(false)
    const bakeSelection = useCallback(() => {
      if (groupBakedRef.current) return
      groupBakedRef.current = true
      setTimeout(() => { groupBakedRef.current = false }, 0)
      const stage = stageRef.current
      if (!stage) return
      bakeNodesIntoObjects(selectedIdsRef.current
        .map(id => ({ id, node: stage.findOne('#' + id) }))
        .filter((e): e is { id: string; node: Konva.Node } => !!e.node))
    }, [bakeNodesIntoObjects])

    // ── Per-object shape renderer ─────────────────────────────────────────────
    const selectable = tool === 'none'
    // The grab band round a line (2026-11-23): the line as drawn on screen
    // plus 4px (2px each side), at least 8px (6px tried), so the pointer and a press
    // react only just before the line (it was stroke + 8px, at least 14px,
    // fixed on screen: the move pointer showed ~6px early, and at high zoom
    // the band was thinner than the line). In stage units.
    const hitWidth = (sw: number) => Math.max(sw * (scale / baseScale) + 4, 8) / scale
    const renderObj = (obj: DrawObject, isPreview = false) => {
      if (isPreview && isTrivialShape(obj)) return null
      const key = isPreview ? 'preview' : obj.id
      // Only Cursor drags shapes (2026-11-23; they were draggable in every
      // tool, a press on one never drew): drawing tools draw over them.
      // Holding Space turns Cursor into a pan tool: shapes ignore presses.
      const manipulable = !isPreview && selectable && !dragKeyHeld

      // A click selects the shape; ⌘-click (Ctrl on Windows) adds it to the
      // selection or takes it out (2026-11-23).
      const pick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
        if (!selectable || dragKeyHeldRef.current) return
        const ev = e.evt as MouseEvent
        if (ev.metaKey || ev.ctrlKey) {
          setSelectedIds(prev => prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id])
        } else {
          // A plain click (Konva fires none after a drag, so dragging a
          // group isn't one) selects just this shape, as in Finder.
          setSelectedId(obj.id)
        }
      }
      const inGroup = () => selectedIdsRef.current.length > 1 && selectedIdsRef.current.includes(obj.id)
      const commonInteractive = !isPreview && {
        onClick: pick,
        onTap: pick,
        onMouseEnter: () => setHoverId(obj.id),
        onMouseLeave: () => setHoverId(prev => (prev === obj.id ? null : prev)),
        // A real drag is not a click → the pending press must not select /
        // edit on release.
        onDragStart: () => { pendingPressRef.current = null },
        // Selecting on release (not mid-drag) keeps the drag itself free of
        // React work; the toolbar / tool then follow the moved shape.
        // A selected group moves and resizes together: bake them all.
        onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
          if (inGroup()) { bakeSelection(); return }
          bakeNodeIntoObject(obj.id, e.target)
          setSelectedId(obj.id)
        },
        onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
          if (inGroup()) { bakeSelection(); return }
          bakeNodeIntoObject(obj.id, e.target)
        },
      }

      if (isFreehand(obj.type)) {
        const hl = obj.type === 'highlighter'
        return (
          <Line
            key={key}
            id={obj.id}
            points={obj.points ?? []}
            stroke={obj.color}
            opacity={hl ? HIGHLIGHTER_OPACITY : 1}
            // Strokes are part of the image (2026-11-23): width in image
            // units (strokeWidth / baseScale), scaled with the stage, so
            // zooming shrinks and grows them with the picture. strokeWidth
            // reads as screen px at 100% (actual size), which is also what
            // the export draws. (They were fixed screen px at every zoom,
            // so at 10% lines ten times too thick merged into a blob.)
            strokeWidth={obj.strokeWidth * (hl ? HIGHLIGHTER_WIDTH : 1) / baseScale}
            hitStrokeWidth={hitWidth(obj.strokeWidth * (hl ? HIGHLIGHTER_WIDTH : 1))}
            tension={0.5}
            lineCap="round"
            lineJoin="round"
            globalCompositeOperation="source-over"
            draggable={manipulable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'rect') {
        return (
          <Rect
            key={key}
            id={obj.id}
            x={obj.x}
            y={obj.y}
            width={obj.width}
            height={obj.height}
            fill="transparent"
            // fill="transparent" still leaves the interior in Konva's hit
            // canvas, so clicking the empty middle of the rectangle would
            // grab it. fillEnabled:false drops the interior off the hit
            // canvas — what the user sees on screen (just the outline) is
            // what they can click. hitStrokeWidth makes the outline
            // forgiving without bringing the interior back.
            fillEnabled={false}
            stroke={obj.color}
            strokeWidth={obj.strokeWidth / baseScale}
            hitStrokeWidth={hitWidth(obj.strokeWidth)}
            draggable={manipulable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'blur') {
        const bx = obj.x ?? 0, by = obj.y ?? 0
        const bw = obj.width ?? 0, bh = obj.height ?? 0
        const radius = blurRadiusFromStrokeWidth(obj.strokeWidth)
        // Top-left and a positive size (a box dragged up or left has a
        // negative width / height); the bake writes it back that way.
        const left = Math.min(bx, bx + bw), top = Math.min(by, by + bh)
        const w = Math.abs(bw), h = Math.abs(bh)
        // Video: the placeholder frosted rect (video blur is a v1.5 feature).
        if (background.kind !== 'image' || !bgImage || w <= 0 || h <= 0) {
          return (
            <Rect
              key={key}
              id={obj.id}
              x={left} y={top} width={w} height={h}
              fill="rgba(128,128,128,0.35)"
              stroke="rgba(255,255,255,0.4)"
              dash={[4, 4]}
              draggable={manipulable}
              {...commonInteractive}
            />
          )
        }
        // One box shape (2026-11-23; it was a group clipped to the box round
        // a blurred copy of the whole image, which nothing could click and
        // whose frame was the whole image). Hit and frame are its rectangle
        // (width / height; fill only feeds the hit canvas).
        //
        // Drawing (2026-11-23): it blurs what is already on the canvas under
        // its box (the image, then the blurs drawn before it, since blurs
        // come first in the layer) and paints that back into the box, so
        // overlapping blurs add up instead of the top one replacing the
        // others with its own blurred copy of the plain image. Read from the
        // canvas being drawn (the screen, or an export's own canvas), in
        // device pixels: the radius is in image px, scaled by the layer's
        // transform. Works at any place and size, so also mid-drag / resize.
        return (
          <Shape
            key={key}
            id={obj.id}
            x={left} y={top} width={w} height={h}
            fill="#000"
            sceneFunc={(ctx, shape) => {
              const c = (ctx as unknown as { _context: CanvasRenderingContext2D })._context
              const m = c.getTransform()
              const dw = shape.width() * m.a, dh = shape.height() * m.d
              const x0 = m.e + Math.min(0, dw), y0 = m.f + Math.min(0, dh)
              const aw = Math.abs(dw), ah = Math.abs(dh)
              if (aw < 1 || ah < 1) return
              // Device px per image px (the shape's own resize scale aside).
              const unit = Math.abs(m.a / (shape.scaleX() || 1))
              const r = radius * unit
              // Sample a margin round the box so its edges blur with what's
              // beside them, not with emptiness.
              const pad = Math.ceil(r * 3)
              const sx = Math.max(0, Math.floor(x0 - pad)), sy = Math.max(0, Math.floor(y0 - pad))
              const ex = Math.min(c.canvas.width, Math.ceil(x0 + aw + pad)), ey = Math.min(c.canvas.height, Math.ceil(y0 + ah + pad))
              if (ex <= sx || ey <= sy) return
              c.save()
              c.setTransform(1, 0, 0, 1, 0, 0)
              c.beginPath()
              c.rect(x0, y0, aw, ah)
              c.clip()
              c.filter = `blur(${r}px)`
              c.drawImage(c.canvas, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy)
              c.restore()
            }}
            hitFunc={(ctx, shape) => {
              ctx.beginPath()
              ctx.rect(0, 0, shape.width(), shape.height())
              ctx.closePath()
              ctx.fillStrokeShape(shape)
            }}
            draggable={manipulable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'ellipse') {
        return (
          <Ellipse
            key={key}
            id={obj.id}
            x={obj.x}
            y={obj.y}
            radiusX={obj.radiusX ?? 0}
            radiusY={obj.radiusY ?? 0}
            stroke={obj.color}
            strokeWidth={obj.strokeWidth / baseScale}
            hitStrokeWidth={hitWidth(obj.strokeWidth)}
            fill="transparent"
            // See the rect above — outline-only hit testing matches the
            // visible outline-only fill.
            fillEnabled={false}
            draggable={manipulable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'arrow') {
        return (
          <Arrow
            key={key}
            id={obj.id}
            points={obj.points ?? []}
            stroke={obj.color}
            strokeWidth={obj.strokeWidth / baseScale}
            hitStrokeWidth={hitWidth(obj.strokeWidth)}
            fill={obj.color}
            // Arrow head size is in image-pixel units, so it shrinks
            // visually as the stage scales. Counter-scale by 1/scale to
            // keep the head consistent across image sizes.
            pointerLength={Math.max(8, obj.strokeWidth * 3) / baseScale}
            pointerWidth={Math.max(8, obj.strokeWidth * 3) / baseScale}
            draggable={manipulable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'text') {
        return (
          <Text
            key={key}
            id={obj.id}
            x={obj.x}
            y={obj.y}
            text={obj.text ?? ''}
            fontSize={obj.strokeWidth * 6 + 12}
            fontFamily="Manrope, sans-serif"
            fontStyle="bold"
            fill={obj.color}
            // Hidden while its content is being re-edited — the textarea
            // stands in for it at the same spot.
            visible={textInput?.editingId !== obj.id}
            draggable={manipulable && textInput?.editingId !== obj.id}
            {...commonInteractive}
            onDblClick={() => {
              if (isPreview || readOnly || (tool !== 'none' && tool !== 'text')) return
              // The DOM dblclick (if the browser agrees it was one — Konva
              // only checks timing, the browser also checks movement) fires in
              // this same task; the timeout clears a flag nobody consumed.
              suppressDblClickZoomResetRef.current = true
              setTimeout(() => { suppressDblClickZoomResetRef.current = false }, 0)
              beginTextEdit(obj)
            }}
            onDblTap={() => {
              if (isPreview || readOnly || (tool !== 'none' && tool !== 'text')) return
              beginTextEdit(obj)
            }}
          />
        )
      }
      if (obj.type === 'sticker') {
        // Previews never apply to stickers (they're placed via addObjects, not
        // dragged out), so commonInteractive is always the real handler set.
        return (
          <StickerImage
            key={key}
            obj={obj}
            selectable={manipulable}
            interactive={commonInteractive || {}}
            onLoaded={bumpStickerTick}
          />
        )
      }
      return null
    }

    // ── Text box metrics ──────────────────────────────────────────────────────
    // The textarea mirrors the Konva <Text> it stands for (same font, weight,
    // size scaled to the stage, same color) so typing/editing happens in
    // place; the box is shifted up-left by its padding + 1px border so the
    // glyphs land where the shape renders.
    // More room left and right than above and below (2026-11-24).
    const TEXT_BOX_PAD_X = 6
    const TEXT_BOX_PAD_Y = 4
    const textEntryObj = textInput?.editingId ? objects.find(o => o.id === textInput.editingId) : undefined
    const textEntryFontPx = ((textEntryObj?.strokeWidth ?? strokeWidth) * 6 + 12) * scale
    const textEntryColor = textEntryObj?.color ?? color

    // ── Highlight (History › Edits, 2026-11-23) ─────────────────────────────
    // The hovered step's shape, outlined: its box in layer (image) units,
    // re-measured when the shapes, the zoom or the target change.
    const [highlightBox, setHighlightBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
    useEffect(() => {
      const stage = stageRef.current
      const node = highlightId && stage ? stage.findOne('#' + highlightId) : null
      const layer = node?.getLayer() ?? null
      if (!node || !layer || !highlightId) { setHighlightBox(null); return }
      setHighlightBox(boxOf(highlightId, node, layer))
    }, [highlightId, objects, scale])

    // ── Cursor ────────────────────────────────────────────────────────────────
    // Hovering a shape in a drawing/text tool shows the move cursor (drag
    // moves it, click selects it) — not while a stroke is in progress. Looked
    // up in `objects` so a deleted shape can't leave a stale cursor behind.
    // Cursor over a shape shows the move pointer (2026-11-23): only Cursor
    // moves shapes, so drawing tools keep their crosshair over them.
    const hoverObj = hoverId && !isDrawing && tool === 'none' ? objects.find(o => o.id === hoverId) : undefined

    // `live`: tell the window when it has to take the clicks (see the prop).
    const interactive = !!hoverId || deleteHover || selectedIds.length > 0 || !!textInput || marquee !== null || isDrawing
    const onInteractiveRef = useRef(onInteractiveChange)
    onInteractiveRef.current = onInteractiveChange
    useEffect(() => {
      if (live) onInteractiveRef.current?.(interactive)
    }, [live, interactive])
    const typing = !!textInput
    const onActivityRef = useRef(onActivityChange)
    onActivityRef.current = onActivityChange
    useEffect(() => {
      onActivityRef.current?.({ drawing: isDrawing, typing })
    }, [isDrawing, typing])
    const cursor = isPanningState ? 'grabbing'
      : dragKeyHeld ? 'grab'
      : readOnly ? 'default'
      // The delete X is a control: the arrow, whatever the tool (2026-11-23;
      // a drawing tool's crosshair showed over it).
      : deleteHover ? 'default'
      : hoverObj ? 'move'
      : handMode ? 'grab'
      : isFreehand(tool) ? 'crosshair'
      : tool === 'text' ? 'text'
      // Cursor on empty canvas: the arrow (a drag draws a selection box);
      // Space turns it into the hand (above).
      : tool === 'none' ? 'default'
      : 'crosshair'

    // ── Background Konva node (image or video) ───────────────────────────────
    const bgElement = background.kind === 'image'
      ? bgImage
      : background.element

    return (
      <div
        ref={containerRef}
        className="w-full h-full relative overflow-hidden"
        style={{ cursor: isPanningState ? 'grabbing' : dragKeyHeld || handMode ? 'grab' : undefined }}
        onMouseDown={handleAreaMouseDown}
      >
        {/* The background frame, behind the image: the padding
            around it at the current zoom, moving with the pan. */}
        {frame && frameBox && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              ...frameBox,
              background: frame.css,
              pointerEvents: 'none',
            }}
          />
        )}
        <div ref={stageWrapRef} style={{
          position: 'absolute',
          left: stageLeft,
          top:  stageTop,
          width: stageWidth,
          height: stageHeight,
          // The Background frame's shadow on screen, at the zoom
          // (2026-11-25); drop-shadow follows the image's alpha like the
          // export's canvas shadow.
          ...(frameOn && frame?.shadow
            ? { filter: `drop-shadow(0 ${frame.shadow.offsetY * scale}px ${frame.shadow.blur * scale}px rgba(0,0,0,${frame.shadow.alpha}))` }
            : {}),
        }}>
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            scaleX={scale}
            scaleY={scale}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{ cursor }}
          >
            <Layer ref={layerRef}>
              {bgElement && (
                <KonvaImage
                  id="__bg__"
                  image={bgElement as any}
                  width={naturalW}
                  height={naturalH}
                  listening={false}
                />
              )}
              {/* Every shape in its order (2026-11-23): a blur blurs what is
                  under it, so one moved above a shape (Layers tab) blurs that
                  shape too. New blurs start at the bottom (see the commit),
                  so by default they still sit under the drawings. A blur
                  being drawn shows there too; other shapes on top. Hidden
                  shapes aren't drawn at all. */}
              {currentObj?.type === 'blur' && renderObj(currentObj, true)}
              {objects.filter(o => !o.hidden).map(obj => renderObj(obj))}
              {currentObj && currentObj.type !== 'blur' && renderObj(currentObj, true)}
              {/* The highlight: the selection frame's box exactly (2026-11-23;
                  it was 4px bigger with a 2px line and round corners): a 1px
                  accent line on the shape's box and a faint accent wash,
                  never clickable. */}
              {highlightBox && (
                <Group id="__highlight__" listening={false}>
                  <Rect
                    x={highlightBox.x}
                    y={highlightBox.y}
                    width={highlightBox.width}
                    height={highlightBox.height}
                    fill={role.accent}
                    opacity={0.12}
                  />
                  <Rect
                    x={highlightBox.x}
                    y={highlightBox.y}
                    width={highlightBox.width}
                    height={highlightBox.height}
                    stroke={role.accent}
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                  />
                </Group>
              )}
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                // Stickers resize from the corners with locked aspect ratio so
                // the artwork never distorts; other shapes keep free resize.
                keepRatio={objects.some(o => selectedIds.includes(o.id) && o.type === 'sticker')}
                enabledAnchors={
                  objects.some(o => selectedIds.includes(o.id) && o.type === 'sticker')
                    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                    : undefined
                }
                borderStroke={role.accent}
                anchorStroke={role.accent}
                anchorFill={role.elevated}
                anchorSize={8}
              />
              {/* Click-to-delete handle, just outside the Transformer's
                  top-right anchor. Styled like a framed button (2026-11-23):
                  a 16px trash icon in a 32px circle on elevated with a 1px
                  line-strong edge inside
                  it (line was lost against the image; line-strong is what
                  the cards' hover buttons use over media),
                  its edge 7px off the corner handle (the callout gap),
                  the icon red at rest (danger-text, Jasper 2026-11-23; grey
                  first), 1px lines as our icons draw; under the pointer the
                  fill steps to elevated-hover and the icon to
                  danger-text-hover. No shadow. */}
              {deleteHandle && selectedIds.length > 0 && (
                // Counter-scale the handle so it stays the same size on
                // screen no matter how the stage was scaled to fit the
                // image. The offset from the shape's corner uses 1/scale
                // too — without that, the gap would compress as the image
                // was scaled down.
                <Group
                  id="__delete_handle__"
                  ref={deleteHandleRef}
                  x={deleteHandle.x + DELETE_OFFSET / scale}
                  y={deleteHandle.y - DELETE_OFFSET / scale}
                  scaleX={1 / scale}
                  scaleY={1 / scale}
                  onClick={(e) => {
                    e.cancelBubble = true
                    // Clicking the X removes it before Konva fires mouseLeave:
                    // drop the hover here, or the next handle starts hovered.
                    setDeleteHover(false)
                    userEditedRef.current = true
                    const ids = new Set(selectedIdsRef.current)
                    commitObjects(prev => prev.filter(o => !ids.has(o.id)))
                    setSelectedIds([])
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true
                    setDeleteHover(false)
                    userEditedRef.current = true
                    const ids = new Set(selectedIdsRef.current)
                    commitObjects(prev => prev.filter(o => !ids.has(o.id)))
                    setSelectedIds([])
                  }}
                  // The arrow pointer, as on every control (macOS cursor rules).
                  onMouseEnter={() => setDeleteHover(true)}
                  onMouseLeave={() => setDeleteHover(false)}
                >
                  {/* Hit area 4px wider than the drawn circle, invisible: a
                      cursor touches things only at its hotspot (the
                      crosshair's centre), while its drawn arms reach further,
                      so the X switched to the arrow only after the cross
                      already overlapped it (2026-11-23). Still 3px clear of
                      the corner resize handle. */}
                  <Circle radius={DELETE_R + DELETE_HIT_PAD} fill="transparent" />
                  <Circle radius={DELETE_R} fill={deleteHover ? role['elevated-hover'] : role.elevated} />
                  <Circle radius={DELETE_R - 0.5} stroke={role['line-strong']} strokeWidth={1} />
                  {/* Lucide's Trash2 (2026-11-23; was an X), 16px like an
                      icon button's, 1px lines like the Icon component's. */}
                  <Path
                    data={TRASH_PATH}
                    x={-DELETE_ICON / 2}
                    y={-DELETE_ICON / 2}
                    scaleX={DELETE_ICON / 24}
                    scaleY={DELETE_ICON / 24}
                    stroke={deleteHover ? role['danger-text-hover'] : role['danger-text']}
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    fillEnabled={false}
                    lineCap="round"
                    lineJoin="round"
                    listening={false}
                  />
                </Group>
              )}
            </Layer>
          </Stage>

          {/* Text-entry overlay. Rendered INSIDE the stage wrapper (the
              centered + panned absolute div) so screenX/screenY — which come
              from stage.getPointerPosition() and are stage-content-relative —
              map straight to the input's position. Placing it in the outer
              container instead would shift it by the centering offset and pan,
              landing the input away from where the user clicked. */}
          {textInput && (
            <div
              className="absolute z-10"
              style={{ left: textInput.screenX - TEXT_BOX_PAD_X - 1, top: textInput.screenY - TEXT_BOX_PAD_Y - 1 }}
              onMouseDown={e => e.stopPropagation()}
            >
              <textarea
                ref={textInputRef}
                value={textValue}
                rows={textValue.split('\n').length}
                onChange={e => setTextValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    // Shift+Enter inserts a line break (Konva <Text> renders
                    // '\n' natively); bare Enter commits. Never commit while an
                    // IME composition is in flight — Enter there only confirms
                    // the candidate (Vietnamese Telex/Unikey, CJK input).
                    if (e.shiftKey || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    commitText(textInput, textValue)
                    setTextInput(null)
                    setTextValue('')
                  } else if (e.key === 'Escape') {
                    setTextInput(null)
                    setTextValue('')
                  }
                }}
                onBlur={e => {
                  // Opening another entry (click elsewhere with the Text tool,
                  // double-click another text) already committed this one.
                  if (skipBlurCommitRef.current) return
                  // Focus moving to the toolbar's color / stroke controls is a
                  // style edit of this text (it is the selection, so the change
                  // lands on it live), not the end of typing: keep the entry
                  // open and take focus back once the control has its click.
                  const to = e.relatedTarget as HTMLElement | null
                  if (to?.closest?.('[data-style-controls]')) {
                    requestAnimationFrame(() => textInputRef.current?.focus())
                    return
                  }
                  const entry = textInput
                  setTimeout(() => {
                    // Still the open entry? Enter/Escape may have closed it, or
                    // a newer one replaced it, in the meantime.
                    if (!entry || textEntryRef.current !== entry) return
                    commitText(entry, textValueRef.current)
                    setTextInput(null)
                    setTextValue('')
                  }, 150)
                }}
                // whiteSpace: pre — no soft-wrapping, so the box mirrors the
                // Konva <Text> (which has no width and never wraps); the only
                // line breaks are the ones the user typed. fieldSizing: content
                // grows the box with the text in both axes (Chromium 123+).
                // lineHeight 1 matches Konva's default line height.
                // Drawn like a selected shape's Transformer frame (no fill,
                // 1px solid accent, square corners) so typing looks like the
                // committed text, selected, with a caret (2026-11-24).
                // text-entry-font: Manrope with tighter ascent / descent so
                // the caret isn't taller than the line (index.css).
                className="block bg-transparent border border-accent outline-none resize-none overflow-hidden text-entry-font"
                style={{
                  fontWeight: 700,
                  fontSize: textEntryFontPx,
                  lineHeight: 1,
                  color: textEntryColor,
                  padding: `${TEXT_BOX_PAD_Y}px ${TEXT_BOX_PAD_X}px`,
                  whiteSpace: 'pre',
                  fieldSizing: 'content',
                }}
              />
              {/* No placeholder: the caret in the empty box is the hint
                  (2026-11-24; a "Type…" span until then). */}
            </div>
          )}
        </div>
        {/* The selection box (Cursor's drag): a 1px accent line and a faint
            accent wash, as the Dashboard's. Drawn over the whole area, not in
            the stage, so it isn't clipped to the image (2026-11-24). */}
        {marquee && (
          <div
            className="absolute z-20 rounded-sm border border-accent bg-accent/15 pointer-events-none"
            style={{
              left: (containerSize.w - stageWidth) / 2 + panOffset.x + Math.min(marquee.x0, marquee.x1) * scale,
              top: (containerSize.h - stageHeight) / 2 + panOffset.y + Math.min(marquee.y0, marquee.y1) * scale,
              width: Math.abs(marquee.x1 - marquee.x0) * scale,
              height: Math.abs(marquee.y1 - marquee.y0) * scale,
            }}
          />
        )}
      </div>
    )
  },
)

export default AnnotationCanvas
