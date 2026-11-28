# Region picker (browser extension)

The extension's "Capture part of page" mode: pick a part of the page (an element) and capture exactly that part, scroll-stitched when it scrolls. Code: `lumiaPickElement` in `extension/background.js`. Settled with Jasper on 2026-11-27, after a throwaway try on real pages (Google search results, news pages).

## Why

The first version (2026-11-26) was a callout with a d-pad (parent, child, previous, next, a Capture key in the middle) and a line of hints. Jasper: the d-pad was confusing, and it wasn't clear which level of the page the outline was on. It also didn't look like Lumia: a purple tint inside the outline, green for parts that scroll, no dim.

## Approaches

- **Path bar** (chosen): the bar at the top shows where the outlined part sits in the page, as a path; ↑ / ↓ and a click on a step move along it. Fixes both problems head-on, and the bar is the capture overlay's.
- **Scroll to grow**: the wheel or ↑ / ↓ widens and narrows the outline, the size label says "Level 3 of 7". Least on screen, but the gesture is invisible.
- **Drag a box**: like the overlay's Region, snapping to element edges. Simplest, but a scrolling pane (the main reason for this mode) is hard to hit by dragging.

## What it looks like

Drawn like the capture overlay (STYLEGUIDE › Capture and recording):

- **The pick:** a 1px line in the image clip colour (`kind-image`), the 18% dim outside it, no tint inside.
- **The size label** under the pick (above it near the bottom edge, inside when neither fits): a small `toolbar` box, 11px medium `tabular-nums`, "604 × 132", then ", 2 of 5" when the part has siblings, and a SCROLLS tag in `success-text` when it scrolls (it's captured scroll-stitched).
- **The bar**, centred 32px from the top, 480px wide: `toolbar`, inset `line` edge, `rounded-lg`, 10px in, two rows 8px apart.
  - **Path** (a breadcrumb, not a Segmented control: a path isn't a choice between options): steps at 12px medium `fg-secondary` (→ `fg` under the pointer), the current one on a `kind-image` pill with white text, a 14px chevron in `fg-tertiary` between steps. The bar keeps one width (480px, the key row needs ~410; Jasper: it mustn't change size on navigation), the path centred in it: the steps fill the row outward from the current one, one each side in turn, as far as they fit; what doesn't goes into "…" at that end (a click steps past the fold).
  - **Keys:** Settings › Wallpapers' keycap (20px, `line` edge, 14px icon) with a 10px label, groups 12px apart: `↑ ↓ Out / in`, `← → Previous / next`, `↵ Capture`, `esc Cancel`. "Level / Part" and "Parent / child / Siblings" were weighed: the first doesn't say which way, the second is developer language.
- **The other parts at the same level** (where ← / → go): a 1px line in `kind-image` at 20%, under the dim. See-through rather than a lighter colour, since the page under it can be any colour; a tint toward white read as a second pick. Only those on screen, at most 300.
- **Cursor:** crosshair over the page, the arrow over the bar.

## How it behaves

- **Hover** outlines the part under the pointer; the path shows it and the parts around it, plus up to three steps below it (the first child at each level: what ↓ goes into), so the bar shows what's inside too.
- **↑ / ↓ or a click on a step** moves the outline out / in along the path. ↓ at the last step goes into the first child. Small pointer moves inside the same part keep the level you stepped to.
- **← / →** move to the part before / after at the same level (skipping parts that take no space); the steps below are rebuilt from there.
- **Click or Enter** captures the outlined part (committed on mousedown: native scrollbars fire no click). **Esc, right-click, or switching tab / window** cancels.
- The outline follows its part when the page or a pane scrolls.

### Which parts count

- **Same edges, one step:** nested parts with the same box (within 1px) are one step. Its name is the first real one among them; what's captured is the one that scrolls, else the outermost (the picture is the same).
- **Empty layers are skipped** everywhere (hover, ↓, ← / →, the merge): an element with no child elements and no text that isn't an image, video, canvas, field or button. Pages stretch these over content as whole-card links or fades (Google's result cards).
- **Hit test past `pointer-events: none`:** the browser's own lookup skips such parts (Google turns them off so clicks reach the card link), so after it the picker walks down by box: the last child whose box holds the pointer. `display: contents` wrappers count through to their children.
- **Same-origin frames** are picked into (each frame's offset is tracked); cross-origin frames only as a whole.

### Step names

What the page says the part is: its ARIA role, else its tag (Page, Main, Navigation, Header, Footer, Sidebar, Article, Section, List, Item, Table, Row, Cell, Form, Paragraph, Quote, Heading, Figure, Image, Graphic, Video, Frame, Code, Button, Link, Field, Menu, Dialog…). A box holding only text is "Text"; anything else is "Box". Pages built from plain `div`s read "Box › Box › Box"; the outlines and the count carry the meaning there.

## Theme

The app sends its role values with the theme (`pageRoles` in `electron/browser-page.ts`, now with `kind-image`). Before the app has sent one, the extension's own defaults (`DEFAULT_ROLES`) follow the system's light / dark; an app too old to send `kind-image` falls back to the app's value for the mode.

## Not done

- No tooltips on the bar's steps (the keys are on screen).
- A step can't show all the parts at its level (the bar is one line); the outlines and "2 of 5" do that on the page.
