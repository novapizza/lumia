import Store from 'electron-store'
import { access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export type CaptureKind = 'image' | 'video'
export type LastImageMode = 'region' | 'window' | 'all-screen' | 'screen' | 'scrolling'
export type LastVideoMode = 'region' | 'window' | 'screen'

/** Deliberate remember policy: only explicit Region / Window picks update the
 *  replay mode that "New Capture" / PrtSc re-run. Everything else (screen,
 *  all-screen, scrolling) is a one-shot — it still flips lastCaptureKind, but
 *  New Capture should never replay an all-monitor grab or a scroll session.
 *  Enforced at every write site: the settings:set IPC handler (renderer
 *  writers — Dashboard, overlay ModeBar) and hotkeys' remember helpers, plus
 *  a load-time normalization below for values persisted by older builds. */
export function isRememberedMode(mode: unknown): mode is 'region' | 'window' {
  return mode === 'region' || mode === 'window'
}

export interface AppSettings {
  defaultSavePath: string
  theme: 'dark' | 'light' | 'system'
  activeWorkflowId: string
  googleDriveRefreshToken: string
  googleDriveAccessToken: string
  googleDriveTokenExpiresAt: number
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  lastCaptureKind: CaptureKind
  lastImageMode: LastImageMode
  lastVideoMode: LastVideoMode
  /** When true, the physical PrintScreen key is bound to "New Capture" via a
   *  globalShortcut, and on Windows the "PrintScreen opens Snipping Tool"
   *  registry hijack is turned off so the keystroke reaches us. The binding
   *  is fixed (PrintScreen only) — toggle on/off only, no rebinding. */
  printScreenAsCapture: boolean
  /** True once the first-run prompt asking the user whether to bind PrintScreen
   *  has been shown (and answered, either way). Used to suppress the prompt
   *  on subsequent launches. Also flipped to true whenever the user toggles
   *  printScreenAsCapture from Settings, so manual configuration counts as
   *  having been asked. */
  printScreenPromptShown: boolean
  /** User-picked wallpaper category IDs. Matches either a built-in id from
   *  the renderer's curated list or a custom id from `wallpaperCustomCategories`.
   *  Empty = first run, show the picker. */
  wallpaperCategories: string[]
  /** User-defined wallpaper categories on top of the built-in curated set.
   *  Each is just a label + free-text search query — no editorial topic
   *  resolution since users wouldn't know Unsplash topic slugs. */
  wallpaperCustomCategories: Array<{ id: string; label: string; query: string }>
  /** Cached result of the last Unsplash random fetch — re-rendered on every
   *  Wallpapers visit until the user explicitly clicks Refresh, so we don't
   *  burn API quota on idle navigation. `photos` is the same shape as
   *  `UnsplashPhoto` in `wallpapers.ts`; kept loosely typed here to avoid
   *  pulling in the wallpapers module just for a type. */
  wallpaperGrid: {
    photos: unknown[]
    pickId: string
    fetchedAt: number
  } | null
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
    lastCaptureKind: 'image',
    lastImageMode: 'region',
    lastVideoMode: 'region',
    printScreenAsCapture: PRINT_SCREEN_DEFAULT,
    printScreenPromptShown: PRINT_SCREEN_DEFAULT,
    wallpaperCategories: [],
    wallpaperCustomCategories: [],
    wallpaperGrid: null
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
  // Remember policy (see isRememberedMode): older builds persisted screen /
  // all-screen / scrolling here — normalize to the default so New Capture
  // can't keep replaying a mode the policy no longer saves.
  if (!isRememberedMode(store.get('lastImageMode'))) store.set('lastImageMode', 'region')
  if (!isRememberedMode(store.get('lastVideoMode'))) store.set('lastVideoMode', 'region')
}

export function getSettings(): AppSettings {
  return {
    defaultSavePath: store.get('defaultSavePath'),
    theme: store.get('theme'),
    activeWorkflowId: store.get('activeWorkflowId'),
    googleDriveRefreshToken: store.get('googleDriveRefreshToken'),
    googleDriveAccessToken: store.get('googleDriveAccessToken'),
    googleDriveTokenExpiresAt: store.get('googleDriveTokenExpiresAt'),
    googleDriveFolderId: store.get('googleDriveFolderId'),
    launchAtStartup: store.get('launchAtStartup'),
    historyRetentionDays: store.get('historyRetentionDays'),
    lastCaptureKind: store.get('lastCaptureKind'),
    lastImageMode: store.get('lastImageMode'),
    lastVideoMode: store.get('lastVideoMode'),
    printScreenAsCapture: store.get('printScreenAsCapture'),
    printScreenPromptShown: store.get('printScreenPromptShown'),
    wallpaperCategories: store.get('wallpaperCategories'),
    wallpaperCustomCategories: store.get('wallpaperCustomCategories'),
    wallpaperGrid: store.get('wallpaperGrid')
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
