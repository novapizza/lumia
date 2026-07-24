import { desktopCapturer, ipcMain, screen, nativeImage, clipboard } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { getMainWindow, createOverlayWindows, closeAllOverlays, getHistoryStore, getOverlayDisplayId, broadcastToOverlays, restoreFromOverlayCancel, waitForViewMounted, openHistoryItemInEditor, isMainDismissed } from './index'
import { getWindowAtPointPhysical } from './native-input'
import { getMacWindowAtPoint } from './mac-window-pick'
import { resolveWin32PickRect, resolveMacPickRect, getSinglePickTarget, getActivePickTarget, PickTarget } from './window-list'
import { setOverlayMode, resetOverlayMode, getOverlayMode } from './scroll-capture'
import { localTimestamp } from './utils'
import { makeThumbnail } from './thumbnail'
import { showNotification } from './notify'
import { applyWatermark } from './watermark'
import { getSettings } from './settings'
import { startVideoCapture, beginWindowRecording } from './video'
import { getDisplayIcc } from './display-icc'
import { tagPngWithIcc } from './png-icc'
import { captureDisplayNative, type NativeCapture } from './native-screen'
import { macSnapAvailable } from './mac-screen-snap'

/** Canonical folder for original captures (both images and videos). Not
 *  user-configurable — user-chosen locations are for the Save-As dialog only,
 *  which writes a separate file and never touches the original. */
export const ORIGINALS_DIR = join(homedir(), 'Pictures', 'Lumia')

/** Write the just-captured image to disk at {ORIGINALS_DIR}/capture-{ts}.{ext}.
 *  Best-effort — returns null if anything goes wrong so capture still completes.
 *
 *  When `displayId` is provided and the OS exposes an ICC profile for that
 *  display, the PNG gets an `iCCP` chunk before write — so color-managed
 *  viewers render wide-gamut content (P3 MacBooks, calibrated monitors)
 *  faithfully instead of falling back to sRGB. JPEG path skips tagging
 *  (different container, not currently produced by our capture pipeline). */
