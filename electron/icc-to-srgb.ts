/**
 * Convert display-color-space pixels to sRGB using the display's ICC profile.
 *
 * Why: Chromium composites web content into the monitor's color space (per
 * the Windows/macOS display profile), and `captureVisibleTab` returns those
 * raw compositor pixels with no embedded profile. On panels whose profile
 * strays far from sRGB the numbers look visibly wrong when read as sRGB —
 * e.g. AWS-console link blue #0972d3 came back as violet (107,48,229) on one
 * wide-gamut laptop. Tagging the saved PNG (png-icc.ts) fixes color-managed
 * viewers, but the clipboard image, the editor dataUrl, and thumbnails are
 * raw pixels — so captures are converted to sRGB once at the source, and
 * every consumer agrees. Both capture pipelines do this: the extension
 * bridge converts its stitched bitmap, and the native screen paths
 * (capture.ts freeze/confirm, scroll-capture.ts frames) convert theirs —
 * GDI/desktopCapturer read the same display-space compositor output that
 * captureVisibleTab returns.
 *
 * Scope: matrix-shaper profiles only (rXYZ/gXYZ/bXYZ + rTRC/gTRC/bTRC — what
 * effectively every display profile ships). LUT-based (A2B) profiles return
 * null from the parser and the caller falls back to iCCP tagging. The 'vcgt'
 * tag is deliberately ignored: it programs the GPU's scanout LUT and is NOT
 * part of Chromium's composite transform, so undoing it would over-correct.
 */

interface MatrixShaper {
  /** Linear device RGB → XYZ (D50-adapted, per ICC PCS), row-major 3×3. */
  m: number[]
  /** Per-channel 256-entry decode LUTs: 8-bit device value → linear [0,1]. */
  decode: [Float64Array, Float64Array, Float64Array]
}

// XYZ(D50) → linear sRGB (Bradford-adapted — the standard ICC PCS matrix).
const XYZD50_TO_LSRGB = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.0334540,
  0.0719453, -0.2289914, 1.4052427
]

function findTag(icc: Buffer, sig: string): { off: number; size: number } | null {
  if (icc.length < 132) return null
  const count = icc.readUInt32BE(128)
  if (icc.length < 132 + count * 12) return null
  for (let i = 0; i < count; i++) {
    const rec = 132 + i * 12
    if (icc.toString('latin1', rec, rec + 4) === sig) {
      const off = icc.readUInt32BE(rec + 4)
      const size = icc.readUInt32BE(rec + 8)
      if (off + size > icc.length) return null
      return { off, size }
    }
  }
  return null
}

function readS15F16(icc: Buffer, off: number): number {
  return icc.readInt32BE(off) / 65536
}

/** 'XYZ ' tag → [X, Y, Z]. */
function parseXYZ(icc: Buffer, off: number): [number, number, number] | null {
  if (icc.toString('latin1', off, off + 4) !== 'XYZ ') return null
  return [readS15F16(icc, off + 8), readS15F16(icc, off + 12), readS15F16(icc, off + 16)]
}

/** 'curv' / 'para' TRC tag → 256-entry decode LUT (8-bit device → linear). */
function parseTrc(icc: Buffer, off: number): Float64Array | null {
  const type = icc.toString('latin1', off, off + 4)
  const lut = new Float64Array(256)

  if (type === 'curv') {
    const n = icc.readUInt32BE(off + 8)
    if (n === 0) {
      for (let i = 0; i < 256; i++) lut[i] = i / 255 // identity
      return lut
    }
    if (n === 1) {
      const gamma = icc.readUInt16BE(off + 12) / 256 // u8Fixed8
      for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma)
      return lut
    }
    // Sampled curve: uint16 entries, linearly interpolated.
    for (let i = 0; i < 256; i++) {
      const pos = (i / 255) * (n - 1)
      const i0 = Math.floor(pos)
      const i1 = Math.min(n - 1, i0 + 1)
      const frac = pos - i0
      const v0 = icc.readUInt16BE(off + 12 + i0 * 2) / 65535
      const v1 = icc.readUInt16BE(off + 12 + i1 * 2) / 65535
      lut[i] = v0 + (v1 - v0) * frac
    }
    return lut
  }

  if (type === 'para') {
    // parametricCurveType (ICC v4): IEC 61966-3 style function families.
    const fn = icc.readUInt16BE(off + 8)
    const p = (idx: number) => readS15F16(icc, off + 12 + idx * 4)
    let g = 1, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0
    switch (fn) {
      case 0: g = p(0); break
      case 1: g = p(0); a = p(1); b = p(2); break
      case 2: g = p(0); a = p(1); b = p(2); c = p(3); break
      case 3: g = p(0); a = p(1); b = p(2); c = p(3); d = p(4); break
      case 4: g = p(0); a = p(1); b = p(2); c = p(3); d = p(4); e = p(5); f = p(6); break
      default: return null
    }
    for (let i = 0; i < 256; i++) {
      const x = i / 255
      let y: number
      switch (fn) {
        case 0: y = Math.pow(x, g); break
        case 1: y = x >= -b / a ? Math.pow(a * x + b, g) : 0; break
        case 2: y = x >= -b / a ? Math.pow(a * x + b, g) + c : c; break
        case 3: y = x >= d ? Math.pow(a * x + b, g) : c * x; break
        default: y = x >= d ? Math.pow(a * x + b, g) + e : c * x + f; break
      }
      lut[i] = Math.min(1, Math.max(0, y))
    }
    return lut
  }

  return null
}

