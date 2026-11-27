import { useState, useEffect, useMemo, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HistoryItem } from '../../types'
import { durationParts, formatDimensions, recordingLengthMs, fileTipText } from '../../utils/captureLabels'
import { useSelectGestures } from './useSelectGestures'
import { ClipActionButton } from '../../components/ClipActionButton'
import { ICON_BUTTON_FRAME } from '../../components/button-classes'
import { OnStrip } from '../../components/OnStrip'
import BrowserPickerDialog from '../../components/BrowserPickerDialog'
import { DaySections } from '../../components/DaySections'
import { useDayHistory } from './useDayHistory'
import { noteOpenedClip } from '../../lib/dashboard-place'
import { reportFileGone } from '../../lib/strip-worker'
import { refreshRecordingThumbnails } from '../../lib/refresh-thumbnails'
import { HistoryListRow, clipSource, SourceText } from '../../components/HistoryListRow'
import { copyHistoryItem, shareHistoryItem, shareHistoryGoogleDrive, editorStateFor } from '../../lib/history-actions'

import { Icon } from '../../components/Icon'
import { AppBarControls } from '../../components/AppBarSlot'
import { UploadMenu } from '../../components/UploadMenu'
import { uploadLinksOf, uploadRows, type UploadRow } from '../../lib/upload-choice'
import { Segmented } from '../../components/Segmented'
import { toast, toastError, dismissToast } from '../../lib/toast'
type CaptureMode = 'region' | 'window' | 'all-screen' | 'screen'
type VideoMode = 'region' | 'window' | 'screen'
type MediaKind = 'image' | 'video' | 'scroll'
type ScrollMethod = 'extension' | 'screen'
type FilterType = 'all' | 'screenshot' | 'recording'
type ViewMode = 'grid' | 'list'

// Public Chrome Web Store listing for the Lumia Scroll Capture extension, from
// RENDERER_VITE_CHROME_WEB_STORE_URL in .env (baked into the renderer at build
// time; e.g. https://chromewebstore.google.com/detail/<extension-id>). When
// unset the setup panel shows the manual "Load unpacked" flow only.
const CHROME_WEB_STORE_URL = import.meta.env.RENDERER_VITE_CHROME_WEB_STORE_URL ?? ''

// Map capture mode → hotkey action name (from electron/hotkeys.ts)
const MODE_ACTION: Record<CaptureMode, string> = {
  region: 'RectangleRegion',
  window: 'ActiveWindow',
 'all-screen': 'PrintScreen',
  screen: 'ActiveMonitor',
}

const VIDEO_MODE_ACTION: Record<VideoMode, string> = {
  region: 'ScreenRecorder',
  window: 'ScreenRecorderWindow',
  screen: 'ScreenRecorderScreen',
}

const CAPTURE_MODES: { mode: CaptureMode; icon: string; label: string }[] = [
  { mode: 'region',     icon: 'crop',        label: 'Region' },
  { mode: 'window',     icon: 'web_asset',   label: 'Window' },
  { mode: 'screen',     icon: 'monitor',     label: 'Screen' },
  { mode: 'all-screen', icon: 'tv_displays', label: 'All Screens' },
]

const VIDEO_MODES: { mode: VideoMode; icon: string; label: string }[] = [
  { mode: 'region', icon: 'crop',      label: 'Region' },
  { mode: 'window', icon: 'web_asset', label: 'Window' },
  { mode: 'screen', icon: 'monitor',   label: 'Screen' },
]

