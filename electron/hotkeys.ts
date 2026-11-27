import { globalShortcut, app } from 'electron'
import Store from 'electron-store'
import { dispatchCapture, dispatchLastCapture } from './capture'
import { getOverlayWindow, markQuitting } from './index'
import { startVideoCapture, requestStop as requestVideoStop, isRecordingActive } from './video'
import { setSetting, getSettings } from './settings'
import { launchScrollCapture } from './scroll-capture'
import type { LastImageMode, LastVideoMode } from './settings'

export interface HotkeyConfig {
  [action: string]: string
}

export const defaultHotkeys: HotkeyConfig = {
  RectangleRegion:      'Ctrl+Shift+1',
  ActiveWindow:         'Ctrl+Shift+2',
  ActiveMonitor:        'Ctrl+Shift+3',
  PrintScreen:          'Ctrl+Shift+4',
  // Back on 2026-11-25 (retired in schema v7 while the Dashboard launcher
  // had a Scroll tile; that launcher is gone). New actions reach existing
  // configs through the defaults merge in getHotkeys, no schema bump.
  ScrollingCapture:     'Ctrl+Shift+5',
  // `ScreenRecorder` kept as the "Region" video entry for backwards compat
  // with saved configs from older releases.
  ScreenRecorder:       'Ctrl+Shift+6',
  ScreenRecorderWindow: 'Ctrl+Shift+7',
  ScreenRecorderScreen: 'Ctrl+Shift+8'
}

// Bump this whenever the default capture-mode bindings change in a way that
// should retake control from users who never hand-customized. On load, if the
// stored version is stale we rewrite the capture/recorder bindings to the new
// defaults while leaving app-level hotkeys alone (those have stable defaults).
const HOTKEY_SCHEMA_VERSION = 7
const CAPTURE_ACTIONS = [
  'RectangleRegion', 'ActiveWindow', 'ActiveMonitor', 'PrintScreen',
  'ScreenRecorder', 'ScreenRecorderWindow', 'ScreenRecorderScreen',
] as const

// Capture/recorder defaults as they shipped in PRIOR schema versions. Used by
// the migration to decide whether a stored binding is "untouched" (still equal
// to whatever default it was last given) and therefore safe to retake, vs.
// hand-customized and therefore left alone. The capture-mode keys have been on
// the stable Ctrl+Shift+1..8 scheme throughout, so this currently mirrors the
// current defaults; if a future bump changes a default key, add the old value
// here so users who never customized still get migrated forward.
const PREVIOUS_CAPTURE_DEFAULTS: Record<string, readonly string[]> = {
  RectangleRegion:      ['Ctrl+Shift+1'],
  ActiveWindow:         ['Ctrl+Shift+2'],
  ActiveMonitor:        ['Ctrl+Shift+3'],
  PrintScreen:          ['Ctrl+Shift+4'],
  ScreenRecorder:       ['Ctrl+Shift+6'],
  ScreenRecorderWindow: ['Ctrl+Shift+7'],
  ScreenRecorderScreen: ['Ctrl+Shift+8'],
}
// Actions that were removed (or renamed) in a migration — stripped from the
// saved config so stale bindings don't linger and accidentally block new keys
// (e.g. S was `StopScreenRecording` and is now `ScreenRecorderScreen`).
// `ExitShareAnywhere` was renamed to `ExitLumia` after the rebrand.
// `ScrollingCapture` (Ctrl+Shift+5) was stripped by v7 and is back since
// 2026-11-25, so it's no longer listed here.
const REMOVED_ACTIONS = ['StopScreenRecording', 'OpenMainWindow', 'WorkflowPicker', 'ExitShareAnywhere'] as const

const store = new Store<{ hotkeys: HotkeyConfig; schemaVersion?: number }>({
  name: 'hotkeys',
  defaults: { hotkeys: defaultHotkeys },
  // A corrupted hotkeys.json should reset to defaults rather than crash.
  clearInvalidConfig: true
})

export function getHotkeys(): HotkeyConfig {
  // `has` reads the on-disk file directly, bypassing the `defaults` merge — so
  // a missing key genuinely means "this install predates the schema bump".
  const storedVersion = store.has('schemaVersion') ? store.get('schemaVersion') ?? 1 : 1
  const saved = store.get('hotkeys')
  if (storedVersion < HOTKEY_SCHEMA_VERSION) {
    // Migrate: retake ONLY the capture/recorder bindings the user never
    // hand-customized (missing, or still equal to a previously-shipped
    // default for that action). Any binding the user changed is preserved —
    // the old code clobbered all of them on every bump. Drop removed actions
    // and keep app-level customizations either way.
    const migrated: HotkeyConfig = { ...saved }
    for (const action of REMOVED_ACTIONS) delete migrated[action]
    for (const action of CAPTURE_ACTIONS) {
      const current = migrated[action]
      const wasDefault = current === undefined
        || current === defaultHotkeys[action]
        || (PREVIOUS_CAPTURE_DEFAULTS[action]?.includes(current) ?? false)
      if (wasDefault) migrated[action] = defaultHotkeys[action]
    }
    store.set('hotkeys', migrated)
    store.set('schemaVersion', HOTKEY_SCHEMA_VERSION)
    return { ...defaultHotkeys, ...migrated }
  }
  // Merge defaults for any new actions not yet in the user's saved config
  return { ...defaultHotkeys, ...saved }
}

