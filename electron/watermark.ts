import { app, nativeImage } from 'electron'
import { join } from 'path'

/**
 * Stamp the Lumia logo onto a captured image in the bottom-left corner
 * with a bit of transparency, so every screenshot carries subtle
 * attribution without crowding the content.
 *
 * Config:
 *   - Logo sized to 2.5% of the shorter capture dimension.
 *   - Positioned tight against the corner (small fixed margin).
 *   - Drawn at ~20% opacity, multiplied by the logo's own per-pixel
 *     alpha so antialiased edges stay soft.
 *
 * Implementation: compose directly on the BGRA bitmap buffer returned
 * by `nativeImage.toBitmap()`. No canvas lib, no renderer hop — keeps
 * this on the main process capture path where it belongs.
 */

// Dev: resources/ lives next to out/ on disk, so __dirname/../../resources works.
// Prod: only out/ is bundled into app.asar; the logo is shipped via
// electron-builder's extraResources and lives at process.resourcesPath/icons/...
const LOGO_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icons/png/icon.png')
  : join(__dirname, '../../resources/icons/png/icon.png')
const LOGO_SIZE_PCT = 0.025
const LOGO_OPACITY = 0.2
const LOGO_MARGIN_PCT = 0.15 // fraction of logo width, hugs the corner

let cachedLogo: Electron.NativeImage | null = null
function loadLogo(): Electron.NativeImage | null {
  if (cachedLogo) return cachedLogo
  try {
    const img = nativeImage.createFromPath(LOGO_PATH)
    if (img.isEmpty()) return null
    cachedLogo = img
    return img
  } catch {
    return null
  }
}

/** Tunable watermark constants, shared with the video recorder so video
 *  frames stamp the logo at the same size/opacity/margin as still images. */
export const WATERMARK_SIZE_PCT = LOGO_SIZE_PCT
export const WATERMARK_OPACITY = LOGO_OPACITY
export const WATERMARK_MARGIN_PCT = LOGO_MARGIN_PCT

/** Returns the watermark logo as a PNG data URL, or null if the asset is
 *  missing. The video recorder ships this string to the headless recorder
 *  renderer so it can decode the logo into an HTMLImageElement once and
 *  composite it onto every frame on the canvas pipeline. */
export function getWatermarkLogoDataUrl(): string | null {
  const logo = loadLogo()
  if (!logo) return null
  return logo.toDataURL()
}

/** Composite the logo onto a NativeImage and return the stamped image —
 *  bitmap in, bitmap out, no PNG encode/decode round trip. Returns the input
 *  itself when there's nothing to do (tiny image, missing logo asset, or an
 *  unexpected failure). */
export function applyWatermarkToImage(base: Electron.NativeImage): Electron.NativeImage {
  try {
    if (base.isEmpty()) return base
    const { width: iw, height: ih } = base.getSize()
    if (iw < 32 || ih < 32) return base // too small to bother

    const logo = loadLogo()
    if (!logo) return base

    const targetW = Math.max(12, Math.round(Math.min(iw, ih) * LOGO_SIZE_PCT))
    const logoResized = logo.resize({ width: targetW, quality: 'good' })
    const { width: lw, height: lh } = logoResized.getSize()
    if (lw === 0 || lh === 0) return base

    const margin = Math.max(2, Math.round(targetW * LOGO_MARGIN_PCT))
    const dx = margin
    const dy = ih - lh - margin

    const baseBuf = Buffer.from(base.toBitmap())
    const logoBuf = logoResized.toBitmap()

    // Alpha-blend the logo onto the base buffer. Both buffers are BGRA when
    // `toBitmap` returns them on Windows/macOS — and the source is
    // PREMULTIPLIED (logoBuf[si] is already color × per-pixel alpha). So the
    // source contribution is just `logoBuf[si] * LOGO_OPACITY` (scaling the
    // already-premultiplied color by the global opacity); multiplying by the
    // alpha again would square it and darken antialiased edges toward black.
    // The destination is dimmed by the effective coverage `a`. Clamp to the
    // base bounds so partial off-screen pixels are ignored instead of wrapping
    // into the next row.
    for (let y = 0; y < lh; y++) {
      const dyRow = dy + y
      if (dyRow < 0 || dyRow >= ih) continue
      for (let x = 0; x < lw; x++) {
        const dxCol = dx + x
        if (dxCol < 0 || dxCol >= iw) continue
        const si = (y * lw + x) * 4
        const a = (logoBuf[si + 3] / 255) * LOGO_OPACITY // effective coverage
        if (a <= 0) continue
        const di = (dyRow * iw + dxCol) * 4
        const oneMinus = 1 - a
        baseBuf[di]     = Math.round(logoBuf[si]     * LOGO_OPACITY + baseBuf[di]     * oneMinus)
        baseBuf[di + 1] = Math.round(logoBuf[si + 1] * LOGO_OPACITY + baseBuf[di + 1] * oneMinus)
        baseBuf[di + 2] = Math.round(logoBuf[si + 2] * LOGO_OPACITY + baseBuf[di + 2] * oneMinus)
        // base alpha left as-is — composite into an opaque image
      }
    }

    return nativeImage.createFromBuffer(baseBuf, { width: iw, height: ih })
  } catch (err) {
    console.error('[watermark] failed, returning original', err)
    return base
  }
}
