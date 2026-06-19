/**
 * Live annotation overlay for the recording session.
 *
 * One window only: the fullscreen click-capturing overlay that hosts a
 * Konva stage where strokes are drawn. The tool palette used to live in
 * its own BrowserWindow but was merged into the recording toolbar (see
 * src/windows/recording-toolbar/RecordingToolbar.tsx) to eliminate the
 * z-order race where the recording toolbar's transparent bottom strip
 * swallowed clicks aimed at the palette's centre.
 *
 * The overlay is intentionally NOT content-protected — strokes need to
 * land in the recorded video, that's the whole feature.
 *
 * Lifecycle is tied to the recording session — closing the session
 * (stop / cancel) tears the overlay down via destroyAnnotation().
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

const isDev = !app.isPackaged

let overlayWin: BrowserWindow | null = null
// Tracks the user-visible "Annotate" toggle. Distinct from "the overlay
// window exists at all": closeAnnotation flips this to false but keeps the
// overlay alive so already-drawn strokes stay rendered (and recorded) while
// the user interacts with the app underneath.
let annotationActive = false

/** Single source of truth for the live drawing state. The recording-toolbar
 *  renderer reads this on mount via annotation:get-state so the user's most
 *  recent color/stroke survive a toggle off → on. Tool defaults to 'none'
 *  (no draw): the user must explicitly pick a tool before clicks on the
 *  overlay turn into strokes — that keeps the first click after enabling
 *  annotation from being an accidental drag. */
interface AnnotationState {
  tool: 'none' | 'select' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'highlighter'
  color: string
  strokeWidth: number
}

const state: AnnotationState = {
  tool: 'none',
  color: '#f87171',
  strokeWidth: 4,
}

