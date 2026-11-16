import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, screen } from 'electron'
import { basename, dirname, extname, join, normalize, resolve as resolvePath } from 'path'
import { homedir } from 'os'
import type { WriteStream } from 'fs'
import {
  getMainWindow,
  getHistoryStore,
  closeAllOverlays,
  createOverlayWindows,
  getOverlayDisplayId,
  restoreFromOverlayCancel,
  waitForViewMounted,
  openHistoryItemInEditor,
  isMainDismissed,
} from './index'
import { ORIGINALS_DIR } from './capture'
import { uploadFileToR2 } from './uploaders/r2'
import { uploadFilePathToDrive } from './google-drive-service'
import { resetOverlayMode, setOverlayMode } from './scroll-capture'
import { showNotification } from './notify'
import { getSettings, resolveSaveStartDir, rememberSaveDir } from './settings'
import { localTimestamp } from './utils'
import { writeThumbnailFromDataUrl, resolveThumbnailUrl } from './thumbnail'
import { openAnnotation, closeAnnotation, destroyAnnotation, isAnnotationOpen, setupAnnotation } from './annotation'
import { forceWindowsExcludeFromCapture } from './native-input'
import { getSinglePickTarget } from './window-list'
import { getWatermarkLogoDataUrl } from './watermark'
import { remuxWebmInPlace, trimWebm, isTrimRunning } from './ffmpeg-remux'

const HIDE_DELAY_MS = process.platform === 'darwin' ? 250 : 200
const OVERLAY_GONE_DELAY_MS = 120

const isDev = !app.isPackaged

// ── Target + window state ──────────────────────────────────────────────────

export interface RecordingTarget {
  kind: 'region' | 'window' | 'screen'
  sourceId: string
  displayId: number
  /** Overlay-local DIP rect (region/window only) */
  rect?: { x: number; y: number; width: number; height: number }
  /** Display DIP size — recorder host computes the DIP→stream-pixel scale
   *  from this plus actual video frame dims at draw time, matching the image
   *  capture pattern. */
  displayDipSize: { width: number; height: number }
  /** Display scale factor — used to pin the getUserMedia stream to exact
   *  physical dims, preventing Chromium from aspect-padding the frame. */
  displayScaleFactor: number
  /** Physical-pixel output canvas dims (region/window only). */
  outputSize?: { width: number; height: number }
}

let recordingTarget: RecordingTarget | null = null
let recorderHost: BrowserWindow | null = null
let recordingToolbar: BrowserWindow | null = null
let recordingBorder: BrowserWindow | null = null

// True once MediaRecorder has actually started (toolbar:begin fired). Used to
// distinguish a Stop pressed during the countdown (→ cancel, nothing to save)
// from a real stop, so the session can't wedge in 'stopping' forever.
let recordingBegun = false

// Streamed save state: the finished webm is forwarded from the recorder host
// to disk in bounded slices (save-begin → save-chunk* → save-end) rather than
// one multi-GB ArrayBuffer over IPC, which OOM'd the renderer and could blow
// the structured-clone limit on long recordings.
let recordingWriteStream: WriteStream | null = null
let recordingSaveFilePath: string | null = null
let recordingSaveBytes = 0

export function getRecordingTarget(): RecordingTarget | null {
  return recordingTarget
}

export function isRecordingActive(): boolean {
  return recorderHost !== null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hideMain(): Promise<void> {
  return new Promise(resolve => {
    // "Capture Lumia window too" — keep the app visible so it can be part of
    // the recording (and a window-record target).
    if (getSettings().captureSelfWindow) return resolve()
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return resolve()
    win.hide()
    setTimeout(resolve, HIDE_DELAY_MS)
  })
}

function showMain() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
}

function waitForOverlayGone(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, OVERLAY_GONE_DELAY_MS))
}

/** Resolve the screen desktopCapturer source for a display. */
async function resolveScreenSourceId(displayId: number): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }, // we only need IDs
  })
  const allDisplays = screen.getAllDisplays()
  const byId = sources.find(s => s.display_id === String(displayId))
  if (byId) return byId.id
  // Fallback: some platform/Electron combos report empty display_id on
  // screen sources. Pairing by enumeration order is not contractually
  // aligned with screen.getAllDisplays(), so on multi-monitor setups this
  // can capture the wrong display — warn so it's diagnosable.
  const idx = allDisplays.findIndex(d => d.id === displayId)
  if (idx >= 0 && idx < sources.length) {
    if (sources.length > 1) {
      console.warn('[video] display_id unavailable on capture sources; falling back to index pairing — recorded monitor may differ from selection')
    }
    return sources[idx].id
  }
  return sources[0]?.id ?? ''
}

type Rect = { x: number; y: number; width: number; height: number }

/** Clip a display-local DIP rect to the display. The overlay captures the
 *  pointer during a drag, so a drag released on the neighbouring monitor
 *  reports coordinates past this display's edge (negative, or > width) —
 *  unclamped, the recorder would crop outside the captured frame and the
 *  border/toolbar would be placed on the wrong monitor. Null when nothing
 *  usable (< 2 DIP either way) is left. */
