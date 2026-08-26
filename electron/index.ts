import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, clipboard, screen, Menu, nativeTheme, protocol, powerMonitor } from 'electron'
import { join, dirname } from 'path'
import fs from 'fs/promises'
import { setupCapture, ORIGINALS_DIR, getFrozenBgrForDisplay, prewarmDesktopCapturer } from './capture'
import { prewarmNativeCapture } from './native-screen'
import { prewarmMacWindowPick } from './mac-window-pick'
import { setupMemoryLogging, labelWebContents } from './mem-metrics'
import { getIccFromPng, tagPngWithIcc } from './png-icc'
import { setupVideo, isRecordingActive } from './video'
import { uploadFileToR2 } from './uploaders/r2'
import {
  refreshGoogleToken,
  revokeGoogleToken,
  exchangeGoogleAuthCode,
} from './uploaders/googledrive'
import { uploadFilePathToDrive } from './google-drive-service'
import { localTimestamp } from './utils'
import { registerOverlayHwnd, unregisterOverlayHwnd, disableDwmTransitions } from './native-input'
import { snapshotActivePickWindow } from './window-list'
import { setupHotkeys, teardownHotkeys, getHotkeys, saveHotkeys, resetHotkeys, defaultHotkeys, type HotkeyConfig } from './hotkeys'
import { setupTray, destroyTray } from './tray'
import { setupScrollCapture, getOverlayMode } from './scroll-capture'
import { setupExtensionBridge } from './extension-bridge'
import { setupStickers } from './stickers'
import { WorkflowEngine } from './workflow'
import { TemplateStore } from './templates'
import { HistoryStore } from './history'
import { makeThumbnail } from './thumbnail'
import { showNotification, consumePendingNotificationClick } from './notify'
import type { HistoryItem } from './types'
import { getSettings, setSetting, isRememberedMode, resolveSaveStartDir, rememberSaveDir, type AppSettings } from './settings'
import { applyLaunchAtStartup, wasLaunchedAtStartup } from './startup'
import { ensureDevStartMenuShortcut } from './dev-shortcut'
import { setSnippingHijack } from './printscreen-key'
import { preflightPermissions } from './permissions'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

log.transports.file.level = 'info'
log.transports.console.level = 'info'
autoUpdater.logger = log
Object.assign(console, log.functions)

// Enable WGC (Windows Graphics Capture) for pixel-perfect, high-quality screenshots on Windows.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'WindowsNativeGraphicsCapture')
}

// Cap Chromium's on-disk HTTP cache. Default is unlimited and grows
// indefinitely — Wallpapers fetches dozens of new Unsplash images per
// Refresh, and a heavy user can balloon the cache past 500 MB.
//
// 80 MB is enough headroom for Lumia's actual cacheable surface (the docs
// site, a few API responses, a few hundred wallpaper thumbnails) while
// bounding the worst case. Fonts no longer factor in — Inter, Manrope and
// Material Symbols are self-hosted and bundled, so Chromium doesn't cache
// them via HTTP. When the cap fills, Chromium evicts LRU; recently-viewed
// wallpapers stay warm, ancient ones get reclaimed automatically.
app.commandLine.appendSwitch('disk-cache-size', String(80 * 1024 * 1024))

// Privileged scheme for streaming local recordings into <video> without
// reading the whole file into renderer memory as a Blob. Chromium's media
// stack issues HTTP Range requests against this scheme; the handler (wired in
// whenReady) serves them from disk with explicit 206/Content-Range responses
// so seeking works. Must be registered before app 'ready', i.e. at top level.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumia-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true },
  },
])

const isDev = !app.isPackaged

// Only allow a single running instance — prevents cache/lock conflicts
// (cache_util_win.cc "Access is denied" errors) when the user relaunches
// while the tray instance is still alive.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
let historyStoreInstance: InstanceType<typeof HistoryStore> | null = null
// Pre-warmed pool: one hidden overlay per display, kept alive for the app's
// lifetime. Reusing a loaded renderer drops region-capture from
// "hotkey → first paint" of ~300–500ms (window create + React boot) down to
// the time it takes to call show() + send a mode reset (~30ms).
const overlayPool: Map<number, BrowserWindow> = new Map()
let overlayPoolReady = false
// Mirror of the currently-active overlays (subset of overlayPool that is
// visible). Kept separate so getOverlayWindow / broadcastToOverlays stay
// scoped to the active session.
const overlayWindows: Map<number, BrowserWindow> = new Map()
let activeOverlayDisplayId: number | null = null
let overlayPollTimer: ReturnType<typeof setInterval> | null = null
let overlayDrawingInProgress = false
let currentRoute = '/dashboard'
let isQuitting = false
// Tracks whether the user has explicitly dismissed the main window (red X
// close, Cmd+Q, dock right-click → Quit, or login-item startup). Set to false
// once the window is surfaced again. Used by overlay cancel handlers to
// decide whether to bring the main window back (not dismissed → restore) or
// stay in tray-only state (dismissed → keep hidden, drop dock icon).
//
// Why a tracked flag instead of `mainWindow.isVisible()`: capture flow hides
// the main window before opening the overlay, so by the time the overlay
// runs `isVisible()` always reads false. The flag captures user *intent*,
// which survives transient hides for capture / Cmd+H.
let mainDismissedByUser = false
// Set when `openHistoryItemInEditor` surfaces the window from a
// dismissed-to-tray state (i.e. the user clicked a notification while in
// tray-only mode). Causes the next X-close on /editor to skip the
// "navigate back to dashboard" behavior and drop straight back to tray —
// the user came from tray, they go back to tray.
//
// Deliberately NOT cleared by `win.on('show')`. On Windows the 'show'
// event can fire asynchronously after `win.show()` returns, racing with
// the assignment in `openHistoryItemInEditor`. Tying clear-on-show would
// produce a Heisenbug where adding console.logs makes the bug disappear.
// Only the close handler clears it (one-shot semantic).
let surfacedFromTray = false
// Set by the autoUpdater 'update-downloaded' handler. Allows the install to
// happen the moment the user drops the app to the tray instead of waiting
// for an explicit Quit / next launch.
let updateDownloaded = false
let autoInstallTimer: ReturnType<typeof setTimeout> | null = null
// Grace window between "user hid the app" and "we restart the app to install".
// Long enough that a brief Cmd+H (Mac) or accidental close-to-tray (Windows)
// doesn't nuke whatever the user is about to come back to. Short enough that
// a genuinely-idle tray instance picks up the update before the next session.
const AUTO_INSTALL_GRACE_MS = 30 * 1000

export function markQuitting() { isQuitting = true }

/** Schedule a quit-and-install for an already-downloaded update, but only if
 *  the window stays hidden for the full grace window. Called from
 *  `update-downloaded` and from the main window's 'hide' event. */
/** True when restarting now would destroy in-progress work the user can't get
 *  back. The main window is hidden for the entire duration of a recording and
 *  while the capture overlay is up, so visibility alone is not enough — a
 *  quit-and-install here would silently drop a recording mid-capture. */
function isAppBusy(): boolean {
  if (isRecordingActive()) return true
  if (overlayWindows.size > 0) return true
  return false
}

function scheduleAutoInstall() {
  if (autoInstallTimer) clearTimeout(autoInstallTimer)
  autoInstallTimer = null
  if (!updateDownloaded) return
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
  if (isAppBusy()) return
  autoInstallTimer = setTimeout(() => {
    autoInstallTimer = null
    // Re-check: user may have surfaced the window or started a recording /
    // capture during the grace window.
    if (!updateDownloaded) return
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
    if (isAppBusy()) return
    console.log('[autoUpdater] grace period elapsed with window hidden — installing update')
    updateDownloaded = false
    isQuitting = true
    // (isSilent=true, isForceRunAfter=true) — Windows-only knobs. Without
    // isSilent the NSIS assisted-installer UI pops up on every update;
    // isForceRunAfter relaunches the app once the install finishes.
    autoUpdater.quitAndInstall(true, true)
  }, AUTO_INSTALL_GRACE_MS)
}

/** Called when the window becomes visible again — cancel any pending install
 *  so the user isn't kicked out the moment after they reopen. */
function cancelAutoInstall() {
  if (autoInstallTimer) clearTimeout(autoInstallTimer)
  autoInstallTimer = null
}

/** Hide the dock icon — called only when the user explicitly closes the
 *  main window to the tray (red X) or when the app launches hidden via the
 *  login item. Hiding the dock flips macOS into Accessory activation
 *  policy, which prevents app.focus() from stealing focus reliably; we
 *  must NOT do it for transient hides (capture flow, Cmd+H, etc.) or the
 *  overlay won't receive mouse / keyboard input. */
function hideDock() {
  if (process.platform !== 'darwin') return
  app.dock?.hide()
}

/** Show the dock icon — called when the main window surfaces from tray.
 *  Idempotent (already visible → no-op). Returns app to Regular policy. */
function showDock() {
  if (process.platform !== 'darwin') return
  app.dock?.show().catch(() => { /* ignore */ })
}

export function getMainWindow() { return mainWindow }
export function getHistoryStore() { return historyStoreInstance }
/** True when the user has explicitly dismissed the main window to the tray
 *  (X close on a non-/editor route). Capture flows use this to decide
 *  whether to surface the editor afterwards or just leave the user in tray
 *  with a clickable notification. */
export function isMainDismissed() { return mainDismissedByUser }
export function getOverlayWindow() {
  if (activeOverlayDisplayId == null) return null
  return overlayWindows.get(activeOverlayDisplayId) ?? null
}
export function getOverlayDisplayId() { return activeOverlayDisplayId }

export function broadcastToOverlays(channel: string, ...args: unknown[]) {
  for (const [, win] of overlayWindows) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/** Wait for the renderer to confirm a given route has mounted, with a
 *  fallback timeout so a renderer crash / dropped IPC can't deadlock the
 *  main process. Used to gate win.show() on capture-success flows so the
 *  window doesn't flash the previous route before /editor renders. */
export function waitForViewMounted(route: string, timeoutMs = 800): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      ipcMain.removeListener('view:mounted', listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (_e: Electron.IpcMainEvent, mountedRoute: string) => {
      if (mountedRoute === route) finish()
    }
    ipcMain.on('view:mounted', listener)
    const timer = setTimeout(finish, timeoutMs)
  })
}

/** Surface a history item in the Editor — used by notification-click
 *  handlers so a user who closed the Editor can still hop back to the
 *  freshly-captured image / video by tapping the toast. Mirrors the
 *  Dashboard `openItem` flow but routes through the navigate IPC since
 *  we're calling from the main process. */
