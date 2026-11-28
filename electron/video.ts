import { captureBarTop } from '../shared/capture-bar'
import { resolveCaptureSource, globalRect } from './capture-source'
import type { CaptureSource } from './types'
import { BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, screen } from 'electron'
import { basename, dirname, extname, join, normalize, resolve as resolvePath } from 'path'
import { createWriteStream, type WriteStream } from 'fs'
import { copyFile, mkdir, stat, statfs, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import {
  getMainWindow,
  getHistoryStore,
  closeAllOverlays,
  createOverlayWindows,
  getOverlayDisplayId,
  restoreFromOverlayCancel,
  prepareMainOnRoute,
  openHistoryItemInEditor,
  claimEditorAfterCapture,
  returnFocusToPreviousApp,
  activateForRecording,
  useFullTheme,
} from './index'
import { clearFrozenCache, HIDE_DELAY_MS } from './capture'
import { captureFolder, isAllowedPath, OUTSIDE_FOLDERS } from './capture-folder'
import { uploadFileToR2 } from './uploaders/r2'
import { uploadFilePathToDrive } from './google-drive-service'
import { resetOverlayMode, setOverlayMode } from './scroll-capture'
import { showNotification } from './notify'
import { getSettings, resolveSaveStartDir, rememberSaveDir } from './settings'
import { localTimestamp } from './utils'
import { loadRoute } from './load-route'
import { recordingFps } from '../shared/recording'
import { writeThumbnailFromDataUrl, resolveThumbnailUrl, writeStripFromDataUrl } from './thumbnail'
import { openAnnotation, closeAnnotation, destroyAnnotation, isAnnotationOpen, setupAnnotation } from './annotation'
import { forceWindowsExcludeFromCapture, focusOwnWindowForeground } from './native-input'
import { getSinglePickTarget } from './window-list'
import { getWatermarkMarks } from './watermark'
import { remuxWebmInPlace, trimWebm, isTrimRunning, probeWebmDurationMs } from './ffmpeg-remux'
import { formatDuration } from '../src/utils/captureLabels'

/** One `[record-trace]` line per recording start (2026-11-24): ms since the
 *  pick in the overlay to each step, up to the toolbar (with its countdown)
 *  showing. Like `[capture-trace]` for images. */
let recT0 = 0
let recMarks: string[] = []
function recTraceBegin(kind: string) { recT0 = performance.now(); recMarks = [kind] }
function recMark(name: string) {
  if (!recT0) return
  recMarks.push(`${name} ${Math.round(performance.now() - recT0)}`)
  if (name === 'toolbar shown') { console.log(`[record-trace] ${recMarks.join(' · ')}`); recT0 = 0 }
}

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
/** The countdown runs while the recorder host acquires its stream
 *  (2026-11-24: the toolbar waited ~1s empty for it). `hostReady`: the
 *  stream is there; `beginWanted`: the countdown ended first, so recording
 *  starts the moment the stream is ready. */
let hostReady = false
let beginWanted = false

// Streamed save state: the finished webm is forwarded from the recorder host
// to disk in bounded slices (save-begin → save-chunk* → save-end) rather than
// one multi-GB ArrayBuffer over IPC, which OOM'd the renderer and could blow
// the structured-clone limit on long recordings.
let recordingWriteStream: WriteStream | null = null
let recordingSaveFilePath: string | null = null
let recordingSaveBytes = 0

/** Drop a recording file that never became a recording (a save cancelled
 *  or failed part-way, or one without data): close its stream, then delete
 *  it. Left in the save folder it would be taken for a recording of its own
 *  the next time the folder is read (folder-history.ts scanForNewFiles). */
function discardPartialRecording(stream: WriteStream | null, filePath: string | null) {
  const remove = () => { if (filePath) void unlink(filePath).catch(() => { /* never written, or already gone */ }) }
  // After 'close': Windows can't delete a file that is still open.
  if (stream && !stream.closed) {
    stream.once('close', remove)
    try { stream.destroy() } catch { remove() }
  } else {
    remove()
  }
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

/** After a recording ends without a file (cancelled, failed to start,
 *  crashed): the same as cancelling the capture overlay (2026-11-24). The
 *  window comes back if it was open; closed to the menu bar it stays
 *  there, with focus back on the previous app (it used to show either way). */
function showMain() {
  restoreFromOverlayCancel()
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

/** Screen source ids per display, fetched when a video pick opens so the
 *  pick's confirm doesn't wait for desktopCapturer (2026-11-24: ~90ms after
 *  a fixed 120ms wait, before the toolbar could even be created). Screen
 *  ids don't change while the displays don't. */
let screenSourceIds: Promise<Map<number, string>> | null = null
let displayWatch = false
function prefetchScreenSourceIds() {
  // A display added or removed drops the ids (registered here, not at load:
  // `screen` isn't usable before the app is ready).
  if (!displayWatch) {
    displayWatch = true
    screen.on('display-added', () => { screenSourceIds = null })
    screen.on('display-removed', () => { screenSourceIds = null })
  }
  const displays = screen.getAllDisplays()
  screenSourceIds = Promise.all(displays.map(async d => [d.id, await resolveScreenSourceId(d.id)] as const))
    .then(pairs => new Map(pairs))
  screenSourceIds.catch(() => { screenSourceIds = null })
}
/** The display's screen source id: from the prefetch, else fetched now (a
 *  pick switched from Image to Video had no prefetch). */
async function screenSourceIdFor(displayId: number): Promise<string> {
  const cached = await (screenSourceIds ?? Promise.resolve(null)).catch(() => null)
  return cached?.get(displayId) || resolveScreenSourceId(displayId)
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
 *   - macOS: AppKit constrains a window's frame to the visible area of a
 *     screen when it comes on screen (keeps its top below the menu bar, may
 *     shove it onto the screen it mostly overlaps). The window's level does
 *     not lift that (2026-11-27, measured: a screen-saver-level window still
 *     landed at the menu bar's bottom, and a second setBounds didn't move
 *     it); `enableLargerThanScreen` on a frameless window does, so every
 *     recording window is created with it.
 *  Bounds are still re-applied once the level is set and again at first
 *  show, and a mismatch afterwards is logged for diagnosis. */
function pinBounds(win: BrowserWindow, bounds: Rect, label?: string) {
  if (win.isDestroyed()) return
  win.setBounds(bounds)
  if (!label) return
  const got = win.getBounds()
  if (got.x !== bounds.x || got.y !== bounds.y || got.width !== bounds.width || got.height !== bounds.height) {
    console.warn(`[video] ${label} bounds mismatch — wanted ${JSON.stringify(bounds)} got ${JSON.stringify(got)}`)
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

/** The toolbar's bar sits 6px inside its window (pt-1.5 in
 *  RecordingToolbar.tsx): the window's top is that much above the bar's. */
const TOOLBAR_BAR_INSET = 6

function computeToolbarBounds(display: Electron.Display, _rect?: { x: number; y: number; width: number; height: number }) {
  // Always where the capture overlay's bar was (2026-11-24): centred, at the
  // same height under the top of the recorded display, whatever the area.
  // That height is the overlay's own (captureBarTop: the menu bar's bottom
  // edge on macOS, 2026-11-27; a fixed 32px before). It was placed above (or
  // inside) the recorded area, so it showed up somewhere new each time.
  // Content protection keeps it out of the recording either way.
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - TOOLBAR_W) / 2),
    y: display.bounds.y + captureBarTop(display, process.platform) - TOOLBAR_BAR_INSET,
    width: TOOLBAR_W,
    height: TOOLBAR_H,
  }
}

function computeBorderBounds(display: Electron.Display, rect: { x: number; y: number; width: number; height: number }, stroke = 2) {
  // `stroke` = RECORDING_BORDER_WIDTH in RecordingBorder.tsx (2px since
  // 2026-11-24). Inflate by it so the outline sits just outside the recorded
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

/** The toolbar window, loaded but not shown (2026-11-24): built while the
 *  Video overlay is open, so the pick only has to place and show it and the
 *  countdown is there at once (building it after the pick took ~200ms). */
let prewarmedToolbar: { win: BrowserWindow; ready: boolean } | null = null
/** Toolbars shown so far (webContents ids): a page that starts listening
 *  after its show missed the countdown signal and asks (toolbar:is-shown). */
const shownToolbars = new Set<number>()

/** Create the toolbar window (hidden) and load its page. */
function buildToolbarWindow(bounds: { x: number; y: number; width: number; height: number }): BrowserWindow {
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
    // macOS keeps a window's top below the menu bar when it comes on screen
    // unless a frameless window has this (2026-11-27: without it the toolbar
    // landed at the menu bar's bottom, y 30 for the wanted 26, so its bar sat
    // 4px lower than the overlay's; measured on both displays). The capture
    // overlay, the border and the drawing layer have it too.
    enableLargerThanScreen: true,
    // Shown by showToolbar, after the first paint (transparent windows
    // flash white on Windows before the body becomes see-through).
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
  win.setMenu(null)
  // screen-saver is the highest Z level available — stays above fullscreen
  // apps, browser fullscreen video, games, etc. Together with the
  // visibleOnFullScreen flag this keeps the Stop button reachable no matter
  // what the user is recording. relativeLevel:1 keeps this above the
  // annotation overlay (which sits at plain screen-saver) on macOS without
  // a moveTop race — the OS enforces the ordering.
  win.setAlwaysOnTop(true, 'screen-saver', 1)
  // skipTransformProcessType (2026-11-24): without it Electron briefly
  // switches the whole app's process type on macOS, which took activation
  // from Lumia (the countdown lost focus) and confused the Dock state.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Not a window the user manages: keep it out of Mission Control / Exposé.
  if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
  // Level is raised now — re-pin (see pinBounds for why the constructor's
  // x/y can't be trusted on mixed-DPI Windows / multi-display macOS).
  pinBounds(win, bounds)
  // First call here so the protection bit is set before any paint reaches
  // the screen — showToolbar re-applies it once the window is realised
  // because that's the only point Windows reliably honours it.
  win.setContentProtection(true)
  useFullTheme(win.webContents)
  loadRoute(win, '/recording-toolbar')
  return win
}

/** Place the toolbar, show it and start its countdown. */
function showToolbar(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }) {
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
  // The page already shows "Starting in 3"; this starts the count.
  const wcId = win.webContents.id
  shownToolbars.add(wcId)
  win.once('closed', () => shownToolbars.delete(wcId))
  win.webContents.send('toolbar:state', { phase: 'countdown', countdown: getSettings().recordCountdown })
  // Shown with focus for the countdown, so Esc cancels it (2026-11-24); the
  // recorded app gets it back when the countdown ends (beginRecording).
  win.showInactive()
  activateForRecording()
  win.focus()
  // The page too: shown without focus first, the window can be key while its
  // page still gets no keys.
  win.webContents.focus()
  if (process.platform === 'win32') focusOwnWindowForeground(win)
  recMark('toolbar shown')
  win.setContentProtection(true)
  forceWindowsExcludeFromCapture(win)
  // After show: AppKit may constrain the frame again on order-in.
  pinBounds(win, bounds, 'toolbar')
}

/** Get a video pick ready while the user picks: the screen ids and the
 *  toolbar. Also when the capture overlay switches from Image to Video. */
export function prepareVideoPick() {
  prefetchScreenSourceIds()
  prewarmRecordingToolbar()
}

/** Build the toolbar ahead, on the display under the pointer (moved at the
 *  pick if that's another one). Kept for the next pick if this one doesn't
 *  record (an Image capture after switching). */
export function prewarmRecordingToolbar() {
  if (prewarmedToolbar && !prewarmedToolbar.win.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const win = buildToolbarWindow(computeToolbarBounds(display))
  const entry = { win, ready: false }
  win.once('ready-to-show', () => { entry.ready = true })
  win.on('closed', () => { if (prewarmedToolbar?.win === win) prewarmedToolbar = null })
  prewarmedToolbar = entry
}

function dropPrewarmedToolbar() {
  const pre = prewarmedToolbar
  prewarmedToolbar = null
  if (pre && !pre.win.isDestroyed()) pre.win.destroy()
}

function createRecordingToolbar(display: Electron.Display, rect?: { x: number; y: number; width: number; height: number }) {
  recMark('toolbar created')
  const bounds = computeToolbarBounds(display, rect)
  const pre = prewarmedToolbar && !prewarmedToolbar.win.isDestroyed() ? prewarmedToolbar : null
  prewarmedToolbar = null
  const win = pre ? pre.win : buildToolbarWindow(bounds)
  win.on('closed', () => { recordingToolbar = null })
  recordingToolbar = win
  if (pre?.ready) showToolbar(win, bounds)
  else win.once('ready-to-show', () => showToolbar(win, bounds))
  return win
}

function createRecordingBorder(display: Electron.Display, rect: { x: number; y: number; width: number; height: number }) {
  const bounds = computeBorderBounds(display, rect)
  const win = new BrowserWindow({
    ...bounds,
    // macOS rounds a frameless window's corners by default, which masked
    // the border's corner dashes away (2026-11-24).
    roundedCorners: false,
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
  // skipTransformProcessType (2026-11-24): without it Electron briefly
  // switches the whole app's process type on macOS, which took activation
  // from Lumia (the countdown lost focus) and confused the Dock state.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Not a window the user manages: keep it out of Mission Control / Exposé.
  if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
  // Level is raised now — re-pin (a border flush with the top edge of an
  // external display is otherwise pushed below its menu bar on macOS).
  pinBounds(win, bounds)
  win.setIgnoreMouseEvents(true, { forward: false })
  win.setContentProtection(true)
  useFullTheme(win.webContents)
  loadRoute(win, '/recording-border')
  win.on('closed', () => { recordingBorder = null })
  recordingBorder = win
  return win
}

/** The app + window under the recorded area (capture-source.ts), looked up
 *  when the session opens and written to the history row when it's saved. */
let recordingSource: Promise<CaptureSource | undefined> | null = null
let recordingMode: 'region' | 'window' | 'screen' | null = null

function openRecordingSession(target: RecordingTarget) {
  // Lumia stays active through the countdown (Esc cancels it there); the
  // recorded app gets focus back when the countdown ends (beginRecording).
  recordingTarget = target
  recordingBegun = false
  hostReady = false
  beginWanted = false
  const allDisplays = screen.getAllDisplays()
  const display = allDisplays.find(d => d.id === target.displayId) ?? screen.getPrimaryDisplay()
  // A window recording records where it came from; region / screen
  // recordings only when they show a single window (else just their kind).
  recordingSource =
    target.kind === 'window' && target.rect ? resolveCaptureSource({ rect: globalRect(target.rect, target.displayId) })
    : target.kind === 'region' && target.rect ? resolveCaptureSource({ rect: globalRect(target.rect, target.displayId) }, { onlyIfSingle: true })
    : target.kind === 'screen' ? resolveCaptureSource({ display }, { onlyIfSingle: true })
    : null
  recordingMode = target.kind

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

function beginRecording() {
  beginWanted = false
  recordingBegun = true
  // Countdown over: focus back to the app being recorded.
  returnFocusToPreviousApp()
  if (process.platform !== 'darwin' && recordingToolbar && !recordingToolbar.isDestroyed()) recordingToolbar.blur()
  sendToHost('recorder:begin')
  sendToToolbar('toolbar:state', { phase: 'recording', elapsedMs: 0 })
}

export function closeRecordingSession() {
  recordingTarget = null
  recordingBegun = false
  hostReady = false
  beginWanted = false
  // Tear down any half-open save stream (e.g. cancel during finalize) so a
  // dangling fd / partial file doesn't leak into the next session.
  if (recordingWriteStream) {
    discardPartialRecording(recordingWriteStream, recordingSaveFilePath)
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
  fps: number,
  stripDataUrl?: string,
): Promise<{ filePath: string; historyId?: string }> {
  const filename = basename(filePath)

  // History entry. Capture the id so the editor can pass it through to
  // runWorkflow — without it, a follow-up Upload R2 lands in the "no
  // historyId" branch and creates a duplicate entry.
  let historyId: string | undefined
  const historyStore = getHistoryStore()
  if (historyStore) {
    const id: string = randomUUID()
    // The file's own Duration header (written by the remux) is the real
    // length; the recorder's clock is the fallback.
    const fileMs = await probeWebmDurationMs(filePath)
    historyStore.add({
      id,
      timestamp: Date.now(),
      name: filename,
      filePath,
      thumbnailFile: writeThumbnailFromDataUrl(id, thumbnailDataUrl),
      // The filmstrip the recorder collected (absent if it sent none: the
      // editor then decodes one).
      stripFile: writeStripFromDataUrl(id, stripDataUrl),
      type: 'recording',
      source: recordingSource ? await recordingSource : undefined,
      captureMode: recordingMode ?? undefined,
      uploads: [],
      durationMs: fileMs ?? Math.round(durationMs),
      fps,
    })
    historyId = id
  }

  showNotification({
    body: `Video recorded (${formatDuration(durationMs)})`,
    thumbnailDataUrl,
    onClick: historyId ? () => { void openHistoryItemInEditor(historyId!) } : undefined,
    launchId: historyId ?? undefined,
  })

  return { filePath, historyId }
}

/** A recording that couldn't start (no screen source, a window that
 *  wouldn't open): end the session as a cancel would and say so
 *  (2026-11-27; a rejected start left the main window hidden, nothing said). */
function failRecordingStart(err: unknown) {
  console.error('[video] could not start recording', err)
  dropPrewarmedToolbar()
  resetOverlayMode()
  closeAllOverlays()
  clearFrozenCache()
  closeRecordingSession()
  showMain()
  showNotification({ body: `Couldn't start recording\n${err instanceof Error ? err.message : String(err)}`, kind: 'error' })
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

  recTraceBegin('window')
  resetOverlayMode()
  closeAllOverlays()
  clearFrozenCache()
  try {
    // No wait for the overlay to go: nothing is recorded before the
    // countdown ends.
    const sourceId = await screenSourceIdFor(display.id)
    recMark('source')
    if (!sourceId) throw new Error('No screen source')

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
  } catch (err) {
    failRecordingStart(err)
  }
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

    recTraceBegin('region')
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    try {
      // No wait for the overlay to go: nothing is recorded before the
      // countdown ends.
      const sourceId = await screenSourceIdFor(display.id)
      recMark('source')
      if (!sourceId) throw new Error('No screen source')

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
    } catch (err) {
      failRecordingStart(err)
    }
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

    recTraceBegin('screen')
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    try {
      // No wait for the overlay to go: nothing is recorded before the
      // countdown ends.
      const sourceId = await screenSourceIdFor(display.id)
      recMark('source')
      if (!sourceId) throw new Error('No screen source')

      openRecordingSession({
        kind: 'screen',
        sourceId,
        displayId: display.id,
        displayDipSize: { width: display.size.width, height: display.size.height },
        displayScaleFactor: display.scaleFactor || 1,
      })
    } catch (err) {
      failRecordingStart(err)
    }
  })

  // Overlay ESC or bail-out
  ipcMain.handle('video:cancel', () => {
    dropPrewarmedToolbar()
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    restoreFromOverlayCancel()
  })

  // ── RecorderHost ↔ Toolbar forwarding ───────────────────────────────────

  // RecorderHost fetches its target on load
  ipcMain.handle('recorder:get-target', () => recordingTarget)

  // Logo dataURL for the watermark composited onto every recorded frame.
  // Shipped on demand (not bundled in the renderer) because the asset lives
  // under resources/ and is reachable only from the main process.
  ipcMain.handle('recorder:get-watermark', () => getWatermarkMarks())

  // RecorderHost reports readiness (stream acquired or error)
  ipcMain.handle('recorder:ready', (_e, ok: boolean, error?: string, micAvailable?: boolean) => {
    if (!ok) {
      sendToToolbar('toolbar:state', { phase: 'error', error: error ?? 'Unable to start recording' })
      // Stream acquisition failed (permission denied, source vanished). Nothing
      // recovers this session — auto-dismiss after a beat so the host/toolbar
      // windows don't wedge isRecordingActive() true forever, which would
      // disable every recording hotkey until the app is restarted.
      setTimeout(() => { closeRecordingSession(); showMain() }, 3000)
      return
    }
    // The toolbar started its countdown when it opened; tell it whether a
    // mic track was actually acquired so it can disable the mic toggle
    // (otherwise it shows a "live" mic while no audio is being captured).
    hostReady = true
    sendToToolbar('toolbar:state', { micAvailable: micAvailable ?? false })
    if (beginWanted) beginRecording()
  })

  // Toolbar countdown finished → tell host to begin MediaRecorder (or as
  // soon as its stream is ready, if the countdown was quicker).
  ipcMain.handle('toolbar:is-shown', (e) => shownToolbars.has(e.sender.id))

  ipcMain.handle('toolbar:begin', () => {
    if (!hostReady) { beginWanted = true; return }
    beginRecording()
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
    // Originals (images + videos) live in a single fixed location. The user's
    // Save-As dialog path is a separate concern — it never touches this folder.
    await mkdir(captureFolder(), { recursive: true })
    // Tear down any half-open stream from a previous aborted save.
    if (recordingWriteStream) discardPartialRecording(recordingWriteStream, recordingSaveFilePath)
    const ts = localTimestamp()
    const filename = `recording-${ts}.webm`
    recordingSaveFilePath = join(captureFolder(), filename)
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

  ipcMain.handle('recorder:save-end', async (_e, thumbnailDataUrl: string, durationMs: number, rawFps?: number, stripDataUrl?: string) => {
    // The rate the recorder ran at, kept on the row for the editor's frame step.
    const fps = recordingFps(rawFps)
    const stream = recordingWriteStream
    const filePath = recordingSaveFilePath
    const bytes = recordingSaveBytes
    recordingWriteStream = null
    recordingSaveFilePath = null
    recordingSaveBytes = 0
    // The file holds a whole recording: from here on a failure keeps it.
    let written = false
    try {
      if (!stream || !filePath) throw new Error('No active recording to finalize')
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject)
        stream.end(() => resolve())
      })
      if (bytes === 0) {
        throw new Error('Recording produced no data (stopped before any frames were captured?)')
      }
      written = true

      // Make the recording seekable. MediaRecorder writes a streaming WebM with
      // no Cues/Duration, so the scrubber is dead in every player until we
      // rebuild the container. ffmpeg -c copy does this losslessly and streams
      // from disk (flat memory at any file size). On failure the original is
      // kept — it still plays, just may not seek.
      const seekable = await remuxWebmInPlace(filePath)
      if (!seekable) console.warn('[video] seekable remux skipped/failed — recording saved as-is')

      // Decided before the "Video recorded" message, so it's the in-app
      // toast when the editor is about to open (claimEditorAfterCapture).
      const openEditor = claimEditorAfterCapture('video')
      const { historyId } = await recordHistoryAndNotify(filePath, thumbnailDataUrl, durationMs, fps, typeof stripDataUrl === 'string' ? stripDataUrl : undefined)
      sendToToolbar('toolbar:state', { phase: 'done' })

      // Open the freshly-saved recording in the video annotator (same pattern
      // as screenshots → /editor). Briefly delay so the toolbar shows "Saved"
      // before the main window steals focus.
      //
      // Tray-only mode: user started the recording while the main window was
      // dismissed to the tray, and Open editor after every capture is off.
      // Skip the editor surface — the toast click still leads back here on
      // demand via openHistoryItemInEditor.
      setTimeout(async () => {
        if (!openEditor) {
          closeRecordingSession()
          // No editor: the window stays away (closed before, or Never) and
          // focus goes back to the app in front before.
          restoreFromOverlayCancel()
          return
        }
        const main = getMainWindow()
        if (main && !main.isDestroyed()) {
          // Navigate, and show once the editor is on screen — same as the
          // capture path (prepareMainOnRoute: no Dashboard flash).
          await prepareMainOnRoute('/editor', () => main.webContents.send('navigate', '/editor', {
            kind: 'video',
            filePath,
            name: basename(filePath),
            historyId,
            fps,
          }))
          if (!main.isDestroyed()) { main.show(); main.focus() }
        }
        closeRecordingSession()
      }, 600)
      return { filePath }
    } catch (err: any) {
      // A file that never became a recording (the write failed, or no data)
      // goes; a written one stays in the save folder even if a later step
      // (the history row, the remux) failed.
      if (written) { try { stream?.destroy() } catch { /* ignore */ } }
      else discardPartialRecording(stream, filePath)
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
  if (!isAllowedPath(target)) return
  try {
    await unlink(target)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    if (retry) setTimeout(() => { void removeTrimmedFile(path, false) }, 60_000)
    else console.error('[video:trim] could not remove old trimmed file', target, err)
  }
}

/** A recording path from the renderer, checked like every other file path
 *  it sends (capture-folder.ts isAllowedPath): the home directory and the
 *  save folders. Throws for anything else. */
function allowedVideoPath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath) throw new Error('No video file path')
  const target = resolvePath(normalize(filePath))
  if (!isAllowedPath(target)) throw new Error(OUTSIDE_FOLDERS)
  return target
}

export function setupVideoActions() {
  /** Save-As dialog, then copy the recording file to the chosen path. The
   *  original at ~/Pictures/Lumia/ is untouched — this creates a copy. */
  ipcMain.handle('video:save-as', async (_e, rawPath: string) => {
    const filePath = allowedVideoPath(rawPath)
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
  ipcMain.handle('video:copy-file', async (_e, rawPath: string) => {
    const filePath = allowedVideoPath(rawPath)
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
        // and chat clients recognise it as a file, not plain text. The path
        // goes in as an argument, never into the script's text (a name with
        // a quote or a backslash could end the string there).
        await run('osascript', [
          '-e', 'on run argv',
          '-e', 'set f to POSIX file (item 1 of argv)',
          '-e', 'tell application "Finder" to set the clipboard to f',
          '-e', 'end run',
          filePath,
        ])
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
    const item = store?.get(historyId)
    if (!store || !item) return { ok: false, error: 'Recording not found' }
    if (item.type !== 'recording' || !item.filePath) return { ok: false, error: 'Not a recording' }
    const original = resolvePath(normalize(item.filePath))
    if (!isAllowedPath(original)) return { ok: false, error: OUTSIDE_FOLDERS }

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

    const fresh = store.get(historyId) ?? item
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
    const item = store?.get(historyId)
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
  ipcMain.handle('video:upload-r2', async (_e, rawPath: string) => {
    try {
      const filePath = allowedVideoPath(rawPath)
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
  ipcMain.handle('video:upload-google-drive', async (_e, rawPath: string) => {
    try {
      const filePath = allowedVideoPath(rawPath)
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
}

// Exported so hotkeys / tray can launch mode selection directly
export async function startVideoCapture(mode: 'region' | 'window' | 'screen') {
  if (isRecordingActive()) return
  const overlayMode =
    mode === 'region' ? 'video-region' :
    mode === 'window' ? 'video-window' : 'video-screen'
  setOverlayMode(overlayMode)
  try {
    // The screen ids and the toolbar, while the user picks.
    prepareVideoPick()
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

    // A video pick shows the live screen: drop any snapshot an earlier image
    // session left in the cache (2026-11-24: an image session switched to
    // Video and then recorded or cancelled never cleared it, so the next video
    // session got that old picture, and so did an Image confirm after
    // switching back).
    clearFrozenCache()
    createOverlayWindows()
  } catch (err) {
    failRecordingStart(err)
  }
}
