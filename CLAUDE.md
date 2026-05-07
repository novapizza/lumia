# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lumia?

Lumia is a cross-platform Electron desktop app for screen capture, screen recording, annotation, and sharing (Windows + macOS). Built with Electron 33, React 18, TypeScript, Tailwind CSS 4, Konva, and Tesseract.

Headline features:
- Image capture: region, active window, active monitor, fullscreen, scrolling capture
- Video recording: region / window / fullscreen with floating toolbar + visible region border
- Annotation canvas (Konva) with re-editable vector layers stored alongside originals
- Auto-blur of sensitive content (email, phone, credit-card, API key, JWT, etc.) via OCR
- Workflow pipeline: after-capture → upload → after-upload, configurable per template
- Built-in uploaders: Cloudflare R2 (baked credentials) and Google Drive (OAuth)
- System tray, global hotkeys, launch-at-startup, auto-update via Cloudflare R2

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | electron-vite dev (renderer at localhost:5173, main + preload hot-reload) |
| `pnpm build` | Compile main, preload, and renderer to `out/` |
| `pnpm preview` | Preview production build without packaging |
| `pnpm build:win` | Build + package Windows NSIS installer (x64 + arm64) into `release/` |
| `pnpm build:mac` | Build + package macOS DMG (x64 + arm64) into `release/` |
| `pnpm icons` | Regenerate platform icon sets from `resources/icon.png` |

`postinstall` runs `electron-builder install-app-deps` automatically. `preinstall` enforces pnpm.

There is **no test framework, linter, or formatter** configured. Type-check via `pnpm build`.

### Releases

Releases are produced by **GitHub Actions** (`.github/workflows/release.yml`), not local scripts. Both `build:win` and `build:mac` skip code-signing locally (`CSC_IDENTITY_AUTO_DISCOVERY=false`); CI provides certs via repo secrets:
- Windows: `WIN_CSC_LINK` (base64 .pfx) + `WIN_CSC_KEY_PASSWORD`
- macOS: `CSC_LINK` (base64 .p12) + `CSC_KEY_PASSWORD`, plus `APPLE_*` env vars for notarization

`build/notarize.cjs` exits cleanly when notarization credentials are absent (so local unsigned builds still succeed). Published artifacts go to a Cloudflare R2 bucket served at `https://release.lumia.asia` (S3 publisher uploads, `generic` provider for client downloads). `electron-updater` polls `latest.yml` / `latest-mac.yml` from that origin every 4 hours. The 1.2.x line published to GitHub Releases as well; 2.0.0+ is R2-only — see `electron-builder.cjs` for the publish array.

## Architecture

### Process Model (Electron)

- **Main**: `electron/index.ts` — app lifecycle, all `BrowserWindow` factories, autoUpdater wiring, top-level IPC. ~75 total `ipcMain.handle` calls split across `index.ts`, `capture.ts`, `video.ts`, and `scroll-capture.ts`.
- **Preload**: `electron/preload/index.ts` — single `contextBridge.exposeInMainWorld('electronAPI', {...})` whitelist
- **Renderer**: `src/` — React SPA with hash routing

`contextIsolation: true`, `nodeIntegration: false` everywhere. All renderer↔main traffic flows through the preload bridge.

**Adding a new IPC channel**: update three places in order, otherwise TS will fail at the call site:
1. The relevant setup module (`electron/index.ts`, `capture.ts`, `video.ts`, etc.) — add `ipcMain.handle('channel-name', ...)`
2. `electron/preload/index.ts` — add the method to the `contextBridge` whitelist
3. `src/electron.d.ts` — add the TypeScript signature to `Window.electronAPI`

### Main Process Modules (`electron/`)

