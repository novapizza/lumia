import { dockTrace } from './dock-trace'
import { desktopCapturer, ipcMain, screen, nativeImage, clipboard, app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import { captureFolder } from './capture-folder'
import { getMainWindow, createOverlayWindows, closeAllOverlays, getHistoryStore, getOverlayDisplayId, broadcastToOverlays, restoreFromOverlayCancel, prepareMainOnRoute, openHistoryItemInEditor, claimEditorAfterCapture, sendFrozenToOverlays, setOpenOverlaysOpacity, overlaySessionOpen } from './index'
import { getWindowAtPointPhysical, focusOwnWindowForeground, waitForDwmFrames } from './native-input'
import { getMacWindowAtPoint } from './mac-window-pick'
import { resolveWin32PickRect, resolveMacPickRect, getSinglePickTarget, getActivePickTarget, PickTarget } from './window-list'
import { setOverlayMode, resetOverlayMode, getOverlayMode, launchScrollCapture } from './scroll-capture'
import { localTimestamp } from './utils'
import { writeThumbnail } from './thumbnail'
import { showNotification } from './notify'
import { applyWatermarkToImage } from './watermark'
import { getSettings } from './settings'
import { startVideoCapture, beginWindowRecording, prepareVideoPick } from './video'
import { getDisplayIcc, getDisplayConversionIcc } from './display-icc'
import { convertBgraToSrgbInPlace } from './icc-to-srgb'
import { tagPngWithIcc } from './png-icc'
import { captureDisplayNative, type NativeCapture } from './native-screen'
import { macSnapAvailable, captureMacWindow } from './mac-screen-snap'
import { traceBegin, traceMark } from './capture-trace'
import { pickCornerRadiusPhys, maskCornersInPlace } from './rounded-corners'
import { resolveCaptureSource, globalRect, type SourceArea } from './capture-source'
import type { ClipCaptureMode } from './types'

/** Write the just-captured image to disk at {captureFolder()}/capture-{ts}.{ext}.
 *  Best-effort — returns null if anything goes wrong so capture still completes.
 *
 *  `displayId` is the LUT-profile fallback: capture pixels are normally
 *  converted to sRGB at the source (see toSrgbFrame) and arrive here with no
 *  displayId. When the display's profile can't be expressed as matrix-shaper
 *  math the pixels stay in display space instead, and the PNG gets an `iCCP`
 *  chunk so color-managed viewers still render them faithfully. Always a PNG:
 *  the watermark pass re-rasterizes every capture before it lands here. */
async function saveOriginalImage(png: Buffer, displayId?: number): Promise<{ filePath: string; filename: string } | null> {
  try {
    const dir = captureFolder()
    await mkdir(dir, { recursive: true })
    const ts = localTimestamp()
    const filename = `capture-${ts}.png`
    const filePath = join(dir, filename)
    // Annotate as the default Buffer<ArrayBufferLike> so reassigning the result
    // of tagPngWithIcc (also Buffer<ArrayBufferLike>) type-checks under @types/node 26.
    let buf: Buffer = png

    if (displayId != null) {
      const icc = await getDisplayIcc(displayId)
      if (icc) buf = tagPngWithIcc(buf, icc, 'Display')
    }

    await writeFile(filePath, buf)
    return { filePath, filename }
  } catch (err) {
    console.error('[capture] failed to save original image', err)
    return null
  }
}

export type CaptureMode = 'all-screen' | 'region' | 'window' | 'screen'

/** How long a hidden window takes to leave the screen before a grab (also
 *  the recordings' wait, video.ts). */
export const HIDE_DELAY_MS = process.platform === 'darwin' ? 250 : 200

// True when the last hideMainWindow() skipped the compositor-settle wait
// because the macOS native snapshot excludes Lumia's windows anyway (PID
// filter in the screen-snap helper). freezeAllDisplays() consults this if it
// unexpectedly lands on the desktopCapturer fallback — that path captures the
// real screen and CAN bake a still-fading main window into the frame.
let hideWaitSkipped = false

/** "Capture Lumia window too" — when on, captures leave the app visible so
 *  Lumia's own windows land in the frozen snapshot (or the live recording —
 *  video.ts consults the same setting), and the window picker offers them
 *  as targets. */
function includeSelfInCapture(): boolean {
  return getSettings().captureSelfWindow
}

function hideMainWindow(): Promise<void> {
  return new Promise(resolve => {
    hideWaitSkipped = false
    // Self-capture: the whole point is for Lumia to be IN the shot — skip the
    // hide (and with it the compositor-settle wait) entirely.
    if (includeSelfInCapture()) { resolve(); return }
    const win = getMainWindow()
    if (!win || win.isDestroyed()) { resolve(); return }
    // Already hidden → no compositor work needed, skip the delay so we get
    // closer to hotkey-press time when freezing (preserves transient UI like
    // tooltips/popovers that auto-dismiss on focus change).
    if (!win.isVisible()) { resolve(); return }
    win.hide()
    // macOS with the ScreenCaptureKit helper: the frozen snapshot excludes
    // all of Lumia's windows at the compositor level, so there's nothing to
    // wait for — freeze immediately. Trims ~250ms off dashboard-initiated
    // captures and moves the frozen pixels closer to hotkey-press time.
    if (process.platform === 'darwin' && macSnapAvailable()) {
      hideWaitSkipped = true
      resolve()
      return
    }
    // Windows: main has DWM transitions disabled (no fade-out), so it is off
    // the screen as soon as DWM presents the next composition. Wait for that
    // directly instead of a flat 200 ms — two flushes (~16–33 ms at 60 Hz)
    // for margin — and keep the fixed delay as the cap / fallback when
    // DwmFlush is unavailable.
    if (process.platform === 'win32') {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      setTimeout(finish, HIDE_DELAY_MS)
      void waitForDwmFrames(2).then(ok => { if (ok) finish() })
      return
    }
    setTimeout(resolve, HIDE_DELAY_MS)
  })
}

// Frozen snapshot cache, filled the moment before the overlay surfaces, then
// consumed by the confirm handlers. Lets us capture the exact pixels visible
// when the user pressed the hotkey — preserving tooltips/popovers that
// auto-dismiss as soon as the overlay (or any other window) steals focus
// from the source app.
//
// We never PNG-encode at freeze time: toDataURL() for a 4K display takes
// ~500-1000ms and would land on the critical path before overlay creation —
// so we hand the overlay raw BGRA bytes instead, and only PNG-encode when the
// user actually confirms a capture. The native capture paths already have the
// raw BGRA in hand, so it's cached alongside the NativeImage (`raw`) — the
// overlay push then skips a full-frame toBitmap() copy (~59 MB on 5K Retina).
interface FrozenFrame {
  image: Electron.NativeImage
  raw?: { buffer: Buffer; width: number; height: number }
  /** Pixels are sRGB — converted from the display's color space at freeze
   *  time, or the display had no profile / the stock sRGB one. false only
   *  for LUT-profile displays (not convertible): those pixels stay in
   *  display space and the saved PNG gets iCCP-tagged instead. */
  srgb: boolean
}
const frozenImages = new Map<number, FrozenFrame>()

/** Convert a freshly captured frame's pixels from the display's color space
 *  to sRGB, so every consumer — overlay preview, editor, clipboard, saved
 *  PNG, thumbnails, uploads — reads them the same way (the extension capture
 *  path already does this; see icc-to-srgb.ts). Chromium composites
 *  color-managed apps' output INTO the display profile's space, so on panels
 *  with a strong profile (e.g. Lenovo's AICCP laptop profiles) raw captures
 *  look tinted everywhere pixels are read as sRGB.
 *
 *  Mutates `raw.buffer` in place when provided (the NativeImage is rebuilt
 *  from it). Cost is one pass over the pixels (~15-30 ms for a FHD frame) and
 *  is skipped entirely for profile-less / sRGB-profiled displays — only
 *  displays whose profile meaningfully differs from sRGB pay, which is also
 *  exactly when the overlay preview would otherwise render visibly off. */
async function toSrgbFrame(
  image: Electron.NativeImage,
  raw: { buffer: Buffer; width: number; height: number } | undefined,
  displayId: number
): Promise<FrozenFrame> {
  try {
    const icc = await getDisplayConversionIcc(displayId)
    if (!icc) return { image, raw, srgb: true }
    const bmp = raw ?? (() => {
      const size = image.getSize()
      return { buffer: image.toBitmap(), width: size.width, height: size.height }
    })()
    if (!convertBgraToSrgbInPlace(bmp.buffer, icc)) {
      // LUT profile — leave pixels in display space; save path tags instead.
      return { image, raw, srgb: false }
    }
    return {
      image: nativeImage.createFromBitmap(bmp.buffer, { width: bmp.width, height: bmp.height }),
      raw: bmp,
      srgb: true,
    }
  } catch (err) {
    console.error('[capture] sRGB conversion failed', err)
    return { image, raw, srgb: false }
  }
}

/** Raw BGRA bitmap of the frozen snapshot for the given display, intended for
 *  the overlay window to render as background via canvas putImageData. No
 *  encode round-trip; no pixel copy at all when the frame came from a native
 *  capture path. */
export function getFrozenBgrForDisplay(displayId: number): { buffer: Buffer; width: number; height: number } | null {
  const frame = frozenImages.get(displayId)
  if (!frame) return null
  if (frame.raw) return frame.raw
  const size = frame.image.getSize()
  return { buffer: frame.image.toBitmap(), width: size.width, height: size.height }
}

export function clearFrozenCache() {
  frozenImages.clear()
}

/** Snapshot every display at full physical resolution into the frozen cache.
 *  Caller must have already hidden the main window (otherwise main bakes
 *  into the cached frame — unless captureSelfWindow is on, where baking it
 *  in is exactly the point). Runs all displays in parallel. */
async function freezeAllDisplays(): Promise<void> {
  clearFrozenCache()
  const allDisplays = screen.getAllDisplays()
  const includeSelf = includeSelfInCapture()

  // Fast path: native capture — Windows GDI BitBlt (~5–20 ms/display), macOS
  // 14+ warm ScreenCaptureKit helper (~50–200 ms/display). See native-screen.ts.
  // includeSelf routes macOS to the desktopCapturer fallback below (the
  // helper's PID filter would erase Lumia from the frame).
  const fallbackDisplays: Electron.Display[] = []
  await Promise.all(allDisplays.map(async d => {
    const nat: NativeCapture | null = await captureDisplayNative(d, { includeSelf })
    traceMark(`grab ${d.id}`)
    if (nat) {
      frozenImages.set(d.id, await toSrgbFrame(nat.image, nat.raw, d.id))
      traceMark(`srgb ${d.id}`)
    }
    else fallbackDisplays.push(d)
  }))
  if (fallbackDisplays.length === 0) return

  // The native path failed under us. If hideMainWindow() skipped its settle
  // wait on the assumption the native snapshot would exclude Lumia's windows,
  // the fallback — which captures the real screen — needs that wait after all.
  if (hideWaitSkipped) {
    hideWaitSkipped = false
    await new Promise(r => setTimeout(r, HIDE_DELAY_MS))
  }

  // Fallback: desktopCapturer (macOS ≤ 13, or native capture failure). One
  // getSources() call per unique physical size instead of one per display —
  // every getSources() call captures EVERY screen at the requested thumbnail
  // size, so per-display calls did N× redundant capture work, and on macOS
  // each call also pays a fresh ScreenCaptureKit session (up to seconds).
  const bySize = new Map<string, Electron.Display[]>()
  for (const d of fallbackDisplays) {
    const sf = d.scaleFactor || 1
    const physW = Math.max(1, Math.round(d.size.width * sf))
    const physH = Math.max(1, Math.round(d.size.height * sf))
    const key = `${physW}x${physH}`
    const group = bySize.get(key)
    if (group) group.push(d)
    else bySize.set(key, [d])
  }
  await Promise.all([...bySize.entries()].map(async ([key, group]) => {
    const [physW, physH] = key.split('x').map(Number)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physW, height: physH },
    })
    for (const d of group) {
      const src = findSourceForDisplay(sources, allDisplays, d.id)
      if (src) frozenImages.set(d.id, await toSrgbFrame(src.thumbnail, undefined, d.id))
    }
  }))
}

