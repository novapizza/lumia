/**
 * Fast native screen capture.
 *
 * Windows: GDI32 BitBlt via koffi — ~5–20 ms per display vs ~50–150 ms for
 * desktopCapturer.getSources() (no WGC session setup per-call).
 *
 * macOS: delegated to the screen-snap Swift helper (ScreenCaptureKit's
 * SCScreenshotManager, macOS 14+ — see mac-screen-snap.ts). Electron's own
 * desktopCapturer also runs on ScreenCaptureKit but re-enumerates shareable
 * content per call, costing 1–3 s at full resolution on macOS 14/15; the
 * helper keeps that enumeration warm. The legacy CGDisplayCreateImage
 * fast-grab was obsoleted (not just deprecated) in the macOS 15 SDK, so SCK
 * is the only native route left. macOS ≤ 13 falls back to desktopCapturer.
 *
 * Returns null on any failure so callers fall back to desktopCapturer.
 */
import { nativeImage, screen } from 'electron'
import { captureDisplayMacSnap, prewarmMacScreenSnap } from './mac-screen-snap'

// ── Win32 constants ──────────────────────────────────────────────────────────
const SRCCOPY    = 0x00CC0020
const CAPTUREBLT = 0x40000000  // include layered/transparent windows
const BI_RGB         = 0
const DIB_RGB_COLORS = 0

// ── koffi bindings (lazy-loaded) ─────────────────────────────────────────────
let _loaded = false
let _GetDC: any, _ReleaseDC: any
let _CreateCompatibleDC: any, _CreateCompatibleBitmap: any
let _SelectObject: any, _BitBlt: any, _GetDIBits: any
let _DeleteObject: any, _DeleteDC: any
let _BITMAPINFOHEADER: any

function ensureLoaded(): boolean {
  if (_loaded) return true
  if (process.platform !== 'win32') return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')

    _BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
      biSize:          'uint32',
      biWidth:         'int32',
      biHeight:        'int32',   // negative = top-down row order
      biPlanes:        'uint16',
      biBitCount:      'uint16',
      biCompression:   'uint32',
      biSizeImage:     'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed:       'uint32',
      biClrImportant:  'uint32',
    })

    const user32 = koffi.load('user32.dll')
    const gdi32  = koffi.load('gdi32.dll')

    _GetDC              = user32.func('intptr_t __stdcall GetDC(intptr_t hWnd)')
    _ReleaseDC          = user32.func('int __stdcall ReleaseDC(intptr_t hWnd, intptr_t hDC)')
    _CreateCompatibleDC = gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)')
    _CreateCompatibleBitmap = gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int nWidth, int nHeight)')
    _SelectObject       = gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t h)')
    _BitBlt             = gdi32.func('bool __stdcall BitBlt(intptr_t hdcDest, int x, int y, int nWidth, int nHeight, intptr_t hdcSrc, int xSrc, int ySrc, uint32_t dwRop)')
    // lpvBits is a plain void* output — koffi passes the Buffer data pointer directly.
    // lpbmi is _In_ only: we set all fields before the call and don't need them back.
    _GetDIBits          = gdi32.func('int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint uStartScan, uint cLines, void *lpvBits, _In_ BITMAPINFOHEADER *lpbmi, uint uUsage)')
    _DeleteObject       = gdi32.func('bool __stdcall DeleteObject(intptr_t ho)')
    _DeleteDC           = gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)')

    _loaded = true
    return true
  } catch (err) {
    console.error('[native-screen] GDI load failed:', err)
    return false
  }
}

/** A native capture result: the NativeImage plus the raw BGRA it was built
 *  from. Callers that need the raw pixels again (the frozen-snapshot cache
 *  hands them to the overlay as its background) reuse `raw` instead of paying
 *  NativeImage.toBitmap() — another full-frame copy (~59 MB on 5K Retina) on
 *  the hotkey→overlay hot path. */
export interface NativeCapture {
  image: Electron.NativeImage
  raw: { buffer: Buffer; width: number; height: number }
}

/**
 * Capture a physical-pixel rect from the virtual desktop using GDI BitBlt.
 * Returns the capture (BGRA, fully opaque) or null if GDI is unavailable.
 *
 * Coordinates must be in virtual-screen physical pixels — i.e. the same space
 * that screen.dipToScreenPoint() returns on Windows.
 */
