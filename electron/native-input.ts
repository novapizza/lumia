/**
 * Native Win32 input simulation via koffi FFI.
 * Replaces PowerShell-based scroll/key simulation with direct user32.dll calls.
 * ~0ms overhead per call vs ~200-500ms PowerShell cold start.
 *
 * Only loaded on Windows — macOS uses the existing Swift scroll helper.
 */

// ── Win32 constants ──────────────────────────────────────────────────────

export const MOUSEEVENTF_WHEEL = 0x0800
export const KEYEVENTF_KEYUP = 0x0002

export const VK_CONTROL = 0x11
export const VK_HOME = 0x24
export const VK_DOWN = 0x28
export const VK_NEXT = 0x22 // Page Down
export const VK_UP = 0x26

export const WM_VSCROLL = 0x0115
export const SB_LINEDOWN = 1
export const SB_TOP = 6

// ── koffi bindings (lazy-loaded) ─────────────────────────────────────────

let _loaded = false
let _SetCursorPos: (x: number, y: number) => boolean
let _mouse_event: (flags: number, dx: number, dy: number, data: number, extra: number) => void
let _keybd_event: (vk: number, scan: number, flags: number, extra: number) => void
let _SendMessageW: (hwnd: any, msg: number, wParam: any, lParam: any) => any
let _WindowFromPoint: (pt: { x: number; y: number }) => any
let _ScreenToClient: (hwnd: any, pt: { x: number; y: number }) => boolean
let _ChildWindowFromPointEx: (hwnd: any, pt: { x: number; y: number }, flags: number) => any
let _SetForegroundWindow: (hwnd: any) => boolean
let _GetWindowRect: (hwnd: any, rect: any) => boolean
let _GetAncestor: (hwnd: any, flags: number) => any
let _IsWindowVisible: (hwnd: any) => boolean
let _GetWindowLongW: (hwnd: any, index: number) => number
let _GetWindow: (hwnd: any, uCmd: number) => any
let _GetTopWindow: (hwnd: any) => any
let _GetForegroundWindow: () => any
let _GetWindowThreadProcessId: (hwnd: any, pid: any) => number
let _GetClassNameW: (hwnd: any, buf: any, maxCount: number) => number
let _GetWindowTextLengthW: (hwnd: any) => number
let _GetWindowTextW: (hwnd: any, buf: any, maxCount: number) => number
let _ShowWindow: (hwnd: any, nCmdShow: number) => boolean
let _EnumWindows: (callback: any, lParam: any) => boolean
let _DwmGetWindowAttribute: (hwnd: any, attr: number, pvAttribute: any, cbAttribute: number) => number
// Same DWM API but with the output typed as a DWORD pointer — used for
// scalar attributes like DWMWA_CLOAKED where the RECT-shaped binding above
// would over-allocate and read garbage past the first 4 bytes.
let _DwmGetWindowAttributeDword: (hwnd: any, attr: number, pvAttribute: any, cbAttribute: number) => number
let _DwmSetWindowAttribute: (hwnd: any, attr: number, pvAttribute: any, cbAttribute: number) => number
let _IsIconic: (hwnd: any) => boolean
let _GetLayeredWindowAttributes: (hwnd: any, key: any, alpha: any, flags: any) => boolean
let _SetThreadDpiAwarenessContext: (ctx: any) => any
let _SetWindowDisplayAffinity: (hwnd: any, affinity: number) => boolean
const DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = -2       // passed as negative intptr_t handle
const DPI_AWARENESS_CONTEXT_PER_MONITOR_V2 = -4

