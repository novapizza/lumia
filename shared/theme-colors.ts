/* Custom themes (design/CUSTOM-THEMES.md): the colour maths shared by main,
   the preload and the renderer. Imports nothing, so unit tests and both
   tsconfig projects load it directly. All colour work is in OKLCH. */

export type Oklch = { l: number; c: number; h: number; alpha: number }

/** Brightness bands per mode and the accent's limits (starting values from
 *  the design; tune by eye, the tests must still pass). */
export const BANDS = {
  dark: { minL: 0.12, maxL: 0.30 },
  // Top at today's light background (L .9703): above it elevated / control
  // (white) can't move up and the steps collapse at L 1 (final review).
  light: { minL: 0.90, maxL: 0.971 },
  /** A base is a tint, not a colour field. */
  baseMaxC: 0.06,
  accent: { minL: 0.45, maxL: 0.65, minC: 0.08 },
} as const

/** The accent's WCAG luminance window. Bottom: it reads at ≥ 2.7:1 as text
 *  or an icon on the dark toolbar (#151515). Top: white text reads better
 *  on it than black (they tie at ≈ 0.185), so every accent takes white
 *  labels; a lighter pick is darkened along its hue (Jasper, 2026-11-22;
 *  was 0.30, the light toolbar's limit). Today's #7440d5 sits at 0.12. */
const ACCENT_Y = { min: 0.11, max: 0.18 }

/** The default accent's hue: a grey pick has none, so it takes this one. */
const DEFAULT_ACCENT_HUE = 293.5

// ── sRGB <-> OKLab (Björn Ottosson's matrices) ──

type Rgb = { r: number; g: number; b: number } // 0..1, gamma-encoded

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

function rgbToOklch({ r, g, b }: Rgb, alpha: number): Oklch {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  const c = Math.hypot(A, B)
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360
  return { l: L, c, h, alpha }
}

/** Unclamped sRGB (channels may fall outside 0..1 when out of gamut). */
function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180
  const A = c * Math.cos(hr), B = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.2914855480 * B
  const L3 = l_ ** 3, M3 = m_ ** 3, S3 = s_ ** 3
  return {
    r: fromLinear(4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3),
    g: fromLinear(-1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3),
    b: fromLinear(-0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3),
  }
}

const EPS = 1e-4
const inGamut = ({ r, g, b }: Rgb) => [r, g, b].every(v => v >= -EPS && v <= 1 + EPS)

// ── Parse / format ──

/** `#rrggbb`, `rgba(r, g, b, a)` / `rgb(r, g, b)`, or `oklch(L C H)`. */
export function parseColor(css: string): Oklch {
  const s = css.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return rgbToOklch({ r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }, 1)
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) return rgbToOklch({ r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255 }, m[4] === undefined ? 1 : +m[4])
  m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(s)
  if (m) return { l: +m[1], c: +m[2], h: +m[3], alpha: 1 }
  throw new Error(`theme-colors: can't parse ${css}`)
}

/** `#rrggbb` when opaque, else `rgba(r, g, b, a)` (a to 3 places). */
export function formatColor(c: Oklch): string {
  const { r, g, b } = oklchToRgb(toGamut(c))
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  const [R, G, B] = [to255(r), to255(g), to255(b)]
  if (c.alpha >= 1) return '#' + [R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')
  return `rgba(${R}, ${G}, ${B}, ${Math.round(c.alpha * 1000) / 1000})`
}

/** Lower the chroma until the colour fits sRGB (hue and lightness kept). */
export function toGamut(c: Oklch): Oklch {
  if (inGamut(oklchToRgb(c))) return c
  let lo = 0, hi = c.c
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklchToRgb({ ...c, c: mid }))) lo = mid; else hi = mid
  }
  return { ...c, c: lo }
}

// ── Contrast (WCAG 2) ──

function luminance({ r, g, b }: Rgb) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

const clampRgb = ({ r, g, b }: Rgb): Rgb => ({ r: Math.min(1, Math.max(0, r)), g: Math.min(1, Math.max(0, g)), b: Math.min(1, Math.max(0, b)) })

