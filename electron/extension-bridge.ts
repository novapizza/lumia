import { ipcMain, app, nativeImage, screen, shell, type BrowserWindow } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync } from 'fs'
import { join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { focusWindowByTitlePrefix } from './native-input'
import { sendCaptureToEditor } from './capture'
import { showNotification } from './notify'
import { getDisplayIcc } from './display-icc'
import { convertBgraToSrgbInPlace } from './icc-to-srgb'

/**
 * Local WebSocket bridge for the Lumia browser extension (extension/ at the
 * repo root; shipped under Resources/extension in packaged builds).
 *
 * Why a localhost WebSocket instead of Chrome Native Messaging: native
 * messaging needs a per-browser host manifest (registry keys on Windows,
 * JSON files per browser on macOS) plus a relay process, while a localhost
 * server needs zero install steps beyond loading the extension. The MV3
 * service worker connects out to us and stays alive off the ping traffic.
 *
 * Security: the server binds 127.0.0.1 only and rejects any connection whose
 * Origin is not a browser-extension origin — a regular web page's ws://
 * connection attempt carries an http(s) Origin and is dropped, so remote
 * content can't drive captures.
 */

// Must match PORTS in extension/background.js. Several candidates so a
// developer running two Lumia instances (or an unlucky port collision)
// still gets a binding; the extension probes them in order.
const BRIDGE_PORTS = [51763, 51764, 51765]

const IDLE_WATCHDOG_MS = 20_000 // per-message inactivity limit during a capture
const MAX_OUTPUT_PIXELS = 256_000_000 // same stitched-size cap as scroll-capture.ts

// ── Wire protocol types (extension → app) ──────────────────────────────────

interface ExtHello {
  type: 'hello'
  browser?: string
  version?: string
}

/** Page geometry, all in CSS pixels of the captured tab. */
interface ExtCaptureMeta {
  type: 'capture-meta'
  id: string
  dpr: number
  /** Window viewport size — the size captureVisibleTab frames map onto. */
  winW: number
  winH: number
  /** Scroller client size (== win size when the document itself scrolls). */
  vpW: number
  vpH: number
  /** Total scrollable content height of the scroller. */
  scrollHeight: number
  /** Scroller bounding rect within the viewport; null → document scroller
   *  (frames are used whole, no crop). */
  rect: { x: number; y: number; w: number; h: number } | null
  totalFrames: number
  /** Scroll steps overlap by this many CSS px (GoFullPage technique): the
   *  top `overlap − bottomCrop` strip of every frame after the first is
   *  discarded when stitching, so viewport-pinned elements the page-side
   *  neutralization missed (JS/transform-pinned headers) can't repeat down
   *  the output. Absent/0 from older extensions → no crop. */
  overlap?: number
  /** Share of `overlap` to discard from the BOTTOM of every frame except the
   *  last instead — kills bottom-pinned overlays the neutralization missed
   *  (scroll-triggered "Back to top" buttons appear only after the page-prep
   *  scan ran). Absent from older extensions → all of `overlap` crops the top. */
  bottomCrop?: number
  /** Scroll advance per frame (= vpH − overlap). Informational. */
  step?: number
  /** 'region' → crop the stitched output to `rect` (just the picked area).
   *  'viewport'/'fullpage' keep the surrounding page chrome. */
  mode?: 'viewport' | 'fullpage' | 'region'
  url?: string
  title?: string
}

interface ExtFrameMsg {
  type: 'frame'
  id: string
  index: number
  /** Actual scroller scrollTop when this frame was captured (CSS px). */
  scrollY: number
  dataUrl: string
}

type ExtMessage =
  | ExtHello
  | { type: 'pong' }
  | ExtCaptureMeta
  | ExtFrameMsg
  | { type: 'capture-done'; id: string }
  | { type: 'capture-error'; id: string; error?: string }
  /** Reply to our 'preview' request — a downscaled JPEG of the client's
   *  active tab, for the multi-browser picker. */
  | { type: 'preview-result'; id: string; dataUrl?: string | null; title?: string; url?: string }
  /** User picked a mode in the extension popup — start a capture session in
   *  THAT browser targeting the given tab, in the chosen mode. */
  | { type: 'capture-request'; target?: { windowId: number; tabId: number }; mode?: 'viewport' | 'fullpage' | 'region' }

// ── Module state ────────────────────────────────────────────────────────────

interface ClientInfo {
  /** Stable per-connection id the renderer uses to target a specific browser. */
  id: number
  browser: string
  version: string
  lastSeen: number
}

let getMain: (() => BrowserWindow | null) | null = null
let wss: WebSocketServer | null = null
const clients = new Map<WebSocket, ClientInfo>()
let nextClientId = 1

function openClients(): Array<[WebSocket, ClientInfo]> {
  return [...clients.entries()].filter(([ws]) => ws.readyState === WebSocket.OPEN)
}

type CaptureMeta = Omit<ExtCaptureMeta, 'type' | 'id'>

interface CaptureResult {
  frames: ExtFrameMsg[]
  meta: CaptureMeta | null
}

interface CaptureSession {
  id: string
  ws: WebSocket
  meta: CaptureMeta | null
  frames: ExtFrameMsg[]
  cancelled: boolean
  watchdog: NodeJS.Timeout | null
  resolve: (result: CaptureResult) => void
  reject: (err: Error) => void
}

let session: CaptureSession | null = null

// ── Version-skew guard ──────────────────────────────────────────────────────
// The extension updates on its own schedule (Chrome Web Store rollout, or a
// load-unpacked copy that only refreshes on browser restart) while the app
// updates via electron-updater — the two sides are ROUTINELY out of sync.
// The protocol survives skew by convention: every new wire field is optional
// with a documented fallback on the receiving side (see meta.overlap /
// meta.bottomCrop), and both peers ignore unknown message types. On top of
// that, the app compares each client's `hello` version against the extension
// copy it ships (Resources/extension) and flags older clients in the status
// broadcast, so the Dashboard can nudge the user to update instead of
// silently capturing with yesterday's page-side fixes.

let bundledExtVersion: string | null | undefined // undefined = not read yet

function getBundledExtVersion(): string | null {
  if (bundledExtVersion !== undefined) return bundledExtVersion
  try {
    const dir = app.isPackaged
      ? join(process.resourcesPath, 'extension')
      : join(__dirname, '../../extension')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    bundledExtVersion = typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    bundledExtVersion = null
  }
  return bundledExtVersion ?? null
}

/** Dotted-numeric compare: negative when a < b, 0 when equal. */
function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function isOutdated(info: ClientInfo): boolean {
  const bundled = getBundledExtVersion()
  return !!(bundled && info.version && cmpVersions(info.version, bundled) < 0)
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface ExtensionStatus {
  connected: boolean
  browsers: string[]
  clients: Array<{ id: number; browser: string; version: string; outdated: boolean }>
  /** Version of the extension copy this app ships (null if unreadable). */
  bundledVersion: string | null
  /** Browsers whose connected extension is older than the bundled copy. */
  outdated: string[]
}

export function getExtensionStatus(): ExtensionStatus {
  const open = openClients().map(([, info]) => info)
  return {
    connected: open.length > 0,
    browsers: open.map(i => i.browser),
    clients: open.map(i => ({ id: i.id, browser: i.browser, version: i.version, outdated: isOutdated(i) })),
    bundledVersion: getBundledExtVersion(),
    outdated: open.filter(isOutdated).map(i => i.browser)
  }
}

export function isExtensionConnected(): boolean {
  return getExtensionStatus().connected
}

function broadcastStatus() {
  const main = getMain?.()
  if (main && !main.isDestroyed()) {
    main.webContents.send('scroll-extension:status', getExtensionStatus())
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  return origin.startsWith('chrome-extension://')
    || origin.startsWith('moz-extension://')
    || origin.startsWith('safari-web-extension://')
}

function listenOn(portIdx: number) {
  if (portIdx >= BRIDGE_PORTS.length) {
    console.warn('[ext-bridge] all bridge ports in use — extension scroll capture unavailable')
    return
  }
  const port = BRIDGE_PORTS[portIdx]
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // Frames are multi-MB base64 PNGs; default 100 MiB is fine but be explicit.
    maxPayload: 64 * 1024 * 1024
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      server.close()
      listenOn(portIdx + 1)
    } else {
      console.error('[ext-bridge] server error:', err.message)
    }
  })

  server.on('listening', () => {
    wss = server
    console.log(`[ext-bridge] listening on 127.0.0.1:${port}`)
  })

  server.on('connection', (ws, req) => {
    if (!isExtensionOrigin(req.headers.origin)) {
      console.warn(`[ext-bridge] rejected connection from origin ${req.headers.origin ?? '(none)'}`)
      ws.close(4003, 'forbidden origin')
      return
    }
    clients.set(ws, { id: nextClientId++, browser: 'browser', version: '', lastSeen: Date.now() })

    ws.on('message', (raw) => {
      let msg: ExtMessage
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const info = clients.get(ws)
      if (info) info.lastSeen = Date.now()
      handleMessage(ws, msg)
    })

    ws.on('close', () => {
      clients.delete(ws)
      if (session && session.ws === ws) {
        failSession(new Error('Browser extension disconnected mid-capture'))
      }
      broadcastStatus()
    })

    ws.on('error', () => { /* close handler does the cleanup */ })
  })
}

