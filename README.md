# Lumia

A cross-platform screen capture, screen recording, annotation, and sharing tool for **Windows** and **macOS** — built with Electron, React, and TypeScript.

Inspired by ShareX, rebuilt from scratch with a modern Liquid Glass UI, scrolling capture (browser-extension-assisted or classic screen scroll), video recording, and a workflow engine that runs uploads in true parallel.

## Download

**[lumia.asia](https://lumia.asia)** — installer download for Windows (x64 — Windows-on-ARM runs it via built-in emulation) and macOS (Apple Silicon + Intel). Auto-update is built in; you only need to fetch the installer once.

---

## Features

### Image Capture

| Mode | Default Shortcut |
|---|---|
| Region (drag to select) | `Ctrl+Shift+1` |
| Active Window | `Ctrl+Shift+2` |
| Active Monitor | `Ctrl+Shift+3` |
| Full Screen | `Ctrl+Shift+4` |

Every shortcut uses `Ctrl+Shift` (no conflicts with macOS `Cmd+Shift` system bindings) and is rebindable in Settings. Originals are auto-saved to `~/Pictures/Lumia/`; user-chosen Save-As locations are kept separate so the original is never overwritten.

**Frozen at hotkey time** — the screen is snapshotted the instant the hotkey fires (native GDI capture on Windows, ~5–20 ms per display; warm ScreenCaptureKit snapshot on macOS 14+), so transient UI like tooltips, popovers, and open menus survives into the capture instead of vanishing when the overlay appears.

**Color-managed** — captures are tagged with the display's ICC profile (PNG `iCCP` chunk), so colors stay correct on wide-gamut monitors; annotated and flattened exports inherit the profile.

**Multi-display aware**: one transparent overlay per monitor; cursor movement between displays seamlessly switches the active one.

### Scrolling Capture

Its own capture kind beside Image and Video — started from the Dashboard's Scroll tab or the browser extension's toolbar button (no global hotkey). Two methods:

- **Browser Extension** — a companion extension for Chromium browsers (`extension/` in this repo; also shipped inside the app's Resources for load-unpacked). It reports **exact DOM scroll offsets** to the app over a localhost WebSocket bridge, so stitching is a plain buffer copy — no overlap guessing. Handles lazy-loading pages, sticky headers, and inner-pane apps (Gmail / Drive / Docs, where only a middle `<div>` scrolls — page chrome is composited from the first frame instead of cropped away). The extension's toolbar popup offers three modes: **viewport** (one frame), **full page** (scroll + stitch), and **region** (in-page element picker with keyboard DOM navigation, iframe-aware). With several browsers connected, the app shows a picker with live tab previews.
- **Screen Scroll** — the classic method that works on any app: synthetic wheel events (Win32 koffi FFI on Windows, Swift helper on macOS) drive a multi-frame scroll loop stitched with FFT-based overlap detection — the same technique ShareX uses.

### Video Recording

| Mode | Default Shortcut |
|---|---|
| Record Region | `Ctrl+Shift+6` |
| Record Window | `Ctrl+Shift+7` |
| Record Screen | `Ctrl+Shift+8` |

While recording, a floating toolbar offers Pause / Resume / Mic toggle / Stop / Cancel, a thin border outlines the recorded region, and a **live drawing overlay** lets you draw arrows, shapes, and pen strokes on screen mid-recording. Pressing any record hotkey while a recording is active stops it (Snipping Tool-style toggle). Microphone is pre-acquired so the toggle is instant; recordings save as `.webm` and are losslessly remuxed with a bundled minimal ffmpeg (~2.5 MB) so they're seekable with a correct duration.

### Annotation Editor

Konva-powered canvas, opens automatically after capture (or by clicking any screenshot in history). Re-editable: each shape is stored as a vector and replayed on next open.

- **Pen** — freehand with smoothing
- **Rectangle / Ellipse / Arrow**
- **Text** — click to place inline input
- **Blur** — pixelate sensitive areas
- **Sticker** — hosted sticker catalog, disk-cached locally
- **Cursor** — select, move, and delete annotations
- **Backgrounds** — frame the shot on a wallpaper / background image
- Auto-fit to viewport; export at full natural resolution
- Native undo/redo, with each replayed annotation as its own undo step

### Workflow Engine

Templates define the full pipeline for every capture:

```
After Capture     →     Upload (parallel)     →     After Upload
─────────────           ─────────────────           ──────────────
annotate                Cloudflare R2               copy URL (first / all)
clipboard               Google Drive                open URL
save to disk                                        OS share
                                                    notify
```

- Multi-destination uploads run in parallel via `Promise.allSettled` — one failure never blocks the others
- Two built-in templates ship by default (**Copy to Clipboard**, **Annotate & Share Link**); create unlimited custom templates
- Set any template as **active** — that's what the editor's Share button uses
- Re-sharing from history merges new uploads into the existing entry instead of duplicating it

### Sharing Destinations

- **Cloudflare R2** (S3-compatible) with shareable public URLs — credentials baked into the build; on-disk files stream via parallel multipart upload
- **Google Drive** with OAuth flow + auto-refresh tokens — per-user, configured in Settings (includes a Google Picker folder browser)
- **Clipboard** (image bytes or URL)
- **Save to disk** (PNG / WebM, opens Save-As dialog with last-used folder remembered)
- **OS native share sheet** (macOS / Windows)

### History

- Every capture saved with thumbnail, timestamp, type (screenshot / recording), and upload status
- Up to 1000 entries; thumbnails inline so the grid is instant
- Click a screenshot → opens in the annotation editor (with previous annotations replayed)
- Click a recording → opens in the editor for playback; Save / Copy / Upload act on the recording file directly
- Detects missing files and offers a one-click cleanup

### System Integration

- **System tray** with capture shortcuts and quit
- **Launch at startup** — auto-hides to tray on boot when launched by the OS startup entry
- **PrintScreen key takeover** (Windows) — optionally routes the PrintScreen key to Lumia instead of the Snipping Tool
- **Auto-update** — polls `release.lumia.asia` every 4 hours; downloads in background, installs on quit
- **Single-instance lock** — relaunching focuses the existing window instead of crashing on cache locks

### Settings

- Default save path · Theme (dark / light / system, syncs Windows native title-bar overlay colors)
- Active workflow · Hotkey rebinding for every action
- Google Drive connect/disconnect · Default Drive folder
- History retention (auto-delete entries older than N days)
- Launch at startup

---

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron 42 |
| Build system | electron-vite 5 |
| UI | React 19 + TypeScript |
| Routing | React Router 7 (hash mode) |
| Canvas / Annotation | Konva 10 + react-konva |
| Styling | Tailwind CSS 4 + Liquid Glass design system |
| Native interop | koffi FFI to user32/gdi32 (Windows) · compiled Swift helpers (macOS) |
| Extension bridge | ws — localhost WebSocket server for the scroll-capture extension |
| Scroll stitching | fft.js — FFT-based overlap detection (screen-scroll method) |
| Video remux | bundled minimal ffmpeg (matroska-only, ~2.5 MB) |
| Logging / Auto-update | electron-log + electron-updater |
| Persistence | electron-store 11 |
| Packaging | electron-builder |
| Package manager | pnpm 10 (enforced via `preinstall`) |

---

## Project Structure

```
lumia/
├── electron/                       # Main process (Node)
│   ├── index.ts                    # Lifecycle, main + overlay window factories, IPC
│   ├── preload/index.ts            # contextBridge — exposes electronAPI to renderer
│   ├── capture.ts                  # Image capture — freeze-at-hotkey, ICC tagging, auto-save
│   ├── native-screen.ts            # Fast native snapshots (Windows GDI BitBlt via koffi)
│   ├── mac-screen-snap.ts          # macOS 14+ ScreenCaptureKit fast-screenshot client
│   ├── display-icc.ts              # Reads the OS-attached ICC profile per display
│   ├── png-icc.ts                  # PNG iCCP chunk insert/extract
│   ├── icc-to-srgb.ts              # ICC parser + BGRA→sRGB conversion (extension captures)
│   ├── video.ts                    # Recording orchestrator + toolbar/border/overlay windows
│   ├── ffmpeg-remux.ts             # Lossless remux → seekable WebM (bundled ffmpeg)
│   ├── annotation.ts               # Live drawing overlay during recording
│   ├── scroll-capture.ts           # Screen-scroll stitching (FFT overlap) + scroll entry point
│   ├── extension-bridge.ts         # WebSocket bridge + stitchers for the browser extension
│   ├── hotkeys.ts                  # globalShortcut registry + schema migrations
│   ├── printscreen-key.ts          # Windows PrintScreen-key takeover (registry toggle)
│   ├── tray.ts                     # System tray icon + menu
│   ├── notify.ts                   # Toast notifications with hero image
│   ├── workflow.ts                 # WorkflowEngine — three-phase pipeline
│   ├── templates.ts                # Built-in + user template CRUD
│   ├── history.ts                  # Capture history persistence
│   ├── settings.ts                 # AppSettings electron-store wrapper
│   ├── startup.ts                  # Launch-at-startup integration
│   ├── stickers.ts                 # Hosted sticker catalog + disk cache
│   ├── wallpapers.ts               # Wallpaper browser + set-as-desktop-wallpaper
│   ├── native-input.ts             # Win32 koffi FFI input simulation (Windows-only)
│   ├── window-list.ts              # Cross-platform window enumeration for the picker
│   ├── mac-window-pick.ts          # macOS window-under-cursor helper client
│   ├── permissions.ts              # OS permission preflight (Screen Recording, Mic, …)
│   ├── google-drive-service.ts     # Drive token lifecycle + upload orchestration
│   ├── watermark.ts                # Lumia logo stamp on captures
│   ├── thumbnail.ts                # Downscaled PNG thumbnail
│   ├── helpers/                    # Swift helpers (macOS), compiled in CI
│   │   ├── screen-snap.swift       # ScreenCaptureKit fast screenshots
│   │   ├── window-at-point.swift   # Window under cursor / window list
│   │   ├── get-display-icc.swift   # Display ICC profile bytes
│   │   └── scroll-helper.swift     # Scroll event synthesis
│   └── uploaders/
│       ├── r2.ts                   # Cloudflare R2 (S3-compatible, streaming multipart)
│       └── googledrive.ts          # Google Drive HTTP layer (OAuth, resumable upload)
├── extension/                      # Companion browser extension (scroll capture)
│   ├── manifest.json · background.js · popup.html · popup.js
├── src/                            # Renderer (React)
│   ├── main.tsx                    # React entry — HashRouter
│   ├── App.tsx                     # Layout + route table
│   ├── index.css                   # Liquid Glass tokens + light/dark mode
│   ├── electron.d.ts               # Window.electronAPI type declarations
│   ├── types.ts                    # Renderer types
│   ├── hooks/                      # useHistory, useLocalVideoUrl
│   ├── lib/                        # history-actions, workflow-actions
│   ├── components/
│   │   ├── TitleBar · Sidebar · AppMenu
│   │   ├── ShareDialog · WorkflowSelector
│   │   ├── BackgroundPanel · StickerPicker
│   │   ├── HistoryListRow · DateGroupedGrid
│   │   ├── ScrollCaptureDialog · BrowserPickerDialog
│   │   ├── UpdateNotification · AboutDialog · PrintScreenPromptDialog
│   │   └── AnnotationCanvas/
│   │       ├── Canvas.tsx          # Konva stage — all drawing tools
│   │       ├── ToolBar.tsx         # In-canvas tool picker
│   │       └── tools.ts            # Tool union types
│   └── windows/                    # Routed views — one folder per route
│       ├── dashboard/Dashboard.tsx           # Capture launcher (Image/Video/Scroll) + history grid
│       ├── editor/Editor.tsx                 # Image annotation + video playback
│       ├── workflow/Workflow.tsx             # Template manager
│       ├── wallpapers/Wallpapers.tsx         # Wallpaper browser
│       ├── settings/Settings.tsx             # Preferences
│       ├── overlay/Overlay.tsx               # Region/window/monitor picker
│       ├── annotation-overlay/AnnotationOverlay.tsx  # Live drawing during recording
│       ├── recorder-host/RecorderHost.tsx    # Hidden — owns MediaRecorder
│       ├── recording-toolbar/RecordingToolbar.tsx
│       └── recording-border/RecordingBorder.tsx
├── resources/                      # App icons + tray icons
├── build/                          # ffmpeg build scripts, notarization, entitlements, icons
├── docs/                           # lumia.asia landing page (GitHub Pages)
├── .github/workflows/release.yml   # CI build + sign + publish
├── electron.vite.config.ts
├── electron-builder.cjs
└── package.json
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 10+ (`npm install -g pnpm`)

### Install & Run

```bash
# Install dependencies (must be pnpm — preinstall enforces it)
pnpm install

# Set up env vars (R2 + Google Drive credentials baked into builds)
cp .env.example .env
# Then fill in MAIN_VITE_R2_* and MAIN_VITE_GDRIVE_* — see .env.example
# for the optional extras (sticker bucket, Google Picker, Web Store URL)

# Start in development mode (renderer at localhost:5173, hot reload)
pnpm dev

# Bundle for production (esbuild — run tsc --noEmit for a real type-check)
pnpm build

# Package for the host platform (output in release/)
pnpm build:win   # NSIS installer (x64)
pnpm build:mac   # DMG + ZIP for x64 + arm64

# Regenerate icon sets from resources/icon.png
pnpm icons
```

### Development Notes

- Renderer runs at `http://localhost:5173`; hash routing (`/#/dashboard`, `/#/editor`, …) drives navigation
- Standalone routes (`/overlay`, `/annotation-overlay`, `/recording-toolbar`, `/recording-border`, `/recorder-host`) render without sidebar/titlebar so they can be loaded into transparent BrowserWindows
- All IPC is bridged via `contextBridge` in `preload/index.ts` — no `nodeIntegration`
- DevTools accessible via the in-app menu (≡) in dev mode; native dev menu also exposes Reload / Force Reload / Toggle DevTools
- On Windows the native min/max/close buttons (`titleBarOverlay`) recolor when toggling dark/light mode via the `titlebar:setTheme` IPC

### Adding a new IPC channel

Update three places in this order — TypeScript will fail at the call site otherwise:

1. The relevant module in `electron/` — `ipcMain.handle('my-channel', ...)`
2. `electron/preload/index.ts` — add the method to the `contextBridge` whitelist
3. `src/electron.d.ts` — add the TypeScript signature to `Window.electronAPI`

---

## Releases

Production releases are produced by **GitHub Actions** (`.github/workflows/release.yml`), not local commands. Local `build:win` / `build:mac` skip code-signing (`CSC_IDENTITY_AUTO_DISCOVERY=false`); CI signs via repo secrets:

| Platform | Signing |
|---|---|
| Windows | **Azure Trusted Signing** — `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` (auth) + `AZURE_PUBLISHER_NAME`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT_NAME`, `AZURE_CERT_PROFILE_NAME` (config — build falls back to unsigned when absent) |
| macOS | `CSC_LINK` (base64 .p12) + `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization |

`build/notarize.cjs` exits cleanly when notarization credentials are absent, so unsigned local builds still complete.

Published artifacts go to a Cloudflare R2 bucket served at **`https://release.lumia.asia`** (S3 publisher uploads, `generic` provider for client downloads — see [`electron-builder.cjs`](electron-builder.cjs)). macOS publishes both DMG (user download) and ZIP (the artifact `electron-updater` applies). Installed copies poll `latest.yml` / `latest-mac.yml` from that origin every 4 hours and install pending updates on the next quit.

The 1.2.x line was also published to GitHub Releases as a one-shot bridge so existing installs could migrate to the R2 channel; 2.0.0 onward is R2-only.

---

## Default Workflows

| Template | Pipeline |
|---|---|
| **Copy to Clipboard** | capture → copy to clipboard → notify |
| **Annotate & Share Link** | capture → annotate → save (via editor's Save button) → upload to R2 + Google Drive (parallel) → copy first URL → notify |

Built-in templates cannot be deleted. Set any template as the active workflow on the Workflow page — the active template is what the editor's Share button invokes.

---

## Design System — Liquid Glass

| Token | Value |
|---|---|
| Background | `#07070b` (deep space) |
| Primary | `#b6a0ff` (lavender) |
| Secondary | `#00e3fd` (cyan) |
| Tertiary | `#ff6c95` (pink) |
| Typography | Manrope (headlines) + Inter (body) + Material Icons |

Core rules:
- Containers translucent — `backdrop-filter: blur(40px)`, never 100% opaque
- No hard borders or dividers — tonal surface shifts and spacing only
- CTAs use a `135deg` gradient from primary → secondary, `scale(1.02)` on hover
- Shadows are refractive glows (40–80 px blur at ~6% opacity), never solid black

Light mode (`html.light` class) overrides all color variables and remaps relevant Tailwind utilities. Toggled from the sidebar, persisted to settings, and synced to the Windows native title-bar overlay colors.

---

## Platform Notes

**Windows**
- WGC (Windows Graphics Capture) enabled via `--enable-features=WindowsNativeGraphicsCapture` for pixel-perfect screenshots
- Freeze-at-hotkey snapshots via GDI BitBlt (koffi FFI, ~5–20 ms/display), prewarmed at startup; falls back to desktopCapturer
- `setAppUserModelId('com.lumia.app')` matches the NSIS shortcut AUMID — required or WinRT silently drops toasts
- Mixed-DPI displays handled with `setBounds()` after window construction (avoids overlay misplacement on secondary monitors)
- Native input simulation via koffi FFI to `user32.dll` — replaces PowerShell's ~200–500 ms cold start
- x64-only installer — Windows-on-ARM runs it via built-in emulation (a dedicated arm64 build would double installer size for little gain)

**macOS**
- Hidden inset title bar with traffic lights at `(18, 20)`
- Universal builds (arm64 + x64); `public.app-category.graphics-design`
- Fast screenshots on macOS 14+ via a long-running ScreenCaptureKit Swift helper (excludes Lumia's own windows by PID); macOS ≤ 13 falls back to desktopCapturer
- Swift helpers (`screen-snap`, `window-at-point`, `get-display-icc`, `scroll-helper`) compiled universal in CI via `build/compile-mac-helpers.sh`
- Hardened runtime + entitlements via `build/entitlements.mac.plist`

---

## License

MIT — see [LICENSE](LICENSE).
