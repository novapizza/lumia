import { app, screen } from 'electron'
import { execFile } from 'child_process'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { profileIsNearSrgb } from './icc-to-srgb'

/**
 * Fetch the ICC profile bytes attached to a display by ID. Used to tag PNG
 * captures with an `iCCP` chunk so color-managed viewers (browsers, Slack,
 * Discord desktop, macOS Preview, Windows Photos) render wide-gamut content
 * faithfully instead of falling back to sRGB and looking desaturated.
 *
 * Cached per displayId; cache is wiped when the OS reports a display
 * configuration change (`display-metrics-changed`, `display-added`,
 * `display-removed`). Returns null when the OS provides no profile — the
 * caller leaves the PNG untagged in that case (preferred over lying about
 * the color space).
 */

const cache = new Map<number, Buffer | null>()
let displayListenersInstalled = false

function ensureDisplayListeners() {
  if (displayListenersInstalled) return
  displayListenersInstalled = true
  const wipe = () => cache.clear()
  screen.on('display-metrics-changed', wipe)
  screen.on('display-added', wipe)
  screen.on('display-removed', wipe)
}

export async function getDisplayIcc(displayId: number): Promise<Buffer | null> {
  ensureDisplayListeners()
  if (cache.has(displayId)) return cache.get(displayId) ?? null

  let result: Buffer | null = null
  try {
    if (process.platform === 'darwin') result = await fetchMac(displayId)
    else if (process.platform === 'win32') result = await fetchWin(displayId)
  } catch (err) {
    console.error('[display-icc] fetch failed', err)
  }
  cache.set(displayId, result)
  return result
}

/** Like getDisplayIcc, but null also when the profile is effectively sRGB —
 *  i.e. non-null only when pixels captured from this display actually need
 *  converting (or iCCP-tagging) to read correctly as sRGB. Capture paths use
 *  this to skip the per-pixel conversion pass on the overwhelmingly common
 *  case of displays carrying the stock sRGB profile (or none at all). */
export async function getDisplayConversionIcc(displayId: number): Promise<Buffer | null> {
  const icc = await getDisplayIcc(displayId)
  if (!icc) return null
  return profileIsNearSrgb(icc) ? null : icc
}

// ── macOS ───────────────────────────────────────────────────────────────────

function getIccHelperPath(): string | null {
  // Mirror the resolution pattern used by ocr.ts so dev / built / packaged
  // layouts all find the binary. Compiled by build/compile-mac-helpers.sh.
  const dev    = resolve(__dirname, '..', 'electron', 'helpers', 'get-display-icc')
  if (existsSync(dev)) return dev
  const prod   = join(process.resourcesPath ?? app.getAppPath(), 'get-display-icc')
  if (existsSync(prod)) return prod
  const built  = resolve(__dirname, '..', '..', 'electron', 'helpers', 'get-display-icc')
  if (existsSync(built)) return built
  return null
}

