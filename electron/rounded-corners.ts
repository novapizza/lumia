/**
 * Rounded-corner alpha masking for window captures.
 *
 * A window capture is a rectangular crop out of the flat frozen screenshot,
 * but real windows have rounded corners — macOS always, Windows 11 only when
 * not maximized (Windows 10 never rounds). Without masking, the crop's
 * corners carry whatever sat behind the window (wallpaper, other windows),
 * which looks broken the moment the capture lands on any other background.
 *
 * pickCornerRadiusPhys() decides the radius for a picked window (0 = leave
 * square), and maskCornersInPlace() erases the pixels outside the rounded
 * outline — anti-aliased, premultiplied-alpha-safe — so window captures ship
 * with transparent corners matching what the user actually saw on screen.
 */

import { release } from 'os'
import type { Display } from 'electron'

/** Mask radius in DIP, or 0 when the platform squares corners.
 *
 *  Values deliberately overshoot the OS's nominal radius by a hair: the OS
 *  draws its corner curve with ~1–1.5px of anti-aliasing, so a mask at the
 *  exact nominal radius leaves a glaring semi-transparent halo of background
 *  along the curve, while overshooting only shaves an invisible sliver off
 *  the window's own chrome (title-bar corners are uniformly colored). */
function windowCornerRadiusDip(): number {
  if (process.platform === 'darwin') {
    // Darwin 25 == macOS 26 "Tahoe", whose Liquid Glass windows round at
    // ~26pt — far beyond the ~10–11pt of Big Sur → Sequoia.
    const darwinMajor = Number(release().split('.')[0] ?? 0)
    return darwinMajor >= 25 ? 26 : 12
  }
  if (process.platform === 'win32') {
    // Windows 11 (build 22000+) rounds top-level windows at a nominal 8 DIP.
    const build = Number(release().split('.')[2] ?? 0)
    return build >= 22000 ? 10 : 0
  }
  return 0
}

/**
 * Physical-pixel corner radius for a picked window, or 0 when the capture
 * should stay square. `rect` is the picked window in display-local DIP.
 *
 * Square cases: fullscreen windows (both platforms), and maximized windows
 * on Windows (they fill the work area and DWM squares their corners). A
 * macOS "zoomed" window also fills the work area but KEEPS its rounded
 * corners, so the work-area check is Windows-only.
 *
 * All four corners are masked uniformly. For a window clipped mid-body by
 * the display edge (spanning monitors) this rounds two corners that are
 * really window interior — accepted: it costs a few arc pixels in a rare
 * layout, while per-corner detection would mis-handle the common snapped
 * window, which keeps its rounded corners flush against the screen edge.
 */
export function pickCornerRadiusPhys(
  rect: { x: number; y: number; width: number; height: number },
  display: Display,
): number {
  const dip = windowCornerRadiusDip()
  if (dip <= 0) return 0

  const b = display.bounds
  // rect is display-local; compare against areas converted to the same space.
  const covers = (ax: number, ay: number, aw: number, ah: number) =>
    rect.x <= ax + 2 && rect.y <= ay + 2 &&
    rect.x + rect.width  >= ax + aw - 2 &&
    rect.y + rect.height >= ay + ah - 2

  if (covers(0, 0, b.width, b.height)) return 0
  if (process.platform === 'win32') {
    const wa = display.workArea
    if (covers(wa.x - b.x, wa.y - b.y, wa.width, wa.height)) return 0
  }

  return Math.max(1, Math.round(dip * (display.scaleFactor || 1)))
}

/**
 * Erase the four corners outside a rounded-rect outline, in place, on a
 * premultiplied BGRA bitmap (the format NativeImage.toBitmap returns).
 * Coverage-scaled edges give ~1px of anti-aliasing; scaling all four
 * channels keeps the premultiplication consistent.
 */
export function maskCornersInPlace(bitmap: Buffer, width: number, height: number, radius: number): void {
  const r = Math.min(Math.round(radius), Math.floor(Math.min(width, height) / 2))
  if (r <= 0) return

  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      // Distance from this pixel's center to the corner arc's center (r, r).
      const dx = r - (x + 0.5)
      const dy = r - (y + 0.5)
      const cov = r - Math.sqrt(dx * dx + dy * dy) + 0.5
      if (cov >= 1) continue
      const f = cov > 0 ? cov : 0
      scalePixel(bitmap, width, x, y, f)                              // top-left
      scalePixel(bitmap, width, width - 1 - x, y, f)                  // top-right
      scalePixel(bitmap, width, x, height - 1 - y, f)                 // bottom-left
      scalePixel(bitmap, width, width - 1 - x, height - 1 - y, f)     // bottom-right
    }
  }
}

function scalePixel(buf: Buffer, width: number, x: number, y: number, f: number): void {
  const i = (y * width + x) * 4
  if (f <= 0) {
    buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0
    return
  }
  buf[i]     = Math.round(buf[i]     * f)
  buf[i + 1] = Math.round(buf[i + 1] * f)
  buf[i + 2] = Math.round(buf[i + 2] * f)
  buf[i + 3] = Math.round(buf[i + 3] * f)
}
