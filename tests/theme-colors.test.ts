import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseColor, formatColor, clampBase, clampAccent, contrast, BANDS, DEFAULTS, deriveRoles, themeCss, ACCENT_PRESETS, LIGHT_BASE_PRESETS, DARK_BASE_PRESETS, fieldToPick, pickToField, PICKER_RANGES, hsvToHex, hexToHsv } from '../shared/theme-colors.ts'

// ── Task 1: colour maths and clamps ──

test('hex round-trips through OKLCH', () => {
  for (const hex of ['#7440d5', '#131313', '#f5f5f5', '#ffffff', '#000000']) assert.equal(formatColor(parseColor(hex)), hex)
})

test('rgba keeps its alpha', () => {
  assert.equal(formatColor(parseColor('rgba(231, 231, 231, 0.12)')), 'rgba(231, 231, 231, 0.12)')
})

test('oklch() parses to the same colour as its hex', () => {
  // the default accent's hover in index.css
  const a = parseColor('oklch(0.64 0.2 293.5)')
  assert.ok(Math.abs(a.l - 0.64) < 1e-6 && Math.abs(a.c - 0.2) < 1e-6 && Math.abs(a.h - 293.5) < 1e-6)
})

test('a dark base outside the band is clamped into it', () => {
  const l = parseColor(clampBase('#ffffff', 'dark')).l
  assert.ok(l <= BANDS.dark.maxL + 1e-3 && l >= BANDS.dark.minL - 1e-3, String(l))
})

test('a light base is clamped into the light band and its chroma capped', () => {
  const c = parseColor(clampBase('#ff0000', 'light'))
  assert.ok(c.l >= BANDS.light.minL - 1e-3, String(c.l))
  assert.ok(c.c <= BANDS.baseMaxC + 1e-3, String(c.c))
})

test('an in-band base is unchanged', () => {
  assert.equal(clampBase('#131313', 'dark'), '#131313')
  assert.equal(clampBase('#f5f5f5', 'light'), '#f5f5f5')
})

test('the default accent is a fixed point', () => assert.equal(clampAccent('#7440d5'), '#7440d5'))

test('a grey accent becomes a valid in-band colour', () => {
  const c = parseColor(clampAccent('#808080'))
  assert.ok(Number.isFinite(c.h) && c.c >= BANDS.accent.minC - 1e-3, JSON.stringify(c))
})

test('contrast matches WCAG for black on white', () => assert.equal(Math.round(contrast('#000000', '#ffffff')), 21))

// ── Task 2: role derivation and CSS ──

/** --color-* values from src/index.css: dark = @theme, light = html.light
 *  over dark. */
function cssRoles(): Record<'dark' | 'light', Record<string, string>> {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const block = (start: string) => {
    const i = css.indexOf(start)
    const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i))
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    return out
  }
  const dark = block('@theme {')
  return { dark, light: { ...dark, ...block('html.light {') } }
}
const same = (a: string, b: string) => formatColor(parseColor(a)) === formatColor(parseColor(b))
const NONE = { accent: null, lightBase: null, darkBase: null }
const STATUS = ['danger-text', 'warning-text', 'success-text', 'kind-image', 'kind-video']

test('nothing picked produces no CSS', () => {
  assert.equal(themeCss(NONE, { neutrals: true }), '')
})

test('DEFAULTS match src/index.css', () => {
  const css = cssRoles()
  for (const mode of ['dark', 'light'] as const) {
    for (const [role, value] of Object.entries(DEFAULTS[mode])) assert.equal(value, css[mode][role], `${mode} ${role}`)
  }
})

test('picking the defaults reproduces the defaults', () => {
  for (const mode of ['dark', 'light'] as const) {
    const base = mode === 'dark' ? { darkBase: '#131313' } : { lightBase: '#f5f5f5' }
    const r = deriveRoles({ ...NONE, accent: '#7440d5', ...base }, mode, { neutrals: true })
    assert.ok(Object.keys(r).length > 20)
    for (const [k, v] of Object.entries(r)) assert.ok(same(v, DEFAULTS[mode][k]), `${mode} ${k}: ${v} vs ${DEFAULTS[mode][k]}`)
  }
})

test('the light base only touches light mode', () => {
  assert.deepEqual(deriveRoles({ ...NONE, lightBase: '#e8eefa' }, 'dark', { neutrals: true }), {})
})

test('neutrals stay out of overlay windows', () => {
  const r = deriveRoles({ accent: '#2f7d4f', lightBase: null, darkBase: '#101828' }, 'dark', { neutrals: false })
  assert.ok(!('background' in r) && 'accent' in r)
})

test('the accent-derived roles follow the pick', () => {
  const r = deriveRoles({ ...NONE, accent: '#2f7d4f' }, 'dark', { neutrals: false })
  const hue = parseColor('#2f7d4f').h
  for (const k of ['accent', 'accent-hover', 'accent-subtle', 'accent-text-hover']) {
    assert.ok(Math.abs(parseColor(r[k]).h - hue) < 8, `${k} ${r[k]}`)
  }
})

