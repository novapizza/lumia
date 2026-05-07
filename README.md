# Lumia

A cross-platform screen capture, screen recording, annotation, and sharing tool for **Windows** and **macOS** — built with Electron, React, and TypeScript.

Inspired by ShareX, rebuilt from scratch with a modern Liquid Glass UI, scrolling capture, video recording, OCR-driven auto-blur of sensitive content, and a workflow engine that runs uploads in true parallel.

## Download

**[lumia.asia](https://lumia.asia)** — installer download for Windows (x64 + arm64) and macOS (Apple Silicon + Intel). Auto-update is built in; you only need to fetch the installer once.

---

## Features

### Image Capture

| Mode | Default Shortcut |
|---|---|
| Region (drag to select) | `Ctrl+Shift+1` |
| Active Window | `Ctrl+Shift+2` |
| Active Monitor | `Ctrl+Shift+3` |
| Full Screen | `Ctrl+Shift+4` |
| Scrolling Capture | `Ctrl+Shift+5` |

Every shortcut uses `Ctrl+Shift` (no conflicts with macOS `Cmd+Shift` system bindings) and is rebindable in Settings. Originals are auto-saved to `~/Pictures/Lumia/`; user-chosen Save-As locations are kept separate so the original is never overwritten.

**Scrolling capture** stitches a tall composite from a multi-frame scroll loop with FFT-based overlap detection — the same technique ShareX uses, ported to Electron with native input simulation (Win32 koffi FFI on Windows, Swift helper on macOS) for instant scroll events.

**Multi-display aware**: one transparent overlay per monitor; cursor movement between displays seamlessly switches the active one.

### Video Recording

| Mode | Default Shortcut |
|---|---|
| Record Region | `Ctrl+Shift+6` |
| Record Window | `Ctrl+Shift+7` |
| Record Screen | `Ctrl+Shift+8` |

While recording, a floating toolbar offers Pause / Resume / Mic toggle / Stop / Cancel, and a thin border outlines the recorded region. Pressing any record hotkey while a recording is active stops it (Snipping Tool-style toggle). Microphone is pre-acquired so the toggle is instant; recordings save as `.webm` with a corrected duration header.

### Annotation Editor

Konva-powered canvas, opens automatically after capture (or by clicking any item in history). Re-editable: each shape is stored as a vector and replayed on next open.

- **Pen** — freehand with smoothing
- **Rectangle / Ellipse / Arrow / Line**
- **Text** — click to place inline input
- **Blur** — pixelate sensitive areas
- **Select** — move and reposition annotations
- Auto-fit to viewport; export at full natural resolution
- Native undo/redo, with each replayed annotation as its own undo step

### Auto-Blur

OCR scans the capture (Tesseract on Windows, native Vision framework on macOS) and detects:

- Email addresses · Phone numbers · Credit card numbers · SSNs
- API keys · JWTs · Private keys · Passwords · Bearer tokens
- IP addresses · URL credentials

Three modes: **off**, **suggest** (regions appear in the editor for one-click apply), or **auto-apply** (blurred before the editor opens). Pixelation block size is configurable (1–20).

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

- **Cloudflare R2** (S3-compatible) with shareable public URLs — credentials baked into the build
- **Google Drive** with OAuth flow + auto-refresh tokens — per-user, configured in Settings
- **Clipboard** (image bytes or URL)
- **Save to disk** (PNG / WebM, opens Save-As dialog with last-used folder remembered)
- **OS native share sheet** (macOS / Windows)

### History

- Every capture saved with thumbnail, timestamp, type (screenshot / recording), and upload status
- Up to 1000 entries; thumbnails inline so the grid is instant
- Click a recording → opens in the editor with video timeline + frame extraction
- Click a screenshot → opens in the annotation editor (with previous annotations replayed)
- Detects missing files and offers a one-click cleanup

### System Integration

- **System tray** with capture shortcuts and quit
- **Launch at startup** — auto-hides to tray on boot when launched by the OS startup entry
- **Auto-update** — polls `release.lumia.asia` every 4 hours; downloads in background, installs on quit
- **Single-instance lock** — relaunching focuses the existing window instead of crashing on cache locks

### Settings

- Default save path · Theme (dark / light / system, syncs Windows native title-bar overlay colors)
- Active workflow · Hotkey rebinding for every action
- Google Drive connect/disconnect · Default Drive folder
- Auto-blur enable + per-category toggles + intensity
- History retention (auto-delete entries older than N days)
- Launch at startup

---

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron 33 |
| Build system | electron-vite 2 |
| UI | React 18 + TypeScript |
| Routing | React Router 6 (hash mode) |
| Canvas / Annotation | Konva 9 + react-konva |
| Styling | Tailwind CSS 4 + Liquid Glass design system |
| OCR | Tesseract.js + macOS Vision framework (Swift helper) |
| Native input (Windows) | koffi FFI to user32.dll |
| Logging / Auto-update | electron-log + electron-updater |
| Persistence | electron-store 8 |
| Packaging | electron-builder |
| Package manager | pnpm 10 (enforced via `preinstall`) |

---

## Project Structure

```
lumia/
├── electron/                       # Main process (Node)
│   ├── index.ts                    # Lifecycle, main + overlay window factories, IPC
│   ├── preload/index.ts            # contextBridge — exposes electronAPI to renderer
│   ├── capture.ts                  # Image capture (region/window/monitor/fullscreen)
│   ├── video.ts                    # Recording orchestrator + RecorderHost windows
│   ├── scroll-capture.ts           # Scrolling screenshot with FFT overlap detection
│   ├── hotkeys.ts                  # globalShortcut registry + schema migrations
│   ├── tray.ts                     # System tray icon + menu
│   ├── notify.ts                   # Toast notifications with hero image
│   ├── workflow.ts                 # WorkflowEngine — three-phase pipeline
│   ├── templates.ts                # Built-in + user template CRUD
│   ├── history.ts                  # Capture history persistence
│   ├── settings.ts                 # AppSettings electron-store wrapper
│   ├── startup.ts                  # Launch-at-startup integration
│   ├── ocr.ts                      # Tesseract / Vision OCR
│   ├── auto-blur.ts                # Sensitive-region detection + pixelation
│   ├── sensitive-detect.ts         # Pattern matching (email/phone/key/JWT/...)
│   ├── native-input.ts             # Win32 koffi FFI (Windows-only)
│   ├── watermark.ts                # Lumia logo stamp on captures
│   ├── thumbnail.ts                # Downscaled PNG thumbnail
│   ├── helpers/                    # Compiled Swift helpers (macOS)
│   │   ├── ocr-vision              # Vision framework OCR binary
│   │   └── scroll-helper.swift     # macOS scroll event helper
│   └── uploaders/
│       ├── r2.ts                   # Cloudflare R2 (S3-compatible)
│       └── googledrive.ts          # Google Drive OAuth uploader
├── src/                            # Renderer (React)
│   ├── main.tsx                    # React entry — HashRouter
│   ├── App.tsx                     # Layout + route table
│   ├── index.css                   # Liquid Glass tokens + light/dark mode
│   ├── electron.d.ts               # Window.electronAPI type declarations
│   ├── types.ts                    # Renderer types
│   ├── hooks/                      # useHistory, useLocalVideoUrl
│   ├── lib/                        # history-actions, workflow-actions
│   ├── components/
│   │   ├── TitleBar.tsx · Sidebar.tsx · AppMenu.tsx
│   │   ├── ShareDialog.tsx · WorkflowSelector.tsx
│   │   ├── AutoBlurPanel.tsx · BackgroundPanel.tsx
│   │   ├── HistoryListRow.tsx · DateGroupedGrid.tsx
│   │   ├── UpdateNotification.tsx · AboutDialog.tsx · ReleaseNotesDialog.tsx
│   │   ├── ScrollCaptureDialog.tsx
│   │   └── AnnotationCanvas/
│   │       ├── Canvas.tsx          # Konva stage — all drawing tools
│   │       ├── ToolBar.tsx         # In-canvas tool picker
│   │       └── tools.ts            # Tool union types
│   └── windows/                    # Routed views — one folder per route
│       ├── dashboard/Dashboard.tsx           # Capture launcher + history grid
│       ├── editor/Editor.tsx                 # Image + video annotation
│       ├── workflow/Workflow.tsx             # Template manager
│       ├── settings/Settings.tsx             # Preferences
│       ├── overlay/Overlay.tsx               # Region/window/monitor picker
│       ├── recorder-host/RecorderHost.tsx    # Hidden — owns MediaRecorder
│       ├── recording-toolbar/RecordingToolbar.tsx
│       └── recording-border/RecordingBorder.tsx
├── resources/                      # App icons + tray icons
├── build/                          # Notarization, entitlements, icon generator
├── .github/workflows/release.yml   # CI build + sign + publish
├── electron.vite.config.ts
├── electron-builder.cjs
├── eng.traineddata                 # Tesseract English language data
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
# Then fill in MAIN_VITE_R2_* and MAIN_VITE_GDRIVE_* values

# Start in development mode (renderer at localhost:5173, hot reload)
pnpm dev

# Type-check + bundle for production
pnpm build

# Package for the host platform (output in release/)
pnpm build:win   # NSIS installer for x64 + arm64
pnpm build:mac   # DMG for x64 + arm64

# Regenerate icon sets from resources/icon.png
pnpm icons
```

### Development Notes

- Renderer runs at `http://localhost:5173`; hash routing (`/#/dashboard`, `/#/editor`, …) drives navigation
- Standalone routes (`/overlay`, `/recording-toolbar`, `/recording-border`, `/recorder-host`) render without sidebar/titlebar so they can be loaded into transparent BrowserWindows
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

Production releases are produced by **GitHub Actions** (`.github/workflows/release.yml`), not local commands. Local `build:win` / `build:mac` skip code-signing (`CSC_IDENTITY_AUTO_DISCOVERY=false`); CI provides certs via repo secrets:

| Platform | Required secrets |
|---|---|
| Windows | `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD` |
| macOS | `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

`build/notarize.cjs` exits cleanly when notarization credentials are absent, so unsigned local builds still complete.

Published artifacts go to a Cloudflare R2 bucket served at **`https://release.lumia.asia`** (S3 publisher uploads, `generic` provider for client downloads — see [`electron-builder.cjs`](electron-builder.cjs)). Installed copies poll `latest.yml` / `latest-mac.yml` from that origin every 4 hours via `electron-updater` and install pending updates on the next quit.

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
- `setAppUserModelId('com.lumia.app')` matches the NSIS shortcut AUMID — required or WinRT silently drops toasts
- Mixed-DPI displays handled with `setBounds()` after window construction (avoids overlay misplacement on secondary monitors)
- Native input simulation via koffi FFI to `user32.dll` — replaces PowerShell's ~200–500 ms cold start

**macOS**
- Hidden inset title bar with traffic lights at `(18, 20)`
- Universal builds (arm64 + x64); `public.app-category.graphics-design`
- Hardened runtime + entitlements via `build/entitlements.mac.plist`
- OCR via the bundled Swift `helpers/ocr-vision` binary (Vision framework) when present, falling back to Tesseract

---

## License

MIT — see [LICENSE](LICENSE).
