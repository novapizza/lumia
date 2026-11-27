/** The image and video editors' keys (2026-11-24): every one can be changed
 *  in Settings › Hotkeys, like the capture shortcuts. Pure (no React, no
 *  Electron, no runtime imports) so `pnpm test` can import it.
 *
 *  A binding is written like a capture accelerator: modifiers in the order
 *  Ctrl, Cmd (macOS) / Super, Alt, Shift, then the key, joined by "+"
 *  ("V", "Cmd+C", "Shift+Left", "Space", "Delete"). A hold action (pan, the
 *  straight-line key) is one key on its own: a modifier ("Shift", "Alt",
 *  "Ctrl", "Cmd") or a plain key ("Space"). */

export type EditorKind = 'image' | 'video'
export type Keymap = Record<string, string>

export interface KeyAction {
  id: string
  label: string
  /** Held while dragging rather than pressed. */
  hold?: boolean
  mac: string
  win: string
}

const same = (k: string) => ({ mac: k, win: k })
const mod = (k: string) => ({ mac: `Cmd+${k}`, win: `Ctrl+${k}` })

/** Tool keys are `tool:<Tool id>`. Order is the Settings list's. */
export const IMAGE_KEY_ACTIONS: readonly KeyAction[] = [
  { id: 'tool:none', label: 'Cursor', ...same('V') },
  { id: 'tool:pen', label: 'Brush', ...same('B') },
  { id: 'tool:highlighter', label: 'Highlighter', ...same('H') },
  { id: 'tool:arrow', label: 'Arrow', ...same('A') },
  { id: 'tool:rect', label: 'Rectangle', ...same('R') },
  { id: 'tool:ellipse', label: 'Ellipse', ...same('E') },
  { id: 'tool:text', label: 'Text', ...same('T') },
  { id: 'tool:blur', label: 'Blur', ...same('U') },
  { id: 'tool:sticker', label: 'Sticker', ...same('S') },
  { id: 'constrain', label: 'Straight line, square, or circle', hold: true, ...same('Shift') },
  // The key only with Settings › Hold key to pan on (without it Settings
  // shows the row as Right-drag alone).
  { id: 'pan', label: 'Pan', hold: true, ...same('Space') },
  { id: 'copy', label: 'Copy image', ...mod('C') },
  { id: 'zoomIn', label: 'Zoom in', ...mod('=') },
  { id: 'zoomOut', label: 'Zoom out', ...mod('-') },
  { id: 'zoomReset', label: 'Reset zoom', ...mod('0') },
  { id: 'delete', label: 'Remove shape', ...same('Delete') },
]

export const VIDEO_KEY_ACTIONS: readonly KeyAction[] = [
  { id: 'playPause', label: 'Play or pause', ...same('Space') },
  { id: 'trimStart', label: 'Set trim start', ...same('D') },
  { id: 'trimEnd', label: 'Set trim end', ...same('F') },
  { id: 'stepBack', label: 'Step back a frame', ...same('Left') },
  { id: 'stepForward', label: 'Step forward a frame', ...same('Right') },
  { id: 'stepBack10', label: 'Step back ten frames', ...same('Shift+Left') },
  { id: 'stepForward10', label: 'Step forward ten frames', ...same('Shift+Right') },
]

export function keyActions(kind: EditorKind): readonly KeyAction[] {
  return kind === 'image' ? IMAGE_KEY_ACTIONS : VIDEO_KEY_ACTIONS
}

export function defaultKeymap(kind: EditorKind, mac: boolean): Keymap {
  return Object.fromEntries(keyActions(kind).map(a => [a.id, mac ? a.mac : a.win]))
}

/** Defaults with the user's overrides on top (unknown ids and non-strings
 *  dropped). */
export function resolveKeymap(kind: EditorKind, overrides: unknown, mac: boolean): Keymap {
  const map = defaultKeymap(kind, mac)
  if (overrides && typeof overrides === 'object') {
    for (const [id, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (id in map && typeof v === 'string' && v) map[id] = v
    }
  }
  return map
}

/** The overrides to store: only bindings that differ from the default. */
export function overridesOf(kind: EditorKind, map: Keymap, mac: boolean): Keymap {
  const def = defaultKeymap(kind, mac)
  return Object.fromEntries(Object.entries(map).filter(([id, b]) => def[id] !== undefined && def[id] !== b))
}

// ── Keys ──────────────────────────────────────────────────────────────────

/** A KeyboardEvent.code as a binding key (the capture accelerators' names),
 *  or null for a modifier or an unknown key. Physical keys, so a layout or
 *  Option's special characters don't change it. */
export function codeToKey(code: string): string | null {
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) {
    const tail = code.slice(6)
    if (/^\d$/.test(tail)) return `num${tail}`
    if (tail === 'Add') return 'numadd'
    if (tail === 'Subtract') return 'numsub'
    if (tail === 'Multiply') return 'nummult'
    if (tail === 'Divide') return 'numdiv'
    if (tail === 'Decimal') return 'numdec'
    if (tail === 'Enter') return 'Return'
    return null
  }
  if (code.startsWith('Key')) return code.slice(3)
  if (/^F\d{1,2}$/.test(code)) return code
  switch (code) {
    case 'Space': return 'Space'
    case 'Enter': return 'Return'
    case 'Tab': return 'Tab'
    case 'Backspace': return 'Backspace'
    case 'Delete': return 'Delete'
    case 'Insert': return 'Insert'
    case 'Home': return 'Home'
    case 'End': return 'End'
    case 'PageUp': return 'PageUp'
    case 'PageDown': return 'PageDown'
    case 'ArrowUp': return 'Up'
    case 'ArrowDown': return 'Down'
    case 'ArrowLeft': return 'Left'
    case 'ArrowRight': return 'Right'
    case 'Comma': return ','
    case 'Period': return '.'
    case 'Slash': return '/'
    case 'Backslash': return '\\'
    case 'Semicolon': return ';'
    case 'Quote': return '\''
    case 'BracketLeft': return '['
    case 'BracketRight': return ']'
    case 'Minus': return '-'
    case 'Equal': return '='
    case 'Backquote': return '`'
  }
  return null
}