async function saveOriginalImage(dataUrl: string, displayId?: number): Promise<{ filePath: string; filename: string } | null> {
  try {
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(ORIGINALS_DIR, { recursive: true })
    const ts = localTimestamp()
    const isJpeg = dataUrl.startsWith('data:image/jpeg')
    const ext = isJpeg ? 'jpg' : 'png'
    const filename = `capture-${ts}.${ext}`
    const filePath = join(ORIGINALS_DIR, filename)
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    // Annotate as the default Buffer<ArrayBufferLike> so reassigning the result
    // of tagPngWithIcc (also Buffer<ArrayBufferLike>) type-checks under @types/node 26.
    let buf: Buffer = Buffer.from(base64, 'base64')

    if (!isJpeg && displayId != null) {
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

const HIDE_DELAY_MS = process.platform === 'darwin' ? 250 : 200

// True when the last hideMainWindow() skipped the compositor-settle wait
// because the macOS native snapshot excludes Lumia's windows anyway (PID
// filter in the screen-snap helper). freezeAllDisplays() consults this if it
// unexpectedly lands on the desktopCapturer fallback — that path captures the
// real screen and CAN bake a still-fading main window into the frame.
let hideWaitSkipped = false

function hideMainWindow(): Promise<void> {
  return new Promise(resolve => {
    hideWaitSkipped = false
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
}
const frozenImages = new Map<number, FrozenFrame>()

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

function clearFrozenCache() {
  frozenImages.clear()
}

/** Snapshot every display at full physical resolution into the frozen cache.
 *  Caller must have already hidden the main window (otherwise main bakes
 *  into the cached frame). Runs all displays in parallel. */
async function freezeAllDisplays(): Promise<void> {
  clearFrozenCache()
  const t0 = Date.now()
  const allDisplays = screen.getAllDisplays()

  // Fast path: native capture — Windows GDI BitBlt (~5–20 ms/display), macOS
  // 14+ warm ScreenCaptureKit helper (~50–200 ms/display). See native-screen.ts.
  const fallbackDisplays: Electron.Display[] = []
  await Promise.all(allDisplays.map(async d => {
    const nat: NativeCapture | null = await captureDisplayNative(d)
    if (nat) frozenImages.set(d.id, nat)
    else fallbackDisplays.push(d)
  }))
  if (fallbackDisplays.length === 0) {
    console.log(`[capture] freeze: ${Date.now() - t0}ms, ${allDisplays.length} display(s), all native`)
    return
  }

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
      if (src) frozenImages.set(d.id, { image: src.thumbnail })
    }
  }))
  console.log(`[capture] freeze: ${Date.now() - t0}ms, ${allDisplays.length} display(s), ${fallbackDisplays.length} via desktopCapturer fallback`)
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

// Map webContentsId → source payload for overlay pull
const overlaySourcePayloads = new Map<number, { sourceId: string; scaleFactor: number }>()

// Cache last window-pick physical rect so confirm can crop in physical pixels
// directly. Avoids the DIP round-trip which introduces sub-pixel drift and,
// for maximized windows, can expose the ~8px invisible resize border that
// DWM rolls into the frame bounds.
let lastWindowPickPhysical: {
  x: number; y: number; width: number; height: number; displayId: number
} | null = null

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
  if (s.lastImageMode === 'scrolling') {
    const main = getMainWindow()
    if (main && !main.isDestroyed()) main.hide()
    await new Promise(r => setTimeout(r, 200))
    setOverlayMode('scroll-region')
    createOverlayWindows()
    return
  }
  dispatchCapture(s.lastImageMode)
}

export function setupCapture() {
  ipcMain.handle('capture:screenshot', async (_e, mode: CaptureMode) => dispatchCapture(mode))
  ipcMain.handle('capture:new', async () => dispatchLastCapture())

  ipcMain.handle('region:confirm', async (_e, payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) => {
    const displayId = getOverlayDisplayId()
    resetOverlayMode()
    closeAllOverlays()
    // No overlay-gone wait — the crop comes from the frozen snapshot, not a
    // fresh screen grab, so the overlay's residual presence doesn't matter.
    const dataUrl = await captureRect(payload.rect, displayId)
    clearFrozenCache()
    await sendCaptureToEditor(dataUrl, 'region', displayId ?? undefined)
    return dataUrl
  })

  ipcMain.handle('overlay:get-source', (e) => {
    return overlaySourcePayloads.get(e.sender.id) ?? null
  })

  // Window-pick mode: return window rect at screen coords.
  //
  // Windows: HWND lookup via WindowFromPoint, then DIP/physical conversions.
  // macOS:   delegated to the Swift CGWindowList helper (see mac-window-pick.ts).
  ipcMain.handle('window-pick:get-window-at', async (_e, x: number, y: number) => {
    if (process.platform === 'darwin') {
      try {
        const displayId = getOverlayDisplayId()
        const allDisplays = screen.getAllDisplays()
        const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

        // Overlay-local DIP → screen-DIP. macOS uses points throughout (Quartz
        // global coords match Electron's display.bounds), so no scale-factor dance.
        const screenX = x + display.bounds.x
        const screenY = y + display.bounds.y

        const rect = await getMacWindowAtPoint(screenX, screenY)
        if (!rect) return null

        // Clip to overlay's display so the highlight (and downstream crop)
        // never extends past the visible area when a window spans displays.
        return resolveMacPickRect(rect, display)
      } catch (err: any) {
        console.error('[window-pick mac] error:', err?.message ?? err)
        return null
      }
    }

    if (process.platform !== 'win32') return null
    try {
      const displayId = getOverlayDisplayId()
      const allDisplays = screen.getAllDisplays()
      const display = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()

      // Overlay's (x,y) is in its local DIP. Go: local DIP → screen DIP → physical.
      // Screen DIP ≠ virtual-screen physical on mixed-DPI (each display's DIP is
      // scaled by its own factor), so we let Electron do the conversion.
      const screenDip = { x: x + display.bounds.x, y: y + display.bounds.y }
      const physPt = screen.dipToScreenPoint(screenDip)

      // Native layer returns a rect in virtual-screen PHYSICAL pixels. The
      // resolver clips it to the overlay's display (maximized windows extend
      // ~8px past monitor edges via DWM's invisible resize border), bites past
      // Win11 rounded corners, and converts to display-local DIP.
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
  })

  // Window-pick confirm: crop against the cached physical rect so we don't lose
  // pixels to the DIP→physical round-trip.
  ipcMain.handle('window-pick:confirm', async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    const overlayId = getOverlayDisplayId()
    const cached = lastWindowPickPhysical
    lastWindowPickPhysical = null
    resetOverlayMode()
    closeAllOverlays()
    const dataUrl = cached
      ? await capturePhysicalRect(cached)
      : await captureRect(rect, overlayId)
    clearFrozenCache()
    await sendCaptureToEditor(dataUrl, 'window', cached?.displayId ?? overlayId ?? undefined)
    return dataUrl
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
      const target = await getActivePickTarget()
      if (!target) return null

      if (mode === 'video-window') {
        await beginWindowRecording(target.rect, target.displayId)
        return null
      }

      lastWindowPickPhysical = null // supersedes any hover-cached rect
      resetOverlayMode()
      closeAllOverlays()
      return await captureWindowTarget(target)
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
  ipcMain.handle('overlay:switch-mode', (_e, mode:
    | 'region' | 'window-pick' | 'monitor-pick'
    | 'video-region' | 'video-window' | 'video-screen'
  ) => {
    setOverlayMode(mode)
    broadcastToOverlays('overlay:mode-changed', mode)
  })

  // Monitor-pick: user clicked an overlay → capture that display
  ipcMain.handle('monitor-pick:confirm', async () => {
    const displayId = getOverlayDisplayId()
    const allDisplays = screen.getAllDisplays()
    const target = allDisplays.find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
    resetOverlayMode()
    closeAllOverlays()
    const dataUrl = await captureDisplay(target, allDisplays)
    clearFrozenCache()
    await sendCaptureToEditor(dataUrl, 'screen', target.id)
    return dataUrl
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
function compositeBGRA(items: CompositeItem[], totalW: number, totalH: number): string {
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
  return nativeImage.createFromBuffer(out, { width: totalW, height: totalH }).toDataURL()
}

async function captureAllScreen(): Promise<string> {
  const allDisplays = screen.getAllDisplays()
  await hideMainWindow()

  // Single-display fast path — captureDisplay tries native capture first,
  // then desktopCapturer.
  if (allDisplays.length <= 1) {
    const d = allDisplays[0] ?? screen.getPrimaryDisplay()
    const dataUrl = await captureDisplay(d, allDisplays)
    await sendCaptureToEditor(dataUrl, 'all-screen', d.id)
    return dataUrl
  }

  // Multi-display: grab every display through the same native-first freeze the
  // overlay flows use (previously this issued one full-res getSources() per
  // display — N× redundant captures, at seconds each on macOS), then composite.
  await freezeAllDisplays()
  try {
    // Keep each display at its native physical resolution. Position each display
    // in physical-pixel space by scaling its OWN DIP origin (offset from the
    // bounding box of all displays) by its scale factor — rather than summing the
    // sizes of other displays. The old summing rule double-offset stacked columns
    // and vertically-offset layouts (black bands / top-aligned content).
    const grabs = allDisplays.map(d => {
      const sf = d.scaleFactor || 1
      return {
        display: d,
        frame: frozenImages.get(d.id) ?? null,
        physW: Math.max(1, Math.round(d.size.width  * sf)),
        physH: Math.max(1, Math.round(d.size.height * sf)),
      }
    })

    // Bounding box of all displays in DIP space.
    const minX = Math.min(...grabs.map(g => g.display.bounds.x))
    const minY = Math.min(...grabs.map(g => g.display.bounds.y))

    const phBounds = new Map<number, { x: number; y: number; w: number; h: number }>()
    for (const { display: d, physW, physH } of grabs) {
      const sf = d.scaleFactor || 1
      const px = Math.round((d.bounds.x - minX) * sf)
      const py = Math.round((d.bounds.y - minY) * sf)
      phBounds.set(d.id, { x: px, y: py, w: physW, h: physH })
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

    const dataUrl = compositeBGRA(items, totalW, totalH)
    // Multi-display composite has mixed color spaces by construction (each
    // display's pixels are in its own native space). Tag with the primary
    // display's profile — accepts inaccuracy across non-primary regions in
    // exchange for at least labeling the dominant color space.
    await sendCaptureToEditor(dataUrl, 'all-screen', screen.getPrimaryDisplay().id)
    return dataUrl
  } finally {
    clearFrozenCache()
  }
}

/** Capture a resolved pick target from the frozen snapshot and hand it to the
 *  editor. Shared by the single-window fast path and Enter-to-confirm. */
async function captureWindowTarget(target: PickTarget): Promise<string> {
  const dataUrl = target.physRect
    ? await capturePhysicalRect(target.physRect)
    : await captureRect(target.rect, target.displayId)
  clearFrozenCache()
  await sendCaptureToEditor(dataUrl, 'window', target.displayId)
  return dataUrl
}

async function captureWindow(): Promise<void> {
  setOverlayMode('window-pick')
  await hideMainWindow()
  try {
    // Freeze and the window-list query are independent (the query reads window
    // rects, not pixels) — run them concurrently. On macOS the list goes
    // through the Swift helper and would otherwise stack its latency on top of
    // the freeze before the overlay can surface.
    //
    // Exactly one app window showing → nothing to choose between; capture it
    // outright instead of surfacing the picker. The freeze already banked the
    // pixels, so this is the same crop a click would produce.
    const [, single] = await Promise.all([freezeAllDisplays(), getSinglePickTarget()])
    if (single) {
      resetOverlayMode()
      await captureWindowTarget(single)
      return
    }
    createOverlayWindows()
    // Capture happens after overlay fires window-pick:confirm
  } catch (err) {
    // Freeze/overlay startup failed — without this restore the main window is
    // left hidden with no way back (the confirm handlers never run).
    console.error('[capture] window-pick startup failed', err)
    resetOverlayMode()
    clearFrozenCache()
    closeAllOverlays()
    showMainWindow()
  }
}

async function captureRegion(): Promise<void> {
  await hideMainWindow()
  try {
    await freezeAllDisplays()
    createOverlayWindows()
  } catch (err) {
    console.error('[capture] region startup failed', err)
    resetOverlayMode()
    clearFrozenCache()
    closeAllOverlays()
    showMainWindow()
  }
}

// Crop directly in physical pixels against the target display's native
// thumbnail. Takes a rect in virtual-screen physical coords (the same space
// getWindowAtPointPhysical returns).
async function capturePhysicalRect(rect: { x: number; y: number; width: number; height: number; displayId: number }): Promise<string> {
  const allDisplays = screen.getAllDisplays()
  const target = allDisplays.find(d => d.id === rect.displayId) ?? screen.getPrimaryDisplay()
  const sf = target.scaleFactor || 1
  const physW = Math.max(1, Math.round(target.size.width  * sf))
  const physH = Math.max(1, Math.round(target.size.height * sf))
  // Frozen cache hit → use the snapshot taken at hotkey time (preserves
  // tooltips/popovers that the overlay would otherwise have dismissed).
  let fullImg = frozenImages.get(target.id)?.image ?? null
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

  return fullImg.crop({ x: cropX, y: cropY, width: cropW, height: cropH }).toDataURL()
}

async function captureRect(rect: { x: number; y: number; width: number; height: number }, displayId?: number | null): Promise<string> {
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
  let fullImg = frozenImages.get(targetDisplay.id)?.image ?? null
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
  return cropped.toDataURL()
}

async function captureDisplay(display: Electron.Display, allDisplays: Electron.Display[]): Promise<string> {
  // Frozen cache hit (monitor-pick path) — encode the cached NativeImage to
  // PNG now. We deliberately don't pre-encode during freezeAllDisplays(): the
  // encode is ~500-1000ms on 4K and would block overlay creation. At confirm
  // time it's off the critical path (overlay already gone) so the cost is OK.
  const cached = frozenImages.get(display.id)
  if (cached) return cached.image.toDataURL()

  // No frozen frame (fullscreen / single-display monitor capture — no overlay
  // session) — same native fast path the freeze uses, then desktopCapturer.
  const nat = await captureDisplayNative(display)
  if (nat) return nat.image.toDataURL()

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
  return src.thumbnail.toDataURL()
}

async function captureActiveMonitor(): Promise<string | void> {
  const allDisplays = screen.getAllDisplays()

  // Single display → capture immediately.
  if (allDisplays.length <= 1) {
    const activeDisplay = allDisplays[0] ?? screen.getPrimaryDisplay()
    await hideMainWindow()
    const dataUrl = await captureDisplay(activeDisplay, allDisplays)
    await sendCaptureToEditor(dataUrl, 'screen', activeDisplay.id)
    return dataUrl
  }

  // Multiple displays → show overlays, let the user click one.
  setOverlayMode('monitor-pick')
  await hideMainWindow()
  try {
    await freezeAllDisplays()
    createOverlayWindows()
  } catch (err) {
    console.error('[capture] monitor-pick startup failed', err)
    resetOverlayMode()
    clearFrozenCache()
    closeAllOverlays()
    showMainWindow()
  }
}

export async function sendCaptureToEditor(dataUrlIn: string, source: string, displayId?: number) {
  const mainWin = getMainWindow()
  if (!mainWin || mainWin.isDestroyed()) return

  // Stamp the Lumia logo into the bottom-left before anything downstream
  // sees the image — clipboard, on-disk original, thumbnail, and the
  // Editor dataUrl all work off the watermarked copy so later exports
  // carry it automatically.
  const dataUrl = applyWatermark(dataUrlIn)

  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    clipboard.writeImage(img)
  } catch { /* silent */ }

  // Always save the original capture to ~/Pictures/Lumia/ (fixed location).
  // Editor's Save button is a separate flow that writes to a user-chosen path.
  // Pass displayId so the PNG carries the originating display's ICC profile.
  const saved = await saveOriginalImage(dataUrl, displayId)

  // Capture the new entry's id so the Editor knows it's already in history.
  // Without this, a follow-up runWorkflow(...) sees historyId=undefined and the
  // workflow engine adds a *second* row instead of merging uploads into this one.
  let historyId: string | undefined
  try {
    const historyStore = getHistoryStore()
    if (historyStore) {
      const ts = localTimestamp()
      const id: string = require('crypto').randomUUID()
      historyStore.add({
        id,
        timestamp: Date.now(),
        name: saved?.filename ?? `capture-${ts}`,
        filePath: saved?.filePath,
        thumbnailUrl: makeThumbnail(dataUrl),
        type: 'screenshot',
        uploads: []
      })
      historyId = id
    }
  } catch { /* silent */ }

  // Tray-only state: user dismissed the main window before triggering this
  // capture (hotkey or tray menu). Honor that — surface the toast and stop.
  // The notification's onClick still calls openHistoryItemInEditor, so a
  // tap on the toast brings them back into the editor on demand.
  //
  // Otherwise: send navigate first, then wait for the renderer to ack that
  // /editor has actually mounted before showing the window — otherwise the
  // user sees a brief flash of the previous route (dashboard) while React
  // processes the navigation. The renderer was alive throughout the capture
  // so we expect the ack within a frame; the helper has a generous timeout
  // fallback.
  if (!isMainDismissed()) {
    mainWin.webContents.send('navigate', '/editor', { dataUrl, source, historyId })
    await waitForViewMounted('/editor')
    showMainWindow()
  }

  // 'active-monitor' / 'fullscreen' are legacy source tags from older
  // builds — preserved here so notifications for existing history items
  // still render correctly.
  const label =
    source === 'region' ? 'Region' :
    source === 'window' ? 'Window' :
    source === 'screen' || source === 'active-monitor' ? 'Screen' :
    'All Screens'
  // Snapshot tray state at notification fire time. The user clicking the
  // toast later (banner or Action Center) should produce the same
  // X-close behavior regardless of what's happened to the window in
  // between — capturing this value here makes the decision deterministic.
  const fromTray = isMainDismissed()
  showNotification({
    body: `${label} captured — copied to clipboard`,
    thumbnailDataUrl: dataUrl,
    onClick: historyId ? () => { void openHistoryItemInEditor(historyId!, fromTray) } : undefined,
    launchId: historyId ?? undefined,
  })
}
