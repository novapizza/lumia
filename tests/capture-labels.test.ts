import { test } from 'node:test'
import assert from 'node:assert/strict'
import { durationParts, formatDimensions, formatDuration, recordingLengthMs, fileTipText } from '../src/utils/captureLabels.ts'

test('formatDuration uses units so it never reads like a clock time', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(42_400), '42s')
  assert.equal(formatDuration(65_000), '1m 05s')
  assert.equal(formatDuration(600_000), '10m 00s')
  assert.equal(formatDuration(3_725_000), '1h 02m')
})

test('durationParts splits each number from its unit (the card spaces them 1px)', () => {
  assert.deepEqual(durationParts(20_000), [{ value: '20', unit: 's' }])
  assert.deepEqual(durationParts(65_000), [{ value: '1', unit: 'm' }, { value: '05', unit: 's' }])
  assert.deepEqual(durationParts(3_725_000), [{ value: '1', unit: 'h' }, { value: '02', unit: 'm' }])
})

test('recordingLengthMs prefers the trimmed length', () => {
  assert.equal(recordingLengthMs({ durationMs: 60_000 }), 60_000)
  assert.equal(recordingLengthMs({ durationMs: 60_000, trim: { startMs: 5_000, endMs: 20_000, actualStartMs: 4_000 } }), 16_000)
  assert.equal(recordingLengthMs({}), undefined)
})

test('formatDimensions shows width × height', () => {
  assert.equal(formatDimensions({ width: 1920, height: 1080 }), '1920×1080')
  assert.equal(formatDimensions({}), null)
})

test('fileTipText: the folder and the file name, in the path\'s separator', () => {
  assert.equal(fileTipText({ name: 'a.png', filePath: '/Users/j/Pictures/Test Lumia/capture-1.png' }), '/ Test Lumia / capture-1.png')
  assert.equal(fileTipText({ name: 'a.png', filePath: 'C:\\Users\\j\\Pictures\\Lumia\\c.png' }), '\\ Lumia \\ c.png')
  assert.equal(fileTipText({ name: 'a.png' }), 'a.png')
})