/** Parse a matrix-shaper display profile; null → not representable (caller
 *  should fall back to iCCP tagging). */
export function parseMatrixShaper(icc: Buffer): MatrixShaper | null {
  try {
    if (icc.length < 132) return null
    // PCS must be XYZ (matrix profiles always are; Lab PCS → LUT profile).
    if (icc.toString('latin1', 20, 24) !== 'XYZ ') return null

    const rXYZ = findTag(icc, 'rXYZ')
    const gXYZ = findTag(icc, 'gXYZ')
    const bXYZ = findTag(icc, 'bXYZ')
    const rTRC = findTag(icc, 'rTRC')
    const gTRC = findTag(icc, 'gTRC')
    const bTRC = findTag(icc, 'bTRC')
    if (!rXYZ || !gXYZ || !bXYZ || !rTRC || !gTRC || !bTRC) return null

    const r = parseXYZ(icc, rXYZ.off)
    const g = parseXYZ(icc, gXYZ.off)
    const b = parseXYZ(icc, bXYZ.off)
    if (!r || !g || !b) return null

    const dr = parseTrc(icc, rTRC.off)
    const dg = parseTrc(icc, gTRC.off)
    const db = parseTrc(icc, bTRC.off)
    if (!dr || !dg || !db) return null

    // Columns are the primaries' XYZ contributions.
    const m = [
      r[0], g[0], b[0],
      r[1], g[1], b[1],
      r[2], g[2], b[2]
    ]
    return { m, decode: [dr, dg, db] }
  } catch {
    return null
  }
}

/** linear [0,1] → 8-bit sRGB-encoded, via a lookup table (pow() per pixel is
 *  too slow for full-page stitches). 8192 entries keeps shadow banding under
 *  1/255. */
function buildSrgbEncodeLut(): Uint8Array {
  const N = 8192
  const lut = new Uint8Array(N + 1)
  for (let i = 0; i <= N; i++) {
    const v = i / N
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    lut[i] = Math.round(Math.min(1, Math.max(0, s)) * 255)
  }
  return lut
}

/**
 * In-place convert a BGRA bitmap (Electron `toBitmap()` layout) from the
 * display profile's space to sRGB. Returns false (buffer untouched) when the
 * profile isn't a matrix-shaper.
 */
export function convertBgraToSrgbInPlace(buf: Buffer, icc: Buffer): boolean {
  const prof = parseMatrixShaper(icc)
  if (!prof) return false

  // Fold both matrices into one: linear device RGB → linear sRGB.
  const A = XYZD50_TO_LSRGB
  const B = prof.m
  const M = new Float64Array(9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      M[row * 3 + col] =
        A[row * 3 + 0] * B[0 * 3 + col] +
        A[row * 3 + 1] * B[1 * 3 + col] +
        A[row * 3 + 2] * B[2 * 3 + col]
    }
  }

  const [dr, dg, db] = prof.decode
  const enc = buildSrgbEncodeLut()
  const N = enc.length - 1

  for (let i = 0; i < buf.length; i += 4) {
    // Electron bitmaps are BGRA.
    const lr = dr[buf[i + 2]]
    const lg = dg[buf[i + 1]]
    const lb = db[buf[i]]
    let r = M[0] * lr + M[1] * lg + M[2] * lb
    let g = M[3] * lr + M[4] * lg + M[5] * lb
    let b = M[6] * lr + M[7] * lg + M[8] * lb
    r = r < 0 ? 0 : r > 1 ? 1 : r
    g = g < 0 ? 0 : g > 1 ? 1 : g
    b = b < 0 ? 0 : b > 1 ? 1 : b
    buf[i + 2] = enc[(r * N + 0.5) | 0]
    buf[i + 1] = enc[(g * N + 0.5) | 0]
    buf[i] = enc[(b * N + 0.5) | 0]
  }
  return true
}

/**
 * True when converting through this profile would be a no-op within 8-bit
 * precision — i.e. the profile IS sRGB or a rebadged copy of it (what Windows
 * assigns to most displays by default). Callers skip the full-frame convert
 * then: it would only add ±1 LSB rounding noise and a wasted pixel pass.
 */
export function profileIsNearSrgb(icc: Buffer): boolean {
  const prof = parseMatrixShaper(icc)
  if (!prof) return false

  // Fold device→XYZ with XYZ→linear-sRGB; sRGB-like primaries fold to ≈ I.
  // 2e-3 tolerance absorbs s15Fixed16 quantization across profile vendors
  // while staying under half an 8-bit step on full-scale channels.
  const A = XYZD50_TO_LSRGB
  const B = prof.m
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const v =
        A[row * 3 + 0] * B[0 * 3 + col] +
        A[row * 3 + 1] * B[1 * 3 + col] +
        A[row * 3 + 2] * B[2 * 3 + col]
      if (Math.abs(v - (row === col ? 1 : 0)) > 2e-3) return false
    }
  }

  // With the matrix ≈ identity the transform reduces to per-channel
  // decode→re-encode; require that round trip to move no value more than 1.
  const enc = buildSrgbEncodeLut()
  const N = enc.length - 1
  for (const lut of prof.decode) {
    for (let i = 0; i < 256; i++) {
      const v = lut[i] < 0 ? 0 : lut[i] > 1 ? 1 : lut[i]
      if (Math.abs(enc[(v * N + 0.5) | 0] - i) > 1) return false
    }
  }
  return true
}