function hexRgb(css: string): { rgb: Rgb; alpha: number } {
  const c = parseColor(css)
  const rgb = oklchToRgb(toGamut(c))
  const cl = (v: number) => Math.min(1, Math.max(0, v))
  return { rgb: { r: cl(rgb.r), g: cl(rgb.g), b: cl(rgb.b) }, alpha: c.alpha }
}

/** WCAG contrast ratio of `fg` over `bg`; a see-through `fg` is composited
 *  over `bg` first. */
export function contrast(fg: string, bg: string): number {
  const B = hexRgb(bg).rgb
  const F = hexRgb(fg)
  const mix = (f: number, b: number) => f * F.alpha + b * (1 - F.alpha)
  const lf = luminance({ r: mix(F.rgb.r, B.r), g: mix(F.rgb.g, B.g), b: mix(F.rgb.b, B.b) })
  const lb = luminance(B)
  return (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)
}

// ── Clamps ──

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Clamped picks aim this far inside a band edge: rounding to 8-bit hex
 *  moves L by up to ~0.002, which would land just outside it. */
const INSET = 0.003

/** A base pick held inside its mode's brightness band, chroma capped. An
 *  in-band pick comes back unchanged. */
export function clampBase(hex: string, mode: 'light' | 'dark'): string {
  const c = parseColor(hex)
  const band = BANDS[mode]
  if (c.l >= band.minL && c.l <= band.maxL && c.c <= BANDS.baseMaxC) return hex.toLowerCase()
  return formatColor({ ...c, l: clampNum(c.l, band.minL + INSET, band.maxL - INSET), c: Math.min(c.c, BANDS.baseMaxC - INSET), alpha: 1 })
}

/** The accent pick held where white or black reads on it and it shows on
 *  both bases. An in-band pick comes back unchanged. */
export function clampAccent(hex: string): string {
  const c = parseColor(hex)
  const a = BANDS.accent
  const y = (x: Oklch) => luminance(clampRgb(oklchToRgb(toGamut(x))))
  const yOk = (x: Oklch) => y(x) >= ACCENT_Y.min && y(x) <= ACCENT_Y.max
  if (c.l >= a.minL && c.l <= a.maxL && c.c >= a.minC && yOk(c)) return hex.toLowerCase()
  const h = c.c < EPS ? DEFAULT_ACCENT_HUE : c.h
  let out: Oklch = { l: clampNum(c.l, a.minL + INSET, a.maxL - INSET), c: Math.max(c.c, a.minC + INSET), h, alpha: 1 }
  // Then move L (inside the band) until the luminance is in its window:
  // a saturated blue is too dark for the dark toolbar, a yellow too light
  // for the light one.
  const target = y(out) < ACCENT_Y.min ? ACCENT_Y.min + 0.005 : y(out) > ACCENT_Y.max ? ACCENT_Y.max - 0.005 : null
  if (target !== null) {
    let lo = a.minL + INSET, hi = a.maxL - INSET
    if (y(out) < target) lo = out.l; else hi = out.l
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (y({ ...out, l: mid }) < target) lo = mid; else hi = mid
    }
    out = { ...out, l: (lo + hi) / 2 }
    // The band can be too narrow for the window at some hues: then leave
    // the band rather than the window (readability wins).
    if (!yOk(out)) {
      let lo2 = 0, hi2 = 1
      for (let i = 0; i < 30; i++) {
        const mid = (lo2 + hi2) / 2
        if (y({ ...out, l: mid }) < target) lo2 = mid; else hi2 = mid
      }
      out = { ...out, l: (lo2 + hi2) / 2 }
    }
  }
  return formatColor(out)
}

// ── Roles ──

export type ThemeMode = 'light' | 'dark'

/** The user's picks (settings.json); null = the default. */
export type ThemePicks = { accent: string | null; lightBase: string | null; darkBase: string | null }