| File | Responsibility |
|------|---------------|
| `index.ts` | App lifecycle, main + multi-display overlay window factories, autoUpdater, top-level IPC |
| `capture.ts` | desktopCapturer wrapper for image modes; auto-saves originals to `~/Pictures/Lumia/` |
| `video.ts` | Recording orchestrator — RecorderHost, RecordingToolbar, RecordingBorder windows, getUserMedia stream lifecycle, save-to-disk |
| `scroll-capture.ts` | Scrolling screenshot — multi-frame scroll loop with FFT-based overlap detection (`fft.js`) |
| `hotkeys.ts` | `globalShortcut` registration, `HotkeyConfig` electron-store with schema migrations, ShareX-compatible action list |
| `tray.ts` | System tray icon + context menu |
| `notify.ts` | Single entry point for toast notifications; on Windows builds custom `toastXml` with hero image so the screenshot renders above the text |
| `workflow.ts` | `WorkflowEngine` — three-phase pipeline: after-capture → uploads (parallel) → after-upload; merges into existing history items when re-shared |
| `templates.ts` | `TemplateStore` — CRUD for workflow templates + 2 built-ins (`builtin-clipboard`, `builtin-r2`) |
| `history.ts` | `HistoryStore` — capture history persistence (max 1000 items, ~4 KB each), file-cleanup on delete |
| `settings.ts` | `AppSettings` interface + electron-store wrapper, `resolveSaveStartDir` helper |
| `startup.ts` | Launch-at-startup OS integration; `wasLaunchedAtStartup()` for `--hidden` boot |
| `thumbnail.ts` | Downscaled PNG thumbnail used by history rows + toast hero |
| `watermark.ts` | Stamps the Lumia logo onto every screenshot (applied in `capture.ts`) |
| `ocr.ts` | Tesseract.js OCR (`eng.traineddata` ships at repo root); on macOS the Swift `helpers/ocr-vision` binary is used when available |
| `auto-blur.ts` | Combines OCR + sensitive-detect to return regions + apply pixelated blur |
| `sensitive-detect.ts` | Regex/heuristic patterns for `SensitiveCategory` (email, phone, CC, SSN, API key, JWT, private-key, password, bearer-token, IP, URL credentials) |
| `native-input.ts` | Win32 input via koffi FFI — `SetCursorPos`, `mouse_event`, `keybd_event`, `SendMessageW`. Replaces PowerShell-based scroll/key sim (~0 ms vs ~200–500 ms cold start). Windows-only |
| `types.ts` | Shared interfaces: `WorkflowTemplate`, `HistoryItem`, `AnnotationObject`, `OcrWord`, `SensitiveRegion`, `AutoBlurSettings` |
| `utils.ts` | `localTimestamp()` formatter for filenames |
| `uploaders/r2.ts` | Cloudflare R2 (S3-compatible) — credentials baked at build time via `MAIN_VITE_R2_*` |
| `uploaders/googledrive.ts` | Google Drive OAuth uploader with auto-refresh token handling |
| `helpers/ocr-vision` | Compiled Swift binary for macOS Vision-framework OCR (`.swift` source alongside) |
| `helpers/scroll-helper.swift` | macOS scroll-event helper (counterpart to Win32 `native-input`) |

### Renderer (`src/`)

- **Entry**: `src/main.tsx` → `HashRouter`
- **Layout**: `App.tsx` wraps standard routes with `TitleBar` + `Sidebar`. The `/editor` route runs full-width (its own toolbars replace the sidebar).
- **Routes** (each in `src/windows/<route>/<Pascal>.tsx`):
  - `/dashboard` — capture launcher + history grid (legacy `/history` redirects here)
  - `/editor` — annotation editor for both image and video (legacy `/video-annotator` redirects here)
  - `/workflow` — template manager
  - `/settings` — preferences + Google Drive auth + auto-blur config
  - **Standalone windows** (no sidebar/titlebar, transparent where applicable):
    - `/overlay` — region/window/monitor picker for both capture and recording
    - `/recording-toolbar` — floating Pause/Stop/Mic toolbar during a recording
    - `/recording-border` — border outline drawn around the recorded region
    - `/recorder-host` — hidden window that owns `MediaRecorder` and writes blobs
- **Drawing**: `components/AnnotationCanvas/Canvas.tsx` — Konva stage; `tools.ts` defines the pen/shape/text/blur/select union; `ToolBar.tsx` is the in-canvas tool picker
- **Shared components**: `Sidebar`, `TitleBar`, `AppMenu`, `ShareDialog`, `AutoBlurPanel`, `BackgroundPanel`, `HistoryListRow`, `ScrollCaptureDialog`, `UpdateNotification`, `AboutDialog`, `ReleaseNotesDialog`, `WorkflowSelector`, `DateGroupedGrid`
- **Hooks**: `hooks/useHistory.ts`, `hooks/useLocalVideoUrl.ts`
- **Action helpers**: `lib/history-actions.ts`, `lib/workflow-actions.ts` — pure functions wrapping `electronAPI` calls so views stay slim
- **State passing**: React Router `location.state` (e.g., captured `dataUrl` / `historyId` handed to the editor)

### Window Management

- **Main window**: 1250×700 (min 900×600), frameless, `#07070b` background. macOS uses `hiddenInset` titlebar with traffic lights at `{x:18, y:20}`; Windows uses native overlay controls (`titleBarOverlay`).
- **Overlay windows**: One transparent fullscreen `BrowserWindow` per display, `alwaysOnTop: 'pop-up-menu'`, `setVisibleOnAllWorkspaces(true)`. A 100 ms cursor-poll switches the "active" overlay as the cursor moves between displays; inactive overlays use `setIgnoreMouseEvents(true, { forward: true })` to pass clicks through to the active one. The `overlay:drawing` IPC locks the active display while the user is drawing a region so the cursor poll can't yank focus mid-drag.
- **Recording windows**: `RecorderHost` (hidden, owns the stream), `RecordingToolbar` (floating controls), `RecordingBorder` (visual outline) — all created and torn down by `video.ts`.
- **Close behavior**: clicking close on the main window hides to tray; on `/editor` it instead navigates back to `/dashboard` (X is "discard capture" there). Real quit only via tray menu / `ExitLumia` hotkey / explicit `markQuitting()`.
- **Single-instance lock**: `app.requestSingleInstanceLock()` prevents Chromium cache lock errors when relaunching while the tray instance is still alive.

