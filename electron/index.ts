import './dev-profile' // must stay first: moves a dev build to its own profile before anything reads userData
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, clipboard, screen, session, Menu, nativeTheme, protocol, powerMonitor, net } from 'electron'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'path'
import { homedir } from 'os'
import fs, { access, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { createReadStream, existsSync, watch as watchFs, constants as fsConstants } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { Readable } from 'stream'
import { setupCapture, getFrozenBgrForDisplay, prewarmDesktopCapturer, clearFrozenCache, refreezeAfterMissionControl } from './capture'
import { prewarmNativeCapture } from './native-screen'
import { traceMark, traceExpect, traceSettle, traceFlush } from './capture-trace'
import { prewarmMacWindowPick, frontMacAppBundle, missionControlActive, listMacWindows, activateMacApp } from './mac-window-pick'
import { macSnapAvailable } from './mac-screen-snap'
import { setupMemoryLogging, labelWebContents, logMilestone } from './mem-metrics'
import { getIccFromPng, tagPngWithIcc } from './png-icc'
import { setupVideo, isRecordingActive } from './video'
import { uploadFileToR2 } from './uploaders/r2'
import {
  refreshGoogleToken,
  revokeGoogleToken,
  exchangeGoogleAuthCode,
} from './uploaders/googledrive'
import { uploadFilePathToDrive, getDriveFolderName, fetchDriveFile } from './google-drive-service'
import { saveResponseTo } from './stream-to-file'
import { localTimestamp } from './utils'
import { registerOverlayHwnd, unregisterOverlayHwnd, disableDwmTransitions } from './native-input'
import { snapshotActivePickWindow } from './window-list'
import { setupHotkeys, teardownHotkeys, getHotkeys, saveHotkeys, defaultHotkeys, type HotkeyConfig } from './hotkeys'
import { setupTray, destroyTray, TRAY_ACTIONS } from './tray'
import { setupScrollCapture, getOverlayMode } from './scroll-capture'
import { setupExtensionBridge, setExtensionTheme } from './extension-bridge'
import { setupStickers } from './stickers'
import { WorkflowEngine } from './workflow'
import { TemplateStore } from './templates'
import { HistoryStore } from './history'
import { dayKey } from './history-days'
import { probeWebmInfo } from './ffmpeg-remux'
import { RECORDING_FPS } from '../shared/recording'
import { readPngSize } from './png-size'
import { setupThumbnailRefresh } from './thumbnail-refresh'
import { writeThumbnail, writeThumbnailFromDataUrl, resolveThumbnailUrl, thumbnailNotifyOpts, writeStripFromDataUrl, stripUrlFor, thumbnailPathFor, hasThumbnail } from './thumbnail'
import { showNotification, consumePendingNotificationClick, setInAppToastRoute } from './notify'
import type { HistoryItem } from './types'
import { PAGE_CSS_PATH, PAGE_FONT_WEIGHTS, pageCss, pageRoles, connectedPage, connectFailedPage, pickerFailedPage } from './browser-page'
import { captureFolder, setCaptureFolder, isAllowedPath, OUTSIDE_FOLDERS } from './capture-folder'
import { FolderIndex, relinkRow } from './file-relink'
import { historyRootFor, scanForNewFiles, moveRows, rowCount, pathKey, isSuitableSaveFolder } from './folder-history'
import { getSettings, setSetting, resolveFirstLaunchTheme, isImageMode, isVideoMode, resolveSaveStartDir, rememberSaveDir, getThemePicks, OPEN_LUMIA_WHEN, RECORD_COUNTDOWNS, type AppSettings, type OpenLumiaWhen } from './settings'
import { DEFAULTS, deriveRoles, validPick, type ThemeMode, type ThemePicks } from '../shared/theme-colors'
import { applyLaunchAtStartup, wasLaunchedAtStartup } from './startup'
import { ensureDevStartMenuShortcut } from './dev-shortcut'
import { setSnippingHijack } from './printscreen-key'
import { preflightPermissions } from './permissions'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'
import { dockTrace } from './dock-trace'
import { captureBarTop } from '../shared/capture-bar'

log.transports.file.level = 'info'
log.transports.console.level = 'info'
autoUpdater.logger = log
Object.assign(console, log.functions)

// Enable WGC (Windows Graphics Capture) for pixel-perfect, high-quality screenshots on Windows.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'WindowsNativeGraphicsCapture')
}

// Cap Chromium's on-disk HTTP cache. Default is unlimited and grows
// indefinitely — Wallpapers fetches dozens of new wallpaper images as
// you scroll, and a heavy user can balloon the cache past 500 MB.
//
// 80 MB is enough headroom for Lumia's actual cacheable surface (the docs
// site, a few API responses, a few hundred wallpaper thumbnails) while
// bounding the worst case. Fonts no longer factor in — Manrope is
// self-hosted and bundled (the icons are Lucide components), so Chromium
// doesn't cache them via HTTP. When the cap fills, Chromium evicts LRU; recently-viewed
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
    // corsEnabled: the app's own pages may read frames off lumia-media
    // videos (thumbnail grabs); see appOriginCors below.
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
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
// Bump when history needs the one-time startup reset (runStartupCleanup).
const HISTORY_CLEANUP_VERSION = 1
// Tracks whether the user has explicitly dismissed the main window (red X
// close, or login-item startup). Set to false
// once the window is surfaced again. Used by overlay cancel handlers to
// decide whether to bring the main window back (not dismissed → restore) or
// stay in tray-only state (dismissed → keep hidden, drop dock icon).
//
// Why a tracked flag instead of `mainWindow.isVisible()`: capture flow hides
// the main window before opening the overlay, so by the time the overlay
// runs `isVisible()` always reads false. The flag captures user *intent*,
// which survives transient hides for capture / Cmd+H.
let mainDismissedByUser = false
// Messages from main: an in-app toast while the window is up, a system
// notification once the user closed it to the menu bar / tray (notify.ts).
setInAppToastRoute(
  (t) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.webContents.send('toast:show', t)
    return true
  },
  () => mainDismissedByUser || !mainWindow || mainWindow.isDestroyed(),
)

// Opt-in silent updates (Settings › About › "Update while hidden",
// autoUpdateWhenHidden, 2026-11-22). Off by default: then a check only finds
// out and the user clicks Update, then Restart. On: found updates download
// by themselves, and a downloaded one installs once the main window has sat
// hidden for the grace window.
let autoUpdaterUsable = false // packaged build that can write its install dir
let updateDownloaded = false
let autoInstallTimer: ReturnType<typeof setTimeout> | null = null
// Long enough that a brief Cmd+H or an accidental close-to-tray doesn't
// restart the app under the user; short enough that an idle tray instance
// picks up the update before the next session.
const AUTO_INSTALL_GRACE_MS = 30 * 1000

function applyAutoUpdateSetting() {
  const on = autoUpdaterUsable && getSettings().autoUpdateWhenHidden
  autoUpdater.autoDownload = on
  if (on) scheduleAutoInstall()
  else cancelAutoInstall()
}

/** True when restarting now would destroy in-progress work the user can't get
 *  back. The main window is hidden for the entire duration of a recording and
 *  while the capture overlay is up, so visibility alone is not enough. */
function isAppBusy(): boolean {
  if (isRecordingActive()) return true
  if (overlayWindows.size > 0) return true
  return false
}

/** With the opt-in on: quit-and-install a downloaded update once the window
 *  has stayed hidden for the grace window. Called on download, on the main
 *  window's 'hide', and when the setting turns on. */
function scheduleAutoInstall() {
  cancelAutoInstall()
  if (!updateDownloaded || !autoUpdaterUsable || !getSettings().autoUpdateWhenHidden) return
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
  if (isAppBusy()) return
  autoInstallTimer = setTimeout(() => {
    autoInstallTimer = null
    // Re-check: the user may have surfaced the window, started a recording
    // or turned the setting off during the grace window.
    if (!updateDownloaded || !getSettings().autoUpdateWhenHidden) return
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
    if (isAppBusy()) return
    console.log('[autoUpdater] grace period elapsed with window hidden — installing update')
    updateDownloaded = false
    isQuitting = true
    autoUpdater.quitAndInstall(true, true)
  }, AUTO_INSTALL_GRACE_MS)
}

function cancelAutoInstall() {
  if (autoInstallTimer) clearTimeout(autoInstallTimer)
  autoInstallTimer = null
}

export function markQuitting() { isQuitting = true }

// Any real quit (menu Quit / Cmd+Q, tray Quit, updater) must get past the
// window's close handler, which otherwise cancels the close and hides to tray.
app.on('before-quit', () => { isQuitting = true })

/** Hide the dock icon — called only when the user explicitly closes the
 *  main window to the tray (red X) or when the app launches hidden via the
 *  login item. Hiding the dock flips macOS into Accessory activation
 *  policy, which prevents app.focus() from stealing focus reliably; we
 *  must NOT do it for transient hides (capture flow, Cmd+H, etc.) or the
 *  overlay won't receive mouse / keyboard input. */
/** Whether Lumia hid its Dock icon itself (2026-11-24): showDock only shows
 *  what hideDock hid. `app.dock.isVisible()` reported false for an icon that
 *  was never hidden (after a process-type switch), so showDock called
 *  dock.show() on an active app and popped an auto-hidden Dock up. */
let dockHiddenByUs = false
/** Whether Lumia's Dock icon is hidden (closed to the menu bar). */
export function isDockIconHidden() { return dockHiddenByUs }
function hideDock() {
  if (process.platform !== 'darwin') return
  dockTrace(`hideDock (was hidden by us: ${dockHiddenByUs}) -> app.dock.hide()`)
  dockHiddenByUs = true
  app.dock?.hide()
}

/** Show the dock icon — called when the main window surfaces from tray.
 *  Returns app to Regular policy. Only acts when the icon is actually hidden:
 *  Electron's dock.show() on an active app briefly activates the Dock itself
 *  (a TransformProcessType workaround), which slides an auto-hidden Dock up
 *  and leaves it there until the user hovers it. The window's 'show' handler
 *  and the capture flow call this every time, so without the check every
 *  launch / activation risked popping the Dock. */
function showDock() {
  if (process.platform !== 'darwin' || !dockHiddenByUs) return
  dockTrace(`showDock -> app.dock.show() (app active: ${appIsActive}, main visible: ${!!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()})`)
  dockHiddenByUs = false
  app.dock?.show().then(() => dockTrace('app.dock.show() resolved')).catch(() => { /* ignore */ })
}

export function getMainWindow() { return mainWindow }
export function getHistoryStore() { return historyStoreInstance }
/** True when the user has explicitly dismissed the main window to the tray
 *  (X close on a non-/editor route). Capture flows use this to decide
 *  whether to surface the editor afterwards or just leave the user in tray
 *  with a clickable notification. */
export function isMainDismissed() { return mainDismissedByUser }
/** A capture or recording just finished: does Lumia's window come back,
 *  with the editor? By Settings › General › Open Lumia (`openLumiaAfter`,
 *  see OpenLumiaWhen in settings.ts). When it opens from the menu bar, the
 *  window counts as open from here on, so the "done" message is the in-app
 *  toast. When it doesn't, it counts as closed to the menu bar (even if it
 *  was open: the setting decides the window), so the message is a system
 *  notification, and the caller restores as after a cancel
 *  (restoreFromOverlayCancel: focus back to the app in front before). */
