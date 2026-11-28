import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { grabVideoFrame } from '../../lib/video-frame'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import AnnotationCanvas, {
  type CanvasHandle,
  Tool,
} from '../../components/AnnotationCanvas/Canvas'
import AnnotationToolBar from '../../components/AnnotationCanvas/ToolBar'
import { defaultKeymap, matchesBinding, resolveKeymap, type Keymap } from '../../lib/editor-keys'
import type { WorkflowTemplate, HistoryItem, AnnotationObject, VideoTrim } from '../../types'
import type { DrawObject, SelectionInfo } from '../../components/AnnotationCanvas/Canvas'
import StickerPicker, { type PickedSticker, pushRecentSticker, STICKER_PANEL_W } from '../../components/StickerPicker'
import { type ActionBtn } from '../../lib/workflow-actions'
import { uploadLinksOf, uploadRows, type UploadLinks, type UploadRow } from '../../lib/upload-choice'
import { UploadMenu } from '../../components/UploadMenu'
import { HistoryPanel } from '../../components/RecentImages'
import { describeStep, packHistory, unpackHistory, type StepObject } from '../../lib/edit-steps'
import { getEditorView, setEditorView, type EditorView } from '../../lib/editor-view'
import { recordingFps } from '../../../shared/recording'
import { useLocalVideoUrl } from '../../hooks/useLocalVideoUrl'
import { useFilmstrip } from '../../hooks/useFilmstrip'
import VideoTrimBar, { MIN_TRIM_SELECTION_MS, useAutoHideControls, autoHideClass } from '../../components/VideoTrimBar'

import { Icon } from '../../components/Icon'
import { toast, toastError } from '../../lib/toast'
import { AppBarControls, useAppBarClose } from '../../components/AppBarSlot'
import { forgetClip } from '../../lib/dashboard-place'
import { ICON_BUTTON, DANGER_ICON_BUTTON } from '../../components/button-classes'
/** Marks Delete in the AppBar slot's button row (it isn't a workflow action). */
const DELETE_SLOT: ActionBtn = { key: 'delete', icon: 'delete', label: 'Delete', templateId: '' }
import { OnStrip } from '../../components/OnStrip'
import { DEFAULT_ANNOTATION_COLOR } from '../../../shared/annotation'
// Wired back 2026-11-25 for its review (built in April, never mounted).
import BackgroundPanel, { DEFAULT_BG, frameOf, type BgSettings } from '../../components/BackgroundPanel'
/** Location.state shape accepted by the unified editor. Image mode carries a
 *  dataUrl; video mode carries filePath (+ optional display name). */