/** Parse an Electron accelerator string like "Ctrl+Shift+4" into display keys */
function parseShortcut(accel: string): string[] {
  return accel.split('+').map(k => {
    if (k === 'CommandOrControl' || k === 'CmdOrCtrl') return 'Ctrl'
    return k
  })
}

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5 mt-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="min-w-[20px] h-5 inline-flex items-center justify-center text-[10px] text-fg-secondary font-medium bg-fill border border-line rounded px-1 leading-none"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Late night session'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function Dashboard() {
  const navigate = useNavigate()
  // Remembered like the view mode (2026-11-22), so leaving the Dashboard
  // (Settings, the editor) and coming back keeps the type filter.
  const [filter, setFilter] = useState<FilterType>(() => {
    const saved = localStorage.getItem('lumia:history-filter')
    return saved === 'screenshot' || saved === 'recording' ? saved : 'all'
  })
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})
  const [mediaKind, setMediaKind] = useState<MediaKind>('image')
  const [captureSelf, setCaptureSelf] = useState(false)
  const [scrollMethod, setScrollMethod] = useState<ScrollMethod>('screen')
  const [extStatus, setExtStatus] = useState<{ connected: boolean; browsers: string[]; outdated?: string[]; bundledVersion?: string | null }>({ connected: false, browsers: [] })
  const [showExtSetup, setShowExtSetup] = useState(false)
  const [storeUrlCopied, setStoreUrlCopied] = useState(false)
  const [showBrowserPicker, setShowBrowserPicker] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (localStorage.getItem('lumia:history-view') as ViewMode) || 'grid'
  )
  const [isSelecting, setIsSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  // History by day: stats for every count, rows only for loaded days.
  const { stats, days, rows, loadDays, dropDays, refresh } = useDayHistory(filter)
  const [sharingId, setSharingId] = useState<string | null>(null)
  const [sharingGdriveId, setSharingGdriveId] = useState<string | null>(null)
  const [gdriveReady, setGdriveReady] = useState(false)
  // Share uploads to R2; a build without R2 credentials shows it disabled.
  const [shareReady, setShareReady] = useState(true)

  // Cmd (Ctrl on Windows) held: clips show the pointing hand, a click
  // reveals the file (useSelectGestures). Read from every key and pointer
  // event, so a key let go outside the window doesn't stick.
  useEffect(() => {
    const mac = document.documentElement.classList.contains('mac')
    const set = (on: boolean) => document.documentElement.classList.toggle('reveal-key', on)
    const fromEvent = (e: KeyboardEvent | PointerEvent) => set(mac ? e.metaKey : e.ctrlKey)
    const off = () => set(false)
    window.addEventListener('keydown', fromEvent, true)
    window.addEventListener('keyup', fromEvent, true)
    window.addEventListener('pointermove', fromEvent, true)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('keydown', fromEvent, true)
      window.removeEventListener('keyup', fromEvent, true)
      window.removeEventListener('pointermove', fromEvent, true)
      window.removeEventListener('blur', off)
      off()
    }
  }, [])

  useEffect(() => {
    // One-time: larger thumbnails for recordings made before the size change.
    refreshRecordingThumbnails()
    window.electronAPI?.r2IsConfigured?.().then(ok => setShareReady(!!ok))
    const refreshGdriveReady = () => {
      window.electronAPI?.getSettings().then(s => {
        setGdriveReady(!!(s?.googleDriveConnected && s?.googleDriveFolderId))
      })
    }
    refreshGdriveReady()
    // The removed launcher's loading (its hotkeys, last kind, "include
    // Lumia's own window" and the extension's status, each kept in state
    // nothing reads) went on 2026-11-27: the status listener re-rendered the
    // whole Dashboard on every extension change. It's written down with the
    // launcher in design/DASHBOARD-TOP-SECTION.md, to come back with it.
    // Main asks for the browser picker when an extension capture starts with
    // several browsers connected (Dashboard card, hotkey, or New Capture).
    window.electronAPI?.onScrollExtensionPick?.(() => setShowBrowserPicker(true))
    // Settings can change while we're on this view (user goes to Settings,
    // connects Drive, comes back) — refresh on connect events + window focus.
    // History needs no refetch here: main pushes history:changed after every
    // write (useDayHistory), including captures made while hidden in the tray.
    window.electronAPI?.onGdriveConnected(refreshGdriveReady)
    const onWindowFocus = () => {
      refreshGdriveReady()
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      window.electronAPI?.removeAllListeners('scroll-extension:pick')
      window.electronAPI?.removeAllListeners('gdrive:connected')
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  const selectMediaKind = (kind: MediaKind) => {
    setMediaKind(kind)
    // Scroll is a deliberate, explicit capture — never remember it as the kind
    // that "New Capture" / PrtSc replays. Only image/video are remembered.
    if (kind !== 'scroll') window.electronAPI?.setSetting('lastCaptureKind', kind)
  }

  const handleCapture = async (mode: CaptureMode) => {
    // Every tool is remembered for New capture / PrintScreen (main's
    // settings:set checks the value: isImageMode in settings.ts).
    window.electronAPI?.setSetting('lastCaptureKind', 'image')
    window.electronAPI?.setSetting('lastImageMode', mode)
    // Main drives navigation via `sendCaptureToEditor` (sends a `navigate`
    // event with historyId so subsequent uploads merge into the new entry
    // instead of creating a duplicate). Don't navigate again here — that
    // overwrites the state and drops the historyId.
    await window.electronAPI?.captureScreenshot(mode)
  }

  const handleCaptureSelfChange = (v: boolean) => {
    setCaptureSelf(v)
    window.electronAPI?.setSetting('captureSelfWindow', v)
  }

  const handleVideo = (mode: VideoMode) => {
    window.electronAPI?.setSetting('lastCaptureKind', 'video')
    window.electronAPI?.setSetting('lastVideoMode', mode)
    window.electronAPI?.startVideoCapture?.(mode)
  }

  const handleScroll = async (method: ScrollMethod) => {
    setScrollMethod(method)
    // Deliberately do NOT persist lastCaptureKind='scroll' — scroll must not
    // become the mode that "New Capture" / PrtSc replays.
    const r = await window.electronAPI?.launchScrollCapture?.(method)
    // Explicit extension request with no extension attached → open setup help
    // instead of silently falling back.
    if (method === 'extension' && r && !r.ok && r.error === 'extension-not-connected') {
      setShowExtSetup(true)
    }
  }

  // Days holding selected rows are never dropped while selecting. Not after
  // Cmd+A (the selection is still that same Set): every day would get
  // pinned and scrolling would keep all of history in memory.
  const selectAllSetRef = useRef<Set<string> | null>(null)
  const pinnedDays = useMemo(() => {
    const out = new Set<string>()
    if (selectedIds.size === 0 || selectedIds === selectAllSetRef.current) return out
    for (const [day, items] of rows) if (items.some(i => selectedIds.has(i.id))) out.add(day)
    return out
  }, [rows, selectedIds])

  const handleDelete = async (id: string) => {
    await window.electronAPI?.deleteHistoryItem(id)
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
  }

  const handleBulkDelete = async () => {
    if (isBulkDeleting) return
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setIsBulkDeleting(true)
    try {
      // Single store transaction. The old Promise.all(map(delete)) fired N
      // concurrent read-modify-writes that clobbered each other — deleted rows
      // resurrected as "Missing" orphans on the next refetch.
      await window.electronAPI?.deleteHistoryItems(ids)
      // Stay in selection mode with nothing selected, so the next batch can
      // be picked right away; the button (now Select in purple, tooltip
      // "Cancel") or Esc leaves it.
      setSelectedIds(new Set())
    } finally {
      setIsBulkDeleting(false)
    }
  }

  // Select mode: clicking a day's label adds all of that day's captures, or,
  // when they're all selected already, deselects them.
  const selectDay = useCallback((items: HistoryItem[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      const allSelected = items.every(i => prev.has(i.id))
      for (const i of items) {
        if (allSelected) next.delete(i.id)
        else next.add(i.id)
      }
      return next
    })
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitSelection = useCallback(() => {
    setIsSelecting(false)
    setSelectedIds(new Set())
  }, [])
  const enterSelection = useCallback(() => setIsSelecting(true), [])

  const selectGestures = useSelectGestures({
    enabled: isSelecting,
    busy: isBulkDeleting,
    selectedIds,
    setSelectedIds,
    // A click on the background leaves select mode (and clears the
    // selection), 2026-11-22. From 2026-11-21 it only cleared the selection
    // and stayed in select mode, like Finder.
    onBackgroundClick: exitSelection,
    onDragEnter: enterSelection,
    onDragCancel: exitSelection,
  })

  // Reload the loaded days — used after a race where a file disappears
  // between the fs.access probe and the user's click, so the UI flips from
  // "clickable" to orphan state on the next interaction.
  const refreshHistory = useCallback(async () => {
    await refresh()
  }, [refresh])

  // Open a clip in the editor. One whose file is gone but which was
  // uploaded is first downloaded back into place (history:restoreFromCloud:
  // the uploaded copy, edits and trim baked in), then opened (2026-11-21).
  const restoringRef = useRef<string | null>(null)
  const openItem = async (item: HistoryItem) => {
    if (item.fileMissing && item.uploads?.some(u => u.success)) {
      if (restoringRef.current) return
      restoringRef.current = item.id
      // The X cancels the download (2026-11-24): the toast goes at once, and
      // "Download canceled" shows when main confirms.
      const id = item.id
      toast('Downloading…', {
        kind: 'progress',
        onClose: () => { dismissToast(); void window.electronAPI?.cancelRestore(id) },
        closeLabel: 'Cancel',
        closeAria: 'Cancel download',
      })
      try {
        const r = await window.electronAPI?.restoreFromCloud(item.id)
        if (r?.error === 'cancelled') { toast('Download canceled', { kind: 'warning', icon: 'close' }); return }
        if (!r?.ok || !r.item) { toastError("Couldn't download", r?.error); return }
        dismissToast()
        await refreshHistory()
        item = r.item
      } finally {
        restoringRef.current = null
      }
    }
    if (item.fileMissing) return
    const state = await editorStateFor(item)
    // Unreadable file (gone since the last probe): refresh into the orphan state.
    if (!state) { if (item.type !== 'recording') await refreshHistory(); return }
    // Coming back, this clip sits where it was clicked (DaySections).
    noteOpenedClip(item.id)
    navigate('/editor', { state })
  }

  // Cloud-only clips (uploaded, file gone): save the uploaded copy to
  // Downloads (from R2, or Drive through its API).
  // One upload button (2026-11-21; was Share for R2 + Drive): an uploaded
  // clip copies its link (the first successful upload's); otherwise it
  // uploads, to R2 when the build has it, else to Google Drive. Which
  // service, and whether to offer both, is to be worked out later.
  // Upload (2026-11-23): one place to go acts at once; with R2 and Google
  // Drive both there, a menu picks (lib/upload-choice.ts). A row with a
  // link copies it; one without uploads there. Locked while uploading.
  const gdriveAvail = gdriveReady
  const [uploadMenu, setUploadMenu] = useState<{ item: HistoryItem; anchor: DOMRect; anchorEl: HTMLElement; rows: UploadRow[] } | null>(null)
  const closeUploadMenu = useCallback(() => setUploadMenu(null), [])
  const rowsFor = (item: HistoryItem) => uploadRows({
    r2Ready: shareReady,
    gdriveReady: gdriveAvail,
    links: uploadLinksOf(item.uploads),
    canUpload: !item.fileMissing && !!item.filePath,
  })
  const uploadTo = async (item: HistoryItem, row: UploadRow) => {
    if (row.link) {
      await window.electronAPI?.writeClipboardText(row.link)
      toast('Link copied', { icon: 'link' })
      return
    }
    if (row.dest === 'r2') return shareItem(item)
    return shareGdriveItem(item)
  }
  // The button's icon (2026-11-23): Upload while any place still needs an
  // upload, the link once every place has one.
  const allLinked = (item: HistoryItem) => {
    const rows = rowsFor(item)
    return rows.length > 0 && rows.every(r => r.link)
  }
  const onUploadClick = (item: HistoryItem, el: HTMLElement) => {
    // A second click on the same button closes its menu.
    if (uploadMenu?.item.id === item.id) { setUploadMenu(null); return }
    const rows = rowsFor(item)
    if (rows.length === 0) return
    if (rows.length === 1) { void uploadTo(item, rows[0]); return }
    setUploadMenu({ item, anchor: el.getBoundingClientRect(), anchorEl: el, rows })
  }

  const downloadItem = async (item: HistoryItem) => {
    const r = await window.electronAPI?.downloadFromCloud(item.id)
    if (r?.ok) toast('Saved to Downloads', { icon: 'download' })
    else toastError("Couldn't download", r?.error)
  }

  const copyItem = async (item: HistoryItem) => {
    const r = await copyHistoryItem(item, refreshHistory)
    if (r.ok) {
      toast(item.type === 'recording' ? 'Video copied' : 'Image copied', { icon: 'content_copy' })
    } else {
      toastError("Couldn't copy", r.error)
    }
  }

  const shareItem = async (item: HistoryItem) => {
    if (sharingId) return
    setSharingId(item.id)
    try {
      const r = await shareHistoryItem(item, refreshHistory)
      if (r.ok) toast('Uploaded, link copied')
      else      toastError("Couldn't upload", r.error)
    } finally {
      setSharingId(null)
    }
  }

  const shareGdriveItem = async (item: HistoryItem) => {
    if (sharingGdriveId) return
    const alreadyUploaded = item.uploads?.some(u => u.destination === 'google-drive' && u.success)
    setSharingGdriveId(item.id)
    try {
      const r = await shareHistoryGoogleDrive(item, refreshHistory)
      if (r.ok) toast(alreadyUploaded ? 'Drive link copied' : 'Uploaded to Drive, link copied', { icon: alreadyUploaded ? 'link' : 'check_circle' })
      else      toastError("Couldn't upload to Drive", r.error)
    } finally {
      setSharingGdriveId(null)
    }
  }

  // Missing files across all of history (history:missingIds), not just the
  // loaded days, so the button stays while scrolling and Clear removes every
  // one (2026-11-21). Missing and not uploaded: an uploaded clip whose file
  // is gone is cloud only, keeps its row (the link) and isn't counted or
  // cleared. Asked again on open, after every history write and when the
  // window gets focus (files deleted in Finder meanwhile); a newer ask wins
  // over a slower older one.
  const [missingIds, setMissingIds] = useState<string[]>([])
  useEffect(() => {
    let seq = 0
    const check = async () => {
      const mine = ++seq
      const ids = await window.electronAPI?.getMissingHistoryIds()
      if (ids && mine === seq) setMissingIds(ids)
    }
    check()
    const off = window.electronAPI?.onHistoryChanged(() => { check() })
    window.addEventListener('focus', check)
    return () => { seq = -1; off?.(); window.removeEventListener('focus', check) }
  }, [])
  const missingCount = missingIds.length
  const handleCleanupMissing = useCallback(async () => {
    await window.electronAPI?.cleanupMissingHistory(missingIds)
  }, [missingIds])

  // Persist view mode and type filter
  useEffect(() => {
    localStorage.setItem('lumia:history-view', viewMode)
  }, [viewMode])
  useEffect(() => {
    localStorage.setItem('lumia:history-filter', filter)
  }, [filter])

  // Escape leaves selection mode. Delete / Backspace (also with Cmd, like
  // Finder) deletes the selected clips, same as the red Delete button; not
  // while typing or with a dialog open.
  const bulkDeleteRef = useRef(handleBulkDelete)
  bulkDeleteRef.current = handleBulkDelete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSelecting) return
      if (e.key === 'Escape') {
        setIsSelecting(false)
        setSelectedIds(new Set())
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (selectedIds.size === 0 || showBrowserPicker || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      void bulkDeleteRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSelecting, selectedIds, showBrowserPicker])

  // Cmd+A (Ctrl+A) selects all of history under the type filter, loaded
  // days or not (ids from main), and turns select mode on. Not while typing
  // or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (showBrowserPicker) return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      if (e.repeat) return
      void window.electronAPI?.getAllHistoryIds(filter === 'all' ? undefined : filter).then(ids => {
        if (!ids?.length) return
        const all = new Set(ids)
        selectAllSetRef.current = all
        setSelectedIds(all)
        setIsSelecting(true)
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filter, showBrowserPicker])

  // Keyboard scrolling without focusing the clip area (it's no Tab stop):
  // arrows, Page Up / Down, Home / End scroll it from anywhere on the page
  // except text fields and open dialogs; arrows glide frame by frame and
  // speed up while held. After the
  // arrows were used, Tab jumps to the first clip in view (Shift+Tab to the
  // last) instead of the next control in page order; from there Tab walks
  // the clips as usual. A click or a Tab ends that mode. Scrolling by keys
  // takes the focus off a clip.
  const scrolledByKeys = useRef(false)
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    const onKey = (e: KeyboardEvent) => {
      if (showBrowserPicker || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      const area = document.querySelector<HTMLElement>('[data-scroll-area]')
      if (!area) return
      if (e.key === 'Tab') {
        if (!scrolledByKeys.current) return
        scrolledByKeys.current = false
        const box = area.getBoundingClientRect()
        const top = box.top + 46 // below the sticky day label
        // In view = more than half of it showing (between the day label and
        // the bottom), so a clip mostly scrolled away never counts as first.
        const inView = [...area.querySelectorAll<HTMLElement>('[data-clip]')].filter(c => {
          const r = c.getBoundingClientRect()
          return Math.min(r.bottom, box.bottom) - Math.max(r.top, top) > r.height / 2
        })
        const target = e.shiftKey ? inView[inView.length - 1] : inView[0]
        if (!target) return
        e.preventDefault()
        target.focus()
        return
      }
      const page = area.clientHeight * 0.9
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Key repeats only keep the glide going; it runs on frames.
        if (!e.repeat) startGlide(area, e.key, e.key === 'ArrowDown' ? 1 : -1)
      }
      else if (e.key === 'PageDown') area.scrollBy({ top: page })
      else if (e.key === 'PageUp') area.scrollBy({ top: -page })
      else if (e.key === 'Home') area.scrollTo({ top: 0 })
      else if (e.key === 'End') area.scrollTo({ top: area.scrollHeight })
      else return
      e.preventDefault()
      scrolledByKeys.current = true
      // Scrolling by keys leaves the clips: a focused one loses its focus,
      // and the next Tab starts again at the first clip in view.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.hasAttribute('data-clip')) focused.blur()
    }

    // Arrow glide: moves the list a little every frame while the arrow is
    // held (key repeats come only ~30 times a second, so jumping on each
    // one stuttered). Starts at 1200px/s (the old 40px per repeat) and
    // speeds up by 600px/s each second, reaching its cap of 2400px/s (80px
    // per repeat) after 2s. A tap still moves at least 20px.
    const START = 1200, ACCEL = 600, MAX = 2400, TAP = 20
    let glide: { area: HTMLElement; key: string; dir: number; t0: number; last: number; pos: number; moved: number; released: boolean; raf: number } | null = null
    const stopGlide = () => { if (glide) cancelAnimationFrame(glide.raf); glide = null }
    const frame = (now: number) => {
      const g = glide
      if (!g) return
      const speed = Math.min(START + ACCEL * (now - g.t0) / 1000, MAX)
      let dist = speed * (now - g.last) / 1000
      if (g.released) dist = Math.min(dist, TAP - g.moved)
      g.last = now
      if (dist > 0) {
        g.pos += g.dir * dist
        g.moved += dist
        g.area.scrollTop = g.pos
      }
      if (g.released && g.moved >= TAP) { stopGlide(); return }
      g.raf = requestAnimationFrame(frame)
    }
    function startGlide(area: HTMLElement, key: string, dir: number) {
      stopGlide()
      const now = performance.now()
      glide = { area, key, dir, t0: now, last: now, pos: area.scrollTop, moved: 0, released: false, raf: requestAnimationFrame(frame) }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (glide && e.key === glide.key) glide.released = true }

    const onPointer = () => { scrolledByKeys.current = false; stopGlide() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('blur', stopGlide)
    return () => {
      stopGlide()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('blur', stopGlide)
    }
  }, [showBrowserPicker])

  return (
    <div className="h-full flex flex-col">
      {/* ── Toast ── */}

      {/* The top section (kind toggle, greeting, capture tiles, scroll setup,
          "include Lumia's own window") is removed for now; see
          design/DASHBOARD-TOP-SECTION.md. Its helpers (MediaKindToggle,
          CAPTURE_MODES, VIDEO_MODES, extension status) are still in this file. */}

      {/* ── Recent / History ── */}
      <section className="flex-1 min-h-0 flex flex-col">
        {/* No visible title (2026-11-20: the Dashboard is the only list of
            captures, so "Captures" told nobody anything); kept for screen
            readers. */}
        <h2 className="sr-only">Captures</h2>

        {/* The filters (the missing-files button when files are gone, the
            type filter, the view switch, Select) sit in the AppBar's slot
            (2026-11-20): a toolbar row of their own wasted 56px with only its
            left side used. One control style (Segmented), 12px medium
            labels, the selected option in the accent purple. */}
        <AppBarControls>
          <div className="flex items-center gap-3">
            {/* Rows whose file is gone: one 32px toolbar button (Lucide
                FileXCorner in the warning colour on the plain elevated fill,
                styled like Select's trash since 2026-11-21; was on
                warning-subtle; the count as a badge) that
                clears them from history. First in the group, before Select
                (2026-11-20; was "trash + N missing files" text). */}
            {missingCount > 0 && (
              <button
                onClick={handleCleanupMissing}
                data-tip="Clear"
                aria-label={`Clear ${missingCount} missing ${missingCount === 1 ? 'file' : 'files'} from History`}
                // Windows (2026-11-23): last in the group (the bar is
                // mirrored there: type, view, Select, missing).
                className={`${ICON_BUTTON_FRAME} group/miss relative text-warning-text hover:bg-elevated-hover hover:text-warning-text-hover ${window.electronAPI?.platform === 'darwin' ? '' : 'order-last'}`}
              >
                <Icon name="file_x_corner" className="text-[16px]" />
                {/* How many, as a badge like Select's trash badge, in the
                    warning pair inverted (warning-text fill, warning-subtle
                    number), so it matches the icon. On the button's
                    top-right corner, not over the icon (2026-11-21; was top
                    left inside): -top-1 -right-1.5, with a 2px ring in the
                    AppBar's colour so it cuts out of the button's edge. The
                    number is 8px system mono, semibold, nudged down half a
                    pixel (pt-px): SF Mono's digits sit high in their line
                    box. */}
                <span className="absolute z-10 -top-1 -right-1.5 min-w-3.5 h-3.5 px-0.75 pt-px flex items-center justify-center rounded-full ring-2 ring-toolbar bg-warning-text group-hover/miss:bg-warning-text-hover text-warning-subtle text-[8px] font-mono font-semibold leading-none">{missingCount}</span>
              </button>
            )}
            {/* Type filter: All, then icons (Lucide's Images and our matching
                VideoStack), named by their tooltips. */}
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { key: 'all', label: 'All', square: true },
                { key: 'screenshot', icon: 'collections', title: 'Images' },
                { key: 'recording', icon: 'video_library', title: 'Videos' },
              ]}
            />
            <Segmented
              value={viewMode}
              onChange={setViewMode}
              options={[
                { key: 'grid', icon: 'view_module', title: 'Grid' },
                { key: 'list', icon: 'list', title: 'List' },
              ]}
            />
            {/* Last, right of the filters (2026-11-22; second, after the
                missing-files button, from 2026-11-20). One
                button, three states (2026-11-21): Select (CircleCheck,
                fg-secondary); in select mode with nothing selected the
                very same icon and colour (2026-11-22: only the strip says
                on; it was the accent, then fg, then a filled circle),
                tooltip "Cancel", which
                leaves select mode; with clips selected the red trash with
                the count as a badge, which deletes them (a delete keeps
                select mode). In both select-mode states a 3px accent strip
                runs along the button's bottom edge (see below), so the mode
                reads as on. Same frame in all three. Tried and dropped: a
                neutral × (no link to the mode being on), an accent × and
                CircleX, a bg-accent fill (looked off beside the segmented
                filters), a separate Delete button, a purple strip over the
                clip area. Esc also leaves. The badge sits on the button's
                top-right corner like the missing-files one. */}
            {(() => {
              const deleting = isSelecting && selectedIds.size > 0
              return (
                <button
                  onClick={deleting ? handleBulkDelete : isSelecting ? exitSelection : () => setIsSelecting(true)}
                  disabled={isBulkDeleting}
                  data-tip={deleting ? 'Delete' : isSelecting ? 'Cancel' : 'Select'}
                  aria-label={deleting ? `Delete ${selectedIds.size} selected` : isSelecting ? 'Leave select mode' : 'Select'}
                  aria-pressed={isSelecting}
                  // Hover: fill step + icon step (grey → fg, red →
                  // danger-text-hover). The trash is red at rest, one of the
                  // three exceptions to "delete buttons are grey at rest"
                  // (STYLEGUIDE › Buttons and controls, 2026-11-27).
                  className={`${ICON_BUTTON_FRAME} group/sel group/on relative hover:bg-elevated-hover ${
                    deleting ? 'text-danger-text hover:text-danger-text-hover' : 'text-fg-secondary hover:text-fg'
                  }`}
                >
                  {/* No spinner while deleting (2026-11-24): the delete is
                      quick, a spinner only flashed. The button is disabled
                      meanwhile. */}
                  <Icon
                    name={deleting || isBulkDeleting ? 'delete' : 'check_circle'}
                    className="text-[16px]"
                  />
                  {/* Select-mode strip, in every select-mode state (also on
                      the red trash, 2026-11-21): straight, 3px (picked on a
                      1 to 7px slider), on the bottom edge inside the frame,
                      across its full width,
                      masked by a wrapper with the frame's inner shape
                      (inset-0 = inside the border, rounded-[7px] = 8px
                      minus the 1px border, overflow-hidden) so its ends
                      never cover the border at the corners. Tried: an
                      inset box-shadow (its top edge curved too), 8px in
                      from each side (too short), unmasked (over the
                      border's curve). */}
                  {isSelecting && (
                    <OnStrip />
                  )}
                  {/* How many are selected: the icon's colour (danger-text)
                      with the pair inverted, so badge and trash match. */}
                  {deleting && (
                    <span className="absolute z-10 -top-1 -right-1.5 min-w-3.5 h-3.5 px-0.75 pt-px flex items-center justify-center rounded-full ring-2 ring-toolbar bg-danger-text group-hover/sel:bg-danger-text-hover text-danger-subtle text-[8px] font-mono font-semibold leading-none">{selectedIds.size}</span>
                  )}
                </button>
              )
            })()}
          </div>
        </AppBarControls>
        {uploadMenu && (
          <UploadMenu
            anchor={uploadMenu.anchor}
            anchorEl={uploadMenu.anchorEl}
            rows={uploadMenu.rows}
            onClose={closeUploadMenu}
            onPick={row => { const it = uploadMenu.item; setUploadMenu(null); void uploadTo(it, row) }}
          />
        )}

        {/* The clips' area, layer L3 (bg-content). */}
        {/* Padding on the scroll area itself (px-5), so the system scroll
            bar sits at the window's edge and the clips scroll to its bottom
            edge: no padding on this wrapper, which would leave a fixed strip
            nothing scrolls into. The space after the last clip is the last
            day's own pb-8. The scroll area is never focused (no Tab
            stop, no ring); the arrow keys scroll it anyway (see the keydown
            effect). scroll-pt-12 keeps a clip Tab brings into view clear of
            the sticky day label (12px + 26px label + 8px). */}
        {/* isolate: the cards' own layers (z-10 to z-30) and the day labels
            (z-30) stack inside the clip area only, so the AppBar's and the
            bottom bar's light-mode shadows (z-10) paint over all of it. */}
        {/* Select-mode mouse gestures live on this wrapper
            (useSelectGestures): drag a rectangle to select, Shift-click for
            a range, click the background to leave select mode. A drag also
            works outside select mode: it turns select mode on, and off again
            if it selects nothing. select-none so a drag or Shift-click never
            selects text. */}
        <div
          className="isolate flex-1 min-h-0 flex flex-col bg-content select-none"
          {...selectGestures.wrapperProps}
        >
        <DaySections
          className="flex-1 min-h-0 overflow-y-auto pt-3 px-5 scroll-pt-12 outline-none"
          days={days}
          rows={rows}
          filter={filter}
          view={viewMode}
          gridClassName={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3' : 'flex flex-col gap-2'}
          loadDays={loadDays}
          dropDays={dropDays}
          pinnedDays={pinnedDays}
          onDayClick={isSelecting ? selectDay : undefined}
          selectedIds={selectedIds}
          renderItem={(item) => {
            return viewMode === 'grid' ? (
              <HistoryCard
                key={item.id}
                item={item}
                isSelecting={isSelecting}
                isSelected={selectedIds.has(item.id)}
                isUploading={sharingId === item.id || sharingGdriveId === item.id}
                uploadReady={shareReady || gdriveAvail}
                uploadLinked={allLinked(item)}
                menuOpen={uploadMenu?.item.id === item.id}
                onToggleSelect={() => toggleSelect(item.id)}
                onOpen={() => openItem(item)}
                onDelete={() => handleDelete(item.id)}
                onCopy={() => copyItem(item)}
                onUpload={el => onUploadClick(item, el)}
                onDownload={() => downloadItem(item)}
              />
            ) : (
                <HistoryListRow
                  key={item.id}
                  item={item}
                  isSelecting={isSelecting}
                  isSelected={selectedIds.has(item.id)}
                  isUploading={sharingId === item.id || sharingGdriveId === item.id}
                  uploadReady={shareReady || gdriveAvail}
                  uploadLinked={allLinked(item)}
                  menuOpen={uploadMenu?.item.id === item.id}
                  onToggleSelect={() => toggleSelect(item.id)}
                  onOpen={() => openItem(item)}
                  onDelete={() => handleDelete(item.id)}
                  onCopy={() => copyItem(item)}
                  onUpload={el => onUploadClick(item, el)}
                  onDownload={() => downloadItem(item)}
                />
            )
          }}
            emptyState={stats ? <EmptyState filter={filter} /> : null}
          />
        </div>
      </section>

      {/* Drag-to-select rectangle (screen coordinates, already clipped to
          the clip area). Accent, so it stands out over any thumbnail: a
          solid accent edge and an accent fill at 15%. The fill has to be
          see-through so the clips stay visible under it, the one place an
          opacity modifier stands in for a role (2026-11-21; neutral line +
          fill roles tried, too quiet). */}
      {selectGestures.marquee && (
        <div
          className="fixed z-40 rounded-sm border border-accent bg-accent/15 pointer-events-none"
          style={selectGestures.marquee}
        />
      )}

      {showBrowserPicker && <BrowserPickerDialog onClose={() => setShowBrowserPicker(false)} />}
    </div>
  )
}