/** One-shot warm-up of the desktopCapturer pipeline. First call after launch
 *  initializes the underlying WGC / CGDisplayStream session and is ~300-500ms
 *  slower than steady-state. Fire from app.whenReady() so the user's first
 *  hotkey press doesn't eat that cold-start cost. */
export async function prewarmDesktopCapturer(): Promise<void> {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    })
  } catch { /* silent — best-effort */ }
}

function showMainWindow() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  // win.focus() alone can't steal the foreground when another process holds it
  // — e.g. after an extension scroll capture the browser is still foreground
  // and Lumia hid itself during the capture (so it's a background process).
  if (process.platform === 'darwin') {
    // macOS: the extension AppleScript-`activate`d the browser, so Lumia is a
    // background app — bring the whole app (not just the window) to the front.
    dockTrace('app.focus steal (capture.ts, window to front)')
    app.focus({ steal: true })
  } else {
    // Windows: AttachThreadInput + SetForegroundWindow lifts the foreground
    // lock. No-op when we already hold the foreground.
    focusOwnWindowForeground(win)
  }
}

function findSourceForDisplay(
  sources: Electron.DesktopCapturerSource[],
  allDisplays: Electron.Display[],
  displayId: number
): Electron.DesktopCapturerSource | null {
  if (sources.length === 0) return null
  if (sources.length === 1) return sources[0]
  const byId = sources.find(s => s.display_id === String(displayId))
  if (byId) return byId
  const idx = allDisplays.findIndex(d => d.id === displayId)
  if (idx >= 0 && idx < sources.length) return sources[idx]
  return sources[0]
}