export async function openHistoryItemInEditor(
  historyId: string,
  /** True when the original capture happened while the main window was
   *  dismissed to the tray. Captured *at notification creation time* so
   *  the decision survives whatever Windows does between toast click and
   *  this function running — banner clicks in particular can bring the
   *  window forward before activation reaches us, clearing
   *  `mainDismissedByUser` and breaking a check-at-click-time approach. */
  fromTray = false,
): Promise<void> {
  const main = mainWindow
  if (!main || main.isDestroyed()) return

  const item = historyStoreInstance?.getAll().find(i => i.id === historyId)

  // Latch surfacedFromTray *before* the show call so the X-close handler
  // sees a stable value regardless of when 'show' fires. Either the
  // notification was created from a tray state (fromTray) or the window
  // happens to be dismissed right now (mainDismissedByUser) — both
  // signal "user came from tray, return them to tray on X close".
  if (fromTray || mainDismissedByUser) surfacedFromTray = true

  // Build the navigate payload *before* surfacing the window, then send
  // it while the window may still be hidden so the renderer can commit
  // the route change in the background. Otherwise users see a brief
  // flash of whatever route was last live (typically /dashboard) before
  // React processes the navigation.
  let route: '/editor' | '/dashboard' = '/dashboard'
  let state: Record<string, unknown> | undefined

  if (!item) {
    // History entry already pruned/deleted — fall through to dashboard.
  } else if (item.type === 'recording') {
    const { basename } = await import('path')
    route = '/editor'
    state = {
      kind: 'video',
      filePath: item.filePath,
      name: item.name ?? (item.filePath ? basename(item.filePath) : 'Recording'),
      historyId: item.id,
      annotations: item.annotations,
    }
  } else {
    // Image: re-read the original from disk (history.json only stores
    // the thumbnail). If the file is gone, fall back to dashboard.
    let dataUrl: string | null = null
    if (item.filePath) {
      try {
        const { readFile } = await import('fs/promises')
        const { resolve, normalize, extname } = await import('path')
        const { homedir } = await import('os')
        const normalized = resolve(normalize(item.filePath))
        if (normalized.startsWith(homedir())) {
          const ext = extname(normalized).toLowerCase()
          const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
          const buf = await readFile(normalized)
          dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        }
      } catch { /* missing file → dashboard */ }
    }
    if (dataUrl) {
      route = '/editor'
      state = {
        kind: 'image',
        dataUrl,
        source: 'history',
        historyId: item.id,
        annotations: item.annotations,
      }
    }
  }

  const wasHidden = !main.isVisible()
  if (state) main.webContents.send('navigate', route, state)
  else main.webContents.send('navigate', route)

  // Only gate the show() call on view:mounted when we're surfacing from
  // a hidden state — that's where the flash is visible. If the window
  // was already on screen, the route change ripples in live and there's
  // no flash to suppress (and view:mounted may not fire at all when
  // pathname stays the same, e.g. /editor → /editor with new state).
  if (wasHidden) await waitForViewMounted(route)

  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

/** Restore window/dock state after the user cancels an overlay session
 *  (ESC, click outside, etc.). If the user hadn't dismissed the main
 *  window (it was open when they triggered capture), bring it back to
 *  the front. If they had (capture invoked from tray-only state via
 *  hotkey or tray menu), keep the main window hidden and drop the dock
 *  icon to return to the prior tray-only state. */
export function restoreFromOverlayCancel() {
  if (mainDismissedByUser) {
    hideDock()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
}

// Parked (between-captures) overlay opacity. Windows: 0 — its occlusion
// tracker still treats alpha-0 layered windows as visible, so the renderer
// keeps compositing. macOS: NSWindow documents fully-transparent (alpha 0)
// windows as OCCLUDED, and Chromium halts the renderer's BeginFrame/rAF loop
// for occluded windows (independent of backgroundThrottling). That deadlocks
// the reveal: the bg-ready ack fires from inside a double-rAF, but frames only
// resume once opacity lifts — which waits on the ack — so every capture used
// to stall out the full fallback timeout (~1.5s perceived as "overlay takes
// 2s to appear"). Park at a sub-perceptual alpha instead: WindowServer counts
// any alpha > 0 as visible, the compositor keeps ticking, and the parked
// frame (≤0.2% of the previous capture) is imperceptible.
const PARKED_OPACITY = process.platform === 'darwin' ? 0.002 : 0

export function closeAllOverlays() {
  if (overlayPollTimer) {
    clearInterval(overlayPollTimer)
    overlayPollTimer = null
  }
  overlayDrawingInProgress = false
  // Snipping-Tool-style opacity trick: instead of win.hide() (which incurs
  // DWM fade-out + drops the alpha compositor for the renderer's frame,
  // causing the next show to flicker as the pipeline warms back up), keep
  // the overlay "shown" in DWM at (near-)zero opacity over its display. The
  // renderer stays composited; ramping opacity back to 1 next capture is
  // instant. We intentionally do NOT setBounds off-screen — Electron's
  // per-monitor DPI tracking can get scrambled on Windows when a window is
  // moved between monitors with different scale factors, manifesting as a
  // mis-scaled snapshot when the overlay returns to its display.
  for (const [, win] of overlayWindows) {
    if (win.isDestroyed()) continue
    win.setOpacity(PARKED_OPACITY)
    // Drop `forward: true` while parked — with it set, Chromium keeps
    // dispatching mouse-move to the renderer, and the renderer's CSS
    // `cursor: 'crosshair'` then bleeds through over apps below the
    // (invisible) overlay. Plain setIgnoreMouseEvents(true) sets
    // WS_EX_TRANSPARENT cleanly so the cursor hit-test falls through.
    win.setIgnoreMouseEvents(true)
    // Reset renderer state to its idle look (cursor default, no
    // crosshair) for the parked period. Belt-and-suspenders alongside
    // the EX_TRANSPARENT flag above.
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('overlay:set-active', false)
      // Drop the frozen snapshot while parked. Otherwise every pooled overlay
      // keeps its last capture alive until the next one — the BGRA buffer in
      // the renderer plus the full-screen <canvas> backing store in the GPU
      // process, i.e. displays × (8–16 MB × 2) sitting idle for hours. The
      // next capture pushes a fresh buffer before the overlay is revealed.
      win.webContents.send('overlay:frozen-bgra-changed', null)
    }
  }
  overlayWindows.clear()
  activeOverlayDisplayId = null
}

const ICON_PATH = process.platform === 'win32'
  ? join(__dirname, '../../resources/icons/win/icon.ico')
  : process.platform === 'darwin'
    ? join(__dirname, '../../resources/icons/mac/icon.icns')
    : join(__dirname, '../../resources/icon.png')

function createMainWindow(startHidden = false): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  const win = new BrowserWindow({
    width: 1250,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07070b',
    icon: ICON_PATH,
    // Defer first paint via ready-to-show below to avoid an empty frame flash
    // on slow renderer cold-starts. startHidden boot keeps the window hidden.
    show: false,
    // VSCode-style: frameless on both platforms
    // macOS: traffic lights inset; Windows: native overlay controls
    frame: false,
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 20 }
    } : isWin ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#07070b',
        symbolColor: '#94a3b8',
        height: 40
      }
    } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Remove native menu bar entirely (replaced by custom TitleBar in HTML)
  win.setMenu(null)

  if (isDev) {
    win.loadURL('http://localhost:5173/#/dashboard')
    // win.webContents.openDevTools({ mode: 'detach' })

  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  }

  // Two-stage show: ready-to-show only means the renderer has painted its
  // initial HTML/CSS, but at that moment Dashboard's IPC fetches and font
  // downloads are still in-flight, so the window pops up half-loaded. Wait
  // for the renderer to send 'window:ready' (App.tsx fires it once those
  // settle) before showing. Fallback timer guarantees the window appears
  // within 1s even if the signal is dropped (renderer crash, IPC failure).
  let shown = false
  const showOnce = () => {
    if (shown || startHidden || win.isDestroyed() || win.isVisible()) return
    shown = true
    win.show()
  }
  ipcMain.once('window:ready', () => showOnce())
  win.once('ready-to-show', () => {
    setTimeout(showOnce, 1000)
    // Opt main out of DWM's hide animation so capture flows can rely on
    // win.hide() removing it from the compositor instantly. Without this,
    // Windows fades main over ~200ms; freezeAllDisplays lands mid-fade
    // and bakes a translucent Lumia frame into the cached screenshot.
    disableDwmTransitions(win)
  })

  // Intercept close: keep the app alive in the tray instead of exiting. Only
  // actually close when we're explicitly quitting (tray Quit / hotkey / IPC).
  // On /editor, X is normally a "discard capture" button — navigate back
  // to the dashboard and keep the window open. Exception: if the user
  // surfaced this editor session by clicking a notification while in tray
  // (`surfacedFromTray`), they came from tray — return them to tray.
  win.on('close', async (e) => {
    if (isQuitting) return
    e.preventDefault()
    if (currentRoute === '/editor' && !surfacedFromTray) {
      currentRoute = '/dashboard'
      win.webContents.send('navigate', '/dashboard')
      return
    }
    // Either an explicit user close on a non-/editor route, or a close on
    // /editor after a tray-notification surface — both end the same way:
    // hide window to tray AND drop the dock icon. Clear the one-shot tray
    // flag so the next session starts fresh. If we were on /editor,
    // reset the renderer to /dashboard first — otherwise the next time
    // the user surfaces the window, Chromium serves the cached editor
    // frame before React's pending /dashboard commit gets a paint pass,
    // producing a visible flash of stale state. `waitForViewMounted`
    // gates the hide on the renderer ack so the cached frame *is* the
    // dashboard.
    if (currentRoute === '/editor') {
      currentRoute = '/dashboard'
      win.webContents.send('navigate', '/dashboard')
      await waitForViewMounted('/dashboard')
    }
    surfacedFromTray = false
    mainDismissedByUser = true
    hideDock()
    win.hide()
  })

  // After the window goes to the tray, schedule install of any pending update.
  // Cancelled if the user surfaces the window again within the grace window.
  win.on('hide', () => { scheduleAutoInstall() })
  win.on('show', () => {
    mainDismissedByUser = false
    // Note: surfacedFromTray is NOT cleared here — see its declaration
    // for the timing rationale. The flag is cleared by the close handler
    // (one-shot) and never auto-cleared on show.
    cancelAutoInstall()
    showDock()
    // macOS: refresh the screen-snap helper's shareable-content cache now
    // that main is on screen — its window must be in that cache for the
    // capture-time PID exclusion (which is what lets hideMainWindow skip
    // its compositor-settle wait) to catch it. Cheap no-op-ish on Windows
    // (1×1 BitBlt).
    prewarmNativeCapture()
  })

  win.on('closed', () => { mainWindow = null })
  return win
}

