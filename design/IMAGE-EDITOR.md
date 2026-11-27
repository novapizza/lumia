# Image editor

Status: built and locked in (2026-11-23; Background added 2026-11-25). Follows the video editor
(`VIDEO-EDITOR.md`) and the style guide (`STYLEGUIDE.md`, see Editors,
Callouts and menus, Spacing).

## Intent

The image editor (`/editor` with an image) feels like the video editor: a
pop-over over the Dashboard, its tools floating over the content, the same
buttons, layers, hover rules and type scale. Uploading follows the
Dashboard's rules.

## Frame

- **AppBar:** the Settings gear becomes the Back arrow to the Dashboard
  (`useAppBarClose`). The slot holds Background (2026-11-25, see Background
  below), then the file actions, 12px apart like all the slot's buttons:
  Copy · Save · Delete · Upload (framed icon
  buttons). Copy and Save always show; Delete for a clip from history
  (2026-11-27, grey at rest, red under the pointer); Upload by the Dashboard's rule with
  the Upload menu (`lib/upload-choice.ts`).
- **An edit makes the upload stale:** when the annotations change, main
  clears the row's uploads (`history:saveAnnotations`), so Upload shows again
  and the next upload carries the edit. Only after a real edit in the session
  (opening and copying an image never clears them).
- **Canvas area:** `bg-content`, no dots. The canvas fills it; the toolbar
  floats over the image (it stopped 76px above the bottom until 2026-11-23,
  which cut actual-size images off and left a band behind the toolbar).

## Zoom

- **100% = actual size:** one image pixel per screen pixel (CSS px = image px
  / devicePixelRatio), whatever the window. A capture opens as big as it was
  on screen; bigger than the window, it pans. (It used to fit the window, with
  100% meaning "fitted".)
- 10% to 300%, 10% steps (higher lagged: the stage canvas spans the whole
  zoomed image). ⌘+ / ⌘− / ⌘0, the wheel; pan by dragging with Cursor, or
  holding the drag key with Settings › Hold key to pan on (see Canvas).