export function captureRectGdi(
  physX: number, physY: number, physW: number, physH: number
): NativeCapture | null {
  if (!ensureLoaded()) return null

  const w = Math.max(1, Math.round(physW))
  const h = Math.max(1, Math.round(physH))
  const x = Math.round(physX)
  const y = Math.round(physY)

  // GetDC(0) == GetDC(NULL) → DC for the full virtual screen (all monitors).
  // Under per-monitor DPI awareness (which Electron sets), this DC uses
  // physical pixel coordinates, matching screen.dipToScreenPoint() output.
  const hdcScreen = _GetDC(0)
  if (!hdcScreen) return null

  let hdcMem = 0, hbmp = 0, hOld = 0
  try {
    hdcMem = _CreateCompatibleDC(hdcScreen)
    if (!hdcMem) return null
    hbmp   = _CreateCompatibleBitmap(hdcScreen, w, h)
    if (!hbmp) return null
    hOld   = _SelectObject(hdcMem, hbmp)

    // Copy pixels from virtual screen into the compatible bitmap.
    // CAPTUREBLT ensures layered/transparent windows are included.
    // On failure GetDIBits would read an uninitialized/garbage bitmap, so bail
    // out and let the caller fall back to desktopCapturer.
    if (!_BitBlt(hdcMem, 0, 0, w, h, hdcScreen, x, y, SRCCOPY | CAPTUREBLT)) return null

    // GetDIBits requires the bitmap NOT be selected into any DC, so deselect it
    // here (restoring the DC's default bitmap) rather than waiting for finally.
    _SelectObject(hdcMem, hOld)
    hOld = 0

    // Zero-fill (not allocUnsafe): if GetDIBits underfills the buffer we return
    // black rather than leaking uninitialized heap memory into the screenshot.
    const pixels = Buffer.alloc(w * h * 4)
    // GetDIBits returns the number of scan lines copied, or 0 on failure.
    const scanLines = _GetDIBits(hdcScreen, hbmp, 0, h, pixels, {
      biSize:          40,  // sizeof(BITMAPINFOHEADER)
      biWidth:         w,
      biHeight:        -h,  // negative → top-down row order
      biPlanes:        1,
      biBitCount:      32,
      biCompression:   BI_RGB,
      biSizeImage:     0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed:       0,
      biClrImportant:  0,
    }, DIB_RGB_COLORS)
    if (!scanLines) return null

    // GDI leaves the alpha byte (byte 3 of each BGRA pixel) as 0, which
    // NativeImage treats as fully transparent. Set it to 0xFF (opaque) via a
    // single Uint32 OR pass: on little-endian, pixel = 0x00RRGGBB in uint32,
    // so OR 0xFF000000 sets the alpha byte without touching RGB channels.
    const u32 = new Uint32Array(pixels.buffer, pixels.byteOffset, w * h)
    for (let i = 0; i < u32.length; i++) u32[i] |= 0xFF000000

    // createFromBitmap (NOT createFromBuffer) — the latter decodes PNG/JPEG.
    // createFromBitmap takes raw BGRA, which is exactly what GetDIBits produced.
    const image = nativeImage.createFromBitmap(pixels, { width: w, height: h })
    return { image, raw: { buffer: pixels, width: w, height: h } }
  } finally {
    if (hOld)   _SelectObject(hdcMem, hOld)
    if (hbmp)   _DeleteObject(hbmp)
    if (hdcMem) _DeleteDC(hdcMem)
    _ReleaseDC(0, hdcScreen)
  }
}

/**
 * Capture a full Electron Display using GDI.
 * Returns null if GDI is unavailable (non-Windows or load failure).
 */
export function captureDisplayGdi(display: Electron.Display): NativeCapture | null {
  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
  const sf = display.scaleFactor || 1
  const physW = Math.round(display.size.width  * sf)
  const physH = Math.round(display.size.height * sf)
  return captureRectGdi(origin.x, origin.y, physW, physH)
}

// ── Unified entry point ───────────────────────────────────────────────────────

/**
 * Fast display capture. Windows uses synchronous GDI; macOS goes through the
 * warm ScreenCaptureKit helper; anything else (or any failure) returns null
 * so the caller falls back to desktopCapturer.
 *
 * `includeSelf` — the capture must contain Lumia's own windows ("Capture
 * Lumia window too"). GDI BitBlts the real screen, so Windows already
 * complies; the macOS helper excludes our PID at the compositor level and
 * can't be asked not to (the filter is baked at spawn), so we return null
 * there and let the caller's desktopCapturer fallback — which captures the
 * true screen contents — pick it up. Slower on macOS, but correct.
 */
export async function captureDisplayNative(
  display: Electron.Display,
  opts?: { includeSelf?: boolean }
): Promise<NativeCapture | null> {
  if (process.platform === 'win32') return captureDisplayGdi(display)
  if (process.platform === 'darwin') {
    if (opts?.includeSelf) return null
    return captureDisplayMacSnap(display)
  }
  return null
}

/**
 * One-shot warm-up of the native capture path, fired from app.whenReady() so
 * the cost never lands on the user's first hotkey capture.
 *
 * Windows: the first call does koffi.load + user32/gdi32 binding (~tens of
 * ms) inside ensureLoaded() — a 1×1 BitBlt forces the bindings without
 * grabbing a full display.
 *
 * macOS: spawns the screen-snap helper and pre-fetches its SCShareableContent
 * cache (~200–500 ms), the slow part of a cold ScreenCaptureKit capture.
 */
export function prewarmNativeCapture(): void {
  if (process.platform === 'win32') {
    try { captureRectGdi(0, 0, 1, 1) } catch { /* silent — best-effort */ }
    return
  }
  if (process.platform === 'darwin') prewarmMacScreenSnap()
}