export function setupExtensionBridge(getMainWindow: () => BrowserWindow | null) {
  getMain = getMainWindow
  listenOn(0)

  // Text-level keepalive: MV3 service workers stay alive while WebSocket
  // messages keep flowing (Chrome 116+), so a plain ws.ping() frame — which
  // never reaches the JS layer — wouldn't prevent the 30 s idle kill.
  const pingTimer = setInterval(() => {
    for (const ws of clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}')
    }
  }, 20_000)

  app.on('will-quit', () => {
    clearInterval(pingTimer)
    wss?.close()
  })

  ipcMain.handle('scroll-extension:status', () => getExtensionStatus())
  ipcMain.handle('scroll-extension:open-folder', () => {
    const dir = app.isPackaged
      ? join(process.resourcesPath, 'extension')
      : join(__dirname, '../../extension')
    return shell.openPath(dir)
  })
  // Multi-browser picker support: live tab thumbnails from every connected
  // browser, and session start targeted at the browser the user picked.
  ipcMain.handle('scroll-extension:previews', () => requestAllPreviews())
  ipcMain.handle('scroll-extension:start-with', (_e, clientId: number) => {
    const entry = openClients().find(([, info]) => info.id === clientId)
    if (!entry) return { ok: false, error: 'That browser is no longer connected' }
    // Fire-and-forget: the session reports progress/result/errors through the
    // scroll-capture:* events (ScrollCaptureDialog), so the picker can close
    // as soon as the session kicks off instead of blocking until it finishes.
    void runExtensionSession(entry[0])
    return { ok: true }
  })
}