function addOverlayToPool(display: Electron.Display): BrowserWindow {
  const { x, y, width, height } = display.bounds
  const displayBounds = { x, y, width, height }

  const win = new BrowserWindow({
    ...displayBounds,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    // Pre-warmed: kept hidden until the user triggers a capture / record.
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Pool overlays live hidden (opacity 0, showInactive) between captures.
      // With the default backgroundThrottling, Chromium throttles a non-visible
      // renderer's timers and — critically — its requestAnimationFrame loop
      // after it's been idle. That stalls the double-rAF in Overlay.tsx that
      // gates `overlay:bg-ready`, so on the first capture (or one after a long
      // idle) the ack arrives late and the overlay surfaces slowly — worst case
      // not until the 1500ms BG_READY_TIMEOUT_MS fallback. Disabling throttling
      // keeps the pre-warmed renderer at full frame rate so the snapshot paints
      // and acks immediately. Matches the recording windows in video.ts.
      backgroundThrottling: false,
    }
  })

  if (process.platform === 'win32') {
    win.setBounds(displayBounds)
  }

  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true)

  // Dedicated lean entry (src/overlay.html → overlay-main.tsx): no router,
  // no dashboard/editor bundle, only the fonts the overlay uses. These
  // renderers live for the whole session, one per display, so every byte
  // the entry pulls in is paid N times.
  if (isDev) {
    win.loadURL('http://localhost:5173/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  // One-time per-window setup: register the HWND for the native click-through
  // helper, kill DWM transitions, then immediately surface the window at
  // opacity 0 over its display. This lights up the alpha compositor + caches
  // the first rendered frame *before* the user ever triggers a capture, so
  // the hot-path (createOverlayWindows) just bumps opacity to 1 — no fade,
  // no cold-start render, no transparent-window flicker. Bounds stay at the
  // display: moving an Electron window across monitors with different DPI
  // scrambles its scale-factor tracking on Windows.
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    if (process.platform === 'win32') {
      const hwnd = win.getNativeWindowHandle().readInt32LE(0)
      registerOverlayHwnd(hwnd)
      disableDwmTransitions(win)
    }
    win.setOpacity(PARKED_OPACITY)
    // No `forward` — pool windows are parked invisible at this point; we
    // want cursor hit-test to fall through (otherwise the renderer's
    // crosshair cursor leaks over apps below).
    win.setIgnoreMouseEvents(true)
    win.showInactive()
  })

  win.on('closed', () => {
    if (process.platform === 'win32') {
      try {
        const hwnd = win.getNativeWindowHandle().readInt32LE(0)
        unregisterOverlayHwnd(hwnd)
      } catch { /* window already destroyed */ }
    }
    overlayPool.delete(display.id)
    overlayWindows.delete(display.id)
  })

  labelWebContents(win.webContents, `overlay:${display.id} ${width}x${height}@${display.scaleFactor}x`)
  overlayPool.set(display.id, win)
  return win
}

/** Initialise the overlay pool: one hidden BrowserWindow per display, plus
 *  listeners that keep the pool in sync with monitor plug/unplug events.
 *  Idempotent — safe to call multiple times. */
export function setupOverlayPool() {
  if (overlayPoolReady) return
  overlayPoolReady = true

  for (const display of screen.getAllDisplays()) {
    addOverlayToPool(display)
  }

  screen.on('display-added', (_e, display) => {
    if (!overlayPool.has(display.id)) addOverlayToPool(display)
  })
  screen.on('display-removed', (_e, display) => {
    const win = overlayPool.get(display.id)
    if (win && !win.isDestroyed()) win.destroy()
  })
  screen.on('display-metrics-changed', (_e, display) => {
    const win = overlayPool.get(display.id)
    if (win && !win.isDestroyed()) {
      win.setBounds(display.bounds)
    }
  })
}

// Wait for the renderer to ack that the frozen bg is decoded + painted, then
// ramp opacity to 1 in one shot. Without the gate, opacity flips before the
// renderer has committed the new bg → user sees a stale frame from the
// previous capture for one composite cycle. Falls back after a timeout so a
// renderer hang doesn't strand the user with an invisible overlay. The ack
// normally lands within a few frames (parked overlays keep compositing — see
// PARKED_OPACITY), so the timeout is pure safety net; keep it short enough
// that even the degenerate path feels responsive.
const BG_READY_TIMEOUT_MS = 600

function revealOverlayWhenBgReady(win: BrowserWindow, displayId: number, isActive: boolean): void {
  const wcId = win.webContents.id
  let done = false

  const reveal = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    ipcMain.off('overlay:bg-ready', handler)
    if (win.isDestroyed() || !overlayWindows.has(displayId)) return
    if (isActive) {
      win.setIgnoreMouseEvents(false)
      // Bring to top + grab keyboard focus so the renderer's ESC handler
      // receives keydown without the user having to click the overlay
      // first. We surfaced with showInactive() at pool time to avoid
      // stealing focus pre-capture, but during a live capture the user
      // expects ESC to work immediately.
      win.focus()
    }
    else win.setIgnoreMouseEvents(true, { forward: true })
    win.setOpacity(1)
  }

  const handler = (e: Electron.IpcMainEvent) => {
    if (e.sender.id === wcId) reveal()
  }

  const timer = setTimeout(reveal, BG_READY_TIMEOUT_MS)
  ipcMain.on('overlay:bg-ready', handler)
}

export function createOverlayWindows(): Map<number, BrowserWindow> {
  closeAllOverlays()
  // Remember the foreground window before any overlay grabs focus — it's the
  // "active window" that Enter confirms while the window picker is up.
  snapshotActivePickWindow()
  // Lazy fallback: caller might invoke this before whenReady has finished
  // wiring up the pool (e.g. tests, or display-added racing with first capture).
  if (!overlayPoolReady) setupOverlayPool()

  // macOS: ensure the dock icon is visible — app is being used regardless of
  // how the capture was invoked. If we were in Accessory mode (user closed
  // main to tray, then triggered capture via hotkey / tray menu), this flips
  // back to Regular activation policy so the overlay can take focus.
  showDock()

  const allDisplays = screen.getAllDisplays()
  const cursorPoint = screen.getCursorScreenPoint()
  const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint)
  activeOverlayDisplayId = cursorDisplay.id

  // Reconcile pool against current displays — covers any display change
  // events that fired between `setupOverlayPool` and now.
  for (const display of allDisplays) {
    if (!overlayPool.has(display.id)) addOverlayToPool(display)
  }

  const currentMode = getOverlayMode()

  for (const display of allDisplays) {
    const win = overlayPool.get(display.id)
    if (!win || win.isDestroyed()) continue

    const { x, y, width, height } = display.bounds
    const displayBounds = { x, y, width, height }
    const isActive = display.id === activeOverlayDisplayId

    // Move into position while still invisible (opacity 0) — bounds change is
    // free under DWM when the window isn't rendering pixels to the desktop.
    win.setBounds(displayBounds)

    // Reset renderer state for a fresh session: pushes the current mode and
    // clears any leftover draw state from a previous capture. The renderer
    // listens for 'overlay:mode-changed' and resets startPos/currentPos/etc.
    win.webContents.send('overlay:mode-changed', currentMode)
    win.webContents.send('overlay:set-active', isActive)
    // Push the frozen-screen snapshot captured at hotkey-press time (null
    // for video flows) as raw BGRA bytes. Renderer paints it to a <canvas>
    // via putImageData and acks once a frame has been committed; we gate
    // setOpacity(1) on that ack so the first visible frame already has the
    // snapshot. Without this gate, opacity flips before the renderer
    // commits → user sees the previous capture's bg for one frame.
    //
    // We pass raw BGRA (not a data URL) because PNG-encoding a 4K display
    // takes ~500-1000ms and would land on the critical path before the
    // overlay can surface. toBitmap() is free.
    const frozenBgr = getFrozenBgrForDisplay(display.id)
    win.webContents.send('overlay:frozen-bgra-changed', frozenBgr)

    overlayWindows.set(display.id, win)

    if (frozenBgr) {
      revealOverlayWhenBgReady(win, display.id, isActive)
    } else {
      // Video flow: no snapshot to wait for, surface immediately.
      if (isActive) {
        win.setIgnoreMouseEvents(false)
        win.focus()
      } else {
        win.setIgnoreMouseEvents(true, { forward: true })
      }
      win.setOpacity(1)
    }
  }

  // Poll cursor position to switch active overlay when mouse moves between
  // displays. Pointless with a single display — the active overlay is already
  // pinned at creation and can never change — so skip the 10/s wakeups on the
  // most common hardware config.
  if (allDisplays.length <= 1) return overlayWindows
  overlayPollTimer = setInterval(() => {
    if (overlayDrawingInProgress) return // don't switch while user is drawing

    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    if (display.id !== activeOverlayDisplayId) {
      const oldId = activeOverlayDisplayId
      activeOverlayDisplayId = display.id

      // Deactivate old overlay
      if (oldId != null) {
        const oldWin = overlayWindows.get(oldId)
        if (oldWin && !oldWin.isDestroyed()) {
          oldWin.webContents.send('overlay:set-active', false)
          oldWin.setIgnoreMouseEvents(true, { forward: true })
        }
      }

      // Activate new overlay
      const newWin = overlayWindows.get(display.id)
      if (newWin && !newWin.isDestroyed()) {
        newWin.webContents.send('overlay:set-active', true)
        newWin.setIgnoreMouseEvents(false)
        newWin.focus()
      }
    }
  }, 100)

  return overlayWindows
}

function navigateTo(route: string) {
  if (!mainWindow) return
  if (isDev) {
    mainWindow.loadURL(`http://localhost:5173/#${route}`)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  }
}

// Set application menu — hidden on Windows (frameless), but provides keyboard accelerators
if (isDev) {
  const devMenu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Dev',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache() },
        { label: 'Toggle DevTools', accelerator: process.platform === 'darwin' ? 'Alt+CmdOrCtrl+I' : 'Ctrl+Shift+I', click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools() },
      ],
    },
  ])
  Menu.setApplicationMenu(devMenu)
} else {
  // On macOS, Cut/Copy/Paste/Undo work via the application menu's Edit entry.
  // Setting null removes that, breaking all text-input shortcuts system-wide.
  // Keep a minimal hidden menu so keyboard shortcuts still work.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      }
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

if (process.platform === 'win32') {
  // Packaged: must match `appId` in electron-builder.yml — NSIS registers
  // the Start Menu shortcut under that AUMID, and WinRT silently drops
  // toasts when the runtime AUMID doesn't match the shortcut.
  //
  // Dev: a parallel-installed production build owns `com.lumia.app`, so
  // toast activations from the dev process would race-route to the
  // production launcher. Suffix `.dev` keeps the two namespaces separate
  // and lets `dev-shortcut.ts` plant a matching shortcut just for dev.
  const aumid = app.isPackaged ? 'com.lumia.app' : 'com.lumia.app.dev'
  app.setAppUserModelId(aumid)

  // Register the URL scheme our toasts use as the `launch` target. Without
  // this, clicking a toast — which Windows resolves as "open lumia:notify"
  // — has no registered handler and silently no-ops. With it, Windows
  // spawns electron via the registered protocol command, which trips our
  // single-instance lock and surfaces as `app.on('second-instance')`.
  // Dev needs to embed the project root in the registered command so the
  // spawned electron.exe knows what to load.
  const protocol = app.isPackaged ? 'lumia' : 'lumia-dev'
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(protocol)
  } else {
    app.setAsDefaultProtocolClient(protocol, process.execPath, [app.getAppPath()])
  }
}

