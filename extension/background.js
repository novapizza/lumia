// Lumia Scroll Capture — MV3 service worker.
//
// Connects to the Lumia desktop app over a localhost WebSocket (see
// electron/extension-bridge.ts) and, on request, captures the active tab as
// a full page: scroll in exact viewport steps, capture each
// viewport with chrome.tabs.captureVisibleTab, and stream frames + exact
// scroll offsets back to the app, which stitches them without any overlap
// guessing.
//
// The service worker stays alive during idle periods off the app's 20 s text
// pings (WebSocket message traffic resets Chrome's 30 s idle kill since 116);
// a chrome.alarms fallback reconnects if the socket ever drops.

// Version skew: this extension and the Lumia app update on INDEPENDENT
// schedules (Web Store rollout vs electron-updater), so either side may be
// newer at any time. Compatibility rules — keep both directions working:
//   - every new field in a message the app consumes must be OPTIONAL, with a
//     documented fallback in extension-bridge.ts (see meta.overlap /
//     meta.bottomCrop for the pattern);
//   - unknown message types are silently ignored by both peers;
//   - `hello` carries this manifest's version — the app compares it against
//     the extension copy it ships and shows an "update available" nudge on
//     the Dashboard when this side is older.
// Must match BRIDGE_PORTS in electron/extension-bridge.ts.
const PORTS = [51763, 51764, 51765]

const MAX_FRAMES = 30
// captureVisibleTab is throttled to 2 calls/sec; the delay doubles as
// lazy-load settle time after each scroll step.
const FRAME_DELAY_MS = 550

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Connection management ───────────────────────────────────────────────────

let ws = null
let connecting = false

function browserName() {
  // userAgentData brands identify Brave/Vivaldi etc., which hide themselves
  // in the plain UA string (they report as Chrome there).
  try {
    const brands = navigator.userAgentData && navigator.userAgentData.brands
    if (brands) {
      const real = brands.find((b) => !/Chromium|Not.?A.?Brand/i.test(b.brand))
      if (real) return real.brand.replace(/^(Google|Microsoft)\s+/, '')
    }
  } catch { /* fall through to UA sniffing */ }
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('OPR/')) return 'Opera'
  if (ua.includes('Vivaldi')) return 'Vivaldi'
  if (ua.includes('Firefox/')) return 'Firefox'
  return 'Chrome'
}

// Connection status is a colored dot drawn onto the toolbar icon itself:
// green (the app's success-text) when the Lumia app is reachable, orange
// (warning-text, as the popup's "Lumia isn't open") when it isn't. (No badge
// text: a text badge covers a third of the icon.)
// The dot sits inside a dark rim on whatever toolbar the browser has, so
// it takes the dark theme's values in both themes, read from DEFAULT_ROLES
// below (2026-11-27; the two hex values were repeated here).
const statusColor = (key) => DEFAULT_ROLES.dark[key === 'on' ? 'success-text' : 'warning-text']
const ICON_SIZES = [16, 32, 48]
const statusIconCache = {}

async function buildStatusIcons(color) {
  const imageData = {}
  for (const size of ICON_SIZES) {
    const resp = await fetch(chrome.runtime.getURL(`icon${size}.png`))
    const bmp = await createImageBitmap(await resp.blob())
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, 0, 0, size, size)
    // Dot in the bottom-right corner with a dark rim for contrast.
    const r = Math.max(3, Math.round(size * 0.2))
    const inset = Math.max(1, Math.round(size * 0.04))
    const cx = size - r - inset
    const cy = size - r - inset
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = Math.max(1, Math.round(size / 16))
    ctx.strokeStyle = 'rgba(19, 19, 19, 0.9)' // the app's dark background
    ctx.stroke()
    imageData[String(size)] = ctx.getImageData(0, 0, size, size)
  }
  return imageData
}

// Tells an open popup the connection or theme changed (2026-11-26; it only
// asked once when it opened). Nobody listening is fine.
function notifyStatus() {
  const t = pageTheme()
  chrome.runtime.sendMessage({
    type: 'lumia-status',
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    theme: t.roles ? t : null,
  }).catch(() => { /* no popup open */ })
}

// Calls overlap (the icons are built async on first use, after every
// service-worker start): only the newest call sets the icon, so a slow
// "off" build can't land after the "on" one (2026-11-27: orange dot while
// connected).
let badgeSeq = 0
async function updateBadge() {
  notifyStatus()
  const seq = ++badgeSeq
  const connected = !!(ws && ws.readyState === WebSocket.OPEN)
  try {
    const key = connected ? 'on' : 'off'
    if (!statusIconCache[key]) {
      // A failed build isn't kept: the next call tries again.
      statusIconCache[key] = buildStatusIcons(statusColor(key)).catch((e) => { delete statusIconCache[key]; throw e })
    }
    const imageData = await statusIconCache[key]
    if (seq !== badgeSeq) return // a newer call sets it
    chrome.action.setIcon({ imageData })
    chrome.action.setBadgeText({ text: '' }) // clear any leftover badge from older versions
    chrome.action.setTitle({
      title: connected
        ? 'Lumia Scroll Capture'
        : "Lumia Scroll Capture (Lumia isn't open)"
    })
  } catch { /* action API unavailable — ignore */ }
}

// While Lumia isn't there, try again every 2 s (2026-11-26, Jasper): the
// 30 s alarm alone made a started Lumia wait up to half a minute for the
// browser. Timers don't keep the service worker alive, so this runs while
// it's up anyway (an event, the alarm, a popup), and each alarm wakes it
// for another ~30 s of tries: close to always trying. Measured cost at 1 s
// (three refused localhost connects): ~0.5% of one core; 2 s halves it.
const RETRY_MS = 2000
let retryTimer = null
function retrySoon() {
  if (retryTimer) return
  retryTimer = setTimeout(() => { retryTimer = null; connect() }, RETRY_MS)
}

function connect() {
  if (connecting) return
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  connecting = true
  tryPort(0)
}

function tryPort(i) {
  if (i >= PORTS.length) {
    connecting = false
    updateBadge()
    retrySoon()
    return
  }
  let opened = false
  const sock = new WebSocket(`ws://127.0.0.1:${PORTS[i]}`)
  sock.onopen = () => {
    opened = true
    connecting = false
    ws = sock
    send({ type: 'hello', browser: browserName(), version: chrome.runtime.getManifest().version })
    updateBadge()
  }
  sock.onmessage = (ev) => handleMessage(sock, ev.data)
  sock.onclose = () => {
    // Lumia quit (or restarts): look for it again right away.
    if (ws === sock) { ws = null; updateBadge(); retrySoon() }
    if (!opened) tryPort(i + 1)
  }
  sock.onerror = () => { /* onclose follows and advances the probe */ }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

// ── Theme ───────────────────────────────────────────────────────────────────
// The popup, the status pill and the Region picker draw in the Lumia app's
// theme (2026-11-26): the app sends its role colours ({ mode, roles }, the
// app's --color-<role> values) on connect and on every change. Kept in
// storage so the last one survives a service-worker restart and the app
// being closed. Before the first one arrives, they follow the system's
// light / dark with the app's default roles below (src/index.css).
const DEFAULT_ROLES = {
  dark: {
    'elevated': '#1d1d1d', 'elevated-hover': '#282828', 'toolbar': '#151515', 'line': 'rgba(231, 231, 231, 0.12)',
    'fg': '#e7e7e7', 'fg-secondary': '#b4b4b4', 'fg-tertiary': '#888888', 'fg-disabled': '#535353',
    'kind-image': 'oklch(0.66 0.175 255)',
    'accent': '#7440d5', 'accent-hover': '#6931c8', 'on-accent': '#ffffff',
    'success-text': '#6dd797', 'warning-subtle': '#421e00', 'warning-text': '#e67a2a',
    'danger-subtle': '#371210', 'danger-text': '#e84b50',
  },
  light: {
    'elevated': '#ffffff', 'elevated-hover': '#f4f4f4', 'toolbar': '#f7f7f7', 'line': 'rgba(29, 29, 29, 0.14)',
    'fg': '#1d1d1d', 'fg-secondary': '#575757', 'fg-tertiary': '#6a6a6a', 'fg-disabled': '#b1b1b1',
    'kind-image': 'oklch(0.55 0.175 255)',
    'accent': '#7440d5', 'accent-hover': '#6931c8', 'on-accent': '#ffffff',
    'success-text': '#007742', 'warning-subtle': '#ffead9', 'warning-text': '#b95a00',
    'danger-subtle': '#ffecea', 'danger-text': '#c21725',
  },
}
let appTheme = null // { mode: 'light' | 'dark', roles }
const themeLoaded = chrome.storage.local.get('appTheme')
  .then((v) => { if (v && v.appTheme && !appTheme) appTheme = v.appTheme })
  .catch(() => {})

function setAppTheme(msg) {
  if (msg.mode !== 'light' && msg.mode !== 'dark') return
  if (!msg.roles || typeof msg.roles !== 'object') return
  appTheme = { mode: msg.mode, roles: msg.roles }
  chrome.storage.local.set({ appTheme }).catch(() => {})
  notifyStatus()
}

/** What the injected page UI draws with: the app's theme, or both defaults
 *  for the page to pick by the system's light / dark. */
function pageTheme() {
  return appTheme
    ? { mode: appTheme.mode, roles: { ...DEFAULT_ROLES[appTheme.mode], ...appTheme.roles } }
    : { defaults: DEFAULT_ROLES }
}

chrome.alarms.create('lumia-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'lumia-reconnect') connect() })
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect() // service worker woke up for any reason — make sure we're connected
updateBadge()

// The toolbar icon opens popup.html (three modes). The popup asks us for the
// connection state and to start a capture in one of three modes:
//   'viewport'  — the current visible area only (one frame)
//   'fullpage'  — the whole scrollable page (scroll + stitch)
//   'region'    — user picks an element/area on the page, capture just that
//
// The app stays the orchestrator (focus, stitching, editor hand-off); we pin
// the session to this browser's active tab and pass the chosen mode along.
async function startFromUI(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { connect(); return { ok: false, error: 'not-connected' } }
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  if (!win) return { ok: false, error: 'no-window' }
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
  if (!tab || tab.id == null) return { ok: false, error: 'no-tab' }
  if (!/^(https?|file):/.test(tab.url || '')) return { ok: false, error: 'restricted-page' }

  if (mode === 'region') {
    // Inject the element picker and return IMMEDIATELY so the popup closes —
    // while the popup is open the page has no focus, so the picker couldn't
    // receive mouse moves or Esc. Fire-and-forget: the picker messages back
    // ('lumia-region-picked') once the user picks, and THAT starts the
    // capture (see the onMessage handler below). Do NOT await it — the
    // injected picker's promise only settles after the user interacts.
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: lumiaPickElement, args: [pageTheme()] })
      .catch(() => {})
    return { ok: true }
  }

  send({ type: 'capture-request', target: { windowId: tab.windowId, tabId: tab.id }, mode })
  return { ok: true }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return
  // Stop button on the in-page status pill → finish early, export what we have.
  if (msg.type === 'lumia-stop-clicked' && activeCapture) {
    activeCapture.stopRequested = true
    return
  }
  // Popup → status query.
  if (msg.type === 'lumia-get-status') {
    themeLoaded.then(() => {
      const t = pageTheme()
      sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN), theme: t.roles ? t : null })
    })
    return true // async response (waits for the stored theme)
  }
  // Popup → start a capture in the chosen mode.
  if (msg.type === 'lumia-ui-start') {
    startFromUI(msg.mode).then(sendResponse)
    return true // async response
  }
  // Region picker (in the page) → the user picked an element. Start the
  // region capture in that tab. The picked element is already stashed on the
  // page as window.__lumiaPickedEl for lumiaPrep to read.
  if (msg.type === 'lumia-region-picked' && sender && sender.tab) {
    send({ type: 'capture-request', target: { windowId: sender.tab.windowId, tabId: sender.tab.id }, mode: 'region' })
    return
  }
})

