// Text for a capture card's status bar. No Electron imports (unit-tested).

/** The capture-mode icons (Icon names), one set app-wide: the list view's
 *  source column, the editor's History panel, the capture overlay's bar
 *  (2026-11-24). */
export const KIND_ICON: Record<'region' | 'window' | 'screen' | 'scroll', string> = {
  window: 'window_mac',  // WindowMacTall (Lucide AppWindowMac, 20x18)
  region: 'region',      // RectDashed (Lucide SquareDashed, 20x18)
  screen: 'monitor',     // Lucide Monitor (20x18 overall)
  scroll: 'scroll_page', // Lucide ScrollText
}

/** An image's pixel size, "1920×1080", or null when it isn't known. */
export function formatDimensions(item: { width?: number; height?: number }): string | null {
  return item.width && item.height ? `${item.width}×${item.height}` : null
}

/** A length as number + unit pairs, so the card can put exactly 1px
 *  between each number and its unit (a space character's width depends on
 *  the font): 42 s → 42 s, 65 s → 1 m 05 s, 1 h 2 min 5 s → 1 h 02 m. */
export function durationParts(ms: number): { value: string; unit: string }[] {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return [{ value: String(h), unit: 'h' }, { value: pad(m), unit: 'm' }]
  if (m > 0) return [{ value: String(m), unit: 'm' }, { value: pad(s), unit: 's' }]
  return [{ value: String(s), unit: 's' }]
}

/** The same length as plain text ("1m 05s"), for labels and tests. In
 *  units, so it never reads like the clock time next to it. */
export function formatDuration(ms: number): string {
  return durationParts(ms).map(p => p.value + p.unit).join(' ')
}

/** A recording's length as the user sees it: the trimmed part when trimmed
 *  (from the real, keyframe-snapped start), else the whole file. */
export function recordingLengthMs(item: { durationMs?: number; trim?: { endMs: number; actualStartMs: number } }): number | undefined {
  if (item.trim) return Math.max(0, item.trim.endMs - item.trim.actualStartMs)
  return item.durationMs
}

/** The clip's file with the folder it's in, "/ Lumia / capture-….png" (the
 *  Cmd-held tooltip, 2026-11-27), in the path's own separator; the name
 *  alone when there's no path. */
export function fileTipText(item: { name: string; filePath?: string }): string {
  if (!item.filePath) return item.name
  const sep = item.filePath.includes('\\') && !item.filePath.includes('/') ? '\\' : '/'
  const parts = item.filePath.split(/[\\/]/).filter(Boolean)
  const folder = parts.length >= 2 ? parts[parts.length - 2] : ''
  const file = parts[parts.length - 1] ?? item.name
  // Led by the separator, so it reads as a path, not a name; spaced like
  // the list's source name (Jasper).
  return folder ? `${sep} ${folder} ${sep} ${file}` : file
}