export function claimEditorAfterCapture(kind: 'image' | 'video'): boolean {
  const when = getSettings().openLumiaAfter
  const opens = when === 'open' ? !mainDismissedByUser
    : when === 'success' ? true
    : when === 'captures' ? kind === 'image'
    : when === 'recordings' ? kind === 'video'
    : false
  mainDismissedByUser = !opens
  return opens
}
export function getOverlayWindow() {
  if (activeOverlayDisplayId == null) return null
  return overlayWindows.get(activeOverlayDisplayId) ?? null
}
/** Display the overlay session is targeting. Pass the IPC `e.sender` from a
 *  confirm handler: the display is then resolved from the overlay window that
 *  SENT the rect, which is authoritative. The global active id alone is racy —
 *  the overlay releases its `overlay:drawing` lock on mouseup and only then
 *  sends the confirm, so the 100 ms cursor poll can flip the active display in
 *  between (drag ending on/near the neighbouring monitor) and the rect would be
 *  applied to the wrong display. */
export function getOverlayDisplayId(sender?: Electron.WebContents, warnOnMismatch = true): number | null {
  if (sender) {
    for (const [displayId, win] of overlayWindows) {
      if (!win.isDestroyed() && win.webContents === sender) {
        if (warnOnMismatch && displayId !== activeOverlayDisplayId) {
          console.warn(`[overlay] confirm from display ${displayId} while active was ${activeOverlayDisplayId} — using sender's display`)
        }
        return displayId
      }
    }
  }
  return activeOverlayDisplayId
}

/** Send each open overlay its display's snapshot from the frozen cache
 *  (null when there's none: the renderer then drops its picture). For a
 *  mid-session re-freeze (Image <-> Video switch). */
export function sendFrozenToOverlays() {
  for (const [displayId, win] of overlayWindows) {
    if (!win.isDestroyed()) win.webContents.send('overlay:frozen-bgra-changed', getFrozenBgrForDisplay(displayId))
  }
}

/** Fade the open overlays out (0) or back in (1) without parking them, for a
 *  mid-session re-freeze where the grab would otherwise include them
 *  (Windows; macOS's helper leaves Lumia out by itself). */
export function setOpenOverlaysOpacity(opacity: number) {
  for (const [, win] of overlayWindows) {
    if (!win.isDestroyed()) win.setOpacity(opacity)
  }
}

/** True while an overlay session is open. */
export function overlaySessionOpen() { return overlayWindows.size > 0 }

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

/** Switch the main window to `route` (`send` sends the navigate) and wait
 *  until that route is on screen before the caller shows it for real
 *  (2026-11-27: the Dashboard flashed before the editor after a recording).
 *  A hidden window draws no frames, so the renderer's mounted ack (sent
 *  from a rAF) never came while it was hidden: the wait ran into its
 *  timeout and show() then put up the last frame drawn before hiding, the
 *  Dashboard. So a hidden window is shown at the overlays' parked opacity
 *  (still compositing, invisible) while the route draws, then made opaque. */
export async function prepareMainOnRoute(route: string, send: () => void): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed()) { send(); return }
  const hidden = !win.isVisible()
  const mounted = waitForViewMounted(route)
  send()
  if (hidden) {
    win.setOpacity(PARKED_OPACITY)
    win.showInactive()
  }
  await mounted
  if (hidden && !win.isDestroyed()) win.setOpacity(1)
}

/** Surface a history item in the Editor — used by notification-click
 *  handlers so a user who closed the Editor can still hop back to the
 *  freshly-captured image / video by tapping the toast. Mirrors the
 *  Dashboard `openItem` flow but routes through the navigate IPC since
 *  we're calling from the main process. */