// ── Tab previews (multi-browser picker) ─────────────────────────────────────

export interface BrowserPreview {
  clientId: number
  browser: string
  title: string
  url: string
  dataUrl: string | null
}

const PREVIEW_TIMEOUT_MS = 4000
const pendingPreviews = new Map<string, {
  clientId: number
  browser: string
  timer: NodeJS.Timeout
  resolve: (p: BrowserPreview) => void
}>()

function requestAllPreviews(): Promise<BrowserPreview[]> {
  return Promise.all(openClients().map(([ws, info]) =>
    new Promise<BrowserPreview>((resolve) => {
      const id = randomUUID()
      pendingPreviews.set(id, {
        clientId: info.id,
        browser: info.browser,
        resolve,
        timer: setTimeout(() => {
          pendingPreviews.delete(id)
          resolve({ clientId: info.id, browser: info.browser, title: '', url: '', dataUrl: null })
        }, PREVIEW_TIMEOUT_MS)
      })
      ws.send(JSON.stringify({ type: 'preview', id }))
    })
  ))
}

// ── Message routing ─────────────────────────────────────────────────────────

function handleMessage(ws: WebSocket, msg: ExtMessage) {
  switch (msg.type) {
    case 'hello': {
      const info = clients.get(ws)
      if (info) {
        info.browser = msg.browser || 'browser'
        info.version = msg.version || ''
      }
      broadcastStatus()
      break
    }
    case 'pong':
      break
    case 'capture-meta': {
      if (!session || session.id !== msg.id) break
      resetWatchdog()
      const { type: _t, id: _id, ...meta } = msg
      session.meta = meta
      // Focus assist: the extension already called
      // chrome.windows.update({focused:true}), but Windows denies foreground
      // to a background process — while Lumia, holding foreground right now,
      // is always allowed to hand it over. macOS gets an AppleScript
      // `activate` for the same reason. Best-effort on both.
      focusBrowserWindow(clients.get(ws)?.browser, msg.title)
      break
    }
    case 'frame': {
      if (!session || session.id !== msg.id) break
      resetWatchdog()
      // Progress is shown by the extension's in-page pill; the app stays
      // hidden during capture (like every other capture mode), so there's
      // nothing to update here.
      session.frames.push(msg)
      break
    }
    case 'capture-done': {
      if (!session || session.id !== msg.id) break
      const s = session
      clearSessionWatchdog()
      session = null
      s.resolve({ frames: s.frames, meta: s.meta })
      break
    }
    case 'capture-error': {
      if (!session || session.id !== msg.id) break
      failSession(new Error(msg.error || 'Extension capture failed'))
      break
    }
    case 'preview-result': {
      const pending = pendingPreviews.get(msg.id)
      if (!pending) break
      clearTimeout(pending.timer)
      pendingPreviews.delete(msg.id)
      pending.resolve({
        clientId: pending.clientId,
        browser: pending.browser,
        title: msg.title ?? '',
        url: msg.url ?? '',
        dataUrl: msg.dataUrl ?? null
      })
      break
    }
    case 'capture-request': {
      // Popup action in a browser: capture in THAT browser, on the given tab,
      // in the chosen mode. Ignore while another session is running.
      if (session) break
      void runExtensionSession(ws, msg.target, msg.mode)
      break
    }
  }
}

