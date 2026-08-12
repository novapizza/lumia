import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
  /** Sticker only: relative R2 path (e.g. "cat-stickers/01-love.png"). Resolved
   *  to a same-origin data URL via the main process so the canvas can be
   *  exported without cross-origin tainting. */
  src?: string
}

// ── Sticker image resolution ────────────────────────────────────────────────
// Sticker bytes are fetched + disk-cached in the main process and returned as
// data URLs (loading remote URLs straight into Konva would taint the canvas and
// break toDataURL on Save/Copy/Upload). Memoise the per-path promise so the same
// sticker placed twice, or replayed from history, only crosses IPC once.
const stickerUrlCache = new Map<string, Promise<string>>()
function resolveStickerUrl(relPath: string): Promise<string> {
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
  addSticker: (opts: { src: string; aspect: number }) => void
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
  /** `userEdited` is true once a genuine user edit has landed (false during
   *  the mount-time replay of `initialObjects`) so the parent can tell real
   *  edits from rehydration without comparing object counts. */
  onHistoryChange?: (canUndo: boolean, canRedo: boolean, userEdited?: boolean) => void
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

// Each cached blur is a full-resolution canvas (~33 MB at 4K). Dragging the
// stroke slider would otherwise materialise one per radius (~20 steps) and
// never release them. Cap the cache and evict the least-recently-used radius
// so memory stays bounded; in-use radii (committed blur shapes) are protected
// from eviction in the populate effect below.
const BLUR_CACHE_MAX = 3

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
    const [selectedId, setSelectedId] = useState<string | null>(null)
    // Position of the per-shape delete handle (the red X) in layer
    // coordinates. Tracked separately from selectedId so the X follows the
    // shape live during drag/transform without going through the React
    // commit cycle on every mousemove.
    const [deleteHandle, setDeleteHandle] = useState<{ x: number; y: number } | null>(null)
    // Konva node ref for the delete handle so drag/transform can reposition it
    // imperatively without a React re-render of the whole canvas per mousemove.
    const deleteHandleRef = useRef<Konva.Group>(null)
    const [textInput, setTextInput] = useState<{
      x: number; y: number; screenX: number; screenY: number
    } | null>(null)
    const textInputRef = useRef<HTMLInputElement>(null)
    const [textValue, setTextValue] = useState('')
    const trRef = useRef<Konva.Transformer>(null)
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

    // ── Zoom ──────────────────────────────────────────────────────────────────
    const [userZoom, setUserZoom] = useState(1)
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
    // Latest tool for the long-lived pan mousedown handler (cursor-tool
    // left-drag pan) without re-binding listeners on every tool switch.
    const toolRef = useRef(tool)
    useEffect(() => { toolRef.current = tool }, [tool])

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
    // Flipped true the first time a genuine user edit lands (draw, drag,
    // transform, text, delete, clear, programmatic add, undo/redo). Stays false
    // during the mount-time replay of `initialObjects` so the Editor can tell a
    // real edit apart from rehydration without relying on object-count diffs
    // (which miss same-length edits like dragging a single Text).
    const userEditedRef = useRef(false)
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
      const cache = blurCacheRef.current
      let added = false
      for (const r of needed) {
        if (cache.has(r)) {
          // Touch: re-insert so Map iteration order tracks recency (LRU tail).
          const existing = cache.get(r)!
          cache.delete(r)
          cache.set(r, existing)
          continue
        }
        const c = document.createElement('canvas')
        c.width  = bgImage.width
        c.height = bgImage.height
        const ctx = c.getContext('2d')
        if (!ctx) continue
        ctx.filter = `blur(${r}px)`
        ctx.drawImage(bgImage, 0, 0)
        cache.set(r, c)
        added = true
      }
      // Evict least-recently-used radii once over the cap, but never drop a
      // radius that's currently in use by a committed blur shape or the live
      // preview — those are guaranteed to be re-created on the next render
      // anyway, so evicting them just thrashes.
      if (cache.size > BLUR_CACHE_MAX) {
        for (const r of cache.keys()) {
          if (cache.size <= BLUR_CACHE_MAX) break
          if (needed.has(r)) continue
          cache.delete(r)
        }
      }
      if (added) setBlurCacheVersion(v => v + 1)
    }, [bgImage, background.kind, objects, tool, strokeWidth])

    // Notify parent on every commit. Depending on `canUndo`/`canRedo` alone
    // would miss changes where those booleans don't toggle — e.g. after the
    // first shape lands `canUndo` stays `true`, so every subsequent shape
    // would be invisible to the parent and the Editor's debounced save would
    // never be scheduled.
    useEffect(() => {
      onHistoryChange?.(canUndo, canRedo, userEditedRef.current)
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

    // Max zoom: bounded by Chromium's hard canvas caps rather than a fixed
    // percentage. The Stage's canvas spans the whole zoomed image (not just
    // the visible viewport), and Chromium silently blanks a canvas past
    // 65,535 px on a side or ~268M px² of backing-buffer area (CSS px ×
    // devicePixelRatio, since Konva renders buffers at dpr× the CSS size).
    // Stay under both with headroom; floor at 1 so 100% is always reachable.
    const maxZoom = useMemo(() => {
      const dpr = window.devicePixelRatio || 1
      const maxSide = 60_000 / dpr
      const maxArea = 240_000_000 / (dpr * dpr)
      const w = naturalW * baseScale
      const h = naturalH * baseScale
      return Math.max(1, Math.min(maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h))))
    }, [naturalW, naturalH, baseScale])
    useEffect(() => {
      maxZoomRef.current = maxZoom
      // Pull the zoom back down if the ceiling dropped below it (e.g. the
      // window grew → baseScale grew → the stage hits the canvas cap sooner).
      setUserZoom(z => Math.min(z, maxZoom))
    }, [maxZoom])

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
    //   • Cursor tool + left-click drag on empty canvas (clicks on shapes
    //     still select/drag them)
    // Uses capture phase so Konva doesn't also start drawing on the same gesture.
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const onMouseDown = (e: MouseEvent) => {
        const rightClick    = e.button === 2
        const spaceLeftDrag = e.button === 0 && spaceHeldRef.current
        // Cursor tool: left-drag pans when no shape is under the pointer.
        // Konva's hit canvas decides, so this agrees exactly with what a
        // click would select (bg image is listening=false → counts as empty;
        // transformer anchors and the delete handle count as shapes).
        let cursorLeftDrag = false
        if (!rightClick && !spaceLeftDrag && e.button === 0 && toolRef.current === 'none') {
          const stage = stageRef.current
          if (stage) {
            stage.setPointersPositions(e)
            const pos = stage.getPointerPosition()
            cursorLeftDrag = !pos || !stage.getIntersection(pos)
          } else {
            cursorLeftDrag = true
          }
        }
        if (!rightClick && !spaceLeftDrag && !cursorLeftDrag) return
        e.preventDefault()
        // Cursor-tool pan lets the event reach Konva so the stage's own
        // mousedown still deselects on empty-canvas clicks; the other
        // triggers must not (space+left would start a draw).
        if (!cursorLeftDrag) e.stopPropagation()
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
    }, [naturalW, naturalH, baseScale])

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

    // Prepare the stage for a natural-resolution export and return a restore
    // fn. Two concerns handled here:
    //   1. Selection chrome — detach the purple Transformer frame and hide the
    //      red X delete handle so neither bakes into the PNG. (Previously only
    //      toAnnotationsCanvas did this, so Copy/Save/Upload captured the UI.)
    //   2. Zoom independence — strokeScaleEnabled=false renders strokes in
    //      screen px, so at zoom != 1 exporting with pixelRatio=1/scale would
    //      leak the current zoom into stroke / arrowhead thickness. Temporarily
    //      reset the stage scale to baseScale (zoom = 1) so exports always
    //      rasterise strokes at the fit-to-container scale. Geometry is
    //      unaffected because pixelRatio compensates 1:1 (see below).
    const prepareExport = useCallback((stage: Konva.Stage): (() => void) => {
      const tr = trRef.current
      const handle = stage.findOne('#__delete_handle__')
      const prevTrNodes = tr?.nodes() ?? []
      const prevHandle = handle?.visible() ?? true
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
      const out = stage.toDataURL({ mimeType: 'image/png', ...exportRect() })
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

    // Place a sticker centred on the image, sized to ~30% of the image's
    // natural width with its own aspect preserved, then select it so the user
    // can immediately drag/resize. Lives here (not the Editor) because the
    // natural dimensions and selection state are local to the canvas.
    const addSticker = useCallback((opts: { src: string; aspect: number }) => {
      const aspect = opts.aspect > 0 ? opts.aspect : 1   // naturalWidth / naturalHeight
      // Fit box = 80% of the image in each axis. `maxFitW` is the widest the
      // sticker can be while honouring its aspect AND staying inside that box —
      // capping width alone let tall stickers (or small/short images) spill
      // past the top/bottom. Default to ~15% of the image width, then clamp to
      // [floor, maxFitW]; the 48px floor is itself capped by the fit so it
      // can't overflow a tiny image.
      const fitW = naturalW * 0.8
      const fitH = naturalH * 0.8
      const maxFitW = Math.min(fitW, fitH * aspect)
      const floorW = Math.min(48, maxFitW)
      const w = Math.round(Math.min(maxFitW, Math.max(floorW, naturalW * 0.15)))
      const h = Math.round(w / aspect)
      const x = Math.round((naturalW - w) / 2)
      const y = Math.round((naturalH - h) / 2)
      const id = uid()
      userEditedRef.current = true
      commitObjects([
        ...objectsRef.current,
        { id, type: 'sticker', src: opts.src, x, y, width: w, height: h, color: '#000000', strokeWidth: 0 },
      ])
      setSelectedId(id)
    }, [commitObjects, naturalW, naturalH])

    // Undo/redo are user actions too — flip the edit latch so the parent's
    // debounced save fires for them (otherwise undoing the only edit back to
    // the baseline length would look like rehydration and skip the save).
    const undoUser = useCallback(() => { userEditedRef.current = true; undo() }, [undo])
    const redoUser = useCallback(() => { userEditedRef.current = true; redo() }, [redo])

    // Expose imperative handle to parent
    useImperativeHandle(ref, () => ({
      undo: undoUser, redo: redoUser, clear: clearViaCommit, canUndo, canRedo,
      zoomIn, zoomOut, zoomReset, zoomLevel: userZoom,
      toDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects, addSticker,
    }), [undoUser, redoUser, clearViaCommit, canUndo, canRedo, zoomIn, zoomOut, zoomReset, userZoom, toDataURL, toCanvas, toAnnotationsCanvas, getObjects, addObjects, addSticker])

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
    }, [selectedId, objects, stickerLoadTick])

    // Deselect when switching to a drawing tool. The cursor tool ('none')
    // is the only mode where selection is valid.
    useEffect(() => { if (tool !== 'none') setSelectedId(null) }, [tool])

    // Track the top-right corner of the selected shape so the delete handle
    // (small red X next to the Transformer) follows the shape during drag /
    // transform without needing to wait for the next React render. The initial
    // placement seeds React state (so the handle mounts); subsequent live
    // updates during drag/transform move the Konva node directly via its ref,
    // avoiding a full canvas re-render on every mousemove.
    useEffect(() => {
      if (!selectedId) { setDeleteHandle(null); return }
      const stage = stageRef.current
      if (!stage) { setDeleteHandle(null); return }
      const node = stage.findOne('#' + selectedId)
      const layer = node?.getLayer() ?? null
      if (!node || !layer) { setDeleteHandle(null); return }
      const compute = () => {
        const box = node.getClientRect({ relativeTo: layer as any })
        return { x: box.x + box.width, y: box.y }
      }
      setDeleteHandle(compute())
      const update = () => {
        const p = compute()
        const handle = deleteHandleRef.current
        if (handle) {
          // The 12/scale offset mirrors the React-rendered placement below
          // (x={deleteHandle.x + 12/scale}) so the imperative move lands the
          // handle in exactly the same spot, just without a React re-render.
          handle.position({ x: p.x + 12 / scale, y: p.y - 12 / scale })
          handle.getLayer()?.batchDraw()
        } else {
          setDeleteHandle(p)
        }
      }
      node.on('dragmove.deletehandle transform.deletehandle', update)
      return () => {
        node.off('dragmove.deletehandle transform.deletehandle')
      }
    }, [selectedId, objects, baseScale, scale])

    // ── Keyboard: Delete / Backspace removes the selected shape ──────────────
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
          e.preventDefault()
          userEditedRef.current = true
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
        isDrawingRef.current = true
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
          isDrawingRef.current = false
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

    // Bake a Konva node's transient transform (drag offset + resize scale)
    // back into the persisted DrawObject geometry, then zero the node so the
    // next render — driven purely by the data — reproduces the same result
    // without double-applying. Without this, drag/resize of non-Text shapes
    // lived only on the node and was lost when the canvas re-rendered or the
    // annotations were re-serialized.
    const bakeNodeIntoObject = useCallback((id: string, node: Konva.Node) => {
      // node.x()/y() is the node's full position. For shapes rendered WITHOUT
      // an x/y prop (pen, arrow — points are absolute and the node sits at the
      // origin) this is purely the drag offset. For shapes rendered WITH an
      // x/y prop (rect, blur, ellipse, text) node.x() already encodes the new
      // absolute position, so it replaces the stored x/y directly.
      const nx = node.x()
      const ny = node.y()
      const sx = node.scaleX()
      const sy = node.scaleY()
      userEditedRef.current = true
      const obj = objectsRef.current.find(o => o.id === id)
      // Origin-anchored shapes render their geometry in group-local coords with
      // the node at (0,0), so node.x()/y() is a pure drag offset that must be
      // ADDED to the stored geometry: pen/arrow (absolute points) and the blur
      // GROUP (it carries clipX/clipY locally). x/y-prop shapes (rect, ellipse,
      // text, and the blur PLACEHOLDER Rect) render `x={obj.x}` so node.x()
      // already IS the new absolute x. The blur object can render either way,
      // so disambiguate by node class — only the Group is origin-anchored.
      const isBlurGroup = obj?.type === 'blur' && node.getClassName() === 'Group'
      const isOriginAnchored = obj?.type === 'pen' || obj?.type === 'arrow' || isBlurGroup
      commitObjects(prev => prev.map(o => {
        if (o.id !== id) return o
        if (o.type === 'pen' || o.type === 'arrow') {
          const pts = o.points ?? []
          const next = pts.map((p, i) => i % 2 === 0 ? nx + p * sx : ny + p * sy)
          return { ...o, points: next }
        }
        if (o.type === 'blur') {
          // Group: clipX/clipY are local, so add the drag offset. Placeholder
          // Rect: node.x() is already absolute.
          return {
            ...o,
            x: isBlurGroup ? nx + (o.x ?? 0) * sx : nx,
            y: isBlurGroup ? ny + (o.y ?? 0) * sy : ny,
            width: (o.width ?? 0) * sx,
            height: (o.height ?? 0) * sy,
          }
        }
        if (o.type === 'rect') {
          return {
            ...o,
            x: nx,
            y: ny,
            width: (o.width ?? 0) * sx,
            height: (o.height ?? 0) * sy,
          }
        }
        if (o.type === 'ellipse') {
          return {
            ...o,
            x: nx,
            y: ny,
            radiusX: (o.radiusX ?? 0) * sx,
            radiusY: (o.radiusY ?? 0) * sy,
          }
        }
        if (o.type === 'text') {
          return { ...o, x: nx, y: ny }
        }
        if (o.type === 'sticker') {
          // Same as rect: x/y are absolute, scale bakes into width/height.
          return {
            ...o,
            x: nx,
            y: ny,
            width: (o.width ?? 0) * sx,
            height: (o.height ?? 0) * sy,
          }
        }
        return o
      }))
      // Reset the node transform — the committed data already encodes it. Scale
      // must always be cleared (Rect/Ellipse/etc. don't pass a scale prop, so
      // react-konva won't reset it for us). Origin-anchored nodes (pen, arrow,
      // blur) have no x/y prop either, so reset their position to the origin or
      // the baked-in offset would be double-applied on the next render. The
      // blur's inner image (counter-offset during drag) also returns to local
      // (0,0) on the data-driven re-render.
      node.scale({ x: 1, y: 1 })
      if (isOriginAnchored) {
        node.position({ x: 0, y: 0 })
        const inner = (node as Konva.Group).findOne?.('Image')
        inner?.position({ x: 0, y: 0 })
      }
    }, [commitObjects])

    // ── Per-object shape renderer ─────────────────────────────────────────────
    const selectable = tool === 'none'
    const renderObj = (obj: DrawObject, isPreview = false) => {
      if (isPreview && isTrivialShape(obj)) return null
      const key = isPreview ? 'preview' : obj.id

      const commonInteractive = !isPreview && {
        onClick: () => { if (selectable) setSelectedId(obj.id) },
        onTap:   () => { if (selectable) setSelectedId(obj.id) },
        onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => bakeNodeIntoObject(obj.id, e.target),
        onTransformEnd: (e: Konva.KonvaEventObject<Event>) => bakeNodeIntoObject(obj.id, e.target),
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
            // The inner pre-blurred image sits at group-local (0,0) and is the
            // size of the whole background. As the group moves, counter-offset
            // the inner image by (-x, -y) so it stays pinned to the layer
            // origin — that way the clip window reveals the blurred pixels
            // NOW under the region, not those from the drag-start location.
            // bakeNodeIntoObject (onDragEnd, via commonInteractive) then writes
            // the new clip coords and the re-render restores the inner image
            // to local (0,0).
            onDragMove={e => {
              const g = e.target as Konva.Group
              const inner = g.findOne('Image')
              inner?.position({ x: -g.x(), y: -g.y() })
            }}
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
            selectable={selectable}
            interactive={commonInteractive || {}}
            onLoaded={bumpStickerTick}
          />
        )
      }
      return null
    }

    const commitText = useCallback(
      (pos: { x: number; y: number }, value: string) => {
        if (!value.trim()) return
        userEditedRef.current = true
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
                // Stickers resize from the corners with locked aspect ratio so
                // the artwork never distorts; other shapes keep free resize.
                keepRatio={objects.find(o => o.id === selectedId)?.type === 'sticker'}
                enabledAnchors={
                  objects.find(o => o.id === selectedId)?.type === 'sticker'
                    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                    : undefined
                }
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
                  id="__delete_handle__"
                  ref={deleteHandleRef}
                  x={deleteHandle.x + 12 / scale}
                  y={deleteHandle.y - 12 / scale}
                  scaleX={1 / scale}
                  scaleY={1 / scale}
                  onClick={(e) => {
                    e.cancelBubble = true
                    // Reset the cursor here — clicking the X destroys the group
                    // before Konva fires mouseLeave, so 'pointer' would stick.
                    document.body.style.cursor = ''
                    userEditedRef.current = true
                    commitObjects(prev => prev.filter(o => o.id !== selectedId))
                    setSelectedId(null)
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true
                    document.body.style.cursor = ''
                    userEditedRef.current = true
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

          {/* Text-entry overlay. Rendered INSIDE the stage wrapper (the
              centered + panned absolute div) so screenX/screenY — which come
              from stage.getPointerPosition() and are stage-content-relative —
              map straight to the input's position. Placing it in the outer
              container instead would shift it by the centering offset and pan,
              landing the input away from where the user clicked. */}
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
      </div>
    )
  },
)

export default AnnotationCanvas