function ensureLoaded(): boolean {
  if (_loaded) return true
  if (process.platform !== 'win32') return false

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')

    // Define POINT struct for WindowFromPoint / ScreenToClient
    const POINT = koffi.struct('POINT', { x: 'int', y: 'int' })
    const RECT  = koffi.struct('RECT',  { left: 'int', top: 'int', right: 'int', bottom: 'int' })

    const user32 = koffi.load('user32.dll')

    _SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
    _mouse_event = user32.func('void __stdcall mouse_event(int dwFlags, int dx, int dy, int dwData, uintptr_t dwExtraInfo)')
    _keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)')
    _SendMessageW = user32.func('intptr_t __stdcall SendMessageW(intptr_t hWnd, uint32_t Msg, intptr_t wParam, intptr_t lParam)')
    _WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT pt)')
    _ScreenToClient = user32.func('bool __stdcall ScreenToClient(intptr_t hWnd, _Inout_ POINT *pt)')
    _ChildWindowFromPointEx = user32.func('intptr_t __stdcall ChildWindowFromPointEx(intptr_t hWnd, POINT pt, uint32_t flags)')
    _SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
    _GetWindowRect   = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *lpRect)')
    _GetAncestor     = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t gaFlags)')
    _IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
    _GetWindowLongW  = user32.func('int32_t __stdcall GetWindowLongW(intptr_t hWnd, int nIndex)')
    // Bound once here (rather than per-call) because getWindowAtPointPhysical
    // is driven by the overlay's ~10/s hover poll — re-running koffi.load +
    // user32.func on every call was pure overhead.
    _GetWindow       = user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)')
    _GetTopWindow    = user32.func('intptr_t __stdcall GetTopWindow(intptr_t hWnd)')
    _GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
    _GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)')
    _GetClassNameW   = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)')
    _GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)')
    _GetWindowTextW  = user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
    _ShowWindow      = user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)')
    _EnumWindows     = user32.func('bool __stdcall EnumWindows(intptr_t lpEnumFunc, intptr_t lParam)')
    // SetThreadDpiAwarenessContext is available on Win10 1607+. Used to force
    // GetWindowRect to return virtualized (primary-scale) DIP coords, dodging
    // the per-monitor physical-pixel math entirely.
    try {
      _SetThreadDpiAwarenessContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t dpiContext)')
    } catch { /* older Windows: leave undefined, caller falls back to raw rect */ }
    _SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(intptr_t hWnd, uint32_t dwAffinity)')

    const dwmapi = koffi.load('dwmapi.dll')
    _DwmGetWindowAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)')
    _DwmGetWindowAttributeDword = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)')
    _DwmSetWindowAttribute = dwmapi.func('int32_t __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _In_ uint32_t *pvAttribute, uint32_t cbAttribute)')
    _IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)')
    _GetLayeredWindowAttributes = user32.func('bool __stdcall GetLayeredWindowAttributes(intptr_t hWnd, _Out_ uint32_t *pcrKey, _Out_ uint8_t *pbAlpha, _Out_ uint32_t *pdwFlags)')
    void RECT // suppress unused warning

    _loaded = true
    return true
  } catch (err) {
    return false
  }
}

/** Check if native input is available (koffi loaded on Windows) */
export function isNativeAvailable(): boolean {
  return ensureLoaded()
}

// ── Low-level functions ──────────────────────────────────────────────────

export function setCursorPos(x: number, y: number): boolean {
  if (!ensureLoaded()) return false
  return _SetCursorPos(Math.round(x), Math.round(y))
}

export function mouseEvent(flags: number, dx: number, dy: number, data: number): void {
  if (!ensureLoaded()) return
  _mouse_event(flags, dx, dy, data, 0)
}

export function keybdEvent(vk: number, scan: number, flags: number): void {
  if (!ensureLoaded()) return
  _keybd_event(vk, scan, flags, 0)
}

export function sendMessage(hwnd: any, msg: number, wParam: any, lParam: any): any {
  if (!ensureLoaded()) return 0
  return _SendMessageW(hwnd, msg, wParam, lParam)
}

export function windowFromPoint(x: number, y: number): any {
  if (!ensureLoaded()) return 0
  return _WindowFromPoint({ x: Math.round(x), y: Math.round(y) })
}

