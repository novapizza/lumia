
/**
 * Converts resources/icons/png/icon.png → resources/icons/win/icon.ico + resources/icons/mac/icon.icns
 *
 * Run manually:   pnpm icons
 *
 * Packages used:
 *   png2icons        – Pure-JS PNG → ICO (Windows) and ICNS (macOS) converter
 *
 * macOS sizing (Apple Human Interface Guidelines):
 *   - App icon: 1024×1024 canvas with artwork inside an 824×824 design grid
 *     (~80%). Full-bleed icons appear visually larger than other apps in the
 *     Dock/Launchpad because macOS 11+ relies on the grid for the squircle mask.
 *   - Menu bar (tray): 22pt total with artwork at ~16pt — anything larger
 *     dominates the menu bar height.
 *
 * Windows uses full-bleed conventions — keep the original buffer for ICO/tray.
 */

const png2icons = require('png2icons')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const UPNG = require('png2icons/lib/UPNG')
const Resize = require('png2icons/lib/resize3')

const ROOT = join(__dirname, '..')
const PNG_SRC = join(ROOT, 'resources/icons/png/icon.png')

const ICO_OUT = join(ROOT, 'resources/icons/win/icon.ico')
const ICNS_OUT = join(ROOT, 'resources/icons/mac/icon.icns')

// Apple HIG design-grid ratio (824/1024). Drives both the icns padding and the
// macOS tray padding so the brand artwork keeps its proportions across surfaces.
const APPLE_GRID_RATIO = 824 / 1024

function decodeRgba(buffer) {
  const png = UPNG.decode(buffer)
  const rgba = new Uint8Array(UPNG.toRGBA8(png)[0])
  return { rgba, width: png.width, height: png.height }
}

function resizeRgba(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4)
  // png2icons' hermiteInterpolation silently returns an all-zero buffer at
  // certain target sizes (e.g. 1024→824 produces black). bilinear works for
  // every size we use and the quality loss at icon scales is invisible.
  Resize.bilinearInterpolation(
    { data: src, width: srcW, height: srcH },
    { data: dst, width: dstW, height: dstH }
  )
  return dst
}

function encodePng(rgba, width, height) {
  // UPNG.encode wants ArrayBuffer[], not Uint8Array[]. Passing the view
  // produces a malformed PNG that png2icons silently downgrades to a single
  // size — the icns came out at 2 KB instead of 400 KB.
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0, [], true))
}

/**
 * Resize `inputBuffer` to `contentSize × contentSize` and composite onto a
 * transparent `canvasSize × canvasSize` canvas, centered. Returns a PNG buffer.
 */
function padPNG(inputBuffer, canvasSize, contentSize) {
  const { rgba, width, height } = decodeRgba(inputBuffer)
  const scaled = resizeRgba(rgba, width, height, contentSize, contentSize)

  const canvas = new Uint8Array(canvasSize * canvasSize * 4) // zero = transparent
  const offset = Math.floor((canvasSize - contentSize) / 2)
  for (let y = 0; y < contentSize; y++) {
    for (let x = 0; x < contentSize; x++) {
      const si = (y * contentSize + x) * 4
      const di = ((y + offset) * canvasSize + (x + offset)) * 4
      canvas[di]     = scaled[si]
      canvas[di + 1] = scaled[si + 1]
      canvas[di + 2] = scaled[si + 2]
      canvas[di + 3] = scaled[si + 3]
    }
  }
  return encodePng(canvas, canvasSize, canvasSize)
}

function resizePNG(inputBuffer, width, height) {
  const { rgba, width: sw, height: sh } = decodeRgba(inputBuffer)
  const scaled = resizeRgba(rgba, sw, sh, width, height)
  return encodePng(scaled, width, height)
}

// ── Read PNG source ──────────────────────────────────────────────────────────
console.log('Generating icons from', PNG_SRC)
const pngBuffer = readFileSync(PNG_SRC)
console.log('  ✓ PNG source')

// ── PNG → ICO (Windows) ───────────────────────────────────────────────────────
// Full-bleed is the Windows convention — no padding.
// Embeds sizes: 16, 24, 32, 48, 64, 128, 256
const ico = png2icons.createICO(pngBuffer, png2icons.HERMITE, 0, false, true)
if (!ico) throw new Error('ICO generation failed')
writeFileSync(ICO_OUT, ico)
console.log('  ✓ win/icon.ico (full-bleed)')

// ── PNG → ICNS (macOS) ────────────────────────────────────────────────────────
// Pad to Apple's 824×824 design grid inside a 1024×1024 canvas before encoding,
// so every embedded size inherits the right padding. Embeds sizes: 16, 32, 64,
// 128, 256, 512, 1024.
const macSize = 1024
const macContent = Math.round(macSize * APPLE_GRID_RATIO) // 824
const macPadded = padPNG(pngBuffer, macSize, macContent)
const icns = png2icons.createICNS(macPadded, png2icons.HERMITE, 0)
if (!icns) throw new Error('ICNS generation failed')
writeFileSync(ICNS_OUT, icns)
console.log(`  ✓ mac/icon.icns (artwork ${macContent}×${macContent} in ${macSize}×${macSize})`)

// ── Tray icons ────────────────────────────────────────────────────────────────
// Windows tray accepts full-bleed; macOS menu bar wants the artwork around 16pt
// within the 22pt slot, otherwise it dominates the menu bar height. The mac
// tray PNG is also rendered as a template image at runtime (tray.ts), so the
// alpha channel is what actually drives the on-screen silhouette.
//
// macOS ships two files: tray-icon.png (22×22, the 1x/22pt base) and
// tray-icon@2x.png (44×44). nativeImage.createFromPath picks the @2x variant
// up automatically as the Retina representation — without it, every modern
// Mac (all 2x) upscales the 22px bitmap and the menu bar icon looks broken.
const trayWinDir = join(ROOT, 'resources/tray/win')
const trayMacDir = join(ROOT, 'resources/tray/mac')

// 32×32 native (not upscaled at runtime) — Windows scales per tray DPI itself.
const trayWin = resizePNG(pngBuffer, 32, 32)
writeFileSync(join(trayWinDir, 'tray-icon.png'), trayWin)
console.log('  ✓ tray/win/tray-icon.png (full-bleed 32×32)')

const trayMac = padPNG(pngBuffer, 22, 16)
writeFileSync(join(trayMacDir, 'tray-icon.png'), trayMac)
console.log('  ✓ tray/mac/tray-icon.png (artwork 16×16 in 22×22)')

const trayMac2x = padPNG(pngBuffer, 44, 32)
writeFileSync(join(trayMacDir, 'tray-icon@2x.png'), trayMac2x)
console.log('  ✓ tray/mac/tray-icon@2x.png (artwork 32×32 in 44×44)')

console.log('Icons ready.')