/** macOS bundle names for the browser labels the extension reports. */
const MAC_APP_NAMES: Record<string, string> = {
  Chrome: 'Google Chrome',
  Edge: 'Microsoft Edge',
  Brave: 'Brave Browser',
  Vivaldi: 'Vivaldi',
  Opera: 'Opera',
  Firefox: 'Firefox',
  Chromium: 'Chromium'
}

/** Bring the capturing browser to the foreground so the user watches the
 *  capture (behind its interaction-blocking overlay) and can hit Stop. */
function focusBrowserWindow(browser: string | undefined, tabTitle: string | undefined) {
  try {
    if (process.platform === 'win32') {
      if (tabTitle) focusWindowByTitlePrefix(tabTitle)
    } else if (process.platform === 'darwin' && browser) {
      const appName = MAC_APP_NAMES[browser]
      if (appName) {
        execFile('osascript', ['-e', `tell application "${appName}" to activate`], () => { /* best effort */ })
      }
    }
  } catch { /* focus is best-effort — capture works without it */ }
}

function resetWatchdog() {
  if (!session) return
  if (session.watchdog) clearTimeout(session.watchdog)
  session.watchdog = setTimeout(() => {
    // Tell the extension to stop + restore the page before dropping the session.
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'capture-cancel', id: session.id }))
    }
    failSession(new Error('Browser extension stopped responding'))
  }, IDLE_WATCHDOG_MS)
}

function clearSessionWatchdog() {
  if (session?.watchdog) clearTimeout(session.watchdog)
}

function failSession(err: Error) {
  if (!session) return
  const s = session
  clearSessionWatchdog()
  session = null
  s.reject(err)
}

export function cancelExtensionCapture() {
  if (!session) return
  const s = session
  s.cancelled = true
  if (s.ws.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify({ type: 'capture-cancel', id: s.id }))
  }
  failSession(new Error('cancelled'))
}

// ── Capture orchestration ───────────────────────────────────────────────────

/**
 * Entry point used by launchScrollCapture(): with a single connected browser
 * the capture starts immediately; with several, the renderer is asked to show
 * the browser picker (with live tab previews) and the session starts later
 * via the `scroll-extension:start-with` IPC.
 */
export async function startExtensionCapture(): Promise<{ ok: boolean; error?: string }> {
  const main = getMain?.()
  if (!main || main.isDestroyed()) return { ok: false, error: 'Main window unavailable' }
  const open = openClients()
  if (open.length === 0) return { ok: false, error: 'Browser extension not connected' }
  if (session) return { ok: false, error: 'A scroll capture is already running' }
  if (open.length === 1) return runExtensionSession(open[0][0])

  // Multiple browsers connected — let the user pick one. Dashboard is the
  // only listener for scroll-extension:pick, so route there first.
  main.show()
  main.focus()
  main.webContents.send('navigate', '/dashboard')
  await sleep(100)
  main.webContents.send('scroll-extension:pick')
  return { ok: true }
}