export function childWindowFromPointEx(hwnd: any, x: number, y: number, flags: number): any {
  if (!ensureLoaded()) return 0
  const pt = { x: Math.round(x), y: Math.round(y) }
  _ScreenToClient(hwnd, pt)
  return _ChildWindowFromPointEx(hwnd, pt, flags)
}

// ── High-level helpers ───────────────────────────────────────────────────

/** Send a single key press (key down + key up) */
export function sendKeyPress(vk: number): void {
  keybdEvent(vk, 0, 0) // key down
  keybdEvent(vk, 0, KEYEVENTF_KEYUP) // key up
}

/** Send mouse wheel scroll at current cursor position */
export function scrollMouseWheel(cx: number, cy: number, wheelDelta: number): void {
  setCursorPos(cx, cy)
  mouseEvent(MOUSEEVENTF_WHEEL, 0, 0, wheelDelta)
}

/** Send WM_VSCROLL SB_LINEDOWN to the window under (cx, cy) */
export function scrollVScroll(cx: number, cy: number, lines: number): void {
  const hwnd = windowFromPoint(cx, cy)
  if (!hwnd) return
  // Try to find child window for better targeting
  const child = childWindowFromPointEx(hwnd, cx, cy, 1) // CWP_SKIPINVISIBLE
  const target = (child && child !== hwnd) ? child : hwnd
  for (let i = 0; i < lines; i++) {
    sendMessage(target, WM_VSCROLL, SB_LINEDOWN, 0)
  }
}

/** Send Down Arrow key press repeated `count` times */
export function scrollDownArrow(count: number): void {
  for (let i = 0; i < count; i++) {
    sendKeyPress(VK_DOWN)
  }
}

/** Send Page Down key press */
export function scrollPageDown(): void {
  sendKeyPress(VK_NEXT)
}

// Set of overlay HWNDs to exclude from window picking
const _overlayHwnds = new Set<number>()
export function registerOverlayHwnd(hwnd: number) { _overlayHwnds.add(hwnd) }
export function unregisterOverlayHwnd(hwnd: number) { _overlayHwnds.delete(hwnd) }

/** IsWindowVisible reports WS_VISIBLE — it does NOT catch cloaked windows
 *  (UWP apps when minimised, apps on a different virtual desktop, suspended
 *  apps, off-screen browser-tab clones) or iconic (minimised) windows. The
 *  Z-order walk in getWindowAtPointPhysical would otherwise hand back a cloaked
 *  window's rect when the cursor happens to fall over its stale screen
 *  position, picking a window the user can't actually see. */
function isWindowReallyVisible(hwnd: any): boolean {
  if (!_IsWindowVisible(hwnd)) return false
  if (_IsIconic && _IsIconic(hwnd)) return false
  if (_DwmGetWindowAttributeDword) {
    const DWMWA_CLOAKED = 14
    const out = [0]
    try {
      const hr = _DwmGetWindowAttributeDword(hwnd, DWMWA_CLOAKED, out, 4)
      if (hr === 0 && out[0] !== 0) return false
    } catch { /* DWM unavailable — fall through */ }
  }
  return true
}

/** Find the topmost non-overlay visible window containing the given point (in
 *  virtual-screen physical pixels), then return its visible-frame rect in the
 *  same physical coord space. Caller is responsible for converting physical →
 *  Electron-DIP via screen.screenToDipRect. */
