import { ipcMain, app, desktopCapturer, screen, BrowserWindow, nativeImage } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import * as native from './native-input'
import { getSettings } from './settings'
import type { ScrollCaptureMethod } from './settings'
import { isExtensionConnected, startExtensionCapture, cancelExtensionCapture } from './extension-bridge'
import { getDisplayConversionIcc } from './display-icc'
import { convertBgraToSrgbInPlace } from './icc-to-srgb'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFT = require('fft.js')

/**
 * Compute side margin to exclude from overlap comparison (avoids scrollbar artifacts).
 * ShareX-inspired: 5% of width, minimum 50px, disabled if > 1/3 of width.
 */
function computeSideMargin(width: number): number {
  const margin = Math.max(50, Math.floor(width * 0.05))
  return margin < Math.floor(width / 3) ? margin : 0
}

// ── Display source matching ────────────────────────────────────────────────

/**
 * Find the desktopCapturer source that corresponds to a given display,
 * with index-based fallback for edge cases (same logic as capture.ts).
 */
function findSourceForDisplay(
  sources: Electron.DesktopCapturerSource[],
  allDisplays: Electron.Display[],
  displayId: number
): Electron.DesktopCapturerSource | null {
  if (sources.length === 0) return null
  if (sources.length === 1) return sources[0]
  // Primary: match by display_id (string) to Display.id (number)
  const byId = sources.find(s => s.display_id === String(displayId))
  if (byId) return byId
  // Fallback: index-based matching (assumes same ordering — not always true)
  const idx = allDisplays.findIndex(d => d.id === displayId)
  if (idx >= 0 && idx < sources.length) return sources[idx]
  return sources[0]
}

// ── Scroll simulation ──────────────────────────────────────────────────────

// Detect macOS natural scrolling once at startup (cached)
let _naturalScrolling: boolean | null = null
function isNaturalScrolling(): boolean {
  if (_naturalScrolling !== null) return _naturalScrolling
  try {
    const val = execFileSync('defaults', ['read', 'NSGlobalDomain', 'com.apple.swipescrolldirection'])
      .toString().trim()
    _naturalScrolling = val !== '0' // default is true (natural scrolling ON)
  } catch {
    _naturalScrolling = true
  }
  return _naturalScrolling
}

// Resolve path to compiled Swift scroll helper (macOS only)
function getScrollHelperPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'scroll-helper')
  }
  // Dev mode: binary is next to the .swift source
  return join(__dirname, '../../electron/helpers/scroll-helper')
}

/** Scroll method — user-selectable via options */
type ScrollMethod = 'mouseWheel' | 'vscroll' | 'downArrow' | 'pageDown'

/**
 * Send a scroll event at (cx, cy).
 * Windows: uses koffi native bindings (direct user32.dll calls, ~0ms overhead).
 *          Falls back to PowerShell if koffi is unavailable.
 * macOS: uses a compiled Swift helper (CGEventCreateScrollWheelEvent2).
 *
 * @param pixelDelta — custom scroll amount in pixels (macOS) or wheel units (Windows).
 *   Positive = scroll content DOWN.
 * @param method — 'mouseWheel' (default), 'vscroll', 'downArrow', or 'pageDown'
 */
function scrollAtPosition(cx: number, cy: number, pixelDelta?: number, method: ScrollMethod = 'mouseWheel'): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      const helper = getScrollHelperPath()
      if (!existsSync(helper)) {
        console.error('[scroll-capture] scroll-helper binary not found at', helper)
        resolve()
        return
      }
      const baseDelta = pixelDelta ?? 300
      const pxDelta = isNaturalScrolling() ? -baseDelta : baseDelta
      execFile(helper, [String(Math.round(cx)), String(Math.round(cy)), String(pxDelta)], (err, _stdout, stderr) => {
        if (err) console.warn('[scroll-capture] scroll-helper error:', err.message)
        if (stderr) console.warn('[scroll-capture] scroll-helper stderr:', stderr)
        resolve()
      })
    })
  }

  // ── Windows: native calls via koffi (preferred) ──
  if (native.isNativeAvailable()) {
    switch (method) {
      case 'vscroll': {
        const lines = pixelDelta != null ? Math.max(1, Math.round(pixelDelta / 30)) : 10
        native.scrollVScroll(cx, cy, lines)
        break
      }
      case 'downArrow': {
        const count = pixelDelta != null ? Math.max(1, Math.round(pixelDelta / 40)) : 8
        native.scrollDownArrow(count)
        break
      }
      case 'pageDown': {
        native.scrollPageDown()
        break
      }
      default: { // mouseWheel
        const wheelDelta = pixelDelta != null ? -Math.round(pixelDelta / 300 * 120) : -120
        native.scrollMouseWheel(cx, cy, wheelDelta)
        break
      }
    }
    return Promise.resolve()
  }

  // ── Windows fallback: PowerShell ──
  return new Promise((resolve) => {
    const wheelDelta = pixelDelta != null ? -Math.round(pixelDelta / 300 * 120) : -120
    const ps = `
Add-Type @"
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
}
"@
[Win32]::SetCursorPos(${Math.round(cx)}, ${Math.round(cy)})
Start-Sleep -Milliseconds 50
[Win32]::mouse_event(0x800, 0, 0, ${wheelDelta}, 0)
`
    execFile('powershell', ['-command', ps], () => resolve())
  })
}

// ── Scroll to top ───────────────────────────────────────────────────────

/**
 * Send Home/Ctrl+Home to scroll content to the top.
 * Windows: native koffi calls (preferred) or PowerShell fallback.
 * macOS: AppleScript Cmd+Up.
 */