// Cache last window-pick physical rect so confirm can crop in physical pixels
// directly. Avoids the DIP round-trip which introduces sub-pixel drift and,
// for maximized windows, can expose the ~8px invisible resize border that
// DWM rolls into the frame bounds.
let lastWindowPickPhysical: {
  x: number; y: number; width: number; height: number; displayId: number
} | null = null

/** macOS: the window under the pointer at the last hover lookup (its
 *  CGWindowID and the frame the overlay drew). A confirm on that same frame
 *  captures the window on its own (2026-11-24): its own pixels with
 *  transparent corners, like macOS's window screenshot, instead of a cut-out
 *  of the frozen screen that carried the desktop and overlapping windows. */
let lastMacPick: { id: number; rect: { x: number; y: number; width: number; height: number } } | null = null
const sameRect = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** After Mission Control (index.ts steps the overlays aside while it's up):
 *  in Image mode, a fresh snapshot, since windows may have been reordered.
 *  The overlays are invisible meanwhile and the helper leaves Lumia out, so
 *  no hide is needed. Returns false when a switch or the session's end
 *  superseded it. */
export async function refreezeAfterMissionControl(): Promise<boolean> {
  const gen = ++refreezeGen
  clearFrozenCache()
  sendFrozenToOverlays()
  if (getOverlayMode().startsWith('video-')) return true
  hideWaitSkipped = false
  await freezeAllDisplays()
  if (gen !== refreezeGen || !overlaySessionOpen()) {
    if (gen === refreezeGen) clearFrozenCache()
    return false
  }
  sendFrozenToOverlays()
  return true
}

/** Bumped per Image <-> Video switch; a re-freeze that finishes after a newer
 *  switch is dropped. */
let refreezeGen = 0

/** Freeze while the overlay is up (Image <-> Video switch). macOS's helper
 *  leaves Lumia's windows out of the grab; elsewhere (Windows, the macOS
 *  fallback, "include Lumia's own window") the overlays fade out for it and
 *  come back, which shows as a short flicker. */
async function refreezeUnderOverlays(): Promise<void> {
  const hide = !(process.platform === 'darwin' && macSnapAvailable()) || includeSelfInCapture()
  hideWaitSkipped = false
  if (hide) {
    setOpenOverlaysOpacity(0)
    if (process.platform === 'win32') {
      await Promise.race([waitForDwmFrames(2), new Promise(r => setTimeout(r, HIDE_DELAY_MS))])
    } else {
      await new Promise(r => setTimeout(r, HIDE_DELAY_MS))
    }
  }
  try {
    await freezeAllDisplays()
  } finally {
    if (hide && overlaySessionOpen()) setOpenOverlaysOpacity(1)
  }
}

/** A capture that failed (no screen source, a grab or an encode that threw):
 *  end the session as a cancel would and say so (2026-11-27; several paths
 *  left the main window hidden with nothing said). The window comes back by
 *  the rule for a cancelled overlay (restoreFromOverlayCancel), and the
 *  message is a toast when it does, a system notification when it doesn't. */
function failCapture(what: string, err: unknown): void {
  console.error(`[capture] ${what} failed`, err)
  resetOverlayMode()
  clearFrozenCache()
  closeAllOverlays()
  restoreFromOverlayCancel()
  showNotification({ body: `Couldn't capture image\n${err instanceof Error ? err.message : String(err)}`, kind: 'error' })
}

export function dispatchCapture(mode: CaptureMode) {
  switch (mode) {
    case 'all-screen':  return captureAllScreen()
    case 'region':      return captureRegion()
    case 'window':      return captureWindow()
    case 'screen':      return captureActiveMonitor()
  }
}

/** Re-invoke the mode the user most recently used. Branches on stored kind,
 *  then on the specific image/video mode. */
export async function dispatchLastCapture() {
  const s = getSettings()
  if (s.lastCaptureKind === 'video') {
    await startVideoCapture(s.lastVideoMode)
    return
  }
  // Scroll is replayed like the scroll hotkey (2026-11-27): the browser in
  // front through the extension, else the screen scroll overlay.
  if (s.lastImageMode === 'scrolling') {
    await launchScrollCapture()
    return
  }
  dispatchCapture(s.lastImageMode)
}

export function setupCapture() {
  ipcMain.handle('capture:screenshot', async (_e, mode: CaptureMode) => dispatchCapture(mode))

  ipcMain.handle('region:confirm', async (e, payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) => {
    const displayId = getOverlayDisplayId(e.sender)
    resetOverlayMode()
    closeAllOverlays()
    try {
      // No overlay-gone wait — the crop comes from the frozen snapshot, not a
      // fresh screen grab, so the overlay's residual presence doesn't matter.
      const res = await captureRect(payload.rect, displayId)
      clearFrozenCache()
      return await sendCaptureToEditor(res.image, 'region', res.tagDisplayId, { rect: globalRect(payload.rect, displayId) })
    } catch (err) {
      failCapture('region capture', err)
      return ''
    }
  })

  // Window-pick mode: return window rect at screen coords.
  //
  // Windows: HWND lookup via WindowFromPoint, then DIP/physical conversions.
  // macOS:   delegated to the Swift CGWindowList helper (see mac-window-pick.ts).
  ipcMain.handle('window-pick:get-window-at', (e, x: number, y: number) => windowAtOverlayPoint(e.sender, x, y))

  // The same, at the cursor: the overlay asks once when it opens, so the
  // window under a still pointer is framed without waiting for a move.
  ipcMain.handle('window-pick:get-window-at-cursor', (e) => {
    const displayId = getOverlayDisplayId(e.sender, false)
    const display = screen.getAllDisplays().find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
    const p = screen.getCursorScreenPoint()
    return windowAtOverlayPoint(e.sender, p.x - display.bounds.x, p.y - display.bounds.y)
  })

  async function windowAtOverlayPoint(sender: Electron.WebContents, x: number, y: number) {
    if (process.platform === 'darwin') {
      try {
        const displayId = getOverlayDisplayId(sender, false)
        const allDisplays = screen.getAllDisplays()
        const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

        // Overlay-local DIP → screen-DIP. macOS uses points throughout (Quartz
        // global coords match Electron's display.bounds), so no scale-factor dance.
        const screenX = x + display.bounds.x
        const screenY = y + display.bounds.y

        const rect = await getMacWindowAtPoint(screenX, screenY)
        if (!rect) { lastMacPick = null; return null }

        // Clip to overlay's display so the highlight (and downstream crop)
        // never extends past the visible area when a window spans displays.
        const resolved = resolveMacPickRect(rect, display)
        // Remember which window this frame is, so the confirm can capture
        // that window on its own.
        lastMacPick = resolved && rect.id ? { id: rect.id, rect: resolved } : null
        return resolved
      } catch (err: any) {
        console.error('[window-pick mac] error:', err?.message ?? err)
        return null
      }
    }

    if (process.platform !== 'win32') return null
    try {
      const displayId = getOverlayDisplayId(sender, false)
      const allDisplays = screen.getAllDisplays()
      const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

      // Overlay's (x,y) is in its local DIP. Go: local DIP → screen DIP → physical.
      // Screen DIP ≠ virtual-screen physical on mixed-DPI (each display's DIP is
      // scaled by its own factor), so we let Electron do the conversion.
      const screenDip = { x: x + display.bounds.x, y: y + display.bounds.y }
      const physPt = screen.dipToScreenPoint(screenDip)

      // Native layer returns a rect in virtual-screen PHYSICAL pixels. The
      // resolver clips it to the overlay's display (maximized windows extend
      // ~8px past monitor edges via DWM's invisible resize border) and
      // converts to display-local DIP. Win11's rounded corners are erased to
      // transparency at capture time (rounded-corners.ts).
      const raw = getWindowAtPointPhysical(physPt.x, physPt.y)
      if (!raw) return null

      const resolved = resolveWin32PickRect(raw, display)
      if (!resolved) return null

      // Cache the clipped physical rect for the confirm handler to crop against.
      lastWindowPickPhysical = resolved.phys

      return resolved.rect
    } catch (err: any) {
      console.error('[window-pick] error:', err?.message ?? err)
      return null
    }
  }

  // Window-pick confirm: crop against the cached physical rect so we don't lose
  // pixels to the DIP→physical round-trip.
  ipcMain.handle('window-pick:confirm', async (e, rect: { x: number; y: number; width: number; height: number }) => {
    const overlayId = getOverlayDisplayId(e.sender)
    const cached = lastWindowPickPhysical
    lastWindowPickPhysical = null
    const macPick = lastMacPick && sameRect(lastMacPick.rect, rect) ? lastMacPick : null
    lastMacPick = null
    resetOverlayMode()
    closeAllOverlays()
    try {
      if (macPick) {
        const own = await captureMacWindow(macPick.id)
        if (own) {
          clearFrozenCache()
          return await sendCaptureToEditor(own, 'window', undefined, { rect: globalRect(rect, overlayId) })
        }
      }
      // Erase the window's rounded corners to transparency so the crop matches
      // what was actually on screen (macOS always rounds; Win11 when unmaximized).
      const displayId = cached?.displayId ?? overlayId
      const display = screen.getAllDisplays().find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
      const cornerRadius = pickCornerRadiusPhys(rect, display)
      const res = cached
        ? await capturePhysicalRect(cached, cornerRadius)
        : await captureRect(rect, overlayId, cornerRadius)
      clearFrozenCache()
      return await sendCaptureToEditor(res.image, 'window', res.tagDisplayId, { rect: globalRect(rect, overlayId) })
    } catch (err) {
      failCapture('window capture', err)
      return ''
    }
  })

  ipcMain.handle('window-pick:cancel', () => {
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    restoreFromOverlayCancel()
  })

  // Enter while the window picker is up: confirm the active (foreground)
  // window without hunting for it with the cursor. No-op when nothing is
  // pickable (empty desktop, enumeration unsupported) — the overlay stays up.
  //
  // Guarded twice against key-repeat / double-press: the mode check rejects
  // Enters arriving after a confirm already reset the session, and the
  // in-flight latch rejects a second invoke racing the first one's awaits
  // (which would otherwise double-capture — the second pass live-grabs the
  // screen because the first pass consumed the frozen cache).
  let confirmActiveInFlight = false
  ipcMain.handle('window-pick:confirm-active', async () => {
    const mode = getOverlayMode()
    if (mode !== 'window-pick' && mode !== 'video-window') return null
    if (confirmActiveInFlight) return null
    confirmActiveInFlight = true
    try {
      // captureSelfWindow applies to both screenshot window-pick and
      // video-window sessions (video.ts also skips its hide when it's on).
      const target = await getActivePickTarget(includeSelfInCapture())
      if (!target) return null

      if (mode === 'video-window') {
        await beginWindowRecording(target.rect, target.displayId)
        return null
      }

      lastWindowPickPhysical = null // supersedes any hover-cached rect
      resetOverlayMode()
      closeAllOverlays()
      return await captureWindowTarget(target)
    } catch (err) {
      failCapture('window capture', err)
      return null
    } finally {
      confirmActiveInFlight = false
    }
  })

  ipcMain.handle('region:cancel', () => {
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    restoreFromOverlayCancel()
  })

  // Switch between overlay modes without closing the overlay. Works for both
  // screenshot (region/window-pick/monitor-pick) and video (video-*) intents —
  // the overlay renderer picks rendering + confirm-channel based on the prefix.
  // 'scroll-region' (2026-11-23): the overlay's Scroll tab, confirmed by
  // scroll-region:confirm in scroll-capture.ts.
  ipcMain.handle('overlay:switch-mode', async (_e, mode:
    | 'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'
    | 'video-region' | 'video-window' | 'video-screen'
  ) => {
    const wasVideo = getOverlayMode().startsWith('video-')
    setOverlayMode(mode)
    broadcastToOverlays('overlay:mode-changed', mode)
    // Image <-> Video (2026-11-24): drop the snapshot; back in Image, take a
    // fresh one of the screen as it is now, so the picture is never from an
    // earlier moment than the switch.
    const isVideo = mode.startsWith('video-')
    if (wasVideo === isVideo) return
    const gen = ++refreezeGen
    clearFrozenCache()
    sendFrozenToOverlays()
    if (isVideo) { prepareVideoPick(); return }
    await refreezeUnderOverlays()
    // A later switch or the session's end supersedes this grab.
    if (gen !== refreezeGen || !overlaySessionOpen() || getOverlayMode().startsWith('video-')) {
      if (gen === refreezeGen) clearFrozenCache()
      return
    }
    sendFrozenToOverlays()
  })

  // Monitor-pick: user clicked an overlay → capture that display
  ipcMain.handle('monitor-pick:confirm', async (e) => {
    const displayId = getOverlayDisplayId(e.sender)
    const allDisplays = screen.getAllDisplays()
    const target = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
    resetOverlayMode()
    closeAllOverlays()
    try {
      const res = await captureDisplay(target, allDisplays)
      clearFrozenCache()
      return await sendCaptureToEditor(res.image, 'screen', res.tagDisplayId, { display: target })
    } catch (err) {
      failCapture('screen capture', err)
      return ''
    }
  })

  ipcMain.handle('monitor-pick:cancel', () => {
    resetOverlayMode()
    closeAllOverlays()
    clearFrozenCache()
    restoreFromOverlayCancel()
  })
}

interface CompositeItem { bitmap: Buffer; srcW: number; srcH: number; dx: number; dy: number }

// Composite raw BGRA buffers directly in Node — no PNG encode/decode round-trip,
// no BrowserWindow. Memory copies only, then a single PNG encode at the end.
function compositeBGRA(items: CompositeItem[], totalW: number, totalH: number): Electron.NativeImage {
  const out = Buffer.alloc(totalW * totalH * 4)
  for (const it of items) {
    const { bitmap, srcW, srcH, dx, dy } = it
    if (dx >= totalW) continue
    const rowBytes = srcW * 4
    // Clamp the per-row copy so a display whose captured width differs from the
    // requested width can't wrap past the composite's right edge into the next
    // output row (horizontal shear).
    const copyBytes = Math.min(rowBytes, Math.max(0, totalW - dx) * 4)
    if (copyBytes <= 0) continue
    for (let row = 0; row < srcH; row++) {
      const destY = dy + row
      if (destY < 0 || destY >= totalH) continue
      const destOffset = (destY * totalW + dx) * 4
      const srcOffset  = row * rowBytes
      bitmap.copy(out, destOffset, srcOffset, srcOffset + copyBytes)
    }
  }
  return nativeImage.createFromBuffer(out, { width: totalW, height: totalH })
}

async function captureAllScreen(): Promise<string> {
  try {
    return await captureAllScreenInner()
  } catch (err) {
    failCapture('all-screens capture', err)
    return ''
  }
}

async function captureAllScreenInner(): Promise<string> {
  const allDisplays = screen.getAllDisplays()
  await hideMainWindow()

  // Single-display fast path — captureDisplay tries native capture first,
  // then desktopCapturer.
  if (allDisplays.length <= 1) {
    const d = allDisplays[0] ?? screen.getPrimaryDisplay()
    const res = await captureDisplay(d, allDisplays)
    return await sendCaptureToEditor(res.image, 'all-screen', res.tagDisplayId, { display: d })
  }

  // Multi-display: grab every display through the same native-first freeze the
  // overlay flows use (previously this issued one full-res getSources() per
  // display — N× redundant captures, at seconds each on macOS), then composite.
  await freezeAllDisplays()
  try {
    // Keep each display at its native physical resolution.
    const grabs = allDisplays.map(d => {
      const sf = d.scaleFactor || 1
      return {
        display: d,
        frame: frozenImages.get(d.id) ?? null,
        physW: Math.max(1, Math.round(d.size.width  * sf)),
        physH: Math.max(1, Math.round(d.size.height * sf)),
      }
    })

    // Place each frame at the display's true physical origin on the virtual
    // desktop. Windows: dipToScreenPoint() is the exact origin the GDI
    // snapshot was BitBlt'd from (native-screen.ts) — deriving it as
    // (dipOffset × own scaleFactor) instead diverges on mixed-DPI layouts
    // (Windows arranges monitors in physical pixels; Electron's DIP space is
    // a per-display warp of that), which shifted/overlapped displays in the
    // composite. macOS/other: no global physical space exists — keep the
    // scaled-DIP heuristic (exact whenever all displays share one scaleFactor).
    const physOrigin = (d: Electron.Display): { x: number; y: number } => {
      if (process.platform === 'win32') {
        return screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y })
      }
      const sf = d.scaleFactor || 1
      return { x: d.bounds.x * sf, y: d.bounds.y * sf }
    }
    const origins = new Map(grabs.map(g => [g.display.id, physOrigin(g.display)]))
    const minX = Math.min(...[...origins.values()].map(o => o.x))
    const minY = Math.min(...[...origins.values()].map(o => o.y))

    const phBounds = new Map<number, { x: number; y: number; w: number; h: number }>()
    for (const { display: d, physW, physH } of grabs) {
      const o = origins.get(d.id)!
      phBounds.set(d.id, {
        x: Math.round(o.x - minX),
        y: Math.round(o.y - minY),
        w: physW,
        h: physH,
      })
    }

    const totalW = Math.max(...[...phBounds.values()].map(b => b.x + b.w))
    const totalH = Math.max(...[...phBounds.values()].map(b => b.y + b.h))

    const items: CompositeItem[] = []
    for (const { display: d, frame } of grabs) {
      if (!frame) continue
      const pb = phBounds.get(d.id)!
      const size = frame.image.getSize()
      items.push({
        bitmap: frame.raw?.buffer ?? frame.image.toBitmap(),
        srcW: frame.raw?.width  ?? size.width,
        srcH: frame.raw?.height ?? size.height,
        dx: pb.x,
        dy: pb.y,
      })
    }

    const image = compositeBGRA(items, totalW, totalH)
    // Every frame was sRGB-normalized at freeze time, so the composite is
    // uniformly sRGB and needs no tag. The exception is a LUT-profile display
    // (not convertible): its region stays in display space. A single tag
    // can't be right for a mixed composite anyway — fall back to tagging
    // with the primary display's profile only when the primary itself
    // couldn't convert (labels the dominant region, same compromise as
    // before sRGB normalization existed).
    const primary = screen.getPrimaryDisplay()
    const primarySrgb = frozenImages.get(primary.id)?.srgb ?? true
    return await sendCaptureToEditor(image, 'all-screen', primarySrgb ? undefined : primary.id)
  } finally {
    clearFrozenCache()
  }
}

