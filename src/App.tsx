import { useEffect, lazy, Suspense } from 'react'
import { TooltipLayer } from './components/TooltipLayer'
import { Routes, Route, useNavigate, Navigate, useLocation } from 'react-router-dom'
import { AppBar } from './components/AppBar'
import { AppBarSlotProvider } from './components/AppBarSlot'
import { BottomBar } from './components/BottomBar'
import { useTheme } from './hooks/useTheme'
import { dashboardStartsAtTop } from './lib/dashboard-place'
import Dashboard from './windows/dashboard/Dashboard'
import { UpdateNotification } from './components/UpdateNotification'
import { ToastHost } from './components/Toast'
import { toast } from './lib/toast'
import { PrintScreenPromptDialog } from './components/PrintScreenPromptDialog'

// Code-split heavy routes. Konva (~150KB) only loads when Editor opens;
// each standalone window only pulls its own renderer chunk instead of the
// full app bundle. Dashboard stays eager — it's the home route, lazy-loading
// it would put a Suspense fallback in front of the user on app launch.
const Editor = lazy(() => import('./windows/editor/Editor'))
const Workflow = lazy(() => import('./windows/workflow/Workflow'))
const Settings = lazy(() => import('./windows/settings/Settings'))
const RecordingToolbar = lazy(() => import('./windows/recording-toolbar/RecordingToolbar'))
const RecordingBorder = lazy(() => import('./windows/recording-border/RecordingBorder'))
const RecorderHost = lazy(() => import('./windows/recorder-host/RecorderHost'))
const AnnotationOverlay = lazy(() => import('./windows/annotation-overlay/AnnotationOverlay'))

