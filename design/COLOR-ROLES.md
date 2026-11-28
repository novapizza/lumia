# Lumia color roles

The color system Lumia uses (implemented in `src/index.css`). Anchored on the website palette: primary `#b6a0ff`, ground `#050810`, text `#e8e6f0`, brand gradient partner `#00e3fd`. Everything else is generated from those in OKLCH and checked for contrast. Open `color-preview.html` (same folder) to see it in both themes.

**Brought back in step with `src/index.css` on 2026-11-27.** The tables under Roles hold today's values; the neutrals are plain greys now (no blue tint), the glass, glow and capture-chrome roles are gone, and three fills (`elevated`, `toolbar`, `content`) carry the UI (STYLEGUIDE › Layers). `src/index.css` is the one source: where code needs the values outside CSS there is one copy each, kept equal by a test (`shared/theme-colors.ts` `DEFAULTS`, `electron/browser-page.ts`, the extension's fallbacks; STYLEGUIDE › Themes and roles). The reasoning below (Why this many colors, Decisions taken, Ramps, Mapping) is the 2026-11-20 design and is kept as history; where it no longer holds it says so.

**Since 2026-11-22** the accent is one value in both themes (`#7440d5`, white on it; STYLEGUIDE › Themes and roles), and users can pick their own accent and light / dark base (Settings › Appearance, `CUSTOM-THEMES.md`): every role below is then derived from the picks by `shared/theme-colors.ts` and applied as a `<style id="lumia-theme">` override. The values here are the defaults. Code that draws outside CSS reads roles at runtime with `hooks/useRoleColors.ts`, never hard-codes them (the annotation canvas used `#b6a0ff` until 2026-11-23).

## Why this many colors

