import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keepHistory, takeHistory, keepPlace, takePlace, noteOpenedClip, takeOpenedClip, dashboardStartsAtTop, forgetClip,
} from '../src/lib/dashboard-place.ts'

const rows = () => ({ stats: null, rows: new Map([['2026-11-27', []]]) })
const place = (key = 'all|grid') => ({ key, anchor: { id: 'c', day: '2026-11-27', offset: 250, dayFraction: 0.4 }, measured: [] })
/** A Dashboard leaving: what its unmount keeps. */
const leave = (key?: string) => { keepHistory(rows()); keepPlace(place(key)) }
/** The next Dashboard starting: history first, then its sections. */
const arrive = (key = 'all|grid') => ({ history: takeHistory(), place: takePlace(key) })

test('the place and the loaded days are handed to the next Dashboard, once', () => {
  leave()
  const first = arrive()
  assert.ok(first.history)
  assert.equal(first.place?.anchor && 'id' in first.place.anchor && first.place.anchor.id, 'c')
  const second = arrive()
  assert.equal(second.history, null)
  assert.equal(second.place, null)
})

test('a place measured in another filter or view is not used', () => {
  leave('all|grid')
  assert.equal(arrive('all|list').place, null)
})

test('the opened clip is noted once', () => {
  noteOpenedClip('c7')
  assert.equal(takeOpenedClip(), 'c7')
  assert.equal(takeOpenedClip(), null)
})

test('a new capture opens the editor from the Dashboard: Back starts at the top', () => {
  dashboardStartsAtTop()   // main sent the window to the editor
  leave()                  // the Dashboard unmounts for it
  const back = arrive()
  assert.equal(back.history, null)
  assert.equal(back.place, null)
})

test('a new capture while the editor or Settings is already open: the kept place goes too', () => {
  noteOpenedClip('c7')
  leave()                  // opened a clip earlier: place kept
  dashboardStartsAtTop()   // then a capture replaced what the editor shows
  const back = arrive()
  assert.equal(back.history, null)
  assert.equal(back.place, null)
  assert.equal(takeOpenedClip(), null)
})

test('only that one return starts at the top: the next visit keeps its place again', () => {
  dashboardStartsAtTop()
  leave()
  arrive()                 // at the top
  leave()                  // then a clip is opened by hand
  const back = arrive()
  assert.ok(back.history)
  assert.ok(back.place)
})

test('a clip deleted in the editor is not in the days handed back', () => {
  const item = (id: string) => ({ id }) as unknown as import('../src/types.ts').HistoryItem
  keepHistory({ stats: null, rows: new Map([['2026-11-27', [item('a'), item('b')]], ['2026-11-26', [item('c')]]]) })
  forgetClip('b')
  const back = takeHistory()
  assert.deepEqual(back?.rows.get('2026-11-27')?.map(i => i.id), ['a'])
  assert.deepEqual(back?.rows.get('2026-11-26')?.map(i => i.id), ['c'])
  forgetClip('a') // nothing kept any more: no error
  assert.equal(takeHistory(), null)
})