// Auto-cancel a running capture when the user switches away from the
// capturing window (to another window / app, or Chrome loses focus) or to a
// different tab. `windowId`/`tabId` are armed inside runCapture only after the
// browser is focused, so the initial focus handoff never trips these.
chrome.windows.onFocusChanged.addListener((winId) => {
  if (activeCapture && activeCapture.windowId != null && winId !== activeCapture.windowId) {
    activeCapture.cancelled = true
  }
})
chrome.tabs.onActivated.addListener((info) => {
  if (activeCapture && activeCapture.tabId != null && info.tabId !== activeCapture.tabId) {
    activeCapture.cancelled = true
  }
})

// ── Command handling ────────────────────────────────────────────────────────

let activeCapture = null // { id, cancelled }

async function handleMessage(sock, data) {
  let msg
  try { msg = JSON.parse(data) } catch { return }

  if (msg.type === 'ping') {
    sock.send('{"type":"pong"}')
    return
  }
  if (msg.type === 'theme') {
    setAppTheme(msg)
    return
  }
  if (msg.type === 'capture-cancel') {
    if (activeCapture && activeCapture.id === msg.id) activeCapture.cancelled = true
    return
  }
  if (msg.type === 'preview') {
    void sendPreview(msg.id)
    return
  }
  // The app's scroll hotkey asks whether this browser is in front
  // (2026-11-27): `focused` is the OS's active window, false while another
  // app is in front.
  if (msg.type === 'focus') {
    chrome.windows.getLastFocused({ windowTypes: ['normal'] })
      .then(win => send({ type: 'focus-result', id: msg.id, focused: !!(win && win.focused) }))
      .catch(() => send({ type: 'focus-result', id: msg.id, focused: false }))
    return
  }
  if (msg.type === 'capture-start') {
    if (activeCapture) {
      send({ type: 'capture-error', id: msg.id, error: 'A capture is already running' })
      return
    }
    // Permission model: captures started from the extension popup carry a
    // `target` and ride on activeTab (granted by the popup click). Captures
    // started from the Lumia app have no user gesture in this browser, so
    // they need the optional <all_urls> grant (one click in the popup).
    if (!msg.target) {
      const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] })
      if (!granted) {
        send({
          type: 'capture-error',
          id: msg.id,
          error: 'Click the Lumia extension in the browser toolbar, then Allow'
        })
        return
      }
    }
    activeCapture = { id: msg.id, cancelled: false, stopRequested: false }
    try {
      await runCapture(msg.id, msg.target, msg.mode)
    } catch (e) {
      send({ type: 'capture-error', id: msg.id, error: e && e.message ? e.message : String(e) })
    } finally {
      activeCapture = null
    }
  }
}

// ── Tab preview (multi-browser picker in the app) ───────────────────────────

async function sendPreview(id) {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (!win) throw new Error('no window')
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
    let dataUrl = null
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 70 })
      dataUrl = await downscalePreview(dataUrl, 480)
    } catch {
      dataUrl = null // restricted page / minimized window — name-only card
    }
    send({ type: 'preview-result', id, dataUrl, title: tab ? tab.title || '' : '', url: tab ? tab.url || '' : '' })
  } catch {
    send({ type: 'preview-result', id, dataUrl: null, title: '', url: '' })
  }
}

async function downscalePreview(dataUrl, maxW) {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, maxW / bmp.width)
    if (scale >= 1) return dataUrl
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    return await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.readAsDataURL(out)
    })
  } catch {
    return dataUrl
  }
}

// ── Capture loop ────────────────────────────────────────────────────────────

async function runCapture(id, target, mode) {
  // Resolve window + tab. A `target` (from a toolbar-icon click) pins the
  // capture to that exact window/tab; otherwise use the last-focused
  // window's active tab.
  let win = null
  if (target && target.windowId != null) {
    try { win = await chrome.windows.get(target.windowId) } catch { win = null }
  }
  if (!win) win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  if (!win) throw new Error('No browser window found')

  let [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
  if (target && target.tabId != null && (!tab || tab.id !== target.tabId)) {
    // The clicked tab lost active status between click and start — reactivate
    // it, since captureVisibleTab always photographs the window's active tab.
    try {
      await chrome.tabs.update(target.tabId, { active: true })
      tab = await chrome.tabs.get(target.tabId)
    } catch { /* fall back to whatever is active */ }
  }
  if (!tab || !tab.id) throw new Error('No active tab found')
  if (!/^(https?|file):/.test(tab.url || '')) {
    throw new Error('This page cannot be captured (browser-internal page)')
  }
  const tabId = tab.id

  // Bring this browser forward — the user watches the capture behind the
  // interaction-blocking overlay (and can hit its Stop button). Restore
  // first when minimized: focused:true alone doesn't un-minimize. The app
  // additionally raises this window natively (see extension-bridge.ts) since
  // the OS may deny foreground to a background browser process.
  try {
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' })
    await chrome.windows.update(win.id, { focused: true })
  } catch { /* ignore */ }

  // Arm the auto-cancel: once we've focused the capturing window, switching to
  // another window/app (windows.onFocusChanged) or another tab
  // (tabs.onActivated) aborts the capture. Set AFTER the focus call so the
  // focus handoff itself doesn't trip it.
  activeCapture.windowId = win.id
  activeCapture.tabId = tabId

  const exec = async (func, ...args) => {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args })
    return results && results[0] ? results[0].result : undefined
  }

  const meta = await exec(lumiaPrep, MAX_FRAMES, mode || 'fullpage')
  if (!meta) throw new Error('Could not read the page layout')
  if (meta.error) throw new Error(meta.error)

  send({ type: 'capture-meta', id, ...meta, url: tab.url, title: tab.title })

  try {
    // Interaction lock + status pill with Stop. The full-screen blocker is
    // transparent (never hidden, never flickers); only the small pill is
    // hidden for the instant each frame is photographed.
    await exec(lumiaShowOverlay, pageTheme())

    // Silent abort (user switched away) — tell the app to drop the session
    // without surfacing an error toast.
    const bail = () => { send({ type: 'capture-error', id, error: 'cancelled' }) }

    // Frames overlap by meta.overlap CSS px (scroll advances by meta.step);
    // the app discards the top strip of frames 1+ when stitching.
    const stepY = meta.step || meta.vpH
    for (let index = 0; index < meta.totalFrames; index++) {
      if (activeCapture.cancelled) { bail(); return }
      const isLast = index === meta.totalFrames - 1
      const targetY = Math.max(0, Math.min(index * stepY, meta.scrollHeight - meta.vpH))
      // Single-frame captures (viewport mode / non-scrolling selection) shoot
      // in place — lumiaScrollTo(0) would yank the page to the top and
      // photograph the wrong spot. The stitcher places a lone frame at 0.
      const scrollY = meta.totalFrames === 1
        ? 0
        : await exec(lumiaScrollTo, targetY, index, isLast, meta.totalFrames)
      await sleep(FRAME_DELAY_MS)
      if (activeCapture.cancelled) { bail(); return }

      // Late-overlay sweep AFTER the scroll settled: sticky bars, "Back to
      // top" buttons, and chat bubbles that mount (or turn position:fixed)
      // only in reaction to scrolling didn't exist when lumiaPrep scanned —
      // catch and hide them before photographing this frame.
      if (meta.totalFrames > 1) await exec(lumiaNeutralizeLate, index, isLast)

      // If the user switched tabs mid-capture, captureVisibleTab would start
      // photographing the wrong page — abort silently.
      const [nowActive] = await chrome.tabs.query({ active: true, windowId: win.id })
      if (!nowActive || nowActive.id !== tabId) { bail(); return }

      await exec(lumiaSetDimVisible, false) // resolves after repaint
      const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' })
      await exec(lumiaSetDimVisible, true)
      send({ type: 'frame', id, index, scrollY: typeof scrollY === 'number' ? scrollY : targetY, dataUrl })

      // Stop button: finish early — the app stitches the frames sent so far.
      if (activeCapture.stopRequested) break
    }
    send({ type: 'capture-done', id })
  } finally {
    try { await exec(lumiaRestore) } catch { /* page may have navigated away */ }
  }
}

// ── Page-context functions ──────────────────────────────────────────────────
// Injected via chrome.scripting.executeScript — each must be fully
// self-contained (no closure over this file). Shared state rides on
// window.__lumiaCap, which persists in the extension's isolated world
// across executeScript calls for the lifetime of the page.

