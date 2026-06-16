/** Shared tool / palette constants used by both the image editor and video
 *  annotator. Keep this file free of React imports so it can be consumed by
 *  pure render helpers too. */

export type Tool = 'none' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'blur' | 'sticker'

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
  { id: 'pen',     icon: 'draw',              label: 'Pen',       shortcut: 'P' },
  { id: 'arrow',   icon: 'arrow_forward',     label: 'Arrow',     shortcut: 'A' },
  { id: 'rect',    icon: 'crop_square',       label: 'Rectangle', shortcut: 'R' },
  { id: 'ellipse', icon: 'circle',            label: 'Ellipse',   shortcut: 'E' },
]

export const EXTRA_TOOLS: ToolDef[] = [
  { id: 'blur',    icon: 'blur_on',           label: 'Blur',      shortcut: 'B' },
  { id: 'text',    icon: 'title',             label: 'Text',      shortcut: 'T' },
  { id: 'sticker', icon: 'add_reaction',      label: 'Sticker',   shortcut: 'S' },
]

/** All tools in a single lookup — used for keyboard shortcut handling. */
export const ALL_TOOLS: ToolDef[] = [...SELECT_TOOLS, ...DRAW_TOOLS, ...EXTRA_TOOLS]

/** Canonical color palette. Keep order stable — users learn positions. */
export const COLORS = [
  '#f87171', // red
  '#fb923c', // orange
  '#fbbf24', // amber
  '#34d399', // emerald
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#f472b6', // pink
  '#ffffff', // white
  '#000000', // black
] as const

/** Stroke-width quick picks shown alongside the slider. */
export const STROKE_PRESETS = [2, 4, 8] as const

/** Return tool id for a keyboard key (case-insensitive). Null = no match. */
export function matchToolShortcut(key: string): Tool | null {
  const upper = key.toUpperCase()
  return ALL_TOOLS.find(t => t.shortcut === upper)?.id ?? null
}