export function getWindowAtPointPhysical(
  px: number,
  py: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!ensureLoaded()) return null

  // Force per-monitor-v2 for this call so GWR + DWM both operate in the same
  // (physical) coord space regardless of how the calling thread was configured.
  const prevCtx = _SetThreadDpiAwarenessContext
    ? (() => { try { return _SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_V2) } catch { return null } })()
    : null

  try {
    const GW_HWNDNEXT = 2
    const WS_EX_TOOLWINDOW = 0x80
    let hwnd = _WindowFromPoint({ x: Math.round(px), y: Math.round(py) })
    if (!hwnd) return null
    hwnd = _GetAncestor(hwnd, 2) // GA_ROOT

    let candidate = hwnd
    let attempts = 0
    while (candidate && attempts < 200) {
      attempts++
      if (!_overlayHwnds.has(candidate) && isWindowReallyVisible(candidate)) {
        const exStyle = _GetWindowLongW(candidate, -20)
        if (!(exStyle & WS_EX_TOOLWINDOW)) {
          const r = { left: 0, top: 0, right: 0, bottom: 0 }
          if (_GetWindowRect(candidate, r)) {
            if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) {
              // Prefer DWM visible frame (no ~8px invisible resize border).
              const DWMWA_EXTENDED_FRAME_BOUNDS = 9
              const fr = { left: 0, top: 0, right: 0, bottom: 0 }
              try {
                const hr = _DwmGetWindowAttribute(candidate, DWMWA_EXTENDED_FRAME_BOUNDS, fr, 16)
                if (hr === 0 && fr.right > fr.left && fr.bottom > fr.top) {
                  return { x: fr.left, y: fr.top, width: fr.right - fr.left, height: fr.bottom - fr.top }
                }
              } catch { /* fall through to GetWindowRect */ }
              return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
            }
          }
        }
      }
      candidate = _GetWindow(candidate, GW_HWNDNEXT)
    }
    return null
  } catch (err: any) {
    return null
  } finally {
    if (prevCtx && _SetThreadDpiAwarenessContext) {
      try { _SetThreadDpiAwarenessContext(prevCtx) } catch { /* ignore */ }
    }
  }
}

/** DWM visible-frame rect (falls back to GetWindowRect) in virtual-screen
 *  physical pixels. Same preference order as getWindowAtPointPhysical. */
function getWindowFrameRectPhysical(hwnd: any): { x: number; y: number; width: number; height: number } | null {
  const DWMWA_EXTENDED_FRAME_BOUNDS = 9
  const fr = { left: 0, top: 0, right: 0, bottom: 0 }
  try {
    const hr = _DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, fr, 16)
    if (hr === 0 && fr.right > fr.left && fr.bottom > fr.top) {
      return { x: fr.left, y: fr.top, width: fr.right - fr.left, height: fr.bottom - fr.top }
    }
  } catch { /* fall through to GetWindowRect */ }
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!_GetWindowRect(hwnd, r)) return null
  if (r.right <= r.left || r.bottom <= r.top) return null
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
}

// Shell housekeeping windows that pass the visible/title/toolwindow filters but
// aren't pickable app windows: the desktop (Progman reports title "Program
// Manager"), wallpaper hosts, and the taskbars.
const SHELL_CLASS_DENYLIST = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])

function isPickableAppWindow(hwnd: any, clsBuf: Uint16Array): boolean {
  if (_overlayHwnds.has(hwnd)) return false
  if (!isWindowReallyVisible(hwnd)) return false
  const WS_EX_TOOLWINDOW = 0x80
  const WS_EX_LAYERED = 0x80000
  const exStyle = _GetWindowLongW(hwnd, -20)
  if (exStyle & WS_EX_TOOLWINDOW) return false
  // Fully transparent layered windows (SetLayeredWindowAttributes alpha 0 —
  // e.g. another Electron app's parked setOpacity(0) windows) are on screen
  // per WS_VISIBLE but show nothing — the macOS helper's kCGWindowAlpha
  // filter equivalent.
  if (exStyle & WS_EX_LAYERED) {
    const key = [0], alpha = [0], flags = [0]
    if (_GetLayeredWindowAttributes(hwnd, key, alpha, flags)) {
      const LWA_ALPHA = 2
      if ((flags[0] & LWA_ALPHA) && alpha[0] === 0) return false
    }
  }
  // Own process (main window, editor, recorder chrome) never counts — the
  // picker exists to grab OTHER apps' windows.
  const pidOut = [0]
  _GetWindowThreadProcessId(hwnd, pidOut)
  if (pidOut[0] === process.pid) return false
  // Untitled top-levels are shell plumbing / hidden hosts, not user windows.
  if (_GetWindowTextLengthW(hwnd) <= 0) return false
  const n = _GetClassNameW(hwnd, clsBuf, clsBuf.length)
  const cls = String.fromCharCode(...clsBuf.subarray(0, Math.max(0, n)))
  if (SHELL_CLASS_DENYLIST.has(cls)) return false
  return true
}

