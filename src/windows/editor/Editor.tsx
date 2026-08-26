import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AnnotationCanvas, {
  type CanvasHandle,
  Tool,
} from '../../components/AnnotationCanvas/Canvas'
import AnnotationToolBar from '../../components/AnnotationCanvas/ToolBar'
import { matchToolShortcut } from '../../components/AnnotationCanvas/tools'
import type { WorkflowTemplate, HistoryItem, AnnotationObject } from '../../types'
import type { DrawObject, SelectionInfo } from '../../components/AnnotationCanvas/Canvas'
import StickerPicker, { type PickedSticker } from '../../components/StickerPicker'
import { deriveActions, type ActionBtn } from '../../lib/workflow-actions'
import { useLocalVideoUrl } from '../../hooks/useLocalVideoUrl'

/** Location.state shape accepted by the unified editor. Image mode carries a
 *  dataUrl; video mode carries filePath (+ optional display name). */
type EditorState = {
  kind?: 'image' | 'video'
  dataUrl?: string
  filePath?: string
  name?: string
  source?: string
  historyId?: string
  annotations?: AnnotationObject[]
}

// Tools / colors / shortcuts live in ../../components/AnnotationCanvas/tools.ts —
// the VideoAnnotator shares the same palette, so keeping them here would just
// invite drift.