export async function openHistoryItemInEditor(
  historyId: string,
): Promise<void> {
  const main = mainWindow
  if (!main || main.isDestroyed()) return

  const item = historyStoreInstance?.get(historyId) ?? undefined

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
    route = '/editor'
    state = {
      kind: 'video',
      filePath: item.filePath,
      trimmedFilePath: item.annotatedFilePath,
      trim: item.trim,
      fps: item.fps,
      name: item.name ?? (item.filePath ? basename(item.filePath) : 'Recording'),
      historyId: item.id,
      annotations: item.annotations,
    }
  } else {
    // Image: re-read the original from disk (the history row only names
    // the thumbnail). If the file is gone, fall back to dashboard.
    let dataUrl: string | null = null
    if (item.filePath) {
      try {
        const normalized = resolve(normalize(item.filePath))
        if (isAllowedPath(normalized)) {
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

  // On screen before it's shown for real (prepareMainOnRoute: a hidden
  // window draws nothing, so it would show the last frame, the Dashboard).
  await prepareMainOnRoute(route, () => {
    if (state) main.webContents.send('navigate', route, state)
    else main.webContents.send('navigate', route)
  })

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
  // A cancel or a failure brings the window back only with Open Lumia on
  // "When it was open before" (2026-11-27); every other choice keeps it away, and
  // it then counts as closed to the menu bar.
  if (getSettings().openLumiaAfter !== 'open') mainDismissedByUser = true
  dockTrace(`restoreFromOverlayCancel (openLumiaAfter: ${getSettings().openLumiaAfter}, dismissed: ${mainDismissedByUser})`)
  if (mainDismissedByUser) {
    returnFocusToPreviousApp()
    hideDock()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
}

/** macOS: the app that was in front when the overlay opened (bundle id,
 *  read before Lumia takes activation). The overlay makes Lumia the active
 *  app so it owns the cursor (2026-11-24: as a background app its crosshair /
 *  camera only flashed on mouse moves and the front app's arrow won). When
 *  the session ends with no Lumia window to show, activation goes back to
 *  this app, so the user isn't left in an invisible Lumia. */
let previousFrontApp: Promise<string> | null = null
let overlayActivatedApp = false

/** Make Lumia the active app for the recording's countdown (2026-11-24, so
 *  Esc cancels it). Notes the app in front first unless the overlay already
 *  did; returnFocusToPreviousApp hands it back when the countdown ends. */
export function activateForRecording() {
  if (process.platform !== 'darwin') return
  // The app noted when the overlay opened is still the one to go back to;
  // only ask again without one.
  if (!previousFrontApp) previousFrontApp = frontMacAppBundle()
  overlayActivatedApp = true
  dockTrace('app.focus steal (recording countdown)')
  app.focus({ steal: true })
}

/** Hand activation back to the app that was in front before the overlay.
 *  No-op unless the overlay activated Lumia; best effort. */
export function returnFocusToPreviousApp() {
  if (process.platform !== 'darwin' || !overlayActivatedApp) return
  overlayActivatedApp = false
  const pending = previousFrontApp
  previousFrontApp = null
  void pending?.then((bundle) => { dockTrace(`focus back to previous app: "${bundle}"`); activateMacApp(bundle) })
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

/** macOS: Mission Control while an overlay is open (2026-11-24). The overlay
 *  sits above it and would hide it, so while Mission Control shows, the
 *  overlays turn invisible and let clicks through; when it closes, Image mode
 *  takes a fresh snapshot (the stacking order may have changed) and the
 *  overlays come back with Lumia active again. Detected by polling the
 *  helper (macOS has no API for it). */
let missionControlTimer: ReturnType<typeof setInterval> | null = null
let overlaysAside = false

function startMissionControlWatch() {
  stopMissionControlWatch()
  if (process.platform !== 'darwin') return
  trackActivation()
  let busy = false
  missionControlTimer = setInterval(async () => {
    if (busy || overlayWindows.size === 0) return
    busy = true
    try {
      const active = await missionControlActive()
      if (overlayWindows.size === 0) return
      if (active && !overlaysAside) stepOverlaysAside()
      else if (!active && overlaysAside) await bringOverlaysBack()
    } finally {
      busy = false
    }
  }, 100)
}

function stopMissionControlWatch() {
  if (missionControlTimer) clearInterval(missionControlTimer)
  missionControlTimer = null
  overlaysAside = false
}

/** The on-screen windows' ids and frames, to tell whether anything moved
 *  while a snapshot was being taken. */
async function windowListSignature(): Promise<string> {
  const wins = await listMacWindows()
  return wins.map(w => `${w.id}:${Math.round(w.x)},${Math.round(w.y)},${Math.round(w.width)}x${Math.round(w.height)}`).join('|')
}

function stepOverlaysAside() {
  console.log('[mission-control] open: overlays step aside')
  overlaysAside = true
  // The overlay stays shown (no fade out and back in): it drops the
  // snapshot so Mission Control shows through, takes no clicks, and hides
  // its tint and frames; the bar stays.
  clearFrozenCache()
  for (const [, win] of overlayWindows) {
    if (win.isDestroyed()) continue
    win.setIgnoreMouseEvents(true)
    win.webContents.send('overlay:frozen-bgra-changed', null)
    win.webContents.send('overlay:aside', true)
  }
}

async function bringOverlaysBack() {
  const tBack = Date.now()
  // The app picked in Mission Control is the one to hand focus back to.
  previousFrontApp = frontMacAppBundle()
  // The cursor may be on another display now.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (overlayWindows.has(display.id) && display.id !== activeOverlayDisplayId) {
    const old = activeOverlayDisplayId != null ? overlayWindows.get(activeOverlayDisplayId) : null
    if (old && !old.isDestroyed()) old.webContents.send('overlay:set-active', false)
    activeOverlayDisplayId = display.id
    overlayWindows.get(display.id)?.webContents.send('overlay:set-active', true)
  }

  const video = getOverlayMode().startsWith('video-')
  // macOS's helper leaves Lumia's windows out of a snapshot, so the overlays
  // can come back at once, see-through over the live screen, while the new
  // snapshot is taken; it then slips in over identical pixels (2026-11-24:
  // waiting for it kept the overlay away ~0.3-1s). Without the helper the
  // grab would include the overlays, so they fade out for it.
  const liveFirst = video || macSnapAvailable()
  if (!liveFirst) {
    for (const [, win] of overlayWindows) if (!win.isDestroyed()) win.setOpacity(PARKED_OPACITY)
  }
  const before = video ? '' : await windowListSignature()
  const freezing = refreezeAfterMissionControl() // drops the old picture at once
  if (liveFirst) showOverlaysNow()
  if (video) return
  let ok = await freezing
  // Windows still moving (Mission Control's closing slide): once more.
  if (ok && overlayWindows.size > 0 && await windowListSignature() !== before) {
    console.log('[mission-control] windows moved during the snapshot, taking another')
    ok = await refreezeAfterMissionControl()
  }
  console.log(`[mission-control] closed: overlay back ${liveFirst ? 'at once' : 'after the snapshot'}, snapshot ready ${Date.now() - tBack}ms after close`)
  if (overlayWindows.size === 0 || liveFirst) return
  showOverlaysNow()
}

/** Whether Lumia is the active app, from macOS's own activation events.
 *  (`win.isFocused()` can't tell: the overlay stays the key window while
 *  another app is active, 2026-11-24.) */
let appIsActive = false
let activationTracked = false
function trackActivation() {
  if (activationTracked || process.platform !== 'darwin') return
  activationTracked = true
  app.on('did-become-active', () => {
    dockTrace('did-become-active')
    appIsActive = true
    // Activation lands after app.focus() returns, and macOS then makes the
    // window that was key last time key again: seen to be the overlay on the
    // other display (2026-11-26). Once active, give the key back to the
    // overlay in use, so Esc and the keys reach it. (It didn't fix the
    // cursor turning into the arrow, OPEN-QUESTIONS.md.)
    if (overlayWindows.size > 0 && !overlaysAside && activeOverlayDisplayId != null) {
      const win = overlayWindows.get(activeOverlayDisplayId)
      if (win && !win.isDestroyed() && !win.isFocused()) win.focus()
    }
  })
  app.on('did-resign-active', () => { dockTrace('did-resign-active'); appIsActive = false })
}

// From launch, so the state is right before the first overlay.
trackActivation()

let reclaimTimer: ReturnType<typeof setInterval> | null = null

/** Mission Control activates the app picked there only at the very end,
 *  after the overlay is back, so Lumia lost activation and Esc / the cursor
 *  needed a click on the overlay first (2026-11-24). For 2.5s after coming
 *  back, check every 100ms and ask for activation whenever Lumia isn't the
 *  active app. The menu bar shows the picked app's name for a moment;
 *  that's accepted. */
function reclaimActivationAfterMissionControl() {
  if (reclaimTimer) clearInterval(reclaimTimer)
  const t0 = Date.now()
  const ask = () => {
    const win = activeOverlayDisplayId != null ? overlayWindows.get(activeOverlayDisplayId) : null
    if (!win || win.isDestroyed() || overlaysAside) return
    dockTrace('app.focus steal (after Mission Control)')
    app.focus({ steal: true })
    overlayActivatedApp = true
    win.focus()
  }
  ask()
  reclaimTimer = setInterval(() => {
    if (Date.now() - t0 > 2500 || overlayWindows.size === 0 || overlaysAside) {
      if (reclaimTimer) clearInterval(reclaimTimer)
      reclaimTimer = null
      return
    }
    if (!appIsActive) ask()
  }, 100)
}

/** The overlays back after Mission Control, taking activation back. */
function showOverlaysNow() {
  trackActivation()
  overlaysAside = false
  for (const [id, win] of overlayWindows) {
    if (win.isDestroyed()) continue
    win.webContents.send('overlay:aside', false)
    if (id === activeOverlayDisplayId) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
    win.setOpacity(1)
  }
  reclaimActivationAfterMissionControl()
}

export function closeAllOverlays() {
  stopMissionControlWatch()
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
      win.webContents.send('overlay:aside', false)
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

/* Custom themes (design/CUSTOM-THEMES.md). The main window's and the
   capture overlays' webContents get the base (neutral) roles and light mode
   (the overlays since 2026-11-24: they follow the app's theme); every other
   window only the accent. The preload asks once, synchronously, before first
   paint. */
const mainWebContentsIds = new Set<number>()
const overlayWebContentsIds = new Set<number>()

/** Give a window the full theme (light / dark and the base), like the main
 *  window: the capture overlays, and since 2026-11-24 the recording
 *  toolbar, border and drawing layer. Call right after creating it, before
 *  its page loads (the preload asks once). */
export function useFullTheme(wc: Electron.WebContents) {
  const id = wc.id
  overlayWebContentsIds.add(id)
  wc.once('destroyed', () => overlayWebContentsIds.delete(id))
}

function savedThemeMode(): ThemeMode {
  return getSettings().theme === 'light' ? 'light' : 'dark'
}

/** The window chrome's colours for a mode with the user's picks: the
 *  window background, the AppBar fill (Windows title bar) and its icon
 *  grey; today's values when nothing is picked. */
function themeChrome(mode: ThemeMode, picks: ThemePicks = getThemePicks()): { background: string; toolbar: string; symbol: string } {
  // The defaults from the roles' one JS copy (shared/theme-colors.ts
  // DEFAULTS, kept equal to src/index.css by a test), under the picks
  // (2026-11-27; the six hex values were repeated here).
  const r = { ...DEFAULTS[mode], ...deriveRoles(picks, mode, { neutrals: true }) }
  return { background: r.background, toolbar: r.toolbar, symbol: r['fg-secondary'] }
}

/** Repaint the native chrome (window background, Windows title bar) for
 *  the saved mode and picks. */
function applyThemeChrome(mode: ThemeMode = savedThemeMode(), picks: ThemePicks = getThemePicks()) {
  // The browser extension's UI follows too (popup, status pill, Region
  // picker), before the window check: it's drawn with or without a window.
  setExtensionTheme({ mode, roles: pageRoles(mode, picks) })
  if (!mainWindow || mainWindow.isDestroyed()) return
  const chrome = themeChrome(mode, picks)
  mainWindow.setBackgroundColor(chrome.background)
  if (process.platform === 'win32') {
    mainWindow.setTitleBarOverlay({ color: chrome.toolbar, symbolColor: chrome.symbol, height: 52 })
  }
}

function createMainWindow(startHidden = false): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  const chrome = themeChrome(savedThemeMode())
  const win = new BrowserWindow({
    width: 1250,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: chrome.background,
    icon: ICON_PATH,
    // Defer first paint via ready-to-show below to avoid an empty frame flash
    // on slow renderer cold-starts. startHidden boot keeps the window hidden.
    show: false,
    // macOS: a standard window with its title bar hidden (traffic lights
    // inset), not `frame: false`: a frameless window only resized on its
    // outermost 1px, a titled one gets macOS's resize margin around the edge
    // (2026-11-27). Windows: frameless with the native overlay controls.
    ...(isMac ? {} : { frame: false }),
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      // y 19: the circles are 14px on current macOS, so y 20 sat them 1px
      // below the AppBar's centre (measured 2026-11-20). Still right at 53px
      // (2026-11-23): the AppBar centres in its top 52px, above its line.
      trafficLightPosition: { x: 20, y: 19 }
    } : isWin ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: chrome.toolbar, // matches the AppBar (bg-toolbar)
        symbolColor: chrome.symbol,
        height: 52 // the AppBar's content height above its 1px edge line (the bar is 53px), as on macOS (2026-11-23; was 40)
      }
    } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Remove the native menu bar entirely (the AppBar in the page stands in for it)
  win.setMenu(null)
  // Before loadURL, so the preload's theme:initial already counts it.
  mainWebContentsIds.add(win.webContents.id)

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
    logMilestone('main window shown')
  }
  ipcMain.once('window:ready', () => { logMilestone('window:ready (dashboard settled)'); showOnce() })
  win.once('ready-to-show', () => {
    logMilestone('main ready-to-show (first paint)')
    setTimeout(showOnce, 1000)
    // Opt main out of DWM's hide animation so capture flows can rely on
    // win.hide() removing it from the compositor instantly. Without this,
    // Windows fades main over ~200ms; freezeAllDisplays lands mid-fade
    // and bakes a translucent Lumia frame into the cached screenshot.
    disableDwmTransitions(win)
  })

  // Intercept close: keep the app alive in the tray instead of exiting. Only
  // actually close when we're explicitly quitting (tray Quit / hotkey / IPC).
  // The red button closes the window on every page, the editor included
  // (Jasper, 2026-11-27: it used to take the editor back to the Dashboard and
  // keep the window open, which read as a second Lumia window appearing
  // behind it; the app bar's Back does that). Hide to tray AND drop the dock
  // icon. If we were on /editor, reset the renderer to /dashboard first —
  // otherwise the next time the user surfaces the window, Chromium serves
  // the cached editor frame before React's pending /dashboard commit gets a
  // paint pass, producing a visible flash of stale state.
  // `waitForViewMounted` gates the hide on the renderer ack so the cached
  // frame *is* the dashboard.
  win.on('close', async (e) => {
    if (isQuitting) return
    e.preventDefault()
    if (currentRoute === '/editor') {
      currentRoute = '/dashboard'
      win.webContents.send('navigate', '/dashboard')
      await waitForViewMounted('/dashboard')
    }
    mainDismissedByUser = true
    hideDock()
    win.hide()
  })

  win.on('hide', () => { dockTrace('main window hide'); scheduleAutoInstall() })
  // A drag on the AppBar (a window drag region) never reaches the page, so
  // tell the renderer the window is moving: it clears any text selection,
  // as a click elsewhere would (2026-11-22). A plain click without a move
  // sends nothing; Esc covers that. Throttled: will-move repeats while
  // dragging on some platforms.
  let lastMoveSent = 0
  const sendMove = () => {
    const now = Date.now()
    if (now - lastMoveSent < 300) return
    lastMoveSent = now
    win.webContents.send('window:will-move')
  }
  // will-move (macOS / Windows) fires as the drag starts; move as a
  // fallback (it also fires for programmatic moves, which is harmless).
  win.on('will-move', sendMove)
  win.on('move', sendMove)
  win.on('show', () => {
    dockTrace(`main window show (dock hidden by us: ${dockHiddenByUs})`)
    cancelAutoInstall()
    mainDismissedByUser = false
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
    // Square corners: macOS rounds a frameless window's by default, which
    // cut the Screen frame and the snapshot at the display's corners.
    roundedCorners: false,
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
  // Before the page loads, so its preload's theme:initial sees it.
  overlayWebContentsIds.add(win.webContents.id)

  win.setAlwaysOnTop(true, 'pop-up-menu')
  // skipTransformProcessType (2026-11-24): without it Electron switches the
  // app's process type on macOS (Dock icon shown / hidden), which took
  // focus and confused the Dock. Over full-screen apps Lumia's windows show
  // only if they were up before the switch to full screen (not supported
  // otherwise; tried and dropped 2026-11-24).
  win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
  // Shown (parked at opacity ~0) the whole session, so macOS would list it
  // as a full-screen "Lumia Overlay" window in Mission Control / Exposé.
  // Keep it out; it stays shown and warm.
  if (process.platform === 'darwin') win.setHiddenInMissionControl(true)

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
    traceSettle(`reveal ${displayId}`)
    if (isActive) {
      win.setIgnoreMouseEvents(false)
      // Bring to top + grab keyboard focus so the renderer's ESC handler
      // receives keydown without the user having to click the overlay
      // first. We surfaced with showInactive() at pool time to avoid
      // stealing focus pre-capture, but during a live capture the user
      // expects ESC to work immediately.
      // macOS: also make Lumia the active app, or the front app keeps
      // setting its own cursor over ours (see returnFocusToPreviousApp).
      if (process.platform === 'darwin') {
        dockTrace('app.focus steal (image overlay reveal)')
        app.focus({ steal: true })
        overlayActivatedApp = true
      }
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

  // macOS: note the front app before the overlay activates Lumia (see
  // returnFocusToPreviousApp).
  if (process.platform === 'darwin') {
    previousFrontApp = frontMacAppBundle()
    overlayActivatedApp = false
  }

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
  let pendingReveals = 0

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
    // Where this display's mode bar sits: at its menu bar's bottom edge
    // (shared/capture-bar.ts). Sent at every open, so a changed display or
    // a menu bar switched to hiding itself is picked up the next time.
    win.webContents.send('overlay:bar-top', captureBarTop(display, process.platform))
    // The pooled overlay loaded long ago: give it the theme as it is now
    // (light / dark and the picks may have changed since).
    win.webContents.send('theme:changed', { picks: getThemePicks(), mode: savedThemeMode() })
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
      pendingReveals++
      traceExpect(1)
      revealOverlayWhenBgReady(win, display.id, isActive)
    } else {
      // Video flow: no snapshot to wait for, surface immediately.
      if (isActive) {
        win.setIgnoreMouseEvents(false)
        // macOS: make Lumia the active app, as the Image reveal does
        // (2026-11-26; the Video overlay never did, so the app in front
        // stayed active and kept its own cursor).
        if (process.platform === 'darwin') {
          dockTrace('app.focus steal (video overlay reveal)')
          app.focus({ steal: true })
          overlayActivatedApp = true
        }
        win.focus()
      } else {
        win.setIgnoreMouseEvents(true, { forward: true })
      }
      win.setOpacity(1)
    }
  }

  traceMark('sent')
  if (pendingReveals === 0) traceFlush()

  // macOS: step aside while Mission Control shows.
  startMissionControlWatch()

  // Poll cursor position to switch active overlay when mouse moves between
  // displays. Pointless with a single display — the active overlay is already
  // pinned at creation and can never change — so skip the 10/s wakeups on the
  // most common hardware config.
  if (allDisplays.length <= 1) return overlayWindows
  overlayPollTimer = setInterval(() => {
    if (overlayDrawingInProgress) return // don't switch while user is drawing
    if (overlaysAside) return // stepped aside for Mission Control

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

// Set application menu — hidden on Windows (frameless), but provides keyboard accelerators
if (isDev) {
  const devMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
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
  logMilestone('app ready')
  resolveFirstLaunchTheme(nativeTheme.shouldUseDarkColors)
  // Native appearance = Lumia's theme from the first frame (traffic lights,
  // menus); the renderer re-sends it via titlebar:setTheme on every change.
  nativeTheme.themeSource = getSettings().theme === 'light' ? 'light' : 'dark'
  // Plant the Start Menu shortcut that registers our AUMID with the Windows
  // shell. Without it, dev-mode toast clicks have no launcher to activate
  // and silently no-op. Fire-and-forget; failure is non-fatal.
  ensureDevStartMenuShortcut()

  // No window ever opens another window or leaves its own page (2026-11-27,
  // defence in depth: the pages hold a bridge that reads and writes files).
  // Links open in the browser through shell:openExternal; routes change by
  // hash, which isn't a navigation. A reload of the same page stays allowed
  // (the dev server's full reload).
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      try {
        const to = new URL(url)
        const from = new URL(contents.getURL())
        if (to.origin === from.origin && to.pathname === from.pathname) return
      } catch { /* not a URL: refused */ }
      console.warn('[security] navigation refused:', url)
      event.preventDefault()
    })
  })

  // Allow getUserMedia desktop capture in all windows (needed for overlay region capture)
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
  // A scroll session can start from a frozen hotkey overlay (its Scroll tab),
  // so its confirm / cancel drop the frozen frames like the other modes do.
  setupScrollCapture(mainWindow, createOverlayWindows, () => { closeAllOverlays(); clearFrozenCache() }, getOverlayDisplayId, restoreFromOverlayCancel)
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
    scheduleAutoInstall() // only with the opt-in on
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
    // Consent at each step (Jasper, 2026-11-22): a check only finds out
    // (Settings shows "Version X is available" + Update), Update downloads
    // (update:download), Restart installs (update:install). Never installs
    // on quit. The one exception is the user's own opt-in, "Update while
    // hidden" (applyAutoUpdateSetting).
    autoUpdaterUsable = true
    autoUpdater.autoInstallOnAppQuit = false
    applyAutoUpdateSetting()
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
    // Set isQuitting before quitAndInstall: the updater closes the windows
    // itself, and the main window's close handler hides to tray unless
    // isQuitting is true, which would silently swallow the restart.
    updateDownloaded = false
    cancelAutoInstall()
    isQuitting = true
    // Silent install on Windows so the NSIS UI doesn't surface on every
    // update; isForceRunAfter brings the app back up after install. No-op
    // for the macOS update path (zip-based, no installer UI to silence).
    autoUpdater.quitAndInstall(true, true)
  })
  // The user's Update click: download the version the last check found.
  ipcMain.handle('update:download', async () => {
    if (isDev || !canWriteInstallDir) return { ok: false }
    try {
      await autoUpdater.downloadUpdate()
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

  // Settings › About: show the log file in Finder / Explorer (for bug
  // reports), and open the bundled open-source licence texts
  // (resources/licenses, extraResources → licenses/ when packaged).
  ipcMain.handle('app:showLogs', () => {
    shell.showItemInFolder(log.transports.file.getFile().path)
  })
  ipcMain.handle('app:openLicenses', async () => {
    const dir = app.isPackaged
      ? join(process.resourcesPath, 'licenses')
      : join(app.getAppPath(), 'resources', 'licenses')
    const error = await shell.openPath(dir)
    return error ? { error } : { ok: true }
  })

  // History: one shared store (day files + history_stat.json). Created
  // before anything that reads or writes history, the workflow engine
  // included; its constructor also migrates an old history.json.
  const historyStore = new HistoryStore(app.getPath('userData'))
  historyStoreInstance = historyStore
  // The one-time upgrade reset (awaited below) empties the default history:
  // its synchronous part runs now, before a save folder's history takes over.
  const startupCleanup = historyStore.runStartupCleanup(HISTORY_CLEANUP_VERSION)
  // The Dashboard shows the save folder's files: a folder other than the
  // default has its own history (folder-history.ts).
  const userData = app.getPath('userData')
  if (historyRootFor(userData, captureFolder()) !== userData) {
    try {
      historyStore.useRoot(historyRootFor(userData, captureFolder()), HISTORY_CLEANUP_VERSION)
    } catch (err) {
      console.error('[history] save folder history unavailable, showing the default', err)
    }
  }
  historyStore.setRootForFile(filePath => {
    const dir = pathKey(dirname(filePath))
    const past = (getSettings().pastCaptureFolders ?? []).find(p => pathKey(p) === dir)
    return past && pathKey(past) !== pathKey(captureFolder()) ? historyRootFor(userData, past) : null
  })
  // One-time re-render of old, small thumbnails (thumbnail-refresh.ts).
  setupThumbnailRefresh(historyStore)
  historyStore.onChange(days => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed', { days })
  })
  // Capture files changed outside Lumia (2026-11-27): deleted, moved or
  // put back in Finder. A row's Missing state is read with its day, and
  // days only reloaded on Lumia's own writes, so the Dashboard needed a
  // Cmd+R to show it. Watch the captures folder; on any change (bundled
  // over 300ms, a bulk delete is one burst) send history:changed without
  // days: the window reloads every loaded day and the missing count.
  // Lumia's own saves land here too and cost one extra reload.
  watchCaptureFolder(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed', {})
  })

  // IPC: Workflow
  const templateStore = new TemplateStore()
  const workflowEngine = new WorkflowEngine(templateStore, historyStore)

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

  // One-time upgrade cleanup. Bump HISTORY_CLEANUP_VERSION when the data
  // model diverges from prior releases badly enough that wiping existing
  // history + sidecar files is friendlier than trying to migrate. Runs
  // once per bump (guarded inside HistoryStore), then never again.
  try {
    const wiped = await startupCleanup
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

  // Renderer view of rows: thumbnailFile → lumia-media:// URL for <img src>,
  // `fileMissing` when the capture file is gone (fs.stat is
  // microsecond-fast on SSDs; a few hundred parallel probes are trivial),
  // `size` in bytes and a screenshot's pixel size from the PNG header (24
  // bytes), both of the file the row stands for: the edited (or trimmed)
  // copy, else the original.
  // Files renamed or moved outside Lumia are followed first (file-relink.ts):
  // the row gets the new path, and fingerprints are saved as files are seen.
  // What it finds (new paths, fingerprints) is collected in `patches` and
  // saved by the caller in one go per pass (updateQuietMany: one write per
  // day; a write per row rewrote the day file for every row, 2026-11-27).
  type RowPatches = { id: string; patch: Partial<HistoryItem> }[]
  const relink = async (row: HistoryItem, index: FolderIndex, saveDir: string, patches: RowPatches) => {
    const r = await relinkRow(row, index, [saveDir])
    if (Object.keys(r.patch).length > 0) patches.push({ id: row.id, patch: r.patch })
    return r
  }
  const forRenderer = async (rows: HistoryItem[]): Promise<HistoryItem[]> => {
    const index = new FolderIndex()
    const sizeOf = async (files: (string | undefined)[]) => {
      for (const f of files) {
        if (!f) continue
        try { const size = await readPngSize(f); if (size) return size } catch { /* missing or unreadable: try the next */ }
      }
      return undefined
    }
    const saveDir = captureFolder()
    const patches: RowPatches = []
    const out = await Promise.all(rows.map(async (raw) => {
      const followed = await relink(raw, index, saveDir, patches)
      const item = resolveThumbnailUrl(followed.item)
      if (!item.filePath) return item
      if (followed.missing) return { ...item, fileMissing: true }
      let bytes: number
      try {
        bytes = (await stat(item.filePath)).size
      } catch {
        return { ...item, fileMissing: true }
      }
      if (item.annotatedFilePath) {
        try { bytes = (await stat(item.annotatedFilePath)).size } catch { /* edited copy gone: the original's size */ }
      }
      if (item.type !== 'screenshot') {
        // What the window still has to make for a recording (see filmstrip:save).
        const needs = item.type === 'recording'
          ? { ...(hasThumbnail(item) ? {} : { needsPreview: true }), ...(stripUrlFor(item) ? {} : { needsStrip: true }) }
          : {}
        return { ...item, size: bytes, ...needs }
      }
      const dims = await sizeOf([item.annotatedFilePath, item.filePath])
      return { ...item, size: bytes, ...dims }
    }))
    historyStore.updateQuietMany(patches)
    return out
  }
  // Recordings saved before durationMs existed: read each one's length once,
  // one ffmpeg probe at a time, when its day is first shown. Each result is
  // written to the row (history:changed then refreshes that day). A file
  // that can't be read is not retried until the next launch.
  // The same probe fills a recording's frame rate (`fps`, for the video
  // editor's frame step; saved with new recordings since 2026-11-27): the
  // rate the file's header names (recordings made at the old 60), else the
  // rate recordings were made at when it wasn't kept, 30. Written without a
  // reload per row; the days it touched are told to the window once.
  const durationQueue: string[] = []
  const durationSeen = new Set<string>()
  let durationDraining = false
  const queueDurationBackfill = (rows: HistoryItem[]) => {
    for (const r of rows) {
      if (r.type !== 'recording' || (r.durationMs != null && r.fps != null) || !r.filePath || r.fileMissing || durationSeen.has(r.id)) continue
      durationSeen.add(r.id)
      durationQueue.push(r.id)
    }
    if (durationDraining || durationQueue.length === 0) return
    durationDraining = true
    void (async () => {
      const fpsDays = new Set<string>()
      try {
        while (durationQueue.length) {
          const item = historyStore.get(durationQueue.shift()!)
          if (!item?.filePath || (item.durationMs != null && item.fps != null)) continue
          const info = await probeWebmInfo(item.filePath)
          // Nothing read (the file is gone, ffmpeg missing): again next launch.
          if (info.durationMs == null && info.fps == null) continue
          if (item.durationMs == null && info.durationMs != null) historyStore.update(item.id, { durationMs: info.durationMs })
          if (item.fps == null) {
            historyStore.updateQuietMany([{ id: item.id, patch: { fps: info.fps ?? RECORDING_FPS } }])
            fpsDays.add(dayKey(item.timestamp))
          }
        }
      } finally {
        durationDraining = false
        if (fpsDays.size > 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed', { days: [...fpsDays] })
      }
    })()
  }

  // The video editor's filmstrip and a recording's card preview
  // (thumbnail.ts, src/lib/filmstrip.ts). New recordings bring both along
  // (recorder:save-end). A recording without one says so on the row the
  // window gets (`needsStrip`: made before the recorder kept strips, or
  // restored from the cloud; `needsPreview`: found by a folder scan, which
  // makes previews for images only, or its frame grab failed at save), and
  // the main window makes it: it has the video decoder (the shipped ffmpeg
  // has none) and knows what's on screen, so it decides the order
  // (src/lib/strip-jobs.ts, strip-worker.ts) and hands each result back
  // through `filmstrip:save`. Never while a recording runs
  // (`filmstrip:canRun`).
  ipcMain.handle('filmstrip:get', (_e, id: string): { url: string } | null => {
    const item = typeof id === 'string' ? historyStore.get(id) : null
    const url = item ? stripUrlFor(item) : undefined
    return url ? { url } : null
  })
  ipcMain.handle('filmstrip:canRun', (): boolean => !isRecordingActive())
  // Whether a row has a preview or a strip is read from the row, never from
  // the disk (2026-11-27: two stats per row per day read otherwise). A file
  // deleted outside Lumia is found by the window, when it fails to load,
  // and reported here by row id (the path is built from the row, never
  // taken from the window). Only if the file really is gone (a failed load
  // can be a glitch) the row's field is cleared: an image's preview is
  // drawn again from its file right here; a recording's is the window's
  // work, and its reloaded row says so (needsPreview). A strip is cleared
  // without a reload: the editor that reported it builds a new one.
  ipcMain.handle('history:fileGone', async (_e, id: string, kind: 'thumbnail' | 'strip'): Promise<boolean> => {
    const item = typeof id === 'string' ? historyStore.get(id) : null
    const file = kind === 'strip' ? item?.stripFile : kind === 'thumbnail' ? item?.thumbnailFile : undefined
    if (!item || !file) return false
    const path = resolve(normalize(thumbnailPathFor(file)))
    if (!isAllowedPath(path)) return false
    try { await access(path); return false } catch { /* gone */ }
    if (kind === 'strip') {
      historyStore.updateQuietMany([{ id: item.id, patch: { stripFile: undefined } }])
      return true
    }
    let thumbnailFile: string | undefined
    const source = item.type === 'screenshot' ? (item.annotatedFilePath || item.filePath) : undefined
    if (source) {
      try {
        const from = resolve(normalize(source))
        if (isAllowedPath(from)) thumbnailFile = writeThumbnail(item.id, nativeImage.createFromPath(from))
      } catch { /* the image is gone too: no preview */ }
    }
    historyStore.update(item.id, { thumbnailFile })
    return true
  })
  // Either part may be missing ('' / undefined: it couldn't be made, or
  // wasn't asked for). The strip is saved without a reload: the editor asks
  // for it by id. The preview, taken only for a row without one, is a
  // normal history write, so the row's day reloads and its card fills in.
  ipcMain.handle('filmstrip:save', (_e, id: string, dataUrl: string, thumbnailDataUrl?: string): boolean => {
    const item = typeof id === 'string' ? historyStore.get(id) : null
    if (!item || item.type !== 'recording') return false
    let saved = false
    const stripFile = writeStripFromDataUrl(item.id, typeof dataUrl === 'string' ? dataUrl : undefined)
    if (stripFile) {
      // Also when the name is the same: the row takes the new write's time.
      historyStore.updateQuietMany([{ id: item.id, patch: { stripFile } }])
      saved = true
    }
    if (typeof thumbnailDataUrl === 'string' && !hasThumbnail(item)) {
      const thumbnailFile = writeThumbnailFromDataUrl(item.id, thumbnailDataUrl, item.thumbnailFile)
      if (thumbnailFile) { historyStore.update(item.id, { thumbnailFile }); saved = true }
    }
    return saved
  })

  ipcMain.handle('history:stats', () => historyStore.getStats())
  ipcMain.handle('history:days', async (_e, days: string[]) => {
    if (!Array.isArray(days)) return {}
    const byDay = historyStore.getDays(days.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
    const out: Record<string, HistoryItem[]> = {}
    for (const [day, rows] of Object.entries(byDay)) out[day] = await forRenderer(rows)
    queueDurationBackfill(Object.values(out).flat())
    return out
  })
  // The newest rows. `onDisk` (2026-11-23, the image editor's Recent
  // images): only rows whose capture file is still there, still `limit` of
  // them; checked here, newest first, so the renderer gets exactly what it
  // shows instead of over-asking and filtering.
  // Saved edit steps of an image (History › Edits, 2026-11-23). Only while
  // the saveEditHistory setting is on; turning it off deletes the saved
  // files (settings:set), as the setting's subtitle says.
  ipcMain.handle('editHistory:get', async (_e, id: string) =>
    getSettings().saveEditHistory ? historyStore.editHistory.get(String(id)) : null)
  // Only for a row that exists: a save arriving after the row was deleted
  // (the editor's Delete, a late flush) must not leave an orphan file.
  ipcMain.handle('editHistory:save', async (_e, id: string, data: unknown) =>
    getSettings().saveEditHistory && historyStore.get(String(id)) ? historyStore.editHistory.save(String(id), data) : false)

  // One row by id (2026-11-23: Settings' close reopens the editor it was
  // opened from with the row as it is now, edits and trim included).
  ipcMain.handle('history:get', async (_e, id: string) => {
    const item = historyStore.get(String(id))
    return item ? (await forRenderer([item]))[0] : null
  })
  ipcMain.handle('history:recent', async (_e, limit: number, type?: 'screenshot' | 'recording', opts?: { onDisk?: boolean }) => {
    const n = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 20
    const kind = type === 'screenshot' || type === 'recording' ? type : undefined
    if (!opts?.onDisk) return forRenderer(historyStore.getRecent(n, kind))
    const kept: HistoryItem[] = []
    let checked = 0
    let take = n
    for (;;) {
      const rows = historyStore.getRecent(take, kind)
      for (const row of rows.slice(checked)) {
        if (!row.filePath) continue
        try { await access(row.filePath); kept.push(row) } catch { /* gone: skip */ }
        if (kept.length >= n) break
      }
      checked = rows.length
      if (kept.length >= n || rows.length < take) break
      take *= 2
    }
    return forRenderer(kept)
  })
  ipcMain.handle('history:delete', async (_e, id: string) => {
    // Store.delete takes the row out of its day file, then unlinks filePath
    // + annotatedFilePath (bounded by isAllowedPath, ENOENT ignored).
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
  // Every row in history whose capture file is gone and that was never
  // uploaded (an uploaded one is cloud only, not missing): the Dashboard's
  // missing-files count and its Clear, which must cover all of history, not
  // just the days it has loaded (2026-11-21; it used to count loaded days
  // only, so the button vanished when those days were scrolled out of
  // memory). One day at a time through the store's LRU cache, one parallel
  // access() per row of the day.
  ipcMain.handle('history:missingIds', async () => {
    const ids: string[] = []
    const index = new FolderIndex()
    const saveDir = captureFolder()
    for (const { day } of historyStore.getStats().days) {
      const rows = historyStore.getDays([day])[day] ?? []
      const patches: RowPatches = []
      await Promise.all(rows.map(async (item) => {
        if (!item.filePath || item.uploads?.some(u => u.success)) return
        // A renamed file is followed, not counted (file-relink.ts).
        if ((await relink(item, index, saveDir, patches)).missing) ids.push(item.id)
      }))
      historyStore.updateQuietMany(patches)
    }
    return ids
  })
  // Every row's id in history, newest first, optionally only one type: the
  // Dashboard's Cmd+A, which must select all of history, not only the days
  // it has loaded (2026-11-25).
  ipcMain.handle('history:allIds', async (_e, type?: 'screenshot' | 'recording') => {
    const ids: string[] = []
    for (const { day } of historyStore.getStats().days) {
      for (const item of historyStore.getDays([day])[day] ?? []) {
        if (!type || item.type === type) ids.push(item.id)
      }
    }
    return ids
  })
  // Removes rows whose capture file is gone, among `ids` (the Dashboard
  // passes history:missingIds).
  ipcMain.handle('history:cleanupMissing', async (_e, ids: string[]) => {
    if (!Array.isArray(ids)) return 0
    const items = ids.map(id => historyStore.get(id)).filter((i): i is HistoryItem => !!i)
    const orphanIds: string[] = []
    const index = new FolderIndex()
    const saveDir = captureFolder()
    const patches: RowPatches = []
    await Promise.all(items.map(async (item) => {
      if (!item.filePath) return
      // An uploaded clip whose local file is gone is cloud only, not an
      // orphan: its row holds the only link back to the upload, so it is
      // never cleared here (2026-11-21).
      if (item.uploads?.some(u => u.success)) return
      // Renamed since the count: followed, not cleared. A folder that isn't
      // there (an unplugged drive) isn't cleared either: its files may be fine.
      if (!(await relink(item, index, saveDir, patches)).missing) return
      try { await fs.access(dirname(item.filePath)) } catch { return }
      orphanIds.push(item.id)
    }))
    historyStore.updateQuietMany(patches)
    // Single read-filter-write — the old Promise.all(map(delete)) raced and
    // left orphans behind.
    if (orphanIds.length > 0) await historyStore.forgetMissing(orphanIds)
    return orphanIds.length
  })
  // Persist the current annotation shapes (and optionally a flattened PNG
  // sidecar) for a history item. Reopening the item replays each shape as
  // its own Canvas commit so native Undo walks back through them in order.
  ipcMain.handle('history:saveAnnotations', async (_e, id: string, annotations: unknown[], flattenedDataUrl?: string) => {
    const item = historyStore.get(id)
    if (!item) throw new Error('History item not found')
    if (!item.filePath) throw new Error('History item has no source file')

    const originalPath = resolve(normalize(item.filePath))
    if (!isAllowedPath(originalPath)) throw new Error(OUTSIDE_FOLDERS)

    const hasAnnotations = Array.isArray(annotations) && annotations.length > 0

    // Preserve the existing sidecar + thumbnail by default — only the branches
    // below overwrite them. Without this, a debounced save (which ships only
    // the vector JSON, no flattened dataUrl) would reset `annotatedFilePath`
    // to undefined, orphan the sidecar on disk, and force Dashboard Share/
    // Copy back to the un-annotated original.
    let annotatedFilePath: string | undefined = item.annotatedFilePath
    let thumbnailFile = item.thumbnailFile

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
        const originalBuf = await readFile(originalPath)
        const icc = getIccFromPng(originalBuf)
        if (icc) sidecarBuf = tagPngWithIcc(sidecarBuf, icc, 'Display')
      } catch { /* original missing or unreadable — write sidecar un-tagged */ }

      await writeFile(sidecar, sidecarBuf)
      annotatedFilePath = sidecar
      thumbnailFile = writeThumbnailFromDataUrl(id, flattenedDataUrl, item.thumbnailFile) ?? thumbnailFile
    }

    if (!hasAnnotations && item.annotatedFilePath) {
      try {
        const prev = resolve(normalize(item.annotatedFilePath))
        if (isAllowedPath(prev)) await unlink(prev)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('[history:saveAnnotations] failed to clean up sidecar', err)
        }
      }
      annotatedFilePath = undefined
      // Regenerate thumbnail from the original now that annotations are gone.
      try {
        const buf = await readFile(originalPath)
        thumbnailFile = writeThumbnail(id, nativeImage.createFromBuffer(buf), item.thumbnailFile) ?? thumbnailFile
      } catch { /* leave previous thumbnail rather than blank the card */ }
    }

    // An edit makes the uploaded copy stale (2026-11-23, design/IMAGE-EDITOR.md):
    // when the shapes change, the row's uploads are cleared, so Upload shows
    // again (editor and Dashboard) and the next upload carries the edit.
    // Saves that only repeat the same shapes (the debounced JSON save, then
    // the action's flattened one) keep them.
    const nextAnnotations = hasAnnotations ? (annotations as HistoryItem['annotations']) : undefined
    const changed = JSON.stringify(nextAnnotations ?? []) !== JSON.stringify(item.annotations ?? [])
    const updated = historyStore.update(id, {
      annotations: nextAnnotations,
      annotatedFilePath,
      thumbnailFile,
      ...(changed && item.uploads?.length ? { uploads: [] } : {}),
    })
    return updated && resolveThumbnailUrl(updated)
  })

  // A clip's uploaded copy (2026-11-21), for clips whose local file is gone:
  // R2 links are public, so a plain fetch; Drive needs the API with the
  // user's token (the file id is in the stored link). The upload is the
  // shared version: the edited (flattened) image or the trimmed video when
  // there was one, not necessarily the original.
  // `signal` cancels it (the restore toast's X); it then returns
  // { error: 'cancelled' }.
  // The copy is streamed to disk (stream-to-file.ts), never held in memory:
  // a long recording is gigabytes.
  type UploadedCopy = { kind: 'r2'; url: string } | { kind: 'drive'; url: string; fileId: string }
  const uploadedCopyOf = (item: HistoryItem): UploadedCopy | null => {
    const r2 = item.uploads?.find(u => u.destination === 'r2' && u.success && u.url)
    if (r2?.url) return { kind: 'r2', url: r2.url }
    const drive = item.uploads?.find(u => u.destination === 'google-drive' && u.success && u.url)
    const fileId = drive?.url?.match(/\/file\/d\/([^/]+)/)?.[1]
    return drive?.url && fileId ? { kind: 'drive', url: drive.url, fileId } : null
  }
  /** Download `copy` to `dest` (written beside it first, moved into place
   *  when complete). `signal` cancels it: then, and on any failure, nothing
   *  is left at or beside `dest`. */
  const saveUploadedCopy = async (copy: UploadedCopy, dest: string, signal?: AbortSignal): Promise<{ ok: true } | { error: string }> => {
    try {
      let res: Response
      if (copy.kind === 'r2') {
        res = await net.fetch(copy.url, { signal })
        if (!res.ok) return { error: `Download failed (${res.status})` }
      } else {
        const got = await fetchDriveFile(copy.fileId, signal)
        if ('error' in got) return got
        res = got.res
      }
      await saveResponseTo(res, dest, signal)
      return { ok: true }
    } catch (err) {
      if (signal?.aborted) return { error: 'cancelled' }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Download button: save the uploaded copy to the Downloads folder under
  // the clip's name (" (1)", " (2)"… when taken) and show it in Finder /
  // Explorer. The history row is left as it is.
  ipcMain.handle('history:downloadFromCloud', async (_e, id: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const item = historyStore.get(id)
    if (!item) return { ok: false, error: 'History item not found' }
    const copy = uploadedCopyOf(item)
    if (!copy) return { ok: false, error: 'No uploaded copy to download' }
    const ext = extname(item.name) || extname(new URL(copy.url).pathname) || (item.type === 'recording' ? '.webm' : '.png')
    const stem = basename(item.name, extname(item.name))
    const dir = app.getPath('downloads')
    let target = join(dir, stem + ext)
    for (let n = 1; existsSync(target); n++) target = join(dir, `${stem} (${n})${ext}`)
    const saved = await saveUploadedCopy(copy, target)
    if ('error' in saved) return { ok: false, error: saved.error }
    shell.showItemInFolder(target)
    return { ok: true, path: target }
  })

  // Click on a clip whose file is gone but which was uploaded: download the
  // uploaded copy back to the clip's own path, so the clip works again
  // (editor, Copy, Save As, re-upload), and return the refreshed row for
  // the renderer to open. The copy is the shared version, so the row starts
  // over from it: saved annotation layers are dropped (the image already
  // carries them; replaying would draw them twice), and a trim is cleared
  // (the video already is the trimmed cut; its length becomes the trim's).
  // A running restore per row, so the toast's X (history:cancelRestore) can
  // stop it; a cancelled one returns { error: 'cancelled' } and writes
  // nothing (2026-11-24).
  const restoreAborts = new Map<string, AbortController>()
  ipcMain.handle('history:cancelRestore', (_e, id: string) => { restoreAborts.get(id)?.abort() })
  ipcMain.handle('history:restoreFromCloud', async (_e, id: string): Promise<{ ok: boolean; item?: HistoryItem; error?: string }> => {
    const item = historyStore.get(id)
    if (!item) return { ok: false, error: 'History item not found' }
    if (!item.filePath) return { ok: false, error: 'History item has no file path' }
    // The row's own path, checked like every path Lumia writes or deletes.
    const dest = resolve(normalize(item.filePath))
    if (!isAllowedPath(dest)) return { ok: false, error: OUTSIDE_FOLDERS }
    const copy = uploadedCopyOf(item)
    if (!copy) return { ok: false, error: 'No uploaded copy to download' }
    const abort = new AbortController()
    restoreAborts.set(id, abort)
    let saved: { ok: true } | { error: string }
    try {
      await fs.mkdir(dirname(dest), { recursive: true })
      saved = await saveUploadedCopy(copy, dest, abort.signal)
    } catch (err) {
      saved = { error: err instanceof Error ? err.message : String(err) }
    } finally {
      restoreAborts.delete(id)
    }
    if (abort.signal.aborted) return { ok: false, error: 'cancelled' }
    if ('error' in saved) return { ok: false, error: saved.error }
    if (item.annotatedFilePath) {
      const edited = resolve(normalize(item.annotatedFilePath))
      if (isAllowedPath(edited)) await fs.unlink(edited).catch(() => { /* already gone */ })
    }
    // The drawings go (they're baked into the upload), so their steps do too.
    await historyStore.editHistory.remove(id)
    // The file is another one now (the upload may be the trimmed clip): its
    // filmstrip goes, and the editor builds a new one when it opens.
    // (Checked like every path taken from a row, as unlinkItemFiles does.)
    if (item.stripFile) {
      const strip = resolve(normalize(thumbnailPathFor(item.stripFile)))
      if (isAllowedPath(strip)) await fs.unlink(strip).catch(() => { /* already gone */ })
    }
    const updated = historyStore.update(id, {
      annotations: undefined,
      annotatedFilePath: undefined,
      trim: undefined,
      stripFile: undefined,
      ...(item.trim ? { durationMs: Math.max(0, item.trim.endMs - item.trim.actualStartMs) } : {}),
    })
    if (!updated) return { ok: false, error: 'History item not found' }
    const [forView] = await forRenderer([updated])
    return { ok: true, item: forView }
  })

  // Upload a history item's source file to R2 and copy the resulting URL.
  // Dedup: if the item already has a successful r2 upload, reuse it so repeat
  // clicks don't re-issue requests (uploadToR2 itself is content-addressable
  // too, but this path short-circuits before even reading the file).
  ipcMain.handle('history:shareR2', async (_e, id: string) => {
    const item = historyStore.get(id)
    if (!item) throw new Error('History item not found')
    if (!item.filePath) throw new Error('History item has no source file')

    const existing = item.uploads?.find(u => u.destination === 'r2' && u.success && u.url)
    if (existing?.url) {
      clipboard.writeText(existing.url)
      return existing
    }


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
        body: 'Uploaded, link copied',
        onlyWhenClosed: true, // the Dashboard / editor show their own toast
        ...thumbnailNotifyOpts(item),
      })
    }
    return res
  })

  // Upload a history item's source file to Google Drive and copy the resulting
  // URL. Mirrors the R2 path: dedup if already uploaded, refresh OAuth token if
  // expired, persist the upload result so subsequent clicks short-circuit.
  ipcMain.handle('history:shareGoogleDrive', async (_e, id: string) => {
    const item = historyStore.get(id)
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
      return { destination: 'google-drive', success: false, error: 'No Drive folder selected. Pick one in Settings › Uploads.' }
    }

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
        body: 'Uploaded to Drive, link copied',
        onlyWhenClosed: true, // the Dashboard / editor show their own toast
        ...thumbnailNotifyOpts(item),
      })
    }
    return res
  })

  // Cmd+click (Ctrl+click on Windows) on a clip (2026-11-27): the file in
  // Finder / Explorer, the edited or trimmed copy when there is one (the
  // file the clip stands for), else the original. A renamed file was
  // followed when its day was read (file-relink.ts).
  ipcMain.handle('history:reveal', async (_e, id: string) => {
    const item = typeof id === 'string' ? historyStore.get(id) : null
    if (!item) return false
    for (const p of [item.annotatedFilePath, item.filePath]) {
      if (!p || !isAllowedPath(p)) continue
      try { await access(p) } catch { continue }
      shell.showItemInFolder(p)
      return true
    }
    return false
  })
  ipcMain.handle('history:addCapture', async (_e, item) => {
    // If a renderer is adding a screenshot with only a dataUrl (e.g. scroll
    // capture, video-annotator frame extract), persist the original to
    // ~/Pictures/Lumia/ here so every history item references a real file.
    try {
      if (item && item.type === 'screenshot' && !item.filePath && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')) {
        await mkdir(captureFolder(), { recursive: true })
        const ext = item.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'
        const filename = `capture-${localTimestamp()}.${ext}`
        const filePath = join(captureFolder(), filename)
        const base64 = item.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        await writeFile(filePath, Buffer.from(base64, 'base64'))
        item = { ...item, name: item.name ?? filename, filePath }
      }
      // Replace the full dataUrl with a compact thumbnail. `filePath` is the
      // source of truth for the full image — dataUrl is never stored.
      if (item && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')) {
        const { dataUrl, thumbnailUrl, ...rest } = item
        item = { ...rest, thumbnailFile: writeThumbnailFromDataUrl(item.id, thumbnailUrl ?? dataUrl) }
      }
    } catch (err) {
      console.error('[history:addCapture] failed to persist original', err)
    }
    return historyStore.add(item)
  })
  ipcMain.handle('history:readAsDataUrl', async (_e, filePath: string) => {
    const normalized = resolve(normalize(filePath))
    if (!isAllowedPath(normalized)) throw new Error(OUTSIDE_FOLDERS)
    const ext = extname(normalized).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
    try {
      const buf = await readFile(normalized)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (err: unknown) {
      // File deleted between the history read's fs.access probe and this read —
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
  // Renderer toggles this while the Settings UI is recording a new binding,
  // so existing global shortcuts don't fire (and double-bind) on the keys
  // the user is pressing to set the new combo.
  ipcMain.handle('hotkeys:setRecording', (_e, recording: boolean) => {
    if (recording) teardownHotkeys()
    else setupHotkeys()
  })
  /** Whether this build can use Google Drive: the OAuth client (sign-in)
   *  and the Picker keys (choosing the folder uploads go to; without one
   *  every Drive upload fails). Without all four, Settings hides Uploads
   *  and nothing starts a Drive flow (2026-11-26: a dev build without them
   *  opened Google with client_id=undefined and Connect hung on Cancel). */
  const gdriveAvailable = (): boolean => !!(
    import.meta.env.MAIN_VITE_GDRIVE_CLIENT_ID && import.meta.env.MAIN_VITE_GDRIVE_CLIENT_SECRET &&
    import.meta.env.MAIN_VITE_GDRIVE_API_KEY && import.meta.env.MAIN_VITE_GDRIVE_PROJECT_NUMBER
  )
  const GDRIVE_UNAVAILABLE = 'Not available in this version of Lumia'

  ipcMain.handle('settings:get', () => {
    // Never ship the Google OAuth tokens to the renderer — a renderer
    // compromise (XSS via rendered content) could exfiltrate the long-lived
    // refresh token. The renderer only ever needs a connected boolean.
    const s = getSettings()
    return {
      ...s,
      googleDriveRefreshToken: '',
      googleDriveAccessToken: '',
      // A build without Drive credentials has no Drive, even with tokens
      // left in the profile by another build: no Upload to Drive anywhere.
      googleDriveAvailable: gdriveAvailable(),
      googleDriveConnected: gdriveAvailable() && !!s.googleDriveRefreshToken,
      // The save folder as a path ('' in the store means the default).
      captureFolderPath: captureFolder(),
    }
  })
  // Settings › General › Save to: the OS folder dialog; the folder must be
  // writable. New captures go there; earlier files stay where they are.
  // Folder changes and moves run one at a time: each swaps or fills the
  // shared history, and a second one mid-way would write into the wrong one.
  let folderOps: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = folderOps.then(fn)
    folderOps = run.catch(() => {})
    return run
  }
  ipcMain.handle('settings:chooseCaptureFolder', () => oneAtATime(async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts: Electron.OpenDialogOptions = { defaultPath: captureFolder(), properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const dir = r.canceled ? undefined : r.filePaths[0]
    if (!dir) return null
    if (!isSuitableSaveFolder(dir, homedir())) {
      return { error: "Can't save to this folder", reason: 'Pick a folder in your home folder or on another drive' }
    }
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.access(dir, fsConstants.W_OK)
    } catch {
      return { error: "Can't save to this folder", reason: "Lumia can't write there" }
    }
    const from = captureFolder()
    const fromRoot = historyRootFor(userData, from)
    const toRoot = historyRootFor(userData, dir)
    const store = historyStoreInstance
    // The new folder's history first: if it can't be opened, nothing changes.
    if (store && toRoot !== fromRoot) {
      try {
        store.useRoot(toRoot, toRoot === userData ? undefined : HISTORY_CLEANUP_VERSION)
      } catch (err) {
        return { error: "Can't save to this folder", reason: (err as Error).message }
      }
    }
    setCaptureFolder(dir)
    watchCaptureFolder()
    let imported = 0
    let movable = 0
    if (store && toRoot !== fromRoot) {
      // Lumia files already in the folder that its history doesn't have;
      // checked again after the scan, since a capture may have landed.
      const found = await scanForNewFiles(captureFolder(), store.allRows())
      const known = new Set(store.allRows().flatMap(row => [row.filePath, row.annotatedFilePath]).filter((p): p is string => !!p).map(pathKey))
      imported = store.addMany(found.filter(row => !known.has(pathKey(row.filePath!))), HISTORY_CLEANUP_VERSION)
      movable = rowCount(fromRoot)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed', {})
    }
    return { folder: captureFolder(), from, imported, movable }
  }))
  // The dialog after a folder change: move the previous folder's files (and
  // their rows) into the current one. `from` must be a folder used before.
  ipcMain.handle('settings:moveCaptureFiles', (_e, from: string) => oneAtATime(async () => {
    const store = historyStoreInstance
    const past = getSettings().pastCaptureFolders ?? []
    if (!store || typeof from !== 'string' || !past.some(p => pathKey(p) === pathKey(from))) return { moved: 0, failed: 0 }
    const fromRoot = historyRootFor(userData, from)
    if (fromRoot === historyRootFor(userData, captureFolder())) return { moved: 0, failed: 0 }
    const result = await moveRows(fromRoot, from, captureFolder(), row => store.addRow(row, HISTORY_CLEANUP_VERSION))
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed', {})
    return result
  }))
  ipcMain.handle('settings:set', (_e, key: keyof AppSettings, value: unknown) => {
    // The replay modes take only known tools (isImageMode / isVideoMode in
    // settings.ts); every renderer writer (overlay ModeBar) comes through here.
    if (key === 'lastImageMode' && !isImageMode(value)) return
    if (key === 'lastVideoMode' && !isVideoMode(value)) return
    // Theme picks: #rrggbb or null only.
    if ((key === 'themeAccent' || key === 'themeLightBase' || key === 'themeDarkBase') && value !== null && validPick(value) === null) return
    // Menu-bar actions: a list of known action ids only.
    if (key === 'trayActions' && !(Array.isArray(value) && value.every(a => TRAY_ACTIONS.some(t => t.action === a)))) return
    if (key === 'openLumiaAfter' && !OPEN_LUMIA_WHEN.includes(value as OpenLumiaWhen)) return
    if (key === 'recordCountdown' && !RECORD_COUNTDOWNS.includes(value as number)) return
    // The save folder only through its dialog (settings:chooseCaptureFolder).
    if (key === 'captureFolder' || key === 'pastCaptureFolders' || key === 'wallpaperBefore') return
    setSetting(key, value as AppSettings[typeof key])
    if (key === 'launchAtStartup') applyLaunchAtStartup(value as boolean)
    if (key === 'historyRetentionDays') runHistoryPrune()
    if (key === 'saveEditHistory' && value === false) return historyStore.editHistory.clear()
    if (key === 'autoUpdateWhenHidden') applyAutoUpdateSetting()
    if (key === 'themeAccent' || key === 'themeLightBase' || key === 'themeDarkBase') {
      // Every window restyles live (pooled overlays included); the native
      // chrome follows the base.
      const picks = getThemePicks()
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme:changed', { picks })
      applyThemeChrome()
    }
  })

  // Dedicated IPC for the PrintScreen toggle: it has two side-effects (rebind
  // the global shortcut, write a Windows registry value) and the registry op
  // can fail in a way the renderer needs to surface as a warning, so we don't
  // route it through the generic settings:set channel. Returns
  // `{ warning?: string; detail?: string }`: a present `warning` means "the setting was
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

  // IPC: Wallpapers (Wikimedia Commons, Wallhaven). Failures surface as
  // `{ ok: false, error }` the renderer can show inline; the credit call
  // never fails (`{}`).
  ipcMain.handle('wallpapers:fetch', async (_e, source, query) => {
    if ((source !== 'commons' && source !== 'wallhaven') || !query || typeof query !== 'object') {
      return { ok: false as const, error: "Couldn't load photos" }
    }
    try {
      const { fetchWallpapers } = await import('./wallpaper-sources')
      const batch = await fetchWallpapers(source, query)
      return { ok: true as const, batch }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('wallpapers:credit', async (_e, photo) => {
    try {
      const { creditFor } = await import('./wallpaper-sources')
      return await creditFor(photo)
    } catch {
      return {}
    }
  })

  // Whether this build has R2 credentials baked in; without them Share can't
  // work, so the UI shows it disabled instead of failing on click.
  ipcMain.handle('share:r2IsConfigured', () => !!(
    import.meta.env.MAIN_VITE_R2_ACCOUNT_ID && import.meta.env.MAIN_VITE_R2_ACCESS_KEY_ID &&
    import.meta.env.MAIN_VITE_R2_SECRET_ACCESS_KEY && import.meta.env.MAIN_VITE_R2_BUCKET
  ))


  ipcMain.handle('wallpapers:screens', async (_e, previews?: boolean) => (await import('./wallpapers')).wallpaperScreens(previews === true))
  ipcMain.handle('wallpapers:canReset', async () => (await import('./wallpapers')).canResetWallpaper())
  ipcMain.handle('wallpapers:reset', async () => {
    try {
      await (await import('./wallpapers')).resetDesktopWallpaper()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('wallpapers:setAsWallpaper', async (_e, photo, screenIds?: unknown) => {
    try {
      const { setDesktopWallpaper } = await import('./wallpapers')
      const ids = Array.isArray(screenIds) ? screenIds.filter((n): n is number => typeof n === 'number') : []
      const result = await setDesktopWallpaper(photo, ids)
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

  /** The Drive connect pages' shared files (browser-page.ts): the favicon,
   *  the stylesheet in the app's current theme and the Manrope weights.
   *  None is sensitive, so both servers answer them before any nonce check.
   *  True when it answered. */
  const serveBrowserPageAsset = async (pathname: string, res: import('http').ServerResponse): Promise<boolean> => {
    if (pathname === '/favicon.png' || pathname === '/favicon.ico') {
      const buf = await loadFavicon()
      if (buf) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
        res.end(buf)
      } else {
        res.writeHead(404)
        res.end()
      }
      return true
    }
    if (pathname === PAGE_CSS_PATH) {
      const mode = savedThemeMode()
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(pageCss(pageRoles(mode, getThemePicks()), mode))
      return true
    }
    const font = pathname.match(/^\/fonts\/manrope-(\d{3})\.woff2$/)
    if (font && (PAGE_FONT_WEIGHTS as readonly number[]).includes(Number(font[1]))) {
      try {
        const buf = await fs.readFile(join(app.getAppPath(), 'node_modules/@fontsource/manrope/files', `manrope-latin-${font[1]}-normal.woff2`))
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=86400' })
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end()
      }
      return true
    }
    return false
  }

  // IPC: Google Drive OAuth — uses localhost redirect (OOB flow deprecated by Google)
  // Tracks an in-progress OAuth flow so the renderer can cancel it (user clicked
  // Connect by mistake, opened the wrong browser, etc.). Calling startAuth again
  // while one is active first cancels the previous flow.
  let activeAuthServer: import('http').Server | null = null
  let activeAuthResolve: ((value: { success: boolean; error?: string; cancelled?: boolean; denied?: boolean }) => void) | null = null

  ipcMain.handle('gdrive:startAuth', async () => {
    if (!gdriveAvailable()) return { success: false, error: GDRIVE_UNAVAILABLE }
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

    return new Promise<{ success: boolean; error?: string; cancelled?: boolean; denied?: boolean }>((resolve) => {
      // The OAuth server lifecycle is intentionally decoupled from `settle`:
      // after a successful code exchange we settle the IPC promise immediately
      // (so the renderer drops the connecting spinner), but keep the local
      // server listening so the Connected page's "Browse Drive folder" button
      // can hit /pick-folder. The server is finally torn down on Browse click,
      // on a new startAuth, on cancelAuth, or after the auto-close grace.
      let authAutoCloseTimer: ReturnType<typeof setTimeout> | null = null
      // This sign-in's own secrets (2026-11-27). `state` comes back on
      // Google's redirect: a request without it isn't from this sign-in (a
      // web page pointing the browser at this port with someone else's
      // code) and is refused without ending the flow. PKCE: the tokens are
      // only given for the code together with `codeVerifier`, which never
      // leaves the app. `connected`: the code is exchanged once.
      const state = randomBytes(16).toString('hex')
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
      let connected = false
      const pickHref = `/pick-folder?k=${state}`
      const settle = (value: { success: boolean; error?: string; cancelled?: boolean; denied?: boolean }) => {
        if (activeAuthResolve !== settle) return
        activeAuthResolve = null
        resolve(value)
      }
      activeAuthResolve = settle

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (await serveBrowserPageAsset(url.pathname, res)) return

        // Browse button on the Connected page hits this route. Boot the
        // picker server (port 42814) and 302 the user's browser there. Only
        // from that page: its link carries this sign-in's key.
        if (url.pathname === '/pick-folder') {
          if (!connected || url.searchParams.get('k') !== state) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Forbidden')
            return
          }
          const result = await startGdriveFolderPicker()
          if (!result.ok) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(pickerFailedPage(result.error))
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

        // Already signed in (the tab reloaded, or a second request): the
        // Connected page again, nothing exchanged twice.
        if (connected) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(connectedPage(pickHref))
          return
        }
        // Not this sign-in's redirect: refused, and the flow keeps waiting
        // for the real one.
        if (url.searchParams.get('state') !== state) {
          console.warn('[gdrive] sign-in callback without the expected state, ignored')
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Forbidden')
          return
        }

        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(connectFailedPage({ oauthError: error }))
          server.close()
          // Declined on Google's screen: not a failure, Settings says so
          // as a warning. Any other code is the raw reason.
          if (error === 'access_denied') settle({ success: false, denied: true })
          else settle({ success: false, error: error ?? 'Google sent no sign-in code' })
          return
        }

        // Exchange the code BEFORE rendering the Connected page so that, by
        // the time the user sees the Browse button, the refresh token is
        // already on disk and /pick-folder is guaranteed to find it. On
        // failure we fall through to the same failure HTML.
        try {
          const result = await exchangeGoogleAuthCode(code, clientId, clientSecret, 'http://localhost:42813', codeVerifier)
          connected = true
          setSetting('googleDriveAccessToken', result.accessToken)
          setSetting('googleDriveRefreshToken', result.refreshToken)
          setSetting('googleDriveTokenExpiresAt', result.expiresAt)
          mainWindow?.webContents.send('gdrive:connected')
          settle({ success: true })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(connectFailedPage({ exchangeError: msg }))
          server.close()
          settle({ success: false, error: msg })
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(connectedPage(pickHref))
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
          prompt: 'consent',
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
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
    if (!gdriveAvailable()) return { ok: false, error: GDRIVE_UNAVAILABLE }
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

      // The favicon, stylesheet and fonts are fetched without our nonce
      // query string, so they're served before the nonce gate. None of them
      // is sensitive or exposes a token.
      if (await serveBrowserPageAsset(url.pathname, res)) return

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

  // The chosen folder's name for Settings (only its id is stored).
  ipcMain.handle('gdrive:folderName', async (_e, folderId: string) => {
    if (typeof folderId !== 'string' || !folderId) return { error: 'No folder id' }
    try {
      return await getDriveFolderName(folderId)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
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
    const normalized = resolve(normalize(filePath))
    if (!isAllowedPath(normalized)) throw new Error(OUTSIDE_FOLDERS)
    await mkdir(dirname(normalized), { recursive: true })
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(normalized, Buffer.from(base64, 'base64'))
    return normalized
  })

  // IPC: Shell
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links can be opened')
    return shell.openExternal(url)
  })

  // IPC: Dialog
  ipcMain.handle('dialog:save', async (_e, opts: Electron.SaveDialogOptions = {}) => {
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

  // IPC: Clipboard write text — renderer's navigator.clipboard.writeText fails
  // under file:// (non-secure context), so we round-trip through Electron's API.
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text)
  })

  // IPC: the renderer's theme changed. The native appearance follows it
  // (macOS draws the traffic lights, context menus and scrollbars for it;
  // left on the system appearance, a light Lumia in a dark-mode Mac gets the
  // dark-mode inactive traffic lights, which look white). On Windows the
  // titleBarOverlay colors follow too.
  ipcMain.handle('titlebar:setTheme', (_e, theme: 'dark' | 'light' | 'system') => {
    const resolved = theme === 'system'
      ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : theme
    nativeTheme.themeSource = resolved
    // The AppBar's bg-toolbar and icon grey, with the user's base.
    applyThemeChrome(resolved)
  })

  // The preload's first call, synchronous so the theme lands before the
  // first paint: the saved mode, the picks, and whether this window takes
  // the base (main window, capture overlays) or only the accent (recording
  // windows).
  ipcMain.on('theme:initial', (e) => {
    e.returnValue = { mode: savedThemeMode(), picks: getThemePicks(), neutrals: mainWebContentsIds.has(e.sender.id) || overlayWebContentsIds.has(e.sender.id) }
  })

  // Live preview while the Custom picker is dragged (2026-11-22): every
  // window restyles with the dragged colour, nothing is saved; the release
  // saves through settings:set, which broadcasts the saved picks again.
  ipcMain.on('theme:preview', (_e, key: 'themeAccent' | 'themeLightBase' | 'themeDarkBase', value: unknown) => {
    const hex = validPick(value)
    const field = key === 'themeAccent' ? 'accent' : key === 'themeLightBase' ? 'lightBase' : key === 'themeDarkBase' ? 'darkBase' : null
    if (!hex || !field) return
    const picks: ThemePicks = { ...getThemePicks(), [field]: hex }
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme:changed', { picks })
    applyThemeChrome(savedThemeMode(), picks)
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
      const normalized = resolve(normalize(filePath))
      // Same sandbox as file:read (the home directory and the save
      // folders, capture-folder.ts) — never serve arbitrary disk paths.
      if (!isAllowedPath(normalized)) {
        // A refused path is a bug signal (e.g. a profile dir outside the home
        // directory), not a normal miss - say so instead of failing silently.
        console.warn('[lumia-media] refused path outside the home directory and save folders:', normalized)
        return new Response('Forbidden', { status: 403 })
      }

      const total = (await stat(normalized)).size
      const ext = extname(normalized).toLowerCase()
      const contentType =
        ext === '.mp4' ? 'video/mp4' :
        ext === '.webm' ? 'video/webm' :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.png' ? 'image/png' :
        ext === '.webp' ? 'image/webp' :
        'application/octet-stream'

      const toWeb = (start?: number, end?: number) =>
        Readable.toWeb(createReadStream(normalized, { start, end })) as unknown as ReadableStream<Uint8Array>

      // CORS only for Lumia's own pages (dev server, packaged file://), so a
      // crossOrigin <video> can be drawn to a canvas and exported (thumbnail
      // grabs) while other origins, e.g. the OAuth window, still can't read files.
      const origin = request.headers.get('origin')
      const appOriginCors: Record<string, string> =
        origin && (origin === 'null' || origin === 'file://' || /^http:\/\/localhost:\d+$/.test(origin))
          ? { 'Access-Control-Allow-Origin': origin }
          : {}

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
            ...appOriginCors,
          },
        })
      }

      return new Response(toWeb(), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          ...appOriginCors,
        },
      })
    } catch (err) {
      console.error('[lumia-media] stream failed', err)
      return new Response('Error', { status: 500 })
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    } else {
      // Focused too, like every other way back (2026-11-24).
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
})

// Cmd+Q, the Dock's Quit and the tray's Quit all really quit: the
// before-quit handler near the top sets `isQuitting`, so the window's close
// handler lets the close through. (Until 2026-11 a second before-quit
// handler here turned Cmd+Q into "hide to tray"; it could no longer run.)

app.on('window-all-closed', () => {
  // Keep app running in the tray instead of quitting when windows close.
  // The user can still quit via the tray menu or Cmd/Ctrl+Q.
  if (!isQuitting) return
  if (process.platform !== 'darwin') app.quit()
})

// OS-initiated logout / shutdown / restart: mark the quit as ours, so the
// window's close handler doesn't hide to tray instead, then quit for real
// (or the OS reports "Lumia interrupted shutdown").
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
    // clears `mainDismissedByUser` before the callback reads it.
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
        void openHistoryItemInEditor(id)
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

/** Calls `onChange` (bundled over 300ms) when a file in the captures folder
 *  is added, removed or renamed. Creates the folder if it isn't there yet;
 *  without it (no permission) there's nothing to watch. */
// The save folder's watcher; replaced when the folder changes (Settings ›
// General › Save to). Earlier folders aren't watched: their files still
// show as missing on the next focus check (history:missingIds).
let captureWatcher: ReturnType<typeof watchFs> | null = null
let captureWatchChange: (() => void) | null = null
let captureWatchGeneration = 0
app.on('will-quit', () => captureWatcher?.close())

function watchCaptureFolder(onChange: () => void = captureWatchChange ?? (() => {})): void {
  captureWatchChange = onChange
  captureWatcher?.close()
  captureWatcher = null
  const dir = captureFolder()
  const generation = ++captureWatchGeneration
  let timer: ReturnType<typeof setTimeout> | null = null
  void fs.mkdir(dir, { recursive: true }).catch(() => {}).then(() => {
    // Called again meanwhile: only the newest call watches.
    if (generation !== captureWatchGeneration || captureFolder() !== dir) return
    captureWatcher?.close()
    try {
      const watcher = watchFs(dir, { persistent: false }, () => {
        if (timer) return
        timer = setTimeout(() => { timer = null; onChange() }, 300)
      })
      watcher.on('error', err => console.warn('[history] captures folder watch stopped:', err.message))
      captureWatcher = watcher
    } catch (err) {
      console.warn('[history] captures folder not watched:', (err as Error).message)
    }
  })
}