/** The user-facing "active" window: root ancestor of GetForegroundWindow.
 *  Returns the raw HWND with no eligibility filtering — callers match it
 *  against listTopLevelWindowsPhysical() to validate. */
export function getForegroundWindowHwnd(): any {
  if (!ensureLoaded()) return 0
  try {
    const hwnd = _GetForegroundWindow()
    if (!hwnd) return 0
    return _GetAncestor(hwnd, 2) // GA_ROOT
  } catch {
    return 0
  }
}

/** Enumerate visible top-level app windows in z-order (front-to-back), with
 *  the same eligibility rules the point-picker applies (visible, not cloaked,
 *  not a tool window, not one of ours) plus a titled-app-window requirement so
 *  shell plumbing doesn't count. Rects are DWM visible frames in virtual-screen
 *  physical pixels — same space as getWindowAtPointPhysical. */
export function listTopLevelWindowsPhysical(): Array<{ hwnd: any; x: number; y: number; width: number; height: number }> {
  if (!ensureLoaded()) return []
  const prevCtx = _SetThreadDpiAwarenessContext
    ? (() => { try { return _SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_V2) } catch { return null } })()
    : null
  try {
    const GW_HWNDNEXT = 2
    const clsBuf = new Uint16Array(256)
    const results: Array<{ hwnd: any; x: number; y: number; width: number; height: number }> = []
    let hwnd = _GetTopWindow(0)
    let attempts = 0
    while (hwnd && attempts < 2000) {
      attempts++
      if (isPickableAppWindow(hwnd, clsBuf)) {
        const rect = getWindowFrameRectPhysical(hwnd)
        // Skip degenerate slivers (offscreen helpers / 1px windows) — same
        // threshold as the macOS helper.
        if (rect && rect.width >= 8 && rect.height >= 8) {
          results.push({ hwnd, ...rect })
        }
      }
      hwnd = _GetWindow(hwnd, GW_HWNDNEXT)
    }
    return results
  } catch {
    return []
  } finally {
    if (prevCtx && _SetThreadDpiAwarenessContext) {
      try { _SetThreadDpiAwarenessContext(prevCtx) } catch { /* ignore */ }
    }
  }
}

/** Bring the first visible top-level window whose title starts with (or
 *  contains) `titlePrefix` to the foreground, restoring it if minimized.
 *
 *  Used by the extension scroll capture: the browser's own
 *  `chrome.windows.update({focused:true})` is denied foreground by Windows
 *  when another app (Lumia) holds it — but Lumia, AS the foreground process,
 *  is always allowed to hand foreground to another window. The prefix comes
 *  from the tab title the extension reports; browser window titles are
 *  "<tab title> - Google Chrome" etc., so startsWith matches. */
