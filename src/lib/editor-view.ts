/* The image editor remembers each image's zoom and pan (2026-11-23), so
   reopening it shows the same view. Per viewer, in localStorage (a
   convenience: lost storage just means the image opens at 100%), keyed by
   the history row id, the most recent MAX_VIEWS kept. */

export interface EditorView {
  zoom: number
  pan: { x: number; y: number }
}

const KEY = 'lumia:editor-views'
const MAX_VIEWS = 200

function readAll(): Record<string, EditorView> {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function getEditorView(id: string): EditorView | undefined {
  const v = readAll()[id]
  if (!v || typeof v.zoom !== 'number' || !v.pan || typeof v.pan.x !== 'number' || typeof v.pan.y !== 'number') return undefined
  return v
}

/** Saves a view; the default one (100%, centred) is dropped instead. */
export function setEditorView(id: string, view: EditorView) {
  try {
    const all = readAll()
    delete all[id]
    const isDefault = Math.abs(view.zoom - 1) < 0.001 && view.pan.x === 0 && view.pan.y === 0
    if (!isDefault) all[id] = view
    // Insertion order = recency: keep the newest MAX_VIEWS.
    const ids = Object.keys(all)
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_VIEWS))) delete all[old]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* storage unavailable: the view just isn't remembered */ }
}
