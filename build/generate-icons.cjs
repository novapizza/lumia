
/**
 * Converts resources/icons/png/icon.png → resources/icons/win/icon.ico and
 * resources/icons/png/icon-mac.png → resources/icons/mac/icon.icns.
 * Both PNGs come from scripts/make-app-icons.py (the logo, src/assets/logo.svg).
 *
 * Run manually:   pnpm icons   (runs make-app-icons.py first)
 *
 * Packages used:
 *   png2icons        – Pure-JS PNG → ICO (Windows) and ICNS (macOS) converter
 *
 * macOS: the tile sits inside Apple's 824×824 design grid on the 1024 canvas
 * (make-app-icons.py draws it that way). Windows: the bare mark, full-bleed.
 */

const png2icons = require('png2icons')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const PNG_SRC = join(ROOT, 'resources/icons/png/icon.png')
const MAC_SRC = join(ROOT, 'resources/icons/png/icon-mac.png')

const ICO_OUT = join(ROOT, 'resources/icons/win/icon.ico')
const ICNS_OUT = join(ROOT, 'resources/icons/mac/icon.icns')

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
// icon-mac.png is already the tile inside Apple's 824 grid on a 1024 canvas
// (scripts/make-app-icons.py), so no padding here. Embeds sizes: 16, 32, 64,
// 128, 256, 512, 1024.
const icns = png2icons.createICNS(readFileSync(MAC_SRC), png2icons.HERMITE, 0)
if (!icns) throw new Error('ICNS generation failed')
writeFileSync(ICNS_OUT, icns)
console.log('  ✓ mac/icon.icns (tile in the 824 grid)')

// Tray icons are not made here: the Windows one comes from
// scripts/make-app-icons.py (wider gaps at 32px), the macOS menu-bar template
// image (resources/tray/mac) is drawn separately.

console.log('Icons ready.')
