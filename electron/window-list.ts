/**
 * Shared window-pick target logic backing two picker shortcuts:
 *   - auto-select when exactly one app window is showing (skip the overlay)
 *   - Enter selects the active (foreground) window while the picker is up
 *
 * Windows: enumerates top-level windows via native-input's z-order walk.
 * macOS:   asks the window-at-point Swift helper for its "list" query.
 * Both return front-to-back order, so [0] is the frontmost window.
 */

import { screen } from 'electron'
import { listTopLevelWindowsPhysical, getForegroundWindowHwnd } from './native-input'
import { listMacWindows } from './mac-window-pick'

export interface PickRect { x: number; y: number; width: number; height: number }

export interface PickTarget {
  displayId: number
  /** Display-local DIP rect — the same space the overlay renderer picks in. */
  rect: PickRect
  /** Win32 only: clipped virtual-screen physical rect for the lossless
   *  capturePhysicalRect crop path (mirrors lastWindowPickPhysical). */
  physRect?: PickRect & { displayId: number }
  /** Win32 only: HWND for matching against the foreground snapshot. */
  hwnd?: unknown
}

/**
 * Win32: clip a raw window rect (virtual-screen physical pixels, as returned
 * by getWindowAtPointPhysical / listTopLevelWindowsPhysical) to one display
 * and convert to display-local DIP.
 * Extracted from the window-pick:get-window-at handler — behavior identical.
 */
export function resolveWin32PickRect(
  raw: PickRect,
  display: Electron.Display,
): { rect: PickRect; phys: PickRect & { displayId: number } } | null {
  const displayPhysOrigin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
  const sf = display.scaleFactor || 1
  const displayPhysW = Math.round(display.size.width  * sf)
  const displayPhysH = Math.round(display.size.height * sf)

  // DWM's rectangular frame bounds encloses Win11's ~8 DIP rounded corners,
  // so the crop's corners would show wallpaper. That used to be papered over
  // with a 2px inset here (losing a sliver of content on every edge); the
  // corners are now erased to transparency at capture time instead
  // (rounded-corners.ts), so the rect stays exact.
  const pLeft   = Math.max(displayPhysOrigin.x, raw.x)
  const pTop    = Math.max(displayPhysOrigin.y, raw.y)
  const pRight  = Math.min(displayPhysOrigin.x + displayPhysW, raw.x + raw.width)
  const pBottom = Math.min(displayPhysOrigin.y + displayPhysH, raw.y + raw.height)
  if (pRight <= pLeft || pBottom <= pTop) return null

  // Convert clipped physical → DIP for the overlay highlight / DIP consumers.
  const dipRect = screen.screenToDipRect(null as never, {
    x: pLeft, y: pTop, width: pRight - pLeft, height: pBottom - pTop,
  })
  const left   = Math.max(display.bounds.x, Math.round(dipRect.x))
  const top    = Math.max(display.bounds.y, Math.round(dipRect.y))
  const right  = Math.min(display.bounds.x + display.bounds.width,  Math.round(dipRect.x + dipRect.width))
  const bottom = Math.min(display.bounds.y + display.bounds.height, Math.round(dipRect.y + dipRect.height))
  if (right <= left || bottom <= top) return null

  return {
    rect: {
      x: left - display.bounds.x,
      y: top - display.bounds.y,
      width: right - left,
      height: bottom - top,
    },
    phys: {
      x: pLeft,
      y: pTop,
      width: pRight - pLeft,
      height: pBottom - pTop,
      displayId: display.id,
    },
  }
}

/**
 * macOS: clip a window rect (global screen points, matching display.bounds
 * space) to one display and convert to display-local coordinates. Extracted
 * from the window-pick:get-window-at handler — behavior identical.
 */
