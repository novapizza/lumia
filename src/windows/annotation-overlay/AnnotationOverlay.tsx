import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Line, Arrow, Rect, Ellipse, Group, Circle, Transformer } from 'react-konva'
import type Konva from 'konva'

type Tool = 'none' | 'select' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'highlighter'

interface DrawState {
  tool: Tool
  color: string
  strokeWidth: number
}

interface BaseShape {
  id: string
  tool: Tool
  color: string
  strokeWidth: number
  // Highlighter draws with reduced alpha + larger width — capture the
  // "intended" properties rather than baking the visual tweak into the
  // base width so undo/replay stays consistent.
  highlight?: boolean
}

interface FreeShape extends BaseShape { kind: 'free'; points: number[] }
interface RectShape extends BaseShape { kind: 'rect'; x: number; y: number; w: number; h: number }
interface EllipseShape extends BaseShape { kind: 'ellipse'; x: number; y: number; rx: number; ry: number }
interface ArrowShape extends BaseShape { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }

type Shape = FreeShape | RectShape | EllipseShape | ArrowShape

let shapeIdCounter = 0
const nextId = () => `${Date.now()}-${++shapeIdCounter}`

export default function AnnotationOverlay() {
  const [draw, setDraw] = useState<DrawState>({ tool: 'none', color: '#f87171', strokeWidth: 4 })
  const [shapes, setShapes] = useState<Shape[]>([])
  const drawingRef = useRef<Shape | null>(null)
  const [drawingPreview, setDrawingPreview] = useState<Shape | null>(null)
  const [stageSize, setStageSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)

  // Drop the selection whenever the user switches to a drawing tool
  // (drawing on top of the X handle would be confusing). Selection is
  // valid in both 'select' and 'none' modes — 'none' acts like 'select'
  // for shape clicks while still passing empty-area clicks through to
  // the recorded app underneath.
  useEffect(() => {
    if (draw.tool !== 'select' && draw.tool !== 'none') setSelectedId(null)
  }, [draw.tool])
  useEffect(() => {
    if (selectedId && !shapes.some(s => s.id === selectedId)) setSelectedId(null)
  }, [shapes, selectedId])

  // Attach the Konva Transformer to the currently selected shape's group
  // so the user gets the same resize-frame affordance the post-capture
  // editor surfaces around its selected objects.
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    if (!selectedId) { tr.nodes([]); tr.getLayer()?.batchDraw(); return }
    const node = stage.findOne('#' + selectedId)
    if (node) { tr.nodes([node]); tr.getLayer()?.batchDraw() }
    else tr.nodes([])
  }, [selectedId, shapes])

  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
  }, [])

  // Cursor reflects what kind of click the overlay will register:
  //   none   -> default (overlay is click-through anyway)
  //   select -> arrow, with each shape switching to pointer on hover
  //             via Konva's listener config below
  //   draw   -> crosshair
  useEffect(() => {
    document.body.style.cursor =
      draw.tool === 'none' ? 'default' :
      draw.tool === 'select' ? 'default' :
      'crosshair'
  }, [draw.tool])

  useEffect(() => {
    const onResize = () => setStageSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Pull initial state from main, then listen for live updates.
  useEffect(() => {
    window.electronAPI?.annotationGetState?.().then((s) => {
      if (s) setDraw({ tool: s.tool as Tool, color: s.color, strokeWidth: s.strokeWidth })
    }).catch(() => {})

    window.electronAPI?.onAnnotationState?.((s) => {
      setDraw({ tool: s.tool as Tool, color: s.color, strokeWidth: s.strokeWidth })
    })
    window.electronAPI?.onAnnotationClear?.(() => {
      drawingRef.current = null
      setDrawingPreview(null)
      setShapes([])
    })
    window.electronAPI?.onAnnotationUndo?.(() => {
      setShapes(prev => prev.slice(0, -1))
    })

    return () => {
      window.electronAPI?.removeAllListeners?.('annotation:state')
      window.electronAPI?.removeAllListeners?.('annotation:clear')
      window.electronAPI?.removeAllListeners?.('annotation:undo')
    }
  }, [])

  /** null when the active tool isn't a drawing tool. Caller bails on null. */
  const startShape = (x: number, y: number): Shape | null => {
    if (draw.tool === 'none' || draw.tool === 'select') return null
    const id = nextId()
    const base = { id, tool: draw.tool, color: draw.color, strokeWidth: draw.strokeWidth }
    switch (draw.tool) {
      case 'pen':
        return { ...base, kind: 'free', points: [x, y] }
      case 'highlighter':
        return { ...base, kind: 'free', points: [x, y], highlight: true, strokeWidth: draw.strokeWidth * 4 }
      case 'rect':
        return { ...base, kind: 'rect', x, y, w: 0, h: 0 }
      case 'ellipse':
        return { ...base, kind: 'ellipse', x, y, rx: 0, ry: 0 }
      case 'arrow':
        return { ...base, kind: 'arrow', x1: x, y1: y, x2: x, y2: y }
    }
  }

  const updateShape = (s: Shape, x: number, y: number): Shape => {
    if (s.kind === 'free') return { ...s, points: [...s.points, x, y] }
    if (s.kind === 'rect') return { ...s, w: x - s.x, h: y - s.y }
    if (s.kind === 'ellipse') return { ...s, rx: Math.abs(x - s.x), ry: Math.abs(y - s.y) }
    return { ...s, x2: x, y2: y }
  }

  /** Bake a Konva node's transient transform — drag offset (dx, dy) plus
   *  resize scale (sx, sy) — into a shape's underlying coordinates so the next
   *  React render of the data alone reproduces both the moved AND resized
   *  geometry without relying on the node's transient x/y/scale. The group has
   *  no x/y prop (its children carry absolute coords), so node.x()/y() is a
   *  pure offset and node.scaleX()/Y() multiplies the geometry about the group
   *  origin: absolute = offset + coord * scale. With sx=sy=1 this degenerates
   *  to a plain translate. */
  const bakeShape = (s: Shape, dx: number, dy: number, sx = 1, sy = 1): Shape => {
    if (s.kind === 'free') {
      return { ...s, points: s.points.map((p, i) => i % 2 === 0 ? dx + p * sx : dy + p * sy) }
    }
    if (s.kind === 'rect') return { ...s, x: dx + s.x * sx, y: dy + s.y * sy, w: s.w * sx, h: s.h * sy }
    if (s.kind === 'ellipse') return { ...s, x: dx + s.x * sx, y: dy + s.y * sy, rx: s.rx * sx, ry: s.ry * sy }
    return { ...s, x1: dx + s.x1 * sx, y1: dy + s.y1 * sy, x2: dx + s.x2 * sx, y2: dy + s.y2 * sy }
  }

  const onPointerDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (!pos) return
    if (draw.tool === 'select' || draw.tool === 'none') {
      // Clicking empty stage area dismisses the X handle. Per-shape
      // clicks have their own onClick listener and don't bubble up
      // because Konva stops propagation when a child claims the target.
      // In 'none' mode this fires only when a selection is active —
      // that's the only state where the overlay captures empty-area
      // clicks (see the selection-driven setInteractive effect above).
      if (e.target === stage) setSelectedId(null)
      return
    }
    const s = startShape(pos.x, pos.y)
    if (!s) return
    drawingRef.current = s
    setDrawingPreview(s)
  }

  const onPointerMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!drawingRef.current) return
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (!pos) return
    const next = updateShape(drawingRef.current, pos.x, pos.y)
    drawingRef.current = next
    setDrawingPreview(next)
  }

  const onPointerUp = () => {
    const s = drawingRef.current
    drawingRef.current = null
    setDrawingPreview(null)
    if (!s) return
    // Drop zero-area shapes — happens when the user clicks without dragging
    // for non-pen tools, leaving a degenerate shape that's just visual noise.
    // Stay in the drawing tool in that case so the user can immediately
    // try again instead of being kicked back to the cursor.
    if (s.kind === 'rect' && s.w === 0 && s.h === 0) return
    if (s.kind === 'ellipse' && s.rx === 0 && s.ry === 0) return
    if (s.kind === 'arrow' && s.x1 === s.x2 && s.y1 === s.y2) return
    setShapes(prev => [...prev, s])
    // Auto-switch back to the cursor after a successful draw so the user
    // can interact with the recorded app or pick another tool without an
    // extra click. Mirrors the "one-shot" feel of single-stroke drawing.
    // Pushes through main so the recording toolbar's active-tool indicator
    // and the overlay's click-through state both update via the
    // annotation:state broadcast.
    window.electronAPI?.annotationSetTool?.('none')
  }

  // In tool='none' mode the overlay starts in click-through (so the user
  // can drive the recorded app underneath), but we still want clicking on
  // an existing stroke to select it for delete/drag. Toggle the OS-level
  // ignoreMouseEvents flag from Konva enter/leave so the cursor over a
  // shape captures clicks, while empty area stays click-through.
  // Skipped while a selection is active — that case is governed by the
  // selection effect below, which forces capture on so empty-area clicks
  // can dismiss the selection instead of leaking through to the app.
  const setOverlayInteractive = (interactive: boolean) => {
    if (draw.tool !== 'none') return
    if (selectedId) return
    window.electronAPI?.annotationOverlaySetInteractive?.(interactive)
  }

  // While a shape is selected in 'none' mode, force the overlay into
  // capture so an empty-area click dismisses the selection (handled in
  // onPointerDown below) instead of falling through to the recorded app
  // and leaving the X handle stranded. When selection clears, revert to
  // hover-driven pass-through so the user can interact with the app
  // through empty space again.
  useEffect(() => {
    if (draw.tool !== 'none') return
    window.electronAPI?.annotationOverlaySetInteractive?.(!!selectedId)
  }, [selectedId, draw.tool])

  const renderShape = (s: Shape, key: number | string, isPreview = false) => {
    const isHighlight = s.highlight === true
    const opacity = isHighlight ? 0.35 : 1
    // Shapes are interactive (click to select, drag to move) in either
    // 'select' mode or 'none' mode. 'select' captures the whole overlay
    // unconditionally; 'none' only captures while the cursor is over a
    // shape, with empty area passing clicks through to the recorded app.
    // Preview (the in-flight drawing) is excluded — it has no committed id.
    const selectable = !isPreview && (draw.tool === 'select' || draw.tool === 'none')

    // Visual node — colours and geometry. Konva's hit-testing cascades
    // from the wrapping Group's `listening`, so we don't need to explicitly
    // set listening here. hitStrokeWidth makes thin pen strokes easier to
    // grab when the user is in select mode. fillEnabled:false on Rect /
    // Ellipse drops the interior off the hit canvas so the user can only
    // grab them by their outline — clicking the transparent interior
    // (which has no visible fill anyway) falls through, matching what
    // the user sees on screen.
    const inner = (() => {
      const visual = {
        stroke: s.color,
        strokeWidth: s.strokeWidth,
        opacity,
        hitStrokeWidth: Math.max(s.strokeWidth + 8, 14),
      }
      if (s.kind === 'free') {
        return (
          <Line
            {...visual}
            points={s.points}
            lineCap="round"
            lineJoin="round"
            tension={0.4}
          />
        )
      }
      if (s.kind === 'rect') {
        const x = s.w < 0 ? s.x + s.w : s.x
        const y = s.h < 0 ? s.y + s.h : s.y
        return <Rect {...visual} fillEnabled={false} x={x} y={y} width={Math.abs(s.w)} height={Math.abs(s.h)} />
      }
      if (s.kind === 'ellipse') {
        return <Ellipse {...visual} fillEnabled={false} x={s.x} y={s.y} radiusX={s.rx} radiusY={s.ry} />
      }
      return (
        <Arrow
          {...visual}
          points={[s.x1, s.y1, s.x2, s.y2]}
          fill={s.color}
          pointerLength={Math.max(8, s.strokeWidth * 3)}
          pointerWidth={Math.max(8, s.strokeWidth * 3)}
        />
      )
    })()

    if (isPreview) return <Group key={key} listening={false}>{inner}</Group>

    return (
      <Group
        key={key}
        id={s.id}
        listening={selectable}
        draggable={selectable}
        onClick={(e) => { if (selectable) { e.cancelBubble = true; setSelectedId(s.id) } }}
        onMouseEnter={() => {
          if (!selectable) return
          document.body.style.cursor = 'pointer'
          setOverlayInteractive(true)
        }}
        onMouseLeave={() => {
          if (!selectable) return
          document.body.style.cursor = 'default'
          setOverlayInteractive(false)
        }}
        onDragEnd={(e) => {
          const node = e.target
          const dx = node.x()
          const dy = node.y()
          const sx = node.scaleX()
          const sy = node.scaleY()
          if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return
          // Pass the scale through (rather than assuming 1) so a drag that
          // follows a resize doesn't bake the wrong size.
          setShapes(prev => prev.map(p => p.id === s.id ? bakeShape(p, dx, dy, sx, sy) : p))
          // Reset the Group's transform so the next render (which already bakes
          // offset + scale into the data) doesn't double-apply it.
          node.position({ x: 0, y: 0 })
          node.scale({ x: 1, y: 1 })
        }}
        onTransformEnd={(e) => {
          // Transformer mutates the group's scaleX/scaleY (and may shift its
          // position from a non-origin anchor). Bake both into the shape data
          // and reset the node, otherwise the next onDragEnd would read a
          // position that includes the transform offset and apply it to
          // unscaled coords, making the shape jump.
          const node = e.target
          const dx = node.x()
          const dy = node.y()
          const sx = node.scaleX()
          const sy = node.scaleY()
          setShapes(prev => prev.map(p => p.id === s.id ? bakeShape(p, dx, dy, sx, sy) : p))
          node.position({ x: 0, y: 0 })
          node.scale({ x: 1, y: 1 })
        }}
      >
        {inner}
      </Group>
    )
  }

  // Track the top-right of the selected shape's Konva node so the X
  // delete handle stays glued to the corner during drag / transform —
  // querying the node directly avoids waiting for React state updates.
  const [deleteHandle, setDeleteHandle] = useState<{ x: number; y: number } | null>(null)
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
    return () => { node.off('dragmove.deletehandle transform.deletehandle') }
  }, [selectedId, shapes])

  const selectedShape = selectedId ? shapes.find(s => s.id === selectedId) ?? null : null
  const deleteSelected = () => {
    if (!selectedId) return
    setShapes(prev => prev.filter(s => s.id !== selectedId))
    setSelectedId(null)
  }

  return (
    <Stage
      ref={stageRef}
      width={stageSize.w}
      height={stageSize.h}
      onMouseDown={onPointerDown}
      onMouseMove={onPointerMove}
      onMouseUp={onPointerUp}
      onTouchStart={onPointerDown}
      onTouchMove={onPointerMove}
      onTouchEnd={onPointerUp}
      style={{ position: 'fixed', inset: 0 }}
    >
      <Layer>
        {shapes.map((s, i) => renderShape(s, s.id || i))}
        {drawingPreview && renderShape(drawingPreview, 'preview', true)}
        <Transformer
          ref={trRef}
          rotateEnabled={false}
          borderStroke="#a78bfa"
          anchorStroke="#a78bfa"
          anchorFill="#ffffff"
          anchorSize={8}
        />
        {deleteHandle && selectedShape && (
          <Group
            x={deleteHandle.x + 12}
            y={deleteHandle.y - 12}
            onClick={(e) => {
              e.cancelBubble = true
              // Reset the cursor here — clicking the X destroys the group
              // before Konva fires mouseLeave, so 'pointer' would otherwise
              // stick. (Overlay pass-through reverts via the selection effect
              // once deleteSelected clears selectedId.)
              document.body.style.cursor = 'default'
              deleteSelected()
            }}
            onMouseEnter={() => {
              document.body.style.cursor = 'pointer'
              // X handle floats above-right of the shape — outside the
              // shape's own bounding rect — so cursor leaving the shape
              // would otherwise revert the overlay to pass-through and
              // the X click would land on the app underneath. Keep
              // capture on while the cursor is over the X.
              setOverlayInteractive(true)
            }}
            onMouseLeave={() => {
              document.body.style.cursor = 'default'
              setOverlayInteractive(false)
            }}
          >
            <Circle radius={11} fill="#ef4444" stroke="#ffffff" strokeWidth={2} shadowColor="#000" shadowBlur={6} shadowOpacity={0.4} />
            <Line points={[-4, -4, 4, 4]} stroke="#ffffff" strokeWidth={2} lineCap="round" />
            <Line points={[-4, 4, 4, -4]} stroke="#ffffff" strokeWidth={2} lineCap="round" />
          </Group>
        )}
      </Layer>
    </Stage>
  )
}