function loadRoute(win: BrowserWindow, route: string) {
  if (isDev) {
    win.loadURL(`http://localhost:5173/#${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  }
}

function createOverlayWindow(display: Electron.Display) {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    // Hide until the renderer has painted at least once. Without this,
    // the empty BrowserWindow appears with a white background for a frame
    // before the transparent body is drawn — causes a visible flash on
    // every "Annotate" toggle. ready-to-show below brings it back.
    show: false,
    // Non-focusable so the OS doesn't raise the overlay above the recording
    // toolbar when it briefly takes focus (e.g., during stroke draw, when
    // creating it). Without this Windows can place the topmost overlay
    // ahead of the topmost toolbar and swallow clicks meant for buttons.
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // Re-apply bounds on Windows: the constructor uses the primary
    // display's DPI context, so on a secondary monitor with a different
    // scale factor the original bounds end up off — rewriting them once
    // the window is realised pins it to the right pixels.
    if (process.platform === 'win32') win.setBounds({ x, y, width, height })
    win.showInactive()
  })
  win.setMenu(null)
  // Stay above the recorded app (including fullscreen games / videos) so
  // strokes paint on top. The recording toolbar and border use the same
  // level + relativeLevel:1 so they stack above this overlay on macOS
  // without any moveTop race. On Windows there are no levels, so
  // SetWindowPos(HWND_TOPMOST) is still applied via raiseAboveOverlay
  // below to keep the toolbar buttons clickable despite the overlay
  // being a fullscreen click-capturing window.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Overlay is intentionally NOT content-protected — strokes have to land
  // in the recording, that's the whole feature.
  loadRoute(win, '/annotation-overlay')
  win.on('closed', () => { overlayWin = null })
  return win
}

function sendToOverlay(channel: string, ...args: unknown[]) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(channel, ...args)
  }
}

/** Broadcast the current annotation state to every BrowserWindow.
 *  Both the overlay (which renders strokes with this colour/stroke) and
 *  the recording toolbar (which renders the palette UI in its second pill
 *  row) listen for 'annotation:state'. Sending to a window that doesn't
 *  subscribe is a no-op, so a coarse broadcast keeps the call sites
 *  simple. */
function broadcastAnnotationState() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('annotation:state', state)
  }
}

/** True iff the user has the "Annotate" toggle on. Distinct from "the
 *  overlay window exists at all" — see hasLiveAnnotations. */
export function isAnnotationOpen(): boolean {
  return annotationActive
}

/** True iff there's an overlay window alive — possibly hidden away as a
 *  click-through layer that's still painting strokes onto the recording.
 *  Used by closeRecordingSession to tear down for real. */
function hasLiveAnnotations(): boolean {
  return overlayWin !== null && !overlayWin.isDestroyed()
}

export function openAnnotation(
  displayId: number,
  topmostAfter: BrowserWindow[] = [],
) {
  if (annotationActive) return
  const display = screen.getAllDisplays().find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

  // Always start without a tool selected so the user picks deliberately —
  // color and stroke width carry over from the previous session.
  state.tool = 'none'

  const reusingOverlay = hasLiveAnnotations()
  if (!reusingOverlay) {
    overlayWin = createOverlayWindow(display)
  }

  // tool='none' = interact mode: clicks pass through the overlay to the
  // recorded app underneath. set-tool will flip this back to capturing
  // when the user picks an actual drawing tool.
  overlayWin!.setIgnoreMouseEvents(true, { forward: true })

  // Tell every subscriber (overlay + recording toolbar's annotation row)
  // about the freshly-reset tool. Reused overlays would otherwise stay
  // stuck on the previous "+" crosshair, and the recording toolbar's
  // annotation row would mount with stale active swatches.
  broadcastAnnotationState()

  annotationActive = true

  // On Windows there are no NSWindowLevel-style layers — only the binary
  // HWND_TOPMOST flag — so order within the topmost group is determined by
  // the most recent SetWindowPos call. Force the recording toolbar / border
  // above the freshly-created overlay so their buttons stay clickable.
  // macOS uses relativeLevel:1 on those windows, so the OS already enforces
  // the stacking (see comment in createOverlayWindow).
  //
  // SetWindowPos on a still-hidden HWND has no effect on the visible Z
  // order, so wait until the overlay's own ready-to-show before raising
  // the others — only at that point is the overlay HWND in the topmost
  // group and visible. The +50ms timer is a safety net for the cached-
  // paint case where ready-to-show has already fired.
  const wins = [...topmostAfter]
  if (overlayWin) {
    overlayWin.once('ready-to-show', () => raiseAboveOverlay(wins))
  }
  setTimeout(() => raiseAboveOverlay(wins), 50)
}

/** Toggle the "Annotate" indicator off without erasing the strokes the
 *  user has already drawn. The overlay window stays alive but flips to
 *  click-through so the user can interact with the recorded app
 *  underneath while their annotations remain visible (and being
 *  recorded). Strokes only go away on destroyAnnotation(). */
export function closeAnnotation() {
  annotationActive = false
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true })
  }
}

/** Tear down the overlay too. Called from closeRecordingSession when
 *  the recording stops or is cancelled. */
export function destroyAnnotation() {
  annotationActive = false
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.close() } catch { /* ignore */ }
  }
  overlayWin = null
}

/** Re-raise each window above the live annotation overlay on Windows.
 *  Windows has no level-style stacking — only the binary HWND_TOPMOST
 *  flag — so order within the topmost group is determined by the most
 *  recent SetWindowPos call. macOS and Linux rely on relativeLevel:1
 *  applied at window creation, so this is a no-op there. */
function raiseAboveOverlay(wins: (BrowserWindow | null)[]) {
  if (process.platform !== 'win32') return
  forceWindowsTopmost(wins)
}

/** Lazily-bound user32!SetWindowPos. Hoisted to module scope (like
 *  native-input.ts's ensureLoaded) so the Annotate toggle — which calls
 *  forceWindowsTopmost twice per activation — doesn't re-run koffi.load +
 *  user32.func each time. Cached across calls; bound on first use. */
type SetWindowPosFn = (
  hWnd: bigint, hWndInsertAfter: number, X: number, Y: number, cx: number, cy: number, uFlags: number,
) => boolean
let _setWindowPos: SetWindowPosFn | null = null
function getSetWindowPos(): SetWindowPosFn | null {
  if (_setWindowPos) return _setWindowPos
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    _setWindowPos = user32.func(
      'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)',
    )
    return _setWindowPos
  } catch (err) {
    console.warn('[annotation] failed to bind SetWindowPos', err)
    return null
  }
}

/** Direct Win32 SetWindowPos(HWND_TOPMOST) on each window's HWND. */
function forceWindowsTopmost(wins: (BrowserWindow | null)[]) {
  if (process.platform !== 'win32') return
  try {
    const SetWindowPos = getSetWindowPos()
    if (!SetWindowPos) return
    const HWND_TOPMOST = -1
    const SWP_NOMOVE = 0x0002
    const SWP_NOSIZE = 0x0001
    const SWP_NOACTIVATE = 0x0010
    const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    for (const w of wins) {
      if (!w || w.isDestroyed()) continue
      // HWND is a pointer — 8 bytes on x64 / arm64 Windows, 4 bytes on x86.
      // BrowserWindow.getNativeWindowHandle returns a Buffer of that size.
      const buf = w.getNativeWindowHandle()
      const hwnd = buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0))
      SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
    }
  } catch (err) {
    console.warn('[annotation] SetWindowPos call failed', err)
  }
}

export function setupAnnotation() {
  ipcMain.handle('annotation:get-state', () => state)

  ipcMain.handle('annotation:set-tool', (_e, tool: AnnotationState['tool']) => {
    state.tool = tool
    // tool === 'none' means the user wants to interact with the recorded
    // app, not draw — flip the overlay to click-through so clicks fall
    // through to whatever's behind it. Picking any actual drawing tool
    // brings click capture back so the next stroke lands on the canvas.
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (tool === 'none') overlayWin.setIgnoreMouseEvents(true, { forward: true })
      else overlayWin.setIgnoreMouseEvents(false)
    }
    broadcastAnnotationState()
  })
  ipcMain.handle('annotation:set-color', (_e, color: string) => {
    state.color = color
    broadcastAnnotationState()
  })
  ipcMain.handle('annotation:set-stroke', (_e, strokeWidth: number) => {
    state.strokeWidth = strokeWidth
    broadcastAnnotationState()
  })
  ipcMain.handle('annotation:clear', () => sendToOverlay('annotation:clear'))
  ipcMain.handle('annotation:undo', () => sendToOverlay('annotation:undo'))

  // Renderer-driven hover hit-test for tool='none' mode. The overlay is in
  // pass-through (setIgnoreMouseEvents true,forward) by default so the
  // user can interact with the recorded app. When the cursor enters an
  // existing stroke, the renderer flips the overlay back to capture so
  // the click registers as a select; on leave, back to pass-through.
  // Sent on transition only.
  ipcMain.on('annotation-overlay:set-interactive', (_e, interactive: boolean) => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    // Don't override drawing/select modes — those want full capture
    // unconditionally. The hit-test toggle only applies in 'none'.
    if (state.tool !== 'none') return
    if (interactive) {
      overlayWin.setIgnoreMouseEvents(false)
    } else {
      overlayWin.setIgnoreMouseEvents(true, { forward: true })
    }
  })
}
