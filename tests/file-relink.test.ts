import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, renameSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileKeyOf, FolderIndex, relinkRow } from '../electron/file-relink.ts'
import type { HistoryItem } from '../electron/types.ts'

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'lumia-relink-'))
}
function row(over: Partial<HistoryItem>): HistoryItem {
  return { id: 'r1', timestamp: Date.now(), name: 'capture-a.png', type: 'screenshot', uploads: [], ...over }
}

test('a file that is there gets its fingerprint saved', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  const r = await relinkRow(row({ filePath: p }), new FolderIndex())
  assert.equal(r.missing, false)
  assert.equal(r.patch.fileKey, await fileKeyOf(p))
  assert.equal(r.patch.filePath, undefined)
  rmSync(dir, { recursive: true })
})

test('nothing to save when the fingerprint is current', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  const r = await relinkRow(row({ filePath: p, fileKey: (await fileKeyOf(p))! }), new FolderIndex())
  assert.deepEqual(r.patch, {})
  rmSync(dir, { recursive: true })
})

test('a renamed original is followed, name included', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  const key = (await fileKeyOf(p))!
  const q = join(dir, 'My shot.png')
  renameSync(p, q)
  const r = await relinkRow(row({ filePath: p, fileKey: key }), new FolderIndex())
  assert.equal(r.missing, false)
  assert.equal(r.patch.filePath, q)
  assert.equal(r.patch.name, 'My shot.png')
  rmSync(dir, { recursive: true })
})

test('a file moved into the save folder is found there', async () => {
  const a = folder()
  const b = folder()
  const p = join(a, 'capture-a.png')
  writeFileSync(p, 'one')
  const key = (await fileKeyOf(p))!
  const q = join(b, 'capture-a.png')
  renameSync(p, q)
  const r = await relinkRow(row({ filePath: p, fileKey: key }), new FolderIndex(), [b])
  assert.equal(r.patch.filePath, q)
  rmSync(a, { recursive: true })
  rmSync(b, { recursive: true })
})

test('gone without a fingerprint, or nowhere to be found: missing', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  assert.equal((await relinkRow(row({ filePath: p }), new FolderIndex())).missing, true)
  assert.equal((await relinkRow(row({ filePath: p, fileKey: '1:2:3' }), new FolderIndex())).missing, true)
  rmSync(dir, { recursive: true })
})

test('a different file of another size is not taken for it', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  const [dev, ino] = (await fileKeyOf(p))!.split(':')
  const r = await relinkRow(row({ filePath: join(dir, 'gone.png'), fileKey: `${dev}:${ino}:999` }), new FolderIndex())
  assert.equal(r.missing, true)
  rmSync(dir, { recursive: true })
})

test('a renamed trimmed copy is followed; the row is not missing', async () => {
  const dir = folder()
  const orig = join(dir, 'recording-a.webm')
  const copy = join(dir, 'recording-a-trimmed-x.webm')
  writeFileSync(orig, 'orig')
  writeFileSync(copy, 'trimmed')
  const copyKey = (await fileKeyOf(copy))!
  const moved = join(dir, 'Demo.webm')
  renameSync(copy, moved)
  const r = await relinkRow(row({ type: 'recording', filePath: orig, annotatedFilePath: copy, annotatedFileKey: copyKey }), new FolderIndex())
  assert.equal(r.missing, false)
  assert.equal(r.patch.annotatedFilePath, moved)
  rmSync(dir, { recursive: true })
})

test('a file made long after the capture is not taken for the original', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  const key = (await fileKeyOf(p))!
  const q = join(dir, 'other.png')
  renameSync(p, q)
  // Needs a real creation time; a file system without one skips the guard.
  if (!(statSync(q).birthtimeMs > 0)) { rmSync(dir, { recursive: true }); return }
  // The row says it was captured a day before this file was made.
  const r = await relinkRow(row({ filePath: p, fileKey: key, timestamp: Date.now() - 24 * 3600 * 1000 }), new FolderIndex())
  assert.equal(r.missing, true)
  rmSync(dir, { recursive: true })
})

test('a folder is read once per pass', async () => {
  const dir = folder()
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'x.png'), 'x')
  const index = new FolderIndex()
  const key = (await fileKeyOf(join(dir, 'x.png')))!
  assert.equal((await index.find(dir, key))?.path, join(dir, 'x.png'))
  writeFileSync(join(dir, 'y.png'), 'yy')
  // y came after the read: not in this pass's index.
  assert.equal(await index.find(dir, (await fileKeyOf(join(dir, 'y.png')))!), null)
  rmSync(dir, { recursive: true })
})

test('a file that is there is never missing, fingerprint or not', async () => {
  const dir = folder()
  const p = join(dir, 'capture-a.png')
  writeFileSync(p, 'one')
  // An old fingerprint that no longer matches (e.g. a drive without file ids
  // gives none): the file is there, so it is not missing and not followed.
  const r = await relinkRow(row({ filePath: p, fileKey: '9:9:9' }), new FolderIndex())
  assert.equal(r.missing, false)
  assert.equal(r.patch.filePath, undefined)
  rmSync(dir, { recursive: true })
})