function MediaKindToggle({ value, onChange }: { value: MediaKind; onChange: (v: MediaKind) => void }) {
  const options: { kind: MediaKind; icon: string; label: string; activeBg: string; activeBorder: string; activeIcon: string }[] = [
    {
      kind: 'image',
      icon: 'photo_camera',
      label: 'Image',
      activeBg: 'bg-accent-subtle',
      activeBorder: 'border-transparent',
      activeIcon: 'text-accent-text',
    },
    {
      kind: 'video',
      icon: 'videocam',
      label: 'Video',
      activeBg: 'bg-accent-subtle',
      activeBorder: 'border-transparent',
      activeIcon: 'text-accent-text',
    },
    {
      kind: 'scroll',
      icon: 'swipe_down',
      label: 'Scroll',
      activeBg: 'bg-accent-subtle',
      activeBorder: 'border-transparent',
      activeIcon: 'text-accent-text',
    },
  ]
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-control border border-line">
      {options.map(({ kind, icon, label, activeBg, activeBorder, activeIcon }) => {
        const active = value === kind
        return (
          <button
            key={kind}
            onClick={() => onChange(kind)}
            className={`group flex items-center gap-2 px-3.5 py-1.5 rounded-lg   border ${
              active
                ? `${activeBg} ${activeBorder}`
                : 'border-transparent '
            }`}
          >
            <Icon name={icon} className={`text-[16px]  ${
                active ? activeIcon : 'text-fg-tertiary '
              }`} />
            <span
              className={`text-xs font-semibold  ${
                active ? 'text-fg' : 'text-fg-secondary '
              }`}
             
            >
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ── Capture-self toggle ── */

/** "Include Lumia's own window" — normally the app hides itself before a
 *  capture/recording starts; this keeps it visible so Lumia's own window can
 *  be part of the shot (and picked in Window mode). Shown under the mode
 *  buttons on both the Image and Video tabs; backed by the persisted
 * `captureSelfWindow` setting so hotkey captures honor it too. */
function CaptureSelfToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className="group inline-flex items-center gap-2 select-none"
      title="Keep Lumia visible while capturing or recording, so the app's own window appears in the result and can be picked in Window mode"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-3.5 h-3.5 accent-accent flex-shrink-0"
      />
      <span
        className="text-[11px] font-medium text-fg-tertiary"
       
      >
        Include Lumia's own window in captures
      </span>
    </label>
  )
}

/* ── Empty State ── */

function EmptyState({ filter }: { filter: FilterType }) {
  // Image: ImageOff, Video: PlayOff, All: both (2026-11-22).
  const icons = filter === 'screenshot' ? ['hide_image']
    : filter === 'recording' ? ['play_off']
    : ['hide_image', 'play_off']
  const message = filter !== 'all'
    // Nouns are Image / Video; screenshot / record are the verbs (2026-11-22).
    ? `No ${filter === 'screenshot' ? 'images' : 'videos'} yet`
    : 'No files yet'

  return (
    // Centred in the clip area (2026-11-22, it sat 80px from the top):
    // fills the scroller's full height, -mt-3 + 12px cancelling its pt-3.
    <div className="flex flex-col items-center justify-center -mt-3 h-[calc(100%+12px)]">
      {/* Bare icon, no box (2026-11-22: the bg-fill box was an old fill
          role and looked heavy over the 12px line). */}
      <div className="flex gap-2 mb-2">
        {icons.map(n => <Icon key={n} name={n} className="text-[24px] text-fg-tertiary" />)}
      </div>
      {/* Caption rank: 12px medium fg-secondary (14px semibold before,
          2026-11-22, off the type scale). */}
      <p className="text-xs font-medium text-fg-secondary">
        {message}
      </p>
    </div>
  )
}

/* ── History Card (Grid View) ── */

function HistoryCard({
  item, isSelecting, isSelected, isUploading, uploadReady, uploadLinked, menuOpen,
  onToggleSelect, onOpen, onDelete, onCopy, onUpload, onDownload,
}: {
  item: HistoryItem
  isSelecting: boolean
  isSelected: boolean
  isUploading: boolean
  uploadReady: boolean
  /** Every place it can go has its link: Upload shows as Copy link. */
  uploadLinked: boolean
  /** Its Upload menu is open: the hover buttons stay up. */
  menuOpen: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDelete: () => void
  onCopy: () => void
  /** Gets the Upload button, for the menu's place. */
  onUpload: (el: HTMLElement) => void
  onDownload: () => void
}) {
  const isUploaded = !!item.uploads?.some(u => u.success)
  // fileGone: the local file isn't on disk (nothing that needs it can run).
  // An uploaded clip without its file is cloud only: its Missing tag and
  // Uploaded mark, but no cover or warning edge (its upload is safe); a
  // click restores it from the upload; its hover buttons are Download (in
  // Copy's place), Upload as Copy link, and Delete (2026-11-21).
  const fileGone = !!item.fileMissing
  const cloudOnly = fileGone && isUploaded
  const missing = fileGone && !isUploaded
  const showUploaded = isUploaded
  // A missing file shows no length either, as an image shows no size
  // (2026-11-27).
  const lengthMs = item.type === 'recording' && !fileGone ? recordingLengthMs(item) : undefined
  // Status bar, left: a recording's length, an image's pixel size.
  // Units sit 1px after their numbers (ml-px), not a space character.
  const leftText = item.type === 'recording'
    ? (lengthMs != null ? durationParts(lengthMs).map((p, i) => <span key={i}>{i > 0 && ' '}{p.value}<span className="ml-px">{p.unit}</span></span>) : null)
    : formatDimensions(item)
  const timeText = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) // 24-hour clock only

  const stop = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn() }

  return (
    // Control role like the toolbar's controls. overflow-hidden clips the
    // thumbnail to the card's inner corner, so it needs no radius of its own.
    // A Tab stop (data-clip: the Dashboard's Tab-after-arrows starts at the
    // first one in view). Enter / Space do what a click does. Its focus
    // ring is the overlay at the end (the card's own outline would sit
    // under the thumbnail and status bar).
    <div
      // isolate: the card's own z layers (10 to 30) stack inside it, never
      // over the sticky day labels (z-30).
      className="group relative isolate overflow-hidden rounded-lg bg-toolbar outline-none"
      tabIndex={0}
      data-clip
      data-id={item.id}
      onClick={isSelecting ? onToggleSelect : (fileGone && !cloudOnly ? undefined : onOpen)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        if (isSelecting) onToggleSelect()
        else if (!fileGone || cloudOnly) onOpen()
      }}
      // The file's name with its extension, while Cmd is held (2026-11-27;
      // the native title "File no longer exists on disk" went: the Missing
      // tag says it). The hover buttons' own tips win, being nearer.
      data-tip={fileTipText(item)}
      data-tip-follow
      data-tip-key
    >
      {/* Thumbnail with the status bar and hover buttons over it. A
          missing file covers all of it (see the cover below). */}
      <div className="aspect-[4/3] bg-content relative overflow-hidden">
        {(item.thumbnailUrl ?? item.dataUrl) ? (
          // A missing file's thumbnail in greyscale, under its cover (2026-11-21).
          <img
            src={item.thumbnailUrl ?? item.dataUrl}
            loading="lazy"
            decoding="async"
            // A preview deleted outside Lumia: main checks and has it made again.
            onError={item.thumbnailUrl ? () => { void reportFileGone(item.id, 'thumbnail') } : undefined}
            className={`w-full h-full object-cover select-none ${missing ? 'grayscale' : ''}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Icon name={item.type === 'recording' ? 'videocam' : 'image'} className="text-fg-tertiary text-[24px]" />
          </div>
        )}

        {/* Selection checkbox: a small circle with an accent edge, so it reads
            apart from the white-edged play button. z-20: above a missing
            file's cover (z-10), which stays in select mode. */}
        {isSelecting && (
          <div className="absolute top-2 left-2 z-20">
            <button
              onClick={stop(onToggleSelect)}
              aria-label={isSelected ? 'Deselect' : 'Select'}
              className={`w-5 h-5 rounded-full flex items-center justify-center border border-accent ${
                isSelected ? 'bg-accent text-on-accent' : 'bg-elevated'
              }`}
            >
              {isSelected && <Icon name="check" className="text-[14px]" />}
            </button>
          </div>
        )}

        {/* Status bar along the bottom of the picture (2026-11-20).
            Left: the type icon (Video `smart_display` in pink kind-video,
            Image `image` in blue kind-image; moved here from the right
            2026-11-21), a recording's length or an image's pixel size, then
            the capture time (from the row's timestamp, never the name, which
            the user can change). Length before time: read left to right,
            "3h 32m" is plainly a length, so the clock time after it can't
            be mistaken for one. No file name. The type stays in select
            mode: it tells what the card is, not what a click does. Right:
            the status tags, bare (no box or fill, so the last one's edge
            lines up with the 8px on the left): Missing (warning-coloured
            text; the whole card is covered as well), then Uploaded (14px
            green `radio`).
            Solid toolbar fill (bg-toolbar), like the day labels and hover
            buttons. */}
        <div className="absolute inset-x-0 bottom-0 z-10 h-6 px-2 flex items-center justify-between gap-2 border-t border-line bg-toolbar text-fg-secondary">
          {/* the source after the time and a
              dot (without the dot tried, also with the time in fg and an
              8px gap, 2026-11-24) ("App / Window title", "Region",
              "Screen", as in the list),
              cut off with an ellipsis; it runs to the bar's right edge when
              there are no tags (the tags group is left out then), else to
              8px before them. */}
          <div className="flex-1 min-w-0 flex items-center gap-1 text-[10px] font-medium tabular-nums whitespace-nowrap">
            {/* Type: Video or Image, the icon in its kind colour (line
                only, no fill), first on the left (2026-11-21). mr-0.5 on
                top of the row's gap-1: 6px to the text, a little more than
                between the words. */}
            {item.type === 'recording' ? (
              <span data-tip="Video" aria-label="Video" className="flex mr-0.5 text-kind-video">
                <Icon name="smart_display" className="text-[14px]" />
              </span>
            ) : (
              <span data-tip="Image" aria-label="Image" className="flex mr-0.5 text-kind-image">
                <Icon name="image" className="text-[14px]" />
              </span>
            )}
            {/* a recording's length or an
                image's pixel size (3072×1754 is wide) shows only while the
                card is hovered, in the source's place after the time, so
                nothing before it moves; the source steps aside then. */}
            <span className="shrink-0">{timeText}</span>
            {leftText && <><span className="shrink-0 hidden group-hover:inline">·</span><span className="shrink-0 hidden group-hover:inline">{leftText}</span></>}
            {(() => {
              const src = clipSource(item)
              if (src.mode !== 'region' && src.mode !== 'screen' && src.parts.length === 0) return null
              const hide = leftText ? 'group-hover:hidden' : ''
              return <><span className={`shrink-0 ${hide}`}>·</span><span className={`min-w-0 truncate ${hide}`}><SourceText {...src} /></span></>
            })()}
          </div>
          {(missing || cloudOnly || showUploaded) && <div className="shrink-0 flex items-center gap-1">
            {/* Final 2026-11-23: the list view's icons, bare (no
                pill), in place of the MISSING text tag. */}
            {(missing || cloudOnly) && <span data-tip="Missing" aria-label="Missing" className="flex text-warning-text"><Icon name="file_x_corner" className="text-[14px]" /></span>}
            {showUploaded && <span data-tip="Uploaded" aria-label="Uploaded" className="flex text-success-text"><Icon name="radio" className="text-[14px]" /></span>}
          </div>}
        </div>

        {/* A missing file (2026-11-21, as in the list view; on top of the
            Missing tag): the card is covered by its own fill at 40% (dark in
            dark mode, light in light mode) and a warning-subtle wash at 35% on
            top (2026-11-21, the list's values; 60% / 25% before),
            both 1px inside the edge (inset-px, radius 7px), and the edge
            turns warning (below). Before the hover buttons in the DOM, so
            Delete paints above it at full strength. Stays in select mode, with
            the edge and the Missing tag (2026-11-21), so missing clips can be
            told apart while picking; the selection circle sits above it. */}
        {missing && <>
          <div className="absolute inset-px z-10 rounded-[7px] bg-toolbar/40 pointer-events-none" />
          <div className="absolute inset-px z-10 rounded-[7px] bg-warning-subtle/35 pointer-events-none" />
        </>}

        {/* Actions on hover, same set for image + video; shown at once, no
            fade. No Edit: clicking the card opens it. Orphan cards collapse
            to Delete only so users prune without chasing dead links. An
            action that can't run is left out, not shown disabled (Upload
            without R2 or Drive set up). In a row at the picture's top
            right, 8px in (p-2; picked 2026-11-21 over centred and the other
            corners/edges). The layer stops above the status bar (top-0
            bottom-6), so it never covers the bar's tags (their tooltips need
            the pointer). While the card uploads or its Upload menu is open,
            the row stays up without the pointer (2026-11-23). */}
        {!isSelecting && (
          <div className={`absolute inset-x-0 top-0 bottom-6 p-2 ${isUploading || menuOpen ? 'flex' : 'hidden group-hover:flex'} items-start justify-end gap-2 z-10`}>
            {cloudOnly && <ClipActionButton icon="download" label="Download" onClick={stop(onDownload)} />}
            {!fileGone && <ClipActionButton icon="content_copy" label="Copy" onClick={stop(onCopy)} />}
            {/* Upload: the Drive icon until the clip is uploaded, then a
                link icon that copies its link (works without the file). */}
            {uploadReady && (isUploaded || !fileGone) && (
              <ClipActionButton
                icon={isUploading ? 'sync' : uploadLinked ? 'link' : 'add_to_drive'}
                label={isUploading ? 'Uploading…' : uploadLinked ? 'Copy link' : 'Upload'}
                onClick={e => { e.stopPropagation(); onUpload(e.currentTarget as HTMLElement) }}
                spinning={isUploading}
                noTip={menuOpen}
              />
            )}
            <ClipActionButton danger icon="delete" label="Delete" onClick={stop(onDelete)} />
          </div>
        )}
      </div>

      {/* Edge line so a white capture on the white page (or a black one on
          the dark page) still shows its edge: the theme's line colour, dark
          in light mode and light in dark mode. Inset on a layer above the
          thumbnail like the selected outline below, which covers it. A
          missing file's edge is warning-line (index.css), as in the list
          view. */}
      {/* under the pointer the edge steps
          up to line-strong (not on a missing card); the hover buttons that
          appear carry the rest. Tried: a solid line-strong, a 2px edge, the
          list rows' overlay (lost over light / dark thumbnails), an outer
          edge on the card itself. */}
      <div className={`absolute inset-0 z-10 rounded-lg ring-1 ring-inset pointer-events-none ${missing ? 'ring-warning-line' : 'ring-line group-hover:ring-line-strong'}`} />

      {/* Keyboard focus ring for the card, over everything on it (z-30). */}
      <div className="absolute inset-0 z-30 hidden group-focus-visible:block rounded-lg ring-2 ring-inset ring-focus pointer-events-none" />

      {/* Accent outline when selected. An inset ring on a layer above the
          thumbnail: an outer ring is cut off by the scroll area at the grid's
          left edge, and one on the card itself sits under the image. */}
      {isSelected && <div className="absolute inset-0 z-20 rounded-lg ring-(length:--selection-ring) ring-inset ring-accent pointer-events-none" />}

    </div>
  )
}




