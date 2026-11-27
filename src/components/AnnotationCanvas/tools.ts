/** Shared tool / palette constants used by both the image editor and video
 *  annotator. Keep this file free of React imports so it can be consumed by
 *  pure render helpers too. */

import { DEFAULT_ANNOTATION_COLOR } from '../../../shared/annotation'

export type Tool = 'none' | 'pen' | 'highlighter' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'blur' | 'sticker'

export interface ToolDef {
  id: Tool
  icon: string
  label: string
  shortcut: string
}

// Tool order is kept in lockstep with the live recording-time annotation
// palette so the two surfaces feel like the same UI: cursor first, then the
// shared drawing tools (pen, arrow, rect, ellipse). Editor-only specialty
// tools (blur, text) trail the shared set instead of being mixed in.

export const SELECT_TOOLS: ToolDef[] = [
  // 'none' = cursor mode: doesn't draw, click an outline to select for
  // delete/drag. Same id and visual as the live recording overlay's
  // unified select-and-interact mode, so users don't have to learn two
  // different idioms.
  { id: 'none',  icon: 'arrow_selector_tool', label: 'Cursor', shortcut: 'V' },
]

export const DRAW_TOOLS: ToolDef[] = [
  { id: 'pen',     icon: 'draw',              label: 'Brush',     shortcut: 'B' },
  // From the recording's live drawing (2026-11-24): a freehand stroke drawn
  // HIGHLIGHTER_WIDTH x as wide at HIGHLIGHTER_OPACITY.
  { id: 'highlighter', icon: 'highlight',     label: 'Highlighter', shortcut: 'H' },
  { id: 'arrow',   icon: 'arrow_forward',     label: 'Arrow',     shortcut: 'A' },
  { id: 'rect',    icon: 'crop_square',       label: 'Rectangle', shortcut: 'R' },
  { id: 'ellipse', icon: 'circle',            label: 'Ellipse',   shortcut: 'E' },
]

// Text before Blur (2026-11-23; Blur came first). Sticker isn't a tool
// since 2026-11-26: a toggle button beside the tools opens its panel, like
// History ('sticker' stays in `Tool` as a shape kind).
export const EXTRA_TOOLS: ToolDef[] = [
  { id: 'text',    icon: 'title',             label: 'Text',      shortcut: 'T' },
  { id: 'blur',    icon: 'blur_on',           label: 'Blur',      shortcut: 'U' },
]

/** Highlighter strokes: this many times the picked width, at this opacity. */
export const HIGHLIGHTER_WIDTH = 4
export const HIGHLIGHTER_OPACITY = 0.35

/** Freehand tools: a trail of points (Pen, Highlighter). */
export const isFreehand = (t: string | undefined) => t === 'pen' || t === 'highlighter'

/** Canonical color palette. Keep order stable — users learn positions. */
export const COLORS = [
  DEFAULT_ANNOTATION_COLOR, // red (#ee3533), the colour a drawing starts in
  '#fe860f', // orange
  '#fbda1b', // yellow
  '#40d872', // green
  '#2896f5', // blue
  '#822dda', // purple
  '#ffffff', // white
  '#000000', // black
] as const

/** Stroke-width quick picks shown alongside the slider. */
export const STROKE_PRESETS = [2, 4, 8] as const

// Tool keys (and every other editor key) are in src/lib/editor-keys.ts
// since 2026-11-24, when they became changeable; `shortcut` above is only
// the default there.
