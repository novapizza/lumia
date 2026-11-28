import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInside, pathKey } from '../electron/path-rules.ts'

test('isInside: inside, the folder itself, a sibling with the same start, outside', () => {
  assert.equal(isInside('/Users/ann', '/Users/ann/Pictures/a.png'), true)
  assert.equal(isInside('/Users/ann', '/Users/ann'), false)
  assert.equal(isInside('/Users/ann', '/Users/ann', true), true)
  assert.equal(isInside('/Users/ann', '/Users/ann/'), false)
  assert.equal(isInside('/Users/ann', '/Users/ann2/a.png'), false)
  assert.equal(isInside('/Users/ann', '/Users/a.png'), false)
  assert.equal(isInside('/Users/ann', '/Users/ann/../bob/a.png'), false)
  assert.equal(isInside('/Users/ann/Pictures/', '/Users/ann/Pictures/Lumia/x.webm'), true)
})

test('pathKey resolves, so the same folder written two ways compares equal', () => {
  assert.equal(pathKey('/Users/ann/Pictures/../Pictures/Lumia/'), pathKey('/Users/ann/Pictures/Lumia'))
  assert.notEqual(pathKey('/Users/ann/Pictures/Lumia'), pathKey('/Users/ann/Pictures/Lumia2'))
})