async function fetchMac(displayId: number): Promise<Buffer | null> {
  const binary = getIccHelperPath()
  if (!binary) return null

  // Swift helper writes raw ICC bytes to a temp file (binary stdout through
  // execFile would need careful encoding handling). We delete after read.
  const outPath = join(tmpdir(), `lumia-icc-${randomUUID()}.icc`)
  try {
    await new Promise<void>((resolveP, rejectP) => {
      execFile(binary, [String(displayId), outPath], { timeout: 5000 }, (err) => {
        // Exit codes 2 (no display) and 3 (no profile) are expected; return
        // null from the caller. Anything else surfaces as a generic failure.
        if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          const code = (err as { code?: number | string }).code
          if (code === 2 || code === 3) { resolveP(); return }
        }
        if (err) rejectP(err)
        else resolveP()
      })
    })
    if (!existsSync(outPath)) return null
    return await readFile(outPath)
  } finally {
    try { await unlink(outPath) } catch { /* ignore */ }
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────

let _winLoaded = false
let _EnumDisplayDevicesW: (lpDevice: string | null, i: number, dev: any, flags: number) => boolean
let _EnumDisplaySettingsW: (name: string, mode: number, dm: any) => boolean
let _CreateDCW: (driver: string | null, device: string, port: any, init: any) => any
let _DeleteDC: (hdc: any) => boolean
let _GetICMProfileW: (hdc: any, sizeOut: any, pathOut: any) => boolean

let DISPLAY_DEVICEW: any
let DEVMODEW: any

const ENUM_CURRENT_SETTINGS = 0xffffffff  // -1 as DWORD
const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001

function ensureWinLoaded(): boolean {
  if (_winLoaded) return true
  if (process.platform !== 'win32') return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')

    // DISPLAY_DEVICEW: 5×32-bit, 4×128-wchar fixed arrays. Fixed sizes are
    // mandated by the API contract — the caller-supplied cb must equal
    // sizeof(DISPLAY_DEVICEW) or Windows fails the call.
    DISPLAY_DEVICEW = koffi.struct('DISPLAY_DEVICEW', {
      cb: 'uint32',
      DeviceName:   koffi.array('uint16', 32),
      DeviceString: koffi.array('uint16', 128),
      StateFlags: 'uint32',
      DeviceID:     koffi.array('uint16', 128),
      DeviceKey:    koffi.array('uint16', 128),
    })

    // DEVMODEW is large and partly version-dependent. We only consume
    // dmPosition (in the union with dmOrientation/dmPaperSize/etc) and
    // dmPelsWidth/dmPelsHeight, but the struct must still be the OS-expected
    // size or EnumDisplaySettingsW fails. Define the full Windows 10+ layout.
    DEVMODEW = koffi.struct('DEVMODEW', {
      dmDeviceName: koffi.array('uint16', 32),
      dmSpecVersion: 'uint16',
      dmDriverVersion: 'uint16',
      dmSize: 'uint16',
      dmDriverExtra: 'uint16',
      dmFields: 'uint32',
      // Union: { dmOrientation, dmPaperSize, dmPaperLength, dmPaperWidth,
      //         dmScale, dmCopies, dmDefaultSource, dmPrintQuality } OR
      //        { dmPosition (POINTL), dmDisplayOrientation, dmDisplayFixedOutput }
      // For display modes the second variant applies. POINTL is two int32.
      dmPositionX: 'int32',
      dmPositionY: 'int32',
      dmDisplayOrientation: 'uint32',
      dmDisplayFixedOutput: 'uint32',
      dmColor: 'int16',
      dmDuplex: 'int16',
      dmYResolution: 'int16',
      dmTTOption: 'int16',
      dmCollate: 'int16',
      dmFormName: koffi.array('uint16', 32),
      dmLogPixels: 'uint16',
      dmBitsPerPel: 'uint32',
      dmPelsWidth: 'uint32',
      dmPelsHeight: 'uint32',
      dmDisplayFlags: 'uint32',
      dmDisplayFrequency: 'uint32',
      dmICMMethod: 'uint32',
      dmICMIntent: 'uint32',
      dmMediaType: 'uint32',
      dmDitherType: 'uint32',
      dmReserved1: 'uint32',
      dmReserved2: 'uint32',
      dmPanningWidth: 'uint32',
      dmPanningHeight: 'uint32',
    })

    const user32 = koffi.load('user32.dll')
    const gdi32  = koffi.load('gdi32.dll')

    _EnumDisplayDevicesW  = user32.func('bool __stdcall EnumDisplayDevicesW(str16 lpDevice, uint32 iDevNum, _Inout_ DISPLAY_DEVICEW *lpDisplayDevice, uint32 dwFlags)')
    _EnumDisplaySettingsW = user32.func('bool __stdcall EnumDisplaySettingsW(str16 lpszDeviceName, uint32 iModeNum, _Inout_ DEVMODEW *lpDevMode)')
    _CreateDCW            = gdi32.func('intptr_t __stdcall CreateDCW(str16 pwszDriver, str16 pwszDevice, intptr_t pszPort, intptr_t pdm)')
    _DeleteDC             = gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)')
    _GetICMProfileW       = gdi32.func('bool __stdcall GetICMProfileW(intptr_t hdc, _Inout_ uint32 *pBufSize, _Out_ uint16 *pszFilename)')

    _winLoaded = true
    return true
  } catch (err) {
    console.error('[display-icc win] koffi bindings failed', err)
    return false
  }
}

function decodeWStringFromArray(arr: number[] | Uint16Array, max: number): string {
  // Stop at first NUL — DISPLAY_DEVICEW/DEVMODEW fields are NUL-padded.
  const codes: number[] = []
  for (let i = 0; i < Math.min(arr.length, max); i++) {
    const c = arr[i]
    if (c === 0) break
    codes.push(c)
  }
  return String.fromCharCode(...codes)
}