/** Capture a resolved pick target from the frozen snapshot and hand it to the
 *  editor. Shared by the single-window fast path and Enter-to-confirm. */
async function captureWindowTarget(target: PickTarget): Promise<string> {
  if (target.windowId) {
    const own = await captureMacWindow(target.windowId)
    if (own) {
      clearFrozenCache()
      return await sendCaptureToEditor(own, 'window', undefined, { rect: globalRect(target.rect, target.displayId) })
    }
  }
  const display = screen.getAllDisplays().find(d => d.id === target.displayId) ?? screen.getPrimaryDisplay()
  const cornerRadius = pickCornerRadiusPhys(target.rect, display)
  const res = target.physRect
    ? await capturePhysicalRect(target.physRect, cornerRadius)
    : await captureRect(target.rect, target.displayId, cornerRadius)
  clearFrozenCache()
  return await sendCaptureToEditor(res.image, 'window', res.tagDisplayId, { rect: globalRect(target.rect, target.displayId) })
}

async function captureWindow(): Promise<void> {
  traceBegin('window')
  setOverlayMode('window-pick')
  await hideMainWindow()
  traceMark('hide')
  try {
    // Freeze and the window-list query are independent (the query reads window
    // rects, not pixels) — run them concurrently. On macOS the list goes
    // through the Swift helper and would otherwise stack its latency on top of
    // the freeze before the overlay can surface.
    //
    // Exactly one app window showing → nothing to choose between; capture it
    // outright instead of surfacing the picker. The freeze already banked the
    // pixels, so this is the same crop a click would produce.
    const [, single] = await Promise.all([freezeAllDisplays(), getSinglePickTarget(includeSelfInCapture())])
    traceMark('freeze+list')
    if (single) {
      resetOverlayMode()
      await captureWindowTarget(single)
      return
    }
    createOverlayWindows()
    // Capture happens after overlay fires window-pick:confirm
  } catch (err) {
    // Freeze / overlay start-up failed, or the single window's capture did:
    // without this the main window is left hidden with no way back (the
    // confirm handlers never run).
    failCapture('window capture', err)
  }
}