app.whenReady().then(async () => {
  // Plant the Start Menu shortcut that registers our AUMID with the Windows
  // shell. Without it, dev-mode toast clicks have no launcher to activate
  // and silently no-op. Fire-and-forget; failure is non-fatal.
  ensureDevStartMenuShortcut()

  // Allow getUserMedia desktop capture in all windows (needed for overlay region capture)
  const { session } = await import('electron')
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })

  const startHidden = wasLaunchedAtStartup()
  mainWindow = createMainWindow(startHidden)
  labelWebContents(mainWindow.webContents, 'main')

  // macOS: normal launches leave the dock visible (default). Login-item
  // startups boot straight to the tray, so drop the dock icon explicitly —
  // user only sees Lumia in the menubar as expected. The startHidden state
  // is the same end state as a user-dismissed window, so seed the dismiss
  // flag accordingly — first capture-then-cancel returns to tray.
  if (startHidden) {
    mainDismissedByUser = true
    hideDock()
  }

  // Keep the OS login-item entry in sync with the stored preference on every
  // launch (covers app moves, reinstalls, and settings changed while offline).
  applyLaunchAtStartup(getSettings().launchAtStartup)

  // Mirror the PrintScreen-as-capture preference into Windows's registry on
  // every launch. The toggle being on means: snipping hijack must be off so
  // PrtSc reaches our globalShortcut. fire-and-forget; warnings are surfaced
  // only via the IPC return when the user explicitly toggles in Settings.
  void setSnippingHijack(!getSettings().printScreenAsCapture)

  setupCapture()
  setupVideo()
  setupStickers()
  setupHotkeys()
  setupTray()
  setupScrollCapture(mainWindow, createOverlayWindows, closeAllOverlays, getOverlayDisplayId, restoreFromOverlayCancel)
  // Local WebSocket bridge for the companion browser extension (extension
  // scroll-capture method). Starts listening immediately so the extension's
  // service worker can attach whenever the browser is running.
  setupExtensionBridge(getMainWindow)

  // Init the desktopCapturer pipeline now so the first hotkey press doesn't
  // pay the ~300-500ms cold-start. Fire-and-forget — no consumer waits on it.
  void prewarmDesktopCapturer()

  // Warm the native capture path too — the primary screenshot route on both
  // platforms. Windows: the first GDI call does the koffi/user32/gdi32
  // binding. macOS: spawns the ScreenCaptureKit helper and pre-fetches its
  // shareable-content cache. Either would otherwise land on the first
  // hotkey's critical path.
  prewarmNativeCapture()

  // Same idea for the macOS window-at-point helper (window-pick hover +
  // window lists) — spawn it now instead of on the first pick hotkey.
  prewarmMacWindowPick()

  // Pre-warm the overlay pool: one hidden BrowserWindow per display, with
  // the renderer already loaded. The first capture after boot drops from
  // ~300–500ms (window construct + React boot) to ~30ms (show + IPC reset).
  setupOverlayPool()

  // Per-process memory breakdown into the log at +10 s / +60 s (mem-metrics.ts).
  setupMemoryLogging()

  // Surface OS permission prompts (Screen Recording / Microphone / Accessibility
  // on macOS, Microphone on Windows) at startup rather than mid-capture. Skip
  // when launched hidden at boot — we'll preflight when the user surfaces the
  // window via the tray. Small delay so the dashboard paints first.
  if (!startHidden) {
    setTimeout(() => { void preflightPermissions(mainWindow) }, 1500)
  } else if (mainWindow) {
    mainWindow.once('show', () => {
      setTimeout(() => { void preflightPermissions(mainWindow) }, 800)
    })
  }

  // IPC: Overlay drawing state — lock active display while user is drawing
  ipcMain.on('overlay:drawing', (_e, drawing: boolean) => {
    overlayDrawingInProgress = drawing
  })

  // IPC: Renderer route tracking — used to intercept close on /editor
  ipcMain.on('app:route-changed', (_e, route: string) => {
    // Leaving /editor via in-app navigation (the Editor's Back button
    // calls react-router's navigate('/dashboard')) means the user
    // explicitly stepped out of the notification-opened editor session.
    // Clear the tray flag so the next /editor X-close (after they pick
    // a different item from the dashboard) follows the normal
    // dashboard-return behavior, not the tray-return one.
    if (currentRoute === '/editor' && route !== '/editor') {
      surfacedFromTray = false
    }
    currentRoute = route
  })

  // Auto-update
  const sendUpdateStatus = (status: string, payload: Record<string, unknown> = {}) => {
    mainWindow?.webContents.send('update:status', { status, ...payload })
  }

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] error:', err)
    sendUpdateStatus('error', { error: String(err?.message ?? err) })
  })
  autoUpdater.on('checking-for-update', () => {
    console.log('[autoUpdater] checking...')
    sendUpdateStatus('checking')
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] update available:', info.version)
    sendUpdateStatus('available', { version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdater] up to date')
    sendUpdateStatus('not-available')
  })
  autoUpdater.on('download-progress', (p) => {
    console.log(`[autoUpdater] downloading ${Math.round(p.percent)}% (${p.transferred}/${p.total})`)
    sendUpdateStatus('downloading', { percent: p.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdater] update downloaded:', info.version)
    mainWindow?.webContents.send('update:downloaded', info.version)
    sendUpdateStatus('downloaded', { version: info.version })
    updateDownloaded = true
    // If the user already has the app minimized to tray, the grace window
    // starts now — install if they don't surface the window within it.
    scheduleAutoInstall()
  })

  // Probe whether this process can write to the install dir. If not (typical
  // case: per-machine install on Windows being run by a non-admin user), the
  // silent NSIS update path can't apply the new bits — and falling back to
  // the UI installer would pop UAC every check. So we just disable the whole
  // auto-update pipeline: no check, no download, no banner. Users in this
  // state must update manually by running the new installer with admin.
  let canWriteInstallDir = false
  try {
    // fs.access(W_OK) does NOT consult Windows ACLs — it only checks the
    // read-only attribute, so it reports a Program Files dir as writable for a
    // non-admin user (exactly the case this guard exists for). Probe by
    // actually creating and deleting a temp file in the install dir.
    const probe = join(dirname(app.getPath('exe')), `.lumia-write-probe-${process.pid}`)
    await fs.writeFile(probe, '')
    await fs.unlink(probe).catch(() => { /* best-effort cleanup */ })
    canWriteInstallDir = true
  } catch { /* not writable — auto-update disabled */ }

  const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
  if (!isDev && canWriteInstallDir) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    console.log(`[autoUpdater] current version ${app.getVersion()}, checking for updates...`)
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdater] checkForUpdates failed:', err)
    })
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[autoUpdater] periodic check failed:', err)
      })
    }, UPDATE_CHECK_INTERVAL_MS)
  } else if (!isDev) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    console.log('[autoUpdater] install dir not writable — auto-update disabled. Update manually via the new installer.')
  }

  ipcMain.handle('update:install', () => {
    if (!canWriteInstallDir) return
    // Must set isQuitting before quitAndInstall — electron-updater triggers
    // app.quit() internally, and our before-quit handler hides to tray
    // unless isQuitting is true, which would silently swallow the restart.
    updateDownloaded = false
    cancelAutoInstall()
    isQuitting = true
    // Silent install on Windows so the NSIS UI doesn't surface on every
    // update; isForceRunAfter brings the app back up after install. No-op
    // for the macOS update path (zip-based, no installer UI to silence).
    autoUpdater.quitAndInstall(true, true)
  })
  ipcMain.handle('update:check', async () => {
    if (isDev) {
      sendUpdateStatus('checking')
      setTimeout(() => sendUpdateStatus('not-available'), 400)
      return { ok: true, dev: true }
    }
    if (!canWriteInstallDir) {
      sendUpdateStatus('error', { error: 'Auto-update is unavailable because Lumia is installed to a location this user cannot write to. Reinstall with administrator rights to enable updates.' })
      return { ok: false, error: 'install-dir-not-writable' }
    }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendUpdateStatus('error', { error: message })
      return { ok: false, error: message }
    }
  })
  // Renderer reads this to hide the "Check for Updates" menu entry when the
  // current process can't apply updates anyway. Always true in dev so the
  // menu item still works for testing the IPC.
  ipcMain.handle('update:available', () => isDev || canWriteInstallDir)

  ipcMain.handle('app:version', () => app.getVersion())

  // IPC: Navigation
  ipcMain.handle('navigate', (_e, route: string) => {
    navigateTo(route)
  })

  // IPC: Workflow
  const templateStore = new TemplateStore()
  const workflowEngine = new WorkflowEngine(templateStore)

  ipcMain.handle('workflow:getTemplates', () => templateStore.getAll())
  ipcMain.handle('workflow:saveTemplate', (_e, template) => templateStore.save(template))
  ipcMain.handle('workflow:deleteTemplate', (_e, id: string) => templateStore.delete(id))
  ipcMain.handle('workflow:run', async (_e, templateId: string, imageData: string, destinationIndex?: number, historyId?: string) => {
    return workflowEngine.run(templateId, imageData, destinationIndex, historyId)
  })
  ipcMain.handle('workflow:inlineAction', async (_e, actionType: 'clipboard' | 'save', imageData: string, historyId?: string) => {
    return workflowEngine.runInlineAction(actionType, imageData, historyId)
  })

  // IPC: History
  const historyStore = new HistoryStore()
  historyStoreInstance = historyStore

  // One-time upgrade cleanup. Bump HISTORY_CLEANUP_VERSION when the data
  // model diverges from prior releases badly enough that wiping existing
  // history + sidecar files is friendlier than trying to migrate. Runs
  // once per bump (guarded inside HistoryStore), then never again.
  const HISTORY_CLEANUP_VERSION = 1
  try {
    const wiped = await historyStore.runStartupCleanup(HISTORY_CLEANUP_VERSION)
    if (wiped > 0) console.log(`[history] upgrade reset v${HISTORY_CLEANUP_VERSION} — removed ${wiped} legacy item(s)`)
  } catch (err) {
    console.error('[history] upgrade cleanup failed', err)
  }

  // Background retention cleanup: prune on boot and then hourly. `days <= 0`
  // means keep forever, so the store skips the scan — cheap to keep running.
  // Prune unlinks the associated files on disk too (shared with the manual
  // delete path in HistoryStore), so old captures don't sit around orphaned.
  const runHistoryPrune = async () => {
    try {
      const days = getSettings().historyRetentionDays
      const removed = await historyStore.pruneOlderThan(days)
      if (removed > 0) console.log(`[history] pruned ${removed} item(s) older than ${days} day(s)`)
    } catch (err) {
      // Fire-and-forget from boot, an hourly timer, and settings:set — a sync
      // electron-store write can throw (EPERM from AV file-locking on Windows),
      // which would otherwise surface as a recurring unhandled rejection.
      console.error('[history] prune failed', err)
    }
  }
  runHistoryPrune()
  const HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000
  const historyPruneTimer = setInterval(runHistoryPrune, HISTORY_PRUNE_INTERVAL_MS)
  app.on('will-quit', () => clearInterval(historyPruneTimer))

  ipcMain.handle('history:get', async () => {
    const items = historyStore.getAll()
    const { access } = await import('fs/promises')
    // fs.access is microsecond-fast on SSDs; 200 parallel probes are trivial.
    return Promise.all(items.map(async (item) => {
      if (!item.filePath) return item
      try {
        await access(item.filePath)
        return item
      } catch {
        return { ...item, fileMissing: true }
      }
    }))
  })
  ipcMain.handle('history:delete', async (_e, id: string) => {
    // Store.delete unlinks filePath + annotatedFilePath (bounded to homedir,
    // ENOENT ignored) and then mutates history.json.
    return historyStore.delete(id)
  })
  // Bulk delete in a single read-filter-write. The renderer previously fired
  // N concurrent history:delete calls, which all snapshotted the same array
  // and clobbered each other (last-writer-wins) — deleted rows resurrected as
  // "Missing" orphans on the next refetch. deleteMany closes that race.
  ipcMain.handle('history:deleteMany', async (_e, ids: string[]) => {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    return historyStore.deleteMany(ids)
  })
  ipcMain.handle('history:cleanupMissing', async () => {
    const items = historyStore.getAll()
    const { access } = await import('fs/promises')
    const orphanIds: string[] = []
    await Promise.all(items.map(async (item) => {
      if (!item.filePath) return
      try { await access(item.filePath) } catch { orphanIds.push(item.id) }
    }))
    // Single read-filter-write — the old Promise.all(map(delete)) raced and
    // left orphans behind.
    if (orphanIds.length > 0) await historyStore.deleteMany(orphanIds)
    return orphanIds.length
  })
  // Persist the current annotation shapes (and optionally a flattened PNG
  // sidecar) for a history item. Reopening the item replays each shape as
  // its own Canvas commit so native Undo walks back through them in order.
  ipcMain.handle('history:saveAnnotations', async (_e, id: string, annotations: unknown[], flattenedDataUrl?: string) => {
    const items = historyStore.getAll()
    const item = items.find(i => i.id === id)
    if (!item) throw new Error('History item not found')
    if (!item.filePath) throw new Error('History item has no source file')

    const { writeFile, unlink } = await import('fs/promises')
    const { resolve, normalize, dirname, basename, extname, join } = await import('path')
    const { homedir } = await import('os')
    const originalPath = resolve(normalize(item.filePath))
    if (!originalPath.startsWith(homedir())) throw new Error('Access denied — path outside home directory')

    const hasAnnotations = Array.isArray(annotations) && annotations.length > 0

    // Preserve the existing sidecar + thumbnail by default — only the branches
    // below overwrite them. Without this, a debounced save (which ships only
    // the vector JSON, no flattened dataUrl) would reset `annotatedFilePath`
    // to undefined, orphan the sidecar on disk, and force Dashboard Share/
    // Copy back to the un-annotated original.
    let annotatedFilePath: string | undefined = item.annotatedFilePath
    let thumbnailUrl = item.thumbnailUrl

    if (hasAnnotations && typeof flattenedDataUrl === 'string' && flattenedDataUrl.startsWith('data:image/')) {
      // Write (or overwrite) the sidecar PNG next to the original. Naming
      // keeps the basename so a user browsing ~/Pictures/Lumia still sees the
      // original and annotated side-by-side.
      const dir = dirname(originalPath)
      const ext = extname(originalPath) || '.png'
      const stem = basename(originalPath, ext)
      const sidecar = join(dir, `${stem}-annotated.png`)

      // Renderer's canvas.toDataURL emits 32-bit RGBA PNGs even when the
      // composite is fully opaque (annotation drawn over an opaque
      // background → every output pixel ends at alpha=255). Pipe through
      // NativeImage so Chromium's main-process PNG encoder — which detects
      // all-opaque images and downgrades to 24-bit RGB (colorType=2) —
      // takes over. Lossless pixel-wise, ~25-30% smaller on opaque content.
      let sidecarBuf = nativeImage.createFromDataURL(flattenedDataUrl).toPNG()

      // Konva's canvas encoder also doesn't embed any color profile. Lift
      // the iCCP chunk off the on-disk original (already tagged at capture
      // time) and stamp it onto the sidecar so both files share the same
      // color space. Best-effort — missing original ICC just leaves the
      // sidecar un-tagged (same as pre-2.0.4 behavior, no regression).
      try {
        const { readFile } = await import('fs/promises')
        const originalBuf = await readFile(originalPath)
        const icc = getIccFromPng(originalBuf)
        if (icc) sidecarBuf = tagPngWithIcc(sidecarBuf, icc, 'Display')
      } catch { /* original missing or unreadable — write sidecar un-tagged */ }

      await writeFile(sidecar, sidecarBuf)
      annotatedFilePath = sidecar
      thumbnailUrl = makeThumbnail(flattenedDataUrl)
    }

    if (!hasAnnotations && item.annotatedFilePath) {
      try {
        const prev = resolve(normalize(item.annotatedFilePath))
        if (prev.startsWith(homedir())) await unlink(prev)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('[history:saveAnnotations] failed to clean up sidecar', err)
        }
      }
      annotatedFilePath = undefined
      // Regenerate thumbnail from the original now that annotations are gone.
      try {
        const { readFile } = await import('fs/promises')
        const buf = await readFile(originalPath)
        const ext = extname(originalPath).toLowerCase()
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
        thumbnailUrl = makeThumbnail(`data:${mime};base64,${buf.toString('base64')}`)
      } catch { /* leave previous thumbnail rather than blank the card */ }
    }

    return historyStore.update(id, {
      annotations: hasAnnotations ? (annotations as HistoryItem['annotations']) : undefined,
      annotatedFilePath,
      thumbnailUrl,
    })
  })

  // Upload a history item's source file to R2 and copy the resulting URL.
  // Dedup: if the item already has a successful r2 upload, reuse it so repeat
  // clicks don't re-issue requests (uploadToR2 itself is content-addressable
  // too, but this path short-circuits before even reading the file).
  ipcMain.handle('history:shareR2', async (_e, id: string) => {
    const items = historyStore.getAll()
    const item = items.find(i => i.id === id)
    if (!item) throw new Error('History item not found')
    if (!item.filePath) throw new Error('History item has no source file')

    const existing = item.uploads?.find(u => u.destination === 'r2' && u.success && u.url)
    if (existing?.url) {
      clipboard.writeText(existing.url)
      return existing
    }

    const { extname } = await import('path')

    // Prefer the annotated sidecar when present so shared links carry the
    // user's final edited version rather than the untouched original.
    const sourcePath = item.annotatedFilePath ?? item.filePath
    const ext = extname(sourcePath).replace(/^\./, '').toLowerCase() || (item.type === 'recording' ? 'webm' : 'png')
    const isVideo = item.type === 'recording'
    const contentType = isVideo
      ? (ext === 'mp4' ? 'video/mp4' : 'video/webm')
      : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png')
    const keyPrefix = isVideo ? 'recordings' : 'captures'

    const res = await uploadFileToR2(
      sourcePath,
      { contentType, ext, keyPrefix },
      import.meta.env.MAIN_VITE_R2_ACCOUNT_ID,
      import.meta.env.MAIN_VITE_R2_ACCESS_KEY_ID,
      import.meta.env.MAIN_VITE_R2_SECRET_ACCESS_KEY,
      import.meta.env.MAIN_VITE_R2_BUCKET,
      import.meta.env.MAIN_VITE_R2_PUBLIC_URL,
    )

    if (res.success && res.url) {
      clipboard.writeText(res.url)
      // Append (or replace) the r2 entry so subsequent shares hit the fast
      // path above, and so the Dashboard card can flip to "Synced".
      const uploads = [
        ...(item.uploads ?? []).filter(u => u.destination !== 'r2'),
        res,
      ]
      historyStore.update(id, { uploads })
      showNotification({
        body: 'Link copied to clipboard',
        thumbnailDataUrl: item.thumbnailUrl,
      })
    }
    return res
  })

  // Upload a history item's source file to Google Drive and copy the resulting
  // URL. Mirrors the R2 path: dedup if already uploaded, refresh OAuth token if
  // expired, persist the upload result so subsequent clicks short-circuit.
  ipcMain.handle('history:shareGoogleDrive', async (_e, id: string) => {
    const items = historyStore.getAll()
    const item = items.find(i => i.id === id)
    if (!item) throw new Error('History item not found')
    if (!item.filePath) throw new Error('History item has no source file')

    const existing = item.uploads?.find(u => u.destination === 'google-drive' && u.success && u.url)
    if (existing?.url) {
      clipboard.writeText(existing.url)
      return existing
    }

    const settings = getSettings()
    if (!settings.googleDriveRefreshToken) {
      return { destination: 'google-drive', success: false, error: 'Not connected to Google Drive' }
    }
    if (!settings.googleDriveFolderId) {
      return { destination: 'google-drive', success: false, error: 'No Drive folder selected — choose one in Settings → Google Drive.' }
    }

    const { extname, basename } = await import('path')
    const sourcePath = item.annotatedFilePath ?? item.filePath
    const ext = extname(sourcePath).replace(/^\./, '').toLowerCase()
    const isVideo = item.type === 'recording'
    const mimeType = isVideo
      ? (ext === 'mp4' ? 'video/mp4' : 'video/webm')
      : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png')

    // Stream the file straight from disk to the resumable uploader — no
    // whole-file buffer and no base64 data-URL intermediary. For a recording
    // that round-trip held the whole file plus a ~1.33× base64 string in
    // memory and blocked the main thread on the sync toString('base64'). The
    // service wrapper handles token refresh (with in-flight dedup + 401 retry)
    // and the default folder.
    const res = await uploadFilePathToDrive(sourcePath, mimeType, basename(sourcePath))

    if (res.success && res.url) {
      clipboard.writeText(res.url)
      const uploads = [
        ...(item.uploads ?? []).filter(u => u.destination !== 'google-drive'),
        res,
      ]
      historyStore.update(id, { uploads })
      showNotification({
        body: 'Drive link copied to clipboard',
        thumbnailDataUrl: item.thumbnailUrl,
      })
    }
    return res
  })

  ipcMain.handle('history:openFile', (_e, filePath: string) => {
    const { resolve, normalize } = require('path')
    const { homedir } = require('os')
    const normalized = resolve(normalize(filePath))
    if (!normalized.startsWith(homedir())) throw new Error('Access denied — path outside home directory')
    return shell.openPath(normalized)
  })
  ipcMain.handle('history:addCapture', async (_e, item) => {
    // If a renderer is adding a screenshot with only a dataUrl (e.g. scroll
    // capture, video-annotator frame extract), persist the original to
    // ~/Pictures/Lumia/ here so every history item references a real file.
    try {
      if (item && item.type === 'screenshot' && !item.filePath && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')) {
        const { writeFile, mkdir } = await import('fs/promises')
        await mkdir(ORIGINALS_DIR, { recursive: true })
        const ext = item.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'
        const filename = `capture-${localTimestamp()}.${ext}`
        const filePath = join(ORIGINALS_DIR, filename)
        const base64 = item.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        await writeFile(filePath, Buffer.from(base64, 'base64'))
        item = { ...item, name: item.name ?? filename, filePath }
      }
      // Replace the full dataUrl with a compact thumbnail. `filePath` is the
      // source of truth for the full image — dataUrl is never stored.
      if (item && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')) {
        const { dataUrl, thumbnailUrl, ...rest } = item
        item = { ...rest, thumbnailUrl: thumbnailUrl ?? makeThumbnail(dataUrl) }
      }
    } catch (err) {
      console.error('[history:addCapture] failed to persist original', err)
    }
    return historyStore.add(item)
  })
  ipcMain.handle('history:readAsDataUrl', async (_e, filePath: string) => {
    const { readFile } = await import('fs/promises')
    const { resolve, normalize, extname } = await import('path')
    const { homedir } = await import('os')
    const normalized = resolve(normalize(filePath))
    if (!normalized.startsWith(homedir())) throw new Error('Access denied — path outside home directory')
    const ext = extname(normalized).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
    try {
      const buf = await readFile(normalized)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (err: unknown) {
      // File deleted between history:get's fs.access probe and this read —
      // return null so renderer can refresh into the orphan state instead of
      // surfacing an ENOENT handler error on stderr.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  })

  // IPC: Overlay mode (scroll-region vs region)
  // Do NOT reset here — React StrictMode double-mounts the overlay,
  // causing a second call that would see 'region' instead of 'scroll-region'.
  // Mode is reset in scroll-region:confirm / scroll-region:cancel / region:confirm / region:cancel.
  ipcMain.handle('overlay:get-mode', () => {
    const mode = getOverlayMode()
    return mode
  })

  // IPC: Settings
  ipcMain.handle('hotkeys:get', () => getHotkeys())
  ipcMain.handle('hotkeys:getDefaults', () => ({ ...defaultHotkeys }))
  ipcMain.handle('hotkeys:set', (_e, hotkeys: HotkeyConfig) => {
    saveHotkeys(hotkeys)
    return getHotkeys()
  })
  ipcMain.handle('hotkeys:reset', () => resetHotkeys())
  // Renderer toggles this while the Settings UI is recording a new binding,
  // so existing global shortcuts don't fire (and double-bind) on the keys
  // the user is pressing to set the new combo.
  ipcMain.handle('hotkeys:setRecording', (_e, recording: boolean) => {
    if (recording) teardownHotkeys()
    else setupHotkeys()
  })
  ipcMain.handle('settings:get', () => {
    // Never ship the Google OAuth tokens to the renderer — a renderer
    // compromise (XSS via rendered content) could exfiltrate the long-lived
    // refresh token. The renderer only ever needs a connected boolean.
    const s = getSettings()
    return {
      ...s,
      googleDriveRefreshToken: '',
      googleDriveAccessToken: '',
      googleDriveConnected: !!s.googleDriveRefreshToken,
    }
  })
  ipcMain.handle('settings:set', (_e, key: keyof AppSettings, value: unknown) => {
    // Remember policy: only Region / Window picks update the replay modes —
    // see isRememberedMode in settings.ts. This is the choke point for all
    // renderer writers (Dashboard buttons, overlay ModeBar), so they can send
    // every selection and the policy lives in one place.
    if ((key === 'lastImageMode' || key === 'lastVideoMode') && !isRememberedMode(value)) return
    setSetting(key, value as AppSettings[typeof key])
    if (key === 'launchAtStartup') applyLaunchAtStartup(value as boolean)
    if (key === 'historyRetentionDays') runHistoryPrune()
  })

  // Dedicated IPC for the PrintScreen toggle: it has two side-effects (rebind
  // the global shortcut, write a Windows registry value) and the registry op
  // can fail in a way the renderer needs to surface as a warning, so we don't
  // route it through the generic settings:set channel. Returns
  // `{ warning?: string }` — a present `warning` means "the setting was
  // saved + shortcut updated, but registry write failed; Snipping Tool may
  // still eat PrtSc on Windows".
  ipcMain.handle('printscreen:set-enabled', async (_e, enabled: boolean) => {
    setSetting('printScreenAsCapture', enabled)
    // Manually toggling the setting also counts as "we asked, user answered"
    // so the first-run prompt doesn't pop up later and confuse the user.
    setSetting('printScreenPromptShown', true)
    // Tear down + rebuild the hotkey table so setupHotkeys() picks up the
    // new setting and (un)registers the PrtSc binding accordingly.
    teardownHotkeys()
    setupHotkeys()
    return setSnippingHijack(!enabled)
  })

  // IPC: Wallpapers (Unsplash). Lazy-import keeps the access-key check off the
  // hot path — Unsplash failures shouldn't bubble through `ipcMain.handle`'s
  // generic error path, so we surface them as `{ ok: false, error }` shapes
  // the renderer can render inline.
  ipcMain.handle('wallpapers:random', async (_e, opts) => {
    try {
      const { getRandomWallpapers } = await import('./wallpapers')
      const { photos, pickId } = await getRandomWallpapers(opts ?? { picks: [] })
      return { ok: true as const, photos, pickId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('wallpapers:trackDownload', async (_e, downloadLocation: string) => {
    const { trackWallpaperDownload } = await import('./wallpapers')
    await trackWallpaperDownload(downloadLocation)
    return { ok: true as const }
  })

  ipcMain.handle('wallpapers:isConfigured', async () => {
    const { isUnsplashConfigured } = await import('./wallpapers')
    return isUnsplashConfigured()
  })

  ipcMain.handle('wallpapers:setAsWallpaper', async (_e, photo) => {
    try {
      const { setDesktopWallpaper } = await import('./wallpapers')
      const result = await setDesktopWallpaper(photo)
      return { ok: true as const, filePath: result.filePath }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  // Favicon served by the local OAuth + picker servers so the browser tab the
  // user lands on during the Google Drive connect flow is recognizably Lumia
  // (alongside the page <title>). Read once, then reused across both servers.
  let cachedFavicon: Buffer | null = null
  const loadFavicon = async (): Promise<Buffer | null> => {
    if (cachedFavicon) return cachedFavicon
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png')
    try {
      cachedFavicon = await fs.readFile(iconPath)
      return cachedFavicon
    } catch {
      return null
    }
  }

  // IPC: Google Drive OAuth — uses localhost redirect (OOB flow deprecated by Google)
  // Tracks an in-progress OAuth flow so the renderer can cancel it (user clicked
  // Connect by mistake, opened the wrong browser, etc.). Calling startAuth again
  // while one is active first cancels the previous flow.
  let activeAuthServer: import('http').Server | null = null
  let activeAuthResolve: ((value: { success: boolean; error?: string; cancelled?: boolean }) => void) | null = null

  ipcMain.handle('gdrive:startAuth', async () => {
    const { createServer } = await import('http')
    const clientId = import.meta.env.MAIN_VITE_GDRIVE_CLIENT_ID
    const clientSecret = import.meta.env.MAIN_VITE_GDRIVE_CLIENT_SECRET

    if (activeAuthServer) {
      activeAuthServer.close()
      activeAuthServer = null
    }
    if (activeAuthResolve) {
      activeAuthResolve({ success: false, cancelled: true })
      activeAuthResolve = null
    }

    return new Promise<{ success: boolean; error?: string; cancelled?: boolean }>((resolve) => {
      // The OAuth server lifecycle is intentionally decoupled from `settle`:
      // after a successful code exchange we settle the IPC promise immediately
      // (so the renderer drops the connecting spinner), but keep the local
      // server listening so the Connected page's "Browse Drive folder" button
      // can hit /pick-folder. The server is finally torn down on Browse click,
      // on a new startAuth, on cancelAuth, or after the auto-close grace.
      let authAutoCloseTimer: ReturnType<typeof setTimeout> | null = null
      const settle = (value: { success: boolean; error?: string; cancelled?: boolean }) => {
        if (activeAuthResolve !== settle) return
        activeAuthResolve = null
        resolve(value)
      }
      activeAuthResolve = settle

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
          const buf = await loadFavicon()
          if (buf) {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
            res.end(buf)
          } else {
            res.writeHead(404)
            res.end()
          }
          return
        }

        // Browse button on the Connected page hits this route. Boot the
        // picker server (port 42814) and 302 the user's browser there.
        if (url.pathname === '/pick-folder') {
          const result = await startGdriveFolderPicker()
          if (!result.ok) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" type="image/png" href="/favicon.png"><title>Lumia — Couldn't open picker</title></head><body style="font-family:'Inter',-apple-system,sans-serif;background:#0d0d0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="max-width:420px;text-align:center;padding:40px"><h1 style="font-size:20px;margin:0 0 12px">Couldn't open the folder picker</h1><p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.6">${result.error}</p><p style="color:rgba(255,255,255,0.35);font-size:12px;margin-top:20px">Close this tab and try again from Lumia → Settings.</p></div></body></html>`)
            return
          }
          res.writeHead(302, { Location: result.url })
          res.end()
          // The browser is now redirected to the picker; tear down the OAuth
          // server shortly after so it doesn't linger on port 42813.
          if (authAutoCloseTimer) { clearTimeout(authAutoCloseTimer); authAutoCloseTimer = null }
          setTimeout(() => server.close(), 500)
          return
        }

        if (url.pathname !== '/') {
          res.writeHead(404)
          res.end()
          return
        }

        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Lumia — Authorization Failed</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0d0d0f;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    color: #fff;
  }
  .card {
    text-align: center;
    padding: 48px 56px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px;
    backdrop-filter: blur(24px);
    max-width: 420px;
    width: 90vw;
  }
  .icon {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: rgba(239,68,68,0.15);
    border: 1px solid rgba(239,68,68,0.3);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 24px;
    font-size: 28px;
  }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; letter-spacing: -0.3px; }
  p { font-size: 14px; color: rgba(255,255,255,0.45); line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">✕</div>
    <h1>Authorization failed</h1>
    <p>Something went wrong. You may close this tab and try again from Lumia.</p>
  </div>
</body>
</html>`)
          server.close()
          settle({ success: false, error: error ?? 'No code returned' })
          return
        }

        // Exchange the code BEFORE rendering the Connected page so that, by
        // the time the user sees the Browse button, the refresh token is
        // already on disk and /pick-folder is guaranteed to find it. On
        // failure we fall through to the same failure HTML.
        try {
          const result = await exchangeGoogleAuthCode(code, clientId, clientSecret, 'http://localhost:42813')
          setSetting('googleDriveAccessToken', result.accessToken)
          setSetting('googleDriveRefreshToken', result.refreshToken)
          setSetting('googleDriveTokenExpiresAt', result.expiresAt)
          mainWindow?.webContents.send('gdrive:connected')
          settle({ success: true })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><link rel="icon" type="image/png" href="/favicon.png"><title>Lumia — Authorization Failed</title></head><body style="font-family:'Inter',-apple-system,sans-serif;background:#0d0d0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="max-width:420px;text-align:center;padding:40px"><h1 style="font-size:20px;margin:0 0 12px">Authorization failed</h1><p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.6">${msg}</p></div></body></html>`)
          server.close()
          settle({ success: false, error: msg })
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Lumia — Connected</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0d0d0f;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    color: #fff;
  }
  .card {
    text-align: center;
    padding: 48px 56px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px;
    backdrop-filter: blur(24px);
    max-width: 460px;
    width: 90vw;
    animation: fadeUp 0.4s cubic-bezier(0.16,1,0.3,1) both;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .icon {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: rgba(74,222,128,0.12);
    border: 1px solid rgba(74,222,128,0.3);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 24px;
    font-size: 28px;
    animation: pop 0.5s 0.2s cubic-bezier(0.16,1,0.3,1) both;
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(0.6); }
    to   { opacity: 1; transform: scale(1); }
  }
  h1 {
    font-size: 22px; font-weight: 700;
    margin-bottom: 12px;
    letter-spacing: -0.3px;
  }
  p { font-size: 14px; color: rgba(255,255,255,0.55); line-height: 1.6; }
  .step {
    margin-top: 24px;
    padding: 14px 18px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px;
    font-size: 13px;
    color: rgba(255,255,255,0.7);
    line-height: 1.5;
    text-align: left;
  }
  .step strong { color: #fff; font-weight: 600; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 20px;
    padding: 12px 22px;
    background: #fff;
    color: #0d0d0f;
    border-radius: 12px;
    font-weight: 600;
    font-size: 14px;
    text-decoration: none;
    letter-spacing: -0.1px;
    transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
  }
  .btn:hover { background: #f1f1f1; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,0.25); }
  .btn svg { width: 16px; height: 16px; }
  .hint { margin-top: 16px; font-size: 12px; color: rgba(255,255,255,0.32); }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Connected!</h1>
    <p>Google Drive is linked to Lumia. One last step:</p>
    <div class="step"><strong>Choose a Drive folder</strong> where Lumia will upload your screenshots and recordings.</div>
    <a class="btn" href="/pick-folder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
      Browse Drive folders
    </a>
    <div class="hint">Or close this tab and pick a folder later from Lumia → Settings.</div>
  </div>
</body>
</html>`)
        // Keep the server alive so the Browse button can hit /pick-folder.
        // Auto-close after 10 minutes if the user closes the tab without
        // clicking Browse — the IPC has already settled, so this is purely
        // socket cleanup.
        if (authAutoCloseTimer) clearTimeout(authAutoCloseTimer)
        authAutoCloseTimer = setTimeout(() => server.close(), 10 * 60 * 1000)
      })

      activeAuthServer = server

      // Cleanup hook — covers all close paths (cancelAuth, /pick-folder
      // redirect, auto-close timer, new startAuth pre-empting us, listen
      // error). Without this the activeAuthServer reference would leak past
      // its actual lifetime.
      server.on('close', () => {
        if (authAutoCloseTimer) { clearTimeout(authAutoCloseTimer); authAutoCloseTimer = null }
        if (activeAuthServer === server) activeAuthServer = null
        // If the server died before the OAuth flow logically completed, treat
        // it as a cancellation so the IPC promise can't hang forever.
        settle({ success: false, cancelled: true })
      })

      server.listen(42813, '127.0.0.1', () => {
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: 'http://localhost:42813',
          response_type: 'code',
          scope: 'https://www.googleapis.com/auth/drive.file',
          access_type: 'offline',
          prompt: 'consent'
        })
        shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
      })

      server.on('error', (err) => {
        settle({ success: false, error: `Local server error: ${err.message}` })
      })
    })
  })

  ipcMain.handle('gdrive:cancelAuth', () => {
    if (activeAuthServer) {
      activeAuthServer.close()
      activeAuthServer = null
    }
    if (activeAuthResolve) {
      activeAuthResolve({ success: false, cancelled: true })
      activeAuthResolve = null
    }
    return { ok: true }
  })

  // IPC: Google Drive folder picker — serves Google's Picker JS via a local
  // HTTP server and opens it in the user's default browser. This way the
  // browser's existing Google session cookies render the picker UI without
  // re-login. Token is fetched via a one-time nonce so it never appears in the
  // URL bar / browser history.
  type PickerResult = { success: boolean; folder?: { id: string; name: string } | null; error?: string; cancelled?: boolean }
  let activePickerServer: import('http').Server | null = null
  let activePickerFinish: ((value: PickerResult) => void) | null = null

  // Spins up the picker HTTP server and returns its URL plus a promise that
  // settles when the user picks a folder, cancels, or the 5-minute timeout
  // fires. Used both by the `gdrive:pickFolder` IPC (Settings UI → opens picker
  // in a new browser tab) and by the OAuth `/pick-folder` route on port 42813
  // (Connected page's Browse button → 302 redirect to the picker URL).
  const startGdriveFolderPicker = async (): Promise<{ ok: false; error: string } | { ok: true; url: string; finished: Promise<PickerResult> }> => {
    const settings = getSettings()
    let { googleDriveAccessToken } = settings
    const { googleDriveRefreshToken, googleDriveTokenExpiresAt } = settings

    if (!googleDriveRefreshToken) {
      return { ok: false, error: 'Not connected to Google Drive' }
    }

    if (Date.now() >= googleDriveTokenExpiresAt - 60_000) {
      try {
        const refreshed = await refreshGoogleToken(
          import.meta.env.MAIN_VITE_GDRIVE_CLIENT_ID,
          import.meta.env.MAIN_VITE_GDRIVE_CLIENT_SECRET,
          googleDriveRefreshToken
        )
        googleDriveAccessToken = refreshed.accessToken
        setSetting('googleDriveAccessToken', refreshed.accessToken)
        setSetting('googleDriveTokenExpiresAt', refreshed.expiresAt)
      } catch (err) {
        return { ok: false, error: `Token refresh failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // Cancel any in-flight picker so we don't leak the previous server / EADDRINUSE on port 42814.
    if (activePickerServer) {
      activePickerServer.close()
      activePickerServer = null
    }
    if (activePickerFinish) {
      activePickerFinish({ success: false, cancelled: true })
      activePickerFinish = null
    }

    const { createServer } = await import('http')
    const { readFile } = await import('fs/promises')
    const { randomBytes } = await import('crypto')
    const nonce = randomBytes(16).toString('hex')
    const config = {
      token: googleDriveAccessToken,
      apiKey: import.meta.env.MAIN_VITE_GDRIVE_API_KEY,
      appId: import.meta.env.MAIN_VITE_GDRIVE_PROJECT_NUMBER
    }

    const pickerHtmlPath = app.isPackaged
      ? join(process.resourcesPath, 'picker.html')
      : join(__dirname, '../../resources/picker.html')
    let pickerHtml: string
    try {
      pickerHtml = await readFile(pickerHtmlPath, 'utf-8')
    } catch (err) {
      return { ok: false, error: `Failed to load picker.html: ${err instanceof Error ? err.message : String(err)}` }
    }

    let resolveFinished: (value: PickerResult) => void = () => {}
    const finished = new Promise<PickerResult>((resolve) => { resolveFinished = resolve })
    let resolved = false

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')

      // Favicon is fetched automatically by the browser without our nonce
      // query string, so it has to be served before the nonce gate. The icon
      // is non-sensitive and does not expose any token.
      if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
        const buf = await loadFavicon()
        if (buf) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
          res.end(buf)
        } else {
          res.writeHead(404)
          res.end()
        }
        return
      }

      if (url.searchParams.get('nonce') !== nonce) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(pickerHtml)
        return
      }
      if (url.pathname === '/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(config))
        return
      }
      if (url.pathname === '/result' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          try {
            const parsed = JSON.parse(body) as { id: string; name: string } | null
            finish({ success: true, folder: parsed })
          } catch {
            finish({ success: true, folder: null })
          }
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    const finish = (value: PickerResult) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutHandle)
      server.close()
      if (activePickerServer === server) activePickerServer = null
      if (activePickerFinish === finish) activePickerFinish = null
      if (value.folder?.id) setSetting('googleDriveFolderId', value.folder.id)
      // Notify the renderer so the Settings UI refreshes its folder display when
      // the picker was launched outside the IPC path (e.g. the Browse button on
      // the OAuth Connected page).
      if (value.success && value.folder) mainWindow?.webContents.send('gdrive:folderSelected')
      resolveFinished(value)
    }

    const timeoutHandle = setTimeout(() => {
      finish({ success: true, folder: null })
    }, 5 * 60 * 1000)

    server.on('error', (err) => {
      finish({ success: false, error: `Local server error: ${err.message}` })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve() }
        const onError = (err: Error) => { server.off('listening', onListening); reject(err) }
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(42814, '127.0.0.1')
      })
    } catch (err) {
      return { ok: false, error: `Local server error: ${err instanceof Error ? err.message : String(err)}` }
    }

    activePickerServer = server
    activePickerFinish = finish

    return {
      ok: true,
      url: `http://localhost:42814/?nonce=${nonce}`,
      finished
    }
  }

  ipcMain.handle('gdrive:pickFolder', async (): Promise<PickerResult> => {
    const result = await startGdriveFolderPicker()
    if (!result.ok) return { success: false, error: result.error }
    shell.openExternal(result.url)
    return result.finished
  })

  ipcMain.handle('gdrive:cancelPickFolder', () => {
    if (activePickerFinish) {
      activePickerFinish({ success: false, cancelled: true })
    }
    return { ok: true }
  })

  ipcMain.handle('gdrive:disconnect', async () => {
    const { googleDriveRefreshToken, googleDriveAccessToken } = getSettings()
    const tokenToRevoke = googleDriveRefreshToken || googleDriveAccessToken
    if (tokenToRevoke) {
      try {
        await revokeGoogleToken(tokenToRevoke)
      } catch {
        // Best-effort: still clear local tokens even if revoke fails (offline, already revoked, etc.)
      }
    }
    setSetting('googleDriveAccessToken', '')
    setSetting('googleDriveRefreshToken', '')
    setSetting('googleDriveTokenExpiresAt', 0)
    setSetting('googleDriveFolderId', '')
    return { success: true }
  })

  // IPC: Save file from dataURL (used by ShareDialog save button)
  ipcMain.handle('capture:saveFile', async (_e, dataUrl: string, filePath: string) => {
    const { writeFile, mkdir } = await import('fs/promises')
    const { dirname, resolve, normalize } = await import('path')
    const { homedir } = await import('os')
    const normalized = resolve(normalize(filePath))
    if (!normalized.startsWith(homedir())) throw new Error('Access denied — path outside home directory')
    await mkdir(dirname(normalized), { recursive: true })
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(normalized, Buffer.from(base64, 'base64'))
    return normalized
  })

  // IPC: Shell
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Invalid URL scheme — only http/https allowed')
    return shell.openExternal(url)
  })
  ipcMain.handle('shell:openPath', (_e, filePath: string) => {
    const { resolve, normalize } = require('path')
    const { homedir } = require('os')
    const normalized = resolve(normalize(filePath))
    if (!normalized.startsWith(homedir())) throw new Error('Access denied — path outside home directory')
    return shell.openPath(normalized)
  })

  // IPC: App quit (for renderer menu)
  ipcMain.handle('app:quit', () => { isQuitting = true; app.quit() })

  // IPC: Dev tools (for renderer menu)
  ipcMain.handle('devtools:toggle', () => mainWindow?.webContents.toggleDevTools())
  ipcMain.handle('window:reload', () => mainWindow?.webContents.reload())
  ipcMain.handle('window:force-reload', () => mainWindow?.webContents.reloadIgnoringCache())

  // IPC: Dialog
  ipcMain.handle('dialog:save', async (_e, opts: Electron.SaveDialogOptions = {}) => {
    const { isAbsolute, join, dirname } = await import('path')
    const startDir = await resolveSaveStartDir()

    // If caller gave just a filename, prepend the resolved dir.
    const incoming = opts.defaultPath
    const defaultPath = !incoming
      ? startDir
      : isAbsolute(incoming) ? incoming : join(startDir, incoming)

    const result = await dialog.showSaveDialog(mainWindow!, { ...opts, defaultPath })
    if (!result.canceled && result.filePath) {
      rememberSaveDir(dirname(result.filePath))
    }
    return result
  })

  ipcMain.handle('dialog:open', async (_e, opts) => {
    const result = await dialog.showOpenDialog(mainWindow!, opts)
    return result
  })

  // IPC: Clipboard write image
  ipcMain.handle('clipboard:writeImage', (_e, dataUrl: string) => {
    const img = nativeImage.createFromDataURL(dataUrl)
    clipboard.writeImage(img)
  })

  // IPC: Clipboard write text — renderer's navigator.clipboard.writeText fails
  // under file:// (non-secure context), so we round-trip through Electron's API.
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text)
  })

  // IPC: Recording — renderer requests the desktop source ID, then records itself
  ipcMain.handle('record:getSources', async () => {
    const sources = await require('electron').desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    })
    return sources.map((s: Electron.DesktopCapturerSource) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL()
    }))
  })

  // IPC: Save recorded video buffer to disk
  ipcMain.handle('record:save', async (_e, buffer: ArrayBuffer, filename: string) => {
    const { writeFile, mkdir } = await import('fs/promises')
    const { homedir } = await import('os')
    const { join } = await import('path')
    const dir = join(homedir(), 'Videos', 'Lumia')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, filename)
    await writeFile(filePath, Buffer.from(buffer))
    return filePath
  })

  // IPC: Update titleBarOverlay colors when theme changes (Windows only)
  ipcMain.handle('titlebar:setTheme', (_e, theme: 'dark' | 'light' | 'system') => {
    if (process.platform !== 'win32' || !mainWindow) return
    const resolved = theme === 'system'
      ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : theme
    mainWindow.setTitleBarOverlay({
      color: resolved === 'light' ? '#f6f6fb' : '#050810',
      symbolColor: resolved === 'light' ? '#2d2f33' : '#94a3b8',
      height: 40
    })
  })

  // IPC: Read local file as buffer (legacy fallback; <video> now streams via
  // the lumia-media:// protocol below instead of buffering the whole file).
  ipcMain.handle('file:read', async (_e, filePath: string) => {
    const { readFile } = await import('fs/promises')
    const { resolve, normalize } = await import('path')
    const { homedir } = await import('os')
    const normalized = resolve(normalize(filePath))
    if (!normalized.startsWith(homedir())) throw new Error('Access denied — path outside home directory')
    return readFile(normalized)
  })

  // Stream a local recording into <video> with Range support, instead of the
  // renderer reading the entire file over IPC and holding it as a Blob (a
  // multi-hundred-MB recording would OOM both processes). The URL shape is
  // `lumia-media://stream/?path=<encodeURIComponent(absPath)>`.
  //
  // Range is handled explicitly: <video> seeks by re-requesting a byte range,
  // and the response MUST be 206 with Content-Range / Accept-Ranges or the
  // scrubber is dead. (net.fetch of a file:// URL does not forward the Range
  // header, so seeking silently fell back to a full-file 200 — no seeking.)
  protocol.handle('lumia-media', async (request) => {
    try {
      const reqUrl = new URL(request.url)
      const filePath = reqUrl.searchParams.get('path')
      if (!filePath) return new Response('Missing path', { status: 400 })
      const { resolve, normalize, extname } = await import('path')
      const { homedir } = await import('os')
      const { stat } = await import('fs/promises')
      const { createReadStream } = await import('fs')
      const { Readable } = await import('stream')
      const normalized = resolve(normalize(filePath))
      // Same homedir sandbox as file:read — never serve arbitrary disk paths.
      if (!normalized.startsWith(homedir())) return new Response('Forbidden', { status: 403 })

      const total = (await stat(normalized)).size
      const ext = extname(normalized).toLowerCase()
      const contentType = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'application/octet-stream'

      const toWeb = (start?: number, end?: number) =>
        Readable.toWeb(createReadStream(normalized, { start, end })) as unknown as ReadableStream<Uint8Array>

      const rangeHeader = request.headers.get('range')
      const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
      if (m && total > 0) {
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : total - 1
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= total) end = total - 1
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
        return new Response(toWeb(start, end), {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
          },
        })
      }

      return new Response(toWeb(), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        },
      })
    } catch (err) {
      console.error('[lumia-media] stream failed', err)
      return new Response('Error', { status: 500 })
    }
  })

  // IPC: Recording state — hide main window before recording starts
  ipcMain.handle('record:hide', async () => {
    mainWindow?.hide()
    await new Promise(r => setTimeout(r, 200))
  })

  ipcMain.handle('record:show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('before-quit', (e) => {
  // If we initiated the quit ourselves (tray Quit / ExitLumia hotkey
  // / app:quit IPC), `isQuitting` is already true and we let it through.
  if (isQuitting) return
  // Otherwise this is Cmd+Q / dock right-click → Quit on macOS, or the
  // taskbar Close on Windows. Treat it as "hide to tray" — same end state
  // as the red X close button: window hidden + dock icon dropped. The user
  // can still fully exit via the tray menu's Quit item. Mirrors WhatsApp /
  // similar tray-resident apps.
  e.preventDefault()
  mainDismissedByUser = true
  hideDock()
  mainWindow?.hide()
})

