import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureBarTop, BAR_TOP_DEFAULT } from '../shared/capture-bar.ts'

const display = (top: number, workTop: number) => ({ bounds: { y: top }, workArea: { y: workTop } })

test('macOS: the bar starts at the menu bar\'s bottom edge', () => {
  assert.equal(captureBarTop(display(0, 30), 'darwin'), 30)   // Jasper's displays
  assert.equal(captureBarTop(display(0, 38), 'darwin'), 38)   // a display with a notch
  assert.equal(captureBarTop(display(0, 24), 'darwin'), 24)   // older macOS
})

test('macOS: counted from the display\'s own top, wherever it sits', () => {
  assert.equal(captureBarTop(display(-1080, -1050), 'darwin'), 30)  // a display above the main one
  assert.equal(captureBarTop(display(1440, 1470), 'darwin'), 30)    // one below
})

test('macOS: no menu bar on the display (it hides itself) keeps 32', () => {
  assert.equal(captureBarTop(display(0, 0), 'darwin'), BAR_TOP_DEFAULT)
  assert.equal(captureBarTop(display(-1080, -1080), 'darwin'), 32)
})

test('Windows keeps 32, also with the taskbar on top', () => {
  assert.equal(captureBarTop(display(0, 0), 'win32'), 32)
  assert.equal(captureBarTop(display(0, 48), 'win32'), 32)
})