/**
 * Run a full-page capture through ONE extension connection.
 *
 * The app is hidden for the duration and shows no progress UI — exactly like
 * the other capture modes. The browser (focused by the extension + native
 * assist) does the scrolling behind its own in-page pill, and the finished
 * image is handed to the editor via `sendCaptureToEditor` (watermark,
 * clipboard, save-to-disk, history, notification — the shared capture path).
 *
 * `target` (windowId/tabId) pins the capture to the tab the user clicked the
 * extension's toolbar icon on; without it the extension captures its
 * last-focused window's active tab.
 */
async function runExtensionSession(
  ws: WebSocket,
  target?: { windowId: number; tabId: number },
  mode?: 'viewport' | 'fullpage' | 'region'
): Promise<{ ok: boolean; error?: string }> {
  const main = getMain?.()
  if (!main || main.isDestroyed()) return { ok: false, error: 'Main window unavailable' }
  if (session) return { ok: false, error: 'A scroll capture is already running' }

  // Hide the app while the browser captures — same as every other mode. No
  // dialog, no app-side progress. (Started from the Dashboard card the window
  // is visible; from the toolbar icon it may already be in the tray.)
  if (main.isVisible()) main.hide()

  const id = randomUUID()
  let wasCancelled = false

  try {
    const result = await new Promise<CaptureResult>((resolve, reject) => {
      session = {
        id,
        ws,
        meta: null,
        frames: [],
        cancelled: false,
        watchdog: null,
        resolve,
        reject: (err) => { wasCancelled = err.message === 'cancelled'; reject(err) }
      }
      resetWatchdog()
      ws.send(JSON.stringify({ type: 'capture-start', id, target, mode: mode || 'fullpage' }))
    })

    if (!result.meta) throw new Error('Extension did not report page metrics')
    // captureVisibleTab returns the compositor's output — pixels in the
    // DISPLAY's color space, with no embedded profile. Read as sRGB they
    // show a color cast (violet AWS-console links on one wide-gamut
    // laptop), so convert the stitched bitmap to sRGB using the display's
    // ICC profile — then the clipboard, editor, uploads, and saved file all
    // agree. The browser's display isn't directly knowable; the cursor's
    // display is the best proxy — the user just interacted with the capture
    // pill there (and on single-monitor setups it's trivially right). When
    // the profile can't be expressed as matrix-shaper math, fall back to
    // tagging the saved PNG with the profile (color-managed viewers still
    // render it right).
    const displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const icc = await getDisplayIcc(displayId).catch(() => null)
    const { dataUrl, srgb } = stitchExtensionFrames(result.frames, result.meta, icc)
    // Deliver like a normal capture: this surfaces the editor (or, if the
    // app was dismissed to tray, just a notification) and handles history.
    await sendCaptureToEditor(dataUrl, 'scrolling', srgb ? undefined : displayId)
    return { ok: true }
  } catch (err) {
    if (wasCancelled) return { ok: false, error: 'cancelled' }
    const message = err instanceof Error ? err.message : String(err)
    // No dialog to show the error in — surface it as a toast instead.
    showNotification({ body: `Scroll capture failed — ${message}` })
    return { ok: false, error: message }
  }
}

// ── Stitching (exact offsets — no overlap detection needed) ────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function stitchExtensionFrames(
  frames: ExtFrameMsg[],
  meta: Omit<ExtCaptureMeta, 'type' | 'id'>,
  icc: Buffer | null = null
): { dataUrl: string; srgb: boolean } {
  if (frames.length === 0) throw new Error('No frames were captured')
  const ordered = [...frames].sort((a, b) => a.index - b.index)

  const images = ordered.map(f => nativeImage.createFromDataURL(f.dataUrl))
  const { width: rawW, height: rawH } = images[0].getSize()
  if (rawW === 0 || rawH === 0) throw new Error('Extension returned an empty frame')

  // Physical pixels per CSS pixel of the tab (device scale × page zoom),
  // measured from the actual frame instead of trusting reported dpr.
  const scale = rawW / meta.winW

  // Discard the overlap strips (scroll steps overlapped by meta.overlap CSS
  // px): `bottomPx` off the bottom of every frame but the last (bottom-pinned
  // overlays — "Back to top" buttons — live only there), the rest off the top
  // of frames 1+ (pinned headers). 2px slack absorbs scale rounding so the
  // crops can never open a gap between consecutive frames.
  const overlapPx = Math.max(0, Math.floor((meta.overlap ?? 0) * scale) - 2)
  const bottomPx = clamp(Math.floor((meta.bottomCrop ?? 0) * scale), 0, overlapPx)
  const topPx = overlapPx - bottomPx

  // 'region': the user picked an element — output JUST that box (crop, no
  // page chrome). Otherwise keep chrome: element scrollers composite the
  // chrome in; whole-document pages stack full viewports.
  if (meta.mode === 'region' && meta.rect) {
    return stitchCroppedRegion(images, ordered, meta.rect, scale, rawW, rawH, topPx, bottomPx, icc)
  }
  return meta.rect
    ? stitchElementScroller(images, ordered, meta.rect, scale, rawW, rawH, topPx, bottomPx, icc)
    : stitchDocumentScroller(images, ordered, scale, rawW, rawH, topPx, bottomPx, icc)
}