export function focusWindowByTitlePrefix(titlePrefix: string): boolean {
  if (!ensureLoaded()) return false
  // Clamp long titles (GetWindowTextW output is capped by our 512-char buffer)
  // and reject too-short needles ("X", "•") that would false-positive across
  // unrelated apps.
  const needle = titlePrefix.trim().slice(0, 200)
  if (needle.length < 5) return false
  try {
    const GW_HWNDNEXT = 2
    const SW_RESTORE = 9
    const textBuf = new Uint16Array(512)
    let hwnd = _GetTopWindow(0)
    let attempts = 0
    while (hwnd && attempts < 2000) {
      attempts++
      if (_IsWindowVisible(hwnd) && _GetWindowTextLengthW(hwnd) > 0) {
        const pidOut = [0]
        _GetWindowThreadProcessId(hwnd, pidOut)
        if (pidOut[0] !== process.pid) {
          const n = _GetWindowTextW(hwnd, textBuf, textBuf.length)
          const text = String.fromCharCode(...textBuf.subarray(0, Math.max(0, n)))
          if (text.startsWith(needle) || text.includes(needle)) {
            if (_IsIconic(hwnd)) _ShowWindow(hwnd, SW_RESTORE)
            return _SetForegroundWindow(hwnd)
          }
        }
      }
      hwnd = _GetWindow(hwnd, GW_HWNDNEXT)
    }
  } catch { /* fall through */ }
  return false
}

/** Scroll to top: Ctrl+Home key + WM_VSCROLL SB_TOP to window under cursor */
export function scrollToTopNative(cx: number, cy: number): void {
  // Send Ctrl+Home
  keybdEvent(VK_CONTROL, 0, 0)
  keybdEvent(VK_HOME, 0, 0)
  keybdEvent(VK_HOME, 0, KEYEVENTF_KEYUP)
  keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP)
  // Also send WM_VSCROLL SB_TOP to the window under cursor
  const hwnd = windowFromPoint(cx, cy)
  if (hwnd) {
    sendMessage(hwnd, WM_VSCROLL, SB_TOP, 0)
  }
}

/** Force-disable DWM's show/hide transition animations on a specific HWND.
 *  Without this, ShowWindow plays the system "window open/close" fade-in/out
 *  (~150-200ms alpha ramp). Two places that hurts us:
 *    - overlay: even after we've gated win.show() on a renderer paint ack,
 *      the OS-level alpha ramp adds its own fade flicker on top.
 *    - main: when capture hides main before freezeAllDisplays, the fade
 *      keeps main on the compositor for ~200ms, so the frozen snapshot
 *      bakes a translucent Lumia frame (theme accents) on top of the
 *      real screen pixels.
 *  Setting DWMWA_TRANSITIONS_FORCEDISABLED opts the HWND out of both. */
export function disableDwmTransitions(win: { isDestroyed(): boolean; getNativeWindowHandle(): Buffer }) {
  if (process.platform !== 'win32') return
  if (!ensureLoaded()) return
  if (win.isDestroyed()) return
  if (!_DwmSetWindowAttribute) return
  try {
    const DWMWA_TRANSITIONS_FORCEDISABLED = 3
    const buf = win.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0))
    _DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, [1], 4)
  } catch (err) {
    console.warn('[native-input] DwmSetWindowAttribute(TRANSITIONS_FORCEDISABLED) failed', err)
  }
}

/** Direct Win32 SetWindowDisplayAffinity(HWND, WDA_EXCLUDEFROMCAPTURE).
 *  Bypasses Electron's setContentProtection wrapper, which has known
 *  reliability issues applying display affinity to layered (transparent +
 *  frame:false) windows on Windows — WGC capture sessions keep showing the
 *  window even after setContentProtection(true) returns. Calling the Win32
 *  API directly on the realised HWND forces the OS-level exclusion.
 *  Requires Windows 10 build 19041 (2004) or newer for WDA_EXCLUDEFROMCAPTURE. */
export function forceWindowsExcludeFromCapture(win: { isDestroyed(): boolean; getNativeWindowHandle(): Buffer }) {
  if (process.platform !== 'win32') return
  if (!ensureLoaded()) return
  if (win.isDestroyed()) return
  try {
    const WDA_EXCLUDEFROMCAPTURE = 0x11
    const buf = win.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0))
    _SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
  } catch (err) {
    console.warn('[native-input] SetWindowDisplayAffinity failed', err)
  }
}
