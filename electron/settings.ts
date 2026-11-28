import Store from 'electron-store'
import { validPick, type ThemePicks } from '../shared/theme-colors'
import { DEFAULT_ANNOTATION_COLOR } from '../shared/annotation'
import type { WallpaperPhoto, WallpaperSourceId } from '../shared/wallpapers'
import { access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export type CaptureKind = 'image' | 'video' | 'scroll'
export type LastImageMode = 'region' | 'window' | 'all-screen' | 'screen' | 'scrolling'
export type LastVideoMode = 'region' | 'window' | 'screen'
/** How a scroll capture runs: 'extension' drives the companion browser
 *  extension over the local WebSocket bridge (exact DOM offsets, no stitch
 *  guessing); 'screen' is the classic synthetic-wheel + screen-grab + stitch
 *  pipeline that works on any app. */
export type ScrollCaptureMethod = 'extension' | 'screen'
// OpenLumiaWhen and the countdown values: shared/capture-settings.ts (Settings
// lists the same ones).
import { OPEN_LUMIA_WHEN, type OpenLumiaWhen } from '../shared/capture-settings'
export { OPEN_LUMIA_WHEN, RECORD_COUNTDOWNS, type OpenLumiaWhen } from '../shared/capture-settings'

/** Remember policy (2026-11-27, a dev called the old one a bug): every
 *  capture and recording tool the user picks last is what New capture /
 *  PrintScreen replay: Region, Window, Screen, All screens and Scroll for
 *  images, Region, Window and Screen for recordings. (Until then only Region
 *  and Window were kept, Screen / All screens counting as one-shots and
 *  Scroll never.) These check values written by the renderer (settings:set)
 *  and persisted by older builds. */
export function isImageMode(mode: unknown): mode is LastImageMode {
  return mode === 'region' || mode === 'window' || mode === 'screen' || mode === 'all-screen' || mode === 'scrolling'
}
export function isVideoMode(mode: unknown): mode is LastVideoMode {
  return mode === 'region' || mode === 'window' || mode === 'screen'
}

export interface AppSettings {
  defaultSavePath: string
  /** 'system' only until first launch resolves it (see resolveFirstLaunchTheme);
   *  after that always the user's last pick. */
  theme: 'dark' | 'light' | 'system'
  activeWorkflowId: string
  googleDriveRefreshToken: string
  googleDriveAccessToken: string
  googleDriveTokenExpiresAt: number
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  /** Thumbnail size generation of the history: TARGET_VERSION in
   *  thumbnail-refresh.ts once every row has been re-rendered at
   *  THUMB_MAX_WIDTH. */
  thumbnailVersion: number
  /** Launches on which the recordings' part of that refresh didn't finish
   *  (a frame that couldn't be read). After a few, it's called done
   *  (thumbnail-refresh.ts). */
  thumbnailRefreshTries: number
  lastCaptureKind: CaptureKind
  lastImageMode: LastImageMode
  lastVideoMode: LastVideoMode
  /** When true, captures include Lumia's own windows: the main window is NOT
   *  hidden before the screen freeze (screenshots) or the recording session
   *  (video), and the window picker offers Lumia's windows too (Win32 — on
   *  macOS the pick helpers exclude our PID at spawn, but region/screen/
   *  all-screen still include Lumia because the freeze routes around the
   *  PID-filtered native snapshot). Scroll capture keeps hiding — it always
   *  captures another app. */
  captureSelfWindow: boolean
  /** Screen scroll jumps the scrolled area to its top before the first
   *  frame (Settings › General, 2026-11-23). The extension always captures
   *  the whole page, so it ignores this. */
  scrollCaptureToTop: boolean
  /** The image editor keeps each image's edit steps after it's closed
   *  (History › Edits, 2026-11-23): files under userData/edit-history/.
   *  Off: steps last only while the image is open. */
  saveEditHistory: boolean
  /** Image editor: holding the pan key (`editorKeys.image.pan`, Space by default) and dragging pans, and
   *  the Cursor tool's drag draws a selection box (2026-11-24). Off (default,
   *  the behaviour before): the drag key does nothing and the Cursor tool
   *  pans by dragging (the hand), with no selection box; shapes still select
   *  and move. */
  keyToDrag: boolean
  /** Copy every image capture to the clipboard (2026-11-27, Settings ›
   *  General; it always did). */
  copyAfterCapture: boolean
  /** Seconds the recording toolbar counts down before recording: 0 (off),
   *  3 or 5 (2026-11-27, Settings › General; always 3 before). */
  recordCountdown: number
  /** Where captures and recordings are saved; '' = ~/Pictures/Lumia
   *  (capture-folder.ts, 2026-11-27). Set only through the folder dialog. */
  captureFolder: string
  /** Save folders used before, kept so their files stay readable
   *  (capture-folder.ts isAllowedPath). Not shown anywhere. */
  pastCaptureFolders: string[]
  /** When the editor opens after an image capture / a recording (see
   *  OpenEditorWhen). Default 'open' for both. */
  openLumiaAfter: OpenLumiaWhen
  /** Capture actions in the menu-bar icon's menu, by hotkey id
   *  (`RectangleRegion`, `ScreenRecorderScreen`…; a switch per row in
   *  Settings › Hotkeys, 2026-11-27). Empty: only New Capture. */
  trayActions: string[]
  /** The app bar's light / dark button (2026-11-25, Settings › Appearance).
   *  Off: hidden, and Appearance offers the mode instead. */
  showThemeButton: boolean
  /** The image and video editors' keys the user changed, per editor, as
   *  { actionId: binding } (Settings › Hotkeys, 2026-11-24; replaces the
   *  same day's `dragKey`). Only changed keys are stored; defaults live in
   *  src/lib/editor-keys.ts. */
  editorKeys: { image?: Record<string, string>; video?: Record<string, string> }
  /** When true, the physical PrintScreen key is bound to "New Capture" via a
   *  globalShortcut, and on Windows the "PrintScreen opens Snipping Tool"
   *  registry hijack is turned off so the keystroke reaches us. The binding
   *  is fixed (PrintScreen only) — toggle on/off only, no rebinding. */
  printScreenAsCapture: boolean
  /** Opt-in silent updates (2026-11-22): found updates download on their
   *  own and install while the main window sits hidden in the tray / menu
   *  bar (after a grace period, never mid-recording or mid-capture). Off:
   *  every step waits for the user (Update, then Restart). */
  autoUpdateWhenHidden: boolean
  /** Custom theme picks (design/CUSTOM-THEMES.md), raw hex as picked (the
   *  clamping happens on apply, shared/theme-colors.ts); null = default. */
  themeAccent: string | null
  themeLightBase: string | null
  themeDarkBase: string | null
  /** True once the first-run prompt asking the user whether to bind PrintScreen
   *  has been shown (and answered, either way). Used to suppress the prompt
   *  on subsequent launches. Also flipped to true whenever the user toggles
   *  printScreenAsCapture from Settings, so manual configuration counts as
   *  having been asked. */
  printScreenPromptShown: boolean
  /** Where wallpaper photos come from. */
  wallpaperSource: WallpaperSourceId
  /** The one category shown. null = the default (Landscapes). */
  wallpaperCategory: string | null
  /** Only photos of at least 3840x2160. */
  wallpaper4kOnly: boolean
  /** Cached batches of the last fetches, keyed `source:categoryId:uhd|any`
   *  (at most 10, 24 hours), so a visit doesn't hit the sources again. */
  wallpaperGrid: Record<string, {
    photos: WallpaperPhoto[]
    cursor?: string
    fetchedAt: number
  }> | null
  /** The desktop wallpaper before Lumia's first change, for Reset
   *  (wallpapers.ts, 2026-11-27): per screen id on macOS, per monitor device
   *  path on Windows (`all`, the registry's one path, when those can't be read).
   *  null when there's nothing to put back. */
  wallpaperBefore: { all?: string; screens?: Record<string, string>; monitors?: Record<string, string> } | null
  /** Last annotation style picked in the editor toolbar (color + stroke
   *  width — the latter also sizes text). Restored when the editor opens so
   *  the next edit starts where the last one left off. Written on user picks
   *  only, not when the toolbar merely mirrors a selected shape's style. */
  annotationStyle: { color: string; strokeWidth: number }
}

// On macOS, binding PrintScreen has no downside: built-in Apple keyboards
// don't have a PrtSc key (so the globalShortcut never fires unintentionally),
// the Windows registry hijack doesn't exist (setSnippingHijack is a no-op),
// and external PC-style keyboards plugged into a Mac will Just Work. So
// default to enabled there and skip the first-run prompt entirely. On
// Windows it's opt-in via the dialog because flipping the registry value
// affects Snipping Tool, which the user might rely on.
const PRINT_SCREEN_DEFAULT = process.platform === 'darwin'

const store = new Store<AppSettings>({
  name: 'settings',
  // A corrupted settings.json must not crash the app at module-import time
  // (this store is read on import below) — reset to defaults instead.
  clearInvalidConfig: true,
  defaults: {
    defaultSavePath: join(homedir(), 'Downloads'),
    theme: 'system',
    activeWorkflowId: 'builtin-r2',
    googleDriveRefreshToken: '',
    googleDriveAccessToken: '',
    googleDriveTokenExpiresAt: 0,
    googleDriveFolderId: '',
    launchAtStartup: true,
    historyRetentionDays: 0,
    thumbnailVersion: 0,
    thumbnailRefreshTries: 0,
    lastCaptureKind: 'image',
    lastImageMode: 'region',
    lastVideoMode: 'region',
    captureSelfWindow: false,
    scrollCaptureToTop: false,
    saveEditHistory: true,
    keyToDrag: false,
    copyAfterCapture: true,
    recordCountdown: 3,
    captureFolder: '',
    pastCaptureFolders: [],
    openLumiaAfter: 'open',
    trayActions: [],
    showThemeButton: true,
    editorKeys: {},
    printScreenAsCapture: PRINT_SCREEN_DEFAULT,
    autoUpdateWhenHidden: false,
    themeAccent: null,
    themeLightBase: null,
    themeDarkBase: null,
    printScreenPromptShown: PRINT_SCREEN_DEFAULT,
    wallpaperSource: 'commons',
    wallpaperCategory: null,
    wallpaper4kOnly: false,
    wallpaperGrid: null,
    wallpaperBefore: null,
    annotationStyle: { color: DEFAULT_ANNOTATION_COLOR, strokeWidth: 3 }
  }
})

// One-time migration of legacy mode IDs from older builds:
//   'fullscreen'     → 'all-screen'   (renamed to match the UI label)
//   'active-monitor' → 'screen'
// Run once at module load so getSettings always returns the current shape.
{
  const raw = store.get('lastImageMode') as string
  if (raw === 'fullscreen') store.set('lastImageMode', 'all-screen')
  else if (raw === 'active-monitor') store.set('lastImageMode', 'screen')
  // Anything else (a hand edit) goes back to the default.
  if (!isImageMode(store.get('lastImageMode'))) store.set('lastImageMode', 'region')
  if (!isVideoMode(store.get('lastVideoMode'))) store.set('lastVideoMode', 'region')
  // Open Lumia, earlier on 2026-11-27: the switch `openEditorAlways`, one
  // dropdown `openEditor` (open / images / videos / always), then a row per
  // kind (`openEditorAfterCapture` / `-Recording`: always / open / never).
  // The old values carry over.
  const legacy = store as unknown as Store<Record<string, unknown>>
  let carried: OpenLumiaWhen | null = null
  if (legacy.has('openEditorAlways')) {
    if (legacy.get('openEditorAlways') === true) carried = 'success'
    legacy.delete('openEditorAlways')
  }
  if (legacy.has('openEditor')) {
    const old = legacy.get('openEditor')
    carried = old === 'always' ? 'success' : old === 'images' ? 'captures' : old === 'videos' ? 'recordings' : 'open'
    legacy.delete('openEditor')
  }
  if (legacy.has('openEditorAfterCapture') || legacy.has('openEditorAfterRecording')) {
    const c = legacy.get('openEditorAfterCapture'), r = legacy.get('openEditorAfterRecording')
    carried = c === 'never' && r === 'never' ? 'never'
      : c === 'always' && r === 'always' ? 'success'
      : c === 'always' ? 'captures' : r === 'always' ? 'recordings' : 'open'
    legacy.delete('openEditorAfterCapture')
    legacy.delete('openEditorAfterRecording')
  }
  if (carried) store.set('openLumiaAfter', carried)
  // `scrollCaptureMethod` (Settings › General › Capture scroll with) is gone
  // (2026-11-27): the scroll hotkey picks by the app in front.
  legacy.delete('scrollCaptureMethod')
  if (!OPEN_LUMIA_WHEN.includes(store.get('openLumiaAfter'))) store.set('openLumiaAfter', 'open')
}

/** First launch (or a settings file from a build that had a "System"
 *  theme): take the OS appearance once and save it. From then on the theme
 *  only changes when the user picks one. Call after app ready (nativeTheme). */
export function resolveFirstLaunchTheme(osIsDark: boolean): void {
  if (store.get('theme') === 'system') store.set('theme', osIsDark ? 'dark' : 'light')
}

/** The custom theme picks, in shared/theme-colors.ts's shape. */
export function getThemePicks(): ThemePicks {
  // A malformed value (hand edit) reads as the default.
  return { accent: validPick(store.get('themeAccent')), lightBase: validPick(store.get('themeLightBase')), darkBase: validPick(store.get('themeDarkBase')) }
}

export function getSettings(): AppSettings {
  // One read of settings.json for all keys. electron-store reads and parses
  // the file on every `get`, so a get per key was 37 disk reads per call,
  // and this is called per history row (captureFolder, isAllowedPath). The
  // values are the same: `get(key)` returns this object's `key`.
  const s = store.store
  return {
    defaultSavePath: s.defaultSavePath,
    theme: s.theme,
    activeWorkflowId: s.activeWorkflowId,
    googleDriveRefreshToken: s.googleDriveRefreshToken,
    googleDriveAccessToken: s.googleDriveAccessToken,
    googleDriveTokenExpiresAt: s.googleDriveTokenExpiresAt,
    googleDriveFolderId: s.googleDriveFolderId,
    launchAtStartup: s.launchAtStartup,
    historyRetentionDays: s.historyRetentionDays,
    thumbnailVersion: s.thumbnailVersion,
    thumbnailRefreshTries: s.thumbnailRefreshTries,
    lastCaptureKind: s.lastCaptureKind,
    lastImageMode: s.lastImageMode,
    lastVideoMode: s.lastVideoMode,
    captureSelfWindow: s.captureSelfWindow,
    scrollCaptureToTop: s.scrollCaptureToTop,
    saveEditHistory: s.saveEditHistory,
    keyToDrag: s.keyToDrag,
    copyAfterCapture: s.copyAfterCapture,
    recordCountdown: s.recordCountdown,
    captureFolder: s.captureFolder,
    pastCaptureFolders: s.pastCaptureFolders,
    openLumiaAfter: s.openLumiaAfter,
    trayActions: s.trayActions,
    showThemeButton: s.showThemeButton,
    editorKeys: s.editorKeys,
    printScreenAsCapture: s.printScreenAsCapture,
    autoUpdateWhenHidden: s.autoUpdateWhenHidden,
    themeAccent: s.themeAccent,
    themeLightBase: s.themeLightBase,
    themeDarkBase: s.themeDarkBase,
    printScreenPromptShown: s.printScreenPromptShown,
    wallpaperSource: s.wallpaperSource,
    wallpaperCategory: s.wallpaperCategory,
    wallpaper4kOnly: s.wallpaper4kOnly,
    wallpaperGrid: s.wallpaperGrid,
    wallpaperBefore: s.wallpaperBefore,
    annotationStyle: s.annotationStyle
  }
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  store.set(key, value)
}

// Resolves the directory the save dialog should open in: the last folder the
// user saved into if it's still accessible, otherwise Downloads. If the stored
// dir is gone, the setting is reset so the next call doesn't re-check it.
export async function resolveSaveStartDir(): Promise<string> {
  const downloads = join(homedir(), 'Downloads')
  const stored = store.get('defaultSavePath')
  if (!stored) return downloads
  try {
    await access(stored)
    return stored
  } catch {
    store.set('defaultSavePath', downloads)
    return downloads
  }
}

export function rememberSaveDir(dir: string): void {
  store.set('defaultSavePath', dir)
}