/** Region mode: crop every frame to `rect` and stack the crops by scroll
 *  offset — the output is exactly the picked area (a single crop when the
 *  element didn't need scrolling). */
function stitchCroppedRegion(
  images: Electron.NativeImage[],
  ordered: ExtFrameMsg[],
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
  rawW: number,
  rawH: number,
  topPx = 0,
  bottomPx = 0,
  icc: Buffer | null = null
): { dataUrl: string; srgb: boolean } {
  const cropX = clamp(Math.round(rect.x * scale), 0, rawW - 1)
  const cropY = clamp(Math.round(rect.y * scale), 0, rawH - 1)
  const cropW = clamp(Math.round(rect.w * scale), 1, rawW - cropX)
  const cropH = clamp(Math.round(rect.h * scale), 1, rawH - cropY)
  const rowBytes = cropW * 4

  const lastY = Math.round(ordered[ordered.length - 1].scrollY * scale)
  const totalHeight = lastY + cropH
  if (totalHeight * cropW > MAX_OUTPUT_PIXELS) {
    throw new Error('Selection is too tall to stitch — try a shorter area')
  }
  const outBuf = Buffer.alloc(totalHeight * rowBytes)
  let lastIdx = images.length - 1
  while (lastIdx > 0 && (images[lastIdx].getSize().width !== rawW || images[lastIdx].getSize().height !== rawH)) lastIdx--
  for (let i = 0; i < images.length; i++) {
    const { width: w, height: h } = images[i].getSize()
    if (w !== rawW || h !== rawH) continue // zoom changed mid-capture — skip
    const bmp = images[i].crop({ x: cropX, y: cropY, width: cropW, height: cropH }).toBitmap()
    // Frames 1+ drop their top overlap strip, every frame but the last drops
    // the bottom one — anything pinned to the pane top or bottom that the
    // page-side neutralization missed lives only there.
    const skip = i === 0 ? 0 : Math.min(topPx, cropH - 1)
    const cut = i === lastIdx ? 0 : Math.min(bottomPx, cropH - 1 - skip)
    const dstY = clamp(Math.round(ordered[i].scrollY * scale) + skip, 0, totalHeight - 1)
    const rows = Math.min(cropH - skip - cut, totalHeight - dstY)
    if (rows <= 0) continue
    bmp.copy(outBuf, dstY * rowBytes, skip * rowBytes, (skip + rows) * rowBytes)
  }
  return finalize(outBuf, cropW, totalHeight, icc)
}

/** Whole-document scroll: frames are full viewports; stack them by scroll
 *  offset. Fixed/sticky chrome was neutralized in the page before capture. */
