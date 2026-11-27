# Custom Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Appearance lets the user pick an accent (both modes), a light base and a dark base; Lumia derives every colour role from them.

**Architecture:** One dependency-free colour module (`shared/theme-colors.ts`) turns the picks into CSS variable overrides by tinting today's tuned role values (approach A). Main hands the saved picks to every window's preload synchronously, the preload writes one `<style id="lumia-theme">` before first paint, and main broadcasts changes so every window (pooled overlays included) restyles live. Nothing picked = no overrides.

**Tech Stack:** Electron 42, React 19, Tailwind CSS 4 (CSS variables `--color-*` in `src/index.css`), TypeScript, `node --test` unit tests.

**Spec:** `design/CUSTOM-THEMES.md`

## Global Constraints

- Nothing picked (`null`) → no variable overridden; today's `index.css` applies untouched.
- OKLCH for all colour work; results gamut-clipped into sRGB by reducing chroma.
- Dark base band: L 0.12–0.30. Light base band: L 0.90–0.99. Base chroma cap 0.06 (starting values; tune by eye, tests must still pass).
- Accent: L clamped 0.45–0.65, chroma ≥ 0.08. One accent for both modes.
- Text roles' chroma factor starts at 0.3 of the base's chroma; surfaces, fills, lines 1.0.
- Status roles never change: `danger*`, `warning*` (incl. `warning-line`), `success*`, `kind-*`, `tooltip*`, `brand-end`. The logo (`src/assets/logo.svg`) stays purple.
- Picking a base for the mode that isn't showing never switches the mode. Only the AppBar moon/sun changes the mode.
- Accent roles apply in every window; neutral (base) roles only in the main window. Overlay / recording windows keep fixed dark neutrals.
- Copy: labels start with a verb; no em dashes; tooltips one word ("Reset"). Rows: "Choose accent" · "Selected items, on states and dots." / "Choose light base" · "Tints the window in light mode." / "Choose dark base" · "Tints the window in dark mode."
- No transitions or animations; hover rules per CLAUDE.md (framed button `hover:bg-elevated-hover hover:text-fg`).
- Never commit: Jasper commits himself. Each task ends with tests + type-check instead.
- Type-check: `pnpm exec tsc --noEmit -p tsconfig.web.json` and `-p tsconfig.node.json`; ignore the existing TS2882 CSS-import and `logo.svg` errors.
- Main / preload changes need a `pnpm dev` restart (no `--watch`).

## Review Focus

- A pure grey Custom accent (chroma 0, hue undefined): must come out as a valid in-band accent, not NaN. Test in Task 1.
- A Custom base far outside its band (white picked as dark base): clamps into the band, swatch shows the clamped colour. Test in Task 1.
- Status text / icons on a base at either band edge stay readable (≥ 3:1 against `toolbar`, `elevated`, `content`). Test in Task 2.
- `index.css` defaults edited later without updating the module's default table: drift must fail a test. Test in Task 2.
- A theme change while capture overlays are parked: they must pick up the new accent without a restart. Manual check in Task 3.

---

### Task 1: Colour math and clamps

**Files:**
- Create: `shared/theme-colors.ts`
- Test: `tests/theme-colors.test.ts`
- Modify: `tsconfig.web.json`, `tsconfig.node.json` (add `"shared/**/*"` to `include`)

**Interfaces:**
- Produces:
  - `type Oklch = { l: number; c: number; h: number; alpha: number }`
  - `parseColor(css: string): Oklch` (accepts `#rrggbb`, `rgba(r, g, b, a)`, `oklch(L C H)`)
  - `formatColor(c: Oklch): string` (`#rrggbb` when alpha is 1, else `rgba(r, g, b, a)` with a rounded to 3 places)
  - `toGamut(c: Oklch): Oklch` (lower chroma until sRGB-representable)
  - `contrast(a: string, b: string): number` (WCAG ratio, alpha composited over `b`)
  - `clampBase(hex: string, mode: 'light' | 'dark'): string`
  - `clampAccent(hex: string): string`
  - `BANDS = { dark: { minL: 0.12, maxL: 0.30 }, light: { minL: 0.90, maxL: 0.99 }, baseMaxC: 0.06, accent: { minL: 0.45, maxL: 0.65, minC: 0.08 } }`

