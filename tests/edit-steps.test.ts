import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeStep, layerIcon, layerName, layerOrder, packHistory, unpackHistory, type StepObject } from '../src/lib/edit-steps.ts'

const pen: StepObject = { id: 'a', type: 'pen', points: [0, 0, 10, 10], color: '#ee3533', strokeWidth: 4 }
const rect: StepObject = { id: 'b', type: 'rect', x: 5, y: 5, width: 20, height: 10, color: '#2896f5', strokeWidth: 2 }
const text: StepObject = { id: 'c', type: 'text', x: 1, y: 1, text: 'Hi', color: '#000000', strokeWidth: 2 }

test('an added shape is named after its tool', () => {
  assert.deepEqual(describeStep([], [pen]), { label: 'Brush', icon: 'draw', shape: pen })
  assert.deepEqual(describeStep([pen], [pen, rect]), { label: 'Rectangle', icon: 'crop_square', shape: rect })
  assert.equal(describeStep([], [{ ...rect, id: 'z', type: 'blur', isBlur: true }]).label, 'Blur')
})

test('several shapes added at once', () => {
  assert.equal(describeStep([], [pen, rect]).label, 'Added 2 drawings')
})

test('a removed shape', () => {
  assert.deepEqual(describeStep([pen, rect], [pen]), { label: 'Deleted rectangle', icon: 'delete', shape: rect })
})

test('everything removed is Cleared', () => {
  assert.deepEqual(describeStep([pen, rect], []), { label: 'Cleared', icon: 'cleaning_services' })
})

test('moved, resized, colour, stroke, text', () => {
  assert.equal(describeStep([rect], [{ ...rect, x: 50 }]).label, 'Moved')
  assert.equal(describeStep([pen], [{ ...pen, points: [5, 5, 15, 15] }]).label, 'Moved')
  assert.equal(describeStep([rect], [{ ...rect, width: 40 }]).label, 'Resized')
  assert.equal(describeStep([rect], [{ ...rect, color: '#000000' }]).label, 'Colour')
  assert.equal(describeStep([rect], [{ ...rect, strokeWidth: 8 }]).label, 'Stroke')
  assert.equal(describeStep([text], [{ ...text, text: 'Hello' }]).label, 'Edited text')
})

test('no visible change still gets a name', () => {
  assert.equal(describeStep([rect], [rect]).label, 'Edit')
})

test('pack and unpack round-trip, cursor kept', () => {
  const steps = [[], [pen], [pen, rect], [pen, { ...rect, x: 50 }]]
  const packed = packHistory(steps, 2)
  assert.deepEqual(unpackHistory(packed), { steps, cursor: 2 })
})

test('pack stores a shape shared by several steps once', () => {
  const steps = [[], [pen], [pen, rect], [pen, rect, text]]
  const packed = packHistory(steps, 3)
  assert.equal(packed.objects.length, 3)
})

test('unpack rejects malformed data', () => {
  assert.equal(unpackHistory(null), null)
  assert.equal(unpackHistory({ v: 1, objects: [], steps: [[0]], cursor: 0 }), null)
  assert.equal(unpackHistory({ v: 1, objects: [pen], steps: [[0]], cursor: 5 }), null)
})

test("a changed shape is the step's shape, as it is after the step", () => {
  const moved = { ...rect, x: 50 }
  assert.deepEqual(describeStep([pen, rect], [pen, moved]).shape, moved)
})

test('several shapes at once have no single shape', () => {
  assert.equal(describeStep([], [pen, rect]).shape, undefined)
})

// ── Layers tab (2026-11-23) ──
const blur: StepObject = { id: 'd', type: 'blur', isBlur: true, x: 0, y: 0, width: 9, height: 9, color: '#000000', strokeWidth: 2 }

test('layer names: the tool, or a text\'s own text', () => {
  assert.equal(layerName(pen), 'Brush')
  assert.equal(layerName(blur), 'Blur')
  assert.equal(layerName(text), 'Hi')
  assert.equal(layerName({ ...text, text: '  ' }), 'Text')
  assert.equal(layerName({ ...text, text: 'one\ntwo' }), 'one two')
  assert.equal(layerIcon(rect), 'crop_square')
})

test('layerOrder lists front to back, blurs where they are in the order', () => {
  assert.deepEqual(layerOrder([pen, blur, rect, text]).map(o => o.id), ['c', 'b', 'd', 'a'])
})
