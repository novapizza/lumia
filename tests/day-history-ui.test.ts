import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DayGenerations, dayLabel, estimateDayHeight, placeholderHeight } from '../src/utils/dayHistory.ts'

const now = new Date(2026, 10, 19, 9)

test('dayLabel names recent days', () => {
  assert.equal(dayLabel('2026-11-19', now), 'Today')
  assert.equal(dayLabel('2026-11-18', now), 'Yesterday')
  assert.equal(dayLabel('2026-11-16', now), 'Monday')
})

test('dayLabel dates older days', () => {
  assert.equal(dayLabel('2026-11-12', now), 'Nov 12')
  assert.equal(dayLabel('2025-12-30', now), 'Dec 30, 2025')
})

test('estimateDayHeight', () => {
  assert.equal(estimateDayHeight(9, 4, 150, 12, 40), 40 + 3 * 150 + 2 * 12)
  assert.equal(estimateDayHeight(4, 4, 150, 12, 40), 40 + 150)
  assert.equal(estimateDayHeight(0, 4, 150, 12, 40), 40)
})

// ── Final review fixes ──

test('I3: a measured height is reused only for the same count and width', () => {
  const m = { height: 900, count: 9, width: 930 }
  assert.equal(placeholderHeight(m, 9, 930, () => 300), 900)
  assert.equal(placeholderHeight(m, 2, 930, () => 300), 300) // filter changed the count
  assert.equal(placeholderHeight(m, 9, 1100, () => 300), 300) // window resized
  assert.equal(placeholderHeight(undefined, 9, 930, () => 300), 300)
})

test('I4: a day load started before a change is stale', () => {
  const g = new DayGenerations()
  const started = g.snapshot(['a', 'b'])
  g.bump(['b'])
  assert.deepEqual(g.stale(started), ['b'])
  assert.deepEqual(g.stale(g.snapshot(['a', 'b'])), [])
})