The module imports nothing (tests and both tsconfigs load it directly).

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseColor, formatColor, clampBase, clampAccent, contrast, BANDS } from '../shared/theme-colors.ts'

test('hex round-trips through OKLCH', () => {
  for (const hex of ['#7440d5', '#131313', '#f5f5f5', '#ffffff', '#000000']) assert.equal(formatColor(parseColor(hex)), hex)
})
test('rgba keeps its alpha', () => {
  assert.equal(formatColor(parseColor('rgba(231, 231, 231, 0.12)')), 'rgba(231, 231, 231, 0.12)')
})
test('a dark base outside the band is clamped into it', () => {
  const l = parseColor(clampBase('#ffffff', 'dark')).l
  assert.ok(l <= BANDS.dark.maxL + 1e-3 && l >= BANDS.dark.minL - 1e-3)
})
test('a light base is clamped into the light band and its chroma capped', () => {
  const c = parseColor(clampBase('#ff0000', 'light'))
  assert.ok(c.l >= BANDS.light.minL - 1e-3 && c.c <= BANDS.baseMaxC + 1e-3)
})
test('an in-band base is unchanged', () => {
  assert.equal(clampBase('#131313', 'dark'), '#131313')
  assert.equal(clampBase('#f5f5f5', 'light'), '#f5f5f5')
})
test('the default accent is a fixed point', () => assert.equal(clampAccent('#7440d5'), '#7440d5'))
test('a grey accent becomes a valid in-band colour', () => {
  const c = parseColor(clampAccent('#808080'))
  assert.ok(Number.isFinite(c.h) && c.c >= BANDS.accent.minC - 1e-3)
})
test('contrast matches WCAG for black on white', () => assert.equal(Math.round(contrast('#000000', '#ffffff')), 21))
```

- [ ] **Step 2: Run `pnpm test` — expected FAIL** (module not found).
- [ ] **Step 3: Implement** the listed exports in `shared/theme-colors.ts`. sRGB ↔ OKLab per Björn Ottosson's published matrices; OKLCH from OKLab. Grey picks (c < 1e-4) take hue 293.5 (the default accent's) before the chroma floor applies. Add `shared/**/*` to both tsconfig `include` arrays.
- [ ] **Step 4: Run `pnpm test` — expected PASS**; run both type-checks.

---

### Task 2: Role derivation and CSS

**Files:**
- Modify: `shared/theme-colors.ts`
- Test: `tests/theme-colors.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `type ThemePicks = { accent: string | null; lightBase: string | null; darkBase: string | null }`
  - `DEFAULTS: Record<'dark' | 'light', Record<string, string>>`: the current value of every neutral and accent role per mode, copied from `src/index.css` (role name without `--color-`). Neutral roles: `background content elevated elevated-hover toolbar toolbar-hover surface surface-raised canvas scrim hover-overlay fill fill-hover fill-active control control-hover line-subtle line line-strong fg fg-secondary fg-tertiary fg-disabled fg-faint`. Accent roles: `accent accent-hover accent-subtle accent-muted accent-text accent-text-hover on-accent focus`.
  - `deriveRoles(picks: ThemePicks, mode: 'light' | 'dark', opts: { neutrals: boolean }): Record<string, string>`: only the overridden roles (empty object when nothing applies).
  - `themeCss(picks: ThemePicks, opts: { neutrals: boolean }): string`: dark overrides under `:root:not(.light)`, light under `html.light.light` (specificity beats `@theme` and `html.light` without the dark block leaking into light). Empty string when nothing is overridden.