function stitchDocumentScroller(
  images: Electron.NativeImage[],
  ordered: ExtFrameMsg[],
  scale: number,
  rawW: number,
  rawH: number,
  topPx = 0,
  bottomPx = 0,
  icc: Buffer | null = null
): { dataUrl: string; srgb: boolean } {
  const rowBytes = rawW * 4
  const lastY = Math.round(ordered[ordered.length - 1].scrollY * scale)
  const totalHeight = lastY + rawH
  if (totalHeight * rawW > MAX_OUTPUT_PIXELS) {
    throw new Error('Page is too tall to stitch — try capturing a shorter section')
  }
  const outBuf = Buffer.alloc(totalHeight * rowBytes)
  let lastIdx = images.length - 1
  while (lastIdx > 0 && images[lastIdx].getSize().width !== rawW) lastIdx--
  for (let i = 0; i < images.length; i++) {
    const { width: w, height: h } = images[i].getSize()
    if (w !== rawW) continue // zoom changed mid-capture — skip frame
    // Frames 1+ drop their top overlap strip, every frame but the last drops
    // the bottom one — viewport-pinned leftovers the page-side neutralization
    // missed (headers up top, "Back to top" buttons down low) live only there.
    const skip = i === 0 ? 0 : Math.min(topPx, h - 1)
    const cut = i === lastIdx ? 0 : Math.min(bottomPx, h - 1 - skip)
    const dstY = clamp(Math.round(ordered[i].scrollY * scale) + skip, 0, totalHeight - 1)
    const rows = Math.min(h - skip - cut, totalHeight - dstY)
    if (rows <= 0) continue
    images[i].toBitmap().copy(outBuf, dstY * rowBytes, skip * rowBytes, (skip + rows) * rowBytes)
  }
  return finalize(outBuf, rawW, totalHeight, icc)
}

/**
 * App with an inner scroll pane (Gmail, Drive, Docs, …): the page itself
 * doesn't scroll — a middle `<div>` does, with a static header above and a
 * sidebar beside it. Cropping to the pane (the old behavior) dropped that
 * chrome entirely. Instead composite a full-width image:
 *   - header (rows above the pane) and footer (rows below it) from frame 0,
 *   - the pane's COLUMN stitched from every frame by exact scroll offset,
 *   - the side margins (sidebar / right rail) from frame 0, extended down to
 *     fill the grown height with a synthesized background row (per-column
 *     dominant color over the band's bottom half — see synthMarginRow;
 *     sidebars have no more content to reveal, and repeating the literal
 *     last row smeared any icons/text it crossed into vertical streaks).
 */
function stitchElementScroller(
  images: Electron.NativeImage[],
  ordered: ExtFrameMsg[],
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
  rawW: number,
  rawH: number,
  topPx = 0,
  bottomPx = 0,
  icc: Buffer | null = null
): { dataUrl: string; srgb: boolean } {
  const rowBytes = rawW * 4
  const top = clamp(Math.round(rect.y * scale), 0, rawH - 2)
  const bottom = clamp(Math.round((rect.y + rect.h) * scale), top + 1, rawH)
  const left = clamp(Math.round(rect.x * scale), 0, rawW - 1)
  const right = clamp(Math.round((rect.x + rect.w) * scale), left + 1, rawW)
  const bandH = bottom - top // visible pane height (physical px)

  // Grown pane height = furthest scroll offset + one visible band.
  const lastYOff = clamp(Math.round(ordered[ordered.length - 1].scrollY * scale), 0, Number.MAX_SAFE_INTEGER)
  const contentH = Math.max(bandH, lastYOff + bandH)
  const outH = top + contentH + (rawH - bottom)
  if (outH * rawW > MAX_OUTPUT_PIXELS) {
    throw new Error('Page is too tall to stitch — try capturing a shorter section')
  }

  const out = Buffer.alloc(outH * rowBytes)
  const bmp0 = images[0].toBitmap()

  // Header: rows [0, top) from frame 0 (full width).
  if (top > 0) bmp0.copy(out, 0, 0, top * rowBytes)
  // Footer: rows [bottom, rawH) from frame 0 → below the grown pane.
  if (rawH > bottom) bmp0.copy(out, (top + contentH) * rowBytes, bottom * rowBytes, rawH * rowBytes)

  // Side margins (sidebar / right rail) across the whole grown pane. Real
  // pixels for the first band; below it a SYNTHESIZED background row — the
  // per-column dominant color over the band's bottom half. Repeating the
  // band's literal bottom row (the old behavior) smeared whatever content
  // that row happened to cross (nav icons, text) into vertical streaks;
  // the per-column mode keeps background and vertical border lines
  // continuing cleanly while content pixels (a minority per column) vanish.
  const leftBytes = left * 4
  const rightStart = right * 4
  if (left > 0 || right < rawW) {
    const fillLeft = left > 0 ? synthMarginRow(bmp0, rowBytes, top, bandH, 0, leftBytes) : null
    const fillRight = right < rawW ? synthMarginRow(bmp0, rowBytes, top, bandH, rightStart, rowBytes) : null
    for (let r = 0; r < contentH; r++) {
      const dstOff = (top + r) * rowBytes
      if (r < bandH) {
        const srcOff = (top + r) * rowBytes
        if (left > 0) bmp0.copy(out, dstOff, srcOff, srcOff + leftBytes)
        if (right < rawW) bmp0.copy(out, dstOff + rightStart, srcOff + rightStart, srcOff + rowBytes)
      } else {
        if (fillLeft) fillLeft.copy(out, dstOff)
        if (fillRight) fillRight.copy(out, dstOff + rightStart)
      }
    }
  }

  // Pane column [left, right): stitch each frame at its exact offset. Later
  // (more-scrolled) frames overwrite the overlap — offsets are exact so the
  // content matches and there are no seams.
  const colStart = left * 4
  const colEnd = right * 4
  let lastIdx = images.length - 1
  while (lastIdx > 0 && images[lastIdx].getSize().width !== rawW) lastIdx--
  for (let i = 0; i < images.length; i++) {
    const { width: w, height: h } = images[i].getSize()
    if (w !== rawW) continue // zoom changed mid-capture — skip frame
    const bmp = images[i].toBitmap()
    const yOff = clamp(Math.round(ordered[i].scrollY * scale), 0, contentH - bandH)
    // Frames 1+ drop the top overlap strip of the pane band; every frame but
    // the last drops the bottom one (see meta.overlap / meta.bottomCrop).
    const skip = i === 0 ? 0 : Math.min(topPx, bandH - 1)
    const cut = i === lastIdx ? 0 : Math.min(bottomPx, bandH - 1 - skip)
    for (let br = skip; br < bandH - cut; br++) {
      const srcRow = top + br
      if (srcRow >= h) break
      const outRow = top + yOff + br
      const srcOff = srcRow * rowBytes
      const dstOff = outRow * rowBytes
      bmp.copy(out, dstOff + colStart, srcOff + colStart, srcOff + colEnd)
    }
  }

  return finalize(out, rawW, outH, icc)
}

