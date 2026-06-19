# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Lumia?

Lumia is a cross-platform Electron desktop app for screen capture, screen recording, annotation, and sharing (Windows + macOS). Built with Electron 33, React 18, TypeScript, Tailwind CSS 4, and Konva.

Headline features:
- Image capture: region, active window, active monitor, fullscreen, scrolling capture. The screen is **frozen at hotkey time** (native GDI snapshot on Windows) so captures preserve transient UI like tooltips/popovers
- Video recording: region / window / fullscreen with floating toolbar + visible region border, plus a live drawing overlay during recording; output WebM is remuxed seekable via bundled ffmpeg
- Annotation canvas (Konva) with re-editable vector layers stored alongside originals, R2-hosted stickers, and Unsplash background/wallpaper images
- Workflow pipeline: after-capture → upload → after-upload, configurable per template
- Built-in uploaders: Cloudflare R2 (baked credentials, streaming multipart) and Google Drive (OAuth, with a Google Picker folder browser)
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

- **Main**: `electron/index.ts` — app lifecycle, all `BrowserWindow` factories, autoUpdater wiring, top-level IPC. `ipcMain.handle` calls are split across `index.ts`, `capture.ts`, `video.ts`, `scroll-capture.ts`, `stickers.ts`, `wallpapers.ts`, and `annotation.ts`.
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
| `capture.ts` | desktopCapturer wrapper for image modes; auto-saves originals to `~/Pictures/Lumia/`. Freezes all displays at hotkey time (`freezeAllDisplays`, fast GDI path on Windows), hands the overlay raw BGRA for instant render, and PNG-encodes only on confirm. Tags PNG captures with the display's ICC profile |
| `native-screen.ts` | Windows-only fast screen capture via GDI BitBlt (koffi FFI) — ~5–20 ms/display vs desktopCapturer. Powers the freeze-at-hotkey snapshot; `prewarmNativeCapture()` runs at startup to dodge cold-start. No macOS equivalent (falls back to desktopCapturer) |
| `display-icc.ts` | Reads the OS-attached ICC profile for a display (Windows via GDI `GetICMProfileW`; macOS via a Swift `get-display-icc` helper). Per-display cache invalidated on display changes |
| `png-icc.ts` | Hand-rolled PNG `iCCP` chunk insert/extract — embeds the display ICC profile into captured PNGs and copies it onto downstream flattened/annotated PNGs |
| `video.ts` | Recording orchestrator — RecorderHost, RecordingToolbar, RecordingBorder, annotation-overlay windows, getUserMedia stream lifecycle. Receives the recording blob in bounded ~16 MB IPC slices (`recorder:save-begin`/`save-chunk`/`save-end`), writes to `~/Pictures/Lumia/recording-{timestamp}.webm`, then calls `remuxWebmInPlace` to make it seekable. Serves local media to the renderer via the `lumia-media://` protocol with HTTP Range/206 support |
| `ffmpeg-remux.ts` | `remuxWebmInPlace(path)` — runs bundled ffmpeg `-c copy` (lossless) to rebuild Cues/Duration so MediaRecorder WebM becomes seekable; atomic temp-file replace. Replaced the old in-renderer `ts-ebml`/`webm-seekable.ts` approach (both removed) |
| `annotation.ts` | Live drawing overlay during video recording — fullscreen click-capturing Konva canvas synced to the recording toolbar. IPC: `annotation:get-state`, `annotation:set-tool`, `annotation:set-color`, `annotation:set-stroke`, `annotation:clear`, `annotation:undo`, `annotation-overlay:set-interactive` |
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
| `native-input.ts` | Win32 input via koffi FFI — `SetCursorPos`, `mouse_event`, `keybd_event`, `SendMessageW`. Replaces PowerShell-based scroll/key sim (~0 ms vs ~200–500 ms cold start). Windows-only |
| `printscreen-key.ts` | Windows-only — toggles the `PrintScreenKeyForSnippingEnabled` registry value so PrintScreen reaches Lumia's global hotkey instead of the Snipping Tool (`setSnippingHijack()`) |
| `mac-window-pick.ts` | macOS window picker — long-running Swift `window-at-point` helper queries CoreGraphics for the topmost non-Lumia window under the cursor to drive overlay hover highlighting |
| `permissions.ts` | OS-level permission preflight (Screen Recording, Accessibility, Microphone); surfaces native prompts at startup and watches for grants |
| `stickers.ts` | R2-hosted sticker catalog — fetches `stickers.json` manifest (1-hour in-memory TTL + cache-bust query param) and individual PNGs, disk-caches them under `userData/sticker-cache/`, returns same-origin data URLs. IPC: `stickers:manifest`, `stickers:fetch`. Base URL from `MAIN_VITE_STICKERS_BASE_URL` (public bucket, no creds) |
| `wallpapers.ts` | Unsplash wallpaper browser — fetch random wallpapers, download to `userData/wallpapers/`, set as desktop wallpaper. IPC: `wallpapers:random`, `wallpapers:trackDownload`, `wallpapers:isConfigured`, `wallpapers:setAsWallpaper`. Needs `MAIN_VITE_UNSPLASH_ACCESS_KEY` |
| `types.ts` | Shared interfaces: `WorkflowTemplate`, `HistoryItem`, `AnnotationObject` |
| `utils.ts` | `localTimestamp()` formatter for filenames |
| `uploaders/r2.ts` | Cloudflare R2 (S3-compatible) — credentials baked at build time via `MAIN_VITE_R2_*`. `uploadToR2()` single-PUTs buffered image data URLs; `uploadFileToR2()` streams on-disk files (recordings) — hashes for HEAD dedup, single-PUT below the 16 MB `MULTIPART_THRESHOLD`, else parallel multipart (8 MB parts × 6 workers → ~48 MB peak regardless of file size) |
| `uploaders/googledrive.ts` | Pure Google Drive HTTP layer — folder lookup/create, multipart image upload, resumable file upload streamed in 1 MB chunks with backpressure, OAuth token exchange/refresh/revoke |
| `google-drive-service.ts` | Drive orchestration over `uploaders/googledrive.ts` — token lifecycle (auto-refresh with 60 s margin, dedup concurrent refreshes, retry on 401), folder resolution, errors surfaced as `UploadResult`. Entry points: `uploadImageDataUrlToDrive()`, `uploadFilePathToDrive()` |
| `helpers/scroll-helper.swift` | macOS scroll-event helper (counterpart to Win32 `native-input`) |
| `helpers/get-display-icc.swift` | macOS helper returning a display's ICC profile bytes (used by `display-icc.ts`) |
| `helpers/window-at-point.swift` | macOS helper returning the topmost non-Lumia window under the cursor (used by `mac-window-pick.ts`) |

