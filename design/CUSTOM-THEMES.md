# Custom themes (Settings › Appearance)

Status: built (2026-11-22; plan `CUSTOM-THEMES-PLAN.md`, ledger `.superpowers/sdd/CUSTOM-THEMES-PLAN/`). Later the same
day: our own colour picker replaced the system panel, the accent presets keep to colours that take white text, the base
row shows for the current mode only, the changed-dot was dropped. Things drawn outside CSS read the roles at runtime
(`hooks/useRoleColors.ts`, 2026-11-23: the annotation canvas's selection frame and delete button).

## Intent

Users make Lumia match their desktop. They pick an **accent** and a **base**
colour; Lumia works out every other colour from those picks. Like Slack's
custom theme, but only the parts that make Lumia feel at home on the
desktop: no per-role pickers.

Settings › Appearance stops being a Light/Dark switch. Light or dark stays
on the AppBar's moon/sun button.

## Goals

- Three picks: accent (both modes), light base, dark base.
- Each pick: a row of preset swatches plus Custom (a colour picker).
- Nothing picked = exactly today's look, value for value.
- Whatever is picked stays readable: the picks are held inside brightness
  bands, and the tuned steps between fills, lines and text keep their
  spacing.

## Non-goals

- No per-role colour editing, no import/export or sharing of themes, no
  named saved themes.
- No "System" mode. The first launch takes the OS appearance (as today,
  `resolveFirstLaunchTheme`), then the user's last moon/sun pick sticks.
- The capture overlay, recording toolbar, recording border and drawing
  layer follow the whole theme since 2026-11-24 (light / dark and the
  base, `useFullTheme` in `electron/index.ts`); until then they kept fixed
  dark neutrals and only the accent followed the pick (2026-11-22).
- Status colours don't change: danger, warning, success, kind-image,
  kind-video, the tooltip (dark in both modes).

## Anti-goals (a failure even if it works)

- A pick that makes text, lines or the fill steps hard to tell apart.
- A flash of the default purple / grey before the user's theme applies.
- Defaults that drift from today's values once the system is in place.

## Decisions (Jasper, 2026-11-22)

- Purpose: match the user's desktop.
- One accent for both modes (the accent is already shared since
  2026-11-22).
- One base **per mode**: a light base and a dark base. Changing one leaves
  the other at its default.
- Light/dark stays a separate choice on the AppBar moon/sun; no mode row in
  Appearance.
- Each base is limited to a brightness band for its mode (a light base
  can't go dark, a dark base can't go light).
- Order in Appearance: accent, light base, dark base. Rows as today: label
  and description on the left, swatches + Custom on the right.
- Approach **A** (below).

## Approaches

**A. Tint today's tuned values (picked).** Every neutral role keeps its
current lightness step; it takes the base's hue and a chroma scaled from
the base's chroma. The base's own lightness (inside the band) shifts the
whole neutral set by an offset. The accent replaces `accent`, and its
derived roles are computed from it. Nothing picked = no overrides, so the
default is today's CSS untouched. Trade-off: a base can't change how far
apart the steps are, only their colour and overall brightness.

**B. Generate a new 12-step scale from the base (Radix-style) and map
roles onto it.** More principled, but today's values would have to be
re-created as the default and all contrast tuning (elevated / toolbar /
content, see-through lines) redone. Dropped.

**Presets only.** Dropped: Custom was asked for.

## How it works (A)

All colour work in OKLCH.

### Neutral roles (follow the base of the current mode)

Surfaces (`background`, `content`, `elevated`, `elevated-hover`,
`toolbar`, `toolbar-hover`, `surface`, `surface-raised`, `canvas`,
`scrim`), fills (`fill*`, `control*`, `hover-overlay`), lines
(`line-subtle`, `line`, `line-strong`, `warning-line` is status, leave it),
text (`fg`, `fg-secondary`, `fg-tertiary`, `fg-disabled`, `fg-faint`).

For each role, starting from its default value in the current mode:
- **Hue** = the base's hue.
- **Chroma** = base chroma × a per-group factor: surfaces 1, fills and
  lines 1 (their alpha stays as is; only the RGB part is tinted), text
  lower (builder's call, start at 0.3) so text stays near neutral.
- **Lightness** = default L + (base L − default base L), where the
  "default base" is the default `background` of that mode. Clamped to
  0..1. So a base exactly as bright as today's background leaves every L
  unchanged.
- Clip each result into sRGB gamut (reduce chroma until in gamut).

### Bands

- Dark base: L between 0.12 and 0.30. Light base: L between 0.90 and 0.99.
  (Starting values, builder's call; adjust by eye.)
- Chroma cap on the base: 0.06 in both modes (a tint, not a colour field).
- A Custom pick outside the band is clamped into it, and the swatch /
  preview shows the clamped colour, not the raw pick.

### Accent roles (both modes)

- `accent` = the pick, clamped to L 0.45..0.65 and chroma ≥ 0.08 (so it
  reads as a colour on both bases and white or black reads on it).
- `accent-hover` = L − 0.04 (today: #7440d5 → #6931c8).
- `accent-text` = `accent` (as today). `accent-text-hover` = L + 0.12,
  chroma × 0.9 (today's rule: L .52 → .64).
- `on-accent` = white or #080808, whichever contrasts more.
- `accent-subtle`, `accent-muted`: same hue as the pick, today's L and
  chroma ratios per mode.
- `focus` = `accent` (as today). The selection outline, dots and on-state
  strips already use these roles.
- `brand-end` (logo gradient end) stays. The logo (`src/assets/logo.svg`,
  `#7440d5` to cyan) does **not** follow the accent: it's the brand mark
  (Jasper, 2026-11-22).

### Defaults

With no pick (setting `null`) no variable is overridden: today's
`index.css` applies untouched. The default swatch in each row stands for
`null`, not for a hex value.

### Applying

- Computed in the renderer (`src/lib/theme-colors.ts`, pure functions, no
  Electron imports, unit-tested with `pnpm test`): picks + mode → a map
  of CSS variable → value.
- Written as one `<style id="lumia-theme">` rule on `:root` (dark) and
  `html.light` (light), so the existing `html.light` switch keeps working
  and the moon/sun flips instantly without recomputing.
- Before first paint: the picks must be available synchronously at
  startup (e.g. main passes them to the preload, which applies the style
  before React mounts). Today the theme itself is applied after an async
  `getSettings()`; fix that in the same step so mode and colours both land
  before the first frame.
- Every window gets the accent roles (the preload applies them in all
  windows, the pooled overlay renderers included, and updates them live
  when the accent changes). The main window, the capture overlays and the
  recording windows also get the base / neutral roles and light mode
  (`neutrals` in `theme:initial`; the pooled overlays get the current mode
  and picks at every open, 2026-11-24). The capture overlay's frame now
  wears the clip type colours, not the accent.
- Main window `backgroundColor` (index.ts, `#131313`) and the Windows
  `titleBarOverlay` colour / symbol colour (`titlebar:setTheme`) follow
  the current mode's computed `toolbar` / `fg-secondary` (and `background`
  for the window).

### Storage

`settings.json` (`AppSettings`): `themeAccent`, `themeLightBase`,
`themeDarkBase`, each a hex string or `null` (default). The raw pick is
stored; clamping happens on apply, so band changes later re-apply cleanly.

## Settings › Appearance UI

```
Appearance
┌──────────────────────────────────────────────────────────┐
│ Choose accent                     ● ● ● ● ● ●  [Custom]  │
│ Selected items, on states and dots.                      │
├──────────────────────────────────────────────────────────┤
│ Choose light base             ↺   ○ ● ● ● ● ●  [Custom]  │
│ Tints the window in light mode.                          │
├──────────────────────────────────────────────────────────┤
│ Choose dark base                  ● ● ● ● ● ●  [Custom]  │
│ Tints the window in dark mode.                           │
└──────────────────────────────────────────────────────────┘
```

- Uses the existing `Row` / `Group` components.
- Swatches: about six per row, the first = default. Preset values tuned
  to each band by eye. Selected swatch: ring in `accent` (builder's call
  on the exact mark).
- Custom: opens a colour picker (native `<input type="color">` is fine to
  start); the result is clamped and saved on change.
- A row that differs from its default gets the hotkeys' reset button
  (`restart_alt`, tooltip "Reset") before the swatches, and the 6px accent
  dot, as in the hotkeys editor.
- Picking a base for the mode that isn't showing does **not** switch
  the mode (Jasper, 2026-11-22: picking a colour isn't consent to change
  the mode). The swatches show the clamped colours, which is the preview;
  the window changes only when the user flips the moon/sun.
- The current Light / Dark Segmented row is removed.

## Builder check answers (CC's calls, 2026-11-22)

- `accent-text-hover`: follow each mode as index.css does today (dark
  L + 0.12, light L − 0.12).
- Status colours (danger, warning, success, kind-*) count for
  readability: the bands are checked against them in `theme-colors.ts`
  tests (contrast at the band edges), not only by eye.
- Bands: today's light background must sit inside the light band with
  room for `elevated` (white) above it; tune so no step collapses at L 1.
- Main gets the computed `background` / `toolbar` from the same pure
  module the renderer uses.

## Left to the builder

- Exact band limits, chroma factors, swatch presets: start from the
  values above and tune by eye in both modes.
- How main hands the picks to the preload before first paint.
- Whether the picker live-previews while dragging or applies on close.
- Tests: `theme-colors.ts` round trips (no pick → no overrides; default
  base value → unchanged L; clamping at band edges; on-accent choice).
