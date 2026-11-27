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

import { dockTrace } from './dock-trace'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { getSettings, setSetting } from './settings'
import { frontMacAppBundle, activateMacApp } from './mac-window-pick'
import { loadRoute } from './load-route'
import { useFullTheme } from './index'
import { DEFAULT_ANNOTATION_COLOR } from '../shared/annotation'

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
  // The image editor's tools without Sticker and Blur (2026-11-24).
  tool: 'none' | 'pen' | 'highlighter' | 'arrow' | 'rect' | 'ellipse' | 'text'
  color: string
  strokeWidth: number
}

const state: AnnotationState = {
  tool: 'none',
  color: DEFAULT_ANNOTATION_COLOR,
  strokeWidth: 4,
}

/** What the overlay reports about its drawings (2026-11-24, the image
 *  editor's toolbar behaviour): the selected shape's kind (its options show
 *  in the toolbar) and whether Undo / Redo have steps. Forwarded to the
 *  recording toolbar as `annotation:edit-state`. */
interface AnnotationEditState { selectedKind: AnnotationState['tool'] | null; canUndo: boolean; canRedo: boolean }
let editState: AnnotationEditState = { selectedKind: null, canUndo: false, canRedo: false }

/** Colour and stroke are the image editor's saved style (`annotationStyle`):
 *  read when the overlay opens, written on a toolbar pick (debounced, as the
 *  editor does). A pick that only mirrors a selected shape isn't saved. */
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistStyle() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    setSetting('annotationStyle', { color: state.color, strokeWidth: state.strokeWidth })
  }, 300)
}

function createOverlayWindow(display: Electron.Display) {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x, y, width, height,
    // Square corners: macOS rounds a frameless window's by default, which
    // would clip strokes drawn into the display's corners.
    roundedCorners: false,
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
    // Focusable since 2026-11-24 (the editor keys while drawing, see
    // annotation-overlay:want-focus). Taking focus can raise it over the
    // recording toolbar on Windows, so the toolbar and border are re-raised
    // each time it does.
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
  // skipTransformProcessType (2026-11-24): without it Electron briefly
  // switches the whole app's process type on macOS, which took activation
  // from Lumia (the countdown lost focus) and confused the Dock state.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Not a window the user manages: keep it out of Mission Control / Exposé.
  if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
  // Overlay is intentionally NOT content-protected — strokes have to land
  // in the recording, that's the whole feature.
  useFullTheme(win.webContents)
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

  // Always start without a tool selected so the user picks deliberately;
  // colour and stroke are the editor's saved style.
  state.tool = 'none'
  const saved = getSettings().annotationStyle
  if (saved && typeof saved.color === 'string' && typeof saved.strokeWidth === 'number') {
    state.color = saved.color
    state.strokeWidth = saved.strokeWidth
  }

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
  raiseWins = wins
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
  releaseFocus()
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
  editState = { selectedKind: null, canUndo: false, canRedo: false }
  focusTaken = false
  prevFrontBundle = null
}

/** Keyboard focus for the drawing layer (2026-11-24): taken while a drawing
 *  tool or a selection is active, so the image editor's keys work; given
 *  back to the app that was in front (the recorded one) afterwards. On
 *  macOS that means making Lumia the active app, then activating the other
 *  app again. The toolbar and border are re-raised over the layer after it
 *  takes focus (Windows orders topmost windows by the last raise). */
let raiseWins: BrowserWindow[] = []
let focusTaken = false
let prevFrontBundle: Promise<string> | null = null

function takeFocus() {
  if (focusTaken || !overlayWin || overlayWin.isDestroyed()) return
  focusTaken = true
  if (process.platform === 'darwin') {
    prevFrontBundle = frontMacAppBundle()
    dockTrace('app.focus steal (drawing layer)')
    app.focus({ steal: true })
  }
  overlayWin.focus()
  raiseAboveOverlay(raiseWins)
}

function releaseFocus() {
  if (!focusTaken) return
  focusTaken = false
  if (process.platform !== 'darwin') return
  const pending = prevFrontBundle
  prevFrontBundle = null
  void pending?.then(activateMacApp)
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
  // `mirror`: the overlay showing a selected shape's own style, not a pick.
  ipcMain.handle('annotation:set-color', (_e, color: string, mirror?: boolean) => {
    state.color = color
    broadcastAnnotationState()
    if (!mirror) persistStyle()
  })
  ipcMain.handle('annotation:set-stroke', (_e, strokeWidth: number, mirror?: boolean) => {
    state.strokeWidth = strokeWidth
    broadcastAnnotationState()
    if (!mirror) persistStyle()
  })
  ipcMain.handle('annotation:clear', () => sendToOverlay('annotation:clear'))
  ipcMain.handle('annotation:undo', () => sendToOverlay('annotation:undo'))
  ipcMain.handle('annotation:redo', () => sendToOverlay('annotation:redo'))
  ipcMain.handle('annotation:get-edit-state', () => editState)
  ipcMain.on('annotation:edit-state', (_e, s: AnnotationEditState) => {
    editState = s
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('annotation:edit-state', s)
    }
  })

  // Renderer-driven hover hit-test for tool='none' mode. The overlay is in
  // pass-through (setIgnoreMouseEvents true,forward) by default so the
  // user can interact with the recorded app. When the cursor enters an
  // existing stroke, the renderer flips the overlay back to capture so
  // the click registers as a select; on leave, back to pass-through.
  // Sent on transition only.
  ipcMain.on('annotation-overlay:want-focus', (_e, want: boolean) => {
    if (!annotationActive) return
    if (want) takeFocus()
    else releaseFocus()
  })

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