test('every accent takes white text (lighter picks are darkened into that range)', () => {
  for (const pick of ['#7440d5', ...ACCENT_PRESETS, '#c9a227', '#ffff00', '#00ff00', '#0891b2', '#ffffff', '#808080']) {
    const r = deriveRoles({ ...NONE, accent: pick }, 'dark', { neutrals: false })
    assert.equal(r['on-accent'], '#ffffff', `${pick} -> ${r.accent}`)
    assert.ok(contrast('#ffffff', r.accent) > contrast('#080808', r.accent), `${pick} -> ${r.accent}`)
  }
})

test('a darkened accent keeps its hue', () => {
  const pick = '#2f9e44'
  assert.ok(Math.abs(parseColor(clampAccent(pick)).h - parseColor(pick).h) < 4)
})

/** A base at each edge of its band, tinted blue at the chroma cap. */
function edgeBases(mode: 'dark' | 'light') {
  const b = BANDS[mode]
  return [b.minL, b.maxL].map(l => clampBase(formatColor({ l, c: BANDS.baseMaxC, h: 250, alpha: 1 }), mode))
}

test('status colours stay readable at the band edges', () => {
  const css = cssRoles()
  for (const mode of ['dark', 'light'] as const) {
    for (const base of edgeBases(mode)) {
      const r = deriveRoles({ ...NONE, [mode === 'dark' ? 'darkBase' : 'lightBase']: base }, mode, { neutrals: true })
      for (const status of STATUS) for (const ground of ['toolbar', 'elevated', 'content']) {
        const ratio = contrast(css[mode][status], r[ground])
        assert.ok(ratio >= 3, `${mode} base ${base}: ${status} on ${ground} = ${ratio.toFixed(2)}`)
      }
    }
  }
})

test('text stays readable at the band edges', () => {
  for (const mode of ['dark', 'light'] as const) {
    for (const base of edgeBases(mode)) {
      const r = deriveRoles({ ...NONE, [mode === 'dark' ? 'darkBase' : 'lightBase']: base }, mode, { neutrals: true })
      assert.ok(contrast(r.fg, r.background) >= 7, `${mode} ${base}: fg/background ${contrast(r.fg, r.background).toFixed(2)}`)
      assert.ok(contrast(r['fg-secondary'], r.toolbar) >= 4.5, `${mode} ${base}: fg-secondary/toolbar ${contrast(r['fg-secondary'], r.toolbar).toFixed(2)}`)
    }
  }
})

// ── Task 5: presets ──

test('every preset sits inside its band (clamping leaves it as is)', () => {
  for (const p of ACCENT_PRESETS) assert.equal(clampAccent(p), p, `accent ${p}`)
  for (const p of LIGHT_BASE_PRESETS) assert.equal(clampBase(p, 'light'), p, `light ${p}`)
  for (const p of DARK_BASE_PRESETS) assert.equal(clampBase(p, 'dark'), p, `dark ${p}`)
  for (const list of [ACCENT_PRESETS, LIGHT_BASE_PRESETS, DARK_BASE_PRESETS]) assert.equal(list.length, 5)
})

// ── Final review fixes ──

test('a malformed saved pick is ignored, never thrown', () => {
  for (const bad of ['#fff', '', 'red', 'not a colour']) {
    assert.equal(themeCss({ accent: bad, lightBase: bad, darkBase: bad }, { neutrals: true }), '', bad)
  }
})

test('no fill step collapses at the band edges', () => {
  for (const mode of ['dark', 'light'] as const) {
    for (const base of edgeBases(mode)) {
      const r = deriveRoles({ ...NONE, [mode === 'dark' ? 'darkBase' : 'lightBase']: base }, mode, { neutrals: true })
      assert.notEqual(r.elevated, r.toolbar, `${mode} ${base}: elevated = toolbar`)
      if (mode === 'light') assert.notEqual(r.control, r['control-hover'], `${mode} ${base}: control = control-hover`)
      assert.notEqual(r['elevated-hover'], r.elevated, `${mode} ${base}: elevated-hover = elevated`)
    }
  }
})

test('selected fills (accent-subtle, accent-muted) stay visible for every preset', () => {
  for (const accent of ['#7440d5', ...ACCENT_PRESETS]) {
    const r = deriveRoles({ ...NONE, accent }, 'light', { neutrals: false })
    assert.ok(contrast(r['accent-subtle'], DEFAULTS.light.control) >= 1.3, `${accent} subtle ${r['accent-subtle']}`)
    assert.ok(contrast(r['accent-muted'], DEFAULTS.light.background) >= 1.1, `${accent} muted ${r['accent-muted']}`)
  }
})

test('the accent reads as text on both default toolbars, whatever is picked', () => {
  for (const pick of ['#7440d5', ...ACCENT_PRESETS, '#0000ff', '#00ff00', '#ffff00', '#000000', '#ffffff', '#808080']) {
    const a = clampAccent(pick)
    for (const mode of ['dark', 'light'] as const) {
      const ratio = contrast(a, DEFAULTS[mode].toolbar)
      assert.ok(ratio >= 2.7, `${pick} -> ${a} on ${mode} toolbar ${ratio.toFixed(2)}`)
    }
  }
})