Derivation (the one algorithm the signatures don't fix):
- Neutrals, base B (clamped) vs the mode's default `background` D: for each role default R: L = R.l + (B.l − D.l), C = B.c × factor (text roles 0.3, others 1.0), H = B.h, alpha = R.alpha; clamp L to 0..1; `toGamut`.
- Accent roles, pick A (clamped) vs default accent A0 = `#7440d5`: for each role default R in that mode: L = R.l + (A.l − A0.l), C = R.c × (A.c / A0.c), H = R.h + (A.h − A0.h); `toGamut`. `accent-text` and `focus` stay `var(--color-accent)`. `on-accent` = `#ffffff` or `#080808`, whichever has the higher `contrast` with the accent.

- [ ] **Step 1: Write the failing tests**

```ts
test('nothing picked produces no CSS', () => {
  assert.equal(themeCss({ accent: null, lightBase: null, darkBase: null }, { neutrals: true }), '')
})
test('picking the defaults reproduces the defaults', () => {
  const r = deriveRoles({ accent: '#7440d5', lightBase: null, darkBase: '#131313' }, 'dark', { neutrals: true })
  for (const [k, v] of Object.entries(r)) if (k !== 'accent-text' && k !== 'focus') assert.equal(v, DEFAULTS.dark[k], k)
})
test('the light base only touches light mode', () => {
  assert.deepEqual(deriveRoles({ accent: null, lightBase: '#e8eefa', darkBase: null }, 'dark', { neutrals: true }), {})
})
test('neutrals stay out of overlay windows', () => {
  const r = deriveRoles({ accent: '#2f7d4f', lightBase: null, darkBase: '#101828' }, 'dark', { neutrals: false })
  assert.ok(!('background' in r) && 'accent' in r)
})
test('DEFAULTS match src/index.css', () => {
  // read src/index.css, take each --color-<role> from @theme (dark) and html.light (light;
  // falling back to dark when light doesn't set it), compare to DEFAULTS
})
test('status colours stay readable at the band edges', () => {
  // for each mode and each band edge (minL, maxL) with hue 250 and the chroma cap:
  // derive roles, then for each of danger-text, warning-text, success-text, kind-image, kind-video
  // (values from index.css for that mode) assert contrast >= 3 against toolbar, elevated and content
})
test('text stays readable at the band edges', () => {
  // same edges: contrast(fg, background) >= 7 and contrast(fg-secondary, toolbar) >= 4.5
})
test('on-accent picks the more readable label', () => {
  assert.equal(deriveRoles({ accent: '#7440d5', lightBase: null, darkBase: null }, 'dark', { neutrals: false })['on-accent'], '#ffffff')
  assert.equal(deriveRoles({ accent: '#f2c94c', lightBase: null, darkBase: null }, 'dark', { neutrals: false })['on-accent'], '#080808')
})
```

The three comment-bodied tests: write the loops as described; values come from `src/index.css`, read with `fs.readFileSync` in the test.

- [ ] **Step 2: Run `pnpm test` — expected FAIL.**
- [ ] **Step 3: Implement** `DEFAULTS`, `deriveRoles`, `themeCss`.
- [ ] **Step 4: Run `pnpm test` — expected PASS.** If a band-edge test fails, narrow the band in `BANDS` (not the threshold) and update the spec's values.

---

### Task 3: Settings, main, preload: apply everywhere before first paint

**Files:**
- Modify: `electron/settings.ts`, `electron/index.ts`, `electron/preload/index.ts`, `src/electron.d.ts`, `src/hooks/useTheme.ts`

**Interfaces:**
- Consumes: `themeCss`, `deriveRoles`, `ThemePicks` from `shared/theme-colors.ts`.
- Produces:
  - `AppSettings.themeAccent: string | null`, `themeLightBase: string | null`, `themeDarkBase: string | null` (defaults `null`).
  - IPC `theme:initial` (sync, `ipcMain.on` + `event.returnValue`): `{ mode: 'light' | 'dark'; picks: ThemePicks; neutrals: boolean }`; `neutrals` is true only for the main window's webContents.
  - Event `theme:changed` sent to every window: `{ picks: ThemePicks }`.
  - `getThemePicks(): ThemePicks` in `electron/settings.ts`.

- [ ] **Step 1:** Add the three settings fields (default `null`) and `getThemePicks()`.
- [ ] **Step 2:** In `electron/index.ts`: handle `theme:initial`; in `settings:set`, for the three theme keys send `theme:changed` to every `BrowserWindow.getAllWindows()` and re-apply the title bar. `titlebar:setTheme` and the main window's `backgroundColor` use `deriveRoles(getThemePicks(), mode, { neutrals: true })` values for `toolbar`, `fg-secondary`, `background`, falling back to today's literals when a role isn't overridden.
- [ ] **Step 3:** In the preload, before `exposeInMainWorld`: `ipcRenderer.sendSync('theme:initial')`; when `neutrals` is true (main window only) toggle `html.light` from `mode` (overlay and recording windows stay dark); insert `<style id="lumia-theme">` with `themeCss(picks, { neutrals })` into `document.head ?? document.documentElement`; on `theme:changed` rewrite its text. Keep `neutrals` from the initial reply.
- [ ] **Step 4:** `useTheme`: initial `mode` from `document.documentElement.classList.contains('light')` (the preload already set it), so no dark-then-light flash; keep the existing `getSettings` sync as a fallback.
- [ ] **Step 5:** Type-check both projects; `pnpm test`.
- [ ] **Step 6: Manual check** (restart `pnpm dev`): set `themeAccent` to `#2f7d4f` via DevTools `electronAPI.setSetting('themeAccent', '#2f7d4f')`; Dashboard selection, Select strip and AppBar dot turn green at once; start a region capture: the overlay's toolbar is green; relaunch: no purple frame on start.

---

### Task 4: Capture overlay accent onto roles

**Files:**
- Modify: `src/windows/overlay/Overlay.tsx:51-57, ~582, ~604`

- [ ] **Step 1:** Replace every `rgba(182,160,255,a)` / `rgba(182, 160, 255, a)` with `color-mix(in oklab, var(--color-accent-text-hover) <a×100>%, transparent)` (the overlay is always dark, where `accent-text-hover` is the lightened accent). Leave the `record` (danger) colours.
- [ ] **Step 2:** Type-check; manual check: default theme overlay frame and hover highlight look as before (lavender-ish); with `#2f7d4f` they are green.

---

### Task 5: Settings › Appearance UI

**Files:**
- Modify: `src/windows/settings/Settings.tsx`
- Create: `src/components/ColorSwatches.tsx`

**Interfaces:**
- Consumes: `clampBase`, `clampAccent`, `ThemePicks` from `shared/theme-colors.ts`; `electronAPI.getSettings` / `setSetting`.
- Produces: `ColorSwatches({ value, presets, onChange, clamp, label }: { value: string | null; presets: (string | null)[]; onChange: (v: string | null) => void; clamp: (hex: string) => string; label: string })`; `null` = the default swatch.

- [ ] **Step 1:** Remove the Light / Dark Segmented row. Add three `Row`s in this order: Choose accent, Choose light base, Choose dark base, with the descriptions from Global Constraints. Right side: reset button (when value ≠ null; the hotkeys' framed `restart_alt` button, `data-tip="Reset"`, sets `null`), then `ColorSwatches`.
- [ ] **Step 2:** `ColorSwatches`: 6 swatches (first = `null`, drawn in the default colour) + a Custom button that opens a native `<input type="color">`; the chosen hex is passed through `clamp` before `onChange`, and every swatch renders its clamped colour. Selected swatch: 2px `ring-accent` ring with a 1px gap; changed-from-default dot as in the hotkeys keycap (`absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent`) on the Custom button when a custom value is active.
- [ ] **Step 3:** Presets: five per row besides the default, chosen by eye, each must satisfy `clamp(p) === p` (add a test in `tests/theme-colors.test.ts` that imports the preset arrays from `shared/theme-colors.ts`: export them there as `ACCENT_PRESETS`, `LIGHT_BASE_PRESETS`, `DARK_BASE_PRESETS`).
- [ ] **Step 4:** Writes go through `setSetting('themeAccent' | 'themeLightBase' | 'themeDarkBase', value)`; the window restyles from the `theme:changed` broadcast (no local style writes). Picking the inactive mode's base must not touch `theme`.
- [ ] **Step 5:** `pnpm test`, both type-checks; manual check in both modes: picking a dark base in light mode changes nothing visible but its swatch; flipping the moon/sun shows it.

---

Docs (CLAUDE.md colour section, `design/COLOR-ROLES.md`, STYLEGUIDE) wait for Jasper's end-of-session doc pass.