### Renderer (`src/`)

- **Entry**: `src/main.tsx` → `HashRouter`
- **Layout**: `App.tsx` wraps standard routes with `TitleBar` + `Sidebar`. The `/editor` route runs full-width (its own toolbars replace the sidebar).
- **Routes** (each in `src/windows/<route>/<Pascal>.tsx`):
  - `/dashboard` — capture launcher + history grid (legacy `/history` redirects here)
  - `/editor` — annotation editor for both image and video (legacy `/video-annotator` redirects here)
  - `/workflow` — template manager
  - `/settings` — preferences + Google Drive auth
  - **Standalone windows** (no sidebar/titlebar, transparent where applicable):
    - `/overlay` — region/window/monitor picker for both capture and recording
    - `/recording-toolbar` — floating Pause/Stop/Mic toolbar during a recording
    - `/recording-border` — border outline drawn around the recorded region
    - `/recorder-host` — hidden window that owns `MediaRecorder` and writes blobs
- **Drawing**: `components/AnnotationCanvas/Canvas.tsx` — Konva stage; `tools.ts` defines the pen/shape/text/blur/sticker/select union; `ToolBar.tsx` is the in-canvas tool picker. Sticker objects store the manifest-relative path in `DrawObject.src` (not a data URL) so `history.json` stays small; the path resolves to a cached data URL at render time
- **Shared components**: `Sidebar`, `TitleBar`, `AppMenu`, `ShareDialog`, `BackgroundPanel`, `StickerPicker`, `HistoryListRow`, `ScrollCaptureDialog`, `UpdateNotification`, `AboutDialog`, `WorkflowSelector`, `DateGroupedGrid` (the `ReleaseNotesDialog` / "What's New" dialog was removed)
- **Hooks**: `hooks/useHistory.ts`, `hooks/useLocalVideoUrl.ts`
- **Action helpers**: `lib/history-actions.ts`, `lib/workflow-actions.ts` — pure functions wrapping `electronAPI` calls so views stay slim
- **State passing**: React Router `location.state` (e.g., captured `dataUrl` / `historyId` handed to the editor)