async function lumiaPrep(maxFrames, mode) {
  try {
    const doc = document
    const de = doc.scrollingElement || doc.documentElement

    // 1. Freeze the environment: instant scrolling, paused animations,
    //    hidden scrollbars (hidden BEFORE measuring so layout is stable
    //    across every frame). background-attachment:fixed → scroll so
    //    parallax backgrounds scroll with the page instead of repeating
    //    in every frame (GoFullPage does the same conversion).
    const freezeCss = [
      'html { scroll-behavior: auto !important; }',
      '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; scroll-behavior: auto !important; background-attachment: scroll !important; }',
      '::-webkit-scrollbar { display: none !important; }',
      '* { scrollbar-width: none !important; }'
    ].join('\n')
    const styleEl = doc.createElement('style')
    styleEl.id = '__lumia-cap-style'
    styleEl.textContent = freezeCss
    doc.documentElement.appendChild(styleEl)
    // Freeze <style> elements injected into same-origin child frames (region
    // capture inside an iframe); tracked here so lumiaRestore can remove them.
    const extraStyles = []

    // 2. Pick the scroller. The document when it scrolls; otherwise the inner
    //    element (or same-origin iframe's element) that best matches "the
    //    main content pane". Ranking is lexicographic: contains the viewport
    //    CENTRE first (main panes span the middle of the screen; sidebars and
    //    detail rails don't), then WIDEST on screen (horizontal space is a
    //    design signal — sidebars are narrow by design no matter how long
    //    their content grows), with scrollHeight only as the tie-break for
    //    equal-width split panes. Ranking by scrollHeight alone (GoFullPage's
    //    rule, and ours before) systematically favours the WRONG pane: navs,
    //    ToCs, and detail rails accumulate endless lists while the main
    //    pane's length varies per page — a short Jira issue would stitch the
    //    right-hand details panel instead of the content. Apps like
    //    Gmail/Drive scroll an inner div; AWS Console and other consoles host
    //    the scroll region inside an iframe.
    // Ranking key: [containsCentre, clientWidth, scrollHeight] — earlier keys
    // win. Shared by the per-document search and the cross-frame comparison.
    const betterThan = (a, b) => {
      if (a[0] !== b[0]) return a[0] > b[0]
      if (a[1] !== b[1]) return a[1] > b[1]
      return a[2] > b[2]
    }
    const findScrollerIn = (searchDoc) => {
      let all
      try { all = searchDoc.querySelectorAll('*') } catch { return null }
      const n = Math.min(all.length, 30000)
      const view = searchDoc.defaultView || window
      const cx = view.innerWidth / 2, cy = view.innerHeight / 2
      let best = null, bestKey = null
      for (let i = 0; i < n; i++) {
        const el = all[i]
        if (el.scrollHeight - el.clientHeight < 120) continue
        if (el.clientWidth < 60 || el.clientHeight < 60) continue
        const cs = view.getComputedStyle(el)
        const oy = cs.overflowY
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue
        if (cs.pointerEvents === 'none') continue // decorative layer, not a pane
        const r = el.getBoundingClientRect()
        const key = [
          (r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy) ? 1 : 0,
          el.clientWidth,
          el.scrollHeight
        ]
        if (!bestKey || betterThan(key, bestKey)) { best = el; bestKey = key }
      }
      return best
    }

    let scroller = de
    let isDoc = true
    let frameChain = []   // outermost→innermost frames down to the scroller's doc
    let singleFrame = false
    let region = false    // true → crop output to the target box (no page chrome)

    // Frame chain from the top document down to `childDoc` (empty when the
    // scroller lives in the top document). Same-origin only — walking stops
    // at a cross-origin boundary, which can't happen for docs we can script.
    const chainFor = (childDoc) => {
      const chain = []
      try {
        let w = childDoc.defaultView
        while (w && w !== window && w.frameElement) {
          chain.unshift(w.frameElement)
          w = w.parent
        }
      } catch { /* boundary reached — return what we have */ }
      return chain
    }
    // Cumulative offset of the scroller's document into TOP-viewport coords:
    // each frame's rect is relative to ITS parent's viewport, so the offsets
    // sum down the chain (content box: border + padding included, matching
    // the region picker's math). Recomputed on use — layout may have shifted.
    const frameOffset = () => {
      let ox = 0, oy = 0
      for (const fe of frameChain) {
        try {
          const r = fe.getBoundingClientRect()
          const cs = (fe.ownerDocument.defaultView || window).getComputedStyle(fe)
          ox += r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)
          oy += r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)
        } catch { /* frame gone — offsets best-effort */ }
      }
      return { ox, oy }
    }

    if (mode === 'viewport') {
      // Just the current visible area — one frame, no scrolling.
      singleFrame = true
    } else if (mode === 'region') {
      // Capture exactly the element the user picked (window.__lumiaPickedEl).
      // If it scrolls, scroll-stitch its full content; otherwise capture it as
      // a single frame. No nested-pane guessing — the picker's ↑/↓ lets the
      // user land on the actual scroll container.
      const picked = window.__lumiaPickedEl
      if (!picked || !picked.isConnected) {
        styleEl.remove()
        return { error: 'No area was selected' }
      }
      region = true
      // The picked element may live in a same-origin (possibly NESTED) iframe
      // (AWS console). Record the frame chain so its rect is offset into
      // top-viewport coords — the same offsets the full-page path uses.
      if (picked.ownerDocument !== doc) {
        frameChain = chainFor(picked.ownerDocument)
      }
      const view = (picked.ownerDocument && picked.ownerDocument.defaultView) || window
      const oy = view.getComputedStyle(picked).overflowY
      const scrolls = picked.scrollHeight - picked.clientHeight > 8 &&
        (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
      if (scrolls) { scroller = picked; isDoc = false }
      else { singleFrame = true; scroller = picked; isDoc = false }
    } else if (de.scrollHeight <= de.clientHeight + 8) {
      // Full page: document doesn't scroll → pick the best scroller across
      // the top document AND same-origin (i)frames TOGETHER, ranked by the
      // same centre/width/scrollHeight key in TOP-viewport coordinates.
      // Consoles (AWS) host the real content scroller inside an iframe —
      // often as the frame's own scrolling document, which findScrollerIn
      // can't see (html/body compute overflowY:visible) — while the top
      // document still has minor scrollable rails; the old "frames only when
      // the top doc has nothing" rule handed the capture to those rails.
      const cxT = window.innerWidth / 2, cyT = window.innerHeight / 2
      const candidates = [] // { el, key } — key in top-viewport coords
      const addCandidate = (el, ox, oy, rectOverride) => {
        const r = rectOverride || el.getBoundingClientRect()
        const left = r.left + ox, topY = r.top + oy
        const right = left + r.width, bottom = topY + r.height
        if (right <= 0 || bottom <= 0 || left >= window.innerWidth || topY >= window.innerHeight) return
        candidates.push({
          el,
          key: [
            (left <= cxT && right >= cxT && topY <= cyT && bottom >= cyT) ? 1 : 0,
            el.clientWidth,
            el.scrollHeight
          ]
        })
      }
      let frameBudget = 40
      const walkDoc = (searchDoc, ox, oy, depth) => {
        const inner = findScrollerIn(searchDoc)
        if (inner) addCandidate(inner, ox, oy)
        let frames
        try { frames = searchDoc.querySelectorAll('iframe, frame') } catch { return }
        for (let i = 0; i < frames.length; i++) {
          if (frameBudget-- <= 0) return
          const fr = frames[i]
          let fdoc = null
          try { fdoc = fr.contentDocument } catch { fdoc = null } // cross-origin → skip
          if (!fdoc) continue
          const frr = fr.getBoundingClientRect()
          if (frr.width < 100 || frr.height < 100) continue
          const fcs = (fr.ownerDocument.defaultView || window).getComputedStyle(fr)
          const fox = ox + frr.left + (parseFloat(fcs.borderLeftWidth) || 0) + (parseFloat(fcs.paddingLeft) || 0)
          const foy = oy + frr.top + (parseFloat(fcs.borderTopWidth) || 0) + (parseFloat(fcs.paddingTop) || 0)
          // The frame's own document may be the scroller (a plain page
          // embedded in the frame): its viewport box starts at the frame's
          // content-box origin.
          const fde = fdoc.scrollingElement || fdoc.documentElement
          if (fde && fde.scrollHeight - fde.clientHeight >= 120) {
            addCandidate(fde, fox, foy, { left: 0, top: 0, width: fde.clientWidth, height: fde.clientHeight })
          }
          if (depth < 3) walkDoc(fdoc, fox, foy, depth + 1)
        }
      }
      walkDoc(doc, 0, 0, 0)
      let chosen = null, chosenKey = null
      for (const c of candidates) {
        if (!chosenKey || betterThan(c.key, chosenKey)) { chosen = c.el; chosenKey = c.key }
      }
      if (chosen) {
        scroller = chosen
        isDoc = false
        if (chosen.ownerDocument !== doc) {
          frameChain = chainFor(chosen.ownerDocument)
        }
      } else {
        // Nothing we can drive by scrollTop (transform-virtualized lists,
        // cross-origin frames, or a genuinely static page). Don't fail —
        // capture the single visible viewport, like GoFullPage does.
        singleFrame = true
      }
    }

    // When the scroller lives in a same-origin iframe (region capture inside
    // e.g. the AWS console frame), freeze that document too — otherwise its
    // scrollbars show and its sticky/fixed elements (collected below) can't be
    // reached, so they'd repeat down the stitched crop.
    if (!isDoc && scroller.ownerDocument && scroller.ownerDocument !== doc) {
      try {
        const fdoc = scroller.ownerDocument
        const fstyle = fdoc.createElement('style')
        fstyle.textContent = freezeCss
        fdoc.documentElement.appendChild(fstyle)
        extraStyles.push(fstyle)
      } catch { /* cross-origin / detached — skip */ }
    }

    // Save the user's scroll position BEFORE the warm-up moves it — restored
    // by lumiaRestore.
    const prevScrollTop = scroller.scrollTop
    const prevScrollLeft = scroller.scrollLeft

    // 2b. Warm-up scroll (GoFullPage technique): jump to the bottom and back
    //     to the top BEFORE measuring, so lazy-loaded content/images mount
    //     and scrollHeight reflects the real page. Also lets lazily-created
    //     sticky/fixed overlays exist before the collection pass below.
    if (!singleFrame) {
      const warm = isDoc ? de : scroller
      try {
        warm.scrollTop = warm.scrollHeight
        void warm.scrollTop
        await new Promise((r) => setTimeout(r, 250))
        warm.scrollTop = 0
        void warm.scrollTop
        await new Promise((r) => setTimeout(r, 120))
      } catch { /* keep going with whatever loaded */ }
    }

    // 3. Collect overlay elements (two passes: collect first, then mutate,
    //    so rect measurements aren't taken mid-reflow). Sticky elements are
    //    flattened to relative (position preserved, offsets zeroed) — they
    //    render once at their natural in-flow position instead of repeating
    //    in every frame; relative (not static) keeps them a positioned box
    //    so z-index/offsetParent-dependent layouts don't break. Fixed
    //    elements are hidden from the second frame on; bottom-anchored ones
    //    (floating footers, cookie bars) are hidden for mid-page frames and
    //    restored on the last frame so they land at the true page bottom.
    //    Scan the top document AND the scroller's document (an iframe) so
    //    sticky/fixed bars inside the frame are neutralized too.
    const fixed = []
    const sticky = []
    // Fixed→absolute conversions (GoFullPage technique, see below): every
    // touched element's full inline-style snapshot, restored by lumiaRestore.
    const converted = []
    const scanDocs = [doc]
    if (!isDoc && scroller.ownerDocument && scroller.ownerDocument !== doc) scanDocs.push(scroller.ownerDocument)

    // The scan is a closure so it can run AGAIN before every frame (via
    // st.neutralizeLate below): sticky add-to-cart bars, "Back to top"
    // buttons, and chat bubbles often mount — or only BECOME fixed/sticky via
    // a scroll handler — after the page scrolls, so a single up-front pass
    // misses them. Elements already classified are skipped via `seenOverlays`
    // (invisible fixed elements are deliberately NOT marked seen — they may
    // show later); new finds are also registered on fixed/sticky so
    // lumiaRestore unwinds them.
    const seenOverlays = new WeakSet()
    const scanOverlays = () => {
      const newFixed = []
      const newSticky = []
      for (const sdoc of scanDocs) {
        const view = sdoc.defaultView || window
        let all
        try { all = sdoc.querySelectorAll('*') } catch { continue }
        const n = Math.min(all.length, 30000)
        for (let i = 0; i < n; i++) {
          const el = all[i]
          if (seenOverlays.has(el)) continue
          if (el === styleEl) continue
          // Skip our own capture UI (blocker + status pill, added after prep).
          if (el.id === '__lumia-cap-blocker' || el.id === '__lumia-cap-dim') continue
          // Never neutralize the scroller itself or an ancestor that wraps it.
          // Some scroll panes live inside a fixed/sticky container (the AWS EC2
          // details drawer is fixed + bottom-anchored); hiding or flattening that
          // container would blank out the very region we're capturing. `.contains`
          // stops at frame boundaries, so every host frame down the chain is
          // guarded separately.
          if (!isDoc && (el === scroller || el.contains(scroller) ||
              frameChain.some((fr) => el === fr || el.contains(fr)))) continue
          const cs = view.getComputedStyle(el)
          if (cs.position === 'fixed') {
            if (cs.display === 'none' || cs.visibility === 'hidden') continue
            const r = el.getBoundingClientRect()
            if (r.width < 4 || r.height < 4) continue
            seenOverlays.add(el)
            const entry = {
              el,
              prevVisibility: el.style.getPropertyValue('visibility'),
              prevOpacity: el.style.getPropertyValue('opacity'),
              bottomAnchored: r.top > (view.innerHeight || window.innerHeight) * 0.5
            }
            fixed.push(entry)
            newFixed.push(entry)
          } else if (cs.position === 'sticky') {
            seenOverlays.add(el)
            const entry = { el, prevCssText: el.style.cssText }
            sticky.push(entry)
            newSticky.push(entry)
          }
        }
      }
      return { newFixed, newSticky }
    }
    const flattenSticky = (entries) => {
      for (const s of entries) {
        try {
          s.el.style.setProperty('position', 'relative', 'important')
          for (const p of ['top', 'left', 'right', 'bottom']) {
            s.el.style.setProperty(p, 'auto', 'important')
          }
        } catch { /* ignore */ }
      }
    }
    // Hide/show for overlay entries. opacity:0 rides along with
    // visibility:hidden because visibility is inheritable AND overridable: a
    // descendant carrying its own `visibility: visible` rule (expand/collapse
    // submenus animate exactly that way — e.g. Bitsight's open sidenav
    // section) pokes back through a hidden ancestor and repeats down the
    // stitch. Nothing pokes through an ancestor's opacity:0.
    const hideEntry = (f) => {
      try {
        f.el.style.setProperty('visibility', 'hidden', 'important')
        f.el.style.setProperty('opacity', '0', 'important')
      } catch { /* ignore */ }
    }
    const showEntry = (f) => {
      try {
        f.el.style.removeProperty('visibility')
        if (f.prevVisibility) f.el.style.setProperty('visibility', f.prevVisibility)
        f.el.style.removeProperty('opacity')
        if (f.prevOpacity) f.el.style.setProperty('opacity', f.prevOpacity)
      } catch { /* ignore */ }
    }
    scanOverlays()
    // Flatten sticky → relative + auto offsets only for multi-frame scroll
    // captures (so sticky bars don't repeat down the stitch). A single-frame
    // capture (viewport / non-scrolling selection / unscrollable fallback)
    // must show exactly what's on screen, so leave positions untouched.
    if (!singleFrame) flattenSticky(sticky)

    // 3a. Fixed → absolute conversion (GoFullPage's core technique, document
    //     scroll only). Instead of hiding ALL fixed chrome after frame 0,
    //     re-anchor it to the DOCUMENT so it appears once, at its natural
    //     place, in every frame consistently:
    //       - "header" bars (top < 20px, not reaching the viewport bottom)
    //         keep the existing treatment — visible in frame 0, hidden after;
    //       - offscreen elements (slide-in drawers) stay on the hide pipeline;
    //       - full-screen fixed overlays (taller than the viewport AND ≥ ⅔ of
    //         its width) are left alone — they tile seamlessly at every frame;
    //       - everything else (side rails, floating buttons, cookie bars)
    //         becomes position:absolute anchored against a position:relative
    //         <body>: an element with author top+bottom (Bitsight's sidenav)
    //         STRETCHES the full page height; one that scrolls internally gets
    //         height=scrollHeight so its whole menu is laid out; bottom-pinned
    //         bars land at the true page bottom.
    //     Runs at scrollTop 0 (same arrangement GoFullPage computes for its
    //     top frame) and stays applied for every frame, so the stitched
    //     slices always agree. All style snapshots go on `converted`.
    if (!singleFrame && isDoc) {
      try {
        const applyImportant = (el, props) => {
          let css = el.style.cssText + '; '
          for (const k in props) css += `${k}: ${props[k]} !important; `
          el.style.cssText = css
        }
        let bodyPrepped = false
        // Making <body> position:relative re-anchors absolute descendants
        // that previously anchored to the page itself (no positioned
        // ancestor) — pin those to their current document coordinates first
        // (GoFullPage's "hanging absolutes" fix), then promote the body.
        const prepBodyForAbsolute = () => {
          if (bodyPrepped) return
          bodyPrepped = true
          const body = doc.body
          if (!body) return
          const bcs = getComputedStyle(body)
          if (bcs.position !== 'static') return // already a containing block
          const hanging = []
          const queue = Array.prototype.slice.call(body.children)
          let steps = 0
          while (queue.length && steps++ < 15000) {
            const el = queue.shift()
            if (!el || el.nodeType !== 1) continue
            let cs2
            try { cs2 = getComputedStyle(el) } catch { continue }
            if (cs2.position === 'absolute') {
              const tag = el.nodeName.toLowerCase()
              if ((tag === 'iframe' || tag === 'img') &&
                  parseInt(cs2.width, 10) <= 5 && parseInt(cs2.height, 10) <= 5) continue
              hanging.push({ el, cs: cs2 })
            } else if (cs2.position === 'static') {
              for (const c of el.children) queue.push(c)
            }
            // positioned (relative/fixed/sticky) → its absolute descendants
            // anchor to it, unaffected by the body change — don't descend.
          }
          const br = body.getBoundingClientRect()
          const bx = br.left + window.scrollX
          const by = br.top + window.scrollY
          for (const h of hanging) {
            const prev = h.el.style.cssText
            applyImportant(h.el, {
              width: h.cs.width,
              height: h.cs.height,
              left: `${parseFloat(h.cs.left) - bx}px`,
              top: `${parseFloat(h.cs.top) + (parseFloat(bcs.marginTop) || 0) - by}px`,
              right: 'auto',
              bottom: 'auto'
            })
            converted.push({ el: h.el, prev })
          }
          const prevBody = body.style.cssText
          const bodyProps = { position: 'relative' }
          if (bcs.display === 'inline') bodyProps.display = 'block'
          applyImportant(body, bodyProps)
          converted.push({ el: body, prev: prevBody })
        }
        // Port of GoFullPage's fixed→absolute re-anchoring: read the fixed
        // element's used inset/size values and which of them the author
        // actually specified (computedStyleMap distinguishes 'auto'), flip to
        // absolute, then rebuild equivalent offsets against the offsetParent.
        const convertFixedToAbsolute = (el) => {
          const cs = getComputedStyle(el)
          const oldL = parseFloat(cs.left), oldR = parseFloat(cs.right)
          const oldT = parseFloat(cs.top), oldB = parseFloat(cs.bottom)
          const oldW = parseFloat(cs.width), oldH = parseFloat(cs.height)
          const sh = el.scrollHeight
          const oy = cs.overflowY
          let map = null
          try { map = el.computedStyleMap ? el.computedStyleMap() : null } catch { map = null }
          const spec = {}
          for (const p of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
            let s = false
            try { s = !!map && String(map.get(p).value) !== 'auto' } catch { s = false }
            spec[p] = s
          }
          const prev = el.style.cssText
          applyImportant(el, { position: 'absolute', transition: 'none' })
          converted.push({ el, prev })
          const op = el.offsetParent
          if (!op) return // anchors to the page as-is — good enough
          const b = op.getBoundingClientRect()
          const docH = de.scrollHeight, docW = de.scrollWidth
          const w = oldL - b.left
          const x = oldR - (docW - (b.left + b.width))
          const v = oldT - b.top
          const S = oldB - (docH - (b.top + b.height))
          const out = {}
          let anchored = false
          if (!isNaN(w) && w <= 0) {
            anchored = true
            if (spec.left || spec.right) {
              if (spec.left) out.left = `${w}px`
              if (spec.right) out.right = `${x}px`
            } else out.left = `${w}px`
          } else if (spec.right && !isNaN(x)) {
            anchored = true
            out.right = `${x}px`
          }
          if (!isNaN(v) && v <= 0) {
            anchored = true
            let hh = oldH
            // The element scrolls internally (a full-height sidebar menu) →
            // lay out ALL of its content instead of one viewport's worth.
            if (oy === 'scroll' || oy === 'auto') hh = Math.max(hh, sh)
            out.height = `${hh}px`
            if (spec.top || spec.bottom) {
              if (spec.top && spec.bottom) delete out.height // stretch instead
              if (spec.top) out.top = `${v}px`
              if (spec.bottom) out.bottom = `${S}px`
            } else if (oldB === 0 && b.height !== 0) {
              out.bottom = '0px'
            } else {
              out.top = `${v}px`
              out.bottom = 'auto'
            }
          } else if (spec.bottom && !isNaN(S)) {
            anchored = true
            out.bottom = (oldB === 0 && b.height !== 0) ? '0px' : `${S}px`
          }
          if ((out.left && !out.right) || (!out.left && out.right)) {
            if (spec.width) out.width = `${oldW}px`
          }
          if (anchored) {
            if (out.width) out['max-width'] = out.width
            if (out.height) out['max-height'] = out.height
            applyImportant(el, out)
          }
        }
        const vhNow = window.innerHeight, vwNow = window.innerWidth
        const hasOverflowHiddenParent = (el) => {
          const p = el.parentNode
          if (p && p !== doc.documentElement && p !== doc.body && p.nodeType === 1) {
            try { return getComputedStyle(p).overflow === 'hidden' } catch { return false }
          }
          return false
        }
        const keepFixed = []
        for (const f of fixed) {
          let r
          try { r = f.el.getBoundingClientRect() } catch { keepFixed.push(f); continue }
          const isHeader = r.top < 20 && r.height < vhNow - r.top - 20
          const offscreen = (r.top + r.height <= 0) || (r.left + r.width <= 0) ||
            (r.top > vhNow) || (r.left > vwNow)
          const tooBig = r.height > vhNow && r.width >= (vwNow * 2) / 3
          if (tooBig) continue // left alone entirely — tiles seamlessly
          // A parent with overflow:hidden doesn't clip a FIXED child but WOULD
          // clip it once absolute — keep those on the hide pipeline instead.
          if (isHeader || offscreen || hasOverflowHiddenParent(f.el)) {
            keepFixed.push(f)
            continue
          }
          try {
            prepBodyForAbsolute()
            convertFixedToAbsolute(f.el)
          } catch {
            keepFixed.push(f) // conversion failed → fall back to hiding
          }
        }
        fixed.length = 0
        for (const f of keepFixed) fixed.push(f)
      } catch { /* conversion is best-effort — hide pipeline + crops still apply */ }
    }

    // 3b. Pinned-chrome probe (multi-frame captures only). The computed-style
    //     scan above only sees position:fixed/sticky, but chrome can be pinned
    //     to the viewport by other means — a scroll handler re-anchoring a
    //     position:absolute sidebar, transform-pinned wrappers, sticky inside
    //     shadow roots. Those repeat in every frame, and when they span the
    //     MIDDLE of the viewport (a full-height pinned sidebar) the
    //     stitch-time edge crops can't remove them. Detect them empirically:
    //     measure each on-screen element's viewport rect at three scroll
    //     offsets (top, bottom, middle) — anything holding its exact viewport
    //     position across all three while the content scrolls under it is
    //     pinned. Three probes, not two, so a virtualized-list row that lands
    //     back on the same spot once can't be flagged. Flagged roots join
    //     `fixed` and get identical treatment (visible in frame 0 / at the
    //     bottom when bottom-anchored, hidden everywhere else).
    if (!singleFrame) {
      try {
        const clientH = scroller.clientHeight || window.innerHeight
        const maxScroll = Math.max(0, scroller.scrollHeight - clientH)
        if (maxScroll >= 300) {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          // Per-document probe box: only elements able to pollute the stitch
          // matter — the viewport when the document scrolls; the pane's box
          // (in each document's own coordinates) when an inner pane scrolls,
          // since chrome outside the pane is composited from frame 0 anyway.
          const boxes = new Map()
          if (isDoc) {
            boxes.set(doc, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
          } else {
            const sr = scroller.getBoundingClientRect()
            // Clamp to the client box — a frame's scrolling documentElement
            // reports its full CONTENT height as the bounding rect.
            const bw = Math.min(sr.width, scroller.clientWidth || sr.width)
            const bh = Math.min(sr.height, scroller.clientHeight || sr.height)
            boxes.set(scroller.ownerDocument, { x: sr.left, y: sr.top, w: bw, h: bh })
            if (scroller.ownerDocument !== doc) {
              const { ox, oy } = frameOffset()
              boxes.set(doc, { x: sr.left + ox, y: sr.top + oy, w: bw, h: bh })
            }
          }
          const probeEls = []
          const baseRects = []
          const collectFrom = (root) => {
            let all
            try { all = root.querySelectorAll('*') } catch { return }
            for (let i = 0; i < all.length && probeEls.length < 20000; i++) {
              const el = all[i]
              if (el.shadowRoot) collectFrom(el.shadowRoot)
              if (seenOverlays.has(el) || el === styleEl) continue
              if (!isDoc && (el === scroller || el.contains(scroller) ||
                  frameChain.some((fr) => el === fr || el.contains(fr)))) continue
              const sdoc = el.ownerDocument
              if (el === sdoc.documentElement || el === sdoc.body || el === sdoc.scrollingElement) continue
              const box = boxes.get(sdoc)
              if (!box) continue
              const r = el.getBoundingClientRect()
              if (r.width < 8 || r.height < 8) continue
              if (r.right < box.x || r.left > box.x + box.w || r.bottom < box.y || r.top > box.y + box.h) continue
              probeEls.push(el)
              baseRects.push({ top: r.top, left: r.left })
            }
          }
          for (const sdoc of scanDocs) collectFrom(sdoc)

          if (probeEls.length) {
            const stableAt = (i) => {
              const el = probeEls[i]
              if (!el.isConnected) return false
              const r = el.getBoundingClientRect()
              const b = baseRects[i]
              return Math.abs(r.top - b.top) <= 1.5 && Math.abs(r.left - b.left) <= 1.5
            }
            scroller.scrollTop = maxScroll
            void scroller.scrollTop
            await wait(220)
            const y1 = scroller.scrollTop
            const pass1 = []
            for (let i = 0; i < probeEls.length; i++) if (stableAt(i)) pass1.push(i)
            scroller.scrollTop = Math.floor(maxScroll / 2)
            void scroller.scrollTop
            await wait(180)
            const y2 = scroller.scrollTop
            // Both jumps must have really scrolled — otherwise every element
            // looks "stable" and the whole page would be flagged.
            if (y1 >= 200 && Math.abs(y1 - y2) >= 100 && pass1.length) {
              const pinned = new Set()
              for (const i of pass1) if (stableAt(i)) pinned.add(probeEls[i])
              // Descendants of pinned chrome are stable too — act only on the
              // outermost roots (elements already handled as fixed count as
              // covering ancestors). Hiding a root hides its subtree.
              const covered = new Set(pinned)
              for (const f of fixed) covered.add(f.el)
              const shadowHost = (n) => {
                const rn = n.getRootNode && n.getRootNode()
                return rn && rn.host ? rn.host : null
              }
              for (const el of pinned) {
                let p = el.parentElement || shadowHost(el)
                let isRoot = true
                while (p) {
                  if (covered.has(p)) { isRoot = false; break }
                  p = p.parentElement || shadowHost(p)
                }
                if (!isRoot) continue
                seenOverlays.add(el)
                const r = el.getBoundingClientRect()
                fixed.push({
                  el,
                  prevVisibility: el.style.getPropertyValue('visibility'),
                  prevOpacity: el.style.getPropertyValue('opacity'),
                  bottomAnchored: r.top > window.innerHeight * 0.5
                })
              }
            }
          }
        }
      } catch { /* best-effort — the stitch-time edge crops still guard the strips */ }
    }

    // 4. Scroll to top and measure AFTER all mutations settled.
    if (!singleFrame) {
      scroller.scrollTop = 0
      void scroller.scrollTop // force layout
    }

    const winW = window.innerWidth
    const winH = window.innerHeight
    let vpW, vpH, rect
    if (isDoc) {
      // Whole-document scroll, or the single-viewport fallback.
      vpW = singleFrame ? winW : (de.clientWidth || winW)
      vpH = singleFrame ? winH : (de.clientHeight || winH)
      rect = null
    } else {
      // Element/iframe scroller — rect in TOP-LEVEL viewport coordinates
      // (an iframe scroller's own rect is relative to the frame, so add the
      // cumulative frame-chain offset; empty chain → 0,0). A frame's
      // scrolling documentElement reports its full CONTENT size as the
      // bounding rect, so clamp root scrollers to their client (viewport)
      // box — otherwise the pane would claim rows below the frame's bottom.
      const sr = scroller.getBoundingClientRect()
      const isRootScroller = scroller ===
        (scroller.ownerDocument.scrollingElement || scroller.ownerDocument.documentElement)
      const visW = isRootScroller ? Math.min(sr.width, scroller.clientWidth || sr.width) : sr.width
      const visH = isRootScroller ? Math.min(sr.height, scroller.clientHeight || sr.height) : sr.height
      const { ox: offX, oy: offY } = frameOffset()
      const absLeft = sr.left + offX, absTop = sr.top + offY
      const absRight = sr.left + visW + offX, absBottom = sr.top + visH + offY
      const x = Math.max(0, absLeft)
      const y = Math.max(0, absTop)
      rect = {
        x,
        y,
        // Step by the VISIBLE strip height — the element's clientHeight can
        // exceed what's on screen when it pokes past the viewport. Floor so
        // the scroll step can never exceed the captured strip height (a
        // rounded-up step would leave 1px gap lines between strips).
        w: Math.max(1, Math.min(absRight, winW) - x),
        h: Math.max(1, Math.min(absBottom, winH) - y)
      }
      vpW = Math.floor(rect.w)
      vpH = Math.floor(rect.h)
    }
    if (!singleFrame && vpH < 50) {
      return { error: 'Scrollable area is too small to capture' }
    }

    // Overlap the scroll steps and let the app discard strips when stitching
    // (GoFullPage's core trick, extended to BOTH edges): the top `topOverlap`
    // of every frame after the first, and the bottom `bottomCrop` of every
    // frame except the last. Anything pinned to the viewport that the
    // neutralization above MISSED — JS/transform-pinned headers (AWS tables),
    // shadow-DOM sticky, and scroll-triggered overlays like "Back to top"
    // buttons that were hidden or absent during the collection pass — only
    // ever pollutes a discarded strip, so it can't repeat down the stitch.
    const topOverlap = singleFrame ? 0 : Math.min(isDoc ? 200 : 100, Math.floor(vpH / 3))
    const bottomCrop = singleFrame ? 0 : Math.min(isDoc ? 120 : 80, Math.floor(vpH / 4))
    const overlap = topOverlap + bottomCrop
    const step = Math.max(1, vpH - overlap)
    const rawScrollHeight = singleFrame ? vpH : scroller.scrollHeight
    // maxFrames cap: first frame covers vpH, each further frame adds `step`.
    const scrollHeight = Math.min(rawScrollHeight, vpH + (maxFrames - 1) * step)
    const totalFrames = singleFrame
      ? 1
      : 1 + Math.max(0, Math.ceil((scrollHeight - vpH) / step))

    if (totalFrames > 1) {
      for (const f of fixed) {
        if (f.bottomAnchored) hideEntry(f)
      }
    }

    window.__lumiaCap = {
      scroller: isDoc ? null : scroller,
      isDoc,
      fixed,
      sticky,
      converted,
      extraStyles,
      prevScrollTop,
      prevScrollLeft,
      // Mid-capture rescan, run right before each frame is photographed (a
      // closure survives across executeScript calls in the isolated world —
      // same trick as overlayKeyHandler). Frame 0 mirrors the initial pass
      // (top-pinned chrome stays visible for the first frame, bottom-anchored
      // hides unless this is also the last frame); later frames hide every
      // new fixed element immediately — except bottom-anchored ones found on
      // the last frame, which render once at the true page bottom like every
      // other bottom-anchored element.
      neutralizeLate: (frameIndex, isLast) => {
        const { newFixed, newSticky } = scanOverlays()
        flattenSticky(newSticky)
        for (const f of newFixed) {
          const keep = frameIndex === 0
            ? (!f.bottomAnchored || isLast)
            : (isLast && f.bottomAnchored)
          if (!keep) hideEntry(f)
        }
      },
      // Shared by lumiaScrollTo / lumiaRestore (closures survive across
      // executeScript calls) so every hide/show site applies the same
      // opacity+visibility pair and prev-style restore.
      hideEntry,
      showEntry
    }

    return {
      dpr: window.devicePixelRatio || 1,
      winW, winH, vpW, vpH,
      scrollHeight,
      rect,
      totalFrames,
      // Scroll advances by `step` (= vpH − overlap). When stitching, the app
      // crops `overlap − bottomCrop` CSS px off the top of frames 1+ and
      // `bottomCrop` off the bottom of every frame but the last. (Older apps
      // that predate bottomCrop crop the full `overlap` off the top instead —
      // still seamless, just without the bottom-pinned-overlay guard.)
      overlap,
      bottomCrop,
      step,
      // 'region' tells the app to crop the stitched output to `rect` (just the
      // picked area, no page chrome). 'viewport'/'fullpage' keep chrome.
      mode: region ? 'region' : (mode || 'fullpage')
    }
  } catch (e) {
    return { error: e && e.message ? e.message : 'Failed to prepare the page' }
  }
}

