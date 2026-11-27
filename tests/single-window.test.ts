import { test } from 'node:test'
import assert from 'node:assert/strict'
import { singleWindowIndex, visibleWindowCount, visibleWindowIndices } from '../electron/single-window.ts'

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

// Windows are listed front to back, like capture-source.ts gets them.
const safari = r(100, 100, 1000, 800)
const notes = r(900, 50, 400, 300)
const finder = r(0, 0, 600, 500)

test('a region inside one window with nothing in front of it is that window', () => {
  assert.equal(singleWindowIndex([safari, finder], r(200, 300, 400, 300)), 0)
  // Behind another window that doesn't reach the region: still one window.
  assert.equal(singleWindowIndex([notes, safari], r(200, 400, 400, 300)), 1)
})

test('a region over the edge of a window, or with a window in front, spans several', () => {
  // Spills past Safari's right edge.
  assert.equal(singleWindowIndex([safari], r(900, 300, 400, 200)), -1)
  // Notes sits in front of part of it.
  assert.equal(singleWindowIndex([notes, safari], r(800, 200, 200, 200)), -1)
  // No window holds it at all (bare desktop).
  assert.equal(singleWindowIndex([safari], r(1500, 1500, 50, 50)), -1)
})

test('a few pixels of slack at the edges still count as inside', () => {
  // Dragged from 2px outside Safari's corner.
  assert.equal(singleWindowIndex([safari], r(98, 98, 500, 400)), 0)
  // A window in front that only touches the region's edge doesn't count.
  assert.equal(singleWindowIndex([r(0, 0, 202, 1000), safari], r(200, 300, 400, 300)), 1)
})

test('a full screen: one window filling the work area, else several', () => {
  const workArea = r(0, 25, 1440, 850)
  // Maximized (fills the work area) or full-screen app (fills the display).
  assert.equal(singleWindowIndex([r(0, 25, 1440, 850)], workArea), 0)
  assert.equal(singleWindowIndex([r(0, 0, 1440, 900)], workArea), 0)
  // A normal window that leaves desktop showing.
  assert.equal(singleWindowIndex([r(100, 100, 1000, 700)], workArea), -1)
  // Maximized, but a small window floats in front.
  assert.equal(singleWindowIndex([r(1200, 600, 200, 200), r(0, 25, 1440, 850)], workArea), -1)
})

test('no windows: none', () => {
  assert.equal(singleWindowIndex([], r(0, 0, 10, 10)), -1)
})

test('visibleWindowCount counts the windows that actually show in the area', () => {
  // Two windows side by side under the region.
  assert.equal(visibleWindowCount([notes, safari], r(800, 200, 300, 300)), 2)
  // Finder hidden behind Safari inside the region: only Safari shows.
  assert.equal(visibleWindowCount([safari, r(200, 200, 300, 300)], r(150, 150, 500, 500)), 1)
  // Safari plus bare desktop: one window.
  assert.equal(visibleWindowCount([safari], r(900, 300, 400, 200)), 1)
  // Desktop only.
  assert.equal(visibleWindowCount([safari], r(1500, 1500, 50, 50)), 0)
})

test('one small window on an otherwise empty screen is that window', () => {
  const screen = r(0, 0, 1920, 1080)
  const small = r(800, 400, 150, 120) // smaller than a 9x9 sample cell
  assert.deepEqual(visibleWindowIndices([small], screen), [0])
  // Behind it, a window it covers completely: still only the small one.
  assert.deepEqual(visibleWindowIndices([small, r(820, 420, 50, 50)], screen), [0])
  // A second window showing anywhere: two.
  assert.deepEqual(visibleWindowIndices([small, r(100, 100, 100, 100)], screen), [0, 1])
})