function clampRectToDisplay(rect: Rect, display: Electron.Display): Rect | null {
  const W = display.bounds.width
  const H = display.bounds.height
  const left = Math.max(0, Math.min(W, Math.round(rect.x)))
  const top = Math.max(0, Math.min(H, Math.round(rect.y)))
  const right = Math.max(0, Math.min(W, Math.round(rect.x + rect.width)))
  const bottom = Math.max(0, Math.min(H, Math.round(rect.y + rect.height)))
  if (right - left < 2 || bottom - top < 2) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Pin a recording chrome window (border / toolbar) to its intended bounds.
 *  The constructor's x/y is not trusted on either platform:
 *   - Windows: interpreted in the primary display's DPI context, so a window
 *     on a mixed-DPI secondary monitor lands short of / offset from its spot.
 *   - macOS: AppKit constrains a NORMAL-level window's frame to the visible
 *     area of a screen at creation (keeps it below the menu bar, may shove it
 *     onto the screen it mostly overlaps) — the screen-saver level that lifts
 *     that constraint is only applied after construction.
 *  So bounds are re-applied once the level is set and again at first show,
 *  and a mismatch afterwards is logged for diagnosis. */
function pinBounds(win: BrowserWindow, bounds: Rect, label?: string) {
  if (win.isDestroyed()) return
  win.setBounds(bounds)
  if (!label) return
  const got = win.getBounds()
  if (got.x !== bounds.x || got.y !== bounds.y || got.width !== bounds.width || got.height !== bounds.height) {
    console.warn(`[video] ${label} bounds mismatch — wanted ${JSON.stringify(bounds)} got ${JSON.stringify(got)}`)
  }
}

function loadRoute(win: BrowserWindow, route: string) {
  if (isDev) {
    win.loadURL(`http://localhost:5173/#${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  }
}

// ── Recording windows (toolbar + border + host) ────────────────────────────

// Recording toolbar dimensions. Fixed size — wide and tall enough for the
// annotation row to fit below the recording pill at all times. The
// annotation row hides via React state when off; the empty transparent
// area beneath the recording pill is invisible visually. Avoiding a
// runtime resize entirely sidesteps the flicker that comes from racing
// the BrowserWindow.setBounds against the renderer's mount/unmount of
// the annotation row.
// Width is wider than the annotation pill itself so the in-DOM tooltips
// hovering off either edge button still have room to render — too tight
// and the tooltip clips against the window boundary on the outermost
// tool / action buttons.
const TOOLBAR_W = 920
const TOOLBAR_H = 150

function computeToolbarBounds(display: Electron.Display, rect?: { x: number; y: number; width: number; height: number }) {
  const displayX = display.bounds.x
  const displayY = display.bounds.y
  const displayW = display.bounds.width

  if (rect) {
    // Always top of the recording region. Preference order:
    //   1. Just above the rect (outside) — keeps the region fully visible.
    //   2. Inside top-center of the rect — falls back when the rect is at the
    //      very top of the display. The toolbar is excluded from screen
    //      capture via setContentProtection, so sitting inside the rect
    //      doesn't contaminate the output.
    const cx = displayX + rect.x + rect.width / 2
    const x = Math.round(Math.max(displayX + 8, Math.min(displayX + displayW - TOOLBAR_W - 8, cx - TOOLBAR_W / 2)))
    const above = displayY + rect.y - TOOLBAR_H - 12
    const insideTop = displayY + rect.y + 12
    const y = above >= displayY + 8 ? above : insideTop
    return { x, y, width: TOOLBAR_W, height: TOOLBAR_H }
  }
  // Screen: center-top of the display
  return {
    x: Math.round(displayX + (displayW - TOOLBAR_W) / 2),
    y: displayY + 24,
    width: TOOLBAR_W,
    height: TOOLBAR_H,
  }
}

function computeBorderBounds(display: Electron.Display, rect: { x: number; y: number; width: number; height: number }, stroke = 3) {
  // Inflate by `stroke` so the red outline sits just outside the recorded
  // area, then clip to display bounds. For screen mode (rect == display
  // bounds) this collapses to the display rect, putting the border right
  // at the display edge.
  const dLeft   = display.bounds.x
  const dTop    = display.bounds.y
  const dRight  = dLeft + display.bounds.width
  const dBottom = dTop  + display.bounds.height
  const left    = Math.max(dLeft,   dLeft + rect.x - stroke)
  const top     = Math.max(dTop,    dTop  + rect.y - stroke)
  const right   = Math.min(dRight,  dLeft + rect.x + rect.width  + stroke)
  const bottom  = Math.min(dBottom, dTop  + rect.y + rect.height + stroke)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function createRecorderHost() {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setMenu(null)
  loadRoute(win, '/recorder-host')
  win.on('closed', () => { recorderHost = null })
  // A renderer crash (e.g. OOM finalizing a very long recording) would
  // otherwise leave recorderHost non-null forever — isRecordingActive() stays
  // true, the mic/desktop capture stays held, and every recording hotkey is
  // disabled until app restart. Tear the session down and surface an error.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    if (recorderHost !== win) return
    console.error('[video] recorder host renderer gone:', details.reason)
    sendToToolbar('toolbar:state', { phase: 'error', error: 'Recording process crashed' })
    setTimeout(() => { closeRecordingSession(); showMain() }, 2000)
  })
  recorderHost = win
  return win
}

function createRecordingToolbar(display: Electron.Display, rect?: { x: number; y: number; width: number; height: number }) {
  const bounds = computeToolbarBounds(display, rect)
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Defer show until first paint to avoid the white flash transparent
    // windows have on Windows before the body becomes see-through.
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  // The toolbar window is fixed at the larger annotating size at all times
  // (see TOOLBAR_W / TOOLBAR_H). That leaves transparent empty area around
  // the pills which would otherwise swallow clicks aimed at the recorded
  // app or the annotation overlay underneath. setIgnoreMouseEvents with
  // forward:true makes the WHOLE window click-through by default, while
  // still forwarding mousemove events to the renderer so it can hit-test
  // the cursor against pill bounds and flip back to capture-mode via
  // 'toolbar:set-interactive' IPC.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    pinBounds(win, bounds)
    // Re-apply content protection right around the show. Calling
    // setContentProtection from the constructor is unreliable for
    // transparent + frame:false windows on Windows — WGC capture sessions
    // bake the toolbar (including the "Starting in 3..2..1" countdown) into
    // the recording. Re-applying after the HWND is fully realised, plus a
    // direct SetWindowDisplayAffinity Win32 call as belt-and-braces, forces
    // the OS to honour the exclusion. macOS has the same class of bug with
    // NSWindowSharingNone via SCK, so we re-apply on every platform.
    win.setContentProtection(true)
    // showInactive so we don't yank focus away from whatever the user is
    // recording the moment the toolbar materialises.
    win.showInactive()
    win.setContentProtection(true)
    forceWindowsExcludeFromCapture(win)
    // After show: AppKit may constrain the frame again on order-in.
    pinBounds(win, bounds, 'toolbar')
  })
  win.setMenu(null)
  // screen-saver is the highest Z level available — stays above fullscreen
  // apps, browser fullscreen video, games, etc. Together with the
  // visibleOnFullScreen flag this keeps the Stop button reachable no matter
  // what the user is recording. relativeLevel:1 keeps this above the
  // annotation overlay (which sits at plain screen-saver) on macOS without
  // a moveTop race — the OS enforces the ordering.
  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Level is raised now — re-pin (see pinBounds for why the constructor's
  // x/y can't be trusted on mixed-DPI Windows / multi-display macOS).
  pinBounds(win, bounds)
  // First call here so the protection bit is set before any paint reaches
  // the screen — the ready-to-show callback re-applies it once the window
  // is realised because that's the only point Windows reliably honours it.
  win.setContentProtection(true)
  loadRoute(win, '/recording-toolbar')
  win.on('closed', () => { recordingToolbar = null })
  recordingToolbar = win
  return win
}

function createRecordingBorder(display: Electron.Display, rect: { x: number; y: number; width: number; height: number }) {
  const bounds = computeBorderBounds(display, rect)
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    // Defer show — same flash issue as the toolbar window.
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    pinBounds(win, bounds)
    // Same WGC-vs-transparent-window bug as the toolbar: re-apply content
    // protection around the show + force the Win32 capture-exclude affinity,
    // otherwise the red border bakes into the recording on Windows.
    win.setContentProtection(true)
    win.showInactive()
    win.setContentProtection(true)
    forceWindowsExcludeFromCapture(win)
    pinBounds(win, bounds, 'border')
  })
  win.setMenu(null)
  // relativeLevel:1 keeps the border above the annotation overlay on macOS.
  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Level is raised now — re-pin (a border flush with the top edge of an
  // external display is otherwise pushed below its menu bar on macOS).
  pinBounds(win, bounds)
  win.setIgnoreMouseEvents(true, { forward: false })
  win.setContentProtection(true)
  loadRoute(win, '/recording-border')
  win.on('closed', () => { recordingBorder = null })
  recordingBorder = win
  return win
}

function openRecordingSession(target: RecordingTarget) {
  recordingTarget = target
  recordingBegun = false
  const allDisplays = screen.getAllDisplays()
  const display = allDisplays.find(d => d.id === target.displayId) ?? screen.getPrimaryDisplay()

  // One line per session — enough to diagnose "recorded the wrong area /
  // wrong monitor" reports from a log without a repro.
  console.log(
    `[video] session ${target.kind} display=${display.id} bounds=${JSON.stringify(display.bounds)}@${display.scaleFactor}x`
    + ` rect=${JSON.stringify(target.rect ?? null)} source=${target.sourceId}`
    + ` displays=${allDisplays.map(d => `${d.id}:${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}x`).join(' | ')}`,
  )

  createRecorderHost()
  createRecordingToolbar(display, target.rect)
  // Always frame the recorded area with a red border. For region/window we
  // already have a rect; for screen mode the "rect" is the whole display.
  const borderRect = target.rect ?? {
    x: 0, y: 0,
    width: display.bounds.width,
    height: display.bounds.height,
  }
  createRecordingBorder(display, borderRect)
}

export function closeRecordingSession() {
  recordingTarget = null
  recordingBegun = false
  // Tear down any half-open save stream (e.g. cancel during finalize) so a
  // dangling fd / partial file doesn't leak into the next session.
  if (recordingWriteStream) {
    try { recordingWriteStream.destroy() } catch { /* ignore */ }
    recordingWriteStream = null
    recordingSaveFilePath = null
    recordingSaveBytes = 0
  }
  // destroyAnnotation, not closeAnnotation: end of session means strokes
  // shouldn't outlive the recording. closeAnnotation only hides the
  // palette, which is the wrong behaviour here.
  destroyAnnotation()
  for (const w of [recorderHost, recordingToolbar, recordingBorder]) {
    if (w && !w.isDestroyed()) {
      try { w.close() } catch { /* ignore */ }
    }
  }
  recorderHost = null
  recordingToolbar = null
  recordingBorder = null
}

// ── IPC forwarding between toolbar and recorder host ───────────────────────

function sendToHost(channel: string, ...args: unknown[]) {
  if (recorderHost && !recorderHost.isDestroyed()) {
    recorderHost.webContents.send(channel, ...args)
  }
}

function sendToToolbar(channel: string, ...args: unknown[]) {
  if (recordingToolbar && !recordingToolbar.isDestroyed()) {
    recordingToolbar.webContents.send(channel, ...args)
  }
}

// ── Save recorded blob ─────────────────────────────────────────────────────

async function recordHistoryAndNotify(
  filePath: string,
  thumbnailDataUrl: string,
  durationMs: number,
): Promise<{ filePath: string; historyId?: string }> {
  const filename = basename(filePath)

  // History entry. Capture the id so the editor can pass it through to
  // runWorkflow — without it, a follow-up Upload R2 lands in the "no
  // historyId" branch and creates a duplicate entry.
  let historyId: string | undefined
  const historyStore = getHistoryStore()
  if (historyStore) {
    const id: string = require('crypto').randomUUID()
    historyStore.add({
      id,
      timestamp: Date.now(),
      name: filename,
      filePath,
      thumbnailFile: writeThumbnailFromDataUrl(id, thumbnailDataUrl),
      type: 'recording',
      uploads: [],
    })
    historyId = id
  }

  // Snapshot tray state at notification fire time so banner / Action
  // Center clicks pin the same X-close-to-tray behavior regardless of
  // what happens to the window between toast appearance and click.
  const fromTray = isMainDismissed()
  showNotification({
    body: `Recording saved · ${Math.round(durationMs / 1000)}s`,
    thumbnailDataUrl,
    onClick: historyId ? () => { void openHistoryItemInEditor(historyId!, fromTray) } : undefined,
    launchId: historyId ?? undefined,
  })

  return { filePath, historyId }
}

/** Start a window recording for a display-local DIP rect. Shared by the
 *  overlay click-confirm, the Enter-picks-active-window shortcut, and the
 *  single-window fast path (where no overlay was ever created — the overlay
 *  teardown calls are no-ops then). */
export async function beginWindowRecording(
  rawRect: { x: number; y: number; width: number; height: number },
  displayId?: number | null,
) {
  const allDisplays = screen.getAllDisplays()
  const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
  const sf = display.scaleFactor || 1
  const rect = clampRectToDisplay(rawRect, display)
  if (!rect) {
    console.warn('[video] window rect lies outside its display — ignoring', rawRect, display.bounds)
    return
  }

  resetOverlayMode()
  closeAllOverlays()
  await waitForOverlayGone()

  const sourceId = await resolveScreenSourceId(display.id)
  if (!sourceId) { showMain(); return }

  openRecordingSession({
    kind: 'window',
    sourceId,
    displayId: display.id,
    rect,
    displayDipSize: { width: display.size.width, height: display.size.height },
    displayScaleFactor: sf,
    outputSize: {
      width:  Math.max(1, Math.round(rect.width  * sf)),
      height: Math.max(1, Math.round(rect.height * sf)),
    },
  })
}

// ── Setup IPC ──────────────────────────────────────────────────────────────

export function setupVideo() {
  setupVideoActions()
  setupAnnotation()

  // Start: user clicked "Record Screen" on dashboard (or hotkey).
  // Opens overlay in video mode so user can pick region/window/screen.
  ipcMain.handle('video:start', async (_e, mode: 'region' | 'window' | 'screen') => {
    await startVideoCapture(mode)
  })

  // Region confirm: user dragged a region → compute target, close overlay,
  // open recording windows.
  ipcMain.handle('video:region-confirm', async (e, rawRect: { x: number; y: number; width: number; height: number }) => {
    const displayId = getOverlayDisplayId(e.sender)
    const allDisplays = screen.getAllDisplays()
    const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
    const sf = display.scaleFactor || 1
    const rect = clampRectToDisplay(rawRect, display)
    if (!rect) {
      console.warn('[video] region rect lies outside its display — ignoring', rawRect, display.bounds)
      return
    }

    resetOverlayMode()
    closeAllOverlays()
    await waitForOverlayGone()

    const sourceId = await resolveScreenSourceId(display.id)
    if (!sourceId) { showMain(); return }

    openRecordingSession({
      kind: 'region',
      sourceId,
      displayId: display.id,
      rect,
      displayDipSize: { width: display.size.width, height: display.size.height },
      displayScaleFactor: sf,
      outputSize: {
        width:  Math.max(1, Math.round(rect.width  * sf)),
        height: Math.max(1, Math.round(rect.height * sf)),
      },
    })
  })

  // Window confirm: user clicked a window. For v1 we treat it like region:
  // crop the display's capture to the window's rect. Window movement/resize
  // during recording is not yet tracked (v2 TODO).
  ipcMain.handle('video:window-confirm', async (e, rect: { x: number; y: number; width: number; height: number }) => {
    await beginWindowRecording(rect, getOverlayDisplayId(e.sender))
  })

  // Screen confirm: user clicked a monitor overlay.
  ipcMain.handle('video:screen-confirm', async (e) => {
    const displayId = getOverlayDisplayId(e.sender)
    const allDisplays = screen.getAllDisplays()
    const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

    resetOverlayMode()
    closeAllOverlays()
    await waitForOverlayGone()

    const sourceId = await resolveScreenSourceId(display.id)
    if (!sourceId) { showMain(); return }

    openRecordingSession({
      kind: 'screen',
      sourceId,
      displayId: display.id,
      displayDipSize: { width: display.size.width, height: display.size.height },
      displayScaleFactor: display.scaleFactor || 1,
    })
  })

  // Overlay ESC or bail-out
  ipcMain.handle('video:cancel', () => {
    resetOverlayMode()
    closeAllOverlays()
    restoreFromOverlayCancel()
  })

  // ── RecorderHost ↔ Toolbar forwarding ───────────────────────────────────

  // RecorderHost fetches its target on load
  ipcMain.handle('recorder:get-target', () => recordingTarget)

  // Logo dataURL for the watermark composited onto every recorded frame.
  // Shipped on demand (not bundled in the renderer) because the asset lives
  // under resources/ and is reachable only from the main process.
  ipcMain.handle('recorder:get-watermark', () => getWatermarkLogoDataUrl())

  // RecorderHost reports readiness (stream acquired or error)
  ipcMain.handle('recorder:ready', (_e, ok: boolean, error?: string, micAvailable?: boolean) => {
    if (!ok) {
      sendToToolbar('toolbar:state', { phase: 'error', error: error ?? 'Unable to start capture' })
      // Stream acquisition failed (permission denied, source vanished). Nothing
      // recovers this session — auto-dismiss after a beat so the host/toolbar
      // windows don't wedge isRecordingActive() true forever, which would
      // disable every recording hotkey until the app is restarted.
      setTimeout(() => { closeRecordingSession(); showMain() }, 3000)
      return
    }
    // Kick off countdown in toolbar. Forward whether a mic track was actually
    // acquired so the toolbar can disable the mic toggle (otherwise it shows a
    // "live" mic while no audio is being captured).
    sendToToolbar('toolbar:state', { phase: 'countdown', countdown: 3, micAvailable: micAvailable ?? false })
  })

  // Toolbar countdown finished → tell host to begin MediaRecorder
  ipcMain.handle('toolbar:begin', () => {
    recordingBegun = true
    sendToHost('recorder:begin')
    sendToToolbar('toolbar:state', { phase: 'recording', elapsedMs: 0 })
  })

  ipcMain.handle('toolbar:pause', () => {
    sendToHost('recorder:pause')
    sendToToolbar('toolbar:state', { phase: 'paused' })
  })
  ipcMain.handle('toolbar:resume', () => {
    sendToHost('recorder:resume')
    sendToToolbar('toolbar:state', { phase: 'recording' })
  })
  ipcMain.handle('toolbar:stop', () => {
    // Stop pressed before MediaRecorder began (during the countdown): there's
    // nothing to finalize, so treat it as a cancel instead of leaving the
    // session stuck in 'stopping' while the countdown still fires begin.
    if (!recordingBegun) { closeRecordingSession(); showMain(); return }
    sendToHost('recorder:stop-request')
    sendToToolbar('toolbar:state', { phase: 'stopping' })
  })
  ipcMain.handle('toolbar:cancel', () => {
    sendToHost('recorder:cancel-request')
    closeRecordingSession()
    showMain()
  })
  // Renderer-driven hover hit-test: capture clicks while the cursor is over
  // a pill, otherwise pass them through to the recorded app (and the
  // annotation overlay if active). Sent on transition only, so traffic is
  // bounded to a few messages per pill enter/leave.
  ipcMain.on('toolbar:set-interactive', (_e, interactive: boolean) => {
    if (!recordingToolbar || recordingToolbar.isDestroyed()) return
    if (interactive) {
      recordingToolbar.setIgnoreMouseEvents(false)
    } else {
      recordingToolbar.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  ipcMain.handle('toolbar:toggle-mic', (_e, enabled: boolean) => {
    sendToHost('recorder:mic-toggle', enabled)
    // Echo only the mic state — no phase. Toggling mid-countdown must not
    // flip the toolbar to 'recording' before MediaRecorder actually starts.
    sendToToolbar('toolbar:state', { micEnabled: enabled })
  })

  // Live annotation overlay — opens a transparent canvas on the recording
  // display so the user can draw on screen during the recording. The tool
  // palette itself lives in the recording toolbar window (second pill row,
  // shown when annotationOn). Drawings are captured naturally by
  // desktopCapturer (the overlay is intentionally NOT content-protected).
  ipcMain.handle('toolbar:toggle-annotation', (_e, enabled: boolean) => {
    if (enabled) {
      if (!recordingTarget) return
      if (isAnnotationOpen()) return
      // Hand the recording toolbar + border to annotation. After the
      // overlay is created, annotation forces these windows back to the
      // top of the OS topmost-stack via SetWindowPos(HWND_TOPMOST), which
      // re-raises an already-topmost window even when setAlwaysOnTop /
      // moveTop don't.
      const topmostAfter: BrowserWindow[] = []
      if (recordingToolbar && !recordingToolbar.isDestroyed()) topmostAfter.push(recordingToolbar)
      if (recordingBorder && !recordingBorder.isDestroyed()) topmostAfter.push(recordingBorder)
      openAnnotation(recordingTarget.displayId, topmostAfter)
    } else {
      closeAnnotation()
    }
    sendToToolbar('toolbar:state', { annotationOn: enabled })
  })

  // RecorderHost reports state changes (including tick)
  ipcMain.handle('recorder:tick', (_e, elapsedMs: number) => {
    // No phase here — a tick that was already in flight when the user hit
    // Pause must not flip the toolbar back to 'recording'. The toolbar keeps
    // its current phase for phase-less updates.
    sendToToolbar('toolbar:state', { elapsedMs })
  })
  ipcMain.handle('recorder:state', (_e, state: string, payload?: unknown) => {
    sendToToolbar('toolbar:state', { phase: state as any, ...(payload as any || {}) })
  })

  // ── Streamed save (replaces the old single recorder:save-blob) ───────────
  // The recorder host forwards the finished webm to disk in bounded slices so
  // a long (multi-GB) recording never has to materialize one contiguous
  // ArrayBuffer in the renderer or structured-clone it across IPC.

  ipcMain.handle('recorder:save-begin', async () => {
    const { createWriteStream } = await import('fs')
    const { mkdir } = await import('fs/promises')
    // Originals (images + videos) live in a single fixed location. The user's
    // Save-As dialog path is a separate concern — it never touches this folder.
    await mkdir(ORIGINALS_DIR, { recursive: true })
    // Tear down any half-open stream from a previous aborted save.
    if (recordingWriteStream) { try { recordingWriteStream.destroy() } catch { /* ignore */ } }
    const ts = localTimestamp()
    const filename = `recording-${ts}.webm`
    recordingSaveFilePath = join(ORIGINALS_DIR, filename)
    recordingSaveBytes = 0
    recordingWriteStream = createWriteStream(recordingSaveFilePath)
    return { ok: true }
  })

  ipcMain.handle('recorder:save-chunk', async (_e, chunk: ArrayBuffer) => {
    const stream = recordingWriteStream
    if (!stream) throw new Error('No active recording write stream')
    const buf = Buffer.from(chunk)
    recordingSaveBytes += buf.byteLength
    // Respect backpressure: resolve only once the write drains (or errors).
    await new Promise<void>((resolve, reject) => {
      stream.write(buf, (err) => err ? reject(err) : resolve())
    })
    return { ok: true }
  })

  ipcMain.handle('recorder:save-end', async (_e, thumbnailDataUrl: string, durationMs: number) => {
    const stream = recordingWriteStream
    const filePath = recordingSaveFilePath
    const bytes = recordingSaveBytes
    recordingWriteStream = null
    recordingSaveFilePath = null
    recordingSaveBytes = 0
    try {
      if (!stream || !filePath) throw new Error('No active recording to finalize')
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject)
        stream.end(() => resolve())
      })
      if (bytes === 0) {
        throw new Error('Recording produced no data (stopped before any frames were captured?)')
      }

      // Make the recording seekable. MediaRecorder writes a streaming WebM with
      // no Cues/Duration, so the scrubber is dead in every player until we
      // rebuild the container. ffmpeg -c copy does this losslessly and streams
      // from disk (flat memory at any file size). On failure the original is
      // kept — it still plays, just may not seek.
      const seekable = await remuxWebmInPlace(filePath)
      if (!seekable) console.warn('[video] seekable remux skipped/failed — recording saved as-is')

      const { historyId } = await recordHistoryAndNotify(filePath, thumbnailDataUrl, durationMs)
      sendToToolbar('toolbar:state', { phase: 'done' })

      // Open the freshly-saved recording in the video annotator (same pattern
      // as screenshots → /editor). Briefly delay so the toolbar shows "Saved"
      // before the main window steals focus.
      //
      // Tray-only mode: user started the recording while the main window was
      // dismissed to the tray. Skip the editor surface — the toast click
      // still leads back here on demand via openHistoryItemInEditor.
      setTimeout(async () => {
        if (isMainDismissed()) {
          closeRecordingSession()
          return
        }
        const main = getMainWindow()
        if (main && !main.isDestroyed()) {
          // Send navigate then wait for the renderer to ack /editor mounted
          // before showing — same reasoning as the screenshot path.
          main.webContents.send('navigate', '/editor', {
            kind: 'video',
            filePath,
            name: basename(filePath),
            historyId,
          })
          await waitForViewMounted('/editor')
          if (!main.isDestroyed()) { main.show(); main.focus() }
        }
        closeRecordingSession()
      }, 600)
      return { filePath }
    } catch (err: any) {
      try { stream?.destroy() } catch { /* ignore */ }
      sendToToolbar('toolbar:state', { phase: 'error', error: err?.message ?? String(err) })
      setTimeout(() => { closeRecordingSession(); showMain() }, 1500)
      throw err
    }
  })
}

// Exported for external callers (e.g. hotkey stop-request)
export function requestStop() {
  if (!isRecordingActive()) return
  // Stop hotkey pressed during the countdown — cancel rather than wedge the
  // toolbar in 'stopping' (the host has no recorder to stop yet).
  if (!recordingBegun) { closeRecordingSession(); showMain(); return }
  sendToHost('recorder:stop-request')
  sendToToolbar('toolbar:state', { phase: 'stopping' })
}

// ── Action IPC: Save / Copy / Upload for an existing video file ──────────

/** Shortest trim we accept — anything below is almost certainly a misclick. */
const MIN_TRIM_MS = 500
/** Free space required on top of the original's size before trimming. */
const DISK_HEADROOM_BYTES = 50 * 1024 * 1024

/** Best-effort delete of a superseded trimmed file. On Windows an open handle
 *  (e.g. an upload still streaming it) makes unlink fail with EBUSY/EPERM, so
 *  retry once later instead of leaving it behind. Bounded to the home dir. */
async function removeTrimmedFile(path: string, retry = true): Promise<void> {
  const target = resolvePath(normalize(path))
  if (!target.startsWith(homedir())) return
  const { unlink } = await import('fs/promises')
  try {
    await unlink(target)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    if (retry) setTimeout(() => { void removeTrimmedFile(path, false) }, 60_000)
    else console.error('[video:trim] could not remove old trimmed file', target, err)
  }
}

export function setupVideoActions() {
  /** Save-As dialog, then copy the recording file to the chosen path. The
   *  original at ~/Pictures/Lumia/ is untouched — this creates a copy. */
  ipcMain.handle('video:save-as', async (_e, filePath: string) => {
    if (!filePath) throw new Error('No video file path')
    const { copyFile } = await import('fs/promises')
    const startDir = await resolveSaveStartDir()
    const defaultPath = join(startDir, basename(filePath))
    const main = getMainWindow()
    const result = main
      ? await dialog.showSaveDialog(main, {
          defaultPath,
          filters: [
            { name: 'WebM Video', extensions: [extname(filePath).replace(/^\./, '') || 'webm'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        })
      : await dialog.showSaveDialog({ defaultPath })
    if (result.canceled || !result.filePath) return { canceled: true }
    await copyFile(filePath, result.filePath)
    rememberSaveDir(dirname(result.filePath))
    return { canceled: false, savedPath: result.filePath }
  })

  /** Copy video FILE to clipboard (not just the path text). Native shell
   *  commands handle the platform-specific clipboard formats so a subsequent
   *  Ctrl+V in Explorer / Finder / Slack / email pastes the actual file. */
  ipcMain.handle('video:copy-file', async (_e, filePath: string) => {
    if (!filePath) throw new Error('No video file path')
    const { execFile } = await import('child_process')
    const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
      execFile(cmd, args, (err) => err ? reject(err) : resolve())
    })
    try {
      if (process.platform === 'win32') {
        // Set-Clipboard -LiteralPath writes CF_HDROP — Explorer / chat apps
        // treat the paste as "file copy" just like Ctrl+C in File Explorer.
        const escaped = filePath.replace(/'/g, "''")
        await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${escaped}'`])
      } else if (process.platform === 'darwin') {
        // AppleScript writes the file reference onto NSPasteboard so Finder
        // and chat clients recognise it as a file, not plain text.
        const escaped = filePath.replace(/"/g, '\\"')
        await run('osascript', ['-e', `tell application "Finder" to set the clipboard to (POSIX file "${escaped}")`])
      } else {
        // Linux: no universal "copy file" clipboard convention. Fall back to
        // the file URL as text, which most file managers accept on paste.
        clipboard.writeText(`file://${filePath}`)
      }
      return { ok: true }
    } catch (err: any) {
      // Fall back to path-as-text if the shell command fails.
      clipboard.writeText(filePath)
      return { ok: true, fallback: 'text', error: err?.message ?? String(err) }
    }
  })

  // ── Trim ──────────────────────────────────────────────────────────────
  // Non-destructive: the original recording is never touched. The trimmed
  // copy is stored in `annotatedFilePath` (same "edited copy" slot images use),
  // so Share / Save-As / Copy / delete cleanup pick it up with no extra wiring.
  // Only ids + numbers + a small thumbnail cross IPC — never file contents.

  ipcMain.handle('video:trim', async (_e, historyId: string, startMs: number, endMs: number, thumbnailDataUrl?: string) => {
    if (typeof historyId !== 'string' || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { ok: false, error: 'Invalid trim request' }
    }
    startMs = Math.max(0, Math.round(startMs))
    endMs = Math.round(endMs)
    if (endMs - startMs < MIN_TRIM_MS) return { ok: false, error: 'Selection is too short' }
    if (isTrimRunning()) return { ok: false, error: 'Another trim is already running' }

    const store = getHistoryStore()
    const item = store?.getAll().find(i => i.id === historyId)
    if (!store || !item) return { ok: false, error: 'Recording not found' }
    if (item.type !== 'recording' || !item.filePath) return { ok: false, error: 'Not a recording' }
    const original = resolvePath(normalize(item.filePath))
    if (!original.startsWith(homedir())) return { ok: false, error: 'Access denied' }

    const { stat, statfs } = await import('fs/promises')
    let originalSize: number
    try {
      originalSize = (await stat(original)).size
    } catch {
      return { ok: false, error: 'Original recording is missing on disk' }
    }
    // The trimmed copy is at most the size of the original. Refuse up front
    // rather than fill the disk and fail half-way.
    try {
      const fsInfo = await statfs(dirname(original))
      const free = Number(fsInfo.bavail) * Number(fsInfo.bsize)
      if (free < originalSize + DISK_HEADROOM_BYTES) return { ok: false, error: 'Not enough free disk space to trim' }
    } catch { /* statfs unsupported here — let ffmpeg report a real failure */ }

    // Fresh name per trim: the previous trimmed file may still be held open
    // (an upload streaming it, Explorer preview) and Windows can't replace an
    // open file. The old one is removed after the new one is in place.
    const ext = extname(original) || '.webm'
    const stem = basename(original, ext)
    const dst = join(dirname(original), `${stem}-trimmed-${Date.now().toString(36)}${ext}`)

    const res = await trimWebm(original, dst, startMs, endMs)
    if (!res.ok) return { ok: false, error: res.error ?? 'Trim failed' }

    // Where the cut really starts: output length minus what was asked for is
    // how far back the keyframe snap went.
    const requested = endMs - startMs
    const snapMs = res.outputDurationMs != null ? Math.max(0, res.outputDurationMs - requested) : 0
    const actualStartMs = Math.max(0, startMs - snapMs)

    const fresh = store.getAll().find(i => i.id === historyId) ?? item
    const updated = store.update(historyId, {
      annotatedFilePath: dst,
      trim: { startMs, endMs, actualStartMs },
      // Cached links point at the untrimmed file — drop them so the next
      // Share uploads the trimmed clip and returns a new link.
      uploads: [],
      thumbnailFile: writeThumbnailFromDataUrl(historyId, thumbnailDataUrl, fresh.thumbnailFile) ?? fresh.thumbnailFile,
    })
    if (fresh.annotatedFilePath && fresh.annotatedFilePath !== dst) void removeTrimmedFile(fresh.annotatedFilePath)
    return { ok: true, item: updated && resolveThumbnailUrl(updated) }
  })

  ipcMain.handle('video:clear-trim', async (_e, historyId: string, thumbnailDataUrl?: string) => {
    const store = getHistoryStore()
    const item = store?.getAll().find(i => i.id === historyId)
    if (!store || !item) return { ok: false, error: 'Recording not found' }
    if (item.type !== 'recording') return { ok: false, error: 'Not a recording' }
    const updated = store.update(historyId, {
      annotatedFilePath: undefined,
      trim: undefined,
      uploads: [],
      thumbnailFile: writeThumbnailFromDataUrl(historyId, thumbnailDataUrl, item.thumbnailFile) ?? item.thumbnailFile,
    })
    if (item.annotatedFilePath) void removeTrimmedFile(item.annotatedFilePath)
    return { ok: true, item: updated && resolveThumbnailUrl(updated) }
  })

  /** Upload the raw video file to R2. Content-addressable key keeps uploads
   *  idempotent (same bytes → same URL). */
  ipcMain.handle('video:upload-r2', async (_e, filePath: string) => {
    if (!filePath) throw new Error('No video file path')
    try {
      const ext = extname(filePath).replace(/^\./, '').toLowerCase() || 'webm'
      const contentType = ext === 'mp4' ? 'video/mp4' : 'video/webm'
      const res = await uploadFileToR2(
        filePath,
        { contentType, ext, keyPrefix: 'recordings' },
        import.meta.env.MAIN_VITE_R2_ACCOUNT_ID,
        import.meta.env.MAIN_VITE_R2_ACCESS_KEY_ID,
        import.meta.env.MAIN_VITE_R2_SECRET_ACCESS_KEY,
        import.meta.env.MAIN_VITE_R2_BUCKET,
        import.meta.env.MAIN_VITE_R2_PUBLIC_URL,
      )
      if (res.success && res.url) {
        clipboard.writeText(res.url)
      }
      return res
    } catch (err: any) {
      return { destination: 'r2', success: false, error: err?.message ?? String(err) }
    }
  })

  /** Upload the raw video file to Google Drive via resumable upload. Same
   *  shape as the R2 handler so the editor can dispatch generically. */
  ipcMain.handle('video:upload-google-drive', async (_e, filePath: string) => {
    if (!filePath) throw new Error('No video file path')
    try {
      const ext = extname(filePath).replace(/^\./, '').toLowerCase() || 'webm'
      const contentType = ext === 'mp4' ? 'video/mp4' : 'video/webm'
      const filename = basename(filePath)
      const res = await uploadFilePathToDrive(filePath, contentType, filename)
      if (res.success && res.url) {
        clipboard.writeText(res.url)
      }
      return res
    } catch (err: any) {
      return { destination: 'google-drive', success: false, error: err?.message ?? String(err) }
    }
  })

  // `homedir` is re-exported from the module namespace for potential future
  // use (fallback save dir, etc.). Silence unused-import lint until needed.
  void homedir
}

// Exported so hotkeys / tray can launch mode selection directly
export async function startVideoCapture(mode: 'region' | 'window' | 'screen') {
  if (isRecordingActive()) return
  const overlayMode =
    mode === 'region' ? 'video-region' :
    mode === 'window' ? 'video-window' : 'video-screen'
  setOverlayMode(overlayMode)
  await hideMain()

  // Exactly one app window showing → nothing to choose between; skip the
  // picker and start recording it directly.
  if (mode === 'window') {
    const single = await getSinglePickTarget(getSettings().captureSelfWindow)
    if (single) {
      await beginWindowRecording(single.rect, single.displayId)
      return
    }
  }

  createOverlayWindows()
}