### Persistence (electron-store)

Four isolated stores under the OS userData dir:
- `settings.json` — `AppSettings` (theme, default save path, active workflow, Google Drive tokens, last capture mode/kind, history retention)
- `templates.json` — user workflow templates (built-ins are code-defined, never persisted)
- `history.json` — capture history (capped at 1000 entries; thumbnails inline as data URLs)
- `hotkeys.json` — `HotkeyConfig` with `schemaVersion` for forward migrations of capture-mode bindings

### Workflow pipeline

1. **Capture** — image or video. Originals always saved to `~/Pictures/Lumia/capture-{timestamp}.{ext}` (not user-configurable). The `Save` button in the editor opens a Save-As dialog that writes a *separate* file via `runInlineAction('save')`.
2. **after-capture** steps: `annotate` (opens editor), `clipboard`, `save` (with empty `path` = surface a Save button only, don't auto-save).
3. **Upload** — destinations run in parallel via `Promise.allSettled`. Currently `r2` and `google-drive`.
4. **after-upload** steps: `copyUrl` (first/all), `openUrl`, `osShare`, `notify`.
5. **History merge** — when a workflow runs against an existing `historyId` (re-share from history), uploads merge by destination instead of creating a duplicate row.

### Hotkey defaults (Ctrl+Shift+…)

`1` Region · `2` Active Window · `3` Active Monitor · `4` Full Screen · `5` Scrolling · `6` Record Region · `7` Record Window · `8` Record Screen

`HOTKEY_SCHEMA_VERSION` (currently 5) gates capture/recorder defaults migration; user-customized app-level bindings are preserved across bumps. Removed actions are stripped via `REMOVED_ACTIONS`.

### Design System — Liquid Glass

Custom CSS design tokens in `src/index.css`. Key utility classes: `.glass-refractive`, `.liquid-glass`, `.card-organic`, `.glass-card`. Manrope (headlines) + Inter (body) + Material Icons. Light/dark theme toggled via `html.light` class and synced to the Windows `titleBarOverlay` via `titlebar:setTheme` IPC.

### Build Tooling

- **electron-vite** compiles three targets (main / preload / renderer) — see `electron.vite.config.ts`
- `node-windows-ocr` is marked `external` in main rollup; loaded only on Windows
- **Path alias**: `@/` → `src/` (renderer only)
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin
- **electron-builder** packages to `release/`. Output: NSIS for Windows (x64 + arm64), DMG for macOS (x64 + arm64). `koffi` is `asarUnpack`ed so the FFI loader can read its native binaries at runtime.
- `extraResources`: `resources/tray/*.{png,ico}` copied to `tray/` so the tray module finds icons in packaged builds.

## Platform-Specific Notes

- **Windows**:
  - WGC (Windows Graphics Capture) enabled via `--enable-features=WindowsNativeGraphicsCapture` for pixel-perfect screenshots
  - `setAppUserModelId('com.lumia.app')` must match `appId` in builder config — WinRT silently drops toasts otherwise
  - Mixed-DPI displays: `win.setBounds(displayBounds)` after construction to fix overlay placement on secondary monitors
  - Frameless with native `titleBarOverlay`; tray + global shortcuts via Electron defaults
  - Native input simulation via koffi FFI (no PowerShell)
- **macOS**:
  - Hidden inset title bar, traffic lights at `(18, 20)`
  - Universal builds (arm64 + x64); Graphics/Design app category; hardened runtime + entitlements via `build/entitlements.mac.plist`
  - OCR via the bundled Swift `ocr-vision` binary (Vision framework) when available, falling back to Tesseract
  - Notarization is gated on `APPLE_*` env vars; `notarize.cjs` skips gracefully when absent
- **Capture timing**: `HIDE_DELAY_MS` is 250 ms on macOS / 200 ms on Windows after hiding overlay/main windows, plus a 120 ms `OVERLAY_GONE_DELAY_MS`, before requesting frames — ensures a clean screen capture.
- **Auto-update**: `electron-updater` polls `emtyty/lumia` every 4 hours in production builds; `autoDownload` and `autoInstallOnAppQuit` are on. Status events surface in the renderer via `update:status` and the `UpdateNotification` component.

## Environment Variables

`MAIN_VITE_*` vars are baked into the main bundle at build time (loaded from `.env` by electron-vite). See `.env.example`:
- `MAIN_VITE_R2_ACCOUNT_ID`, `MAIN_VITE_R2_ACCESS_KEY_ID`, `MAIN_VITE_R2_SECRET_ACCESS_KEY`, `MAIN_VITE_R2_BUCKET`, `MAIN_VITE_R2_PUBLIC_URL`
- `MAIN_VITE_GDRIVE_CLIENT_ID`, `MAIN_VITE_GDRIVE_CLIENT_SECRET`

These are **not** user-facing settings — distributing the app means embedding R2/Drive credentials in the bundle. Per-user state (refresh tokens, folder IDs) lives in `settings.json`.