export function saveHotkeys(hotkeys: HotkeyConfig) {
  store.set('hotkeys', hotkeys)
  teardownHotkeys()
  setupHotkeys()
}

let isCapturing = false

// Route capture hotkeys through the same `dispatchCapture` the Dashboard
// buttons invoke, so the behavior (overlay pickers, multi-display
// compositing, etc.) stays consistent across entry points. The lock guards
// against re-entrancy when the user mashes the hotkey or clicks during a
// running capture.
const withLock = (fn: () => Promise<void>) => async () => {
  if (isCapturing) return
  if (getOverlayWindow()) return
  isCapturing = true
  // The capture paths restore the window and show their own message when
  // they fail; this only keeps a stray rejection out of the log as
  // "unhandled" (a global shortcut's handler has no caller to catch it).
  try { await fn() } catch (err) { console.error('[hotkeys] capture failed', err) } finally { isCapturing = false }
}

// Persist what the user just triggered so New capture / New recording (the
// menu bar, PrintScreen) replay it: every tool, see isImageMode in
// settings.ts for the policy.
const rememberImage = (mode: LastImageMode) => {
  setSetting('lastCaptureKind', 'image')
  setSetting('lastImageMode', mode)
}
const rememberVideo = (mode: LastVideoMode) => {
  setSetting('lastCaptureKind', 'video')
  setSetting('lastVideoMode', mode)
}

// The actions, shared by the hotkeys and the menu-bar icon's menu
// (2026-11-27), so a menu item does exactly what its hotkey does.
const handlers: Record<string, () => void> = {
  RectangleRegion: withLock(async () => { rememberImage('region'); await dispatchCapture('region') }),
  PrintScreen:     withLock(async () => { rememberImage('all-screen'); await dispatchCapture('all-screen') }),
  ActiveWindow:    withLock(async () => { rememberImage('window'); await dispatchCapture('window') }),
  ActiveMonitor:   withLock(async () => { rememberImage('screen'); await dispatchCapture('screen') }),
  // Scroll: a browser in front with the extension connected captures its
  // page through the extension, anything else gets the screen scroll overlay.
  // Remembered like every tool (2026-11-27).
  ScrollingCapture: withLock(async () => { rememberImage('scrolling'); await launchScrollCapture() }),
  // All three video hotkeys toggle: pressing any of them while recording
  // stops (matches Snipping Tool's UX), otherwise starts in that mode.
  ScreenRecorder:       () => { if (isRecordingActive()) requestVideoStop(); else { rememberVideo('region'); void startVideoCapture('region') } },
  ScreenRecorderWindow: () => { if (isRecordingActive()) requestVideoStop(); else { rememberVideo('window'); void startVideoCapture('window') } },
  ScreenRecorderScreen: () => { if (isRecordingActive()) requestVideoStop(); else { rememberVideo('screen'); void startVideoCapture('screen') } },
  ExitLumia: () => { markQuitting(); app.quit() }
}

/** Runs a capture action by its hotkey id (`RectangleRegion`,
 *  `ScreenRecorderScreen`…), as its hotkey would. */
export function runCaptureAction(action: string): void {
  handlers[action]?.()
}

export function setupHotkeys() {
  const hotkeys = getHotkeys()

  for (const [action, shortcut] of Object.entries(hotkeys)) {
    if (!shortcut) continue
    const handler = handlers[action]
    if (!handler) continue
    try {
      // register() returns false (without throwing) when another app already
      // owns the accelerator — distinct from the catch below, which fires only
      // on an invalid/unparseable accelerator string.
      const ok = globalShortcut.register(shortcut, handler)
      if (!ok) console.warn(`Hotkey ${shortcut} for ${action} not registered (already in use by another app?)`)
    } catch {
      console.warn(`Failed to register hotkey ${shortcut} for ${action}`)
    }
  }

  // Special PrintScreen → "New Capture" binding. Fixed key, toggle-only via
  // Settings; not part of the configurable hotkeys map (kept out of
  // `defaultHotkeys` deliberately so the hotkeys editor can't rebind or
  // shadow it). On Windows the snipping-tool hijack is also
  // disabled via registry — that side of the toggle lives in
  // printscreen-key.ts and is invoked from the IPC handler / boot path.
  if (getSettings().printScreenAsCapture) {
    const handler = withLock(async () => { await dispatchLastCapture() })
    try { globalShortcut.register('PrintScreen', handler) }
    catch { console.warn('Failed to register PrintScreen as New Capture') }
    // macOS keyboard driver maps HID PrintScreen (usage 0x46) on external PC
    // keyboards to virtual keycode F13, not PrintScreen, so the accelerator
    // above never fires on Mac — globalShortcut sits on top of Carbon's
    // RegisterEventHotKey which keys off the Mac virtual code. Register F13
    // as an alias here. Safe collision: Lumia doesn't bind F13 elsewhere,
    // and the Apple Extended Keyboard's real F13 key is rarely used by app
    // shortcuts, so users with one will just have F13 also trigger capture
    // (which is exactly what they probably want anyway).
    if (process.platform === 'darwin') {
      try { globalShortcut.register('F13', handler) } catch { /* ignore */ }
    }
  }
}

export function teardownHotkeys() {
  globalShortcut.unregisterAll()
}