### Window Management

- **Main window**: 1250×700 (min 900×600), frameless, `#07070b` background. macOS uses `hiddenInset` titlebar with traffic lights at `{x:18, y:20}`; Windows uses native overlay controls (`titleBarOverlay`).
- **Overlay windows**: One transparent fullscreen `BrowserWindow` per display, `alwaysOnTop: 'pop-up-menu'`, `setVisibleOnAllWorkspaces(true)`. A 100 ms cursor-poll switches the "active" overlay as the cursor moves between displays; inactive overlays use `setIgnoreMouseEvents(true, { forward: true })` to pass clicks through to the active one. The `overlay:drawing` IPC locks the active display while the user is drawing a region so the cursor poll can't yank focus mid-drag.
- **Recording windows**: `RecorderHost` (hidden, owns the stream), `RecordingToolbar` (floating controls), `RecordingBorder` (visual outline), and a fullscreen annotation overlay (`annotation.ts`, toggled interactive via `annotation-overlay:set-interactive`) — all created and torn down by `video.ts`.
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
- **Path alias**: `@/` → `src/` (renderer only)
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin
- **electron-builder** packages to `release/`. Output: NSIS for Windows (x64 only — Windows-on-ARM runs it via emulation), DMG for macOS (x64 + arm64). `koffi` is `asarUnpack`ed so the FFI loader can read its native binaries at runtime; the `files` array drops koffi's prebuilt binaries for platforms we never package (keeps only win32_x64 + darwin_x64/arm64).
- `extraResources`: `resources/tray/*.{png,ico}` copied to `tray/` so the tray module finds icons in packaged builds.
- **ffmpeg**: the afterPack hook (`build/embed-ffmpeg.cjs`) embeds a per-arch ffmpeg into Resources. On Windows it prefers a **minimal matroska-only build** (~2.5 MB vs ffmpeg-static's ~82 MB) — cross-compiled with mingw-w64 via `build/build-minimal-ffmpeg-win.sh` (locally: `pnpm ffmpeg:min:win` → Docker; in CI: the `ffmpeg-win` job uploads it as an artifact that `release-win` downloads to `build/minimal-ffmpeg/dist/`). Falls back to the full ffmpeg-static download when the minimal binary isn't staged. macOS still uses the full per-arch ffmpeg-static binary.

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
  - Notarization is gated on `APPLE_*` env vars; `notarize.cjs` skips gracefully when absent
- **Capture timing**: `HIDE_DELAY_MS` is 250 ms on macOS / 200 ms on Windows after hiding overlay/main windows, plus a 120 ms `OVERLAY_GONE_DELAY_MS`, before requesting frames — ensures a clean screen capture.
- **Auto-update**: `electron-updater` polls the Cloudflare R2 origin (`generic` provider, defaulting to `https://release.lumia.asia` — `latest.yml` / `latest-mac.yml`) every 4 hours in production builds; `autoDownload` and `autoInstallOnAppQuit` are on. Status events surface in the renderer via `update:status` and the `UpdateNotification` component.

## Environment Variables

`MAIN_VITE_*` vars are baked into the main bundle at build time (loaded from `.env` by electron-vite). See `.env.example`:
- `MAIN_VITE_R2_ACCOUNT_ID`, `MAIN_VITE_R2_ACCESS_KEY_ID`, `MAIN_VITE_R2_SECRET_ACCESS_KEY`, `MAIN_VITE_R2_BUCKET`, `MAIN_VITE_R2_PUBLIC_URL`
- `MAIN_VITE_STICKERS_BASE_URL` — public base URL of the bucket hosting `stickers.json` + sticker PNGs (no credentials; optional, falls back to a baked-in default)
- `MAIN_VITE_GDRIVE_CLIENT_ID`, `MAIN_VITE_GDRIVE_CLIENT_SECRET` — Google Drive OAuth
- `MAIN_VITE_GDRIVE_API_KEY`, `MAIN_VITE_GDRIVE_PROJECT_NUMBER` — Google Picker API (in-app Drive folder browser)
- `MAIN_VITE_UNSPLASH_ACCESS_KEY` — Unsplash API for the in-app Wallpapers browser

These are **not** user-facing settings — distributing the app means embedding R2/Drive credentials in the bundle. Per-user state (refresh tokens, folder IDs) lives in `settings.json`.
