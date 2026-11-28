import { app, nativeImage } from 'electron'
import { join } from 'path'
import {
  WATERMARK_PT as MARK_PT, WATERMARK_MARGIN_PT as MARK_MARGIN_PT, WATERMARK_OPACITY as MARK_OPACITY,
  WATERMARK_MAX_W as MARK_MAX_W, WATERMARK_MAX_H as MARK_MAX_H, WATERMARK_MIN_PX as MARK_MIN_PX, WATERMARK_INK_THRESHOLD,
} from '../shared/watermark'

/**
 * Stamp the Lumia watermark onto a captured image in the bottom-left
 * corner: the mark and the name "Lumia" (2026-11-27; the logo alone until
 * then, which no one could look up), very faint.
 *
 * Config:
 *   - A fixed size on screen (Jasper, 2026-11-27: scaled with the image it
 *     was unreadable on small ones): 12pt tall, so 24px from a 2x display
 *     (picked from out/previews/watermark-sizes.html),
 *     6pt from the corner. On an image too small for it, shrunk to half the
 *     image's width at most; under 10px tall it's left off (unreadable).
 *   - Drawn at 10% opacity (Jasper, 2026-11-27: "A at 10%" in
 *     out/previews/watermark.html), multiplied by the mark's own per-pixel
 *     alpha so antialiased edges stay soft.
 *   - The name's ink follows what's under it: white on a dark corner,
 *     near-black on a light one (two prepared images, resources/watermark/,
 *     made by `pnpm watermark`). The logo keeps its colours.
 *
 * Implementation: compose directly on the BGRA bitmap buffer returned
 * by `nativeImage.toBitmap()`. No canvas lib, no renderer hop — keeps
 * this on the main process capture path where it belongs.
 */
// Dev: resources/ lives next to out/ on disk. Prod: shipped via
// electron-builder's extraResources at process.resourcesPath/watermark.
const MARK_DIR = app.isPackaged
  ? join(process.resourcesPath, 'watermark')
  : join(__dirname, '../../resources/watermark')
// Size, margin, opacity and the ink threshold: shared/watermark.ts (the
// recorder stamps its frames with the same numbers). Images are stamped
// again since 2026-11-27 (Jasper; off 2026-11-26).

export type Ink = 'light' | 'dark'
const cachedMarks: Partial<Record<Ink, Electron.NativeImage>> = {}
function loadMark(ink: Ink): Electron.NativeImage | null {
  if (cachedMarks[ink]) return cachedMarks[ink]!
  try {
    const img = nativeImage.createFromPath(join(MARK_DIR, `watermark-${ink}.png`))
    if (img.isEmpty()) return null
    cachedMarks[ink] = img
    return img
  } catch {
    return null
  }
}

/** Both inks of the mark as PNG data URLs, or null if the assets are
 *  missing. The video recorder decodes them once and picks one per frame
 *  by the brightness under the mark. */
export function getWatermarkMarks(): { light: string; dark: string } | null {
  const light = loadMark('light'), dark = loadMark('dark')
  if (!light || !dark) return null
  return { light: light.toDataURL(), dark: dark.toDataURL() }
}

/** Composite the mark onto a NativeImage and return the stamped image —
 *  bitmap in, bitmap out, no PNG encode/decode round trip. Returns the input
 *  itself when there's nothing to do (tiny image, missing asset, or an
 *  unexpected failure). */
export function applyWatermarkToImage(
  base: Electron.NativeImage,
  /** Image pixels per point: the scale factor of the display it came from. */
  scale = 1,
): Electron.NativeImage {
  try {
    if (base.isEmpty()) return base
    const { width: iw, height: ih } = base.getSize()
    if (iw < 32 || ih < 32) return base // too small to bother
    const probe = loadMark('light')
    if (!probe) return base
    const ps = probe.getSize()
    const aspect = ps.width / ps.height
    let markH = Math.round(MARK_PT * scale)
    if (markH * aspect > iw * MARK_MAX_W) markH = Math.floor(iw * MARK_MAX_W / aspect)
    if (markH > ih * MARK_MAX_H) markH = Math.floor(ih * MARK_MAX_H)
    if (markH < MARK_MIN_PX) return base
    const markW = Math.round(markH * aspect)
    const margin = Math.max(2, Math.round(MARK_MARGIN_PT * scale))
    // toBitmap() already hands back a copy of the pixels: no second copy.
    const baseBuf = base.toBitmap()

    // The ink: the average brightness where the mark goes.
    const dx = margin
    const dy = ih - markH - margin
    let sum = 0, n = 0
    for (let y = Math.max(0, dy); y < Math.min(ih, dy + markH); y += 2) {
      for (let x = Math.max(0, dx); x < Math.min(iw, dx + markW); x += 2) {
        const i = (y * iw + x) * 4
        sum += 0.0722 * baseBuf[i] + 0.7152 * baseBuf[i + 1] + 0.2126 * baseBuf[i + 2] // BGRA
        n++
      }
    }
    const ink: Ink = n && sum / n >= WATERMARK_INK_THRESHOLD ? 'dark' : 'light'
    const mark = loadMark(ink)
    if (!mark) return base
    const markResized = mark.resize({ height: markH, quality: 'good' })
    const { width: lw, height: lh } = markResized.getSize()
    if (lw === 0 || lh === 0) return base
    const markBuf = markResized.toBitmap()

    // Alpha-blend the mark onto the base buffer. Both buffers are BGRA when
    // `toBitmap` returns them on Windows/macOS — and the source is
    // PREMULTIPLIED (markBuf[si] is already color × per-pixel alpha). So the
    // source contribution is just `markBuf[si] * MARK_OPACITY` (scaling the
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
        const a = (markBuf[si + 3] / 255) * MARK_OPACITY // effective coverage
        if (a <= 0) continue
        const di = (dyRow * iw + dxCol) * 4
        const oneMinus = 1 - a
        baseBuf[di]     = Math.round(markBuf[si]     * MARK_OPACITY + baseBuf[di]     * oneMinus)
        baseBuf[di + 1] = Math.round(markBuf[si + 1] * MARK_OPACITY + baseBuf[di + 1] * oneMinus)
        baseBuf[di + 2] = Math.round(markBuf[si + 2] * MARK_OPACITY + baseBuf[di + 2] * oneMinus)
        // base alpha left as-is — composite into an opaque image
      }
    }
    return nativeImage.createFromBuffer(baseBuf, { width: iw, height: ih })
  } catch (err) {
    console.error('[watermark] failed, returning original', err)
    return base
  }
}
