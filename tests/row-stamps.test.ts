import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withStamps } from '../electron/row-stamps.ts'

const written = new Map([['a.jpg', 1000], ['a-strip.webp', 2000]])
const at = (f: string) => written.get(f)

test('a file written this session gets its write time on the row', () => {
  assert.deepEqual(withStamps({ thumbnailFile: 'a.jpg' }, at), { thumbnailFile: 'a.jpg', thumbnailStamp: 1000 })
  assert.deepEqual(withStamps({ stripFile: 'a-strip.webp' }, at), { stripFile: 'a-strip.webp', stripStamp: 2000 })
  assert.deepEqual(
    withStamps({ id: 'a', thumbnailFile: 'a.jpg', stripFile: 'a-strip.webp' }, at),
    { id: 'a', thumbnailFile: 'a.jpg', thumbnailStamp: 1000, stripFile: 'a-strip.webp', stripStamp: 2000 },
  )
})

test('a row saved again with the same, unwritten file keeps what it has', () => {
  // an annotation save that didn't redraw the thumbnail; a row moved from another folder
  const patch = { thumbnailFile: 'old.jpg', uploads: [] }
  assert.equal(withStamps(patch, at), patch)
  assert.deepEqual(withStamps({ thumbnailFile: 'old.jpg', thumbnailStamp: 77 }, at), { thumbnailFile: 'old.jpg', thumbnailStamp: 77 })
})

test('a patch that doesn\'t name the files is left alone', () => {
  const patch = { uploads: [], durationMs: 5 }
  assert.equal(withStamps(patch, at), patch)
})

test('a file taken off the row takes its stamp along', () => {
  assert.deepEqual(withStamps({ stripFile: undefined }, at), { stripFile: undefined, stripStamp: undefined })
  assert.deepEqual(withStamps({ thumbnailFile: undefined, trim: undefined }, at), { thumbnailFile: undefined, trim: undefined, thumbnailStamp: undefined })
})

test('a rewrite of the same name moves the stamp on', () => {
  written.set('a.jpg', 5000)
  assert.deepEqual(withStamps({ thumbnailFile: 'a.jpg' }, at), { thumbnailFile: 'a.jpg', thumbnailStamp: 5000 })
})
