import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import useImage from 'use-image'
import type Konva from 'konva'
import { useHistory } from '../../hooks/useHistory'
import type { Tool } from './tools'

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
}

interface Props {
  background: CanvasBackground
  tool: Tool
  color: string
  strokeWidth: number
  /** Optional: if provided, hitting Enter/clicking an action button writes the
   *  composite PNG here. Video callers should prefer the `toDataURL` ref method. */
  onExport?: (dataUrl: string) => void
  exportTrigger?: number
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void
  onZoomChange?: (zoom: number) => void
  /** Disable pointer-driven drawing (used by video mode while the video is
   *  actively playing — lets users watch without accidental strokes). */
  readOnly?: boolean
  /** Seed the annotation layer on mount with previously persisted shapes.
   *  Each shape is replayed as a separate commit, so native Undo walks back
   *  through them one at a time — same UX as if the user had just drawn
   *  them. Only read at mount; later changes are ignored so parent
   *  re-renders don't clobber in-progress edits. */
  initialObjects?: DrawObject[]
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
    { background, tool, color, strokeWidth, onExport, exportTrigger = 0, onHistoryChange, onZoomChange, readOnly = false, initialObjects },
    ref,
  ) {
    // ── Background ────────────────────────────────────────────────────────────
    const imageDataUrl = background.kind === 'image' ? background.dataUrl : ''
    const [bgImage] = useImage(imageDataUrl)
    // Blur tool re-uses the stroke-width slider as a blur-intensity control.
    // We cache one pre-blurred canvas per radius so dragging the slider only
    // costs a single CSS-filter pass per new value, not one per mouse move.
    const blurCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
    const [blurCacheVersion, setBlurCacheVersion] = useState(0)
    void blurCacheVersion  // referenced by Konva render reads — forces redraw on cache growth

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
    const [currentObj, setCurrentObj] = useState<DrawObject | null>(null)
    const drawStart = useRef({ x: 0, y: 0 })
    const [selectedId, setSelectedId] = useState<string | null>(null)
    // Position of the per-shape delete handle (the red X) in layer
    // coordinates. Tracked separately from selectedId so the X follows the
    // shape live during drag/transform without going through the React
    // commit cycle on every mousemove.
    const [deleteHandle, setDeleteHandle] = useState<{ x: number; y: number } | null>(null)
    const [textInput, setTextInput] = useState<{
      x: number; y: number; screenX: number; screenY: number
    } | null>(null)
    const textInputRef = useRef<HTMLInputElement>(null)
    const [textValue, setTextValue] = useState('')
    const trRef = useRef<Konva.Transformer>(null)
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

    // ── Zoom ──────────────────────────────────────────────────────────────────
    const [userZoom, setUserZoom] = useState(1)
    const clampZoom = (z: number) => Math.max(0.1, Math.min(z, 5))
    const zoomIn  = useCallback(() => setUserZoom(z => clampZoom(z + 0.1)), [])
    const zoomOut = useCallback(() => setUserZoom(z => clampZoom(z - 0.1)), [])
    const zoomReset = useCallback(() => { setUserZoom(1); setPanOffset({ x: 0, y: 0 }) }, [])
    // Latest userZoom for handlers in long-lived effects (wheel, mousedown).
    const userZoomRef = useRef(1)
    useEffect(() => { userZoomRef.current = userZoom }, [userZoom])

    // ── Pan (right-click drag, Space+left-click drag, two-finger touchpad swipe) ──
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
    const panOffsetRef = useRef(panOffset)
    useEffect(() => { panOffsetRef.current = panOffset }, [panOffset])
    const [isPanningState, setIsPanningState] = useState(false)
    const isPanning = useRef(false)
    const panStart  = useRef({ x: 0, y: 0 })
    // Space-bar held → cursor flips to grab and left-click starts pan (Figma
    // convention). Ref so the mousedown handler sees the latest value without
    // re-binding listeners on every keypress.
    const [spaceHeld, setSpaceHeld] = useState(false)
    const spaceHeldRef = useRef(false)
    useEffect(() => { spaceHeldRef.current = spaceHeld }, [spaceHeld])

    // ── History ───────────────────────────────────────────────────────────────
    const {
      state: objects,
      set: commitObjects,
      undo,
      redo,
      canUndo,
      canRedo,
    } = useHistory<DrawObject[]>([])

    // Rehydrate persisted annotations by replaying each shape as its own
    // commit — Undo then walks back through them one-at-a-time, identical to
    // the session that created them. Guarded by a ref so StrictMode's double
    // effect invocation doesn't double-push the stack.
    const replayedRef = useRef(false)
    useEffect(() => {
      if (replayedRef.current) return
      replayedRef.current = true
      if (!initialObjects || initialObjects.length === 0) return
      for (let i = 0; i < initialObjects.length; i++) {
        commitObjects(initialObjects.slice(0, i + 1))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const objectsRef = useRef(objects)
    useEffect(() => { objectsRef.current = objects }, [objects])

    // Drop cached blurs whenever the source image swaps so stale radii from a
    // previous bitmap don't leak in. The populate effect below refills as
    // soon as render asks for a radius.
    useEffect(() => {
      blurCacheRef.current.clear()
      setBlurCacheVersion(v => v + 1)
    }, [bgImage])

    // Populate the blur cache whenever a new radius is needed — either by an
    // existing blur object on the canvas or by the live tool/slider preview.
    // Each entry is a CSS-blur pass over the source image, so the work is
    // cheap and amortised across re-renders.
    useEffect(() => {
      if (background.kind !== 'image' || !bgImage) return
      const needed = new Set<number>()
      for (const obj of objects) {
        if (obj.type === 'blur') needed.add(blurRadiusFromStrokeWidth(obj.strokeWidth))
      }
      if (tool === 'blur') needed.add(blurRadiusFromStrokeWidth(strokeWidth))
      let added = false
      for (const r of needed) {
        if (blurCacheRef.current.has(r)) continue
        const c = document.createElement('canvas')
        c.width  = bgImage.width
        c.height = bgImage.height
        const ctx = c.getContext('2d')
        if (!ctx) continue
        ctx.filter = `blur(${r}px)`
        ctx.drawImage(bgImage, 0, 0)
        blurCacheRef.current.set(r, c)
        added = true
      }
      if (added) setBlurCacheVersion(v => v + 1)
    }, [bgImage, background.kind, objects, tool, strokeWidth])

    // Notify parent on every commit. Depending on `canUndo`/`canRedo` alone
    // would miss changes where those booleans don't toggle — e.g. after the
    // first shape lands `canUndo` stays `true`, so every subsequent shape
    // would be invisible to the parent and the Editor's debounced save would
    // never be scheduled.
    useEffect(() => {
      onHistoryChange?.(canUndo, canRedo)
    }, [objects, canUndo, canRedo, onHistoryChange])

    // ── Container sizing ──────────────────────────────────────────────────────
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
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
        const t = setTimeout(() => textInputRef.current?.focus(), 50)
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

    // Base scale: fit content into container.
    const isTallImage = naturalH / naturalW > 2
    const baseScale = containerSize.w > 0 && containerSize.h > 0
      ? isTallImage
        ? Math.min((containerSize.w - 32) / naturalW, 1)
        : Math.min((containerSize.w - 32) / naturalW, (containerSize.h - 32) / naturalH, 1)
      : 1

    const scale = baseScale * userZoom

    useEffect(() => { onZoomChange?.(userZoom) }, [userZoom, onZoomChange])

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
      if (!el) return
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
      if (!el) return
      const onDblClick = () => {
        setUserZoom(1)
        setPanOffset({ x: 0, y: 0 })
      }
      el.addEventListener('dblclick', onDblClick)
      return () => el.removeEventListener('dblclick', onDblClick)
    }, [])

    // Mouse-drag to pan. Triggers:
    //   • Right-click drag (legacy fallback)
    //   • Space-bar held + left-click drag (Figma convention)
    // Uses capture phase so Konva doesn't also start drawing on the same gesture.
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const onMouseDown = (e: MouseEvent) => {
        const rightClick    = e.button === 2
        const spaceLeftDrag = e.button === 0 && spaceHeldRef.current
        if (!rightClick && !spaceLeftDrag) return
        e.preventDefault()
        e.stopPropagation()
        isPanning.current = true
        setIsPanningState(true)
        panStart.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
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
      const onMouseUp = () => {
        if (!isPanning.current) return
        isPanning.current = false
        setIsPanningState(false)
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
    }, [panOffset, naturalW, naturalH, baseScale])

    // Re-clamp panOffset whenever the stage or container resizes (zoom button,
    // window resize, image swap). Without this, zooming out leaves the stage
    // partially off-screen because the pan bounds shrink with stage size.
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const stageW = naturalW * baseScale * userZoom
      const stageH = naturalH * baseScale * userZoom
      setPanOffset(prev => clampPan(prev, el.clientWidth, el.clientHeight, stageW, stageH))
    }, [userZoom, baseScale, naturalW, naturalH, containerSize])

    // Space-bar tracking. Window-level so user can hold space anywhere on the
    // canvas. Skipped while typing in an input so text annotation isn't broken.
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== 'Space' || e.repeat) return
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        setSpaceHeld(true)
      }
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code !== 'Space') return
        setSpaceHeld(false)
      }
      const onBlur = () => setSpaceHeld(false)
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup',   onKeyUp)
      window.addEventListener('blur',    onBlur)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup',   onKeyUp)
        window.removeEventListener('blur',    onBlur)
      }
    }, [])

    const stageWidth  = Math.round(naturalW * scale)
    const stageHeight = Math.round(naturalH * scale)

    // ── Composite snapshot (current background + annotations at natural res) ──
    const toDataURL = useCallback((): string => {
      const stage = stageRef.current
      if (!stage) return ''
      return stage.toDataURL({ mimeType: 'image/png', pixelRatio: 1 / scale })
    }, [scale])

    const toCanvas = useCallback((): HTMLCanvasElement | null => {
      const stage = stageRef.current
      if (!stage) return null
      return stage.toCanvas({ pixelRatio: 1 / scale })
    }, [scale])

    const toAnnotationsCanvas = useCallback((): HTMLCanvasElement | null => {
      const stage = stageRef.current
      if (!stage) return null
      // Temporarily hide the background node so the export contains only the
      // annotation shapes. Transformer stays hidden via `nodes([])` when idle,
      // so it rarely shows up in snapshots — but hide it too to be safe.
      const bg = stage.findOne('#__bg__')
      const tr = trRef.current
      const prevBg = bg?.visible() ?? true
      const prevTrNodes = tr?.nodes() ?? []
      bg?.visible(false)
      tr?.nodes([])
      stage.batchDraw()
      const out = stage.toCanvas({ pixelRatio: 1 / scale })
      bg?.visible(prevBg)
      if (tr && prevTrNodes.length > 0) tr.nodes(prevTrNodes)
      stage.batchDraw()
      return out
    }, [scale])

    const getObjects = useCallback((): DrawObject[] => objectsRef.current, [])

    // User-initiated Clear: commit an empty state instead of resetting the
    // history stack. That way the parent's `onHistoryChange` sees `canUndo`
    // flip to `true` (so the Editor's debounced save fires and the sidecar
    // PNG + thumbnail get regenerated from the original image), and the user
    // can undo the clear to recover the shapes if it was accidental.
    const clearViaCommit = useCallback(() => {
      commitObjects([])
    }, [commitObjects])

    // Programmatic append: one history entry covers the whole batch so a
    // single Undo removes them all together (used by auto-blur to inject
    // detected regions as Konva blur shapes).
    const addObjects = useCallback((objs: Omit<DrawObject, 'id'>[]) => {
      if (objs.length === 0) return
      const stamped: DrawObject[] = objs.map(o => ({ ...o, id: uid() }))
      commitObjects([...objectsRef.current, ...stamped])
    }, [commitObjects])

    // Expose imperative handle to parent
    useImperativeHandle(ref, () => ({
      undo, redo, clear: clearViaCommit, canUndo, canRedo,
      zoomIn, zoomOut, zoomReset, zoomLevel: userZoom,
      toDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects,
    }), [undo, redo, clearViaCommit, canUndo, canRedo, zoomIn, zoomOut, zoomReset, userZoom, toDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects])

    // ── Export trigger (legacy path — kept for Editor's workflow buttons) ────
    useEffect(() => {
      if (exportTrigger > 0 && stageRef.current && onExport) {
        onExport(toDataURL())
      }
    }, [exportTrigger, onExport, toDataURL])

    // ── Transformer attachment ────────────────────────────────────────────────
    useEffect(() => {
      const tr = trRef.current
      if (!tr) return
      if (!selectedId) { tr.nodes([]); tr.getLayer()?.batchDraw(); return }
      const stage = stageRef.current
      if (!stage) return
      const node = stage.findOne('#' + selectedId)
      if (node) { tr.nodes([node]); tr.getLayer()?.batchDraw() }
      else tr.nodes([])
    }, [selectedId, objects])

    // Deselect when switching to a drawing tool. The cursor tool ('none')
    // is the only mode where selection is valid.
    useEffect(() => { if (tool !== 'none') setSelectedId(null) }, [tool])

    // Track the top-right corner of the selected shape so the delete handle
    // (small red X next to the Transformer) follows the shape during drag /
    // transform without needing to wait for the next React render.
    useEffect(() => {
      if (!selectedId) { setDeleteHandle(null); return }
      const stage = stageRef.current
      if (!stage) { setDeleteHandle(null); return }
      const node = stage.findOne('#' + selectedId)
      const layer = node?.getLayer() ?? null
      if (!node || !layer) { setDeleteHandle(null); return }
      const update = () => {
        const box = node.getClientRect({ relativeTo: layer as any })
        setDeleteHandle({ x: box.x + box.width, y: box.y })
      }
      update()
      node.on('dragmove.deletehandle transform.deletehandle', update)
      return () => {
        node.off('dragmove.deletehandle transform.deletehandle')
      }
    }, [selectedId, objects])

    // ── Keyboard: Delete / Backspace removes the selected shape ──────────────
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
          e.preventDefault()
          commitObjects(prev => prev.filter(o => o.id !== selectedId))
          setSelectedId(null)
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [selectedId, commitObjects])

    // ── Drawing handlers ──────────────────────────────────────────────────────
    const handleMouseDown = useCallback(
      (e: Konva.KonvaEventObject<MouseEvent>) => {
        if (readOnly || e.evt.button === 2) return
        if (tool === 'none') {
          if (e.target === e.target.getStage()) setSelectedId(null)
          return
        }
        const raw = e.target.getStage()!.getPointerPosition()!
        const pos = { x: raw.x / scale, y: raw.y / scale }
        setIsDrawing(true)
        drawStart.current = pos

        const base: DrawObject = { id: uid(), type: tool, color, strokeWidth }

        if (tool === 'pen') {
          setCurrentObj({ ...base, points: [pos.x, pos.y] })
        } else if (tool === 'rect' || tool === 'blur') {
          setCurrentObj({ ...base, x: pos.x, y: pos.y, width: 0, height: 0 })
        } else if (tool === 'ellipse') {
          setCurrentObj({ ...base, x: pos.x, y: pos.y, radiusX: 0, radiusY: 0 })
        } else if (tool === 'arrow') {
          setCurrentObj({ ...base, points: [pos.x, pos.y, pos.x, pos.y] })
        } else if (tool === 'text') {
          setTextInput({ x: pos.x, y: pos.y, screenX: raw.x, screenY: raw.y })
          setTextValue('')
          setIsDrawing(false)
          return
        }
      },
      [tool, color, strokeWidth, scale, readOnly],
    )

    const handleMouseMove = useCallback(
      (e: Konva.KonvaEventObject<MouseEvent>) => {
        if (!isDrawing || !currentObj) return
        const raw = e.target.getStage()!.getPointerPosition()!
        const pos = { x: raw.x / scale, y: raw.y / scale }

        if (currentObj.type === 'pen') {
          setCurrentObj(prev =>
            prev ? { ...prev, points: [...(prev.points ?? []), pos.x, pos.y] } : null,
          )
        } else if (currentObj.type === 'rect' || currentObj.type === 'blur') {
          const s = drawStart.current
          const nx = Math.min(s.x, pos.x)
          const ny = Math.min(s.y, pos.y)
          const nw = Math.abs(pos.x - s.x)
          const nh = Math.abs(pos.y - s.y)
          setCurrentObj(prev =>
            prev ? { ...prev, x: nx, y: ny, width: nw, height: nh } : null,
          )
        } else if (currentObj.type === 'ellipse') {
          const s = drawStart.current
          setCurrentObj(prev =>
            prev
              ? {
                  ...prev,
                  radiusX: Math.abs(pos.x - s.x) / 2,
                  radiusY: Math.abs(pos.y - s.y) / 2,
                  x: (s.x + pos.x) / 2,
                  y: (s.y + pos.y) / 2,
                }
              : null,
          )
        } else if (currentObj.type === 'arrow') {
          const pts = currentObj.points ?? []
          setCurrentObj(prev =>
            prev ? { ...prev, points: [pts[0], pts[1], pos.x, pos.y] } : null,
          )
        }
      },
      [isDrawing, currentObj, scale],
    )

    const MIN_SHAPE_SIZE = 4
    const isTrivialShape = (obj: DrawObject) => {
      if (obj.type === 'pen') return (obj.points?.length ?? 0) < 4
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
      if (!isDrawing || !currentObj) return
      setIsDrawing(false)
      if (isTrivialShape(currentObj)) { setCurrentObj(null); return }
      commitObjects(prev => [...prev, currentObj])
      setCurrentObj(null)
    }, [isDrawing, currentObj, commitObjects])

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

    // ── Per-object shape renderer ─────────────────────────────────────────────
    const selectable = tool === 'none'
    const renderObj = (obj: DrawObject, isPreview = false) => {
      if (isPreview && isTrivialShape(obj)) return null
      const key = isPreview ? 'preview' : obj.id

      const commonInteractive = !isPreview && {
        onClick: () => { if (selectable) setSelectedId(obj.id) },
        onTap:   () => { if (selectable) setSelectedId(obj.id) },
      }

      if (obj.type === 'pen') {
        return (
          <Line
            key={key}
            id={obj.id}
            points={obj.points ?? []}
            stroke={obj.color}
            strokeWidth={obj.strokeWidth}
            // Don't let the stage's fit-to-container scale shrink/expand
            // strokes — strokeWidth should read as constant screen pixels
            // across images of different natural sizes. Export still
            // produces a stroke proportional to the image because
            // toDataURL passes pixelRatio=1/scale.
            strokeScaleEnabled={false}
            hitStrokeWidth={Math.max(obj.strokeWidth + 8, 14) / scale}
            tension={0.5}
            lineCap="round"
            lineJoin="round"
            globalCompositeOperation="source-over"
            draggable={selectable}
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
            strokeWidth={obj.strokeWidth}
            strokeScaleEnabled={false}
            hitStrokeWidth={Math.max(obj.strokeWidth + 8, 14) / scale}
            draggable={selectable}
            {...commonInteractive}
          />
        )
      }
      if (obj.type === 'blur') {
        const bx = obj.x ?? 0, by = obj.y ?? 0
        const bw = obj.width ?? 0, bh = obj.height ?? 0
        const radius = blurRadiusFromStrokeWidth(obj.strokeWidth)
        const blurredBg = blurCacheRef.current.get(radius) ?? null
        // Video background has no pre-blurred sample — fall through to the
        // placeholder frosted rect. (Video blur is a v1.5 feature.)
        if (!blurredBg || bw <= 0 || bh <= 0) {
          return (
            <Rect
              key={key}
              id={obj.id}
              x={bx} y={by} width={bw} height={bh}
              fill="rgba(128,128,128,0.35)"
              stroke="rgba(255,255,255,0.4)"
              dash={[4, 4]}
              draggable={selectable}
              {...commonInteractive}
            />
          )
        }
        return (
          <Group
            key={key}
            id={obj.id}
            clipX={bx} clipY={by} clipWidth={bw} clipHeight={bh}
            draggable={selectable}
            {...commonInteractive}
          >
            <KonvaImage
              image={blurredBg}
              width={naturalW}
              height={naturalH}
              listening={false}
            />
          </Group>
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
            strokeWidth={obj.strokeWidth}
            strokeScaleEnabled={false}
            hitStrokeWidth={Math.max(obj.strokeWidth + 8, 14) / scale}
            fill="transparent"
            // See the rect above — outline-only hit testing matches the
            // visible outline-only fill.
            fillEnabled={false}
            draggable={selectable}
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
            strokeWidth={obj.strokeWidth}
            strokeScaleEnabled={false}
            hitStrokeWidth={Math.max(obj.strokeWidth + 8, 14) / scale}
            fill={obj.color}
            // Arrow head size is in image-pixel units, so it shrinks
            // visually as the stage scales. Counter-scale by 1/scale to
            // keep the head consistent across image sizes.
            pointerLength={Math.max(8, obj.strokeWidth * 3) / scale}
            pointerWidth={Math.max(8, obj.strokeWidth * 3) / scale}
            draggable={selectable}
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
            draggable={!isPreview}
            {...commonInteractive}
            onDragEnd={e => {
              if (!isPreview) {
                const node = e.target
                commitObjects(prev =>
                  prev.map(o =>
                    o.id === obj.id ? { ...o, x: node.x(), y: node.y() } : o,
                  ),
                )
              }
            }}
          />
        )
      }
      return null
    }

    const commitText = useCallback(
      (pos: { x: number; y: number }, value: string) => {
        if (!value.trim()) return
        commitObjects(prev => [
          ...prev,
          { id: uid(), type: 'text' as Tool, x: pos.x, y: pos.y, text: value, color, strokeWidth },
        ])
      },
      [commitObjects, color, strokeWidth],
    )

    // ── Cursor ────────────────────────────────────────────────────────────────
    const cursor = isPanningState ? 'grabbing'
      : spaceHeld ? 'grab'
      : readOnly ? 'default'
      : tool === 'pen' ? 'crosshair'
      : tool === 'text' ? 'text'
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
        style={{ cursor: isPanningState ? 'grabbing' : spaceHeld ? 'grab' : undefined }}
      >
        <div style={{
          position: 'absolute',
          left: (containerSize.w - stageWidth) / 2 + panOffset.x,
          top:  (containerSize.h - stageHeight) / 2 + panOffset.y,
          width: stageWidth,
          height: stageHeight,
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
              {objects.map(obj => renderObj(obj))}
              {currentObj && renderObj(currentObj, true)}
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                borderStroke="#a78bfa"
                anchorStroke="#a78bfa"
                anchorFill="#ffffff"
                anchorSize={8}
              />
              {/* Click-to-delete handle. Mirrors the X on the live
                  recording-time annotation overlay so both selection
                  surfaces feel the same. Sits just outside the
                  Transformer's top-right anchor to avoid overlapping it. */}
              {deleteHandle && selectedId && (
                // Counter-scale the handle so it stays the same size on
                // screen no matter how the stage was scaled to fit the
                // image. The offset from the shape's corner uses 1/scale
                // too — without that, the gap would compress as the image
                // was scaled down.
                <Group
                  x={deleteHandle.x + 12 / scale}
                  y={deleteHandle.y - 12 / scale}
                  scaleX={1 / scale}
                  scaleY={1 / scale}
                  onClick={(e) => {
                    e.cancelBubble = true
                    commitObjects(prev => prev.filter(o => o.id !== selectedId))
                    setSelectedId(null)
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true
                    commitObjects(prev => prev.filter(o => o.id !== selectedId))
                    setSelectedId(null)
                  }}
                  onMouseEnter={() => { document.body.style.cursor = 'pointer' }}
                  onMouseLeave={() => { document.body.style.cursor = '' }}
                >
                  <Circle radius={11} fill="#ef4444" stroke="#ffffff" strokeWidth={2} shadowColor="#000" shadowBlur={6} shadowOpacity={0.4} />
                  <Line points={[-4, -4, 4, 4]} stroke="#ffffff" strokeWidth={2} lineCap="round" />
                  <Line points={[-4, 4, 4, -4]} stroke="#ffffff" strokeWidth={2} lineCap="round" />
                </Group>
              )}
            </Layer>
          </Stage>
        </div>

        {textInput && (
          <div
            className="absolute z-10"
            style={{ left: textInput.screenX, top: textInput.screenY }}
            onMouseDown={e => e.stopPropagation()}
          >
            <input
              ref={textInputRef}
              value={textValue}
              onChange={e => setTextValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  commitText(textInput, textValue)
                  setTextInput(null)
                  setTextValue('')
                } else if (e.key === 'Escape') {
                  setTextInput(null)
                  setTextValue('')
                }
              }}
              onBlur={() => {
                setTimeout(() => {
                  setTextInput(prev => {
                    if (!prev) return null
                    const val = textInputRef.current?.value ?? ''
                    commitText(prev, val)
                    return null
                  })
                  setTextValue('')
                }, 150)
              }}
              className="bg-slate-900/90 border border-primary/50 text-white text-sm px-3 py-2 rounded-xl outline-none min-w-[160px] backdrop-blur-sm shadow-lg"
              style={{ fontFamily: 'Manrope, sans-serif' }}
              placeholder="Type text, Enter to confirm..."
            />
          </div>
        )}
      </div>
    )
  },
)

export default AnnotationCanvas