/** Neutral roles follow the base; text roles take less of its tint. */
const NEUTRAL_ROLES = [
  'background', 'content', 'elevated', 'elevated-hover', 'toolbar', 'toolbar-hover', 'surface',
  'surface-raised', 'canvas', 'scrim', 'hover-overlay', 'fill', 'fill-hover', 'fill-active',
  'control', 'control-hover', 'line-subtle', 'line', 'line-strong',
  'fg', 'fg-secondary', 'fg-tertiary', 'fg-disabled', 'fg-faint',
] as const
const TEXT_ROLES = new Set(['fg', 'fg-secondary', 'fg-tertiary', 'fg-disabled', 'fg-faint'])
/** Share of the base's chroma the text roles take (surfaces, fills and
 *  lines take all of it). */
const TEXT_TINT = 0.3
/** `accent-text` and `focus` are `var(--color-accent)` in index.css and
 *  follow the accent on their own. */
const ACCENT_ROLES = ['accent', 'accent-hover', 'accent-subtle', 'accent-muted', 'accent-text-hover'] as const

/** Today's values of the derived roles, per mode, exactly as in
 *  src/index.css (a test keeps the two in step). */
export const DEFAULTS: Record<ThemeMode, Record<string, string>> = {
  dark: {
    'background': '#131313',
    'content': '#0e0e0e',
    'elevated': '#1d1d1d',
    'elevated-hover': '#282828',
    'toolbar': '#151515',
    'toolbar-hover': '#212121',
    'surface': '#0e0e0e',
    'surface-raised': '#171717',
    'canvas': '#080808',
    'scrim': 'rgba(8, 8, 8, 0.72)',
    'hover-overlay': 'rgba(255, 255, 255, 0.05)',
    'fill': 'rgba(231, 231, 231, 0.068)',
    'fill-hover': 'rgba(231, 231, 231, 0.1)',
    'fill-active': 'rgba(231, 231, 231, 0.134)',
    'control': 'rgba(231, 231, 231, 0.068)',
    'control-hover': 'rgba(231, 231, 231, 0.1)',
    'line-subtle': 'rgba(231, 231, 231, 0.07)',
    'line': 'rgba(231, 231, 231, 0.12)',
    'line-strong': 'rgba(231, 231, 231, 0.22)',
    'fg': '#e7e7e7',
    'fg-secondary': '#b4b4b4',
    'fg-tertiary': '#888888',
    'fg-disabled': '#535353',
    'fg-faint': '#464646',
    'accent': '#7440d5',
    'accent-hover': '#6931c8',
    'accent-subtle': '#3e2d69',
    'accent-muted': '#211939',
    'accent-text-hover': 'oklch(0.64 0.2 293.5)',
    'on-accent': '#ffffff',
  },
  light: {
    'background': '#f5f5f5',
    'content': '#f0f0f0',
    'elevated': '#ffffff',
    'elevated-hover': '#f4f4f4',
    'toolbar': '#f7f7f7',
    'toolbar-hover': '#ececec',
    'surface': '#ffffff',
    'surface-raised': '#ffffff',
    'canvas': '#eeeeee',
    'scrim': 'rgba(29, 29, 29, 0.45)',
    'hover-overlay': 'rgba(0, 0, 0, 0.045)',
    'fill': 'rgba(29, 29, 29, 0.058)',
    'fill-hover': 'rgba(29, 29, 29, 0.095)',
    'fill-active': 'rgba(29, 29, 29, 0.129)',
    'control': '#ffffff',
    'control-hover': '#fafafa',
    'line-subtle': 'rgba(29, 29, 29, 0.1)',
    'line': 'rgba(29, 29, 29, 0.14)',
    'line-strong': 'rgba(29, 29, 29, 0.22)',
    'fg': '#1d1d1d',
    'fg-secondary': '#575757',
    'fg-tertiary': '#6a6a6a',
    'fg-disabled': '#b1b1b1',
    'fg-faint': '#c1c1c1',
    'accent': '#7440d5',
    'accent-hover': '#6931c8',
    'accent-subtle': '#d9d1fc',
    'accent-muted': '#e4dcfe',
    'accent-text-hover': 'oklch(0.40 0.21 293.5)',
    'on-accent': '#ffffff',
  },
}

const DEFAULT_ACCENT = '#7440d5'

