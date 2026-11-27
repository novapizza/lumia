import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AnnotationCanvas, { type CanvasHandle, type CanvasBackground, type SelectionInfo } from '../../components/AnnotationCanvas/Canvas'
import type { Tool } from '../../components/AnnotationCanvas/tools'
import { matchesBinding, resolveKeymap, type Keymap } from '../../lib/editor-keys'
import { DEFAULT_ANNOTATION_COLOR } from '../../../shared/annotation'

const isMac = navigator.platform.toLowerCase().includes('mac')

/** Tools the recording offers: the image editor's, without Sticker and
 *  Blur (2026-11-24, Jasper; Blur has no screen pixels to blur here). */
export const LIVE_TOOLS: Tool[] = ['none', 'pen', 'highlighter', 'arrow', 'rect', 'ellipse', 'text']

/** The recording's live drawing layer (2026-11-24): the image editor's own
 *  canvas (AnnotationCanvas, `live`), see-through over the recorded screen,
 *  so drawing works exactly as in the editor: Shift snapping, ⌘-click and
 *  box selection, the delete button, the text box, ⌘Z / ⇧⌘Z, the editor
 *  keys. Tool, colour and stroke live in main (the recording toolbar picks
 *  them, `annotation:state`); the canvas reports its selection and Undo /
 *  Redo back (`annotation:edit-state`).
 *
 *  Cursor lets clicks through to the recorded app except where the layer
 *  needs them (a shape under the pointer, a selection, the text box). A
 *  drawing tool, or a selection, takes keyboard focus for the editor keys;
 *  Cursor with nothing selected gives it back to the recorded app. */
export default function AnnotationOverlay() {
  const canvasRef = useRef<CanvasHandle>(null)
  const [tool, setTool] = useState<Tool>('none')
  const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOR)
  const [strokeWidth, setStrokeWidth] = useState(4)
  const [keymap, setKeymap] = useState<Keymap | undefined>(undefined)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const history = useRef({ canUndo: false, canRedo: false })

  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
  }, [])

  // The display in device pixels: 100% is actual size, as in the editor.
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const background = useMemo<CanvasBackground>(() => {
    const dpr = window.devicePixelRatio || 1
    return { kind: 'video', element: null, naturalWidth: Math.round(size.w * dpr), naturalHeight: Math.round(size.h * dpr) }
  }, [size])

  // Tool, colour and stroke from main; Undo / Redo / Clear from the toolbar.
  useEffect(() => {
    const apply = (s: { tool: string; color: string; strokeWidth: number } | null | undefined) => {
      if (!s) return
      setTool((LIVE_TOOLS as string[]).includes(s.tool) ? s.tool as Tool : 'none')
      setColor(s.color)
      setStrokeWidth(s.strokeWidth)
    }
    window.electronAPI?.annotationGetState?.().then(apply).catch(() => {})
    window.electronAPI?.onAnnotationState?.(apply)
    window.electronAPI?.onAnnotationClear?.(() => canvasRef.current?.clear())
    window.electronAPI?.onAnnotationUndo?.(() => canvasRef.current?.undo())
    window.electronAPI?.onAnnotationRedo?.(() => canvasRef.current?.redo())
    window.electronAPI?.getSettings?.().then(s => setKeymap(resolveKeymap('image', s?.editorKeys?.image, isMac))).catch(() => {})
    return () => {
      window.electronAPI?.removeAllListeners?.('annotation:state')
      window.electronAPI?.removeAllListeners?.('annotation:clear')
      window.electronAPI?.removeAllListeners?.('annotation:undo')
      window.electronAPI?.removeAllListeners?.('annotation:redo')
    }
  }, [])

  // What the toolbar shows: the selected shape's kind (its options) and
  // whether Undo / Redo have steps.
  const selectionRef = useRef<SelectionInfo | null>(null)
  const report = useCallback(() => {
    const sel = selectionRef.current
    window.electronAPI?.annotationReportEditState?.({
      selectedKind: sel ? sel.type : null,
      canUndo: history.current.canUndo,
      canRedo: history.current.canRedo,
    })
  }, [])
  const onHistoryChange = useCallback((canUndo: boolean, canRedo: boolean) => {
    history.current = { canUndo, canRedo }
    report()
  }, [report])
  // A selected shape's style shows in the toolbar (not saved as a pick); the
  // canvas then restyles the selection when a pick comes back as props.
  const onSelectionChange = useCallback((sel: SelectionInfo | null) => {
    selectionRef.current = sel
    setSelection(sel)
    report()
    if (sel) {
      window.electronAPI?.annotationSetColor?.(sel.color, true)
      window.electronAPI?.annotationSetStroke?.(sel.strokeWidth, true)
    }
  }, [report])

  // Cursor: clicks through to the recorded app unless the layer needs them.
  const onInteractiveChange = useCallback((interactive: boolean) => {
    window.electronAPI?.annotationOverlaySetInteractive?.(interactive)
  }, [])

  // Keyboard focus while drawing or with a selection; back to the app
  // otherwise.
  const wantFocus = tool !== 'none' || selection !== null
  useEffect(() => {
    window.electronAPI?.annotationOverlayWantFocus?.(wantFocus)
  }, [wantFocus])

  // The editor's tool keys (Settings › Hotkeys), as Editor.tsx handles them.
  useEffect(() => {
    if (!keymap) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const id = Object.keys(keymap).find(k => k.startsWith('tool:') && matchesBinding(keymap[k], e, isMac))
      const t = id?.slice(5) as Tool | undefined
      if (t && LIVE_TOOLS.includes(t)) window.electronAPI?.annotationSetTool?.(t)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keymap])

  return (
    <div className="fixed inset-0">
      <AnnotationCanvas
        ref={canvasRef}
        live
        background={background}
        tool={tool}
        color={color}
        strokeWidth={strokeWidth}
        keymap={keymap}
        onHistoryChange={onHistoryChange}
        onSelectionChange={onSelectionChange}
        onInteractiveChange={onInteractiveChange}
      />
    </div>
  )
}