- **Use color sparingly.** Apple's HIG says to use color sparingly in non-game apps and to keep brand color in the content layer, not on Liquid Glass chrome.
- **Count roles, not swatches.** Design systems converge on 1 accent hue, 1 neutral ramp of about 9 to 12 steps, and 3 to 4 status hues.
- **Two layers.** Ramps hold raw values (`N1` to `N12`). Roles name the job (`fg-secondary`) and point at a step. Components only use roles.
- **Fixed jobs per step** (Radix): 1 to 2 backgrounds, 3 to 5 fills, 6 to 8 borders, 9 to 10 solid, 11 to 12 text. Light and dark use the same step numbers, so the role map is written once.
- **Generate, don't hand-pick.** Linear replaced 98 theme variables with 3 inputs (base, accent, contrast) in LCH. Lumia's ramps come from 4 website anchors the same way.
- **Status only for status.** A hue that means two things ends up meaning neither (see today's `tertiary`).

Lumia is content first (the screenshots are the colorful part), dark first, and draws chrome over arbitrary screens. Annotation colors are drawn into images, so they are content and sit outside the UI budget.

## Budget

| Group | Hues | Roles |
|---|---|---|
| Neutral | 1 ramp | 14 |
| Accent | 1 ramp (violet) | 6 + `on-accent` |
| Brand gradient | 1 extra stop (cyan), primary CTA only | 1 |
| Status | 3 ramps (red, amber, green) | 8 + `on-danger` |
| Capture chrome | the clip type's blue and pink | 2 (`kind-image`, `kind-video`), per theme |
| **UI total** | **5 hues + 1 gradient stop** | **~36** (today: ~10 hues, 69 tokens) |
| Annotation (content) | 8 swatches | 8 |

## In code

Each role is a Tailwind 4 `--color-*` token in `src/index.css`, so it works with every color utility and opacity modifier: `bg-surface`, `text-fg-secondary`, `border-line-subtle`, `bg-accent/15`, `hover:bg-fill-hover`, `text-danger-text`, `ring-focus`. Dark values sit in `@theme`, light values under `html.light`. `.glass-refractive`, `.liquid-glass` and `.primary-gradient` are built from the same tokens and are used only by the unmounted Share dialog and workflow picker (`.glass-card` and `.card-organic` were deleted 2026-11-27). Never use raw palette colors (`slate-*`, `white/10`, `red-400`) for UI; the only exceptions are content and media overlays.

Every window with UI follows the theme since 2026-11-24 (the capture overlay, the recording toolbar, border and drawing layer were fixed dark before). The main process reads `background` (the window) and `toolbar` (the Windows title bar overlay) from `DEFAULTS` under the user's picks.

## Decisions taken

1. **Accent is the website violet, one value for both themes** (2026-11-22). `#7440d5` with a white label (6.1:1) in light *and* dark. Until 2026-11-22 dark had its own lighter fill (oklch(0.72 0.175 293.6) ≈ `#ab8eff`, earlier `#b6a0ff`) with a near-black label; a middle value (oklch(0.60 0.2) ≈ `#8a5fea`) was tried. Cost: as an icon / text colour on the dark controls `#7440d5` is only ~2.9:1. The cobalt `#0050d4` light accent went away earlier, so both themes are the same brand.
2. **Per-kind hues only on the clip type icon.** Image / Video / Scroll lost violet / pink / cyan; the selected kind uses the accent. Since 2026-11-21 the type icon in a clip's status bar is drawn in `kind-video` (pink) or `kind-image` (blue). Tried and dropped: green for images (reserved for success), cyan, blue for video, line only, no fill. Fills were tried (bright with dark lines, dark with grey lines) and dropped. Since 2026-11-24 the capture overlay and the recording wear them too: the overlay's frame and its Segmented pills (blue in Image, pink in Video), the recording's border, live dot and Stop button (pink). Nothing else is coloured by kind.
3. **Brand gradient stays, on the main action of a screen only.** No mounted screen uses it today (2026-11-27): the launcher that had New Capture is removed, and dialogs, Settings and the trim bar use the solid accent (`ACCENT_BUTTON`). It lives on in the unmounted Share dialog. Accent to `brand-end` at 135deg, same as the website. Pills, toggles, progress bars and small toolbar buttons use solid `accent`.
4. **The website pink (`#ff6c95`) stays website-only.** It was too close to the recording/error red to carry a separate meaning in the app. The app's one pink is `kind-video` (hue 345, a cooler pink, 2026-11-21), on the video type icon only.
5. **Neutrals took the website ground's hue** (OKLCH 264, a cool blue-slate) at low chroma. They are plain greys now (`#131313`, `#e7e7e7`…), see Roles. A user who wants a tint picks a base in Settings › Appearance.
6. **Glows are gone** (they were accent at 7% and cyan at 4%, dark theme only): no effects, layers only.
7. **Focus ring uses the accent fill step, not step 8**: the light step 8 is too pale to reach 3:1. It is set once globally (`:focus-visible`, 2px outline, 2px offset).
10. **Lines are translucent `fg`**, not solid ramp steps, so they blend with the fill under them. The old translucent fills (`fill*`, `control` in dark) have no mounted user left; the three layer fills are solid. Their alphas match ramp steps 3 to 5 over the background; lines stay close to the old hairlines (7%, 12%, 22% in dark).
11. **Content stays content.** Thumbnail overlays, video scrims, image previews and the screenshot background presets keep fixed white-on-dark or their own colors in both themes.
8. **Warning and success have no solid fill.** Lumia only shows them as text/icons on a tinted background.
9. **Annotation palette drops to 8** (pink removed). Swatches differ in lightness as well as hue, so red/green and blue/purple stay apart for color-blind viewers.

Still open: whether to follow the macOS / Windows system accent (Apple says Mac users expect it). Default stays Lumia violet.

## Roles

`N` neutral, `A` accent, `R` red, `Y` amber, `G` green. Step numbers match the ramps below.

### Surfaces

| Role | Step | Dark | Light | Job |
|---|---|---|---|---|
| `background` | | `#131313` | `#f5f5f5` | Window ground (the page behind the bars; main's window background) |
| `surface` | | `#0e0e0e` | `#ffffff` | Old role. Only `.liquid-glass` (the unmounted Share dialog) |
| `surface-raised` | | `#171717` | `#ffffff` | Old role. `.glass-refractive` (the unmounted workflow picker) and the native select's option list |
| `content` | L3 | `#0e0e0e` | `#f0f0f0` | Dashboard clip area (below everything else on that page) |
| `toolbar` | L1.5 | `#151515` | `#f7f7f7` | The AppBar (the Windows `titleBarOverlay` colour matches it), day labels, a clip's status bar and hover buttons |
| `toolbar-hover` | | `#212121` | `#ececec` | A card's hover button or a list row's action under the pointer (2026-11-22) |
| `elevated` | L1 | `#1d1d1d` | `#ffffff` | The controls on the AppBar (filters, Select, theme, Settings), the BottomBar, a clip's selection circle, callouts, toasts (info / progress), dialogs (2026-11-25) |
| `elevated-hover` | | `#282828` | `#f4f4f4` | A framed `elevated` button under the pointer (2026-11-22) |
| `canvas` | | `#080808` | `#eeeeee` | Old role. No mounted user since the grid card's well moved to `content` (2026-11-27); the editors' area is `content` |
| `scrim` | | `rgba(8, 8, 8, 0.72)` | `rgba(29, 29, 29, 0.45)` | Behind modal dialogs (a dim only, no blur, 2026-11-25) |

**Glass is gone from the mounted UI** (no blur, no translucent fills; STYLEGUIDE › Philosophy). What's left serves the two unmounted pieces above, with these parameters:

| Parameter | Dark | Light | Used for |
|---|---|---|---|
| `glass-alpha-docked` | 0.6 | 0.75 | `surface` panels (website `--bg-surface` is 0.6) |
| `glass-alpha-floating` | 0.8 | 0.88 | `surface-raised`: popovers, menus, recording pill need to stay legible over anything |
| `glass-blur` | 40px | 40px | Both classes |

Dashboard layers, highest first: **L1** `elevated` (app bar, toolbar controls), **L1.5** `toolbar` (toolbar strip, day labels, a clip's status bar and hover buttons), **L2** the clips, **L3** `content`. Dark: higher is lighter. Light: L1 is white and each lower layer is a step greyer. No shadows in either theme. (2026-11-20)

### Interaction

| Role | Step | Dark | Light | Job |
|---|---|---|---|---|
| `fill` | | `rgba(231, 231, 231, 0.068)` | `rgba(29, 29, 29, 0.058)` | Old role, no mounted user (the unmounted Share dialog, the removed launcher) |
| `fill-hover` | | `rgba(231, 231, 231, 0.1)` | `rgba(29, 29, 29, 0.095)` | Old role, as above |
| `fill-active` | | `rgba(231, 231, 231, 0.134)` | `rgba(29, 29, 29, 0.129)` | Old role, no user |
| `control` | | `rgba(231, 231, 231, 0.068)` | `#ffffff` | Old role, no mounted user since the grid card moved to `toolbar` (2026-11-27) |
| `control-hover` | | `rgba(231, 231, 231, 0.1)` | `#fafafa` | Old role, no user |
| `line-subtle` | | `rgba(231, 231, 231, 0.07)` | `rgba(29, 29, 29, 0.1)` | Dividers between rows, a bare row action's hover edge |
| `line` | | `rgba(231, 231, 231, 0.12)` | `rgba(29, 29, 29, 0.14)` | The edge of every control, bar, card, callout and dialog |
| `line-strong` | | `rgba(231, 231, 231, 0.22)` | `rgba(29, 29, 29, 0.22)` | A card's edge under the pointer, a card's hover buttons, the toggle's edge, the slider's track |

Lines stay see-through, so they blend with what they sit on (solid lines were tried 2026-11-20 and dropped).

### Text

| Role | Step | Dark | Light | Job |
|---|---|---|---|---|
| `fg` | | `#e7e7e7` | `#1d1d1d` | Headings, primary copy |
| `fg-secondary` | | `#b4b4b4` | `#575757` | Descriptions, meta, idle icons, button labels |
| `fg-tertiary` | | `#888888` | `#6a6a6a` | Placeholders, empty-state and missing-picture icons, a source's kind icon |
| `fg-disabled` | | `#535353` | `#b1b1b1` | Disabled labels and icons (no minimum) |
| `fg-faint` | - | `#464646` | `#c1c1c1` | Decorative text nobody has to read (the Dashboard's bottom sign-off); below every contrast minimum on purpose |

### Accent

| Role | Step | Dark | Light | Job |
|---|---|---|---|---|
| `accent` | A9 | `#7440d5` | `#7440d5` | Primary button, selected pill and selected segment (Dashboard filter, view switch), selected clip outline (an inset ring, `--selection-ring` wide: 1px dark, 1.5px light, 2026-11-24; also the editor's History panel rows), on-state strip, progress, links. One value for both themes since 2026-11-22 (dark was ≈ `#ab8eff`) |
| `accent-hover` | A10 | `#6931c8` | `#6931c8` | Hover on accent fills |
| `accent-subtle` | | `#3e2d69` | `#d9d1fc` | Old pale selected fill. No mounted user (the removed launcher's toggle) |
| `accent-muted` | | `#211939` | `#e4dcfe` | Old selected-nav fill. No user since the Settings nav went accent-filled (`.active-nav-bg` deleted 2026-11-27); still derived for custom themes |
| `accent-text` | A11 | = `accent` | = `accent` | Accent text and icons on neutral or accent-subtle (an info toast's icon; on-state icons and the theme's moon / sun are neutral since 2026-11-22) |
| `accent-text-hover` | | `oklch(0.64 0.2 293.5)` | `oklch(0.40 0.21 293.5)` ≈ `#5410aa` | Accent icons and the on-state strip under the pointer (L ±.12, 2026-11-22) |
| `focus` | A9 | = `accent` | = `accent` | Keyboard focus, 2px outline, inside the control |
| `on-accent` | | `#ffffff` | `#ffffff` | Label on accent fill and on the brand gradient (dark was `#050810` / `#080808` until 2026-11-22) |
| `brand-end` | | `#00e3fd` | `#007d8c` | Second stop of the brand gradient (135deg, accent to this). Primary CTA only |

### Status

| Role | Step | Dark | Light | Job |
|---|---|---|---|---|
| `danger` | R9 | `#db232f` | `#d41828` | Destructive fill, recording dot, mic-on button |
| `danger-hover` | R10 | `#c91927` | `#c3001f` | Hover on danger fills |
| `danger-subtle` | R3 | `#371210` | `#ffecea` | Error banner, failed row |
| `danger-text` | R11 | `#e84b50` | `#c21725` | Error icons and error lines; every delete button's icon or label under the pointer (grey at rest, 2026-11-27); at rest on the three red ones: Select's trash and (inverted) its badge, the armed "Confirm disconnect", the trash on a selected shape |
| `danger-text-hover` | | `oklch(0.754 0.154 22.8)` ≈ `#ff8480` | `oklch(0.401 0.2 25)` ≈ `#970000` | What's red at rest, under the pointer: Select's trash and its badge, the armed "Confirm disconnect", the trash on a selected shape in the image editor (2026-11-27; the other delete buttons used it on hover from 2026-11-22 and now turn plain `danger-text`) |
| `warning-subtle` | Y3 | `#421e00` | `#ffead9` | Warning pill / banner background (orange hue 27 since 2026-11-20) |
| `warning-text` | Y11 | `#e67a2a` | `#b95a00` | Warning copy and icons (orange hue 27 since 2026-11-20). Dark is `oklch(0.69 0.16 52)` since 2026-11-24: `#ee9a56` (L .76, chroma .13) read pale and much lighter than `danger-text`; now it sits as far above its light value as danger does |
| `warning-text-hover` | | `oklch(0.81 0.122 52.1)` ≈ `#ffaa75` | `oklch(0.453 0.147 52.4)` ≈ `#913500` | The missing-files icon and badge under the pointer (2026-11-22). Dark moved down with `warning-text` (2026-11-24; was `oklch(0.878 0.105 57.9)`), still L +.12, chroma ×0.8 |
| `warning-line` | | `#421e00` | `#e4c9b5` | A missing clip's edge (list row and grid card); solid, light value sampled from `warning-text` at 30% over a light row (2026-11-21) |
| `hover-overlay` | | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.045)` | `.hover-overlay` layer: a list row and the select-mode day label under the pointer, inside their edge (2026-11-22; light value picked on a slider, 5% was too strong) |
| `success-subtle` | G3 | `#002712` | `#e0f9e7` | Connected / done background |
| `success-text` | G11 | `#6dd797` | `#007742` | Saved, connected, check icons |
| `kind-video` | | `oklch(0.66 0.175 345)` ≈ `#d95faa` | `oklch(0.55 0.175 345)` ≈ `#b43b88` | Video type icon in a clip's status bar (pink, hue 345, accent's chroma); the capture overlay in Video (frame, pills), the recording border, live dot and Stop (2026-11-24) |
| `kind-video-hover` | | `oklch(0.6198 0.1764 344.87)` ≈ `#cc519e` | `oklch(0.5098 0.1764 344.87)` ≈ `#a62d7d` | A `kind-video` fill under the pointer: the recording's Stop (2026-11-27; a colour-mix written in place before). The accent → accent-hover step, see below |
| `kind-image` | | `oklch(0.66 0.175 255)` ≈ `#3b92fa` | `oklch(0.55 0.175 255)` ≈ `#0d70d4` | Image type icon in a clip's status bar (blue, hue 255, accent's chroma); the capture overlay in Image (frame, pills) (2026-11-24) |
| `on-danger` | | `#ffffff` | `#ffffff` | Label/icon on danger fill |

There is no `recording` role: a recording's live dot, Stop and border wear `kind-video`.

**`kind-video-hover` comes from the accent's hover** (Jasper, 2026-11-27): Stop's hover step must equal an accent button's, so the role is `kind-video` moved by the step that takes `accent` (`#7440d5`, oklch 0.5199 0.2141 293.52) to `accent-hover` (`#6931c8`, oklch 0.4797 0.2155 293.39): L −0.0402, C +0.0014, H −0.13. The accent pair is one in both themes, so the step is too; it's applied to each theme's `kind-video`. `tests/theme-colors.test.ts` fails if either pair moves without the other. There is no `kind-image-hover`: nothing filled with `kind-image` can be pressed.

### Capture chrome

No roles of its own any more (2026-11-24; `capture-frame`, `capture-frame-outline`, `capture-highlight`, `capture-dim` and `recording-frame` are gone from the CSS). The capture overlay and the recording windows follow the theme and use the roles above: the pick's 1px line, the mode bar's pills, the recording's border, live dot and Stop wear the clip type's colour (`kind-image` / `kind-video`); bars and labels are `toolbar` with a `line` edge. One fixed value lives in `Overlay.tsx`: the 18% black dim outside the pick (`rgba(0,0,0,0.18)`, the extension's Region picker uses the same), drawn over the user's screen, so no role holds it.

### Over media

Controls and tags drawn on a capture thumbnail (Dashboard cards: status bar and its tags, hover buttons, selection circle) use the theme roles (merged 2026-11-20; they had become exact copies): fill `toolbar`, icons and text `fg-secondary`, edges `line-strong` (`line` on the status bar's top edge; a hover action that can't run is hidden, not disabled), Missing tag `warning-text` (tags have no box, fill or outline), Uploaded icon `success-text`, type icon `kind-video` / `kind-image`. They follow the theme like the other layers.

The tooltip keeps its own roles, dark in both themes:

| Role | Value | Job |
|---|---|---|
| `tooltip` | `#1d1d1d` | Tooltip fill (TooltipLayer) |
| `tooltip-ring` | `#343434` | Tooltip edge |
| `on-tooltip` | `#ffffff` | Tooltip text |

## Contrast

**Not recomputed for today's grey neutrals** (2026-11-27): the neutral rows below were measured on the earlier blue-tinted values; the accent, status and kind rows were updated as they changed. All checked with WCAG 2 contrast against every surface the role lands on, both themes. Minimums: 4.5:1 for all text including `fg-tertiary` (Lumia uses it for 10 to 11px meta text), 3:1 for the focus ring and the recording dot.

| Pair | Dark | Light |
|---|---|---|
| `fg` (min 4.5) | 14.53:1 lowest | 14.54:1 lowest |
| `fg-secondary` (min 4.5) | 8.63:1 lowest | 6.26:1 lowest |
| `fg-tertiary` (min 4.5) | 5.03:1 lowest | 4.67:1 lowest |
| `accent-text` (min 4.5) | ~2.9:1 on `elevated` since the shared accent (2026-11-22; was 9.96:1), below the minimum, accepted for icons | 6.51:1 lowest |
| `on-accent` (min 4.5) | 6.1:1 (white on `#7440d5`) | 6.1:1 |
| `focus` (min 3.0) | ~2.9:1 on `elevated` (2026-11-22; was 8.08:1) | 5.26:1 lowest |
| `on-danger` (min 4.5) | 4.89:1 lowest | 5.3:1 lowest |
| `danger-text` (min 4.5) | 4.5:1 on `elevated` #1d1d1d | 5.25:1 lowest |
| `warning-text` (min 4.5) | 5.1:1 on its subtle fill, 6.2:1 on the status bar (2026-11-24; was 7.9:1 / 8.2:1) | 5.0:1 on its subtle fill |
| `success-text` (min 4.5) | 9.1:1 lowest | 4.86:1 lowest |
| `danger` (min 3.0) | 3.67:1 lowest | 4.57:1 lowest |

Known gap: control lines (`line`, `line-strong`) sit well below the 3:1 WCAG asks when a border is the only thing marking a control. Lumia's inputs and chips also have a `fill`, so they are identifiable without it. Radix and most dark UIs make the same trade-off.

## Annotation palette

Fixed in both themes, in this order (people learn positions).

| # | Swatch | Value | OKLCH lightness |
|---|---|---|---|
| 1 | red | `#ee3533` | 0.62 |
| 2 | orange | `#fe860f` | 0.74 |
| 3 | yellow | `#fbda1b` | 0.89 |
| 4 | green | `#40d872` | 0.78 |
| 5 | blue | `#2896f5` | 0.66 |
| 6 | purple | `#822dda` | 0.52 |
| 7 | white | `#ffffff` | 1.0 |
| 8 | black | `#000000` | 0.0 |

## Ramps

Generated in OKLCH. Hues: neutral 264 (from `#050810`), accent 294 (from `#b6a0ff`), red 25, amber 75, green 155. **History** (2026-11-27): these are the 2026-11-20 generator's ramps. The neutral ramp is no longer in use (the roles are plain greys), the dark accent ramp's step 9 isn't the accent any more (`#7440d5` in both themes), and warning moved to orange (hue 52). The red and green ramps still hold the status roles' values.

### Neutral

| Theme | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dark | `#050810` | `#090e19` | `#111723` | `#171e2b` | `#1e2534` | `#262e3d` | `#343c4c` | `#4b5362` | `#626977` | `#818895` | `#aeb4c1` | `#e8e6f0` |
| light | `#fafcff` | `#f5f7fb` | `#ebeef5` | `#e2e6ee` | `#dadee7` | `#cfd4de` | `#c2c7d3` | `#abb1bd` | `#878c97` | `#656a75` | `#515762` | `#181d27` |

### Accent

| Theme | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dark | `#0b0a13` | `#120f1e` | `#211939` | `#2a1e4a` | `#332559` | `#3f3068` | `#514080` | `#6b55a6` | `#b6a0ff` | `#c1b1ff` | `#cdc0ff` | `#e8e4ff` |
| light | `#fdfcff` | `#f9f8ff` | `#f1efff` | `#e9e5ff` | `#e1daff` | `#d6ccff` | `#c7b8ff` | `#af9af5` | `#7440d5` | `#6931c8` | `#6534bd` | `#331b62` |

### Red

| Theme | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dark | `#130807` | `#1d0c0b` | `#371210` | `#471312` | `#551918` | `#642321` | `#7c322f` | `#a14440` | `#db232f` | `#c91927` | `#ff958d` | `#ffdbd7` |
| light | `#fffcfc` | `#fff7f6` | `#ffecea` | `#ffe0dd` | `#ffd4cf` | `#ffc3bd` | `#ffaba3` | `#f28881` | `#d41828` | `#c3001f` | `#c21725` | `#610d11` |

### Amber

| Theme | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dark | `#100a03` | `#190f03` | `#2d1b00` | `#382300` | `#432b00` | `#523500` | `#694500` | `#895b00` | `#ffb848` | `#ffca7f` | `#ffc673` | `#ffe7c8` |
| light | `#fffcf9` | `#fff8ef` | `#ffeed9` | `#ffe4c0` | `#fcdaac` | `#f5cd95` | `#eabb79` | `#da9e3f` | `#fbac16` | `#eba000` | `#8d5e00` | `#4a2f00` |

### Green

| Theme | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dark | `#050e08` | `#06150c` | `#002712` | `#003118` | `#003b1e` | `#004926` | `#005d33` | `#047a45` | `#10ae65` | `#2bbb71` | `#6dd797` | `#cbf4d8` |
| light | `#fafefb` | `#f2fcf5` | `#e0f9e7` | `#cdf4d9` | `#bceecc` | `#a8e5bc` | `#8ed8a8` | `#5ec386` | `#008b4f` | `#007e46` | `#007742` | `#003b1e` |

## Mapping from the pre-2026-11-20 tokens

History: how the old tokens became roles. Several targets here (`surface*`, `fill*`, `canvas`, the capture chrome roles, the glows) have since been retired, see Roles.

| Today | Count | Becomes |
|---|---|---|
| `primary`, `secondary`, `tertiary`, `gradient-*`, `nav-active-*` | 9 | Accent roles + `brand-end` |
| `text-white` to `text-slate-700`, `on-surface*` | 10 | `fg`, `fg-secondary`, `fg-tertiary`, `fg-disabled` |
| `glass-*`, `liquid-glass*`, `card-organic*`, `titlebar*`, `surface-glass` | 15 | `surface`, `surface-raised` + glass parameters |
| `bg-white-*`, `border-white-*`, `selection-ring`, `scrollbar-thumb`, `outline` | 10 | `fill*`, `line*`, `focus` |
| `red-400/500`, `amber-400`, `emerald-400` | 4 | 8 status roles + `on-danger` |
| `capture-*`, `scroll-region`, `recording-border` | 5 | 5 capture chrome roles |
| `workspace-*`, `glow-*` | 5 | `canvas`, `glow-accent`, `glow-cyan` |
| `annot-*` | 9 | 8 annotation swatches |

## Sources

- [Apple HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color.md)
- [Apple HIG: Mac Catalyst visual design (system accent color)](https://developer-rno.apple.com/design/human-interface-guidelines/technologies/mac-catalyst/visual-design)
- [Radix Colors: Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)
- [Radix Colors: Aliasing](https://radix-ui.com/colors/docs/overview/aliasing)
- [Linear: How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Material 3 color roles (Android developers)](https://developer.android.com/design/ui/wear/guides/styles/color/roles-tokens)
- [Flutter: New ColorScheme roles for Material 3](https://docs.flutter.dev/release/breaking-changes/new-color-scheme-roles)
- [DesignProject: Create a UI color palette](https://designproject.io/resources/guides/create-ui-color-palette/)
- [DesignProject: Create semantic color tokens](https://designproject.io/resources/guides/create-semantic-color-tokens/)
- [Aura design system: Color](https://docs.cognite.com/aura-design-system/foundations/color)
- [Microsoft Fluent 2: Color](https://fluent2.microsoft.design/color)