async function captureRegion(): Promise<void> {
  traceBegin('region')
  await hideMainWindow()
  traceMark('hide')
  try {
    await freezeAllDisplays()
    traceMark('freeze')
    createOverlayWindows()
  } catch (err) {
    failCapture('region capture start', err)
  }
}

/** An encoded capture plus how to color-label it downstream: `tagDisplayId`
 *  is set only when the pixels could NOT be normalized to sRGB (LUT display
 *  profile) — saveOriginalImage then iCCP-tags the PNG with that display's
 *  profile. Undefined means the pixels are sRGB (or the display had no
 *  meaningful profile) and the file needs no tag. */
interface EncodedCapture {
  image: Electron.NativeImage
  tagDisplayId?: number
}

/** Finalize a cropped capture — no PNG encode here; sendCaptureToEditor does
 *  that exactly once. When the crop came from a live grab (frozen
 *  cache miss — `alreadySrgb` false) the pixels are converted from the
 *  display's color space to sRGB first, mirroring what toSrgbFrame did for
 *  frozen frames. When `cornerRadiusPhys` > 0 (window captures only —
 *  region/monitor crops stay square), the corners outside the window's
 *  rounded outline are erased to transparency. */
async function encodeCrop(
  cropped: Electron.NativeImage,
  opts: { displayId?: number | null; alreadySrgb: boolean; cornerRadiusPhys?: number }
): Promise<EncodedCapture> {
  const { displayId, alreadySrgb, cornerRadiusPhys } = opts
  const icc = alreadySrgb || displayId == null ? null : await getDisplayConversionIcc(displayId).catch(() => null)
  const needsMask = !!cornerRadiusPhys && cornerRadiusPhys > 0
  if (!icc && !needsMask) return { image: cropped }

  const size = cropped.getSize()
  const bmp = cropped.toBitmap()
  let tagDisplayId: number | undefined
  if (icc && !convertBgraToSrgbInPlace(bmp, icc)) tagDisplayId = displayId ?? undefined
  if (needsMask) maskCornersInPlace(bmp, size.width, size.height, cornerRadiusPhys!)
  return { image: nativeImage.createFromBitmap(bmp, size), tagDisplayId }
}

