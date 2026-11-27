import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveKeymap, overridesOf, eventToBinding, matchesBinding, isHoldKeyEvent, isHoldDown,
  conflictOf, keycapsOf, defaultKeymap, modifierName,
} from '../src/lib/editor-keys.ts'

const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

test('defaults differ by platform for chords only', () => {
  const mac = defaultKeymap('image', true)
  const win = defaultKeymap('image', false)
  assert.equal(mac.copy, 'Cmd+C')
  assert.equal(win.copy, 'Ctrl+C')
  assert.equal(mac['tool:pen'], 'B')
  assert.equal(mac['tool:blur'], 'U')
  assert.equal(win.pan, 'Space')
})

test('resolveKeymap applies known overrides only', () => {
  const map = resolveKeymap('image', { 'tool:pen': 'K', bogus: 'X', copy: 3 }, true)
  assert.equal(map['tool:pen'], 'K')
  assert.equal(map.copy, 'Cmd+C')
  assert.ok(!('bogus' in map))
})

test('overridesOf keeps only changed bindings', () => {
  const map = { ...defaultKeymap('video', true), trimStart: 'J' }
  assert.deepEqual(overridesOf('video', map, true), { trimStart: 'J' })
})

test('eventToBinding orders modifiers and skips lone modifiers', () => {
  assert.equal(eventToBinding(ev('KeyC', 'c', { metaKey: true }), true), 'Cmd+C')
  assert.equal(eventToBinding(ev('ArrowLeft', 'ArrowLeft', { shiftKey: true, ctrlKey: true }), false), 'Ctrl+Shift+Left')
  assert.equal(eventToBinding(ev('ShiftLeft', 'Shift', { shiftKey: true }), true), null)
})

test('matchesBinding needs exact modifiers, except = takes Shift', () => {
  assert.ok(matchesBinding('P', ev('KeyP', 'p'), true))
  assert.ok(!matchesBinding('P', ev('KeyP', 'p', { metaKey: true }), true))
  assert.ok(matchesBinding('Cmd+=', ev('Equal', '+', { metaKey: true, shiftKey: true }), true))
  assert.ok(matchesBinding('Shift+Left', ev('ArrowLeft', 'ArrowLeft', { shiftKey: true }), false))
  assert.ok(!matchesBinding('Left', ev('ArrowLeft', 'ArrowLeft', { shiftKey: true }), false))
})

test('Delete and Backspace are one key', () => {
  assert.ok(matchesBinding('Delete', ev('Backspace', 'Backspace'), true))
  assert.ok(matchesBinding('Delete', ev('Delete', 'Delete'), false))
})

test('hold keys: modifiers from flags, plain keys from the held set', () => {
  assert.ok(isHoldKeyEvent('Shift', ev('ShiftRight', 'Shift'), true))
  assert.ok(isHoldKeyEvent('Space', ev('Space', ' '), true))
  assert.ok(!isHoldKeyEvent('Alt', ev('ShiftLeft', 'Shift'), true))
  assert.ok(isHoldDown('Alt', ev('', '', { altKey: true }), new Set(), true))
  assert.ok(isHoldDown('Space', ev('', ''), new Set(['Space']), true))
  assert.ok(!isHoldDown('Cmd', ev('', '', { metaKey: true }), new Set(), false))
  assert.equal(modifierName('Control', true), 'Ctrl')
  assert.equal(modifierName('Meta', true), 'Cmd')
})

test('conflictOf names the other action', () => {
  const map = defaultKeymap('image', true)
  assert.equal(conflictOf(map, 'tool:pen', 'A'), 'tool:arrow')
  assert.equal(conflictOf(map, 'tool:pen', 'P'), undefined)
})

test('keycapsOf uses macOS symbols and arrows', () => {
  assert.deepEqual(keycapsOf('Cmd+Shift+Left', true), ['⌘', '⇧', '←'])
  assert.deepEqual(keycapsOf('Ctrl+Shift+1', false), ['Ctrl', 'Shift', '1'])
  assert.deepEqual(keycapsOf('Alt', true), ['⌥'])
  assert.deepEqual(keycapsOf('Space', true), ['Space'])
})