- **Remembered per image:** zoom and pan (`lib/editor-view.ts`, localStorage,
  the 200 most recent; the default view isn't stored).
- **Strokes scale with the zoom** (image units, `strokeWidth / baseScale`); at
  10% they used to keep their screen width and merge into a blob. The
  selection outlines and the delete button keep a fixed screen size; a line's
  grab band is the line as drawn plus 4px (at least 8px), so the move pointer
  shows only just before the line.

## Floating toolbar (`AnnotationCanvas/ToolBar.tsx`)

The video trim bar's box and place: `bg-toolbar`, inset `line` edge,
`rounded-lg`, `p-2.5`, 10px from the sides, 20px from the bottom
(`EDGE_X` / `EDGE_Y` in `Editor.tsx`, the same as the video trim bar).
With the History panel pinned it stops 10px left of the panel. Tooltips
inside it centre on their button (`data-tip-center`).

**Fades like the video trim bar** (2026-11-25, `useAutoHideControls`): 300ms
opacity after 3s without pointer moves; at once when a stroke starts (pointer
moves don't bring it back until the stroke ends) or the text box opens (a
move does, so the colours stay in reach while typing); back when the stroke
ends or the text box closes. Never while the pointer is on it or on one of
its callouts, or a control in it has keyboard focus. The positioning box
lets the pointer through; only the visible toolbar takes it, so strokes
run under a faded one.

- **Left, a cluster 12px apart:** the Sticker button (2026-11-26, at the
  left end; it was the last tool), the tools (Segmented: Cursor, Brush,
  Highlighter, Arrow, Rectangle, Ellipse, Text, Blur), the size control,
  the colours. Each tool's tooltip names its key from the key map,
  "Brush (B)" (2026-11-24, `toolTip` in `ToolBar.tsx`). Brush was Pen,
  key P, until 2026-11-25 (the tool id stays `pen`).
- **Highlighter** (2026-11-24, from the recording's live drawing): a
  freehand stroke like Brush, drawn 4× the picked width at 35% opacity
  (`HIGHLIGHTER_WIDTH` / `HIGHLIGHTER_OPACITY` in `tools.ts`); Shift draws a
  straight line, as with Brush.
- **Right:** zoom (− | % | +, one framed group, `line-subtle` dividers, the %
  as wide as "100%"), 40px, then Undo · Redo · Clear edits (red eraser) ·
  History, 12px apart.
- **Options follow the tool**, or the selected shape's kind: Brush,
  Highlighter, Arrow, Rectangle, Ellipse: line width (dots) and colours; Text: size ("A" at 6.4 /
  9.6 / 16px, the dots' 4 : 6 : 10 rate) and colours; Blur: strength (one 10px
  dot, blurred as the image would be at 100%); Cursor with nothing selected
  or a selected sticker: none.
- **Colours:** the eight palette swatches and Custom, 24px circles 6px apart,
  `line` edge (`line-strong` until 2026-11-25) on an `elevated` base under
  the colour (2026-11-26, `swatchBg`: over the colour itself the edge all but
  vanished), so it reads like a button's edge; the pick an accent ring 1px
  out. Custom remembers the last custom colour (localStorage). Its icon
  (`CustomSwatchIcon`, 2026-11-25, every Custom swatch in the app): a grey
  + with no custom colour, a 12px pencil on it while it isn't in use, a 12px
  × while it is (black or white by the colour, the line weight set by that
  ground). A click on the × clears it: the custom colour is forgotten and
  the palette colour in use before comes back (the palette's first only if
  there was none). A colour set in the picker keeps Custom picked even when
  it equals a palette colour.
- **Custom picker** (2026-11-24; the system colour panel before): Settings'
  `ColorPicker` with the `free` field, any colour: saturation (left → right)
  by brightness (white top left, black along the bottom) at the hue picked
  on the strip below, which shows the pure hues. A click on Custom picks it
  at once (the colour in use if already Custom, else the remembered one,
  else the current colour) and opens the picker in a callout 12px above the
  toolbar's controls (`CALLOUT_GAP`, 7px until 2026-11-26; measured from the
  24px swatch before 2026-11-25 it sat 4px low; every toolbar callout
  measures the same way); a second click, Esc or a press outside closes it. The picker
  (2026-11-25): the eyedropper (a framed 32px button, Chromium's EyeDropper:
  a colour from anywhere on screen) at the left of the hue strip, 8px from
  it, only on this full-spectrum picker (not Settings' theme pickers, whose
  colours stay inside a band); the hue knob stays inside the strip (its
  centre runs from 6px in to 6px in, the hue picked sliding from under its
  left edge to under its right); the field's and strip's `line` edges sit on
  `elevated`, so they render like the buttons' on any ground. With the colours
  in the Palette / ⋯ callout it opens in that callout, above the row at its
  right end. The colour follows every move (a selected shape restyles live,
  one undo step per drag). A text being typed stays open while you pick.
- **Narrowing** (order Jasper's, 2026-11-26): the toolbar measures its parts
  (no breakpoints) and uses the first step that keeps at least 40px between
  the cluster and zoom:
  1. size and colours inline;
  2. the size folds into a **Size** button (line-weight icon, the size
     control in a callout);
  3. the colours fold into a **Palette** button too;
  4. zoom drops its %;
  5. size and colours merge into one **⋯** button;
  6. the tools fold into one button showing the current tool ("Tools", the
     tools in a callout).
  Every step is tried with the % first, so it comes back wherever it fits.
  A tool without a size or colours skips their steps (Blur: inline → Size →
  tools fold; Cursor: % → tools fold). A pick in the Size, Palette or Tools
  callout closes it. Callouts: 12px from their button, the shared triangle
  (`CalloutArrow.tsx`) on it, kept inside the toolbar's ends (never under a
  pinned sidebar), closed by a window resize. With both sidebars pinned in
  a 900px window the toolbar is ~460px and the folded row needs ~446px.
- **Selecting a shape keeps your tool;** its colour and size show in the
  toolbar so changing them restyles it.

## Background (`components/BackgroundPanel.tsx`, 2026-11-25)

Puts the image on a background for sharing, CleanShot-style: the exported
picture is the background with the image on it. Built in April and never
mounted; restyled and wired up in its review.

- **Opening:** the Background button (Lucide SquarePadding since 2026-11-26,
  the image inside its padded background; Blend before, which read as a
  blend mode) in the AppBar slot,
  images only. A callout under it like the Upload menu (`bg-elevated`, `line`
  edge, 264px, a 5px triangle 7px from the button); a second click, Esc or a
  press outside closes it; the button wears the on-state strip while it's
  open.
- **Top:** None | Gradient | Solid (`Segmented`, `stretch`), then the kind's
  swatches, centred, 6px apart (24px, `line` edge on an `elevated` base under
  it, `onEdgeBase`, so a gradient's far end doesn't show through the edge).
  Gradient: seven presets (orange → red, purple → pink, dark slate, teal →
  cyan → indigo (default), indigo → purple, lime → green, light silver; ten
  before, half of them flips or shades of each other) + Custom. Solid: seven
  colours (black, dark grey, red, amber, green, blue, violet; 24 before) +
  Custom. Custom swatches as in the toolbar (+ / pencil / ×).
- **The options band:** the active colour's options sit a level down, in a
  `bg-toolbar` band from a line with a ^ under the active swatch (the
  callout triangle's shape, 1px `line-subtle`, the ^ filled with the band)
  to a `line-subtle` line above the settings. A preset gradient: a 32px
  preview bar of it with Flip (`swap_horiz`: the same stops the other way
  round; another preset resets it) and Edit (pencil: loads the colours as
  drawn into Custom, replacing it; a three-colour preset keeps Start /
  Middle / End). Custom gradient: Start / End (or Middle) colour buttons,
  centred, the ring on the one the picker below edits; the picker (with the
  eyedropper), centred. Custom solid: the picker. A preset solid has no
  options: just the line. A click on the active preset gradient folds the
  band away (again, or another swatch, opens it; Custom's click clears it
  instead): the band glides shut (grid rows, 200ms ease-out), the ^ sinks
  into the line with it, and the line fades out over 50ms from 130ms in, so
  nothing divides the swatches from the settings when folded; opening shows
  the line at once. Off under reduced motion.
- **Settings:** Padding (% of the image's longer side, 0–50, default 5; it was
  image pixels 0–120, then 0–400), Shadow (0–100, default 40: falls a
  quarter of the value, blur 1.2×, up to 65% black; follows the image's
  alpha, so a window capture's transparent corners cast none), Ratio
  (Auto | 16:9 | 4:3 | 1:1 | 9:16 in one row, `Segmented`; Auto is the image
  plus even padding; a fixed ratio adds background on the short axis), and
  Alignment (a 3×3 single select, the picked cell accent with a white dot)
  only with a fixed ratio. Sliders: label, a flat range (`.flat-range`: 4px
  `line-strong` track, accent up to a 14px white knob), the value
  (`tabular-nums`). Dropped: Inset and Auto-balance (never wired up), a
  corner radius (tried; it rounded the image, he meant the background),
  "Original" ratio (the image's own shape; Auto kept).
- **Drawing:** the canvas takes a `frame` (`CanvasFrame`: padding, shadow,
  ratio, alignment, CSS and a canvas painter). On screen a div behind the
  stage, snapped with it to device pixels (unsnapped, a 1px frame showed only
  at the right and bottom), the shadow a `drop-shadow` on the stage. In
  Copy / Save / Upload (`toDataURL`) a bigger canvas: the background
  painted, the image composite drawn on it with the shadow. Screen and
  export share `frameLayout`. Not remembered: the panel resets when the
  editor closes, and reopening an image shows it without one (the saved
  edited copy, if drawings were saved, has the frame baked in).

## Canvas

- **Only Cursor selects and moves shapes** (the move pointer over a shape).
  ⌘-click (Ctrl on Windows) adds or removes one shape; a plain click selects
  just that one. Several selected shapes share one frame round them all and
  one delete button at its corner; they move, resize, restyle and delete
  together (one undo step).
- **Settings › General › Hold key to pan** (2026-11-24; first "Space to drag", then
  "Key to drag", the same day; off by default, which keeps the behaviour from before the 2026-11-23
  rework) decides what a Cursor drag on empty canvas does. The key itself is
  **Settings › Hotkeys › Image editor › Pan** (Space by default, any one key
  but the select modifier ⌘ / Ctrl; see Shortcuts), shown only while Hold key
  to pan is on.
  - **Off:** Cursor is the hand (open hand, closed while dragging). A drag
    from anywhere but a shape, a handle or the text box pans; a click there
    deselects (Shift / ⌘ keep the selection). No selection box. The drag
    key does nothing, in any tool (settled 2026-11-24).
  - **On:** Cursor shows the arrow on empty canvas, and a drag draws a
    selection box that selects every shape it touches (Shift or ⌘ adds). The
    box starts anywhere in the canvas area, the image or around it, follows
    the pointer outside the image and ends wherever the button is released;
    it's drawn over the whole area (not clipped to the image), styled as the
    Dashboard's (`rounded-sm border-accent bg-accent/15`). Holding the drag
    key turns any tool into a pan tool (shapes ignore presses), like
    Photoshop's Space.
  - Either way, right-drag and the trackpad pan. The setting is read when the
    editor opens.
- **Drawing tools draw,** also over a shape (crosshair); the Text tool on a
  text re-opens it for editing.
- **Shift while drawing** (2026-11-24), pressed before or during the drag
  (the shape changes at once, without a pointer move):
  - **Brush:** the whole stroke becomes one straight line from where it
    started; letting go of Shift brings the freehand stroke back.
  - **Brush and Arrow** snap to 15° steps (`SHIFT_SNAP_DEG`; 45° felt stiff),
    the end following the pointer along the snapped direction.
  - **Rectangle, Blur and Ellipse:** equal sides (square, circle), anchored
    where the drag started.
- **Text entry** (2026-11-24): the box is drawn like a selected shape's frame,
  no fill, a 1px solid accent border, square corners (until then a
  see-through dark fill, half-faded accent edge, rounded, blurred, at least
  160px wide). Padding 6px left and right, 4px top and bottom; the box is
  shifted by it so the text lands where it was clicked. No placeholder: the
  caret in the empty box is the hint (a "Type…" placeholder was dropped). The
  box uses `.text-entry-font` (`index.css`): Manrope Bold with
  `ascent-override` / `descent-override` so the caret is 1.1em tall, not
  Manrope's 1.37em (Chromium sizes the caret by ascent + descent; there's no
  CSS caret height); their difference is kept, so the baseline and the match
  with the Konva text don't move.
- **Blur boxes always render under the drawings** (a blur hides what's in the
  image, never a shape drawn on it).
- **Selection:** the frame and handles in the theme's accent (role colours read
  at runtime, `useRoleColors`). The delete button: a 32px circle (`elevated`,
  inset `line-strong` edge) with a 16px red trash (`danger-text`, darker under
  the pointer), its edge 7px off the corner handle; a 4px wider invisible hit
  area; the arrow cursor.
- **Stickers:** click one in the sticker sidebar to place it in the middle
  (the sidebar stays open), or drag it onto the image; then Cursor, the
  sticker selected, with its delete button (it waits for the sticker's
  picture to load, `stickerLoadTick`). New stickers are 120px wide on screen
  at the current zoom (`STICKER_SCREEN_W`, 2026-11-26; 15% of the image's
  width before, ~450px on a full-screen capture), capped at 80% of the
  image. Sidebar: below.

## Sticker sidebar (`components/StickerPicker.tsx`, 2026-11-26)

The sticker callout over the toolbar became a sidebar the same day: the
History panel mirrored at the canvas's left.

- **Opening:** the Sticker button at the toolbar's left end or the S key
  (still `tool:sticker` in the key map, so a changed key carries over);
  Sticker isn't a tool any more, picking stickers leaves your tool alone.
  Opened by the user, the search takes focus; a pinned sidebar that opens
  with the editor doesn't (it would take the tool keys).
- **Frame:** History's exactly, left for right: `bg-toolbar`, inset `line`
  edge, rounded, 200px; floating from 20px under the AppBar to 7px above
  the toolbar, a press outside or Esc closes it and it keeps the toolbar
  shown; **pinned** (remembered, `lumia:editor-stickers-pinned` / `-open`)
  it grows to the toolbar's bottom edge and the toolbar's left edge makes
  room (10px from it), gliding 200ms.
- **Header** (48px, 10px in): a 32px framed search field (Settings ›
  Wallpapers' box: elevated, `line` edge, accent while typing; placeholder
  "Search"; × clears and keeps focus), then Pin at the right.
- **Stickers:** 2 across (3 tried the same day, too small at 200px), History's
  list spacing (8px in, 4px gaps), cells with History's row hover; tooltips
  are the names in sentence case ("Love"). Loading, empty ("No stickers
  found") and error ("Couldn't load stickers", the raw error under it)
  states as in Settings › Wallpapers. Cached stickers show a blank cell
  while they load.
- **Categories:** a `Segmented` row along the bottom (48px, the edge line
  above), Recent first when there's any; it scrolls sideways by dragging
  (open hand on the row, closed while dragging) or the mouse wheel.
- **Dragging a sticker** (pointer-driven; HTML drag and drop didn't place
  it): past 4px a ghost follows the pointer (the sticker at 60%, the size it
  will land at, the closed hand, over a layer that keeps the canvas from
  reacting). A floating sidebar stays until the pointer leaves it, then
  closes; let go over the canvas area places it there (kept inside the
  image), anywhere else or Esc drops nothing. Recent counts only placed
  stickers.

## History panel (`components/RecentImages.tsx`, `HistoryPanel`)

- **Floating:** at the canvas's right (20px in, ending 7px above the toolbar),
  rounded, inset edge; a click outside or Esc closes it. **Pinned** (the pin
  button, left in its header): docked full height at the window's right over
  the canvas (the image doesn't move; the toolbar's right edge makes room),
  no close button, gliding 200ms between the two. Pinned and open states are
  remembered.
- **Tabs:** Layers | Edits | Recent (Segmented, `equal`, icons with one-word
  tooltips); the panel is a fixed 200px wide. Layers: `LAYERS-TAB.md`.
- **Rows** (2026-11-24): 50px on every tab, each with a 36 x 36 thumbnail
  (`w-9 h-9 rounded-md`, line edge): Recent's square. Layers and Edits drew
  their shape previews in 40 x 28 tiles on 40px rows before; 4:3 (48 x 36,
  like the Dashboard's list rows, and 36 x 27) was tried the same day and
  dropped. The marked row (the selected layers, the current step, the open
  image) gets the Dashboard's selected outline: an inset `ring-accent`,
  `--selection-ring` wide (1px dark, 1.5px light), over the row's edge, no
  fill (`Mark` in `RecentImages.tsx`; an `elevated` fill with a `line` edge
  before). Marked Layers / Edits rows keep their hover layer; the open image
  in Recent has none (a click on it does nothing).
- **Edits:** the open image's undo steps, newest at the top, each with a
  preview tile of the shape it touched (the image itself for "Original", a
  sticker's own picture since 2026-11-26), its
  icon and a name worked out by diffing the drawings (`lib/edit-steps.ts`).
  Hover outlines the shape on the canvas; a click jumps there (later steps
  grey until the next edit drops them: the name in `fg-disabled`, the preview
  greyscale at 40% opacity, 2026-11-24; greyscale only before). Saved per image under
  `userData/edit-history/` (main `edit-history.ts`), used only when its
  current step matches the row's saved drawings; Settings › General › Keep
  edit history (on by default).
- **Recent:** the 20 newest images still on disk (main skips missing files),
  rows with the capture type's icon, the source, and "2h ago, 2026-11-23
  13:43"; a placeholder tile without a thumbnail. The open image's thumbnail
  is rendered live from the canvas on every edit; the others are preloaded.
  The list refreshes on every history change and stays open on a pick.

## Thumbnails

One file per row (`<id>.jpg`), overwritten in place on every save after an
edit, its URL versioned by mtime (`electron/thumbnail.ts`).

## Shortcuts

Settings › Hotkeys › Image editor. Every key can be changed (2026-11-24;
read-only until then), like the capture shortcuts: click the keycaps, press
the new key, Esc cancels, a changed row gets a Reset button. Defaults:
V Cursor, B Brush, H Highlighter, A Arrow, R Rectangle, E Ellipse, T Text, U Blur,
S Sticker, Shift held while drawing "Straight line, square, or circle",
Space held to Pan (row shown while Hold key to pan is on), ⌘C Copy image,
⌘= / ⌘− / ⌘0 Zoom (⌘+ works too), Delete Remove shape (Backspace too).
Ctrl for ⌘ on Windows.

- **Hold keys** (straight line, Pan) are one key on its own: a modifier,
  recorded when it's let go with nothing else pressed, or a plain key.
  Pan refuses the select modifier (⌘ / Ctrl adds shapes).
- **Refused everywhere:** a key another action of the same editor uses, and
  a capture shortcut (it would fire instead).
- **Stored:** only changed keys, `editorKeys.image` in `settings.json`;
  definitions, defaults, matching and recording in `src/lib/editor-keys.ts`
  (unit-tested). The editor reads them when it opens.

## The recording's drawing layer

Since 2026-11-24 the live drawing during a recording is this editor's canvas
(`AnnotationCanvas` with `live`, in `windows/annotation-overlay/`), so it
behaves exactly the same: Shift snapping, ⌘-click and box selection, the
delete button, the text box, ⌘Z / ⇧⌘Z, Delete and the tool keys. `live`
turns off zoom and panning (no wheel, no double-click reset, no hand, no
Space or right-drag) and reports when the layer needs the clicks
(`onInteractiveChange`); otherwise Cursor lets them through to the recorded
app. The recording toolbar's drawing row offers the tools without Sticker
and Blur (a live screen has no pixels to blur), the shared stroke control
(`StrokeControl`) and the eight colours without Custom (left out while Custom
opened macOS's colour panel, a window of its own that would be recorded; the
in-app picker since 2026-11-24 has no such window, but the row stays without
Custom, Jasper 2026-11-25). Colour and stroke are this
editor's saved style (`annotationStyle`), in both directions.
