# Layers tab (image editor), design

2026-11-23. Short design, agreed in conversation.

## Why

Find and pick shapes (also ones that are hard to click on the canvas), change which shape sits on top, and hide shapes while working.

## What

A third tab in the image editor's History panel, first: **Layers · Edits · Recent**. The tabs become icon segments (16px, the standard Segmented) with one-word tooltips: Layers = Lucide `Layers`, Edits = `RotateCcwClock`, Recent = `ListClock`.

- **List:** every shape on the image, front to back (top row = last in the order). Blurs are ordinary rows in their real place and can be dragged anywhere (Jasper, 2026-11-23). A new blur starts at the bottom. The canvas draws every shape in this order, and a blur blurs whatever is under it, so one moved above a shape blurs that shape too; stacked blurs add up.
- **Row:** a drag grip at the left (2026-11-26: Lucide GripVertical, 16px, `fg-tertiary`, 6px before the preview; the open hand over it, the closed hand on the list while a row is dragged; the whole row still drags), the shape preview (as in Edits; a sticker shows its own picture since 2026-11-26), the shape's name (Brush, Arrow, Rectangle, Ellipse, Text with its text, Sticker, Blur), and an eye button (16px icon) at the right.
- **Hover a row:** outlines the shape on the canvas (the Edits hover highlight).
- **Click a row:** selects that shape on the canvas, as a Cursor click would; ⌘-click adds or removes it. Selected rows show the marked-row look, as the current step in Edits: the Dashboard's selected outline (inset `ring-accent`, 1px dark / 1.5px light), no fill (2026-11-24; an elevated fill with a line edge before). Rows are 50px with a 36px square preview (40px rows, 40 x 28 previews before); the drag maths uses a 54px pitch.
- **Drag a row:** moves the shape in the stacking order. While dragged, a ghost of the row follows the pointer, the row leaves the list (the rows close up) and an empty row-sized slot opens where the ghost hovers; rows jump, no motion. Not an undo step (see Behaviour).
- **Eye:** hides or shows the shape. Hidden rows stay in the list, their preview greyscale and their name in `fg-disabled`, the eye showing the closed icon.

## Behaviour

- **Order** is the shapes' order in the drawing (the `objects` array): later = on top, for blurs too (new blurs are inserted first, at the bottom).
- **Hidden** (`hidden: true` on the shape, saved with the annotations): not drawn on the canvas, not clickable, not in the selection box, and **left out of Copy / Save / Upload** (what you see is what you export). Hiding a selected shape drops it from the selection.
- **Undo:** reorder, hide and show are not undo steps and don't show in Edits (Jasper, 2026-11-23). They're written into every saved step, so undo / redo / a step jump keep the current order and visibility.
- **Saved:** order and hidden state are part of the annotations, so reopening the image keeps them.

## Approaches considered

1. **Drag rows to reorder (picked).** Like Figma / Photoshop; one drag moves a shape past several others.
2. Arrow buttons per row (up / down or front / back): simpler, but many clicks for a long move.

## Left to the builder

- The drag mechanics (pointer events).
- The canvas API for selecting by id from the panel.
- The panel's width: icon tabs make the header narrower; the Recent subline sizer keeps it wide enough.
