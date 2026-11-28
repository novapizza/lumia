import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadLinksOf, uploadRows, uploadRowLabel } from '../src/lib/upload-choice.ts'

const R2 = 'https://share.lumia.asia/a'
const GD = 'https://drive.google.com/file/d/x/view'

test('uploadLinksOf keeps the first successful link per destination', () => {
  assert.deepEqual(uploadLinksOf([
    { destination: 'r2', success: false, url: 'bad' },
    { destination: 'r2', success: true, url: R2 },
    { destination: 'r2', success: true, url: 'later' },
    { destination: 'google-drive', success: true, url: GD },
    { destination: 'other', success: true, url: 'x' },
  ]), { r2: R2, 'google-drive': GD })
  assert.deepEqual(uploadLinksOf(undefined), {})
})

test('both ready, nothing uploaded: two upload rows, R2 first', () => {
  assert.deepEqual(uploadRows({ r2Ready: true, gdriveReady: true, links: {}, canUpload: true }),
    [{ dest: 'r2' }, { dest: 'google-drive' }])
})

test('one ready: one row (the button acts without a menu)', () => {
  assert.deepEqual(uploadRows({ r2Ready: true, gdriveReady: false, links: {}, canUpload: true }), [{ dest: 'r2' }])
  assert.deepEqual(uploadRows({ r2Ready: false, gdriveReady: true, links: {}, canUpload: true }), [{ dest: 'google-drive' }])
})

test('neither ready and no links: no rows (no button)', () => {
  assert.deepEqual(uploadRows({ r2Ready: false, gdriveReady: false, links: {}, canUpload: true }), [])
})

test('a link is a copy row even when that service is no longer set up', () => {
  assert.deepEqual(uploadRows({ r2Ready: true, gdriveReady: false, links: { 'google-drive': GD }, canUpload: true }),
    [{ dest: 'r2' }, { dest: 'google-drive', link: GD }])
})

test('file gone: only rows with links remain', () => {
  assert.deepEqual(uploadRows({ r2Ready: true, gdriveReady: true, links: { r2: R2 }, canUpload: false }),
    [{ dest: 'r2', link: R2 }])
})

test('row labels', () => {
  assert.equal(uploadRowLabel({ dest: 'r2' }), 'Upload to Lumia')
  assert.equal(uploadRowLabel({ dest: 'google-drive', link: GD }), 'Copy Google Drive link')
})