function scrollToTop(cx: number, cy: number): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      const script = `
tell application "System Events"
  key code 126 using command down
end tell`
      execFile('osascript', ['-e', script], () => resolve())
    })
  }

  // Windows: native
  if (native.isNativeAvailable()) {
    native.scrollToTopNative(cx, cy)
    return Promise.resolve()
  }

  // Windows: PowerShell fallback
  return new Promise((resolve) => {
    const ps = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{
  [StructLayout(LayoutKind.Sequential)] public struct P{public int x;public int y;}
  [DllImport("user32.dll")] public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  public static void T(int x,int y){
    keybd_event(0x11,0,0,UIntPtr.Zero);keybd_event(0x24,0,0,UIntPtr.Zero);
    keybd_event(0x24,0,2,UIntPtr.Zero);keybd_event(0x11,0,2,UIntPtr.Zero);
    P p;p.x=x;p.y=y;IntPtr h=WindowFromPoint(p);
    if(h!=IntPtr.Zero)SendMessage(h,0x0115,(IntPtr)6,IntPtr.Zero);
  }
}
"@
[W]::T(${Math.round(cx)},${Math.round(cy)})
`
    execFile('powershell', ['-command', ps], () => resolve())
  })
}

// ── Fixed header/footer detection ────────────────────────────────────────

/**
 * FNV-1a hash for a single row of RGBA bitmap data.
 * Fast, non-cryptographic hash suitable for row comparison.
 */
function fnv1aRowHash(bitmap: Buffer, rowIndex: number, width: number): number {
  const bytesPerRow = width * 4
  const start = rowIndex * bytesPerRow
  const end = start + bytesPerRow
  let hash = 0x811c9dc5 // FNV offset basis (32-bit)
  for (let i = start; i < end; i++) {
    hash ^= bitmap[i]
    hash = (hash * 0x01000193) >>> 0 // FNV prime, keep as uint32
  }
  return hash
}

/**
 * Compute per-channel mean-absolute-error between two rows.
 * Returns a similarity score in [0, 1] where 1 = identical.
 */
function rowSimilarity(
  bitmapA: Buffer, rowA: number,
  bitmapB: Buffer, rowB: number,
  width: number
): number {
  const bytesPerRow = width * 4
  const startA = rowA * bytesPerRow
  const startB = rowB * bytesPerRow
  let totalDiff = 0
  // Sample every 4th pixel for performance
  const colStep = Math.max(1, Math.floor(width / 64))
  let samples = 0
  for (let col = 0; col < width; col += colStep) {
    const offA = startA + col * 4
    const offB = startB + col * 4
    totalDiff += Math.abs(bitmapA[offA] - bitmapB[offB])
    totalDiff += Math.abs(bitmapA[offA + 1] - bitmapB[offB + 1])
    totalDiff += Math.abs(bitmapA[offA + 2] - bitmapB[offB + 2])
    samples++
  }
  if (samples === 0) return 0
  // max possible diff per sample = 255 * 3 = 765
  const avgDiff = totalDiff / samples
  return 1 - avgDiff / 765
}

/**
 * Detect fixed (sticky) header/footer regions by comparing row hashes across frames.
 * Rows that are pixel-identical across first, second, and last frames are considered fixed.
 *
 * Two-pass approach:
 * 1. Exact match: FNV-1a row hashes identical across all reference frames
 * 2. Tolerance fallback: similarity > 0.95 for semi-transparent/glassmorphism headers
 *
 * Returns pixel heights of detected fixed regions (in bitmap coordinates, already scaled).
 */
function detectFixedRegions(
  frames: Electron.NativeImage[],
  minRegionHeight: number = 10
): { topFixed: number; bottomFixed: number } {
  if (frames.length < 2) return { topFixed: 0, bottomFixed: 0 }

  // Use first, second, and last frames as reference
  const refIndices = [0, 1]
  if (frames.length > 2) refIndices.push(frames.length - 1)

  const bitmaps = refIndices.map(i => frames[i].toBitmap())
  const sizes = refIndices.map(i => frames[i].getSize())

  // All frames must have the same dimensions
  const width = sizes[0].width
  const height = sizes[0].height
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i].width !== width || sizes[i].height !== height) {
      return { topFixed: 0, bottomFixed: 0 }
    }
  }

  // --- Pass 1: exact hash matching ---
  // Precompute row hashes for each reference bitmap
  const hashes: number[][] = bitmaps.map(bmp => {
    const h: number[] = new Array(height)
    for (let row = 0; row < height; row++) {
      h[row] = fnv1aRowHash(bmp, row, width)
    }
    return h
  })

  // Scan from top: consecutive rows with identical hashes across all reference frames
  let topFixed = 0
  for (let row = 0; row < height; row++) {
    const baseHash = hashes[0][row]
    let allMatch = true
    for (let b = 1; b < hashes.length; b++) {
      if (hashes[b][row] !== baseHash) { allMatch = false; break }
    }
    if (allMatch) topFixed = row + 1
    else break
  }

  // Scan from bottom
  let bottomFixed = 0
  for (let row = height - 1; row >= topFixed; row--) {
    const baseHash = hashes[0][row]
    let allMatch = true
    for (let b = 1; b < hashes.length; b++) {
      if (hashes[b][row] !== baseHash) { allMatch = false; break }
    }
    if (allMatch) bottomFixed = height - row
    else break
  }

  // --- Pass 2: tolerance fallback for semi-transparent/glassmorphism headers ---
  // Only extend regions if the exact pass found less than minRegionHeight
  if (topFixed < minRegionHeight) {
    let tolerantTop = 0
    for (let row = 0; row < height; row++) {
      let allSimilar = true
      for (let b = 1; b < bitmaps.length; b++) {
        if (rowSimilarity(bitmaps[0], row, bitmaps[b], row, width) < 0.95) {
          allSimilar = false
          break
        }
      }
      if (allSimilar) tolerantTop = row + 1
      else break
    }
    topFixed = Math.max(topFixed, tolerantTop)
  }

  if (bottomFixed < minRegionHeight) {
    let tolerantBottom = 0
    for (let row = height - 1; row >= topFixed; row--) {
      let allSimilar = true
      for (let b = 1; b < bitmaps.length; b++) {
        if (rowSimilarity(bitmaps[0], row, bitmaps[b], row, width) < 0.95) {
          allSimilar = false
          break
        }
      }
      if (allSimilar) tolerantBottom = height - row
      else break
    }
    bottomFixed = Math.max(bottomFixed, tolerantBottom)
  }

  // Enforce minimum region height to avoid false positives from border lines
  if (topFixed < minRegionHeight) topFixed = 0
  if (bottomFixed < minRegionHeight) bottomFixed = 0

  return { topFixed, bottomFixed }
}

// ── Robust row-voting overlap score ──────────────────────────────────────

/**
 * Row-level voting overlap score: instead of a single global pixel mismatch
 * ratio, compute per-row match quality and return the fraction of rows that
 * are "good" matches. This is robust to animated / video backgrounds where
 * a minority of rows change between frames while the majority stays identical.
 *
 * Returns a score in [0, 1] where 1 = all rows match well.
 */
function robustOverlapScore(
  bitmapA: Buffer, bitmapB: Buffer,
  width: number, height: number,
  step: number,
  topSkip: number = 0,
  bottomSkip: number = 0
): number {
  // A non-positive step means the two frames overlap fully (or the geometry is
  // degenerate) — there is no real scroll to score, so return the worst score.
  if (step <= 0) return 0
  const bytesPerRow = width * 4
  const overlapRows = height - step
  if (overlapRows <= 0) return 0

  const rowStart = topSkip
  const rowEnd = overlapRows - bottomSkip
  if (rowEnd <= rowStart) return 0

  const sideMargin = computeSideMargin(width)
  const colStart = sideMargin
  const colEnd = width - sideMargin
  const colStep = Math.max(1, Math.floor(width / 16))

  let goodRows = 0
  let totalRows = 0

  for (let row = rowStart; row < rowEnd; row += 2) {
    const rowAStart = (row + step) * bytesPerRow
    const rowBStart = row * bytesPerRow
    let rowDiff = 0
    let rowSamples = 0

    for (let col = colStart; col < colEnd; col += colStep) {
      const offA = rowAStart + col * 4
      const offB = rowBStart + col * 4
      rowSamples++
      if (
        Math.abs(bitmapA[offA] - bitmapB[offB]) > 8 ||
        Math.abs(bitmapA[offA + 1] - bitmapB[offB + 1]) > 8 ||
        Math.abs(bitmapA[offA + 2] - bitmapB[offB + 2]) > 8
      ) {
        rowDiff++
      }
    }

    totalRows++
    // A row is "good" if fewer than 20% of sampled pixels differ
    if (rowSamples > 0 && rowDiff / rowSamples < 0.2) {
      goodRows++
    }
  }

  return totalRows === 0 ? 0 : goodRows / totalRows
}

// ── Overlap detection ──────────────────────────────────────────────────────

/**
 * Score how well the bottom `overlapRows` rows of bitmapA
 * match the top `overlapRows` rows of bitmapB.
 * Returns a mismatch ratio (0 = perfect match, 1 = completely different).
 *
 * topSkip / bottomSkip: rows to exclude from comparison (fixed header/footer regions)
 * that would otherwise create false match signals.
 */
function overlapMismatch(
  bitmapA: Buffer, bitmapB: Buffer,
  width: number, height: number,
  step: number,
  topSkip: number = 0,
  bottomSkip: number = 0
): number {
  // A non-positive step means the frames overlap fully (or the geometry is
  // degenerate) — return the worst mismatch so callers never accept it.
  if (step <= 0) return 1
  const bytesPerRow = width * 4
  const overlapRows = height - step
  if (overlapRows <= 0) return 1

  // Determine the effective row range to compare (skip fixed regions)
  const rowStart = topSkip
  const rowEnd = overlapRows - bottomSkip
  if (rowEnd <= rowStart) return 1

  let diffCount = 0
  let sampleCount = 0
  // Exclude side margins (scrollbar area) from comparison
  const sideMargin = computeSideMargin(width)
  const colStart = sideMargin
  const colEnd = width - sideMargin
  // Sample every 2nd row, every width/16 pixel — denser than before for accuracy
  const colStep = Math.max(1, Math.floor(width / 16))
  for (let row = rowStart; row < rowEnd; row += 2) {
    const rowAStart = (row + step) * bytesPerRow
    const rowBStart = row * bytesPerRow
    for (let col = colStart; col < colEnd; col += colStep) {
      const offA = rowAStart + col * 4
      const offB = rowBStart + col * 4
      sampleCount++
      if (
        Math.abs(bitmapA[offA] - bitmapB[offB]) > 8 ||
        Math.abs(bitmapA[offA + 1] - bitmapB[offB + 1]) > 8 ||
        Math.abs(bitmapA[offA + 2] - bitmapB[offB + 2]) > 8
      ) {
        diffCount++
      }
    }
  }
  return sampleCount === 0 ? 1 : diffCount / sampleCount
}

/**
 * Detect how many pixels scrolled between two frames using a two-pass SAD approach:
 * 1. Coarse pass: scan every 4th pixel to find candidate offsets
 * 2. Fine pass: refine the best candidate with single-pixel accuracy
 *
 * topSkip / bottomSkip: rows to exclude from overlap comparison (fixed header/footer).
 * Returns the best matching row offset, or `defaultStep` if no good match found.
 */
function detectScrollStepSAD(
  frameA: Electron.NativeImage,
  frameB: Electron.NativeImage,
  defaultStep: number,
  topSkip: number = 0,
  bottomSkip: number = 0
): number {
  try {
    const bitmapA = frameA.toBitmap()
    const bitmapB = frameB.toBitmap()
    const sizeA = frameA.getSize()
    const sizeB = frameB.getSize()

    if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return defaultStep

    const { width, height } = sizeA
    const minStep = 5
    // Cap maxStep to ensure at least 15% overlap — prevents false matches on uniform content
    const minOverlap = Math.max(Math.floor(height * 0.15), 50)
    const maxStep = Math.min(Math.floor(defaultStep * 2.5), height - minOverlap)

    // Pass 1: coarse scan (every 4th step)
    let bestStep = defaultStep
    let bestScore = 1
    for (let step = minStep; step <= maxStep; step += 4) {
      const score = overlapMismatch(bitmapA, bitmapB, width, height, step, topSkip, bottomSkip)
      if (score < bestScore) {
        bestScore = score
        bestStep = step
      }
    }

    // Pass 2: fine-tune around the best coarse result (±6 pixels)
    const fineMin = Math.max(minStep, bestStep - 6)
    const fineMax = Math.min(maxStep, bestStep + 6)
    for (let step = fineMin; step <= fineMax; step++) {
      const score = overlapMismatch(bitmapA, bitmapB, width, height, step, topSkip, bottomSkip)
      if (score < bestScore) {
        bestScore = score
        bestStep = step
      }
    }

    // Strict: accept if mismatch < 2%
    if (bestScore < 0.02) return bestStep

    // Robust fallback: strict threshold failed (common on pages with animated
    // backgrounds / video heroes). Use row-level voting — if 60%+ of rows in
    // the overlap zone are good matches, accept the step.
    // Require minimum overlap to prevent false matches on uniform/white content.
    const overlapAtBest = height - bestStep
    const robust = robustOverlapScore(bitmapA, bitmapB, width, height, bestStep, topSkip, bottomSkip)
    if (robust > 0.6 && overlapAtBest >= minOverlap) {
      console.log(`[scroll-capture] SAD: strict mismatch=${(bestScore * 100).toFixed(1)}% but robust=${(robust * 100).toFixed(0)}% overlap=${overlapAtBest} — accepting step=${bestStep}`)
      return bestStep
    }
  } catch {
    // bitmap comparison failed — use default
  }

  return defaultStep
}

// ── FFT-based phase correlation ─────────────────────────────────────────────

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/**
 * Detect scroll step using FFT-based 1D phase correlation along sampled columns.
 * For vertical-only scroll, we compute cross-correlation of column vectors between
 * frames A and B, then find the peak which gives the vertical shift.
 *
 * Falls back to `defaultStep` if the result seems unreliable.
 */
function detectScrollStepFFT(
  frameA: Electron.NativeImage,
  frameB: Electron.NativeImage,
  defaultStep: number,
  topSkip: number = 0,
  bottomSkip: number = 0
): number {
  const bitmapA = frameA.toBitmap()
  const bitmapB = frameB.toBitmap()
  const { width, height } = frameA.getSize()

  // Content region (skip fixed header/footer)
  const startRow = topSkip
  const endRow = height - bottomSkip
  const contentH = endRow - startRow
  if (contentH < 32) return defaultStep

  // Next power of 2 for FFT
  const fftSize = nextPow2(contentH)
  const fft = new FFT(fftSize)

  // Exclude side margins from column sampling (avoid scrollbar artifacts)
  const sideMargin = computeSideMargin(width)
  const colStart = sideMargin
  const colEnd = width - sideMargin
  // Sample columns (every width/32 columns, at least 1)
  const colStep = Math.max(1, Math.floor(width / 32))
  const bytesPerRow = width * 4

  // Accumulate cross-correlation across sampled columns
  const corrAccum = new Float64Array(fftSize)
  let numCols = 0

  for (let col = colStart; col < colEnd; col += colStep) {
    // Extract grayscale column vectors (zero-padded to fftSize)
    const colA = new Float64Array(fftSize)
    const colB = new Float64Array(fftSize)

    for (let row = startRow; row < endRow; row++) {
      const off = row * bytesPerRow + col * 4
      const grayA = (bitmapA[off] + bitmapA[off + 1] + bitmapA[off + 2]) / 3
      const grayB = (bitmapB[off] + bitmapB[off + 1] + bitmapB[off + 2]) / 3
      colA[row - startRow] = grayA
      colB[row - startRow] = grayB
    }

    // FFT both columns
    const fftA = fft.createComplexArray()
    const fftB = fft.createComplexArray()
    fft.realTransform(fftA, colA)
    fft.realTransform(fftB, colB)
    fft.completeSpectrum(fftA)
    fft.completeSpectrum(fftB)

    // Cross-power spectrum: conj(A) * B
    const cross = fft.createComplexArray()
    for (let i = 0; i < fftSize; i++) {
      const reA = fftA[2 * i], imA = fftA[2 * i + 1]
      const reB = fftB[2 * i], imB = fftB[2 * i + 1]
      cross[2 * i] = reA * reB + imA * imB       // real part of conj(A)*B
      cross[2 * i + 1] = reA * imB - imA * reB   // imag part of conj(A)*B
    }

    // IFFT to get correlation
    const corr = fft.createComplexArray()
    fft.inverseTransform(corr, cross)

    for (let i = 0; i < fftSize; i++) {
      corrAccum[i] += corr[2 * i] // accumulate real parts
    }
    numCols++
  }

  if (numCols === 0) return defaultStep

  // Find peak in valid scroll range
  const minStep = 5
  const maxStep = Math.min(Math.floor(defaultStep * 2.5), contentH - 1)

  let bestIdx = defaultStep
  let bestVal = -Infinity
  for (let i = minStep; i <= maxStep; i++) {
    if (corrAccum[i] > bestVal) {
      bestVal = corrAccum[i]
      bestIdx = i
    }
  }

  // Find the runner-up peak OUTSIDE a small neighborhood of the main peak.
  // Without this exclusion the second-best is almost always the peak's
  // immediate neighbor, so bestVal/secondBestVal ≈ 1 and the reliability check
  // below always fails — making the FFT path effectively dead.
  const EXCLUDE = 3
  let secondBestVal = -Infinity
  for (let i = minStep; i <= maxStep; i++) {
    if (Math.abs(i - bestIdx) <= EXCLUDE) continue
    if (corrAccum[i] > secondBestVal) {
      secondBestVal = corrAccum[i]
    }
  }

  // Reliability check: peak should be significantly above second-best
  // If the ratio is too low, the FFT result is unreliable
  if (secondBestVal > 0 && bestVal / secondBestVal < 1.3) {
    return -1 // signal unreliable — caller should fall back to SAD
  }

  // Parabolic interpolation for sub-pixel accuracy
  if (bestIdx > 0 && bestIdx < fftSize - 1) {
    const y0 = corrAccum[bestIdx - 1]
    const y1 = corrAccum[bestIdx]
    const y2 = corrAccum[bestIdx + 1]
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-10) {
      const delta = (y0 - y2) / (2 * denom)
      if (Math.abs(delta) < 1) {
        return Math.round(bestIdx + delta)
      }
    }
  }

  return bestIdx
}

/**
 * Detect how many pixels scrolled between two frames.
 * Tries FFT-based phase correlation first for speed and accuracy,
 * then falls back to SAD-based brute force if FFT result is unreliable.
 *
 * topSkip / bottomSkip: rows to exclude from overlap comparison (fixed header/footer).
 * Returns the best matching row offset, or `defaultStep` if no good match found.
 */
function detectScrollStep(
  frameA: Electron.NativeImage,
  frameB: Electron.NativeImage,
  defaultStep: number,
  topSkip: number = 0,
  bottomSkip: number = 0
): number {
  try {
    const sizeA = frameA.getSize()
    const sizeB = frameB.getSize()
    if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return defaultStep

    const { width, height } = sizeA

    // Try FFT-based detection first
    const fftResult = detectScrollStepFFT(frameA, frameB, defaultStep, topSkip, bottomSkip)
    if (fftResult > 0) {
      // Cross-validate FFT result: verify that the detected step actually
      // produces a low mismatch. FFT can return false peaks when the page
      // barely scrolled (e.g., reached the bottom).
      const bitmapA = frameA.toBitmap()
      const bitmapB = frameB.toBitmap()
      const fftMismatch = overlapMismatch(bitmapA, bitmapB, width, height, fftResult, topSkip, bottomSkip)
      if (fftMismatch < 0.02) return fftResult
      // Strict failed — try robust row-voting (handles animated content)
      const fftOverlap = height - fftResult
      const fftMinOverlap = Math.max(Math.floor(height * 0.15), 50)
      const fftRobust = robustOverlapScore(bitmapA, bitmapB, width, height, fftResult, topSkip, bottomSkip)
      if (fftRobust > 0.6 && fftOverlap >= fftMinOverlap) {
        console.log(`[scroll-capture] FFT: strict=${(fftMismatch * 100).toFixed(1)}% but robust=${(fftRobust * 100).toFixed(0)}% overlap=${fftOverlap} — accepting step=${fftResult}`)
        return fftResult
      }
      // FFT result doesn't validate — fall through to SAD
    }

    // Fall back to SAD-based detection
    return detectScrollStepSAD(frameA, frameB, defaultStep, topSkip, bottomSkip)
  } catch {
    // If FFT fails entirely, fall back to SAD
    try {
      return detectScrollStepSAD(frameA, frameB, defaultStep, topSkip, bottomSkip)
    } catch {
      return defaultStep
    }
  }
}

// ── Nearly-identical frame check ───────────────────────────────────────────

function framesNearlyIdentical(
  frameA: Electron.NativeImage,
  frameB: Electron.NativeImage
): boolean {
  try {
    const bitmapA = frameA.toBitmap()
    const bitmapB = frameB.toBitmap()
    if (bitmapA.length !== bitmapB.length) return false

    let diffPixels = 0
    const totalPixels = bitmapA.length / 4
    const sampleStep = 4 // check every 4th pixel for performance

    for (let i = 0; i < bitmapA.length; i += 4 * sampleStep) {
      if (
        Math.abs(bitmapA[i] - bitmapB[i]) > 10 ||
        Math.abs(bitmapA[i + 1] - bitmapB[i + 1]) > 10 ||
        Math.abs(bitmapA[i + 2] - bitmapB[i + 2]) > 10
      ) {
        diffPixels++
      }
    }

    const sampledPixels = Math.ceil(totalPixels / sampleStep)
    // Threshold: 0.2% — tighter than before to avoid false positives when the
    // page scrolled a small amount near the bottom (the old 0.5% was too loose
    // and would incorrectly mark the last useful frame as a duplicate).
    return diffPixels / sampledPixels < 0.002
  } catch {
    return false
  }
}

// ── Main-process stitching (raw RGBA buffers) ──────────────────────────────

/**
 * DP seam finder operating on raw RGBA buffers.
 * Finds the optimal seam row within the overlap zone between two frames.
 * Returns the median row of the minimum-cost path (best blend center point).
 */
function findSeamDPBuffer(
  bitmapA: Buffer, bitmapB: Buffer,
  width: number,
  overlapStartA: number, overlapStartB: number,
  overlapHeight: number
): number {
  if (overlapHeight <= 0) return 0

  const bytesPerRow = width * 4
  const sideMargin = computeSideMargin(width)
  const colStart = sideMargin
  const colEnd = width - sideMargin
  const effectiveW = colEnd - colStart
  const colStep = Math.max(1, Math.floor(effectiveW / (overlapHeight > 1000 ? 100 : 200)))
  const sampledW = Math.ceil(effectiveW / colStep)

  // Build cost matrix
  const cost: Float32Array[] = []
  for (let row = 0; row < overlapHeight; row++) {
    const rowCost = new Float32Array(sampledW)
    const offA = (overlapStartA + row) * bytesPerRow
    const offB = (overlapStartB + row) * bytesPerRow
    for (let sc = 0; sc < sampledW; sc++) {
      const col = colStart + sc * colStep
      const pi = col * 4
      const dr = Math.abs(bitmapA[offA + pi] - bitmapB[offB + pi])
      const dg = Math.abs(bitmapA[offA + pi + 1] - bitmapB[offB + pi + 1])
      const db = Math.abs(bitmapA[offA + pi + 2] - bitmapB[offB + pi + 2])
      rowCost[sc] = dr + dg + db
    }
    cost.push(rowCost)
  }

  // DP: minimum-cost path from left to right
  const dp: Float32Array[] = []
  const backtrack: Int16Array[] = []

  dp.push(new Float32Array(overlapHeight))
  backtrack.push(new Int16Array(overlapHeight))
  for (let row = 0; row < overlapHeight; row++) {
    dp[0][row] = cost[row][0]
    backtrack[0][row] = row
  }

  for (let sc = 1; sc < sampledW; sc++) {
    const dpCol = new Float32Array(overlapHeight)
    const btCol = new Int16Array(overlapHeight)

    for (let row = 0; row < overlapHeight; row++) {
      let bestPrev = dp[sc - 1][row]
      let bestPrevRow = row
      if (row > 0 && dp[sc - 1][row - 1] < bestPrev) {
        bestPrev = dp[sc - 1][row - 1]
        bestPrevRow = row - 1
      }
      if (row < overlapHeight - 1 && dp[sc - 1][row + 1] < bestPrev) {
        bestPrev = dp[sc - 1][row + 1]
        bestPrevRow = row + 1
      }
      dpCol[row] = bestPrev + cost[row][sc]
      btCol[row] = bestPrevRow
    }
    dp.push(dpCol)
    backtrack.push(btCol)
  }

  // Backtrack
  const lastCol = dp[sampledW - 1]
  let endRow = 0
  let minCost = lastCol[0]
  for (let row = 1; row < overlapHeight; row++) {
    if (lastCol[row] < minCost) {
      minCost = lastCol[row]
      endRow = row
    }
  }

  const seamPath = new Array<number>(sampledW)
  seamPath[sampledW - 1] = endRow
  for (let sc = sampledW - 2; sc >= 0; sc--) {
    seamPath[sc] = backtrack[sc + 1][seamPath[sc + 1]]
  }

  const sortedRows = [...seamPath].sort((a, b) => a - b)
  return sortedRows[Math.floor(sortedRows.length / 2)]
}

/**
 * Incremental stitching: extract bitmaps one at a time, stitch, free NativeImages.
 * Peak memory: accumulator buffer + 2 frame bitmaps (prev + current).
 * This is much better than holding all NativeImages + all bitmaps at once.
 */
function stitchFramesIncremental(
  frames: Electron.NativeImage[],
  scrollSteps: number[],
  topFixed: number = 0,
  bottomFixed: number = 0
): string {
  if (frames.length === 0) return ''
  if (frames.length === 1) {
    const url = frames[0].toDataURL()
    return url
  }

  const { width, height: frameH } = frames[0].getSize()
  const safeTopFixed = Math.min(Math.max(0, Math.round(topFixed)), Math.floor(frameH * 0.4))
  const safeBottomFixed = Math.min(Math.max(0, Math.round(bottomFixed)), Math.floor(frameH * 0.4))
  const contentTop = safeTopFixed
  const contentH = frameH - safeTopFixed - safeBottomFixed

  if (contentH <= 0) return frames[0].toDataURL()

  // Compute total output height from scroll steps
  const stripYOffsets: number[] = [safeTopFixed]
  for (let i = 0; i < scrollSteps.length; i++) {
    stripYOffsets.push(stripYOffsets[i] + Math.max(0, scrollSteps[i]))
  }
  const totalHeight = stripYOffsets[stripYOffsets.length - 1] + contentH + safeBottomFixed
  const bytesPerRow = width * 4

  if (totalHeight * width > 256_000_000) {
    console.warn('[scroll-capture] stitched image too large, returning last frame')
    return frames[frames.length - 1].toDataURL()
  }

  const outBuf = Buffer.alloc(totalHeight * bytesPerRow)

  function copyRows(src: Buffer, srcY: number, dstY: number, rows: number) {
    if (rows <= 0) return
    const maxSrcRows = Math.floor(src.length / bytesPerRow)
    const maxDstRows = Math.floor(outBuf.length / bytesPerRow)
    const safeRows = Math.min(rows, maxSrcRows - srcY, maxDstRows - dstY)
    if (safeRows <= 0) return
    src.copy(outBuf, dstY * bytesPerRow, srcY * bytesPerRow, (srcY + safeRows) * bytesPerRow)
  }

  // ── Frame 0: extract bitmap, write header + content, keep bitmap ────
  let prevBitmap: Buffer | null = frames[0].toBitmap()

  if (safeTopFixed > 0) {
    copyRows(prevBitmap, 0, 0, safeTopFixed)
  }
  copyRows(prevBitmap, contentTop, stripYOffsets[0], contentH)

  // Free NativeImage (we keep the Buffer)
  // (Can't truly free NativeImage in JS, but dropping reference allows GC)

  // ── Frames 1..N-1: extract, stitch, free ───────────────────────────
  for (let i = 1; i < frames.length; i++) {
    const curBitmap = frames[i].toBitmap()

    const stripY = stripYOffsets[i]
    const prevStripBottom = stripYOffsets[i - 1] + contentH
    let overlapH = prevStripBottom - stripY
    overlapH = Math.max(0, Math.min(overlapH, contentH))

    if (overlapH <= 0) {
      copyRows(curBitmap, contentTop, stripY, contentH)
    } else {
      const overlapStartInPrev = contentTop + (contentH - overlapH)
      const overlapStartInCurr = contentTop

      const seamRow = (prevBitmap != null)
        ? findSeamDPBuffer(prevBitmap, curBitmap, width, overlapStartInPrev, overlapStartInCurr, overlapH)
        : Math.floor(overlapH / 2)

      // Hard cut at seam row: prev frame above, current frame below.
      // No alpha blend — avoids visible shadow/ghosting when frames have
      // animated content that differs slightly in the overlap zone.

      // Current frame's content from seam row to end of overlap
      const belowSeamInOverlap = overlapH - seamRow
      if (belowSeamInOverlap > 0) {
        copyRows(curBitmap, contentTop + seamRow, stripY + seamRow, belowSeamInOverlap)
      }

      // Non-overlapping content below overlap
      if (overlapH < contentH) {
        copyRows(curBitmap, contentTop + overlapH, stripY + overlapH, contentH - overlapH)
      }
    }

    // Free previous bitmap, keep current for next iteration's seam finding
    prevBitmap = curBitmap
  }

  // ── Footer from last frame ──────────────────────────────────────────
  if (safeBottomFixed > 0 && prevBitmap) {
    copyRows(prevBitmap, frameH - safeBottomFixed, totalHeight - safeBottomFixed, safeBottomFixed)
  }
  prevBitmap = null // free last bitmap

  // ── Force alpha=255 for all pixels ──────────────────────────────────
  for (let i = 3; i < outBuf.length; i += 4) {
    outBuf[i] = 255
  }

  const result = nativeImage.createFromBitmap(outBuf, { width, height: totalHeight })
  return result.toDataURL()
}

// ── Main capture loop (crops each frame to rect) ───────────────────────────

async function captureScrollingInRect(
  rect: { x: number; y: number; width: number; height: number },
  opts: { delay: number; maxFrames: number; scrollMethod?: ScrollMethod; scrollToTopFirst?: boolean },
  progressCb: (data: { frame: number; maxFrames: number; phase?: 'capturing' | 'stitching' }) => void,
  isCancelledFn: () => boolean,
  displayId?: number | null
): Promise<{ dataUrl: string }> {
  const allDisplays = screen.getAllDisplays()
  const targetDisplay = (displayId != null
    ? allDisplays.find(d => d.id === displayId)
    : null) ?? screen.getPrimaryDisplay()
  const scaleFactor = targetDisplay.scaleFactor
  const { width: dispW, height: dispH } = targetDisplay.size
  const displayBounds = targetDisplay.bounds

  // Centre of capture rect in ABSOLUTE screen coordinates (for scroll-wheel targeting).
  // rect coordinates are relative to the overlay window which fills the target display,
  // so we add the display's origin offset for multi-display setups.
  const centerDipX = displayBounds.x + rect.x + rect.width / 2
  const centerDipY = displayBounds.y + rect.y + rect.height / 2

  // The native Win32 scroll path (SetCursorPos / mouse_event / WindowFromPoint)
  // expects virtual-screen PHYSICAL pixels, which only equal DIP at 100% scale.
  // Convert here on Windows; macOS uses points throughout (points == DIP), so
  // leave the coordinates untouched there.
  const center = process.platform === 'win32'
    ? screen.dipToScreenPoint({ x: centerDipX, y: centerDipY })
    : { x: centerDipX, y: centerDipY }
  const centerX = center.x
  const centerY = center.y

  const scrollMethod: ScrollMethod = opts.scrollMethod ?? 'mouseWheel'

  console.log(`[scroll-capture] start: display=${targetDisplay.id} scale=${scaleFactor} rect=${JSON.stringify(rect)} center=(${centerX},${centerY}) method=${scrollMethod}`)

  // ── Debug: save individual frames to Desktop/scroll-debug/ ─────────
  // Dev builds only — never dump frame PNGs to the user's Desktop in production.
  const DEBUG_FRAMES = !app.isPackaged
  const debugDir = DEBUG_FRAMES ? join(app.getPath('desktop'), 'scroll-debug') : ''
  if (DEBUG_FRAMES) {
    try { mkdirSync(debugDir, { recursive: true }) } catch { /* ok */ }
  }

  // ── Scroll to top before capture (opt-in) ──────────────────────────
  if (opts.scrollToTopFirst === true) {
    await scrollToTop(centerX, centerY)
    await sleep(500) // wait for scroll animation to finish
  }

  // Display profile → sRGB conversion, resolved once per session. Frames are
  // converted as they're captured so the overlap detector and every output
  // path (dialog preview, save, editor) see sRGB — same treatment the other
  // capture modes get in capture.ts (toSrgbFrame). Null when the display has
  // no profile / the stock sRGB one (skip) or a LUT profile (not convertible
  // — frames stay raw, same as before conversion existed).
  const conversionIcc = await getDisplayConversionIcc(targetDisplay.id).catch(() => null)

  const frames: Electron.NativeImage[] = []
  const scrollSteps: number[] = [] // per-pair scroll offsets (in physical pixels)

  // Physical pixel dimensions of the cropped frame
  const framePhysH = Math.round(rect.height * scaleFactor)

  // Target overlap: 40% of frame height for reliable matching on dynamic pages
  const TARGET_OVERLAP_PX = Math.max(150, Math.floor(framePhysH * 0.40))
  // Ideal scroll step = frame height minus target overlap. For very short
  // regions (< ~150 physical px) framePhysH - TARGET_OVERLAP_PX goes negative,
  // which cascades into broken overlap detection — clamp to a positive minimum.
  const minStepPx = 1
  const targetStep = Math.max(minStepPx, framePhysH - TARGET_OVERLAP_PX)
  // Default prediction for detectScrollStep (first pair)
  const defaultStep = targetStep

  // ── Adaptive scroll delta ──────────────────────────────────────────────
  // Start with an initial wheel delta, then calibrate based on the ratio
  // between the actual detected scroll step and what we sent.
  let currentDelta = 300 // initial macOS pixel delta / Windows base unit
  let calibrated = false // becomes true after first pair measurement

  // Early fixed region estimates (populated after 3 frames)
  let earlyTopFixed = 0
  let earlyBottomFixed = 0

  // ── Best-guess fallback (ShareX-inspired) ─────────────────────────────
  // Track the best successful scroll step across all frame pairs. When
  // detection fails for a frame, reuse the best previous step instead of
  // defaultStep. This handles content changes between frames (animations, ads).
  let bestGuessStep = 0
  let bestGuessMismatch = 1.0

  console.log(`[scroll-capture] loop: maxFrames=${opts.maxFrames} delay=${opts.delay} cancelled=${isCancelledFn()}`)

  for (let i = 0; i < opts.maxFrames; i++) {
    if (isCancelledFn()) { console.log(`[scroll-capture] cancelled at frame ${i}`); break }

    // Capture full screen
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(dispW * scaleFactor),
        height: Math.round(dispH * scaleFactor)
      }
    })

    console.log(`[scroll-capture] frame ${i}: sources=${sources.length} ids=[${sources.map(s => s.display_id).join(',')}] targetId=${targetDisplay.id}`)

    // Find the source for the target display (same logic as capture.ts)
    const source = findSourceForDisplay(sources, allDisplays, targetDisplay.id)
    if (!source) { console.log(`[scroll-capture] no source found — breaking`); break }

    // Crop to selected rect (apply scaleFactor)
    let cropped = source.thumbnail.crop({
      x: Math.round(rect.x * scaleFactor),
      y: Math.round(rect.y * scaleFactor),
      width: Math.round(rect.width * scaleFactor),
      height: framePhysH
    })

    if (conversionIcc) {
      const size = cropped.getSize()
      const bmp = cropped.toBitmap()
      if (convertBgraToSrgbInPlace(bmp, conversionIcc)) {
        cropped = nativeImage.createFromBitmap(bmp, size)
      }
    }

    frames.push(cropped)
    progressCb({ frame: i + 1, maxFrames: opts.maxFrames, phase: 'capturing' })

    // Debug: save each frame as PNG
    if (DEBUG_FRAMES) {
      try { writeFileSync(join(debugDir, `frame-${String(i).padStart(2, '0')}.png`), cropped.toPNG()) } catch { /* ok */ }
    }

    // Early fixed region detection after 3 frames are captured. Cap each region
    // at 40% of the frame height (same rule the stitch step applies) so an
    // oversized detection can't drive rowEnd <= rowStart in overlapMismatch —
    // which would make every pair fail.
    if (frames.length === 3 && earlyTopFixed === 0 && earlyBottomFixed === 0) {
      const early = detectFixedRegions(frames)
      const fixedCap = Math.floor(framePhysH * 0.4)
      earlyTopFixed = Math.min(Math.max(0, early.topFixed), fixedCap)
      earlyBottomFixed = Math.min(Math.max(0, early.bottomFixed), fixedCap)
    }

    // Detect scroll step for each consecutive pair
    if (frames.length >= 2) {
      const prevStep = scrollSteps.length > 0 ? scrollSteps[scrollSteps.length - 1] : defaultStep
      let step = detectScrollStep(frames[frames.length - 2], frames[frames.length - 1], prevStep, earlyTopFixed, earlyBottomFixed)

      // Validate detected step — check overlap mismatch
      const frameA = frames[frames.length - 2]
      const frameB = frames[frames.length - 1]
      const { width: fw, height: fh } = frameA.getSize()
      const bA = frameA.toBitmap()
      const bB = frameB.toBitmap()
      const mismatch = overlapMismatch(bA, bB, fw, fh, step, earlyTopFixed, earlyBottomFixed)
      let stepConfirmed = false

      // Conservative estimate: one wheel notch ≈ 100-200 physical pixels
      const conservativeStep = Math.min(Math.round(framePhysH * 0.2), 200)

      if (mismatch < 0.02) {
        // Good strict match
        stepConfirmed = true
        if (mismatch < bestGuessMismatch || bestGuessStep === 0) {
          bestGuessStep = step
          bestGuessMismatch = mismatch
        }
      } else {
        // Strict validation failed — try robust row-voting (animated/video content)
        // Require minimum overlap to prevent false matches on uniform/white content
        const overlapAtStep = fh - step
        const minOverlapForRobust = Math.max(Math.floor(fh * 0.15), 50)
        const robust = robustOverlapScore(bA, bB, fw, fh, step, earlyTopFixed, earlyBottomFixed)
        if (robust > 0.6 && overlapAtStep >= minOverlapForRobust) {
          // Majority of rows match with sufficient overlap — accept step
          stepConfirmed = true
          if (bestGuessStep === 0) {
            bestGuessStep = step
            bestGuessMismatch = mismatch
          }
        } else if (bestGuessStep > 0) {
          // Detection failed — use best previous confirmed step as fallback
          const fallbackMismatch = overlapMismatch(bA, bB, fw, fh, bestGuessStep, earlyTopFixed, earlyBottomFixed)
          const fallbackRobust = robustOverlapScore(bA, bB, fw, fh, bestGuessStep, earlyTopFixed, earlyBottomFixed)
          if (fallbackMismatch < mismatch || fallbackRobust > robust) {
            step = bestGuessStep
          }
        } else {
          // Complete detection failure: no previous good guess, no match at all.
          // This happens on pages with full-screen video/animation.
          // Use a conservative estimate instead of defaultStep (which is way too large).
          step = conservativeStep
          console.log(`[scroll-capture] pair ${frames.length - 2}->${frames.length - 1}: COMPLETE FAIL — using conservativeStep=${step}`)
        }
        if (robust !== undefined) {
          console.log(`[scroll-capture] pair ${frames.length - 2}->${frames.length - 1}: mismatch=${(mismatch * 100).toFixed(1)}% robust=${(robust * 100).toFixed(0)}% step=${step} confirmed=${stepConfirmed}`)
        }
      }

      scrollSteps.push(step)

      // When the first confirmed step is found, retroactively correct all
      // previous unconfirmed steps. The early frames had video/animation
      // that prevented detection, but the scroll delta was constant, so
      // the actual scroll per frame was similar.
      if (stepConfirmed && bestGuessStep > 0) {
        let retroFixed = 0
        for (let j = 0; j < scrollSteps.length - 1; j++) {
          if (scrollSteps[j] === defaultStep || scrollSteps[j] === conservativeStep) {
            scrollSteps[j] = bestGuessStep
            retroFixed++
          }
        }
        if (retroFixed > 0) {
          console.log(`[scroll-capture] retroactively corrected ${retroFixed} steps to ${bestGuessStep}`)
        }
      }

      const actualOverlap = framePhysH - step

      // ── Calibrate scroll delta — ONLY on confirmed steps ──
      // Ratio: how many physical scroll pixels per unit of delta we sent.
      // Cap increase to 2x per calibration to avoid overshooting.
      if (!calibrated && stepConfirmed && step > 10) {
        const prevDelta = currentDelta
        const pxPerDelta = step / currentDelta
        const idealDelta = Math.round(targetStep / pxPerDelta)
        // Cap to max 2x current delta to prevent wild overshooting
        currentDelta = Math.max(50, Math.min(idealDelta, currentDelta * 2, 2000))
        calibrated = true
        // Reset bestGuessStep — scroll amount is changing, old guess is stale
        bestGuessStep = 0
        bestGuessMismatch = 1.0
        console.log(`[scroll-capture] calibrated: step=${step} pxPerDelta=${pxPerDelta.toFixed(2)} delta ${prevDelta}->${currentDelta} (ideal=${idealDelta}) targetStep=${targetStep}`)
      } else if (calibrated && stepConfirmed && step > 10) {
        // Fine-tune: if actual overlap drifted from target, nudge the delta
        const overlapError = actualOverlap - TARGET_OVERLAP_PX
        if (Math.abs(overlapError) > 20) {
          const prevDelta = currentDelta
          const adjustment = Math.round(overlapError * (currentDelta / step) * 0.5)
          currentDelta = Math.max(50, Math.min(currentDelta + adjustment, currentDelta * 2, 2000))
          // Reset bestGuessStep when delta changes significantly
          if (Math.abs(currentDelta - prevDelta) > prevDelta * 0.3) {
            bestGuessStep = 0
            bestGuessMismatch = 1.0
          }
        }
      }
    }

    // Stop if at bottom (require at least 3 frames so we always attempt ≥2 scrolls,
    // then stop when two consecutive frames look the same — i.e. page didn't move)
    if (frames.length >= 3) {
      const identical = framesNearlyIdentical(frames[frames.length - 2], frames[frames.length - 1])
      if (identical) {
        console.log(`[scroll-capture] frames ${frames.length - 2} & ${frames.length - 1} nearly identical — stopping (page bottom reached)`)
        frames.pop()
        scrollSteps.pop()
        break
      }
    }

    if (i < opts.maxFrames - 1) {
      await scrollAtPosition(centerX, centerY, currentDelta, scrollMethod)
      await sleep(opts.delay + 200)
    }
  }

  if (frames.length === 0) return { dataUrl: '' }

  // ── Fixed region detection ───────────────────────────────────────────
  // Use early detection if we have enough frames, else detect from what we have
  const { topFixed, bottomFixed } = earlyTopFixed > 0 || earlyBottomFixed > 0
    ? { topFixed: earlyTopFixed, bottomFixed: earlyBottomFixed }
    : detectFixedRegions(frames)

  // If fixed regions were found, re-run scroll step detection for accuracy.
  // Only update a step if the refined detection produces a BETTER match
  // (lower mismatch). This prevents overwriting good steps with bad ones
  // when detection fails due to video/animation content.
  if ((topFixed > 0 || bottomFixed > 0) && frames.length >= 2) {
    for (let i = 0; i < scrollSteps.length; i++) {
      if (frames[i] && frames[i + 1]) {
        const prevStep = i > 0 ? scrollSteps[i - 1] : defaultStep
        const refinedStep = detectScrollStep(frames[i], frames[i + 1], prevStep, topFixed, bottomFixed)
        if (refinedStep !== scrollSteps[i]) {
          const { width: rw, height: rh } = frames[i].getSize()
          const rA = frames[i].toBitmap()
          const rB = frames[i + 1].toBitmap()
          const oldMismatch = overlapMismatch(rA, rB, rw, rh, scrollSteps[i], topFixed, bottomFixed)
          const newMismatch = overlapMismatch(rA, rB, rw, rh, refinedStep, topFixed, bottomFixed)
          if (newMismatch < oldMismatch) {
            scrollSteps[i] = refinedStep
          }
        }
      }
    }
  }

  console.log(`[scroll-capture] done: ${frames.length} frames, topFixed=${topFixed} bottomFixed=${bottomFixed} steps=[${scrollSteps.join(',')}]`)

  // ── Incremental stitch in main process ───────────────────────────────
  // Stitch frame by frame, freeing each NativeImage after extracting its
  // bitmap. Peak memory: accumulator + 2 frame bitmaps (prev + current).
  progressCb({ frame: frames.length, maxFrames: frames.length, phase: 'stitching' })
  const dataUrl = stitchFramesIncremental(frames, scrollSteps, topFixed, bottomFixed)

  return { dataUrl }
}

// ── Overlay mode tracking ──────────────────────────────────────────────────

export type OverlayMode =
  | 'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'
  | 'video-region' | 'video-window' | 'video-screen'

let overlayMode: OverlayMode = 'region'

export function getOverlayMode(): OverlayMode {
  return overlayMode
}

export function resetOverlayMode() {
  overlayMode = 'region'
}

export function setOverlayMode(mode: OverlayMode) {
  overlayMode = mode
}

// ── Unified launcher (method routing) ──────────────────────────────────────

// Captured at setup time so hotkeys / tray / dispatchLastCapture can launch a
// scroll session without re-plumbing the overlay factories everywhere.
let scrollDeps: { mainWindow: BrowserWindow; createOverlayWindows: () => void } | null = null

/**
 * Start a scroll capture using the given method, or the saved
 * `scrollCaptureMethod` setting when none is passed.
 *
 * Fallback policy: an EXPLICIT 'extension' request (Dashboard card) with no
 * extension connected fails fast with `extension-not-connected` so the UI can
 * show setup help; the implicit path (hotkey / New Capture replay) silently
 * falls back to the classic screen method so the hotkey always does something.
 */
export async function launchScrollCapture(
  method?: ScrollCaptureMethod
): Promise<{ ok: boolean; error?: string }> {
  const resolved = method ?? getSettings().scrollCaptureMethod
  if (resolved === 'extension') {
    if (isExtensionConnected()) return startExtensionCapture()
    if (method === 'extension') return { ok: false, error: 'extension-not-connected' }
    console.log('[scroll-capture] extension method saved but not connected — falling back to screen scroll')
  }

  // Classic screen method: hide the main window, open the region overlay.
  // Same dance as the hotkey path used to inline.
  const main = scrollDeps?.mainWindow
  if (main && !main.isDestroyed()) main.hide()
  await sleep(200)
  setOverlayMode('scroll-region')
  scrollDeps?.createOverlayWindows()
  return { ok: true }
}

// ── IPC setup ─────────────────────────────────────────────────────────────

export function setupScrollCapture(
  mainWindow: BrowserWindow,
  createOverlayWindows: () => void,
  closeAllOverlays: () => void,
  getOverlayDisplayId: () => number | null,
  restoreFromOverlayCancel: () => void,
) {
  scrollDeps = { mainWindow, createOverlayWindows }

  let cancelled = false
  let captureOpts: {
    delay: number; maxFrames: number;
    scrollMethod?: ScrollMethod; scrollToTopFirst?: boolean
  } = { delay: 600, maxFrames: 50 }

  // Unified entry point: routes to the extension bridge or the classic
  // screen pipeline based on the saved setting / explicit method.
  ipcMain.handle('scroll-capture:launch', (_e, method?: ScrollCaptureMethod) =>
    launchScrollCapture(method))

  // Step 1: User clicks "Scrolling" — hide main window, open overlay
  ipcMain.handle('scroll-capture:start', async (_e, opts?: {
    delay?: number; maxFrames?: number;
    scrollMethod?: ScrollMethod; scrollToTopFirst?: boolean
  }) => {
    cancelled = false
    captureOpts = {
      delay: opts?.delay ?? 600,
      maxFrames: opts?.maxFrames ?? 50,
      scrollMethod: opts?.scrollMethod,
      scrollToTopFirst: opts?.scrollToTopFirst
    }

    mainWindow.hide()
    await sleep(200) // wait for window to hide before opening overlay

    // Tell overlay to use 'scroll-region' mode before creating it
    overlayMode = 'scroll-region'
    createOverlayWindows()
    return { ok: true }
  })

  // Step 2: Overlay confirms region selection
  ipcMain.handle('scroll-region:confirm', async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    // Reset here too: the hotkey path opens the overlay without going through
    // scroll-capture:start, so a previous ESC leaves `cancelled` stuck true and
    // every subsequent capture would abort at frame 0.
    cancelled = false
    const captureDisplayId = getOverlayDisplayId()
    resetOverlayMode()
    closeAllOverlays()

    try {
      await sleep(150) // brief delay after overlay closes

      const { dataUrl } = await captureScrollingInRect(
        rect,
        captureOpts,
        (data) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scroll-capture:progress', data)
          }
        },
        () => cancelled,
        captureDisplayId
      )

      if (!mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        // Only Dashboard listens for scroll-capture:open/result, so make sure
        // it's the mounted route before we emit — otherwise the result is lost
        // when the user kicked the capture off from another view (e.g. Settings).
        mainWindow.webContents.send('navigate', '/dashboard')
        await sleep(100)
        mainWindow.webContents.send('scroll-capture:open')
        // Wait for React to mount ScrollCaptureDialog and register its IPC listener
        // before sending result — otherwise the event arrives before the listener exists
        await sleep(500)
        mainWindow.webContents.send('scroll-capture:result', { dataUrl })
      }
    } catch (err: unknown) {
      if (!mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        // Same as the success path: Dashboard is the only listener for
        // scroll-capture:open/error, so route there first.
        mainWindow.webContents.send('navigate', '/dashboard')
        await sleep(100)
        mainWindow.webContents.send('scroll-capture:open')
        await sleep(500)
        mainWindow.webContents.send('scroll-capture:error', { error: err instanceof Error ? err.message : 'Unknown error' })
      }
    }
  })

  // Cancel from overlay (ESC key)
  ipcMain.handle('scroll-region:cancel', () => {
    resetOverlayMode()
    closeAllOverlays()
    cancelled = true
    restoreFromOverlayCancel()
  })

  ipcMain.handle('scroll-capture:cancel', () => {
    cancelled = true
    // Same dialog cancels both methods — stop an extension session too.
    cancelExtensionCapture()
  })
}