/** The roles a mode's picks override (empty when nothing applies).
 *  `neutrals: false` (overlay and recording windows) skips the base. */
/** The highest lightness at which a colour of the base's hue keeps (nearly)
 *  all of the base's chroma inside sRGB. */
function tintCeiling(B: Oklch): number {
  if (B.c < EPS) return 1
  let lo = B.l, hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (toGamut({ l: mid, c: B.c, h: B.h, alpha: 1 }).c >= B.c * 0.95) lo = mid; else hi = mid
  }
  return lo
}

/** A saved pick as `#rrggbb`, else null: a hand-edited or malformed value
 *  means "default", never an exception (final review: one bad value used to
 *  break the preload in every window). */
export function validPick(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null
}

export function deriveRoles(raw: ThemePicks, mode: ThemeMode, opts: { neutrals: boolean }): Record<string, string> {
  const picks: ThemePicks = { accent: validPick(raw?.accent), lightBase: validPick(raw?.lightBase), darkBase: validPick(raw?.darkBase) }
  const out: Record<string, string> = {}
  const defaults = DEFAULTS[mode]

  const basePick = mode === 'dark' ? picks.darkBase : picks.lightBase
  if (opts.neutrals && basePick) {
    // Every neutral keeps its step; the whole set moves by the base's
    // brightness against today's background, and takes the base's tint.
    const B = parseColor(clampBase(basePick, mode))
    const D = parseColor(defaults.background)
    // Light mode (1a, 2026-11-22): white has no room for colour, so the
    // steps above the background are squeezed under the highest L that
    // still holds the base's tint (white itself for a grey base, so the
    // default stays exact). They keep their order and relative spacing.
    // At most 0.985 once the base has a visible tint (scaled in from grey),
    // so the white surfaces read as tinted next to the rows, not as white
    // (which looks like the opposite colour beside them).
    const cap = mode === 'light' ? Math.min(tintCeiling(B), 1 - 0.015 * clampNum(B.c / 0.008, 0, 1)) : 1
    const squeeze = (cap - B.l) / (1 - D.l)
    for (const role of NEUTRAL_ROLES) {
      const R = parseColor(defaults[role])
      const l = mode === 'light' && R.l > D.l ? B.l + (R.l - D.l) * squeeze : R.l + (B.l - D.l)
      out[role] = formatColor({
        l: clampNum(l, 0, 1),
        c: B.c * (TEXT_ROLES.has(role) ? TEXT_TINT : 1),
        h: B.h,
        alpha: R.alpha,
      })
    }
  }

  if (picks.accent) {
    // Each accent role keeps its chroma ratio and hue offset from today's
    // accent. The accent and its hovers move by the pick's lightness; the
    // selected fills (accent-subtle, accent-muted) keep today's L, as the
    // spec says, so they never wash out to white (final review).
    const A = parseColor(clampAccent(picks.accent))
    const A0 = parseColor(DEFAULT_ACCENT)
    for (const role of ACCENT_ROLES) {
      const R = parseColor(defaults[role])
      const keepL = role === 'accent-subtle' || role === 'accent-muted'
      out[role] = formatColor({
        l: keepL ? R.l : clampNum(R.l + (A.l - A0.l), 0, 1),
        c: R.c * (A.c / A0.c),
        h: (R.h + (A.h - A0.h) + 360) % 360,
        alpha: R.alpha,
      })
    }
    out['on-accent'] = contrast('#ffffff', out.accent) >= contrast('#080808', out.accent) ? '#ffffff' : '#080808'
  }
  return out
}

/** The CSS for a window: dark overrides on `:root:not(.light)`, light on
 *  `html.light.light` (both beat `@theme` and index.css's `html.light`
 *  without the dark block reaching light mode). Empty when nothing is
 *  overridden. */
export function themeCss(picks: ThemePicks, opts: { neutrals: boolean }): string {
  const block = (selector: string, roles: Record<string, string>) => {
    const decls = Object.entries(roles).map(([k, v]) => `--color-${k}: ${v};`).join(' ')
    return decls ? `${selector} { ${decls} }` : ''
  }
  return [
    block(':root:not(.light)', deriveRoles(picks, 'dark', opts)),
    block('html.light.light', deriveRoles(picks, 'light', opts)),
  ].filter(Boolean).join('\n')
}