function lumiaShowOverlay(theme) {
  const st = window.__lumiaCap
  if (!st || document.getElementById('__lumia-cap-blocker')) return
  // Transparent click-blocker: stays up for the whole capture. Deliberately
  // INVISIBLE — it never needs hiding around shots, so nothing full-screen
  // ever flickers. (An earlier full-screen dim toggled around every frame
  // and strobed painfully.) The arrow cursor: macOS draws its own wait.
  const blocker = document.createElement('div')
  blocker.id = '__lumia-cap-blocker'
  blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:default;'
  const swallow = (e) => e.preventDefault()
  blocker.addEventListener('wheel', swallow, { passive: false })
  blocker.addEventListener('touchmove', swallow, { passive: false })

  // The only VISIBLE element: a Lumia wait toast (2026-11-26, the app's
  // ToastBox with an action: elevated, a line edge, the grey spinner, 12px
  // medium text, a 24px accent button, 40px tall), centred 8px from the top
  // like the app's toasts. In the app's theme (`theme` from the service
  // worker; before the app sent one, the system's light / dark), in a
  // shadow root so the page's CSS can't reach it. Hidden for the instant
  // each frame is photographed.
  const t = theme && theme.roles
    ? theme
    : (matchMedia('(prefers-color-scheme: dark)').matches
      ? { mode: 'dark', roles: theme.defaults.dark }
      : { mode: 'light', roles: theme.defaults.light })
  try {
    if (!window.__lumiaFont) {
      window.__lumiaFont = true
      for (const w of ['500', '600']) {
        const f = new FontFace('LumiaManrope', `url(${chrome.runtime.getURL(`fonts/manrope-${w}.woff2`)})`, { weight: w })
        document.fonts.add(f)
        f.load().catch(() => {})
      }
    }
  } catch { /* system font */ }
  const host = document.createElement('div')
  host.id = '__lumia-cap-dim'
  host.style.cssText = 'all:initial;position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;display:block;'
  for (const [k, v] of Object.entries(t.roles)) host.style.setProperty(`--${k}`, v)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>
    .toast { box-sizing: border-box; min-height: 40px; max-width: 420px; padding: 0 8px 0 12px; display: flex; align-items: center; gap: 8px;
      border: 1px solid var(--line); border-radius: 8px; background: var(--elevated);
      font-family: LumiaManrope, Manrope, -apple-system, BlinkMacSystemFont, sans-serif; cursor: default; user-select: none; }
    svg { width: 14px; height: 14px; flex-shrink: 0; fill: none; stroke: var(--fg-secondary); stroke-width: ${t.mode === 'light' ? '1.35px' : '1px'};
      stroke-linecap: round; stroke-linejoin: round; animation: spin 1s linear infinite; }
    svg * { vector-effect: non-scaling-stroke; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { svg { animation: none; } }
    .msg { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--fg); white-space: nowrap; font-variant-numeric: tabular-nums; }
    button { height: 24px; padding: 0 12px; margin: 0; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent);
      font: inherit; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: default; }
    button:hover { background: var(--accent-hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .toast.saving { padding-right: 12px; min-height: 32px; }
    .toast.saving button { display: none; }
  </style>
  <div class="toast" role="status">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    <span class="msg">Capturing page…</span>
    <button type="button">Stop and save</button>
  </div>`
  const toast = root.querySelector('.toast')
  const btn = root.querySelector('button')
  st.pillLabel = root.querySelector('.msg')
  btn.addEventListener('click', () => {
    // What's captured so far is saved; the toast says so until it's done.
    st.pillLabel.textContent = 'Saving…'
    toast.classList.add('saving')
    st.pillSaving = true
    try { chrome.runtime.sendMessage({ type: 'lumia-stop-clicked' }) } catch { /* ignore */ }
  })
  document.documentElement.append(blocker, host)

  // Block keyboard scrolling too (arrows, space, page keys) — programmatic
  // scrollTop writes from the capture loop are unaffected.
  const keyHandler = (e) => {
    if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
    }
  }
  window.addEventListener('keydown', keyHandler, true)
  st.overlayKeyHandler = keyHandler
}

function lumiaNeutralizeLate(index, isLast) {
  const st = window.__lumiaCap
  if (st && st.neutralizeLate) {
    // Never let a page-side surprise kill the capture — the stitch-time
    // overlap crops still guard the top/bottom strips if this pass fails.
    try { st.neutralizeLate(index, isLast) } catch { /* ignore */ }
  }
  return true
}

function lumiaSetDimVisible(visible) {
  // "dim" id kept for the toggle target, but the element is now the small
  // status pill — the only visible UI that must stay out of the frames.
  const dim = document.getElementById('__lumia-cap-dim')
  if (dim) dim.style.display = visible ? 'block' : 'none'
  // Resolve only after the compositor has repainted, so captureVisibleTab
  // right after this never photographs a half-hidden overlay.
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  })
}

function lumiaScrollTo(y, index, isLast, total) {
  const st = window.__lumiaCap
  if (!st) return null
  // The toast's count, the app's "(1 of 2)" form; it stays on "Saving…"
  // once Stop and save was pressed.
  const label = st.pillLabel
  if (label && !st.pillSaving && typeof total === 'number') {
    label.textContent = `Capturing page (${index + 1} of ${total})…`
  }
  if (index === 1) {
    for (const f of st.fixed) {
      if (!f.bottomAnchored) st.hideEntry(f)
    }
  }
  if (isLast) {
    for (const f of st.fixed) {
      if (f.bottomAnchored) st.showEntry(f)
    }
  }
  const sc = st.isDoc ? (document.scrollingElement || document.documentElement) : st.scroller
  if (!sc) return null
  sc.scrollTop = y
  void sc.scrollTop // force layout so the read below is post-scroll
  // Synthetic scroll event (GoFullPage does the same): virtualized lists and
  // lazy-loaders that render off scroll handlers get an immediate kick
  // instead of waiting for the async native event. When the scroller is a
  // frame's own document (scroll events fire on that frame's window, and
  // 'scroll' doesn't bubble from the html element), kick the frame's window.
  try {
    const rootOf = sc.ownerDocument &&
      (sc.ownerDocument.scrollingElement || sc.ownerDocument.documentElement)
    const target = st.isDoc
      ? window
      : (sc === rootOf ? (sc.ownerDocument.defaultView || sc) : sc)
    target.dispatchEvent(new Event('scroll'))
  } catch { /* ignore */ }
  return sc.scrollTop
}

function lumiaRestore() {
  const st = window.__lumiaCap
  if (!st) return
  try {
    const blocker = document.getElementById('__lumia-cap-blocker')
    if (blocker) blocker.remove()
    const dim = document.getElementById('__lumia-cap-dim')
    if (dim) dim.remove()
    if (st.overlayKeyHandler) window.removeEventListener('keydown', st.overlayKeyHandler, true)
    for (const f of st.fixed) {
      if (st.showEntry) st.showEntry(f)
      else {
        try {
          f.el.style.removeProperty('visibility')
          if (f.prevVisibility) f.el.style.setProperty('visibility', f.prevVisibility)
        } catch { /* ignore */ }
      }
    }
    for (const s of st.sticky) {
      // Flattening touched position + top/left/right/bottom — restore the
      // element's whole inline style snapshot instead of unpicking each.
      try { s.el.style.cssText = s.prevCssText || '' } catch { /* ignore */ }
    }
    // Fixed→absolute conversions (incl. the body promotion and hanging-
    // absolute pins) — full inline-style snapshots, restored verbatim.
    if (st.converted) {
      for (const c of st.converted) {
        try { c.el.style.cssText = c.prev || '' } catch { /* ignore */ }
      }
    }
    const styleEl = document.getElementById('__lumia-cap-style')
    if (styleEl) styleEl.remove()
    // Remove any freeze <style> injected into same-origin child frames.
    if (st.extraStyles) for (const s of st.extraStyles) { try { s.remove() } catch { /* frame gone */ } }
    const sc = st.isDoc ? (document.scrollingElement || document.documentElement) : st.scroller
    if (sc) {
      sc.scrollTop = st.prevScrollTop
      sc.scrollLeft = st.prevScrollLeft
    }
  } finally {
    delete window.__lumiaCap
    delete window.__lumiaPickedEl
  }
}

// Interactive element picker for the 'region' mode (2026-11-27, the path
// bar; design/REGION-PICKER.md). Drawn like the app's capture
// overlay: a 1px image-blue line around the part, an 18% dim outside it,
// the size under it, and one bar 32px from the top. The bar shows where
// the part sits in the page as a Segmented control (Page › Main › Article
// › List); the pill is the level the outline is on, the parts at that level
// are outlined faintly, and the keys are listed under it. Hover picks the
// part under the pointer; a click on a step, or ↑ / ↓, moves the outline
// out and back in along that path; ← / → move to the part before / after. Click / Enter captures, Esc / right-click /
// switching away cancels. On pick it stashes the element on
// window.__lumiaPickedEl and messages the service worker.
//
// Same-origin iframes (e.g. AWS console embeds content in a frame): the picker
// attaches its listeners to every reachable same-origin child document too and
// records each frame's offset into top-viewport coords, so elements *inside*
// the frame can be highlighted and picked. Cross-origin frames can't be
// scripted, so hovering inside one keeps the last highlight (the frame itself
// is still pickable from its edges).
function lumiaPickElement(theme) {
  return new Promise((resolve) => {
    if (window.__lumiaPicking) { resolve({ ok: false }); return }
    window.__lumiaPicking = true
    const t = theme && theme.roles
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches
        ? { mode: 'dark', roles: theme.defaults.dark }
        : { mode: 'light', roles: theme.defaults.light })
    const R = t.roles
    const dark = t.mode !== 'light'
    // Apps before 2026-11-27 don't send the image clip colour: the app's
    // value for the mode.
    const KIND = R['kind-image'] || (dark ? 'oklch(0.66 0.175 255)' : 'oklch(0.55 0.175 255)')
    const TOOLBAR = R.toolbar || (dark ? '#151515' : '#f7f7f7')
    try {
      if (!window.__lumiaFont) {
        window.__lumiaFont = true
        for (const w of ['500', '600']) {
          const f = new FontFace('LumiaManrope', `url(${chrome.runtime.getURL(`fonts/manrope-${w}.woff2`)})`, { weight: w })
          document.fonts.add(f)
          f.load().catch(() => {})
        }
      }
    } catch { /* system font */ }

    // The outline: the capture overlay's pick. A 1px line in the image clip
    // colour, never a tint inside, the 18% dim outside (a spread shadow).
    const hl = document.createElement('div')
    hl.style.cssText = `all:initial;position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:1px solid ${KIND};box-shadow:0 0 0 100vmax rgba(0,0,0,.18);display:none;`

    // The bar and the size label live in one shadow root so the page's CSS
    // can't reach them. Open, so a press's composedPath reaches the steps.
    const ui = document.createElement('div')
    ui.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;'
    for (const [k, v] of Object.entries(R)) ui.style.setProperty(`--${k}`, v)
    ui.style.setProperty('--kind-image', KIND)
    ui.style.setProperty('--toolbar', TOOLBAR)
    const root = ui.attachShadow({ mode: 'open' })
    // Lucide ArrowUp / ArrowDown / ArrowLeft / ArrowRight / CornerDownLeft /
    // ChevronRight.
    const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
    const ICON = {
      up: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
      down: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
      left: svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
      right: svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
      enter: svg('<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>'),
      chevron: svg('<path d="m9 18 6-6-6-6"/>'),
    }
    root.innerHTML = `<style>
      * { box-sizing: border-box; }
      .bar { position: fixed; top: 32px; left: 50%; transform: translateX(-50%); padding: 10px; border-radius: 8px;
        width: 480px; max-width: calc(100vw - 32px); box-sizing: border-box;
        background: var(--toolbar); box-shadow: inset 0 0 0 1px var(--line); pointer-events: auto;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        font-family: LumiaManrope, Manrope, -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; cursor: default; }
      svg { width: 14px; height: 14px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: ${dark ? '1px' : '1.35px'};
        stroke-linecap: round; stroke-linejoin: round; }
      svg * { vector-effect: non-scaling-stroke; }
      /* The path (2026-11-27, a breadcrumb): plain steps, the current one
         on the image-blue pill, a chevron between steps. */
      .seg { height: 32px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 2px; overflow: hidden; }
      .seg > * { flex-shrink: 0; }
      .seg button { all: unset; height: 28px; padding: 0 10px; display: inline-flex; align-items: center; border-radius: 6px;
        font-size: 12px; line-height: 16px; font-weight: 500; color: var(--fg-secondary); white-space: nowrap; cursor: default; }
      .seg button:hover { color: var(--fg); }
      .seg button.on { background: var(--kind-image); color: #fff; }
      .seg button.more { padding: 0 6px; color: var(--fg-tertiary); }
      .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .seg .sep { display: inline-flex; color: var(--fg-tertiary); }
      /* The keys (Settings › Wallpapers' keycap: 20px, line edge, 14px
         icon), each with a Meta-rank label. */
      .keys { display: flex; align-items: center; gap: 12px; }
      .key { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; line-height: 14px; font-weight: 500; color: var(--fg-secondary); white-space: nowrap; }
      kbd { all: unset; height: 20px; min-width: 24px; padding: 0 4px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        border-radius: 6px; border: 1px solid var(--line); color: var(--fg-secondary); font-size: 10px; font-weight: 500; }
      /* The capture overlay's size label (Overlay.tsx: h-6 px-2 rounded-md),
         24px tall, 8px sides (2026-11-27; it was 5px / 7px padding, ~21px). */
      .size { position: fixed; height: 24px; padding: 0 8px; border-radius: 6px; background: var(--toolbar); box-shadow: inset 0 0 0 1px var(--line);
        display: none; align-items: center; gap: 6px; white-space: nowrap; color: var(--fg);
        font: 500 11px/1 LumiaManrope, Manrope, -apple-system, BlinkMacSystemFont, sans-serif; font-variant-numeric: tabular-nums; }
      .tag { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--success-text); }
    </style>
    <div class="bar" role="toolbar" aria-label="Part of the page">
      <div class="seg"></div>
      <div class="keys" aria-hidden="true">
        <span class="key"><kbd>${ICON.up}</kbd><kbd>${ICON.down}</kbd>Out / in</span>
        <span class="key"><kbd>${ICON.left}</kbd><kbd>${ICON.right}</kbd>Previous / next</span>
        <span class="key"><kbd>${ICON.enter}</kbd>Capture</span>
        <span class="key"><kbd>esc</kbd>Cancel</span>
      </div>
    </div>
    <div class="size"><span class="dims"></span><span class="tag" hidden>Scrolls</span></div>`
    const seg = root.querySelector('.seg')
    const sizeBox = root.querySelector('.size')
    const sizeDims = root.querySelector('.dims')
    const sizeTag = root.querySelector('.tag')
    // Every part at the outline's level, the ones ← / → go to (2026-11-27,
    // Jasper): a faint blue line, under the dim (they're not the pick).
    // See-through (20%) rather than a lighter colour: the page under it can
    // be any colour, and a tint toward white glared and read as a second
    // pick. Drawn from a pool of boxes, at most NEAR_MAX.
    const NEAR = `color-mix(in srgb, ${KIND} 20%, transparent)`
    const NEAR_MAX = 300
    const nearLayer = document.createElement('div')
    nearLayer.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;display:block;'
    const nearPool = []
    const drawNear = (rects) => {
      while (nearPool.length < Math.min(rects.length, NEAR_MAX)) {
        const d = document.createElement('div')
        d.style.cssText = `all:initial;position:fixed;pointer-events:none;box-sizing:border-box;border:1px solid ${NEAR};display:none;`
        nearLayer.append(d)
        nearPool.push(d)
      }
      nearPool.forEach((d, k) => {
        const q = rects[k]
        if (!q) { d.style.display = 'none'; return }
        d.style.display = 'block'
        d.style.left = q.left + 'px'; d.style.top = q.top + 'px'
        d.style.width = q.width + 'px'; d.style.height = q.height + 'px'
      })
    }
    document.documentElement.append(nearLayer, hl, ui)

    // Collect same-origin documents (top + descendant frames) and each one's
    // offset into TOP-viewport coords. Cross-origin frames throw on
    // contentDocument and are skipped (can't be scripted).
    const offsets = new Map()   // doc -> { ox, oy }
    const listenerDocs = []
    const addDoc = (doc, ox, oy) => {
      offsets.set(doc, { ox, oy })
      listenerDocs.push(doc)
      let frames
      try { frames = doc.querySelectorAll('iframe, frame') } catch { return }
      for (const fr of frames) {
        let fdoc = null
        try { fdoc = fr.contentDocument } catch { fdoc = null }
        if (!fdoc) continue
        try {
          const r = fr.getBoundingClientRect()
          const cs = (fr.ownerDocument.defaultView || window).getComputedStyle(fr)
          const bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)
          const by = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)
          addDoc(fdoc, ox + r.left + bx, oy + r.top + by)
        } catch { /* frame not measurable — skip */ }
      }
    }
    addDoc(document, 0, 0)

    // The path: the hovered element and the parts around it, outermost
    // (body, "Page") first. `level` is the step the outline is on; the
    // steps after it stay until the pointer picks another part, so ↓ goes
    // back in. A step is a run of nested parts with the same edges
    // (2026-11-27, Jasper: five same-size boxes read as five steps that
    // capture the same picture): { members (outer to inner), el (what the
    // outline and the capture use: the one that scrolls, else the
    // outermost), name (the first real one, else "Box") }.
    let path = []
    let level = -1
    let armed = false      // set on first real move; guards blur/tab-hide cancel
    let finished = false
    let lastX = -1, lastY = -1
    const current = () => (level >= 0 && path[level] ? path[level].el : null)

    const offOf = (doc) => offsets.get(doc) || { ox: 0, oy: 0 }
    const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window
    const isScrollable = (el) => {
      if (!el || el.nodeType !== 1) return false
      const oy = viewOf(el).getComputedStyle(el).overflowY
      return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
        el.scrollHeight - el.clientHeight > 8
    }
    // A step's name: what the page says the part is, else "Box".
    const ROLE_NAMES = { main: 'Main', navigation: 'Navigation', banner: 'Header', contentinfo: 'Footer', complementary: 'Sidebar',
      article: 'Article', region: 'Section', dialog: 'Dialog', list: 'List', listitem: 'Item', table: 'Table', grid: 'Table',
      form: 'Form', search: 'Search', feed: 'Feed', tabpanel: 'Panel', menu: 'Menu', toolbar: 'Toolbar', figure: 'Figure', img: 'Image' }
    const TAG_NAMES = { body: 'Page', main: 'Main', nav: 'Navigation', header: 'Header', footer: 'Footer', aside: 'Sidebar',
      article: 'Article', section: 'Section', ul: 'List', ol: 'List', dl: 'List', li: 'Item', table: 'Table', thead: 'Table head',
      tbody: 'Rows', tr: 'Row', td: 'Cell', th: 'Cell', form: 'Form', fieldset: 'Group', p: 'Paragraph', blockquote: 'Quote',
      h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', figure: 'Figure', img: 'Image',
      picture: 'Image', svg: 'Graphic', canvas: 'Canvas', video: 'Video', iframe: 'Frame', pre: 'Code', code: 'Code',
      button: 'Button', a: 'Link', input: 'Field', textarea: 'Field', select: 'Menu', dialog: 'Dialog', details: 'Details' }
    const nameOf = (el) => {
      const role = el.getAttribute && el.getAttribute('role')
      if (role && ROLE_NAMES[role]) return ROLE_NAMES[role]
      const tag = TAG_NAMES[el.tagName.toLowerCase()]
      if (tag) return tag
      // A box holding only text (a span, a label) reads as Text.
      if (el.childElementCount === 0 && (el.textContent || '').trim()) return 'Text'
      return 'Box'
    }
    const sameBox = (a, b) => {
      const r = a.getBoundingClientRect(), q = b.getBoundingClientRect()
      return Math.abs(r.left - q.left) <= 1 && Math.abs(r.top - q.top) <= 1 &&
        Math.abs(r.width - q.width) <= 1 && Math.abs(r.height - q.height) <= 1
    }
    const makeStep = (members) => {
      const named = members.map(nameOf).find((n) => n !== 'Box')
      return { members, el: members.find(isScrollable) || members[0], name: named || 'Box' }
    }
    // n and the parts inside it with its edges, one level each.
    const groupDown = (n) => {
      const members = [n]
      for (;;) {
        const m = members[members.length - 1]
        // Not into an empty layer (a same-size decoration div): it has
        // nothing to step into, so ↓ died there (Google's question rows).
        const c = kidsOf(m).find((k) => !isEmptyLayer(k) && sameBox(k, m))
        if (!c) break
        members.push(c)
      }
      return members
    }
    const pathOf = (el) => {
      const raw = []
      for (let n = el; n && n.nodeType === 1 && n !== n.ownerDocument.documentElement; n = n.parentElement) raw.unshift(n)
      const steps = []
      let run = []
      for (const n of raw) {
        if (run.length && !sameBox(n, run[run.length - 1])) { steps.push(run); run = [] }
        run.push(n)
      }
      if (run.length) steps.push([...run, ...groupDown(run[run.length - 1]).slice(1)])
      return steps.map(makeStep)
    }

    // The bar keeps one width (2026-11-27, Jasper): the path fills its row
    // outward from the current step, one step each side in turn, as far as
    // it fits; what doesn't goes into "…" at that end, a click on which
    // steps past the fold.
    const mkStep = (i) => {
      const b = document.createElement('button')
      b.textContent = path[i].name
      b.dataset.lumiaStep = String(i)
      if (i === level) { b.className = 'on'; b.setAttribute('aria-pressed', 'true') }
      return b
    }
    const mkSep = () => {
      const s = document.createElement('span')
      s.className = 'sep'; s.innerHTML = ICON.chevron
      return s
    }
    const mkMore = (step, label) => {
      const b = document.createElement('button')
      b.className = 'more'; b.textContent = '…'
      b.dataset.lumiaStep = String(step)
      b.setAttribute('aria-label', label)
      return b
    }
    const renderBar = () => {
      seg.textContent = ''
      if (!path.length) return
      // Measure every step, a chevron and a "…" in place.
      const steps = path.map((_, i) => mkStep(i))
      const probeSep = mkSep(), probeMore = mkMore(0, '')
      seg.append(...steps, probeSep, probeMore)
      const gap = 2
      const w = steps.map((b) => b.offsetWidth)
      const sepW = probeSep.offsetWidth + gap, moreW = probeMore.offsetWidth + gap
      const avail = seg.clientWidth
      seg.textContent = ''
      const width = (a, b) => {
        let t = 0
        for (let i = a; i <= b; i++) t += w[i] + (i > a ? sepW + gap : 0)
        if (a > 0) t += moreW + sepW
        if (b < path.length - 1) t += moreW + sepW
        return t
      }
      let a = level, b = level
      for (let side = 0, stuck = 0; stuck < 2; side ^= 1) {
        if (side === 0 && a > 0 && width(a - 1, b) <= avail) { a--; stuck = 0 }
        else if (side === 1 && b < path.length - 1 && width(a, b + 1) <= avail) { b++; stuck = 0 }
        else stuck++
      }
      if (a > 0) seg.append(mkMore(a - 1, 'Outer parts'), mkSep())
      for (let i = a; i <= b; i++) {
        if (i > a) seg.append(mkSep())
        seg.append(steps[i])
      }
      if (b < path.length - 1) seg.append(mkSep(), mkMore(b + 1, 'Inner parts'))
    }

    const paint = () => {
      const el = current()
      if (!el) { hl.style.display = 'none'; drawNear([]); sizeBox.style.display = 'none'; renderBar(); return }
      const { ox, oy } = offOf(el.ownerDocument)
      const r = el.getBoundingClientRect()
      const L = r.left + ox, T = r.top + oy
      hl.style.display = 'block'
      hl.style.left = L + 'px'; hl.style.top = T + 'px'
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px'
      // The size under the pick (above it near the bottom edge, inside it
      // when neither fits), centred on it.
      // Its place among the parts at this level ("2 of 5"), and the others
      // outlined faintly (those on screen).
      const { list, i } = siblingsOf(path[level])
      sizeDims.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}` + (list.length > 1 ? `, ${i + 1} of ${list.length}` : '')
      const rects = []
      for (const n of list) {
        if (n === list[i]) continue
        const q = n.getBoundingClientRect()
        const nl = q.left + ox, nt = q.top + oy
        if (nt + q.height < 0 || nt > innerHeight || nl + q.width < 0 || nl > innerWidth) continue
        rects.push({ left: nl, top: nt, width: q.width, height: q.height })
        if (rects.length >= NEAR_MAX) break
      }
      drawNear(rects)
      sizeTag.hidden = !isScrollable(el)
      sizeBox.style.display = 'flex'
      const bw = sizeBox.offsetWidth, bh = sizeBox.offsetHeight
      let top = T + r.height + 8
      if (top + bh > innerHeight - 8) top = T - 8 - bh
      if (top < 8) top = Math.min(innerHeight - 8 - bh, T + r.height - 8 - bh)
      const left = Math.min(Math.max(8, L + r.width / 2 - bw / 2), innerWidth - 8 - bw)
      sizeBox.style.top = top + 'px'; sizeBox.style.left = left + 'px'
      renderBar()
    }

    // The steps ↓ would take from the last one (its first child that
    // shows, each level), so the bar shows what's inside the outlined part
    // too (2026-11-27, Jasper). At most DOWN_STEPS.
    const DOWN_STEPS = 3
    const extendDown = (p) => {
      const out = [...p]
      for (let i = 0; i < DOWN_STEPS; i++) {
        const last = out[out.length - 1]
        const c = last && kidsOf(last.members[last.members.length - 1]).find(shows)
        if (!c) break
        out.push(makeStep(groupDown(c)))
      }
      return out
    }
    let hovered = null
    const pickFromPointer = (el) => {
      if (el === hovered) return
      hovered = el
      const p = pathOf(el)
      level = p.length - 1
      path = extendDown(p)
      paint()
    }
    const stepTo = (i) => {
      if (i < 0 || i >= path.length || i === level) return
      armed = true
      level = i
      try { path[level].el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
      paint()
    }
    // ← / → move to the part before / after at the same level (a sibling;
    // 2026-11-27, Jasper), skipping ones that take no space (scripts,
    // hidden parts). The steps after the level belonged to the old part
    // and go.
    const shows = (el) => { if (isEmptyLayer(el)) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    // The parts at a step's level that show, and where the step's own
    // (outermost) part sits among them.
    const siblingsOf = (step) => {
      const own = step.members[0]
      const parent = own.parentElement
      const list = parent ? kidsOf(parent).filter((k) => k === own || shows(k)) : [own]
      return { list, i: Math.max(0, list.indexOf(own)) }
    }
    const stepSide = (dir) => {
      if (!path[level]) return
      const { list, i } = siblingsOf(path[level])
      const n = list[i + dir]
      if (!n) return
      armed = true
      path = extendDown([...path.slice(0, level), makeStep(groupDown(n))])
      try { path[level].el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
      paint()
    }
    // ↓ at the innermost step goes into its first child that shows.
    const stepIn = () => {
      if (level < path.length - 1) { stepTo(level + 1); return }
      const step = path[level]
      if (!step) return
      const c = kidsOf(step.members[step.members.length - 1]).find(shows)
      if (c) { path = extendDown([...path, makeStep(groupDown(c))]); stepTo(level + 1) }
    }

    const KEEP = new Set(['img', 'svg', 'video', 'canvas', 'picture', 'iframe', 'input', 'textarea', 'select', 'button', 'hr'])
    const isEmptyLayer = (n) => n.childElementCount === 0 && !KEEP.has(n.tagName.toLowerCase()) && !(n.textContent || '').trim()
    // A part's children as laid out: display:contents wrappers have no box,
    // their children stand in for them.
    const kidsOf = (n) => {
      const out = []
      for (const k of n.children) {
        let disp = ''
        try { disp = viewOf(k).getComputedStyle(k).display } catch { /* ignore */ }
        if (disp === 'contents') out.push(...kidsOf(k))
        else out.push(k)
      }
      return out
    }
    // The browser's hit test skips parts with pointer-events: none (Google's
    // result cards turn them off so clicks reach a whole-card link), so walk
    // down from the hit by hand: the last child whose box holds the point
    // (later ones paint on top), skipping empty layers. x / y in n's
    // document's viewport.
    const deepestAt = (n, x, y) => {
      for (let guard = 0; guard < 200; guard++) {
        const inside = kidsOf(n).filter((k) => {
          if (isEmptyLayer(k)) return false
          const r = k.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom
        })
        if (!inside.length) return n
        n = inside[inside.length - 1]
      }
      return n
    }
    // Each doc gets its own mousemove; e.currentTarget is that doc and
    // e.clientX/Y are in its viewport — convert to top coords via its offset.
    const move = (e) => {
      armed = true
      const doc = e.currentTarget
      const { ox, oy } = offOf(doc)
      const tx = e.clientX + ox, ty = e.clientY + oy
      if (lastX >= 0 && Math.abs(tx - lastX) < 4 && Math.abs(ty - lastY) < 4) return
      lastX = tx; lastY = ty
      // Everything under the pointer, top first; skip our own UI and empty
      // layers stretched over content (a card's whole-card link, a fade),
      // which would hide the parts under them (2026-11-27: Google's result
      // cards). None left (over a scrollbar) → keep the current outline.
      const all = doc.elementsFromPoint(e.clientX, e.clientY)
      if (all[0] === ui) return // over the bar
      const stack = all.filter((n) => n !== ui && n !== hl)
      const hit = stack.find((n) => !isEmptyLayer(n)) || stack[0]
      if (!hit) return
      pickFromPointer(deepestAt(hit, e.clientX, e.clientY))
    }
    const finish = (targetEl, viaMouse) => {
      if (finished) return
      finished = true
      for (const d of listenerDocs) {
        try {
          d.removeEventListener('mousemove', move, true)
          d.removeEventListener('mousedown', onDown, true)
          d.removeEventListener('keydown', key, true)
          d.removeEventListener('contextmenu', ctx, true)
          if (d.body) d.body.style.cursor = ''
        } catch { /* frame gone */ }
      }
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('visibilitychange', onVis)
      hl.remove(); ui.remove(); nearLayer.remove()
      delete window.__lumiaPicking
      // We commit on mousedown, so a mouseup (and maybe a click) still trail the
      // pick gesture — swallow them across every doc briefly so the page (or a
      // frame) doesn't act on it, then unhook. Only needed for a mouse pick.
      if (viaMouse) {
        const unhook = () => {
          for (const d of listenerDocs) {
            try { d.removeEventListener('mouseup', trail, true); d.removeEventListener('click', trail, true) } catch { /* frame gone */ }
          }
        }
        const trail = (e) => { e.preventDefault(); e.stopPropagation(); if (e.type === 'click') unhook() }
        for (const d of listenerDocs) {
          try { d.addEventListener('mouseup', trail, true); d.addEventListener('click', trail, true) } catch { /* frame gone */ }
        }
        setTimeout(unhook, 700) // fallback if no click follows the mousedown
      }
      if (targetEl) {
        window.__lumiaPickedEl = targetEl
        try { chrome.runtime.sendMessage({ type: 'lumia-region-picked' }) } catch { /* ignore */ }
      }
      resolve({ ok: !!targetEl })
    }
    // Commit the OUTLINED element on mousedown (native scrollbars fire no
    // click). A press on a step of the bar moves the outline instead; a
    // press elsewhere on the bar does nothing.
    const onDown = (e) => {
      const p = e.composedPath ? e.composedPath() : [e.target]
      const step = p.find((n) => n && n.nodeType === 1 && n.dataset && n.dataset.lumiaStep !== undefined)
      if (step || p.includes(ui)) {
        e.preventDefault(); e.stopPropagation()
        if (step && e.button === 0) stepTo(Number(step.dataset.lumiaStep))
        return
      }
      e.preventDefault(); e.stopPropagation()
      if (e.button !== 0) return // right = contextmenu cancels; ignore middle
      if (!current()) { const el = e.currentTarget.elementFromPoint(e.clientX, e.clientY); if (el) pickFromPointer(el) }
      finish(current() || null, true)
    }
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null) }
      else if (e.key === 'Enter' && current()) { e.preventDefault(); finish(current()) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepTo(level - 1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepIn() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepSide(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepSide(1) }
    }
    const ctx = (e) => { e.preventDefault(); finish(null) }
    // Switching away from the whole tab/window cancels the pick. Defer + check
    // hasFocus so moving focus INTO a same-origin child frame (which blurs the
    // top window but keeps the tab focused) doesn't cancel.
    const onBlur = () => {
      if (!armed) return
      setTimeout(() => { if (!finished && !document.hasFocus()) finish(null) }, 0)
    }
    const onVis = () => { if (document.hidden && armed) finish(null) }
    // The page (or a pane) scrolled: the outline follows its part.
    const onScroll = () => { if (current()) paint() }

    for (const d of listenerDocs) {
      try {
        d.addEventListener('mousemove', move, true)
        d.addEventListener('mousedown', onDown, true)
        d.addEventListener('keydown', key, true)
        d.addEventListener('contextmenu', ctx, true)
        if (d.body) d.body.style.cursor = 'crosshair'
      } catch { /* frame gone */ }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('visibilitychange', onVis)
    renderBar()
  })
}
