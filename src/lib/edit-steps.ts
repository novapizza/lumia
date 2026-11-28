/* The image editor's edit history (2026-11-23, History › Edits): a name for
   each undo step, worked out by comparing the drawings before and after it
   (so the places that change drawings don't each have to say what they
   did), and a compact form for saving the steps with the image.
   Pure: no React or Electron (tests/edit-steps.test.ts). */

/** The parts of a drawn shape the history looks at (DrawObject). */
export interface StepObject {
  id: string
  type: string
  points?: number[]
  x?: number; y?: number
  width?: number; height?: number
  radiusX?: number; radiusY?: number
  text?: string
  color: string
  strokeWidth: number
  fill?: string
  isBlur?: boolean
  src?: string
  /** Hidden from the Layers tab (2026-11-23): not drawn, not exported.
   *  Order and visibility aren't undo steps: every step carries them. */
  hidden?: boolean
}

/** A step's row: its name, the icon (an Icon name), and the one shape it
 *  touched, as it is after the step (a deleted one as it was), for the
 *  row's preview and the canvas highlight; none for several at once. */
export interface StepInfo { label: string; icon: string; shape?: StepObject }

const TOOL_NAMES: Record<string, { label: string; icon: string }> = {
  pen: { label: 'Brush', icon: 'draw' },
  highlighter: { label: 'Highlighter', icon: 'highlight' },
  arrow: { label: 'Arrow', icon: 'arrow_forward' },
  rect: { label: 'Rectangle', icon: 'crop_square' },
  ellipse: { label: 'Ellipse', icon: 'circle' },
  blur: { label: 'Blur', icon: 'blur_on' },
  text: { label: 'Text', icon: 'title' },
  sticker: { label: 'Sticker', icon: 'add_reaction' },
}

function toolOf(o: StepObject): { label: string; icon: string } {
  return TOOL_NAMES[o.isBlur ? 'blur' : o.type] ?? { label: 'Drawing', icon: 'draw' }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What changed from `prev` to `next`, as a row name and icon. */
export function describeStep(prev: StepObject[], next: StepObject[]): StepInfo {
  const before = new Map(prev.map(o => [o.id, o]))
  const after = new Map(next.map(o => [o.id, o]))
  const added = next.filter(o => !before.has(o.id))
  const removed = prev.filter(o => !after.has(o.id))

  if (next.length === 0 && prev.length > 0) return { label: 'Cleared', icon: 'cleaning_services' }
  if (added.length === 1 && removed.length === 0) return { ...toolOf(added[0]), shape: added[0] }
  if (added.length > 1 && removed.length === 0) return { label: `Added ${added.length} drawings`, icon: 'add' }
  if (removed.length === 1 && added.length === 0) {
    return { label: `Deleted ${toolOf(removed[0]).label.toLowerCase()}`, icon: 'delete', shape: removed[0] }
  }
  if (removed.length > 1 && added.length === 0) return { label: `Deleted ${removed.length} drawings`, icon: 'delete' }

  // Same shapes, one (or more) changed: name the first kind of change found.
  for (const o of next) {
    const p = before.get(o.id)
    if (!p || same(p, o)) continue
    if (p.text !== o.text) return { label: 'Edited text', icon: 'title', shape: o }
    if (p.color !== o.color) return { label: 'Colour', icon: 'palette', shape: o }
    if (p.strokeWidth !== o.strokeWidth) return { label: 'Stroke', icon: 'line_weight', shape: o }
    if (p.width !== o.width || p.height !== o.height || p.radiusX !== o.radiusX || p.radiusY !== o.radiusY) {
      return { label: 'Resized', icon: 'open_in_full', shape: o }
    }
    if (p.x !== o.x || p.y !== o.y || !same(p.points, o.points)) return { label: 'Moved', icon: 'open_with', shape: o }
  }
  return { label: 'Edit', icon: 'edit' }
}

/** A layer's row name (Layers tab): a text's own text on one line, else
 *  the tool's name. */
export function layerName(o: StepObject): string {
  if (o.type === 'text') {
    const t = (o.text ?? '').replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  return toolOf(o).label
}

/** A layer's row icon: its tool's. */
export function layerIcon(o: StepObject): string {
  return toolOf(o).icon
}

/** The Layers tab's list, front to back: the drawing's order reversed.
 *  Blurs are ordinary rows here; the canvas draws every shape in this
 *  order, a blur blurring whatever is under it (2026-11-23). */
export function layerOrder<T extends StepObject>(objects: T[]): T[] {
  return [...objects].reverse()
}

/** Saved form: every distinct shape once, each step a list of indexes into
 *  them (a shape unchanged across steps is the same entry), and the step
 *  the editor was on. */
export interface PackedHistory {
  v: 1
  objects: StepObject[]
  steps: number[][]
  cursor: number
}

export function packHistory(steps: StepObject[][], cursor: number): PackedHistory {
  const objects: StepObject[] = []
  const index = new Map<string, number>()
  const packed = steps.map(step => step.map(o => {
    const key = JSON.stringify(o)
    let i = index.get(key)
    if (i === undefined) { i = objects.length; objects.push(o); index.set(key, i) }
    return i
  }))
  return { v: 1, objects, steps: packed, cursor }
}

/** The steps back, or null when the data isn't a valid saved history. */
export function unpackHistory(data: unknown): { steps: StepObject[][]; cursor: number } | null {
  const d = data as PackedHistory | null
  if (!d || d.v !== 1 || !Array.isArray(d.objects) || !Array.isArray(d.steps) || d.steps.length === 0) return null
  if (!Number.isInteger(d.cursor) || d.cursor < 0 || d.cursor >= d.steps.length) return null
  const steps: StepObject[][] = []
  for (const step of d.steps) {
    if (!Array.isArray(step)) return null
    const objs: StepObject[] = []
    for (const i of step) {
      const o = d.objects[i]
      if (!o || typeof o !== 'object') return null
      objs.push(o)
    }
    steps.push(objs)
  }
  return { steps, cursor: d.cursor }
}