// Crop directly in physical pixels against the target display's native
// thumbnail. Takes a rect in virtual-screen physical coords (the same space
// getWindowAtPointPhysical returns).
async function capturePhysicalRect(rect: { x: number; y: number; width: number; height: number; displayId: number }, cornerRadiusPhys?: number): Promise<EncodedCapture> {
  const allDisplays = screen.getAllDisplays()
  const target = allDisplays.find(d => d.id === rect.displayId) ?? screen.getPrimaryDisplay()
  const sf = target.scaleFactor || 1
  const physW = Math.max(1, Math.round(target.size.width  * sf))
  const physH = Math.max(1, Math.round(target.size.height * sf))
  // Frozen cache hit → use the snapshot taken at hotkey time (preserves
  // tooltips/popovers that the overlay would otherwise have dismissed).
  const frozen = frozenImages.get(target.id) ?? null
  let fullImg = frozen?.image ?? null
  if (!fullImg) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } })
    fullImg = findSourceForDisplay(sources, allDisplays, target.id)?.thumbnail ?? null
  }
  if (!fullImg) throw new Error('no screen source available for capture')
  const fullSize = fullImg.getSize()

  // Map virtual-screen physical → display-local physical (thumbnail-local).
  const displayPhysOrigin = screen.dipToScreenPoint({ x: target.bounds.x, y: target.bounds.y })
  const localX = rect.x - displayPhysOrigin.x
  const localY = rect.y - displayPhysOrigin.y

  // If the capturer returned a different size than we requested, scale linearly.
  const sx = fullSize.width  / physW
  const sy = fullSize.height / physH

  const cropX = Math.max(0, Math.round(localX * sx))
  const cropY = Math.max(0, Math.round(localY * sy))
  const cropW = Math.max(1, Math.min(fullSize.width  - cropX, Math.round(rect.width  * sx)))
  const cropH = Math.max(1, Math.min(fullSize.height - cropY, Math.round(rect.height * sy)))

  return encodeCrop(fullImg.crop({ x: cropX, y: cropY, width: cropW, height: cropH }), {
    displayId: target.id,
    alreadySrgb: frozen?.srgb ?? false,
    cornerRadiusPhys,
  })
}