/**
 * Synthesize one margin row for extending a side margin below the visible
 * band: for every column in [byteStart, byteEnd) of the row, the most
 * frequent color over the bottom half of the band. Background (and vertical
 * separator lines, which are constant per column) dominate that window, so
 * the extension continues them seamlessly; nav icons/text crossing any one
 * row are a per-column minority and can't smear into streaks.
 */
function synthMarginRow(
  bmp: Buffer,
  rowBytes: number,
  top: number,
  bandH: number,
  byteStart: number,
  byteEnd: number
): Buffer {
  const width = (byteEnd - byteStart) / 4
  const row = Buffer.alloc(byteEnd - byteStart)
  const from = top + Math.max(0, Math.floor(bandH / 2))
  const to = top + bandH // exclusive
  const counts = new Map<number, number>()
  for (let c = 0; c < width; c++) {
    counts.clear()
    let bestColor = 0
    let bestN = 0
    for (let r = from; r < to; r++) {
      const off = r * rowBytes + byteStart + c * 4
      const color = bmp[off] | (bmp[off + 1] << 8) | (bmp[off + 2] << 16)
      const n = (counts.get(color) ?? 0) + 1
      counts.set(color, n)
      if (n > bestN) {
        bestN = n
        bestColor = color
      }
    }
    const o = c * 4
    row[o] = bestColor & 0xff
    row[o + 1] = (bestColor >> 8) & 0xff
    row[o + 2] = (bestColor >> 16) & 0xff
    row[o + 3] = 255
  }
  return row
}

/** captureVisibleTab PNGs can carry alpha — force opaque like the classic
 *  path. Convert display-space pixels to sRGB when the display profile
 *  allows (see icc-to-srgb.ts) — `srgb: false` tells the caller to fall
 *  back to iCCP-tagging the saved file instead. Then encode. */
function finalize(buf: Buffer, width: number, height: number, icc: Buffer | null = null): { dataUrl: string; srgb: boolean } {
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255
  let srgb = false
  if (icc) {
    try { srgb = convertBgraToSrgbInPlace(buf, icc) } catch { srgb = false }
  }
  return { dataUrl: nativeImage.createFromBitmap(buf, { width, height }).toDataURL(), srgb }
}