import { isStandaloneHash } from './lib/standalone'

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const standalone = isStandaloneHash()
  // Applies the saved theme at start, whatever route the window opens on.
  useTheme()

  // Esc takes keyboard focus off the focused control (and its ring). A click
  // on the AppBar / page headers can't: they're window drag regions, so
  // macOS keeps those clicks and the page never sees them. Text fields keep
  // their own Esc (e.g. the editor's text box cancels on it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (!(el instanceof HTMLElement) || el === document.body) return
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      el.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Dragging the window by the AppBar clears a text selection, like a
  // click anywhere else (main sends window:will-move; the drag itself never
  // reaches the page).
  useEffect(() => {
    window.electronAPI?.onWindowWillMove?.(() => window.getSelection()?.removeAllRanges())
    return () => window.electronAPI?.removeAllListeners('window:will-move')
  }, [])

  // Mouse clicks don't leave focus on buttons, links or clip cards, like
  // native macOS buttons. Chromium focuses them on click, and the next key
  // press (any key, e.g. Delete) then shows the focus ring on whatever was
  // clicked last. A mouse click has detail ≥ 1; Enter / Space give 0, so
  // keyboard use keeps its focus. Text fields, selects and sliders aren't
  // matched and keep the focus a click gives them. If the click handler
  // moved focus elsewhere (a dialog's field), that's left alone.
  // Capture phase (2026-11-23): a handler that stops propagation (trim bar,
  // card buttons) no longer keeps the focus; and a press released off the
  // control (no click) gives it up on pointer release.
  useEffect(() => {
    const MOUSE_BLUR = 'button, a, [role="button"], [data-clip]'
    const blurIfMatched = () => {
      const el = document.activeElement
      if (el instanceof HTMLElement && el.matches(MOUSE_BLUR)) el.blur()
    }
    const onClick = (e: MouseEvent) => { if (e.detail !== 0) blurIfMatched() }
    const onUp = () => blurIfMatched()
    // The window becoming active (from the menu bar / tray, the Dock, a
    // switch back) can land focus on its first control, ringed: the missing
    // files button (2026-11-24). Drop it once the activation has settled;
    // text fields keep theirs.
    const onWindowFocus = () => setTimeout(blurIfMatched, 0)
    document.addEventListener('click', onClick, true)
    document.addEventListener('pointerup', onUp, true)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  // Selects too (2026-11-22): one opened with the mouse shows no focus ring
  // while its list is open (data-mouse-focus, index.css) and gives up focus
  // once an option is picked. Opened from the keyboard, it keeps both.
  useEffect(() => {
    let mouseOpened: HTMLSelectElement | null = null
    const onDown = (e: PointerEvent) => {
      const sel = (e.target as Element | null)?.closest?.('select')
      mouseOpened = sel instanceof HTMLSelectElement ? sel : null
      if (mouseOpened) {
        const el = mouseOpened
        el.dataset.mouseFocus = ''
        el.addEventListener('blur', () => { delete el.dataset.mouseFocus }, { once: true })
      }
    }
    const onKey = () => { mouseOpened = null }
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLSelectElement && e.target === mouseOpened) {
        e.target.blur()
        mouseOpened = null
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('change', onChange, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('change', onChange, true)
    }
  }, [])

  useEffect(() => {
    window.electronAPI?.onNavigate((route, state) => {
      // Main only sends the window to the editor for a new capture or
      // recording (and from its notification): Back then shows the
      // Dashboard's top, where the new clip is. Every other way into the
      // editor, and Settings, comes back to the place it left.
      if (route === '/editor') dashboardStartsAtTop()
      navigate(route, state ? { state } : undefined)
    })
    return () => { window.electronAPI?.removeAllListeners('navigate') }
  }, [navigate])

  // Messages from main while the window is up (notify.ts): the same text as
  // the system notification would have, as an in-app toast.
  useEffect(() => {
    window.electronAPI?.onToast(t => toast(t.message, { kind: t.kind, icon: t.icon, detail: t.detail }))
    return () => { window.electronAPI?.removeAllListeners('toast:show') }
  }, [])

  // Notify main once the new route has actually committed to the DOM. Main
  // uses this ack to gate win.show() on capture-success flows so the window
  // doesn't pop up still painting the previous route. On every navigation,
  // not just a new path (2026-11-27): /editor → /editor with a new capture
  // sent no ack, so main waited out its timeout.
  useEffect(() => {
    if (standalone) return
    requestAnimationFrame(() => {
      window.electronAPI?.notifyViewMounted?.(location.pathname)
    })
  }, [location.key, location.pathname, standalone])

  // Tell main to show() the BrowserWindow once the renderer has finished its
  // critical initial work — fonts loaded + Dashboard's IPC fetches resolved.
  // Until then main keeps the window hidden so the user doesn't see a half-
  // rendered Dashboard pop in. Standalone windows (overlay/recording-toolbar/
  // etc.) don't gate — main shows them on demand via its own logic. Renderer-
  // side fallback ensures the signal fires even if a fetch hangs.
  useEffect(() => {
    if (standalone) return
    let cancelled = false
    const fallback = setTimeout(() => {
      if (!cancelled) window.electronAPI?.windowReady?.()
    }, 1500)
    Promise.all([
      document.fonts.ready,
      window.electronAPI?.getSettings?.(),
      window.electronAPI?.getHotkeys?.(),
    ]).then(() => {
      if (cancelled) return
      clearTimeout(fallback)
      window.electronAPI?.windowReady?.()
    }).catch(() => { /* fallback timer covers failure paths */ })
    return () => { cancelled = true; clearTimeout(fallback) }
  }, [standalone])

  useEffect(() => {
    if (standalone) return
    window.electronAPI?.notifyRoute?.(location.pathname)
  }, [location.pathname, standalone])

  // Standalone windows — no sidebar/title bar, body transparent where applicable.
  // Suspense fallback is null: standalone windows are transparent or pre-warmed
  // hidden, so a loading shimmer would either flash or be invisible anyway.
  if (standalone) {
    return (
      <Suspense fallback={null}>
        <Routes>
          <Route path="/recording-toolbar" element={<RecordingToolbar />} />
          <Route path="/recording-border" element={<RecordingBorder />} />
          <Route path="/recorder-host" element={<RecorderHost />} />
          <Route path="/annotation-overlay" element={<AnnotationOverlay />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <AppBarSlotProvider>
    <div className="flex flex-col h-screen overflow-hidden">
      {/* No sidebar: the AppBar on top carries the app name,
          theme and Settings, plus the window chrome (traffic lights on macOS,
          native controls on Windows). */}
      <TooltipLayer />
      {/* The editor too (2026-11-22): its controls go in the AppBar's slot;
          it had its own top bar, plus a bare 40px strip on Windows. */}
      <AppBar />
      <main className="flex-1 overflow-hidden min-h-0">
        <Suspense fallback={<div className="w-full h-full" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/editor" element={<Editor />} />
            {/* /history merged into /dashboard — stale links redirect. */}
            <Route path="/history" element={<Navigate to="/dashboard" replace />} />
            <Route path="/workflow" element={<Workflow />} />
            <Route path="/settings" element={<Settings />} />
            {/* /video-annotator merged into /editor — stale links redirect. */}
            <Route path="/video-annotator" element={<Navigate to="/editor" replace />} />
          </Routes>
        </Suspense>
      </main>
      <BottomBar />
      <ToastHost>
        <UpdateNotification />
      </ToastHost>
      <PrintScreenPromptDialog />
    </div>
    </AppBarSlotProvider>
  )
}