export function resolveMacPickRect(
  raw: PickRect,
  display: Electron.Display,
): PickRect | null {
  const left   = Math.max(display.bounds.x, Math.round(raw.x))
  const top    = Math.max(display.bounds.y, Math.round(raw.y))
  const right  = Math.min(display.bounds.x + display.bounds.width,  Math.round(raw.x + raw.width))
  const bottom = Math.min(display.bounds.y + display.bounds.height, Math.round(raw.y + raw.height))
  if (right <= left || bottom <= top) return null

  return {
    x: left - display.bounds.x,
    y: top - display.bounds.y,
    width: right - left,
    height: bottom - top,
  }
}

// Foreground window captured at overlay-session start. By the time the user
// presses Enter, the overlay itself is the foreground window — so the "active
// window" has to be remembered from before the overlay took focus.
let foregroundHwndAtSessionStart: unknown = 0

/** Snapshot the current foreground window. Call at overlay-session start,
 *  before any overlay window is focused. No-op off Windows — macOS derives
 *  the frontmost window from CGWindowList order, which our (excluded-by-pid)
 *  overlay windows never perturb. */
export function snapshotActivePickWindow(): void {
  if (process.platform !== 'win32') return
  try {
    foregroundHwndAtSessionStart = getForegroundWindowHwnd()
  } catch {
    foregroundHwndAtSessionStart = 0
  }
}

function win32ToPickTarget(w: { hwnd: unknown } & PickRect): PickTarget | null {
  // Attribute the window to the display with the largest overlap; the clip
  // then bounds the crop to that display (same rule as hover-picking, where
  // the overlay's display clips the rect).
  const dip = screen.screenToDipRect(null as never, { x: w.x, y: w.y, width: w.width, height: w.height })
  const display = screen.getDisplayMatching({
    x: Math.round(dip.x), y: Math.round(dip.y),
    width: Math.max(1, Math.round(dip.width)), height: Math.max(1, Math.round(dip.height)),
  })
  const resolved = resolveWin32PickRect(w, display)
  if (!resolved) return null
  return { displayId: display.id, rect: resolved.rect, physRect: resolved.phys, hwnd: w.hwnd }
}

/** All pickable app windows, front-to-back. Empty when enumeration is
 *  unsupported (koffi failed to load, pre-"list" macOS helper, linux).
 *
 *  `includeSelf` ("Capture Lumia window too"): Win32 lets our own windows
 *  count as targets. macOS can't — the window-at-point helper excludes our
 *  PID at spawn — so Lumia stays unpickable there (region/screen captures
 *  still include it via the freeze's desktopCapturer fallback). */
export async function listPickTargets(includeSelf = false): Promise<PickTarget[]> {
  if (process.platform === 'win32') {
    return listTopLevelWindowsPhysical(includeSelf)
      .map(win32ToPickTarget)
      .filter((t): t is PickTarget => t !== null)
  }
  if (process.platform === 'darwin') {
    const wins = await listMacWindows()
    return wins
      .map((r): PickTarget | null => {
        const display = screen.getDisplayMatching({
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)),
        })
        const rect = resolveMacPickRect(r, display)
        return rect ? { displayId: display.id, rect } : null
      })
      .filter((t): t is PickTarget => t !== null)
  }
  return []
}

/** The lone pickable window, or null when there are zero or several. */
export async function getSinglePickTarget(includeSelf = false): Promise<PickTarget | null> {
  const targets = await listPickTargets(includeSelf)
  return targets.length === 1 ? targets[0] : null
}

/** The active window for Enter-to-confirm: the foreground window snapshotted
 *  at session start when it's still pickable, else the frontmost pickable
 *  window, else null (Enter is then a no-op). */
export async function getActivePickTarget(includeSelf = false): Promise<PickTarget | null> {
  const targets = await listPickTargets(includeSelf)
  if (targets.length === 0) return null
  if (process.platform === 'win32' && foregroundHwndAtSessionStart) {
    const hit = targets.find(t => t.hwnd === foregroundHwndAtSessionStart)
    if (hit) return hit
  }
  return targets[0]
}
