/* Shared button looks (2026-11-22; from Settings' BUTTON). Framed controls
   sit on elevated with a line edge; grey label or icon that turns fg under
   the pointer; disabled: fg-disabled, no hover, never faded. */

/** A framed text button, 32px tall (Settings' Browse / Disconnect, the
 *  editor's Copy / Save / Upload). */
export const BUTTON =
  'h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-elevated border border-line text-xs font-medium text-fg-secondary flex-shrink-0 whitespace-nowrap enabled:hover:bg-elevated-hover enabled:hover:text-fg disabled:text-fg-disabled'

/** BUTTON for an action that deletes or disconnects (2026-11-27, Jasper,
 *  final: every delete rests in the grey of the buttons around it and turns
 *  red only under the pointer, in plain danger-text; red at rest was tried
 *  the same day). Settings' Disconnect, the Workflow page's Delete. */
export const DANGER_BUTTON =
  'h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-elevated border border-line text-xs font-medium text-fg-secondary flex-shrink-0 whitespace-nowrap enabled:hover:bg-elevated-hover enabled:hover:text-danger-text disabled:text-fg-disabled'

/** The framed 32px box alone, without an icon colour or hover: for a button
 *  whose icon has colours of its own (the Dashboard's Select and missing
 *  files). Every framed icon button below starts from it. */
export const ICON_BUTTON_FRAME =
  'w-8 h-8 inline-flex items-center justify-center rounded-lg bg-elevated border border-line flex-shrink-0'

/** A framed 32px icon button with a 16px icon (the AppBar's buttons). */
export const ICON_BUTTON =
  `${ICON_BUTTON_FRAME} text-fg-secondary enabled:hover:bg-elevated-hover enabled:hover:text-fg disabled:text-fg-disabled`

/** ICON_BUTTON on a link (the AppBar's Back and Settings): `:enabled` never
 *  matches an `<a>`, so its hover is plain `hover:`. */
export const ICON_LINK =
  `${ICON_BUTTON_FRAME} text-fg-secondary hover:bg-elevated-hover hover:text-fg`

/** ICON_BUTTON for an action that deletes or discards (2026-11-27, Jasper,
 *  final): grey at rest like its neighbours, the icon in plain danger-text
 *  under the pointer. Clear edits, the recording's Clear and Discard, a
 *  workflow step's Remove. */
export const DANGER_ICON_BUTTON =
  `${ICON_BUTTON_FRAME} text-fg-secondary enabled:hover:bg-elevated-hover enabled:hover:text-danger-text disabled:text-fg-disabled`

/** A bare 32px icon button on a row (the History panel's eye; a list row's
 *  actions draw the same through ClipActionButton `bare`): no fill or edge
 *  at rest; under the pointer the toolbar-hover fill, a line-subtle border
 *  (there, transparent, at rest, so nothing moves) and an fg icon. */
export const BARE_ICON_BUTTON =
  'w-8 h-8 inline-flex items-center justify-center rounded-lg flex-shrink-0 border border-transparent text-fg-secondary hover:bg-toolbar-hover hover:border-line-subtle hover:text-fg'

/** The one main action of a screen (Settings' Connect, the editor's Apply
 *  trim): accent fill; disabled it falls back to a plain framed button. */
export const ACCENT_BUTTON =
  'h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium flex-shrink-0 whitespace-nowrap enabled:bg-accent enabled:border-accent enabled:text-on-accent enabled:hover:bg-accent-hover disabled:bg-elevated disabled:border-line disabled:text-fg-disabled'

/** ICON_BUTTON for a main action (the trim bar's Trim): accent fill;
 *  disabled it falls back to a plain framed button. */
export const ACCENT_ICON_BUTTON =
  'w-8 h-8 inline-flex items-center justify-center rounded-lg border flex-shrink-0 enabled:bg-accent enabled:border-accent enabled:text-on-accent enabled:hover:bg-accent-hover disabled:bg-elevated disabled:border-line disabled:text-fg-disabled'