interface WinMonitor {
  deviceName: string  // "\\.\DISPLAY1"
  x: number; y: number; width: number; height: number  // screen-coord pixels
}

function enumerateWinMonitors(): WinMonitor[] {
  const out: WinMonitor[] = []
  for (let i = 0; i < 64; i++) {
    const adapter: any = { cb: 0, DeviceName: new Array(32).fill(0), DeviceString: new Array(128).fill(0), StateFlags: 0, DeviceID: new Array(128).fill(0), DeviceKey: new Array(128).fill(0) }
    // koffi needs cb set to struct size in bytes. DISPLAY_DEVICEW is 4 + 32*2 + 128*2 + 4 + 128*2 + 128*2 = 840.
    adapter.cb = 840
    if (!_EnumDisplayDevicesW(null, i, adapter, 0)) break
    if (!(adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue

    const deviceName = decodeWStringFromArray(adapter.DeviceName, 32)
    if (!deviceName) continue

    const dm: any = {
      dmDeviceName: new Array(32).fill(0),
      dmSpecVersion: 0, dmDriverVersion: 0, dmSize: 220, dmDriverExtra: 0, dmFields: 0,
      dmPositionX: 0, dmPositionY: 0, dmDisplayOrientation: 0, dmDisplayFixedOutput: 0,
      dmColor: 0, dmDuplex: 0, dmYResolution: 0, dmTTOption: 0, dmCollate: 0,
      dmFormName: new Array(32).fill(0),
      dmLogPixels: 0, dmBitsPerPel: 0, dmPelsWidth: 0, dmPelsHeight: 0,
      dmDisplayFlags: 0, dmDisplayFrequency: 0, dmICMMethod: 0, dmICMIntent: 0,
      dmMediaType: 0, dmDitherType: 0, dmReserved1: 0, dmReserved2: 0,
      dmPanningWidth: 0, dmPanningHeight: 0,
    }
    if (!_EnumDisplaySettingsW(deviceName, ENUM_CURRENT_SETTINGS, dm)) continue

    out.push({
      deviceName,
      x: dm.dmPositionX,
      y: dm.dmPositionY,
      width: dm.dmPelsWidth,
      height: dm.dmPelsHeight,
    })
  }
  return out
}

function getIcmFileForDevice(deviceName: string): string | null {
  // CreateDCW's last two args are nullable pointers (LPCWSTR / const DEVMODEW*).
  // koffi rejects JS `null` for `intptr_t` — opaque-handle params must be 0.
  // First arg (driver) is `str16`; null is valid there because str16 in koffi
  // is a nullable wide-string pointer.
  const hdc = _CreateDCW(null, deviceName, 0, 0)
  if (!hdc) return null
  try {
    // Path buffer: 260 wchars (MAX_PATH) is the documented cap.
    const sizeBuf = [260]
    const pathBuf = new Uint16Array(260)
    const ok = _GetICMProfileW(hdc, sizeBuf, pathBuf)
    if (!ok) return null
    return decodeWStringFromArray(pathBuf, 260)
  } finally {
    _DeleteDC(hdc)
  }
}

async function fetchWin(displayId: number): Promise<Buffer | null> {
  if (!ensureWinLoaded()) return null

  const display = screen.getAllDisplays().find(d => d.id === displayId)
  if (!display) return null

  // Electron's display.bounds is in DIP; Windows enumeration returns screen
  // pixels. Convert once. dipToScreenRect's signature accepts a nullable
  // window — pass null to mean "use no specific window context".
  const phys = screen.dipToScreenRect(null as never, display.bounds)
  const monitors = enumerateWinMonitors()
  if (monitors.length === 0) return null

  // Best match by overlap area against the display's screen-coord rect.
  // Equality would fail under sub-pixel DIP rounding on fractional scales
  // (e.g. 1.5×) — overlap handles those cleanly.
  let best: WinMonitor | null = null
  let bestArea = -1
  for (const m of monitors) {
    const ox = Math.max(0, Math.min(phys.x + phys.width, m.x + m.width) - Math.max(phys.x, m.x))
    const oy = Math.max(0, Math.min(phys.y + phys.height, m.y + m.height) - Math.max(phys.y, m.y))
    const area = ox * oy
    if (area > bestArea) { bestArea = area; best = m }
  }
  if (!best || bestArea <= 0) return null

  const iccPath = getIcmFileForDevice(best.deviceName)
  if (!iccPath) return null

  try {
    return await readFile(iccPath)
  } catch {
    return null
  }
}
