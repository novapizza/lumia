// Lumia Scroll Capture — MV3 service worker.
//
// Connects to the Lumia desktop app over a localhost WebSocket (see
// electron/extension-bridge.ts) and, on request, captures the active tab as
// a full-page screenshot: scroll in exact viewport steps, capture each
// viewport with chrome.tabs.captureVisibleTab, and stream frames + exact
// scroll offsets back to the app, which stitches them without any overlap
// guessing.
//
// The service worker stays alive during idle periods off the app's 20 s text
// pings (WebSocket message traffic resets Chrome's 30 s idle kill since 116);
// a chrome.alarms fallback reconnects if the socket ever drops.

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

// Connection status is a colored dot drawn onto the toolbar icon itself —
// green when the Lumia app is reachable, red when it isn't. (No badge text:
// a text badge covers a third of the icon.)
const STATUS_COLORS = { on: '#22c55e', off: '#ef4444' }
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
    ctx.strokeStyle = 'rgba(15,23,42,0.9)'
    ctx.stroke()
    imageData[String(size)] = ctx.getImageData(0, 0, size, size)
  }
  return imageData
}

async function updateBadge() {
  const connected = !!(ws && ws.readyState === WebSocket.OPEN)
  try {
    const key = connected ? 'on' : 'off'
    if (!statusIconCache[key]) statusIconCache[key] = await buildStatusIcons(STATUS_COLORS[key])
    chrome.action.setIcon({ imageData: statusIconCache[key] })
    chrome.action.setBadgeText({ text: '' }) // clear any leftover badge from older versions
    chrome.action.setTitle({
      title: connected
        ? 'Lumia Scroll Capture — capture this page'
        : 'Lumia Scroll Capture — Lumia app not running'
    })
  } catch { /* action API unavailable — ignore */ }
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
    if (ws === sock) { ws = null; updateBadge() }
    if (!opened) tryPort(i + 1)
  }
  sock.onerror = () => { /* onclose follows and advances the probe */ }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
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
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: lumiaPickElement })
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
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) })
    return // synchronous response
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
  if (msg.type === 'capture-cancel') {
    if (activeCapture && activeCapture.id === msg.id) activeCapture.cancelled = true
    return
  }
  if (msg.type === 'preview') {
    void sendPreview(msg.id)
    return
  }
  if (msg.type === 'capture-start') {
    if (activeCapture) {
      send({ type: 'capture-error', id: msg.id, error: 'A capture is already running' })
      return
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
    await exec(lumiaShowOverlay)

    // Silent abort (user switched away) — tell the app to drop the session
    // without surfacing an error toast.
    const bail = () => { send({ type: 'capture-error', id, error: 'cancelled' }) }

    for (let index = 0; index < meta.totalFrames; index++) {
      if (activeCapture.cancelled) { bail(); return }
      const isLast = index === meta.totalFrames - 1
      const targetY = Math.max(0, Math.min(index * meta.vpH, meta.scrollHeight - meta.vpH))
      const scrollY = await exec(lumiaScrollTo, targetY, index, isLast, meta.totalFrames)
      await sleep(FRAME_DELAY_MS)
      if (activeCapture.cancelled) { bail(); return }

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

function lumiaPrep(maxFrames, mode) {
  try {
    const doc = document
    const de = doc.scrollingElement || doc.documentElement

    // 1. Freeze the environment: instant scrolling, paused animations,
    //    hidden scrollbars (hidden BEFORE measuring so layout is stable
    //    across every frame).
    const styleEl = doc.createElement('style')
    styleEl.id = '__lumia-cap-style'
    styleEl.textContent = [
      'html { scroll-behavior: auto !important; }',
      '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; scroll-behavior: auto !important; }',
      '::-webkit-scrollbar { display: none !important; }',
      '* { scrollbar-width: none !important; }'
    ].join('\n')
    doc.documentElement.appendChild(styleEl)

    // 2. Pick the scroller. The document when it scrolls; otherwise the inner
    //    element (or same-origin iframe's element) with the MOST scrollable
    //    content. Choosing by scrollHeight (not on-screen area) matches
    //    GoFullPage and lands on the main content pane, not a wide-but-short
    //    wrapper. Apps like Gmail/Drive scroll an inner div; AWS Console and
    //    other consoles host the scroll region inside an iframe.
    const findScrollerIn = (searchDoc) => {
      let all
      try { all = searchDoc.querySelectorAll('*') } catch { return null }
      const n = Math.min(all.length, 30000)
      const vw = window.innerWidth, vh = window.innerHeight
      let best = null, bestScroll = 0
      let bestAny = null, bestAnyScroll = 0
      for (let i = 0; i < n; i++) {
        const el = all[i]
        if (el.scrollHeight - el.clientHeight < 120) continue
        if (el.clientWidth < 60 || el.clientHeight < 60) continue
        const oy = getComputedStyle(el).overflowY
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue
        if (el.scrollHeight > bestAnyScroll) { bestAny = el; bestAnyScroll = el.scrollHeight }
        if (el.clientWidth >= vw * 0.3 && el.clientHeight >= vh * 0.3 && el.scrollHeight > bestScroll) {
          best = el; bestScroll = el.scrollHeight
        }
      }
      return best || bestAny
    }

    let scroller = de
    let isDoc = true
    let iframeEl = null   // set when the scroller lives inside a same-origin frame
    let singleFrame = false
    let region = false    // true → crop output to the target box (no page chrome)

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
      const oy = getComputedStyle(picked).overflowY
      const scrolls = picked.scrollHeight - picked.clientHeight > 8 &&
        (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
      if (scrolls) { scroller = picked; isDoc = false }
      else { singleFrame = true; scroller = picked; isDoc = false }
    } else if (de.scrollHeight <= de.clientHeight + 8) {
      // Full page: document doesn't scroll → find the inner scroller.
      let chosen = findScrollerIn(doc)
      // Fall back to same-origin iframes. Cross-origin frames throw on
      // contentDocument access and are skipped.
      if (!chosen) {
        const frames = doc.querySelectorAll('iframe, frame')
        let bestFrameScroll = 0
        for (let i = 0; i < Math.min(frames.length, 40); i++) {
          const fr = frames[i]
          let fdoc = null
          try { fdoc = fr.contentDocument } catch { fdoc = null }
          if (!fdoc) continue
          const fr_r = fr.getBoundingClientRect()
          if (fr_r.width < 100 || fr_r.height < 100) continue
          const cand = findScrollerIn(fdoc)
          if (cand && cand.scrollHeight > bestFrameScroll) {
            chosen = cand; iframeEl = fr; bestFrameScroll = cand.scrollHeight
          }
        }
      }
      if (chosen) {
        scroller = chosen
        isDoc = false
      } else {
        // Nothing we can drive by scrollTop (transform-virtualized lists,
        // cross-origin frames, or a genuinely static page). Don't fail —
        // capture the single visible viewport, like GoFullPage does.
        singleFrame = true
      }
    }

    // 3. Collect overlay elements (two passes: collect first, then mutate,
    //    so rect measurements aren't taken mid-reflow). Sticky elements are
    //    flattened to static — they render once at their natural in-flow
    //    position instead of repeating in every frame. Fixed elements are
    //    hidden from the second frame on; bottom-anchored ones (floating
    //    footers, cookie bars) are hidden for mid-page frames and restored
    //    on the last frame so they land at the true page bottom.
    const fixed = []
    const sticky = []
    {
      const all = doc.querySelectorAll('*')
      const n = Math.min(all.length, 30000)
      for (let i = 0; i < n; i++) {
        const el = all[i]
        if (el === styleEl) continue
        const cs = getComputedStyle(el)
        if (cs.position === 'fixed') {
          if (cs.display === 'none' || cs.visibility === 'hidden') continue
          const r = el.getBoundingClientRect()
          if (r.width < 4 || r.height < 4) continue
          fixed.push({
            el,
            prevVisibility: el.style.getPropertyValue('visibility'),
            bottomAnchored: r.top > window.innerHeight * 0.5
          })
        } else if (cs.position === 'sticky') {
          sticky.push({ el, prevPosition: el.style.getPropertyValue('position') })
        }
      }
    }
    // Flatten sticky → static only for multi-frame scroll captures (so sticky
    // bars don't repeat down the stitch). A single-frame capture (viewport /
    // non-scrolling selection / unscrollable fallback) must show exactly
    // what's on screen, so leave positions untouched.
    if (!singleFrame) {
      for (const s of sticky) {
        try { s.el.style.setProperty('position', 'static', 'important') } catch { /* ignore */ }
      }
    }

    // 4. Scroll to top and measure AFTER all mutations settled.
    const prevScrollTop = scroller.scrollTop
    const prevScrollLeft = scroller.scrollLeft
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
      // frame's on-screen offset).
      const sr = scroller.getBoundingClientRect()
      let offX = 0, offY = 0
      if (iframeEl) { const frr = iframeEl.getBoundingClientRect(); offX = frr.left; offY = frr.top }
      const absLeft = sr.left + offX, absTop = sr.top + offY
      const absRight = sr.right + offX, absBottom = sr.bottom + offY
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

    const rawScrollHeight = singleFrame ? vpH : scroller.scrollHeight
    const scrollHeight = Math.min(rawScrollHeight, vpH * maxFrames)
    const totalFrames = singleFrame ? 1 : Math.max(1, Math.ceil(scrollHeight / vpH))

    if (totalFrames > 1) {
      for (const f of fixed) {
        if (f.bottomAnchored) {
          try { f.el.style.setProperty('visibility', 'hidden', 'important') } catch { /* ignore */ }
        }
      }
    }

    window.__lumiaCap = {
      scroller: isDoc ? null : scroller,
      isDoc,
      fixed,
      sticky,
      prevScrollTop,
      prevScrollLeft
    }

    return {
      dpr: window.devicePixelRatio || 1,
      winW, winH, vpW, vpH,
      scrollHeight,
      rect,
      totalFrames,
      // 'region' tells the app to crop the stitched output to `rect` (just the
      // picked area, no page chrome). 'viewport'/'fullpage' keep chrome.
      mode: region ? 'region' : (mode || 'fullpage')
    }
  } catch (e) {
    return { error: e && e.message ? e.message : 'Failed to prepare the page' }
  }
}

function lumiaShowOverlay() {
  const st = window.__lumiaCap
  if (!st || document.getElementById('__lumia-cap-blocker')) return
  // Transparent click-blocker: stays up for the whole capture. Deliberately
  // INVISIBLE — it never needs hiding around shots, so nothing full-screen
  // ever flickers. (An earlier full-screen dim toggled around every frame
  // and strobed painfully.)
  const blocker = document.createElement('div')
  blocker.id = '__lumia-cap-blocker'
  blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:wait;'
  const swallow = (e) => e.preventDefault()
  blocker.addEventListener('wheel', swallow, { passive: false })
  blocker.addEventListener('touchmove', swallow, { passive: false })

  // The only VISIBLE element is a small status pill at the bottom — hidden
  // for the instant each frame is photographed. A tiny corner blink is far
  // gentler on the eyes than a whole-page dim pulsing on and off.
  const pill = document.createElement('div')
  pill.id = '__lumia-cap-dim'
  pill.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 14px 10px 18px;border-radius:999px;background:rgba(15,23,42,0.92);color:#e2e8f0;box-shadow:0 6px 24px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;'
  const label = document.createElement('span')
  label.id = '__lumia-cap-label'
  label.textContent = 'Lumia is capturing this page…'
  label.style.cssText = 'font-size:13px;font-weight:600;white-space:nowrap;'
  const btn = document.createElement('button')
  btn.textContent = 'Stop & save'
  btn.style.cssText = 'padding:6px 16px;border-radius:999px;border:0;background:#ef4444;color:#fff;font-size:12px;font-weight:700;cursor:pointer;'
  btn.addEventListener('click', () => {
    btn.disabled = true
    btn.textContent = 'Stopping…'
    try { chrome.runtime.sendMessage({ type: 'lumia-stop-clicked' }) } catch { /* ignore */ }
  })
  pill.append(label, btn)
  document.documentElement.append(blocker, pill)

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

function lumiaSetDimVisible(visible) {
  // "dim" id kept for the toggle target, but the element is now the small
  // status pill — the only visible UI that must stay out of the frames.
  const dim = document.getElementById('__lumia-cap-dim')
  if (dim) dim.style.display = visible ? 'flex' : 'none'
  // Resolve only after the compositor has repainted, so captureVisibleTab
  // right after this never photographs a half-hidden overlay.
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  })
}

function lumiaScrollTo(y, index, isLast, total) {
  const st = window.__lumiaCap
  if (!st) return null
  const label = document.getElementById('__lumia-cap-label')
  if (label && typeof total === 'number') {
    label.textContent = `Lumia capturing ${index + 1}/${total}…`
  }
  if (index === 1) {
    for (const f of st.fixed) {
      if (!f.bottomAnchored) {
        try { f.el.style.setProperty('visibility', 'hidden', 'important') } catch { /* ignore */ }
      }
    }
  }
  if (isLast) {
    for (const f of st.fixed) {
      if (f.bottomAnchored) {
        try {
          f.el.style.removeProperty('visibility')
          if (f.prevVisibility) f.el.style.setProperty('visibility', f.prevVisibility)
        } catch { /* ignore */ }
      }
    }
  }
  const sc = st.isDoc ? (document.scrollingElement || document.documentElement) : st.scroller
  if (!sc) return null
  sc.scrollTop = y
  void sc.scrollTop // force layout so the read below is post-scroll
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
      try {
        f.el.style.removeProperty('visibility')
        if (f.prevVisibility) f.el.style.setProperty('visibility', f.prevVisibility)
      } catch { /* ignore */ }
    }
    for (const s of st.sticky) {
      try {
        s.el.style.removeProperty('position')
        if (s.prevPosition) s.el.style.setProperty('position', s.prevPosition)
      } catch { /* ignore */ }
    }
    const styleEl = document.getElementById('__lumia-cap-style')
    if (styleEl) styleEl.remove()
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

// Interactive element picker for the 'region' mode. Hovering highlights the
// element under the cursor (green outline = it scrolls, cyan = static) and the
// tip shows what it is. A d-pad (or ↑ ↓ ← → keys) refines the selection along
// the DOM tree: ▲/↑ parent, ▼/↓ child, ◀▶/←→ same-level siblings — so you can
// reach a scroll pane covered by children without hunting for a bare spot.
// Click / Enter captures exactly that element; Esc / right-click / switching
// away cancels. On pick it stashes the element on window.__lumiaPickedEl and
// messages the service worker.
function lumiaPickElement() {
  return new Promise((resolve) => {
    if (window.__lumiaPicking) { resolve({ ok: false }); return }
    window.__lumiaPicking = true
    const prevCursor = document.body ? document.body.style.cursor : ''
    const hl = document.createElement('div')
    hl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #00e3fd;background:rgba(0,227,253,0.12);box-sizing:border-box;transition:all .04s;'
    const tip = document.createElement('div')
    tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:12px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.96);color:#e2e8f0;font:600 12px system-ui,sans-serif;padding:8px 14px;border-radius:9px;box-shadow:0 4px 20px rgba(0,0,0,0.45);text-align:center;'
    const tipInfo = document.createElement('div')
    tipInfo.textContent = 'Click an element to capture'
    // A d-pad to refine the selection along the DOM tree without moving the
    // mouse: ▲ out a level (parent) · ▼ in a level (child) · ◀ ▶ same-level
    // siblings · centre ⏎ captures the current selection. Buttons + the
    // ↑ ↓ ← → / Enter keys both drive this.
    const pad = document.createElement('div')
    pad.style.cssText = 'display:grid;grid-template-columns:repeat(3,24px);grid-template-rows:repeat(3,20px);gap:3px;justify-content:center;margin:6px 0 4px;'
    const mkBtn = (dir, glyph, title) => {
      const b = document.createElement('button')
      b.setAttribute('data-lumia-nav', dir)
      b.title = title
      b.textContent = glyph
      b.style.cssText = 'pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#e2e8f0;border-radius:5px;font:600 11px system-ui,sans-serif;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;'
      return b
    }
    const spacer = () => document.createElement('span')
    const bEnter = mkBtn('enter', '⏎', 'Capture this element')
    // Accent the capture button so the centre reads as the confirm action.
    bEnter.style.background = 'rgba(0,227,253,0.18)'
    bEnter.style.borderColor = 'rgba(0,227,253,0.5)'
    bEnter.style.color = '#7dd3fc'
    pad.append(
      spacer(), mkBtn('up', '▲', 'Parent — out a level'), spacer(),
      mkBtn('left', '◀', 'Previous sibling'), bEnter, mkBtn('right', '▶', 'Next sibling'),
      spacer(), mkBtn('down', '▼', 'Child — in a level'), spacer()
    )
    const tipMain = document.createElement('div')
    tipMain.style.cssText = 'margin-top:2px;font-weight:500;font-size:11px;opacity:.9;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    const legend = document.createElement('div')
    legend.textContent = '↑ parent · ↓ child · ← → sibling · ⏎ Enter capture · Esc cancel'
    legend.style.cssText = 'margin-top:4px;font-weight:500;font-size:10px;opacity:.55;'
    tip.append(tipInfo, pad, tipMain, legend)
    // Hover styling for the nav buttons (inline styles can't do :hover).
    const styleTag = document.createElement('style')
    styleTag.textContent = '[data-lumia-nav]:hover{background:rgba(0,227,253,0.25)!important;border-color:rgba(0,227,253,0.6)!important}'
    document.documentElement.append(hl, tip, styleTag)

    let current = null     // element currently highlighted (the one a click picks)
    let armed = false      // set on first real move; guards blur/tab-hide cancel

    const isScrollable = (el) => {
      if (!el || el.nodeType !== 1) return false
      const oy = getComputedStyle(el).overflowY
      return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
        el.scrollHeight - el.clientHeight > 8
    }
    const shortName = (el) => {
      let s = el.tagName.toLowerCase()
      if (el.id) s += '#' + el.id
      else if (typeof el.className === 'string' && el.className.trim()) {
        s += '.' + el.className.trim().split(/\s+/)[0]
      }
      return s
    }
    const paint = (el) => {
      current = el
      if (!el) { hl.style.display = 'none'; tipMain.textContent = ''; return }
      const r = el.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px'
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px'
      const scr = isScrollable(el)
      hl.style.borderColor = scr ? '#22c55e' : '#00e3fd'
      hl.style.background = scr ? 'rgba(34,197,94,0.16)' : 'rgba(0,227,253,0.12)'
      tipMain.textContent = (scr ? '✓ scrolls · ' : 'static · ') + shortName(el) +
        '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    }
    const setFromPoint = (x, y) => {
      hl.style.display = 'none'
      const el = document.elementFromPoint(x, y)
      hl.style.display = 'block'
      // Over a native scrollbar elementFromPoint returns null — keep the
      // current highlight instead of dropping it, so a scroll pane you've
      // pointed at stays selected while the cursor grazes its scrollbar.
      if (!el || el === tip || el === hl || tip.contains(el)) return
      if (el !== current) paint(el)
    }
    // D-pad / arrow-key navigation: walk the DOM tree from the current element.
    const isElem = (n) => !!n && n.nodeType === 1
    const navigate = (dir) => {
      if (!current) return
      let next = null
      if (dir === 'up') { const p = current.parentElement; if (p && p !== document.documentElement) next = p }
      else if (dir === 'down') { if (isElem(current.firstElementChild)) next = current.firstElementChild }
      else if (dir === 'left') { if (isElem(current.previousElementSibling)) next = current.previousElementSibling }
      else if (dir === 'right') { if (isElem(current.nextElementSibling)) next = current.nextElementSibling }
      if (!next) return
      armed = true
      // Bring it into view (in case a sibling/child is off-screen), then paint
      // at the settled position.
      try { next.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
      paint(next)
    }

    let lastX = -1, lastY = -1
    const move = (e) => {
      armed = true
      // Ignore sub-pixel jitter so a d-pad / arrow-key selection isn't clobbered
      // by a tiny mouse twitch before the click.
      if (lastX >= 0 && Math.abs(e.clientX - lastX) < 4 && Math.abs(e.clientY - lastY) < 4) return
      lastX = e.clientX; lastY = e.clientY
      setFromPoint(e.clientX, e.clientY)
    }
    let finished = false
    const finish = (targetEl, viaMouse) => {
      if (finished) return
      finished = true
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('contextmenu', ctx, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVis)
      hl.remove(); tip.remove(); styleTag.remove()
      if (document.body) document.body.style.cursor = prevCursor
      delete window.__lumiaPicking
      // We commit on mousedown, so a mouseup (and maybe a click) still trail the
      // pick gesture — swallow them briefly so the page doesn't act on it (link
      // nav, button press), then unhook. Only needed for a mouse pick.
      if (viaMouse) {
        const trail = (e) => {
          e.preventDefault(); e.stopPropagation()
          if (e.type === 'click') { // click is the last of the trio — unhook
            document.removeEventListener('mouseup', trail, true)
            document.removeEventListener('click', trail, true)
          }
        }
        document.addEventListener('mouseup', trail, true)
        document.addEventListener('click', trail, true)
        setTimeout(() => {
          document.removeEventListener('mouseup', trail, true)
          document.removeEventListener('click', trail, true)
        }, 700) // fallback if no click follows the mousedown
      }
      if (targetEl) {
        window.__lumiaPickedEl = targetEl
        // Tell the service worker to start the region capture. (The popup has
        // already closed, so we can't return this up the executeScript chain.)
        try { chrome.runtime.sendMessage({ type: 'lumia-region-picked' }) } catch { /* ignore */ }
      }
      resolve({ ok: !!targetEl })
    }
    // Commit the HIGHLIGHTED element on mousedown — more reliable than waiting
    // for a click (native scrollbars fire no DOM click, and some widgets change
    // target between down and up so the click never lands on the pane). A press
    // on a d-pad button adjusts the selection instead of committing.
    const onDown = (e) => {
      const navBtn = e.target && e.target.closest ? e.target.closest('[data-lumia-nav]') : null
      if (navBtn) {
        e.preventDefault(); e.stopPropagation()
        const dir = navBtn.getAttribute('data-lumia-nav')
        if (dir === 'enter') { if (current) finish(current, true) }
        else navigate(dir)
        return
      }
      e.preventDefault(); e.stopPropagation()
      if (e.button !== 0) return // right = contextmenu cancels; ignore middle
      if (!current) setFromPoint(e.clientX, e.clientY)
      finish(current || null, true)
    }
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null) }
      else if (e.key === 'Enter' && current) { e.preventDefault(); finish(current) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); navigate('up') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); navigate('down') }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate('left') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate('right') }
    }
    const ctx = (e) => { e.preventDefault(); finish(null) }
    // Switching away from the tab/window cancels the pick.
    const onBlur = () => { if (armed) finish(null) }
    const onVis = () => { if (document.hidden && armed) finish(null) }

    document.addEventListener('mousemove', move, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('contextmenu', ctx, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVis)
    if (document.body) document.body.style.cursor = 'crosshair'
  })
}