// ── Presets (Settings › Appearance), each inside its band (a test checks).
//    The default swatch (null) comes first in the UI and isn't listed. ──

// One column per hue across the three rows (2026-11-22): blue, cyan, green,
// orange, pink. The bases take each accent's hue: light at L .962 C .012,
// dark at L .215 C .026.
// Accents all take white text: cyan, green and orange darkened along their
// hue into that range (2026-11-22; were #0891b2, #2f9e44, #e8590c).
export const ACCENT_PRESETS = ['#2563eb', '#007f9c', '#04872d', '#ca4a00', '#d6336c']
export const LIGHT_BASE_PRESETS = ['#eef3fb', '#eaf4f8', '#eef5ee', '#faf0ec', '#faeff1']
export const DARK_BASE_PRESETS = ['#131926', '#0b1c22', '#111d12', '#241510', '#241418']

// ── Custom picker (Settings › Appearance): a field of tint strength (x) ×
//    brightness (y, top = lightest) at one hue, holding only colours that
//    can be had. Each point is drawn as its clamped colour, so what is shown
//    is what is picked. ──

export type PickerKind = 'accent' | 'light' | 'dark'

export const PICKER_RANGES: Record<PickerKind, { minL: number; maxL: number; minC: number; maxC: number }> = {
  accent: { minL: BANDS.accent.minL, maxL: BANDS.accent.maxL, minC: BANDS.accent.minC, maxC: 0.3 },
  light: { minL: BANDS.light.minL, maxL: BANDS.light.maxL, minC: 0, maxC: BANDS.baseMaxC },
  dark: { minL: BANDS.dark.minL, maxL: BANDS.dark.maxL, minC: 0, maxC: BANDS.baseMaxC },
}

const clampFor = (kind: PickerKind, hex: string) => (kind === 'accent' ? clampAccent(hex) : clampBase(hex, kind))

/** The picker's field: a theme band, or `free` (the image editor's Custom
 *  colour, 2026-11-24): any colour, saturation (x) by brightness (y, top =
 *  brightest) in HSV, white at the top left and black along the bottom. */
export type FieldKind = PickerKind | 'free'

const hex2 = (v: number) => Math.round(clampNum(v, 0, 1) * 255).toString(16).padStart(2, '0')

/** HSV (h 0..360, s and v 0..1) to `#rrggbb`. */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + (((h % 360) + 360) % 360) / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return `#${hex2(f(5))}${hex2(f(3))}${hex2(f(1))}`
}

/** `#rrggbb` to HSV; a grey keeps hue 0. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 0, s: 0, v: 0 }
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max }
}

/** The pick at field point (x, y) in 0..1 for hue `h`, already clamped. */
export function fieldToPick(kind: FieldKind, x: number, y: number, h: number): string {
  if (kind === 'free') return hsvToHex(h, clampNum(x, 0, 1), 1 - clampNum(y, 0, 1))
  const r = PICKER_RANGES[kind]
  const raw = formatColor({ l: r.maxL - clampNum(y, 0, 1) * (r.maxL - r.minL), c: r.minC + clampNum(x, 0, 1) * (r.maxC - r.minC), h, alpha: 1 })
  return clampFor(kind, raw)
}

/** Where a pick sits in the field (for the marker), and its hue. */
export function pickToField(kind: FieldKind, hex: string): { x: number; y: number; h: number } {
  if (kind === 'free') { const c = hexToHsv(hex); return { x: c.s, y: 1 - c.v, h: c.h } }
  const r = PICKER_RANGES[kind]
  const c = parseColor(hex)
  return {
    x: clampNum((c.c - r.minC) / (r.maxC - r.minC), 0, 1),
    y: clampNum((r.maxL - c.l) / (r.maxL - r.minL), 0, 1),
    h: c.h,
  }
}

/** 0..255 channels of a colour (for drawing the field on a canvas). */
export function toRgb255(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