// MediaRecorder writes WebM progressively and omits the duration cue, so on
// playback `video.duration === Infinity` and the scrubber breaks. Seeking to
// an absurdly large timestamp forces the browser to scan the whole file;
// when it finds the real end a `durationchange` fires with a finite value and
// we rewind to 0. Runs once per <video> instance.
function fixWebmDuration(e: React.SyntheticEvent<HTMLVideoElement>) {
  const v = e.currentTarget
  if (Number.isFinite(v.duration) && v.duration > 0) return
  const onDurChange = () => {
    if (Number.isFinite(v.duration) && v.duration > 0) {
      v.removeEventListener('durationchange', onDurChange)
      v.currentTime = 0
    }
  }
  v.addEventListener('durationchange', onDurChange)
  v.currentTime = 1e101
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function Editor() {
  const location = useLocation()
  const navigate = useNavigate()

  // Unified state — `kind` switches the editor between image and video mode.
  // Callers that navigate here must set `kind` explicitly; default is 'image'
  // so existing screenshot paths keep working without changes.
  const initialState = (location.state ?? {}) as EditorState
  const [kind, setKind] = useState<'image' | 'video'>(initialState.kind ?? (initialState.filePath ? 'video' : 'image'))
  const [imageDataUrl, setImageDataUrl] = useState<string>(initialState.dataUrl ?? '')
  const [videoFilePath, setVideoFilePath] = useState<string>(initialState.filePath ?? '')
  const [videoName, setVideoName]         = useState<string>(initialState.name ?? '')
  const [historyId, setHistoryId]         = useState<string | undefined>(initialState.historyId)
  const [initialAnnotations, setInitialAnnotations] = useState<AnnotationObject[] | undefined>(initialState.annotations)
  const isVideo = kind === 'video'

  const triggerNewCapture = useCallback(() => {
    window.electronAPI?.newCapture()
  }, [])
  const [tool, setTool] = useState<Tool>('none')
  const [color, setColor] = useState('#f87171')
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [exportTrigger, setExportTrigger] = useState(0)
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [activeWorkflowId, setActiveWorkflowId] = useState<string>('')
  const [gdriveConnected, setGdriveConnected] = useState(false)
  const [toast, setToast] = useState<{ message: string; icon: string; type: 'success' | 'error' } | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const pendingAction = useRef<string | null>(null)
  const canvasRef = useRef<CanvasHandle>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [clipboardHistory, setClipboardHistory] = useState<
    {
      id: string
      thumbnailUrl: string
      filePath?: string
      annotatedFilePath?: string
      legacyDataUrl?: string
      name: string
      timestamp: number
      annotations?: AnnotationObject[]
    }[]
  >([])
  const [showClipPanel, setShowClipPanel] = useState(false)
  // Color popover is now handled inside AnnotationToolBar.

  // Video is view-only here — plain HTML5 <video controls> for playback. Save
  // / Copy / Upload R2 operate on the source file directly, not on frames.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoSrc = useLocalVideoUrl(isVideo ? videoFilePath : '')

  // Render the video at its actual encoded size, clamped to fit the editor
  // pane. This avoids the browser stretching a small recording (e.g. a
  // 600×450 region) to fill the canvas area, which makes UI text in the
  // recording look soft. ResizeObserver keeps the clamp accurate across
  // window resizes; videoNaturalSize is reset on every src change.
  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const [videoContainerSize, setVideoContainerSize] = useState<{ w: number; h: number } | null>(null)
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => { setVideoNaturalSize(null) }, [videoSrc])
  useEffect(() => {
    const el = videoContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const e = entries[0]
      if (e) setVideoContainerSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isVideo, videoSrc])
  const videoDisplaySize = useMemo(() => {
    if (!videoNaturalSize || !videoContainerSize) return null
    // Never upscale beyond the encoded resolution — that's the whole point.
    const k = Math.min(
      1,
      videoContainerSize.w / videoNaturalSize.w,
      videoContainerSize.h / videoNaturalSize.h,
    )
    return {
      width: Math.round(videoNaturalSize.w * k),
      height: Math.round(videoNaturalSize.h * k),
    }
  }, [videoNaturalSize, videoContainerSize])
  const onVideoMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    fixWebmDuration(e)
    const v = e.currentTarget
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setVideoNaturalSize({ w: v.videoWidth, h: v.videoHeight })
    }
  }

  const resetForNewImage = useCallback((dataUrl: string) => {
    // No canvasRef.current?.clear() here — the Canvas is keyed on
    // `imageDataUrl` so it remounts (with fresh history) whenever the image
    // actually changes. Calling clear() here would also wipe replay that
    // Canvas just ran for a loaded history item, since Editor's location
    // effect runs AFTER Canvas's mount effects.
    setImageDataUrl(dataUrl)
    setExportTrigger(0)
  }, [])

  const activeTemplate = useMemo(() => {
    const found = templates.find(t => t.id === activeWorkflowId)
    if (found) return found
    return templates.find(t => t.id === 'builtin-r2') ?? templates[0]
  }, [templates, activeWorkflowId])
  const actionBtns = useMemo(
    () => deriveActions(activeTemplate, gdriveConnected, kind),
    [activeTemplate, gdriveConnected, kind],
  )

  useEffect(() => {
    const state = (location.state ?? {}) as EditorState
    const nextKind: 'image' | 'video' = state.kind ?? (state.filePath ? 'video' : state.dataUrl ? 'image' : kind)
    setHistoryId(state.historyId)
    setInitialAnnotations(state.annotations)
    userEditedRef.current = false
    if (nextKind === 'video') {
      setKind('video')
      setVideoFilePath(state.filePath ?? '')
      setVideoName(state.name ?? '')
      setImageDataUrl('')
      canvasRef.current?.clear()
    } else if (state.dataUrl) {
      setKind('image')
      setVideoFilePath('')
      setVideoName('')
      resetForNewImage(state.dataUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  useEffect(() => {
    window.electronAPI?.onCaptureReady(({ dataUrl }) => {
      // capture:ready is screenshot-only — switch back to image mode if the
      // user happened to be viewing a video when the next capture landed.
      setKind('image')
      setVideoFilePath('')
      setVideoName('')
      // Fresh capture has no existing history entry yet, so wipe any lingering
      // annotation context from a previously-opened history item.
      setHistoryId(undefined)
      setInitialAnnotations(undefined)
      userEditedRef.current = false
      resetForNewImage(dataUrl)
    })
    Promise.all([
      window.electronAPI?.getTemplates(),
      window.electronAPI?.getSettings(),
    ]).then(([t, s]) => {
      if (t) setTemplates(t)
      if (s?.activeWorkflowId) setActiveWorkflowId(s.activeWorkflowId)
      // Start from the style the user last picked (see persistStyle below).
      const st = s?.annotationStyle
      if (st && typeof st.color === 'string' && typeof st.strokeWidth === 'number') {
        setColor(st.color)
        setStrokeWidth(st.strokeWidth)
      }
      setGdriveConnected(!!s?.googleDriveConnected)
    })
    return () => { window.electronAPI?.removeAllListeners('capture:ready') }
  }, [])

  useEffect(() => {
    window.electronAPI?.getHistory().then((items: HistoryItem[]) => {
      setClipboardHistory(
        items
          .filter((i) => i.type === 'screenshot' && !i.fileMissing && (i.thumbnailUrl || i.dataUrl))
          .slice(0, 20)
          .map((i) => ({
            id: i.id,
            thumbnailUrl: (i.thumbnailUrl ?? i.dataUrl)!,
            filePath: i.filePath,
            annotatedFilePath: i.annotatedFilePath,
            legacyDataUrl: i.filePath ? undefined : i.dataUrl,
            name: i.name,
            timestamp: i.timestamp,
            annotations: i.annotations,
          })),
      )
    })
  }, [])

  const loadClipboardItem = useCallback(async (entry: { id: string; filePath?: string; annotatedFilePath?: string; legacyDataUrl?: string; annotations?: AnnotationObject[] }) => {
    // When the item carries vector annotations, load the ORIGINAL file and let
    // Canvas replay the vectors on top — same as Dashboard. Using the annotated
    // sidecar here would flatten the annotations into pixels AND replay the
    // vectors, doubling them (and leaving ghosts when one is deleted). Only when
    // there are no vectors do we fall back to the annotated sidecar so a legacy
    // item edited before vectors were persisted still shows its edited version.
    const hasVectors = (entry.annotations?.length ?? 0) > 0
    const sourcePath = hasVectors ? entry.filePath : (entry.annotatedFilePath ?? entry.filePath)
    if (sourcePath) {
      try {
        const dataUrl = await window.electronAPI?.readHistoryFile(sourcePath)
        if (dataUrl) return dataUrl
        // null → file disappeared between getHistory and click. Drop the
        // entry from the panel so the next click doesn't repeat the miss.
        setClipboardHistory(prev => prev.filter(c => c.id !== entry.id))
        return undefined
      } catch { /* fall through to legacy */ }
    }
    return entry.legacyDataUrl
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); canvasRef.current?.zoomIn(); return }
        if (e.key === '-')                  { e.preventDefault(); canvasRef.current?.zoomOut(); return }
        if (e.key === '0')                  { e.preventDefault(); canvasRef.current?.zoomReset(); return }
      }
      // Don't let a modified chord (Ctrl+V/A/R/T/B/E/P, etc.) silently switch
      // the active tool — those are clipboard/select/etc. shortcuts, not the
      // bare single-key tool picks.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const match = matchToolShortcut(e.key)
      if (match) setTool(match)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showToast = useCallback((message: string, icon: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, icon, type })
    setTimeout(() => setToast(null), 2500)
  }, [])

  // ── Video action handlers ─────────────────────────────────────────────────
  // Video in this editor is view-only — Save / Copy / Upload act on the source
  // recording file directly. (Annotating video / freeze-frame export were
  // removed to keep the flow simple; bring them back in a dedicated video
  // editing module when needed.)
  // Unified action dispatcher — both modes share the same button list (from
  // deriveActions) so order and styling stay consistent. Video routes clicks
  // to file-level IPCs since there's no composite frame pipeline.
  const runVideoAction = useCallback(async (btn: ActionBtn) => {
    if (!videoFilePath) return
    setActionBusy(btn.key)
    try {
      if (btn.actionType === 'clipboard') {
        const res = await window.electronAPI?.videoCopyFile?.(videoFilePath)
        if (res?.fallback === 'text') showToast('Copied file path (clipboard file copy unsupported here)', 'content_copy')
        else                          showToast('Video copied', 'content_copy')
      } else if (btn.actionType === 'save') {
        const res = await window.electronAPI?.videoSaveAs?.(videoFilePath)
        if (res && !res.canceled && res.savedPath) showToast('Recording saved', 'check_circle')
      } else if (btn.destinationIndex !== undefined) {
        const dest = activeTemplate?.destinations[btn.destinationIndex]
        // When the recording came in through history (the normal path — every
        // capture lands there), route uploads via history:share* so main
        // dedupes against existing uploads, persists the result onto the
        // history item, and a second click copies the cached URL instead of
        // re-uploading the file. videoUpload* by-passes history entirely and
        // would re-upload on every click, leaving the history Synced badge
        // off too.
        if (dest?.type === 'r2') {
          const res = historyId
            ? await window.electronAPI?.shareHistoryR2(historyId)
            : await window.electronAPI?.videoUploadR2?.(videoFilePath)
          if (res?.success && res.url) showToast('Uploaded — link copied', 'check_circle')
          else                         showToast(res?.error ?? 'Upload failed', 'error', 'error')
        } else if (dest?.type === 'google-drive') {
          const res = historyId
            ? await window.electronAPI?.shareHistoryGoogleDrive(historyId)
            : await window.electronAPI?.videoUploadGoogleDrive?.(videoFilePath)
          if (res?.success && res.url) showToast('Uploaded to Drive — link copied', 'check_circle')
          else                         showToast(res?.error ?? 'Upload failed', 'error', 'error')
        }
      }
    } catch (err: any) {
      showToast(err?.message ?? 'Action failed', 'error', 'error')
    } finally {
      setActionBusy(null)
    }
  }, [videoFilePath, activeTemplate, showToast, historyId])

  // Debounce timer for auto-saving annotation JSON as the user draws. Full
  // saves (with the flattened PNG sidecar + fresh thumbnail) happen on every
  // action trigger via handleExport — this debounce is purely so annotations
  // survive an Editor close that isn't accompanied by an action.
  //
  // `pendingSave` holds the payload the timer is scheduled to write. On
  // unmount (Back button, closing the editor, app quit) we flush it
  // synchronously so work in progress isn't dropped when the debounce
  // doesn't reach its 600ms window.
  const annotationSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAnnotationSave = useRef<{ historyId: string; objects: AnnotationObject[]; flattenedDataUrl?: string } | null>(null)
  // Suppress saves triggered by Canvas's replay of `initialAnnotations`. The
  // replay fires before `useImage` has finished loading the background, so
  // `stage.toDataURL()` at that moment captures the strokes on a transparent
  // canvas — the resulting sidecar PNG would lose the original image. We only
  // enable saves after Canvas reports a genuine user edit via the `userEdited`
  // flag on onHistoryChange.
  const userEditedRef = useRef(false)
  useEffect(() => () => {
    if (annotationSaveTimer.current) {
      clearTimeout(annotationSaveTimer.current)
      annotationSaveTimer.current = null
    }
    const pending = pendingAnnotationSave.current
    pendingAnnotationSave.current = null
    if (pending) {
      window.electronAPI?.saveHistoryAnnotations(pending.historyId, pending.objects, pending.flattenedDataUrl).catch(() => {})
    }
  }, [])

  // Persist toolbar style picks to settings (debounced — the stroke slider
  // fires per pixel) so the next editor session starts with them. Only the
  // wrappers handed to the toolbar persist; handleSelectionChange below sets
  // the raw state on purpose — mirroring an existing shape's style into the
  // toolbar is not a new pick.
  const styleRef = useRef({ color, strokeWidth })
  useEffect(() => { styleRef.current = { color, strokeWidth } }, [color, strokeWidth])
  const persistStyleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistStyle = useCallback(() => {
    if (persistStyleTimer.current) clearTimeout(persistStyleTimer.current)
    persistStyleTimer.current = setTimeout(() => {
      persistStyleTimer.current = null
      window.electronAPI?.setSetting('annotationStyle', styleRef.current)
    }, 300)
  }, [])
  // Flush a pending write if the editor closes inside the debounce window.
  useEffect(() => () => {
    if (persistStyleTimer.current) {
      clearTimeout(persistStyleTimer.current)
      persistStyleTimer.current = null
      window.electronAPI?.setSetting('annotationStyle', styleRef.current)
    }
  }, [])
  const pickColor = useCallback((c: string) => { setColor(c); persistStyle() }, [persistStyle])
  const pickStrokeWidth = useCallback((w: number) => { setStrokeWidth(w); persistStyle() }, [persistStyle])

  // Selecting a shape switches to its tool (rect → Rect, text → Text, …) and
  // mirrors its style in the toolbar; toolbar edits then flow back onto that
  // shape through Canvas's `color` / `strokeWidth` props. Canvas keeps the
  // selection across this tool switch (it only drops it for a *different*
  // tool). Stickers are skipped: the sticker "tool" is the picker modal and
  // they carry no style. Deselecting keeps tool + values for the next shape.
  const handleSelectionChange = useCallback((sel: SelectionInfo | null) => {
    if (!sel || sel.type === 'sticker' || sel.type === 'none') return
    setTool(sel.type)
    setColor(sel.color)
    setStrokeWidth(sel.strokeWidth)
  }, [])

  const handleExport = useCallback(async (dataUrl: string) => {
    setExportTrigger(0)

    const pendingRaw = pendingAction.current
    pendingAction.current = null
    const pending = pendingRaw ? JSON.parse(pendingRaw) as {
      key: string; templateId: string; destinationIndex?: number; actionType?: 'clipboard' | 'save'
    } : null

    // Every action (including Save) persists the current annotations +
    // flattened sidecar so the next Editor session rehydrates the shapes and
    // Dashboard surfaces see annotated pixels. Save's "pure file I/O" promise
    // is about not creating a *new* history entry — `runInlineAction` doesn't
    // touch the history store, so updating an existing item's annotations
    // here is fine.
    //
    // AWAIT instead of fire-and-forget: runInlineAction('save') below reads
    // the just-written sidecar off disk and copies it to the user's chosen
    // location (preserves bytes + iCCP, avoids a lossy decode/re-encode
    // round-trip through Konva canvas). Racing the two would let copyFile
    // pick up stale sidecar contents from the previous edit.
    if (historyId && !isVideo && canvasRef.current) {
      if (annotationSaveTimer.current) { clearTimeout(annotationSaveTimer.current); annotationSaveTimer.current = null }
      pendingAnnotationSave.current = null  // action save supersedes any pending debounced save
      const objects = canvasRef.current.getObjects() as AnnotationObject[]
      try {
        await window.electronAPI?.saveHistoryAnnotations(historyId, objects, dataUrl)
      } catch (err) {
        console.error('[editor] failed to save annotations', err)
      }
    }

    if (!pending) return
    const { key, templateId, destinationIndex, actionType } = pending
    setActionBusy(key)
    if (actionType) {
      window.electronAPI?.runInlineAction(actionType, dataUrl, historyId)
        .then((res) => {
          if (res?.canceled) return // user dismissed the save dialog
          showToast(actionType === 'clipboard' ? 'Copied to clipboard' : 'Saved to file', 'check_circle')
        })
        .catch(() => showToast('Action failed', 'error', 'error'))
        .finally(() => setActionBusy(null))
      return
    }
    window.electronAPI?.runWorkflow(templateId, dataUrl, destinationIndex, historyId)
      .then((r) => {
        if (r?.uploads?.some(u => u.url))  showToast('Uploaded — link copied', 'check_circle')
        else if (r?.copiedToClipboard)     showToast('Copied to clipboard', 'check_circle')
        else if (r?.savedPath)             showToast('Saved to file', 'check_circle')
        else                               showToast('Done', 'check_circle')
      })
      .catch(() => showToast('Action failed', 'error', 'error'))
      .finally(() => setActionBusy(null))
  }, [historyId, isVideo, showToast])

  const triggerAction = (key: string, templateId: string, destinationIndex?: number, actionType?: 'clipboard' | 'save') => {
    pendingAction.current = JSON.stringify({ key, templateId, destinationIndex, actionType })
    setExportTrigger((n) => n + 1)
  }

  const handleHistoryChange = useCallback((u: boolean, r: boolean, userEdited?: boolean) => {
    setCanUndo(u)
    setCanRedo(r)
    // Lightweight auto-save: just the annotation JSON, no flattened PNG. That
    // way closing the Editor without clicking an action doesn't lose work.
    // The flattened sidecar + thumbnail get refreshed on the next action via
    // handleExport, which is the right moment since that's when external
    // surfaces (Dashboard Share/Copy) need an up-to-date pixel version.
    //
    // Skip when the stack is at its blank root (no undo, no redo) — that's
    // either the Canvas's first render before replay fills it, or a cleared
    // state with no editing history. In both cases saving an empty array
    // would wipe the user's persisted annotations.
    if (!u && !r) return
    if (historyId && !isVideo && canvasRef.current) {
      // Gate out Canvas replay using its explicit `userEdited` signal rather
      // than an object-count diff — the count check missed same-length first
      // edits (e.g. dragging a single Text), silently dropping that save.
      // `userEditedRef` latches once Canvas reports the first real edit.
      if (!userEditedRef.current) {
        if (!userEdited) return
        userEditedRef.current = true
      }
      const objects = canvasRef.current.getObjects() as AnnotationObject[]
      // Stash JSON now; defer the expensive full-resolution rasterisation to
      // the debounce callback so we don't flatten the whole stage on every
      // stroke commit. The unmount flush below may run before this fires and
      // sends JSON-only (flattenedDataUrl undefined) — that's fine, the next
      // action refreshes the sidecar.
      pendingAnnotationSave.current = { historyId, objects, flattenedDataUrl: undefined }
      if (annotationSaveTimer.current) clearTimeout(annotationSaveTimer.current)
      annotationSaveTimer.current = setTimeout(() => {
        // Rasterise inside the debounce window — the stage is still alive here.
        try { if (canvasRef.current && pendingAnnotationSave.current) pendingAnnotationSave.current.flattenedDataUrl = canvasRef.current.toDataURL() } catch { /* stage unavailable */ }
        const pending = pendingAnnotationSave.current
        pendingAnnotationSave.current = null
        annotationSaveTimer.current = null
        if (pending) {
          window.electronAPI?.saveHistoryAnnotations(pending.historyId, pending.objects, pending.flattenedDataUrl).catch(() => {})
        }
      }, 600)
    }
  }, [historyId, isVideo])

  const handlePickSticker = useCallback((s: PickedSticker) => {
    const aspect = s.natural.h > 0 ? s.natural.w / s.natural.h : 1
    canvasRef.current?.addSticker({ src: s.path, aspect })
    // Drop back to cursor so the freshly-placed sticker is selected and
    // draggable, and the picker (gated on tool === 'sticker') closes.
    setTool('none')
  }, [])

  /* ── Empty state (no source at all — covers both image and video modes) ── */
  const hasSource = isVideo ? !!videoFilePath : !!imageDataUrl
  if (!hasSource) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6">
        <div className="relative">
          <div className="absolute -inset-8 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative p-7 rounded-3xl bg-white/[0.03] border border-white/[0.06] shadow-2xl">
            <span className="material-symbols-outlined text-5xl text-slate-500" style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}>
              {isVideo ? 'videocam' : 'photo_camera'}
            </span>
          </div>
        </div>
        <div className="text-center space-y-2">
          <p className="text-lg font-bold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>Ready to annotate</p>
          <p className="text-sm text-slate-500 max-w-[260px]">
            {isVideo
              ? 'Open a recording from the History page to start editing'
              : 'Capture your screen or pick a recent screenshot to start editing'}
          </p>
        </div>
        <div className="flex gap-3 mt-1">
          <button
            onClick={() => navigate('/dashboard')}
            className="px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-semibold text-white transition-all"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Dashboard
          </button>
          <button
            onClick={triggerNewCapture}
            className="primary-gradient text-slate-900 font-bold px-5 py-2.5 rounded-xl text-sm hover:scale-[1.02] active:scale-95 transition-transform flex items-center gap-2"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-base">screenshot_region</span>
            New Capture
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-12 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-2 px-4 py-2 backdrop-blur-xl border rounded-xl shadow-lg animate-slide-up ${
          toast.type === 'error' ? 'bg-red-500/20 border-red-500/30' : 'bg-emerald-500/20 border-emerald-500/30'
        }`}>
          <span className={`material-symbols-outlined text-sm ${toast.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{toast.icon}</span>
          <span className="text-xs font-semibold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>{toast.message}</span>
        </div>
      )}

      {/* ── Top bar: title + actions ── */}
      <header className="h-10 liquid-glass flex items-center px-3 border-b border-white/5 flex-shrink-0 gap-2">
        {/* Back */}
        <button
          onClick={() => navigate('/dashboard')}
          className="h-7 w-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-all flex-shrink-0"
          title="Back"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
        </button>

        {/* Zoom — image only (Konva-managed; video player has its own scaling). */}
        {!isVideo && (
          <>
            <div className="w-px h-5 bg-white/10" />
            <div className="flex items-center gap-0.5">
              <TinyBtn icon="remove" title="Zoom out (Ctrl+-)" onClick={() => canvasRef.current?.zoomOut()} />
              <button
                onClick={() => canvasRef.current?.zoomReset()}
                className="h-7 px-2 rounded-lg text-[11px] font-bold text-slate-400 hover:text-white hover:bg-white/10 transition-all tabular-nums min-w-[44px] text-center"
                title="Reset zoom (Ctrl+0 / Double click)"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                {Math.round(zoomLevel * 100)}%
              </button>
              <TinyBtn icon="add" title="Zoom in (Ctrl+=)" onClick={() => canvasRef.current?.zoomIn()} />
            </div>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* New capture */}
        <button
          onClick={triggerNewCapture}
          className="h-7 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1.5 text-slate-400 hover:text-white transition-all flex-shrink-0"
          title="New capture"
        >
          <span className="material-symbols-outlined text-[15px]">add_a_photo</span>
          <span className="text-[11px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>New</span>
        </button>

        {/* Recent captures */}
        <button
          onClick={() => setShowClipPanel(p => !p)}
          className={`h-7 px-2.5 rounded-lg flex items-center gap-1.5 transition-all flex-shrink-0 ${
            showClipPanel ? 'bg-primary/20 text-primary' : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
          }`}
          title="Recent captures"
        >
          <span className="material-symbols-outlined text-[15px]">history</span>
          <span className="text-[11px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>History</span>
        </button>

        {actionBtns.length > 0 && <div className="w-px h-5 bg-white/10" />}

        {/* Shared action buttons — same list, order, and styling for image and
             video. Click dispatches via kind: image → workflow/inline-action,
             video → file-level IPCs (save-as copy, clipboard file, R2 upload). */}
        {actionBtns.map((btn) => (
          <button
            key={btn.key}
            onClick={() => isVideo
              ? runVideoAction(btn)
              : triggerAction(btn.key, btn.templateId, btn.destinationIndex, btn.actionType)}
            disabled={!!actionBusy || (isVideo && !videoFilePath)}
            title={btn.label}
            className={`h-7 px-2.5 rounded-lg flex items-center gap-1.5 transition-all flex-shrink-0 disabled:opacity-40 text-[11px] font-semibold ${
              actionBusy === btn.key
                ? 'bg-primary/20 text-primary'
                : btn.primary
                  ? 'primary-gradient text-slate-900 hover:brightness-110'
                  : 'bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
            }`}
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            {actionBusy === btn.key
              ? <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              : <span className="material-symbols-outlined text-[14px]">{btn.icon}</span>
            }
            {btn.label}
          </button>
        ))}
      </header>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Canvas container ── */}
        <div className="flex-1 relative overflow-hidden editor-workspace">
          <div className="absolute inset-0 opacity-[0.025] pointer-events-none editor-workspace-dots" />
          {isVideo ? (
            /* Plain HTML5 video player — annotation isn't supported on video in
             *  this build; showing a live video through Konva is overkill when
             *  we're not drawing on it. Native controls give smooth playback. */
            videoSrc ? (
              <div
                ref={videoContainerRef}
                className="absolute inset-0 flex items-center justify-center"
              >
                <video
                  ref={el => { videoRef.current = el }}
                  src={videoSrc}
                  controls
                  playsInline
                  preload="auto"
                  onLoadedMetadata={onVideoMeta}
                  style={
                    videoDisplaySize
                      ? { width: videoDisplaySize.width, height: videoDisplaySize.height }
                      : { maxWidth: '100%', maxHeight: '100%' }
                  }
                />
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-500">
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-sm" style={{ fontFamily: 'Manrope, sans-serif' }}>Loading video…</span>
              </div>
            )
          ) : (
            <AnnotationCanvas
              ref={canvasRef}
              key={imageDataUrl}
              background={{ kind: 'image', dataUrl: imageDataUrl }}
              tool={tool}
              color={color}
              strokeWidth={strokeWidth}
              onExport={handleExport}
              exportTrigger={exportTrigger}
              onHistoryChange={handleHistoryChange}
              onZoomChange={setZoomLevel}
              onSelectionChange={handleSelectionChange}
              initialObjects={initialAnnotations as DrawObject[] | undefined}
            />
          )}
        </div>

        {/* ── Clipboard history panel ── */}
        {showClipPanel && (
          <aside className="w-60 flex-shrink-0 glass-refractive border-l border-white/5 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 flex-shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Recent Captures
              </span>
              <button onClick={() => setShowClipPanel(false)} className="text-slate-500 hover:text-white transition-colors">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {clipboardHistory.length === 0 ? (
                <div className="flex flex-col items-center py-10 gap-3">
                  <span className="material-symbols-outlined text-2xl text-slate-700">collections</span>
                  <p className="text-xs text-slate-600 text-center px-4">Your recent captures will appear here</p>
                </div>
              ) : (
                clipboardHistory.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2.5 p-2 rounded-xl cursor-pointer transition-all bg-white/[0.02] hover:bg-white/[0.06] border border-transparent"
                    onClick={async () => {
                      const dataUrl = await loadClipboardItem(item)
                      if (!dataUrl) return
                      // Switching the editor to a different history item: re-tag
                      // historyId + annotations so subsequent Upload/Save flows
                      // target this entry instead of leaking into whichever item
                      // the editor was previously on (or creating a duplicate
                      // when no historyId was set).
                      setHistoryId(item.id)
                      setInitialAnnotations(item.annotations)
                      userEditedRef.current = false
                      resetForNewImage(dataUrl)
                    }}
                  >
                    <img src={item.thumbnailUrl} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-white/10" draggable={false} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-slate-300 truncate font-medium">{item.name}</p>
                      <p className="text-[9px] text-slate-600 mt-0.5">{relativeTime(item.timestamp)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Annotation toolbar — image mode only. Video is view-only in this
           build; to annotate, extract a frame via the History page or rebuild
           the dedicated video annotator. */}
      {!isVideo && (
        <div className="relative flex-shrink-0">
        {tool === 'sticker' && (
          <StickerPicker
            onSelect={handlePickSticker}
            onClose={() => setTool('none')}
          />
        )}
        <AnnotationToolBar
          tool={tool} setTool={setTool}
          color={color} setColor={pickColor}
          strokeWidth={strokeWidth} setStrokeWidth={pickStrokeWidth}
          canUndo={canUndo} canRedo={canRedo}
          onUndo={() => canvasRef.current?.undo()}
          onRedo={() => canvasRef.current?.redo()}
          onClear={() => canvasRef.current?.clear()}
        />
        </div>
      )}

      {/* No playback bar — the native HTML5 <video controls> provides
           play/pause/seek/volume without any custom UI. */}

    </div>
  )
}

/* ── Tiny icon button (top bar) ── */
function TinyBtn({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-25 disabled:cursor-not-allowed"
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
    </button>
  )
}