async function captureRect(rect: { x: number; y: number; width: number; height: number }, displayId?: number | null, cornerRadiusPhys?: number): Promise<EncodedCapture> {
  const allDisplays = screen.getAllDisplays()
  const overlayId = displayId ?? getOverlayDisplayId()
  const targetDisplay = allDisplays.find(d => d.id === overlayId) ?? screen.getPrimaryDisplay()
  const scaleFactor = targetDisplay.scaleFactor || 1

  // Fast path: desktopCapturer thumbnail. getUserMedia was ~1-3s on Win; thumbnail
  // is near-instant. We derive actual scale from the returned image size so that
  // mixed-DPI multi-monitor setups still crop correctly.
  const physW = Math.max(1, Math.round(targetDisplay.size.width * scaleFactor))
  const physH = Math.max(1, Math.round(targetDisplay.size.height * scaleFactor))
  // Prefer the frozen snapshot captured at hotkey time. Falls through to a
  // live capture if cache is empty (legacy paths, scrolling capture).
  const frozen = frozenImages.get(targetDisplay.id) ?? null
  let fullImg = frozen?.image ?? null
  if (!fullImg) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } })
    fullImg = findSourceForDisplay(sources, allDisplays, targetDisplay.id)?.thumbnail ?? null
  }
  if (!fullImg) throw new Error('no screen source available for capture')
  const fullSize = fullImg.getSize()
  // Derive actual scale from captured image vs logical size — handles cases where
  // the capturer returns a resolution different from what we requested.
  const sx = fullSize.width  / targetDisplay.size.width
  const sy = fullSize.height / targetDisplay.size.height

  const cropX = Math.max(0, Math.round(rect.x * sx))
  const cropY = Math.max(0, Math.round(rect.y * sy))
  const cropW = Math.max(1, Math.min(fullSize.width  - cropX, Math.round(rect.width  * sx)))
  const cropH = Math.max(1, Math.min(fullSize.height - cropY, Math.round(rect.height * sy)))

  const cropped = fullImg.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  return encodeCrop(cropped, {
    displayId: targetDisplay.id,
    alreadySrgb: frozen?.srgb ?? false,
    cornerRadiusPhys,
  })
}

async function captureDisplay(display: Electron.Display, allDisplays: Electron.Display[]): Promise<EncodedCapture> {
  // Frozen cache hit (monitor-pick path) — hand back the cached NativeImage.
  // We deliberately don't PNG-encode during freezeAllDisplays() (~500-1000ms
  // on 4K, would block overlay creation); sendCaptureToEditor encodes once,
  // off the overlay's critical path. Frozen frames were already
  // sRGB-normalized at freeze time.
  const cached = frozenImages.get(display.id)
  if (cached) return { image: cached.image, tagDisplayId: cached.srgb ? undefined : display.id }

  // No frozen frame (fullscreen / single-display monitor capture — no overlay
  // session) — same native fast path the freeze uses, then desktopCapturer.
  const nat = await captureDisplayNative(display, { includeSelf: includeSelfInCapture() })
  if (nat) {
    const frame = await toSrgbFrame(nat.image, nat.raw, display.id)
    return { image: frame.image, tagDisplayId: frame.srgb ? undefined : display.id }
  }

  const sf = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width:  Math.max(1, Math.round(display.size.width  * sf)),
      height: Math.max(1, Math.round(display.size.height * sf)),
    }
  })
  const src = findSourceForDisplay(sources, allDisplays, display.id)
  if (!src) throw new Error('no screen source available for capture')
  const frame = await toSrgbFrame(src.thumbnail, undefined, display.id)
  return { image: frame.image, tagDisplayId: frame.srgb ? undefined : display.id }
}