interface KeyLike {
  code: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** A key event as a binding ("Cmd+C"), or null for a lone modifier press. */
export function eventToBinding(e: KeyLike, mac: boolean): string | null {
  const key = codeToKey(e.code)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey) parts.push(mac ? 'Cmd' : 'Super')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

const MODIFIERS = ['Ctrl', 'Cmd', 'Super', 'Alt', 'Shift'] as const

/** A modifier key's binding name ("Shift"), or null for any other key. */
export function modifierName(key: string, mac: boolean): string | null {
  if (key === 'Shift') return 'Shift'
  if (key === 'Alt') return 'Alt'
  if (key === 'Control') return 'Ctrl'
  if (key === 'Meta') return mac ? 'Cmd' : 'Super'
  return null
}

export function isModifierBinding(b: string): boolean {
  return (MODIFIERS as readonly string[]).includes(b)
}

function parse(b: string): { mods: Set<string>; key: string } {
  // The key can itself be "+"-free only ("=" for plus), so the last part is it.
  const parts = b.split('+')
  const key = parts.pop() ?? ''
  return { mods: new Set(parts), key }
}

/** Delete and Backspace are one key here (macOS's delete key is Backspace). */
const sameKey = (a: string, b: string) =>
  a === b || ((a === 'Delete' || a === 'Backspace') && (b === 'Delete' || b === 'Backspace'))

/** Does a key press match a (press) binding? Modifiers must match exactly,
 *  except that "=" also takes Shift (so ⌘+ and ⌘= both zoom in). */
export function matchesBinding(binding: string, e: KeyLike, mac: boolean): boolean {
  if (!binding) return false
  const key = codeToKey(e.code)
  if (!key) return false
  const { mods, key: want } = parse(binding)
  if (!sameKey(want, key)) return false
  const meta = mac ? 'Cmd' : 'Super'
  if (mods.has('Ctrl') !== e.ctrlKey) return false
  if (mods.has(meta) !== e.metaKey) return false
  if (mods.has('Alt') !== e.altKey) return false
  if (mods.has('Shift') !== e.shiftKey && !(want === '=' && e.shiftKey)) return false
  return true
}

/** Is this key event (down or up) the hold key itself? */
export function isHoldKeyEvent(binding: string, e: { code: string; key: string }, mac: boolean): boolean {
  if (isModifierBinding(binding)) return modifierName(e.key, mac) === binding
  const key = codeToKey(e.code)
  return !!key && sameKey(binding, key)
}

/** Is a hold key down, read from a mouse or key event's modifier flags
 *  (modifiers) or from the keys the caller saw go down (plain keys). */
export function isHoldDown(
  binding: string,
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  held: ReadonlySet<string>,
  mac: boolean,
): boolean {
  switch (binding) {
    case 'Shift': return e.shiftKey
    case 'Alt': return e.altKey
    case 'Ctrl': return e.ctrlKey
    case 'Cmd': return mac && e.metaKey
    case 'Super': return !mac && e.metaKey
  }
  return held.has(binding) || (binding === 'Delete' && held.has('Backspace'))
}

/** The modifier that adds shapes to the selection (⌘-click / Ctrl-click). */
export const selectModifier = (mac: boolean) => (mac ? 'Cmd' : 'Ctrl')

/** A binding (editor key or capture accelerator) as keycaps, in order:
 *  "Cmd+Shift+Left" → ["⌘", "⇧", "←"] on macOS. macOS shows ⌘ ⌥ ⌃
 *  ⇧ (2026-11-24); Space and the named keys stay words; arrows are arrows.
 *  Windows has no key symbols: Ctrl, Alt, Shift, Win. */
export function keycapsOf(binding: string, mac: boolean): string[] {
  if (!binding) return []
  // No key is "+" itself (plus is "="), so splitting is safe.
  return binding.split('+').map(p => {
    switch (p) {
      case 'Cmd': case 'Command': return mac ? '⌘' : 'Win'
      case 'CmdOrCtrl': case 'CommandOrControl': return mac ? '⌘' : 'Ctrl'
      case 'Super': return 'Win'
      case 'Alt': case 'Option': return mac ? '⌥' : 'Alt'
      case 'Ctrl': case 'Control': return mac ? '⌃' : 'Ctrl'
      case 'Shift': return mac ? '⇧' : 'Shift'
      case 'Left': return '←'
      case 'Right': return '→'
      case 'Up': return '↑'
      case 'Down': return '↓'
      case 'Return': return mac ? 'Return' : 'Enter'
      case 'Backspace': return mac ? 'Delete' : 'Backspace'
      default: return p.startsWith('num') ? `Num ${p.slice(3)}` : p
    }
  })
}

/** Keycap names spoken / shown in messages ("Cmd+C" → "⌘C" on macOS). */
export function bindingText(binding: string, mac: boolean): string {
  const caps = keycapsOf(binding, mac)
  return mac ? caps.map(c => (c.length > 1 && caps.length > 1 ? c + ' ' : c)).join('').trim() : caps.join('+')
}

/** The id of another action already bound to `binding`, if any. */
export function conflictOf(map: Keymap, id: string, binding: string): string | undefined {
  return Object.entries(map).find(([other, b]) => other !== id && b === binding)?.[0]
}

export function labelOf(kind: EditorKind, id: string): string {
  return keyActions(kind).find(a => a.id === id)?.label ?? id
}