type EditorState = {
  kind?: 'image' | 'video'
  dataUrl?: string
  filePath?: string
  /** Recording only: applied trimmed copy + its range (from the history row). */
  trimmedFilePath?: string
  trim?: VideoTrim
  /** Recording only: the rate it was recorded at (the history row's `fps`). */
  fps?: number
  name?: string
  source?: string
  historyId?: string
  annotations?: AnnotationObject[]
  /** Recording only: the history row's upload links, per destination. */
  uploadLinks?: UploadLinks
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



/** Recent images' second line (2026-11-24; the date and time read busy):
 *  how long ago, "Now", "5m ago", "3h ago", "2d ago"; a week or older the
 *  date as the Dashboard's list writes it ("2026-11-17"). */
function recentTimeLabel(ts: number): string {
  const mins = minutesAgo(ts)
  if (mins < 1) return 'Now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  if (mins < 7 * 1440) return `${Math.floor(mins / 1440)}d ago`
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whole clock minutes between then and now, seconds dropped on both sides
 *  (2026-11-23): 20:14:50 → 20:16:10 is 2m, as the clock reads. */
function minutesAgo(ts: number): number {
  return Math.floor(Date.now() / 60000) - Math.floor(ts / 60000)
}

export default function Editor() {
  const location = useLocation()

  // Unified state — `kind` switches the editor between image and video mode.
  // Callers that navigate here must set `kind` explicitly; default is 'image'
  // so existing screenshot paths keep working without changes.
  const initialState = (location.state ?? {}) as EditorState
  const [kind, setKind] = useState<'image' | 'video'>(initialState.kind ?? (initialState.filePath ? 'video' : 'image'))
  const [imageDataUrl, setImageDataUrl] = useState<string>(initialState.dataUrl ?? '')
  const [videoFilePath, setVideoFilePath] = useState<string>(initialState.filePath ?? '')
  // Trim: the player always shows the ORIGINAL (videoFilePath) so a trim can
  // be widened again; the trimmed copy is what Save / Copy / Upload send.
  const [trimmedPath, setTrimmedPath]     = useState<string | undefined>(initialState.trimmedFilePath)
  // The recording's upload links (2026-11-23), per destination, as on the
  // Dashboard. A trim or reset clears the row's uploads.
  const [uploadLinks, setUploadLinks] = useState<UploadLinks>(initialState.uploadLinks ?? {})
  const [uploadMenu, setUploadMenu] = useState<{ anchor: DOMRect; anchorEl: HTMLElement; rows: UploadRow[] } | null>(null)
  const closeUploadMenu = useCallback(() => setUploadMenu(null), [])
  // Upload for recordings follows the Dashboard's rule, not the workflow
  // template: shown when this build has R2 credentials or Google Drive is
  // connected with a folder; R2 first.
  const [r2Ready, setR2Ready] = useState(false)
  const [gdriveReady, setGdriveReady] = useState(false)
  // Settings › Hold key to pan (2026-11-24): off makes the Cursor tool the hand.
  const [keyToDrag, setKeyToDrag] = useState(false)
  // The editors' keys (Settings › Hotkeys, 2026-11-24; src/lib/editor-keys.ts),
  // read when the editor opens. Refs for the long-lived key listeners.
  const isMac = window.electronAPI?.platform === 'darwin'
  const [imageKeys, setImageKeys] = useState<Keymap>(() => defaultKeymap('image', isMac))
  const imageKeysRef = useRef(imageKeys)
  imageKeysRef.current = imageKeys
  const videoKeysRef = useRef<Keymap>(defaultKeymap('video', isMac))
  const [appliedTrim, setAppliedTrim]     = useState<VideoTrim | undefined>(initialState.trim)
  // One frame of this recording, for the ←/→ steps: by the rate it was
  // recorded at (saved on its row since 2026-11-27), else the recorder's
  // current rate (shared/recording.ts). A fixed 1000 / 60 here had fallen
  // out of step with the recorder's 30 fps: every second press showed the
  // same picture. Screen recordings are variable-frame-rate, so on a static
  // screen a step can still land on the same picture; the playhead readout
  // moves either way.
  const [videoFps, setVideoFps]           = useState<number | undefined>(initialState.fps)
  const frameMs = 1000 / recordingFps(videoFps)
  const [historyId, setHistoryId]         = useState<string | undefined>(initialState.historyId)
  const [initialAnnotations, setInitialAnnotations] = useState<AnnotationObject[] | undefined>(initialState.annotations)
  const isVideo = kind === 'video'

  const [tool, setTool] = useState<Tool>('none')
  // The sticker sidebar (2026-11-26): History mirrored at the canvas's
  // left, toggled by the toolbar's Sticker button and the Sticker key (it
  // was the Sticker tool's callout). Pinned and open are remembered like
  // History's.
  const [stickersPinned, setStickersPinned] = useState(() => {
    try { return localStorage.getItem('lumia:editor-stickers-pinned') === '1' } catch { return false }
  })
  const pinStickers = useCallback((on: boolean) => {
    setStickersPinned(on)
    try { localStorage.setItem('lumia:editor-stickers-pinned', on ? '1' : '0') } catch { /* not remembered */ }
  }, [])
  const stickersPinnedRef = useRef(stickersPinned)
  stickersPinnedRef.current = stickersPinned
  const [stickersOpen, setStickersOpenRaw] = useState(() => {
    try { return stickersPinned && localStorage.getItem('lumia:editor-stickers-open') !== '0' } catch { return stickersPinned }
  })
  const setStickersOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setStickersOpenRaw(prev => {
      const open = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem('lumia:editor-stickers-open', open ? '1' : '0') } catch { /* not kept */ }
      return open
    })
  }, [])
  // Opened by the user (the Sticker button or key): the search takes focus
  // (2026-11-26). Not when a pinned sidebar opens with the editor, where a
  // focused field would swallow the tool keys.
  const stickersByUserRef = useRef(false)
  const toggleStickers = useCallback(() => {
    stickersByUserRef.current = true
    setStickersOpen(o => !o)
  }, [setStickersOpen])
  const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOR)
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [exportTrigger, setExportTrigger] = useState(0)
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [activeWorkflowId, setActiveWorkflowId] = useState<string>('')
  // Background panel: open state and its settings. The fill shows as a
  // frame `padding` image pixels wide around the image, and goes into
  // Copy / Save / Upload (2026-11-25). Not remembered per image yet.
  const [bgOpen, setBgOpen] = useState(false)
  const bgBtnRef = useRef<HTMLButtonElement>(null)
  const [bg, setBg] = useState<BgSettings>(DEFAULT_BG)
  const closeBgPanel = useCallback(() => setBgOpen(false), [])
  const bgFrame = useMemo(() => frameOf(bg), [bg])
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
      uploads?: HistoryItem['uploads']
      captureMode?: HistoryItem['captureMode']
      source?: HistoryItem['source']
    }[]
  >([])
  // History pinned (2026-11-23): docked, stays open (a click outside or Esc
  // leaves it). Remembered per viewer; closing the panel keeps the pin, so
  // History reopens it docked. Whether a pinned panel was open is kept too:
  // the editor opens with it open only if it was left open.
  const [historyPinned, setHistoryPinned] = useState(() => {
    try { return localStorage.getItem('lumia:editor-history-pinned') === '1' } catch { return false }
  })
  const pinHistory = useCallback((on: boolean) => {
    setHistoryPinned(on)
    try { localStorage.setItem('lumia:editor-history-pinned', on ? '1' : '0') } catch { /* not remembered */ }
  }, [])
  const [showClipPanel, setShowClipPanelRaw] = useState(() => {
    try { return historyPinned && localStorage.getItem('lumia:editor-history-open') !== '0' } catch { return historyPinned }
  })
  // Docking and undocking glide (2026-11-23, asked for): the panel stays
  // one element and moves between its two places (CSS transitions in
  // HistoryPanel); docked it lies over the canvas's right side (the image
  // doesn't move) and the floating toolbar's right edge makes room. The
  // panel's width, measured and kept for that.
  const [panelWidth, setPanelWidth] = useState(() => {
    try { return Number(localStorage.getItem('lumia:history-panel-width')) || 0 } catch { return 0 }
  })
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-history-panel]')
    if (!el) return
    const measure = () => {
      const w = el.offsetWidth
      setPanelWidth(w)
      try { localStorage.setItem('lumia:history-panel-width', String(w)) } catch { /* not kept */ }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showClipPanel, isVideo])
  const setShowClipPanel = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setShowClipPanelRaw(prev => {
      const open = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem('lumia:editor-history-open', open ? '1' : '0') } catch { /* not kept */ }
      return open
    })
  }, [])
  /** Recent images' thumbnails, decoded ahead of the Images tab. */
  const preloadRef = useRef<HTMLImageElement[]>([])
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
  useEffect(() => {
    // Keep the size the element already knows on a dev hot reload (no new
    // loadedmetadata comes then); a new video starts unknown.
    const v = videoRef.current
    setVideoNaturalSize(v && v.currentSrc === videoSrc && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null)
  }, [videoSrc])
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
  // ── Trim state ─────────────────────────────────────────────────────────
  // durationMs stays 0 until the real (finite) duration is known —
  // fixWebmDuration may report Infinity first for un-remuxed files.
  const [durationMs, setDurationMs] = useState(0)
  // The trim bar's filmstrip, asked for as the editor opens so it's there
  // when the bar first draws.
  const filmstrip = useFilmstrip(isVideo ? historyId : undefined, videoSrc || undefined, durationMs)
  const [currentMs, setCurrentMs] = useState(0)
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 })
  const [trimBusy, setTrimBusy] = useState(false)
  // A new video starts unknown (0) until its duration arrives. Read what the
  // element already knows instead of a flat 0: a hot reload in dev re-runs
  // this effect without reloading the <video>, so no new durationchange
  // would come and the trim bar stayed hidden (2026-11-22).
  useEffect(() => {
    const v = videoRef.current
    const d = v?.duration
    const known = v && d !== undefined && Number.isFinite(d) && d > 0 && v.currentSrc === videoSrc
    setDurationMs(known ? Math.round(d * 1000) : 0)
    setCurrentMs(known ? v.currentTime * 1000 : 0)
  }, [videoSrc])
  // (Re)seed the selection from the applied trim once the duration is known.
  useEffect(() => {
    if (durationMs <= 0) return
    setSel(appliedTrim
      ? { start: Math.min(appliedTrim.startMs, durationMs), end: Math.min(appliedTrim.endMs, durationMs) }
      : { start: 0, end: durationMs })
  }, [durationMs, appliedTrim])
  const onVideoDuration = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration
    if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000))
  }
  const selIsFull = durationMs > 0 && sel.start <= 0 && sel.end >= durationMs
  const trimDirty = durationMs > 0 && (appliedTrim
    ? Math.abs(sel.start - appliedTrim.startMs) > 1 || Math.abs(sel.end - Math.min(appliedTrim.endMs, durationMs)) > 1
    : !selIsFull)
  // Keep the playhead inside the selection (applied or pending): playback
  // stops at the end, and a seek past either edge (e.g. the native scrubber)
  // is pulled back to it. 1 ms of slack so a seek to the edge itself, which
  // reads back with float error, doesn't trigger another one.
  const selReady = durationMs > 0 && !selIsFull && sel.end > sel.start
  const onVideoTime = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    checkAudio(v)
    // A handle preview moves the picture, not the playhead.
    if (previewingRef.current) return
    const ms = v.currentTime * 1000
    // While a seek we asked for is on its way (a playhead drag, an arrow
    // step) the playhead already stands where it was sent. The frame that
    // just landed is an older position: taking its time pulled the playhead
    // back behind the pointer on every landed seek (2026-11-27, measured:
    // 140 of 174 seeks in one drag, up to 47px).
    if (!seekBusyRef.current) setCurrentMs(ms)
    if (!selReady) return
    if (ms > sel.end + 1 || (!v.paused && ms >= sel.end)) {
      v.pause()
      v.currentTime = sel.end / 1000
    } else if (ms < sel.start - 1) {
      v.currentTime = sel.start / 1000
    }
  }
  const onVideoPlay = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    const ms = v.currentTime * 1000
    if (durationMs > 0 && !selIsFull && (ms < sel.start - 50 || ms >= sel.end - 50)) {
      v.currentTime = sel.start / 1000
    }
  }
  // Chained seeks (2026-11-22): a drag sets a new time on every move, and
  // each new seek cancelled the one in flight, so the picture only caught up
  // when the pointer slowed down. Now a seek starts once the previous frame
  // has landed, always to the newest time asked for. seekTargetRef is that
  // newest time (arrow-key steps add to it, not to a stale currentTime).
  const seekBusyRef = useRef(false)
  const seekPendingRef = useRef<number | null>(null)
  const seekTargetRef = useRef<number | null>(null)
  /** Moves the picture only: chained seeks to the newest time asked for. */
  const chainSeek = useCallback((ms: number) => {
    const v = videoRef.current
    if (!v) return
    if (seekBusyRef.current) { seekPendingRef.current = ms; return }
    const run = (target: number) => {
      seekBusyRef.current = true
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        seekBusyRef.current = false
        const next = seekPendingRef.current
        seekPendingRef.current = null
        if (next !== null) run(next)
        else seekTargetRef.current = null
      }
      // A seek that never reports back mustn't block the next one.
      const timer = setTimeout(done, 500)
      v.addEventListener('seeked', done, { once: true })
      v.currentTime = target / 1000
    }
    run(ms)
  }, [])
  // Handle preview (2026-11-23): while a trim handle is dragged the video
  // shows the handle's frame; the playhead stays put (or is pushed along by
  // the handle) and the video returns to it on release, playing again if it
  // was playing.
  const previewingRef = useRef(false)
  const resumeAfterPreviewRef = useRef(false)
  const currentMsRef = useRef(0)
  currentMsRef.current = currentMs
  const seekVideo = useCallback((ms: number) => {
    setCurrentMs(ms)
    currentMsRef.current = ms
    seekTargetRef.current = ms
    if (!previewingRef.current) chainSeek(ms)
  }, [chainSeek])
  const previewFrame = useCallback((ms: number | null) => {
    const v = videoRef.current
    if (!v) return
    if (ms !== null) {
      if (!previewingRef.current) {
        previewingRef.current = true
        resumeAfterPreviewRef.current = !v.paused
        if (!v.paused) v.pause()
      }
      chainSeek(ms)
      return
    }
    if (!previewingRef.current) return
    previewingRef.current = false
    // Straight back to the playhead, dropping any queued preview frame, so
    // play() below starts from the playhead and not from the handle.
    seekPendingRef.current = null
    v.currentTime = currentMsRef.current / 1000
    if (resumeAfterPreviewRef.current) { resumeAfterPreviewRef.current = false; void v.play() }
  }, [chainSeek])

  // Our own player controls (2026-11-22; the native ones are gone):
  // play / pause and mute in the trim bar, a click on the video plays or
  // pauses. Mute shows once the recording turns out to have sound.
  const [playing, setPlaying] = useState(false)
  // Starts muted (2026-11-23); Unmute turns the sound on.
  const [muted, setMuted] = useState(true)
  const [hasAudio, setHasAudio] = useState(false)
  // Remember the image's zoom and pan (debounced: pans fire per move).
  // The view waiting to be saved is written at once when the editor closes
  // or moves on to another image (2026-11-27: it was dropped then).
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingView = useRef<{ id: string; view: EditorView } | null>(null)
  const flushView = useCallback(() => {
    clearTimeout(viewTimer.current)
    const p = pendingView.current
    pendingView.current = null
    if (p) setEditorView(p.id, p.view)
  }, [])
  const saveView = useCallback((view: EditorView) => {
    if (!historyId) return
    const id = historyId
    if (pendingView.current && pendingView.current.id !== id) flushView()
    clearTimeout(viewTimer.current)
    pendingView.current = { id, view }
    viewTimer.current = setTimeout(flushView, 300)
  }, [historyId, flushView])
  useEffect(() => flushView, [flushView])
  // The floating trim bar and the image toolbar hide and show on their own
  // (useAutoHideControls): video on playback, image while drawing a stroke
  // or typing in the text box (2026-11-25).
  const [canvasActivity, setCanvasActivity] = useState({ drawing: false, typing: false })
  const autoHide = useAutoHideControls(
    isVideo ? playing : canvasActivity.drawing || canvasActivity.typing,
    !isVideo && canvasActivity.drawing,
    // The toolbar stays up while the floating sticker sidebar is open
    // (2026-11-26); pinned it's always open, so the toolbar fades as usual.
    !isVideo && stickersOpen && !stickersPinned,
  )
  // The editor opens as a pop-over (videos 2026-11-23, images the same
  // day): the AppBar gets a Back arrow to the Dashboard, its own group
  // before Copy · Save · Upload; the gear stays.
  // The gear stays; Settings opened from here comes back to this row.
  useAppBarClose('/dashboard', historyId ?? null)
  useEffect(() => {
    // Same for a hot reload: keep what the element already shows.
    const v = videoRef.current
    const same = !!v && v.currentSrc === videoSrc
    setPlaying(same ? !v.paused : false)
    setHasAudio(same && ((v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0) > 0)
  }, [videoSrc])
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play(); else v.pause()
  }, [])
  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }, [])
  const checkAudio = (v: HTMLVideoElement) => {
    // Chromium's count of decoded audio bytes: above 0 once a track plays.
    const bytes = (v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount
    if (!hasAudio && typeof bytes === 'number' && bytes > 0) setHasAudio(true)
  }
  // When the selection changes (seeded from an applied trim, D / F, a handle
  // drag), pull a playhead left outside it onto the nearest edge.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !selReady) return
    const ms = previewingRef.current ? currentMsRef.current : v.currentTime * 1000
    if (ms < sel.start - 1) seekVideo(sel.start)
    else if (ms > sel.end + 1) seekVideo(sel.end)
  }, [sel, selReady, seekVideo])

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
  // The AppBar holds the file actions (2026-11-23, design/IMAGE-EDITOR.md):
  // Copy and Save always (no longer from the workflow template), then one
  // Upload by the Dashboard's rule (r2Ready): shown when there's somewhere
  // to go; one destination acts at once, two open the Upload menu
  // (lib/upload-choice.ts).
  const fileBtns = useMemo<ActionBtn[]>(() => [
    { key: 'clipboard', icon: 'content_copy', label: 'Copy', templateId: activeTemplate?.id ?? '', actionType: 'clipboard' },
    { key: 'save', icon: 'save', label: 'Save', templateId: activeTemplate?.id ?? '', actionType: 'save' },
  ], [activeTemplate])
  const uploadChoices = useMemo(() => uploadRows({
    r2Ready,
    gdriveReady,
    links: uploadLinks,
    // Images upload through their history row (the flattened copy).
    canUpload: isVideo ? !!(trimmedPath || videoFilePath) : !!historyId,
  }), [r2Ready, gdriveReady, uploadLinks, isVideo, trimmedPath, videoFilePath, historyId])
  const uploadBtn = useMemo<ActionBtn | undefined>(() =>
    uploadChoices.length > 0 ? { key: 'upload', icon: 'add_to_drive', label: 'Upload', templateId: '' } : undefined,
  [uploadChoices])

  useEffect(() => {
    const state = (location.state ?? {}) as EditorState
    const nextKind: 'image' | 'video' = state.kind ?? (state.filePath ? 'video' : state.dataUrl ? 'image' : kind)
    setHistoryId(state.historyId)
    setInitialAnnotations(state.annotations)
    setUploadLinks(state.uploadLinks ?? {})
    userEditedRef.current = false
    if (nextKind === 'video') {
      setKind('video')
      setVideoFilePath(state.filePath ?? '')
      setTrimmedPath(state.trimmedFilePath)
      setAppliedTrim(state.trim)
      setVideoFps(state.fps)
      setImageDataUrl('')
      canvasRef.current?.clear()
    } else if (state.dataUrl) {
      setKind('image')
      setVideoFilePath('')
      resetForNewImage(state.dataUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  useEffect(() => {
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
      setGdriveReady(!!(s?.googleDriveConnected && s?.googleDriveFolderId))
      setKeyToDrag(s?.keyToDrag === true)
      setImageKeys(resolveKeymap('image', s?.editorKeys?.image, isMac))
      videoKeysRef.current = resolveKeymap('video', s?.editorKeys?.video, isMac)
    })
    window.electronAPI?.r2IsConfigured?.().then(ok => setR2Ready(!!ok))
  }, [])

  useEffect(() => {
    // The 20 newest images whose file is still there (main skips missing
    // ones, 2026-11-23; it fetched 40 and filtered here). One without a
    // thumbnail is listed with a placeholder tile, not left out. Fetched
    // again after every history write (main's history:changed: an edit's
    // save rewrites the thumbnail, a new capture lands), so the list and its
    // thumbnails stay current while the editor is open.
    let alive = true
    let queued = false
    const load = () => window.electronAPI?.getRecentHistory(20, 'screenshot', { onDisk: true }).then((items: HistoryItem[]) => {
      if (!alive) return
      // Load and decode the thumbnails now, in the background, so the
      // Images tab shows them at once when opened (2026-11-23: they visibly
      // loaded in each time the tab opened). Kept in a ref so they stay in
      // memory.
      preloadRef.current = items.flatMap(i => {
        const url = i.thumbnailUrl ?? i.dataUrl
        if (!url) return []
        const img = new Image()
        img.src = url
        img.decode().catch(() => { /* missing: the tab shows the broken / placeholder state */ })
        return [img]
      })
      setClipboardHistory(
        items
          .filter((i) => i.type === 'screenshot' && !i.fileMissing)
          .map((i) => ({
            id: i.id,
            thumbnailUrl: i.thumbnailUrl ?? i.dataUrl ?? '',
            filePath: i.filePath,
            annotatedFilePath: i.annotatedFilePath,
            legacyDataUrl: i.filePath ? undefined : i.dataUrl,
            name: i.name,
            timestamp: i.timestamp,
            annotations: i.annotations,
            uploads: i.uploads,
            captureMode: i.captureMode,
            source: i.source,
          })),
      )
    })
    load()
    // Saves come in bursts (JSON, then the flattened copy): one refetch per
    // burst, 300ms after the first.
    const off = window.electronAPI?.onHistoryChanged?.(() => {
      if (queued) return
      queued = true
      setTimeout(() => { queued = false; void load() }, 300)
    })
    return () => { alive = false; off?.() }
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
      // Keys from the keymap (Settings › Hotkeys); modifiers must match
      // exactly, so a chord never also picks a tool.
      const keys = imageKeysRef.current
      const hit = (id: string) => matchesBinding(keys[id], e, isMac)
      if (hit('zoomIn'))    { e.preventDefault(); canvasRef.current?.zoomIn(); return }
      if (hit('zoomOut'))   { e.preventDefault(); canvasRef.current?.zoomOut(); return }
      if (hit('zoomReset')) { e.preventDefault(); canvasRef.current?.zoomReset(); return }
      // Sticker keeps its `tool:` key id (saved bindings) but toggles the
      // panel: it isn't a tool since 2026-11-26.
      if (hit('tool:sticker')) { toggleStickers(); return }
      const toolId = Object.keys(keys).find(id => id.startsWith('tool:') && hit(id))
      if (toolId) setTool(toolId.slice(5) as Tool)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Video action handlers ─────────────────────────────────────────────────
  // Video in this editor is view-only — Save / Copy / Upload act on the source
  // recording file directly. (Annotating video / freeze-frame export were
  // removed to keep the flow simple; bring them back in a dedicated video
  // editing module when needed.)
  // Unified action dispatcher — both modes share the same button list (from
  // deriveActions) so order and styling stay consistent. Video routes clicks
  // to file-level IPCs since there's no composite frame pipeline.
  const runVideoAction = useCallback(async (btn: ActionBtn, row?: UploadRow) => {
    // Trimmed copy when a trim is applied, else the original recording.
    const effectivePath = trimmedPath || videoFilePath
    if (!effectivePath) return
    setActionBusy(btn.key)
    try {
      if (btn.actionType === 'clipboard') {
        const res = await window.electronAPI?.videoCopyFile?.(effectivePath)
        if (res?.fallback === 'text') toast('File path copied instead', { kind: 'warning', icon: 'content_copy' })
        else                          toast('Video copied', { icon: 'content_copy' })
      } else if (btn.actionType === 'save') {
        const res = await window.electronAPI?.videoSaveAs?.(effectivePath)
        if (res && !res.canceled && res.savedPath) toast('Video saved')
      } else if (btn.key === 'upload' && row) {
        // A row with a link copies it; one without uploads there, through
        // history when the recording has a row (main dedupes, the row gets
        // its Uploaded mark), videoUpload* only without one.
        if (row.link) {
          await window.electronAPI?.writeClipboardText(row.link)
          toast('Link copied', { icon: 'link' })
        } else {
          const res = row.dest === 'r2'
            ? (historyId ? await window.electronAPI?.shareHistoryR2(historyId) : await window.electronAPI?.videoUploadR2?.(effectivePath))
            : (historyId ? await window.electronAPI?.shareHistoryGoogleDrive(historyId) : await window.electronAPI?.videoUploadGoogleDrive?.(effectivePath))
          if (res?.success && res.url) {
            toast(row.dest === 'r2' ? 'Uploaded, link copied' : 'Uploaded to Drive, link copied')
            const url = res.url
            setUploadLinks(prev => ({ ...prev, [row.dest]: url }))
          } else {
            toastError(row.dest === 'r2' ? "Couldn't upload" : "Couldn't upload to Drive", res?.error)
          }
        }
      }
    } catch (err: any) {
      toastError(btn.actionType === 'clipboard' ? "Couldn't copy" : btn.actionType === 'save' ? "Couldn't save" : "Couldn't upload", err)
    } finally {
      setActionBusy(null)
    }
  }, [videoFilePath, trimmedPath, historyId, gdriveReady])

  // ── Trim actions ─────────────────────────────────────────────────────────
  // Only ids + numbers + a ≤480 px JPEG go to main; ffmpeg streams the cut
  // from disk to disk there. One trim at a time (buttons disabled while busy,
  // and main rejects overlapping requests).
  const applyTrim = useCallback(async () => {
    if (!historyId || trimBusy || durationMs <= 0) return
    if (sel.end - sel.start < MIN_TRIM_SELECTION_MS) return
    // Selecting the whole clip again is the same as removing the trim.
    if (selIsFull && !appliedTrim) return
    setTrimBusy(true)
    try {
      videoRef.current?.pause()
      const thumb = await grabVideoFrame(videoSrc, { ms: selIsFull ? 0 : sel.start })
      const res = selIsFull
        ? await window.electronAPI?.videoClearTrim(historyId, thumb)
        : await window.electronAPI?.videoTrim(historyId, sel.start, sel.end, thumb)
      if (!res?.ok) { toastError(selIsFull ? "Couldn't remove trim" : "Couldn't trim", res?.error); return }
      const trimmedFile = res.item?.annotatedFilePath
      setTrimmedPath(trimmedFile)
      setAppliedTrim(res.item?.trim)
      setUploadLinks(uploadLinksOf(res.item?.uploads))
      seekVideo(selIsFull ? 0 : sel.start)
      if (selIsFull || !trimmedFile) {
        toast(selIsFull ? 'Trim removed' : 'Trimmed, original kept', { icon: selIsFull ? 'restart_alt' : 'cut' })
      } else {
        // Put the trimmed clip straight on the clipboard so it can be pasted
        // into chat / Explorer / Finder without another click. A clipboard
        // failure doesn't undo the trim — just say so.
        const copy = await window.electronAPI?.videoCopyFile?.(trimmedFile).catch(() => undefined)
        if (copy?.ok && copy.fallback !== 'text') toast('Trimmed and copied', { icon: 'content_copy' })
        else toast("Trimmed, couldn't copy video", { kind: 'warning', icon: 'cut' })
      }
    } catch (err: any) {
      toastError(selIsFull ? "Couldn't remove trim" : "Couldn't trim", err)
    } finally {
      setTrimBusy(false)
    }
  }, [historyId, trimBusy, durationMs, sel, selIsFull, appliedTrim, videoSrc, seekVideo])

  const resetTrim = useCallback(async () => {
    if (!historyId || trimBusy) return
    // Unapplied selection change: just snap the handles back. Only a Reset
    // with nothing pending removes the applied trim.
    if (trimDirty) {
      setSel(appliedTrim
        ? { start: appliedTrim.startMs, end: Math.min(appliedTrim.endMs, durationMs) }
        : { start: 0, end: durationMs })
      return
    }
    if (!appliedTrim) return
    setTrimBusy(true)
    try {
      const thumb = await grabVideoFrame(videoSrc, { ms: 0 })
      const res = await window.electronAPI?.videoClearTrim(historyId, thumb)
      if (!res?.ok) { toastError("Couldn't remove trim", res?.error); return }
      setTrimmedPath(undefined)
      setAppliedTrim(undefined)
      setUploadLinks(uploadLinksOf(res.item?.uploads))
      toast('Trim removed', { icon: 'restart_alt' })
    } catch (err: any) {
      toastError("Couldn't remove trim", err)
    } finally {
      setTrimBusy(false)
    }
  }, [historyId, trimBusy, trimDirty, appliedTrim, durationMs, videoSrc])

  // D / F set the selection edge at the playhead; Space plays/pauses (skipped
  // when the native player or a button has focus — they handle Space already).
  // ←/→ step one frame, Shift+←/→ ten. Listened in the capture phase so a
  // focused native <video> doesn't also run its own ±5 s arrow-key seek
  // (Blink skips an element's default handler once defaultPrevented).
  useEffect(() => {
    if (!isVideo || !historyId || durationMs <= 0) return
    const onKey = (e: KeyboardEvent) => {
      if (trimBusy) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return
      const v = videoRef.current
      if (!v) return
      const now = Math.round(v.currentTime * 1000)
      // Keys from the keymap (Settings › Hotkeys, 2026-11-24).
      const keys = videoKeysRef.current
      const hit = (id: string) => matchesBinding(keys[id], e, isMac)
      const step = hit('stepBack') ? -1 : hit('stepForward') ? 1 : hit('stepBack10') ? -10 : hit('stepForward10') ? 10 : 0
      if (hit('trimStart')) {
        e.preventDefault()
        setSel(s => ({ start: Math.max(0, Math.min(now, s.end - MIN_TRIM_SELECTION_MS)), end: s.end }))
      } else if (hit('trimEnd')) {
        e.preventDefault()
        setSel(s => ({ start: s.start, end: Math.min(durationMs, Math.max(now, s.start + MIN_TRIM_SELECTION_MS)) }))
      } else if (step) {
        e.preventDefault()
        e.stopPropagation()
        v.pause()
        // Read currentTime (not React state) so held / rapid presses
        // accumulate even before the seek lands and timeupdate fires.
        const from = seekTargetRef.current ?? v.currentTime * 1000
        seekVideo(Math.min(sel.end, Math.max(sel.start, from + step * frameMs)))
      } else if (hit('playPause') && !(e.code === 'Space' && t?.closest?.('button'))) {
        e.preventDefault()
        if (v.paused) void v.play(); else v.pause()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isVideo, historyId, durationMs, trimBusy, seekVideo, sel.start, sel.end, frameMs])

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
  // tool). Stickers are skipped: they carry no style. Deselecting keeps tool + values for the next shape.
  // A selected shape's colour and stroke show in the toolbar (so changing
  // them restyles it). The tool stays the one you picked (2026-11-23: it
  // used to switch to the shape's kind, so selecting with Cursor jumped to
  // Pen).
  // The selected shape's kind: the toolbar shows that kind's options while
  // it's selected (2026-11-23).
  const [selectedType, setSelectedType] = useState<Tool | null>(null)
  const handleSelectionChange = useCallback((sel: SelectionInfo | null) => {
    setSelectedType(sel ? sel.type : null)
    if (!sel || sel.type === 'sticker' || sel.type === 'none') return
    setColor(sel.color)
    setStrokeWidth(sel.strokeWidth)
  }, [])

  const handleExport = useCallback(async (dataUrl: string) => {
    setExportTrigger(0)

    const pendingRaw = pendingAction.current
    pendingAction.current = null
    const pending = pendingRaw ? JSON.parse(pendingRaw) as {
      key: string; templateId: string; destinationIndex?: number; actionType?: 'clipboard' | 'save'; row?: UploadRow
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
    // Only after a real edit in this session (2026-11-23): a save with
    // shapes that differ from the stored ones clears the row's uploads
    // (design/IMAGE-EDITOR.md), and an untouched image's sidecar is current.
    if (historyId && !isVideo && canvasRef.current && userEditedRef.current) {
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
    const { key, templateId, destinationIndex, actionType, row } = pending
    setActionBusy(key)
    // Upload (2026-11-23): through the history row, after the save above
    // wrote the flattened copy (and, after an edit, cleared stale uploads).
    if (key === 'upload' && row && historyId) {
      try {
        const res = row.dest === 'r2'
          ? await window.electronAPI?.shareHistoryR2(historyId)
          : await window.electronAPI?.shareHistoryGoogleDrive(historyId)
        if (res?.success && res.url) {
          toast(row.dest === 'r2' ? 'Uploaded, link copied' : 'Uploaded to Drive, link copied')
          const url = res.url
          setUploadLinks(prev => ({ ...prev, [row.dest]: url }))
        } else {
          toastError(row.dest === 'r2' ? "Couldn't upload" : "Couldn't upload to Drive", res?.error)
        }
      } catch (err: any) {
        toastError(row.dest === 'r2' ? "Couldn't upload" : "Couldn't upload to Drive", err)
      } finally {
        setActionBusy(null)
      }
      return
    }
    if (actionType) {
      window.electronAPI?.runInlineAction(actionType, dataUrl, historyId)
        .then((res) => {
          if (res?.canceled) return // user dismissed the save dialog
          if (actionType === 'clipboard') toast('Image copied', { icon: 'content_copy' })
          else toast('Image saved')
        })
        .catch((err) => toastError(actionType === 'clipboard' ? "Couldn't copy" : "Couldn't save", err))
        .finally(() => setActionBusy(null))
      return
    }
    window.electronAPI?.runWorkflow(templateId, dataUrl, destinationIndex, historyId)
      .then((r) => {
        if (r?.uploads?.some(u => u.url))  toast('Uploaded, link copied')
        else if (r?.copiedToClipboard)     toast('Image copied', { icon: 'content_copy' })
        else if (r?.savedPath)             toast('Image saved')
        else                               toast('Workflow finished')
      })
      .catch((err) => toastError("Couldn't run workflow", err))
      .finally(() => setActionBusy(null))
  }, [historyId, isVideo])

  const triggerAction = (key: string, templateId: string, destinationIndex?: number, actionType?: 'clipboard' | 'save', row?: UploadRow) => {
    pendingAction.current = JSON.stringify({ key, templateId, destinationIndex, actionType, row })
    setExportTrigger((n) => n + 1)
  }

  // Recent images (2026-11-23): switch the editor to another image, its
  // saved drawings, links and view with it.
  const pickRecent = useCallback(async (id: string) => {
    const item = clipboardHistory.find(c => c.id === id)
    if (!item) return
    const dataUrl = await loadClipboardItem(item)
    if (!dataUrl) return
    // Re-tag historyId + annotations so later Upload / Save flows target
    // this entry, not the image the editor was on before.
    setHistoryId(item.id)
    setInitialAnnotations(item.annotations)
    setUploadLinks(uploadLinksOf(item.uploads))
    userEditedRef.current = false
    resetForNewImage(dataUrl)
    // The panel stays open (2026-11-23), so you can hop through images.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipboardHistory, loadClipboardItem])

  // One Upload menu row (or the only destination): copy its link, or upload
  // there (a recording from its file, an image through its export).
  const uploadTo = (row: UploadRow) => {
    if (row.link) {
      const link = row.link
      void window.electronAPI?.writeClipboardText(link).then(() => toast('Link copied', { icon: 'link' }))
      return
    }
    if (isVideo) { if (uploadBtn) void runVideoAction(uploadBtn, row); return }
    triggerAction('upload', '', undefined, undefined, row)
  }

  // Cmd/Ctrl+C copies the *annotated* image, same as the Copy button. Without
  // this the chord fell through to the menu's role:'copy' (a no-op with no DOM
  // text selected), and the clipboard kept the raw screenshot that capture.ts
  // auto-copies at capture time — so pasting dropped every drawing/text.
  const triggerActionRef = useRef(triggerAction)
  triggerActionRef.current = triggerAction
  useEffect(() => {
    if (isVideo) return
    const onKey = (e: KeyboardEvent) => {
      if (!matchesBinding(imageKeysRef.current.copy, e, isMac) || e.repeat) return
      // Let native copy work while typing in a text annotation / input, or
      // when the user has deliberately selected DOM text.
      if ((e.target as HTMLElement | null)?.closest?.('textarea, input, [contenteditable="true"]')) return
      if (window.getSelection()?.toString()) return
      if (actionBusy) return
      e.preventDefault()
      triggerActionRef.current('clipboard', activeTemplate?.id ?? '', undefined, 'clipboard')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isVideo, actionBusy, activeTemplate])

  // ── Edit history (History › Edits, 2026-11-23) ──────────────────────────
  // The open image's undo steps, saved per image (when the saveEditHistory
  // setting is on) and loaded before the canvas opens, so Undo and the
  // Edits tab carry on where you left off. Saved steps are only used when
  // they end on the image's saved drawings (anything else changed them:
  // a restore from the cloud, an older build); else the drawings are
  // replayed shape by shape as before.
  const [loadedSteps, setLoadedSteps] = useState<{ key: string; steps?: { steps: DrawObject[][]; cursor: number; dropped: number } } | null>(null)
  const stepsKey = `${historyId ?? ''}|${imageDataUrl.length}|${imageDataUrl.slice(-32)}`
  useEffect(() => {
    if (isVideo || !imageDataUrl) return
    let alive = true
    const done = (steps?: { steps: DrawObject[][]; cursor: number; dropped: number }) => { if (alive) setLoadedSteps({ key: stepsKey, steps }) }
    if (!historyId) { done(); return }
    window.electronAPI?.getEditHistory?.(historyId).then(raw => {
      const h = unpackHistory(raw)
      if (!h) { done(); return }
      const want = JSON.stringify(initialAnnotations ?? [])
      if (JSON.stringify(h.steps[h.cursor]) !== want) { done(); return }
      const dropped = typeof (raw as { dropped?: unknown })?.dropped === 'number' ? (raw as { dropped: number }).dropped : 0
      done({ steps: h.steps as DrawObject[][], cursor: h.cursor, dropped })
    }).catch(() => done())
    return () => { alive = false }
  // initialAnnotations travels with historyId (set together).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsKey, isVideo])
  const canvasReady = !!loadedSteps && loadedSteps.key === stepsKey

  const [editSteps, setEditSteps] = useState<{ steps: DrawObject[][]; cursor: number; dropped: number }>({ steps: [[]], cursor: 0, dropped: 0 })
  const stepRows = useMemo(() => editSteps.steps.map((step, i) =>
    i === 0
      // The Original row shows the image itself (2026-11-23).
      ? (editSteps.dropped > 0 ? { label: 'Earlier steps', icon: 'history' } : { label: 'Original', icon: 'image', image: imageDataUrl || undefined })
      : describeStep(editSteps.steps[i - 1] as StepObject[], step as StepObject[]),
  ), [editSteps, imageDataUrl])
  // The steps waiting to be saved are written at once when the editor
  // closes or moves on to another image (2026-11-27: closing within the
  // 600ms dropped them, and the next open then threw the saved steps away
  // because they no longer ended on the saved drawings).
  const stepsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingSteps = useRef<{ id: string; steps: DrawObject[][]; cursor: number; dropped: number } | null>(null)
  const flushSteps = useCallback(() => {
    clearTimeout(stepsSaveTimer.current)
    const p = pendingSteps.current
    pendingSteps.current = null
    if (p) void window.electronAPI?.saveEditHistory?.(p.id, { ...packHistory(p.steps as StepObject[][], p.cursor), dropped: p.dropped })
  }, [])
  useEffect(() => flushSteps, [flushSteps])
  // A live thumbnail of the open image (2026-11-23): rendered small from the
  // canvas after each edit (a few ms), shown in Recent images at once
  // instead of waiting ~1-2s for the save to write the real one.
  const [livePreview, setLivePreview] = useState<{ id: string; url: string } | null>(null)
  const livePreviewFrame = useRef(0)
  const handleStepsChange = useCallback((steps: DrawObject[][], cursor: number, dropped: number) => {
    setEditSteps({ steps, cursor, dropped })
    if (historyId && userEditedRef.current) {
      const id = historyId
      cancelAnimationFrame(livePreviewFrame.current)
      livePreviewFrame.current = requestAnimationFrame(() => {
        const url = canvasRef.current?.toPreviewDataURL(960)
        if (url) setLivePreview({ id, url })
      })
    }
    // Saved only after a real edit in this session (opening isn't one).
    if (!historyId || !userEditedRef.current) return
    const id = historyId
    if (pendingSteps.current && pendingSteps.current.id !== id) flushSteps()
    clearTimeout(stepsSaveTimer.current)
    pendingSteps.current = { id, steps, cursor, dropped }
    stepsSaveTimer.current = setTimeout(flushSteps, 600)
  }, [historyId, flushSteps])
  // Layers first (2026-11-23).
  const [historyTab, setHistoryTab] = useState<'layers' | 'edits' | 'images'>('layers')
  // Floating panel / toolbar / trim bar margins (2026-11-24): 10px from
  // the window's sides, so with their 10px inner padding every right-hand
  // icon sits on the AppBar's 20px line; 20px to the app bars above and
  // below, for more room there. (--mx / --my, also read by the History
  // panel and the trim bar.)
  const EDGE_X = 10
  const EDGE_Y = 20
  // The shape of the Layers / Edits row under the pointer, outlined on the canvas.
  const [hoverShapeId, setHoverShapeId] = useState<string | null>(null)
  useEffect(() => { if (!showClipPanel || historyTab === 'images') setHoverShapeId(null) }, [showClipPanel, historyTab])
  // Layers tab: the selected shapes (from the canvas) and the drawing now.
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([])
  const layerObjects = (editSteps.steps[editSteps.cursor] ?? []) as StepObject[]
  const selectLayer = useCallback((id: string, toggle: boolean) => {
    // Only Cursor selects: picking a layer switches to it, as a click on
    // the canvas would need.
    setTool('none')
    canvasRef.current?.selectShapes([id], toggle)
  }, [])

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
      // An edit makes the uploaded copy stale (2026-11-23): Upload shows
      // again; main clears the row's uploads on the save below.
      setUploadLinks(prev => (Object.keys(prev).length ? {} : prev))
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
    // Cursor, so the freshly placed sticker is selected and can be moved.
    // The panel stays open for the next one (2026-11-26); a press on the
    // canvas closes it, like History.
    setTool('none')
  }, [])

  // Dragging a sticker onto the image (2026-11-26; native drag and drop
  // before, which didn't place it). The panel hands the drag over once a
  // press moves past its slop and stays open until the pointer leaves it
  // (let go inside it, nothing is placed and it stays open); a ghost of the sticker, at the
  // size it will land at, follows the pointer (a see-through layer over
  // the window holds it and the closed hand, and keeps the canvas from
  // reacting); let go over the canvas area places it there (kept inside
  // the image), then Cursor with it selected, as after a click. Let go
  // anywhere else, or Esc, drops nothing.
  type StickerDrag = { path: string; dataUrl: string; aspect: number; w: number; h: number; x: number; y: number }
  const [stickerDrag, setStickerDrag] = useState<StickerDrag | null>(null)
  const stickerDragRef = useRef<StickerDrag | null>(null)
  stickerDragRef.current = stickerDrag
  const dragLayerRef = useRef<HTMLDivElement>(null)
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  const closeStickers = useCallback(() => setStickersOpen(false), [setStickersOpen])
  const handleStickerDragOut = useCallback((s: PickedSticker, x: number, y: number) => {
    const aspect = s.natural.h > 0 ? s.natural.w / s.natural.h : 1
    const size = canvasRef.current?.stickerScreenSize(aspect) ?? { w: 80, h: 80 / aspect }
    setStickerDrag({ path: s.path, dataUrl: s.dataUrl, aspect, ...size, x, y })
  }, [])
  const draggingSticker = stickerDrag !== null
  useEffect(() => {
    if (!draggingSticker) return
    const onMove = (e: PointerEvent) => {
      setStickerDrag(d => d && { ...d, x: e.clientX, y: e.clientY })
      // Out of the floating sidebar's box: it closes (and stays closed if
      // the pointer comes back). Pinned, it stays.
      if (stickersPinnedRef.current) return
      const panel = document.querySelector('[data-sticker-panel]')
      if (!panel) return
      const r = panel.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setStickersOpen(false)
    }
    const onUp = (e: PointerEvent) => {
      const d = stickerDragRef.current
      setStickerDrag(null)
      if (!d) return
      // What's under the drag layer: placed only over the canvas area (not
      // the toolbar or the History panel over it).
      const under = document.elementsFromPoint(e.clientX, e.clientY).find(el => !dragLayerRef.current?.contains(el))
      if (!under || !canvasAreaRef.current?.contains(under)) return
      canvasRef.current?.addSticker({ src: d.path, aspect: d.aspect, at: { clientX: e.clientX, clientY: e.clientY } })
      pushRecentSticker(d.path)
      setTool('none')
    }
    const onCancel = () => setStickerDrag(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setStickerDrag(null) } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [draggingSticker])

  /* ── Delete (2026-11-27, right of Save) ──
     Deletes the clip like the Dashboard's Delete (no confirm), then goes
     back to the Dashboard, where its day stands in for it. Anything still
     waiting to be saved for it is dropped first, so no unmount flush writes
     edit steps or drawings for a row that no longer exists. */
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const deleteClip = useCallback(async () => {
    if (!historyId || deleting) return
    setDeleting(true)
    if (annotationSaveTimer.current) { clearTimeout(annotationSaveTimer.current); annotationSaveTimer.current = null }
    pendingAnnotationSave.current = null
    clearTimeout(stepsSaveTimer.current)
    pendingSteps.current = null
    clearTimeout(viewTimer.current)
    pendingView.current = null
    // Let go of the video file first: Windows can't delete a file a player
    // still holds open.
    const v = videoRef.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    try {
      await window.electronAPI?.deleteHistoryItem(historyId)
      forgetClip(historyId)
      navigate('/dashboard')
    } catch {
      setDeleting(false)
    }
  }, [historyId, deleting, navigate])

  /* ── Nothing to edit: go to the Dashboard ──
     Every normal way in hands over an image or a video, so this only
     catches stray routes (an old /video-annotator link, /editor without
     state). It used to show a "Ready to annotate" empty state with a video
     variant no path could reach (removed 2026-11-22). */
  const hasSource = isVideo ? !!videoFilePath : !!imageDataUrl
  if (!hasSource) return <Navigate to="/dashboard" replace />

  // The History panel, floating over the canvas or, pinned, docked beside
  // it (2026-11-23).
  const historyPanel = (
    <HistoryPanel
      tab={historyTab}
      onTab={setHistoryTab}
      steps={stepRows}
      cursor={editSteps.cursor}
      onStep={i => canvasRef.current?.goToStep(i)}
      onHoverStep={setHoverShapeId}
      layers={layerObjects}
      selectedIds={selectedShapeIds}
      onSelectLayer={selectLayer}
      onReorderLayers={ids => canvasRef.current?.reorderShapes(ids)}
      onToggleLayerHidden={(id, hidden) => canvasRef.current?.setShapeHidden(id, hidden)}
      pinned={historyPinned}
      onPin={pinHistory}
      items={livePreview ? clipboardHistory.map(c => (c.id === livePreview.id ? { ...c, thumbnailUrl: livePreview.url } : c)) : clipboardHistory}
      currentId={historyId}
      onPick={item => void pickRecent(item.id)}
      onClose={() => setShowClipPanel(false)}
      timeLabel={recentTimeLabel}
    />
  )

  return (
    <div className="relative h-full flex flex-col overflow-hidden" style={{ '--mx': `${EDGE_X}px`, '--my': `${EDGE_Y}px` } as React.CSSProperties}>
      {/* ── Toast ── solid, no blur or slide (2026-11-22) */}

      {/* ── The editor's file actions, in the AppBar's slot (2026-11-22; it
           had its own top bar): Copy · Save · Delete · Upload. Zoom and History
           moved into the floating toolbar (2026-11-23). ── */}
      <AppBarControls>
        {!isVideo && (
          <div className="flex items-center gap-3">
            {/* Opens the Background callout; while it's open the on state
                (the 3px accent strip) and no tooltip, like the toolbar's
                Palette (Callouts and menus). */}
            <button
              ref={bgBtnRef}
              onClick={() => setBgOpen(o => !o)}
              className={`${ICON_BUTTON} group/on relative`}
              data-tip={bgOpen ? undefined : 'Background'}
              aria-label="Background"
              aria-expanded={bgOpen}
            >
              <Icon name="background" className="text-[16px]" />
              {bgOpen && <OnStrip />}
            </button>
          </div>
        )}
        {(fileBtns.length > 0 || uploadBtn) && (
          <div className="flex items-center gap-3">
            {/* Icon buttons only, like the rest of the AppBar (2026-11-22;
                 text buttons tried): the list rows' icons and tooltips. */}
            {[...fileBtns, ...(historyId ? [DELETE_SLOT] : []), ...(uploadBtn ? [uploadBtn] : [])].map((btn) => {
              if (btn === DELETE_SLOT) return (
                <button
                  key="delete"
                  onClick={() => { void deleteClip() }}
                  disabled={deleting || !!actionBusy || trimBusy}
                  className={DANGER_ICON_BUTTON}
                  data-tip="Delete"
                  aria-label="Delete"
                >
                  <Icon name="delete" className="text-[16px]" />
                </button>
              )
              const isUpload = btn === uploadBtn
              const busy = actionBusy === btn.key
              // As on the Dashboard: Upload while any place still needs an
              // upload, the link once every place has one; uploading spins
              // `sync` (2026-11-23).
              const linked = isUpload && uploadChoices.every(r => r.link)
              const label = isUpload ? (linked ? 'Copy link' : 'Upload') : btn.label
              const icon = isUpload ? (linked ? 'link' : 'add_to_drive') : btn.icon
              return (
                <button
                  key={btn.key}
                  onClick={e => {
                    if (!isUpload) {
                      if (isVideo) void runVideoAction(btn)
                      else triggerAction(btn.key, btn.templateId, btn.destinationIndex, btn.actionType)
                      return
                    }
                    if (uploadMenu) { setUploadMenu(null); return } // a second click closes it
                    if (uploadChoices.length === 1) { uploadTo(uploadChoices[0]); return }
                    setUploadMenu({ anchor: e.currentTarget.getBoundingClientRect(), anchorEl: e.currentTarget, rows: uploadChoices })
                  }}
                  disabled={!!actionBusy || trimBusy || (isVideo && !videoFilePath)}
                  className={ICON_BUTTON}
                  data-tip={isUpload && uploadMenu ? undefined : busy ? `${label === 'Copy' || label === 'Copy link' ? 'Copying' : label === 'Save' ? 'Saving' : 'Uploading'}…` : label}
                  aria-label={label}
                >
                  {busy
                    ? <Icon name={isUpload && !linked ? 'sync' : 'progress_activity'} className="text-[16px] animate-spin" />
                    : <Icon name={icon} className="text-[16px]" />}
                </button>
              )
            })}
          </div>
        )}
      </AppBarControls>
      {uploadMenu && uploadBtn && (
        <UploadMenu
          anchor={uploadMenu.anchor}
          anchorEl={uploadMenu.anchorEl}
          rows={uploadMenu.rows}
          onClose={closeUploadMenu}
          onPick={row => { setUploadMenu(null); uploadTo(row) }}
        />
      )}

      {/* ── Main area ── (relative: the History panel is placed in it) */}
      <div className="relative flex flex-1 overflow-hidden">

        {/* ── Canvas container ── */}
        {/* The Dashboard's clip area fill, no dot pattern (video 2026-11-22,
             image 2026-11-23). */}
        <div
          className="flex-1 relative overflow-hidden bg-content"
        >
          {!isVideo && bgOpen && bgBtnRef.current && (
            <BackgroundPanel bg={bg} onChange={setBg} anchorEl={bgBtnRef.current} onClose={closeBgPanel} />
          )}
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
                  // No native controls (2026-11-22): play / pause and mute
                  // are ours, in the trim bar; a click here plays or pauses.
                  onClick={togglePlay}
                  playsInline
                  muted={muted}
                  preload="auto"
                  onLoadedMetadata={onVideoMeta}
                  onLoadedData={e => checkAudio(e.currentTarget)}
                  onDurationChange={onVideoDuration}
                  onTimeUpdate={onVideoTime}
                  onPlay={e => { setPlaying(true); onVideoPlay(e) }}
                  onPause={() => setPlaying(false)}
                  onVolumeChange={e => setMuted(e.currentTarget.muted)}
                  style={
                    videoDisplaySize
                      ? { width: videoDisplaySize.width, height: videoDisplaySize.height }
                      : { maxWidth: '100%', maxHeight: '100%' }
                  }
                />
              </div>
            ) : (
              // The app's wait: the 16px spinner beside its label
              // (STYLEGUIDE › Dialogs › Waits; it was a hand-made 24px ring
              // over the label).
              <div className="h-full flex items-center justify-center gap-2 text-xs font-medium text-fg-secondary">
                <Icon name="progress_activity" className="text-[16px] animate-spin" />
                Loading video…
              </div>
            )
          ) : (
            <>
            {/* The canvas fills the whole area and the toolbar floats over the
                image (2026-11-23). It used to stop 76px above the bottom so
                the toolbar never covered a fitted image; with images at
                actual size that cut them off and left an empty band behind
                the toolbar. */}
            <div
              // Stickers dragged from the panel land here (stickerDrag).
              ref={canvasAreaRef}
              className="absolute inset-0"
            >
            {canvasReady && <AnnotationCanvas
              ref={canvasRef}
              key={stepsKey}
              background={{ kind: 'image', dataUrl: imageDataUrl }}
              frame={bgFrame}
              tool={tool}
              color={color}
              strokeWidth={strokeWidth}
              onExport={handleExport}
              exportTrigger={exportTrigger}
              onHistoryChange={handleHistoryChange}
              onZoomChange={setZoomLevel}
              onActivityChange={setCanvasActivity}
              // Each image reopens at the zoom and pan it was left at
              // (2026-11-23, lib/editor-view.ts).
              initialView={historyId ? getEditorView(historyId) : undefined}
              onViewChange={saveView}
              onSelectionChange={handleSelectionChange}
              onSelectedIdsChange={setSelectedShapeIds}
              initialObjects={initialAnnotations as DrawObject[] | undefined}
              initialSteps={loadedSteps?.steps}
              onStepsChange={handleStepsChange}
              highlightId={hoverShapeId}
              keyToDrag={keyToDrag}
              keymap={imageKeys}
            />}
            </div>
            {/* The floating toolbar (2026-11-23, design/IMAGE-EDITOR.md): the
                video trim bar's box and place, inside the canvas area (it
                ends at the History panel when that's open). */}
            {/* Docked History panel (2026-11-23): the image stays where it
                is (the panel lies over the canvas's right side, like a side
                panel in Figma); only the toolbar makes room, its right edge
                gliding in by the panel's width at the panel's pace. */}
            <div
              // pointer-events-none: once the toolbar has faded, this box
              // must not sit over the canvas and swallow a stroke's moves.
              className="absolute z-20 pointer-events-none transition-[left,right] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
              // Pinned panel: the toolbar ends 10px (EDGE_X) left of it.
              // Pinned sticker sidebar: the toolbar starts 10px right of it.
              style={{ left: EDGE_X + (stickersOpen && stickersPinned ? STICKER_PANEL_W + EDGE_X : 0), bottom: EDGE_Y, right: EDGE_X + (showClipPanel && historyPinned ? panelWidth + EDGE_X : 0) }}
            >
              {/* Fades like the video trim bar (2026-11-25); its own
                  layer, since the wrapper's transition is on `right`. */}
              <div className={`${autoHideClass(autoHide.shown)} ${autoHide.shown ? 'pointer-events-auto' : ''}`} {...autoHide.hold}>
              <AnnotationToolBar
                tool={tool} setTool={setTool}
                selectedType={selectedType}
                color={color} setColor={pickColor}
                strokeWidth={strokeWidth} setStrokeWidth={pickStrokeWidth}
                canUndo={canUndo} canRedo={canRedo}
                onUndo={() => canvasRef.current?.undo()}
                onRedo={() => canvasRef.current?.redo()}
                onClear={() => canvasRef.current?.clear()}
                zoomLevel={zoomLevel}
                onZoomIn={() => canvasRef.current?.zoomIn()}
                onZoomOut={() => canvasRef.current?.zoomOut()}
                onZoomReset={() => canvasRef.current?.zoomReset()}
                historyOpen={showClipPanel}
                onToggleHistory={() => setShowClipPanel(p => !p)}
                keymap={imageKeys}
                stickersOpen={stickersOpen}
                onToggleStickers={toggleStickers}
              />
              </div>
            </div>
            </>
          )}
        </div>

        {/* The History panel itself, floating or docked (one element). */}
        {!isVideo && showClipPanel && historyPanel}
        {/* The sticker sidebar, History mirrored at the left (2026-11-26). */}
        {!isVideo && stickersOpen && (
          <StickerPicker
            onSelect={handlePickSticker}
            onDragOut={handleStickerDragOut}
            onClose={closeStickers}
            focusSearch={stickersByUserRef.current}
            pinned={stickersPinned}
            onPin={pinStickers}
          />
        )}

        {/* A sticker being dragged onto the image: the layer and its ghost
            (handleStickerDragOut). Over the whole window, so the closed
            hand shows everywhere and nothing under it reacts. */}
        {stickerDrag && createPortal(
          <div ref={dragLayerRef} className="fixed inset-0 z-[200] cursor-grabbing">
            <img
              src={stickerDrag.dataUrl}
              alt=""
              draggable={false}
              className="absolute pointer-events-none opacity-60"
              style={{ left: stickerDrag.x - stickerDrag.w / 2, top: stickerDrag.y - stickerDrag.h / 2, width: stickerDrag.w, height: stickerDrag.h }}
            />
          </div>,
          document.body,
        )}
      </div>

      {/* Trim bar — recordings opened from history only (the trim lives on
           the history row). Playback itself stays on native <video controls>. */}
      {isVideo && historyId && durationMs > 0 && (
        <VideoTrimBar
          filmstrip={filmstrip}
          durationMs={durationMs}
          currentMs={currentMs}
          startMs={sel.start}
          endMs={sel.end}
          onChange={(start, end) => setSel({ start, end })}
          onSeek={seekVideo}
          onPreview={previewFrame}
          dirty={trimDirty}
          hasAppliedTrim={!!appliedTrim}
          snappedMs={appliedTrim ? appliedTrim.startMs - appliedTrim.actualStartMs : 0}
          busy={trimBusy}
          disabled={!!actionBusy}
          onApply={applyTrim}
          onReset={resetTrim}
          playing={playing}
          autoHide={autoHide}
          onTogglePlay={togglePlay}
          muted={muted}
          hasAudio={hasAudio}
          onToggleMute={toggleMute}
        />
      )}

    </div>
  )
}