async function captureActiveMonitor(): Promise<string | void> {
  const allDisplays = screen.getAllDisplays()

  // Single display → capture immediately.
  if (allDisplays.length <= 1) {
    const activeDisplay = allDisplays[0] ?? screen.getPrimaryDisplay()
    await hideMainWindow()
    try {
      const res = await captureDisplay(activeDisplay, allDisplays)
      return await sendCaptureToEditor(res.image, 'screen', res.tagDisplayId, { display: activeDisplay })
    } catch (err) {
      failCapture('screen capture', err)
      return
    }
  }

  // Multiple displays → show overlays, let the user click one.
  traceBegin('monitor')
  setOverlayMode('monitor-pick')
  await hideMainWindow()
  traceMark('hide')
  try {
    await freezeAllDisplays()
    traceMark('freeze')
    createOverlayWindows()
  } catch (err) {
    failCapture('screen capture start', err)
  }
}

/** `tagDisplayId` — set only when the capture's pixels are still in that
 *  display's color space (LUT profile, not convertible to sRGB); the saved
 *  PNG then gets iCCP-tagged with the display's profile. Callers that
 *  normalized to sRGB pass undefined. The extension bridge follows the same
 *  convention (`srgb ? undefined : displayId`). */
export async function sendCaptureToEditor(
  input: Electron.NativeImage | string,
  source: string,
  tagDisplayId?: number,
  /** What was captured, for the row's source app + window title
   *  (capture-source.ts). Omitted (all screens): the frontmost window. */
  area: SourceArea = null,
): Promise<string> {
  const mainWin = getMainWindow()
  if (!mainWin || mainWin.isDestroyed()) return ''
  // A window or a scrolled page records where it came from; region / screen
  // captures (old 'active-monitor' / 'fullscreen' tags included) only when
  // they show a single window, else just their kind. The lookup starts now and is awaited just
  // before the history row is written, so it runs alongside the watermark /
  // encode / save.
  const captureMode: ClipCaptureMode =
    source === 'window' ? 'window' :
    source === 'region' ? 'region' :
    source === 'scrolling' ? 'scroll' : 'screen'
  const captureSource = captureMode === 'window' || captureMode === 'scroll'
    ? resolveCaptureSource(area)
    : resolveCaptureSource(area, { onlyIfSingle: true })

  // Stamp the Lumia logo into the bottom-left before anything downstream
  // sees the image — clipboard, on-disk original, thumbnail, and the
  // Editor dataUrl all work off the watermarked copy so later exports
  // carry it automatically. Everything below shares ONE PNG encode of that
  // stamped bitmap: the previous data-URL-only pipeline re-encoded and
  // re-decoded the same pixels several times over (≈60 ms on a plain 1080p
  // capture, several hundred on 4K). `input` is a data URL only for callers
  // that already hold one (extension stitch).
  const base = typeof input === 'string' ? nativeImage.createFromDataURL(input) : input
  // The mark is a fixed size on screen: points × the scale of the display
  // the capture came from (the cursor's display when it isn't known).
  const scale = area && 'display' in area ? area.display.scaleFactor
    : area && 'rect' in area ? screen.getDisplayMatching(area.rect).scaleFactor
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor
  const img = applyWatermarkToImage(base, scale)
  const png = img.toPNG()
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`

  const copied = getSettings().copyAfterCapture !== false
  if (copied) { try { clipboard.writeImage(img) } catch { /* silent */ } }

  // Always save the original capture to the save folder (capture-folder.ts).
  // Editor's Save button is a separate flow that writes to a user-chosen path.
  const saved = await saveOriginalImage(png, tagDisplayId)

  // Capture the new entry's id so the Editor knows it's already in history.
  // Without this, a follow-up runWorkflow(...) sees historyId=undefined and the
  // workflow engine adds a *second* row instead of merging uploads into this one.
  let historyId: string | undefined
  try {
    const historyStore = getHistoryStore()
    if (historyStore) {
      const ts = localTimestamp()
      const id: string = randomUUID()
      historyStore.add({
        id,
        timestamp: Date.now(),
        name: saved?.filename ?? `capture-${ts}`,
        filePath: saved?.filePath,
        thumbnailFile: writeThumbnail(id, img),
        type: 'screenshot',
        source: await captureSource,
        captureMode,
        uploads: []
      })
      historyId = id
    }
  } catch (err) {
    // The image is saved and on its way to the editor; only its row is missing.
    console.error('[capture] could not add the capture to history', err)
  }

  // Tray-only state: user dismissed the main window before triggering this
  // capture (hotkey or tray menu), and Settings › General › Open editor
  // after every capture is off. Honor that — surface the toast and stop.
  // The notification's onClick still calls openHistoryItemInEditor, so a
  // tap on the toast brings them back into the editor on demand.
  //
  // Otherwise: send navigate first, then wait for the renderer to ack that
  // /editor has actually mounted before showing the window — otherwise the
  // user sees a brief flash of the previous route (dashboard) while React
  // processes the navigation. The renderer was alive throughout the capture
  // so we expect the ack within a frame; the helper has a generous timeout
  // fallback.
  if (claimEditorAfterCapture('image')) {
    await prepareMainOnRoute('/editor', () => mainWin.webContents.send('navigate', '/editor', { dataUrl, source, historyId }))
    showMainWindow()
  } else {
    // No editor: the window stays away (closed before, or Never) and focus
    // goes back to the app the overlay took over from.
    restoreFromOverlayCancel()
  }

  showNotification({
    body: copied ? 'Image captured and copied' : 'Image captured',
    thumbnailDataUrl: dataUrl,
    onClick: historyId ? () => { void openHistoryItemInEditor(historyId!) } : undefined,
    launchId: historyId ?? undefined,
  })
  return dataUrl
}
