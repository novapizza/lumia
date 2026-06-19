import { useEffect, lazy, Suspense } from 'react'
import { Routes, Route, useNavigate, Navigate, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import Dashboard from './windows/dashboard/Dashboard'
import { AboutDialog } from './components/AboutDialog'
import { UpdateNotification } from './components/UpdateNotification'
import { PrintScreenPromptDialog } from './components/PrintScreenPromptDialog'

// Code-split heavy routes. Konva (~150KB) only loads when Editor opens;
// each standalone window only pulls its own renderer chunk instead of the
// full app bundle. Dashboard stays eager — it's the home route, lazy-loading
// it would put a Suspense fallback in front of the user on app launch.
const Editor = lazy(() => import('./windows/editor/Editor'))
const Workflow = lazy(() => import('./windows/workflow/Workflow'))
const Wallpapers = lazy(() => import('./windows/wallpapers/Wallpapers'))
const Settings = lazy(() => import('./windows/settings/Settings'))
const Overlay = lazy(() => import('./windows/overlay/Overlay'))
const RecordingToolbar = lazy(() => import('./windows/recording-toolbar/RecordingToolbar'))
const RecordingBorder = lazy(() => import('./windows/recording-border/RecordingBorder'))
const RecorderHost = lazy(() => import('./windows/recorder-host/RecorderHost'))
const AnnotationOverlay = lazy(() => import('./windows/annotation-overlay/AnnotationOverlay'))

const STANDALONE_ROUTES = ['/overlay', '/recording-toolbar', '/recording-border', '/recorder-host', '/annotation-overlay']

function isStandaloneHash(): boolean {
  const hash = window.location.hash.replace(/^#/, '')
  return STANDALONE_ROUTES.some(r => hash === r || hash.startsWith(r + '?') || hash.startsWith(r + '/'))
}

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const standalone = isStandaloneHash()
  // Editor runs full-width (handles both image and video modes) — its own
  // toolbars replace the sidebar, and it needs every pixel of canvas space.
  const isFullWidth = !standalone && location.pathname === '/editor'

  useEffect(() => {
    window.electronAPI?.onNavigate((route, state) => {
      navigate(route, state ? { state } : undefined)
    })
    return () => { window.electronAPI?.removeAllListeners('navigate') }
  }, [navigate])

  // Notify main once the new route has actually committed to the DOM. Main
  // uses this ack to gate win.show() on capture-success flows so the window
  // doesn't pop up still painting the previous route.
  useEffect(() => {
    if (standalone) return
    requestAnimationFrame(() => {
      window.electronAPI?.notifyViewMounted?.(location.pathname)
    })
  }, [location.pathname, standalone])

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
          <Route path="/overlay" element={<Overlay />} />
          <Route path="/recording-toolbar" element={<RecordingToolbar />} />
          <Route path="/recording-border" element={<RecordingBorder />} />
          <Route path="/recorder-host" element={<RecorderHost />} />
          <Route path="/annotation-overlay" element={<AnnotationOverlay />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
      {!isFullWidth && <Sidebar />}
      <main className={`flex-1 overflow-hidden ${isFullWidth ? '' : 'ml-64'}`}>
        <Suspense fallback={<div className="w-full h-full" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/editor" element={<Editor />} />
            {/* /history merged into /dashboard — stale links redirect. */}
            <Route path="/history" element={<Navigate to="/dashboard" replace />} />
            <Route path="/workflow" element={<Workflow />} />
            <Route path="/wallpapers" element={<Wallpapers />} />
            <Route path="/settings" element={<Settings />} />
            {/* /video-annotator merged into /editor — stale links redirect. */}
            <Route path="/video-annotator" element={<Navigate to="/editor" replace />} />
          </Routes>
        </Suspense>
      </main>
      </div>
      <AboutDialog />
      <UpdateNotification />
      <PrintScreenPromptDialog />
    </div>
  )
}
