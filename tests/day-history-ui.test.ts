import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DayGenerations, dayLabel, estimateDayHeight, placeholderHeight, pickAnchorClip, placeDelta } from '../src/utils/dayHistory.ts'

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

// ── The Dashboard's place, kept across the editor and Settings ──

const area = { top: 100, bottom: 700, left: 0, right: 1000 }
const clip = (id: string, top: number, left = 0) => ({ id, top, bottom: top + 160, left, right: left + 220 })

test('pickAnchorClip: the clip nearest the middle, by height then by column', () => {
  // middle line at 400; rows at 150, 330 and 510: the 330 row's centre (410) is nearest
  const clips = [clip('a', 150), clip('b', 330, 0), clip('c', 330, 390), clip('d', 330, 780), clip('e', 510)]
  assert.equal(pickAnchorClip(clips, area)?.id, 'c') // same row: the one nearest the centre column
  // centres at 180 and 590: 590 is nearer the middle line (400)
  assert.equal(pickAnchorClip([clip('a', 100), clip('e', 510)], area)?.id, 'e')
})

test('pickAnchorClip: the opened clip wins while any of it shows', () => {
  const clips = [clip('a', 150), clip('c', 330, 390), clip('edge', 650)]
  assert.equal(pickAnchorClip(clips, area, 'a')?.id, 'a')
  assert.equal(pickAnchorClip(clips, area, 'edge')?.id, 'edge') // only its top 50px in view
  // scrolled out of the area, or not there: the middle one
  assert.equal(pickAnchorClip([...clips, clip('gone', 900)], area, 'gone')?.id, 'c')
  assert.equal(pickAnchorClip(clips, area, 'nope')?.id, 'c')
})

test('pickAnchorClip: nothing in view gives nothing', () => {
  assert.equal(pickAnchorClip([clip('above', -300), clip('below', 800)], area), null)
  assert.equal(pickAnchorClip([], area), null)
})

test('placeDelta: scroll so the clip\'s centre is back at its height', () => {
  // it sat with its centre 250px under the area's top; now it is at 480 to 640 (centre 560), area top 100
  const anchor = { id: 'c', day: '2026-11-19', offset: 250, dayFraction: 0.4 }
  assert.equal(placeDelta(anchor, 100, { top: 480, bottom: 640 }, { top: 300, height: 1000 }), 210)
  // already there
  assert.equal(placeDelta(anchor, 100, { top: 270, bottom: 430 }, undefined), 0)
})

test('placeDelta: the clip is gone (deleted in the editor), its day stands in', () => {
  const anchor = { id: 'c', day: '2026-11-19', offset: 250, dayFraction: 0.4 }
  // the day's 40% point: 300 + 1000 * 0.4 = 700; it belongs 250 under the top (350)
  assert.equal(placeDelta(anchor, 100, undefined, { top: 300, height: 1000 }), 350)
  // the day is gone too: stay
  assert.equal(placeDelta(anchor, 100, undefined, undefined), null)
})