app.on('window-all-closed', () => {
  // Keep app running in the tray instead of quitting when windows close.
  // The user can still quit via tray menu, Cmd/Ctrl+Q, or app:quit IPC.
  if (!isQuitting) return
  if (process.platform !== 'darwin') app.quit()
})

// OS-initiated logout / shutdown / restart. Without this, the before-quit
// handler above would preventDefault() the Quit Apple Event (macOS) / session
// end (Windows) and the OS reports "Lumia interrupted shutdown". Mark the quit
// as ours so before-quit lets it through, then quit for real.
powerMonitor.on('shutdown', () => {
  isQuitting = true
  app.quit()
})

app.on('will-quit', () => {
  teardownHotkeys()
  destroyTray()
  // Tear down the pre-warmed overlay pool so Electron can exit cleanly.
  // closeAllOverlays only hides; on quit we actually destroy.
  for (const [, win] of overlayPool) {
    if (!win.isDestroyed()) win.destroy()
  }
  overlayPool.clear()
})

app.on('second-instance', (_e, argv) => {
  // A duplicate `--hidden` launch (two HKCU\...\Run entries left over from
  // older builds, or any other path that re-fires the boot launcher) must
  // not surface the window — the user's intent for `--hidden` is "stay in
  // tray", and the first instance has already honored that.
  if (argv.includes('--hidden')) return

  // Windows toast activation routes through here when the toastXml uses
  // `activationType="protocol"` — the click opens our scheme, spawns
  // electron, and lands on second-instance.
  //
  // Only treat this as a toast click when the relaunch args actually carry our
  // protocol URL (`activationType="protocol"` → lumia:/lumia-dev:). A plain
  // duplicate launch (double-clicking the shortcut, a stray --hidden re-fire)
  // must NOT replay the last toast's callback — otherwise it opens the editor
  // on the most recent capture as if the toast had been clicked.
  const toastArg = argv.find(a => a.startsWith('lumia:') || a.startsWith('lumia-dev:'))
  if (toastArg) {
    // Deferring the window surfacing to `openHistoryItemInEditor` matters:
    // calling `mainWindow.show()` here would fire the 'show' listener which
    // clears `mainDismissedByUser`, so the callback would snapshot
    // `wasDismissed=false` and skip `surfacedFromTray` — breaking the
    // X-close-to-tray behavior.
    //
    // Prefer the per-toast id baked into the launch URI so clicking an OLDER
    // Action Center toast opens ITS history item, not whatever the most-recent
    // toast latched. Fall back to the single latched callback for toasts with
    // no id.
    let routedById = false
    try {
      const id = new URL(toastArg).searchParams.get('id')
      if (id) {
        routedById = true
        void openHistoryItemInEditor(id, mainDismissedByUser)
        // Drop any stale latch so a later plain activation can't replay it.
        consumePendingNotificationClick()
        return
      }
    } catch { /* not a parseable URL — fall through to the latched callback */ }
    if (!routedById) {
      const pending = consumePendingNotificationClick()
      if (pending) {
        try {
          pending()
          return
        } catch { /* fall through to plain show */ }
      }
    }
  }
  // Plain second-instance (e.g. user double-clicked the .lnk directly,
  // or any non-notification activation) — just surface the window.
  mainWindow?.show()
  mainWindow?.focus()
})
