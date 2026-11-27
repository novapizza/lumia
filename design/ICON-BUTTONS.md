# Icon buttons

Icon-only buttons are **one size everywhere**: 32 px `w-8 h-8 rounded-lg`, 16 px icon, `gap-3` between them in a bar, `gap-2` among a card's hover buttons. The why is in `STYLEGUIDE.md` › Buttons and controls; this file is the quick reference. Brought back in step with the code on 2026-11-27 (it still described the 2026-11-21 state).

## The classes

All in `src/components/button-classes.ts`. No file writes a framed button's classes out by hand.

| Class | Look | Used by |
|---|---|---|
| `ICON_BUTTON` | framed: `bg-elevated border border-line`, icon `fg-secondary`; hover `elevated-hover` fill + `fg` icon; disabled `fg-disabled`, no hover | every bar: the editors' file actions, undo / redo, play / mute, Pin, Reset, the recording toolbar |
| `ICON_LINK` | the same on a link (`hover:` without `enabled:`, which never matches an `<a>`) | the app bar's Back, Settings and theme |
| `ICON_BUTTON_FRAME` | the 32 px frame alone, no icon colour or hover | a button whose icon has colours of its own: Select, missing files, the on-state gear |
| `DANGER_ICON_BUTTON` | `ICON_BUTTON` whose icon turns `danger-text` under the pointer (grey at rest) | Clear edits, the recording's Clear and Discard, a workflow step's Remove |
| `ACCENT_ICON_BUTTON` | accent fill, `on-accent` icon; disabled falls back to framed | the trim bar's Trim |
| `BARE_ICON_BUTTON` | no fill or edge at rest, icon `fg-secondary`; hover `toolbar-hover` fill, `line-subtle` border, `fg` icon | a row's action: the Layers eye |
| `BUTTON` / `ACCENT_BUTTON` / `DANGER_BUTTON` | the text versions, 32 px tall, `px-2.5`, 12 px medium; `DANGER_BUTTON`'s label turns `danger-text` under the pointer | Settings, dialogs; Disconnect and the Workflow page's Delete |

On a clip, `components/ClipActionButton.tsx` draws the action buttons:

| Where | Look |
|---|---|
| A card's hover buttons | `bg-toolbar border border-line-strong`, icon `fg-secondary`; hover `toolbar-hover` fill + `fg` icon. An action that can't run is hidden, not disabled |
| A list row's actions (`bare`) | `BARE_ICON_BUTTON`'s look, always shown, first in the row. One that can't run is shown disabled (`unavailable`: `fg-disabled`, tooltip kept, no hover), so the columns hold |
| Delete (`danger`), both | icon `fg-secondary` at rest, plain `danger-text` under the pointer |

## Delete buttons turn red only under the pointer (2026-11-27)

Every button that deletes, discards, clears or disconnects rests in the grey of the buttons around it (`fg-secondary`) and shows its icon or label in plain `danger-text` under the pointer (`danger-text-hover` belongs to the three exceptions below). A clip's Delete, Clear edits, the recording's Clear and Discard, Disconnect, the Workflow page's Delete and Remove.

Three exceptions are red at rest (`danger-text`) and step to `danger-text-hover`: Select's trash in select mode (its count badge with it), the armed "Confirm disconnect", and the trash on a selected shape in the image editor. Red at rest on every delete was tried the same day and dropped.

## On state of a framed button

The icon keeps its colour; a straight 3 px `bg-accent` strip runs along the bottom edge, inside the border, masked to the frame's inner shape. No fill. One component, `components/OnStrip.tsx`: the button takes `relative` and `group/on`, and the strip steps to `accent-text-hover` under the pointer.

Used by: Select in select mode, Settings on its page, Background, History and the image toolbar's callout buttons while their panel is open, Wallpapers' Filter, the recording's Mic and Draw, the keycaps while recording a shortcut, and Pin on the History panel and the sticker sidebar while pinned (one icon for on and off).

Not for the theme button: light and dark are two equal choices, neither is "on".

## Hover

Instant colour changes, details in `STYLEGUIDE.md` › Hover:

- **Framed buttons:** fill `elevated` → `elevated-hover`; icon grey → `fg`, red → `danger-text-hover` (Select's trash), orange → `warning-text-hover`, a delete button's grey → `danger-text`; a count badge and the on-state strip follow.
- **Segments:** unselected icon / label `fg-secondary` → `fg`.
- **Card hover buttons:** fill `toolbar` → `toolbar-hover`, icon → `fg`.
- **Bare row actions:** `toolbar-hover` fill, `line-subtle` border, icon → `fg`.
- Disabled / `aria-disabled` buttons: none.

## The Dashboard filters

All in the app bar's slot, `gap-3`, in this order: missing files (when files are gone), type filter, view switch, Select. "Filters" always means the whole group, Select included. The type filter and view are remembered across pages and restarts (`localStorage`).

- **Select:** `check_circle` in `fg-secondary`. In select mode with nothing selected, the same check with the on-state strip, tooltip "Cancel" (leaves select mode). With clips selected, the red trash (`danger-text`, red at rest) with its count badge, keeping the strip (deletes them; a delete keeps select mode). Esc and a click on empty space in the clip area also leave select mode. Drag-to-select and Shift-click ranges: `windows/dashboard/useSelectGestures.ts`.
- **Missing files:** Lucide FileXCorner in `warning-text` with a count badge. Tooltip "Clear".
- **The app bar's own buttons** (`gap-10` after the filters, `gap-3` between them): theme (a plain moon / sun) and Settings. On the Settings page the gear shows the on state and closes Settings (tooltip "Close"). In the editors a Back arrow to the Dashboard sits before the page's controls.

## Count badges

`absolute -top-1 -right-1.5 min-w-3.5 h-3.5 px-0.75 pt-px rounded-full ring-2 ring-toolbar`: 14 px, on the button's top-right corner, the 2 px ring in the app bar's colour cutting it out of the button's edge. Number 8 px `font-mono font-semibold` (system mono, the one non-Manrope text), nudged down half a pixel with `pt-px`, since SF Mono's digits sit high. Filled with the icon's colour, status pair inverted: `bg-danger-text text-danger-subtle` (trash), `bg-warning-text text-warning-subtle` (missing files).

## Status tags on a capture

Status isn't a button, so it never uses a button's box. On a card, tags sit in the status bar, bare (no box, fill or outline), `gap-1`, the last one 8 px from the edge. All are 14 px icons since 2026-11-23:

- **Type**, first on the left: Video (`smart_display`, Lucide SquarePlay) in `text-kind-video` (pink) or Image (`image`) in `text-kind-image` (blue), tooltip "Video" / "Image".
- **Missing:** `file_x_corner` in `text-warning-text` (a 10 px uppercase text tag before).
- **Uploaded:** `radio` (`RadioNarrow`) in `text-success-text`.

In the list view the same icons sit on small pills (`h-5 px-1 rounded-full`), pale fills in their text colour. All tags stay in select mode.

## Not buttons of that size, fine as they are

- **Segments** inside a `Segmented` control: 28 px wide, the track's height, `rounded-md`, 16 px icon, inside a `h-8 p-0.5 rounded-lg bg-elevated border-line` track.
- **The zoom group** on the image toolbar: − | % | + as one framed 32 px group with `line-subtle` dividers.
- **Selection circles** on a card and a list row: 20 px round.
- **A toast's buttons:** the bare 24 px X with a 14 px icon, the 24 px accent text button.
- **A search field's ×:** bare, 20 px, 14 px icon.

## Selected state

- **Segments:** `bg-accent text-on-accent`, the purple of a selected clip's outline; one pill that slides to the picked segment (160 ms).
- **Toggles:** `bg-accent` with a white knob, a `border-line-strong` edge in both states.
- **A page in a list** (the Settings nav, the Workflow list): `bg-accent text-on-accent`.
- **A button in a single-select grid** (Wallpapers' categories) and a cell of the Background panel's Alignment track: the accent fill with `on-accent`.
- **A card** (a clip, a screen in the screen picker): the inset accent `--selection-ring`.
- Words and icons share one colour on a selected fill. Never accent-coloured text or icons on a purple fill. Unselected: no fill (or the control's own `bg-elevated`), `text-fg-secondary`.

## Still open

- The unmounted Share dialog's close button is still 28 px with older styling; it goes in that dialog's review (`OPEN-QUESTIONS.md`).