// ── 1a: white surfaces carry the light base's tint ──

test('white surfaces take the light base tint and stay the lightest layer', () => {
  for (const base of LIGHT_BASE_PRESETS) {
    const b = parseColor(base)
    const r = deriveRoles({ ...NONE, lightBase: base }, 'light', { neutrals: true })
    for (const role of ['elevated', 'control', 'surface']) {
      const c = parseColor(r[role])
      assert.ok(c.c >= b.c * 0.8, `${base} ${role} ${r[role]} chroma ${c.c.toFixed(4)} vs base ${b.c.toFixed(4)}`)
      assert.ok(c.l > parseColor(r.toolbar).l, `${base} ${role} not above toolbar`)
      // a visible step below white, so it reads as tinted next to the rows
      assert.ok(c.l <= 0.987, `${base} ${role} ${r[role]} L ${c.l.toFixed(4)} too close to white`)
    }
    assert.ok(parseColor(r['control-hover']).l < parseColor(r.control).l, `${base} control-hover not below control`)
  }
})

// ── Custom picker: only colours that can be had ──

test('every point of the picker field is a valid pick, shown as is', () => {
  const clampOf = { accent: clampAccent, light: (h: string) => clampBase(h, 'light'), dark: (h: string) => clampBase(h, 'dark') }
  for (const kind of ['accent', 'light', 'dark'] as const) {
    for (const h of [0, 90, 155, 250, 330]) for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) {
      const hex = fieldToPick(kind, x, y, h)
      assert.equal(clampOf[kind](hex), hex, `${kind} x${x} y${y} h${h} -> ${hex}`)
    }
  }
})

test('a pick maps back to (about) the same field point', () => {
  for (const kind of ['light', 'dark'] as const) {
    const hex = fieldToPick(kind, 0.6, 0.3, 155)
    const p = pickToField(kind, hex)
    assert.ok(Math.abs(p.x - 0.6) < 0.08 && Math.abs(p.y - 0.3) < 0.08 && Math.abs(p.h - 155) < 6, `${kind} ${JSON.stringify(p)}`)
  }
  assert.ok(PICKER_RANGES.light.maxL <= BANDS.light.maxL && PICKER_RANGES.dark.maxC <= BANDS.baseMaxC)
})

test('the preset columns share their hue across the rows (blue, cyan, green, orange, pink)', () => {
  const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  ACCENT_PRESETS.forEach((accent, i) => {
    const h = parseColor(accent).h
    for (const base of [LIGHT_BASE_PRESETS[i], DARK_BASE_PRESETS[i]]) {
      assert.ok(hueGap(parseColor(base).h, h) < 8, `column ${i}: ${accent} vs ${base}`)
    }
  })
  // cyan, not teal: between green and blue, closer to blue
  const cyan = parseColor(ACCENT_PRESETS[1]).h
  assert.ok(cyan > 200 && cyan < 235, `cyan hue ${cyan.toFixed(0)}`)
})

test('the free field reaches any colour: white top left, black at the bottom, pure hues top right', () => {
  assert.equal(fieldToPick('free', 0, 0, 200), '#ffffff')
  assert.equal(fieldToPick('free', 0.4, 1, 200), '#000000')
  assert.equal(fieldToPick('free', 1, 0, 0), '#ff0000')
  assert.equal(fieldToPick('free', 1, 0, 120), '#00ff00')
  assert.equal(fieldToPick('free', 1, 0, 240), '#0000ff')
  assert.equal(hsvToHex(360, 1, 1), '#ff0000')
})

test('a free pick maps back to its field point', () => {
  for (const hex of ['#ee3533', '#fe860f', '#2896f5', '#822dda', '#40d872', '#808080', '#ffffff', '#000000']) {
    const p = pickToField('free', hex)
    assert.equal(fieldToPick('free', p.x, p.y, p.h), hex, hex)
  }
  assert.deepEqual(hexToHsv('#808080').h, 0)
})

// ── kind-video-hover (2026-11-27) ──

test('kind-video-hover is the accent → accent-hover step from kind-video, in both themes', () => {
  // Jasper: the recording's Stop must change under the pointer exactly as an
  // accent button does. Same OKLCH deltas (L, C, H) in each theme.
  const css = cssRoles()
  for (const mode of ['dark', 'light'] as const) {
    const r = css[mode]
    // accent-text is var(--color-accent) in the CSS; accent itself is a hex.
    const [a, ah, k, kh] = [r.accent, r['accent-hover'], r['kind-video'], r['kind-video-hover']].map(parseColor)
    assert.ok(Math.abs((kh.l - k.l) - (ah.l - a.l)) < 1e-3, `${mode} L: ${kh.l - k.l} vs ${ah.l - a.l}`)
    assert.ok(Math.abs((kh.c - k.c) - (ah.c - a.c)) < 1e-3, `${mode} C: ${kh.c - k.c} vs ${ah.c - a.c}`)
    assert.ok(Math.abs((kh.h - k.h) - (ah.h - a.h)) < 0.05, `${mode} H: ${kh.h - k.h} vs ${ah.h - a.h}`)
  }
})
