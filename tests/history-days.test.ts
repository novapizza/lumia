import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DayHistory, dayKey, writeJsonAtomic } from '../electron/history-days.ts'
import type { HistoryItem } from '../electron/types.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'lumia-history-'))
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
let n = 0
const row = (timestamp: number, type: HistoryItem['type'] = 'screenshot', extra: Partial<HistoryItem> = {}): HistoryItem => ({
  id: `id-${++n}`, timestamp, name: `capture-${n}`, type, uploads: [], ...extra,
})
const dayFile = (root: string, day: string) => join(root, 'history', `${day}.json`)

test('dayKey uses local date', () => {
  assert.equal(dayKey(at(2026, 11, 18, 23, 59)), '2026-11-18')
  assert.equal(dayKey(at(2026, 11, 19, 0, 1)), '2026-11-19')
})

test('add writes the day file and stats', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 18, 10)))
  const file = JSON.parse(readFileSync(dayFile(root, '2026-11-18'), 'utf8'))
  assert.equal(file.items.length, 1)
  assert.deepEqual(h.getStats(), {
    version: 1, cleanupVersion: 0, total: 1, screenshot: 1, recording: 0,
    days: [{ day: '2026-11-18', total: 1, screenshot: 1, recording: 0 }],
  })
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'history_stat.json'), 'utf8')), h.getStats())
})

test('midnight split', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 18, 23, 59)))
  h.add(row(at(2026, 11, 19, 0, 1)))
  assert.ok(existsSync(dayFile(root, '2026-11-18')))
  assert.ok(existsSync(dayFile(root, '2026-11-19')))
  assert.deepEqual(h.getStats().days.map(d => d.day), ['2026-11-19', '2026-11-18'])
})

test('day file is newest first', () => {
  const h = new DayHistory(tmp())
  h.add(row(at(2026, 11, 18, 10)))
  h.add(row(at(2026, 11, 18, 9)))
  h.add(row(at(2026, 11, 18, 11)))
  const ts = h.getDays(['2026-11-18'])['2026-11-18'].map(i => i.timestamp)
  assert.deepEqual(ts, [at(2026, 11, 18, 11), at(2026, 11, 18, 10), at(2026, 11, 18, 9)])
})

test('get finds a row in a day not yet read', () => {
  const root = tmp()
  const first = new DayHistory(root)
  const r = row(at(2026, 11, 10, 8))
  first.add(r)
  first.add(row(at(2026, 11, 18, 8)))
  const second = new DayHistory(root)
  assert.deepEqual(second.get(r.id), r)
  assert.equal(second.get('nope'), null)
})

test('update patches and keeps the day', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const r = row(at(2026, 11, 18, 8))
  h.add(r)
  const uploads = [{ destination: 'r2', success: true, url: 'https://x' }] as HistoryItem['uploads']
  const res = h.update(r.id, { uploads })
  assert.equal(res?.day, '2026-11-18')
  assert.deepEqual(new DayHistory(root).get(r.id)?.uploads, uploads)
  assert.equal(h.update('nope', { name: 'x' }), null)
})

test('deleting the last row removes the day', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const r = row(at(2026, 11, 18, 8))
  h.add(r)
  const res = h.deleteMany([r.id])
  assert.deepEqual(res, { removed: [r], days: ['2026-11-18'] })
  assert.ok(!existsSync(dayFile(root, '2026-11-18')))
  assert.deepEqual(h.getStats().days, [])
  assert.equal(h.getStats().total, 0)
  assert.deepEqual(new DayHistory(root).getStats().days, [])
})

test('getRecent across days with type filter', () => {
  const h = new DayHistory(tmp())
  h.add(row(at(2026, 11, 17, 8)))
  h.add(row(at(2026, 11, 17, 9)))
  const aNewest = row(at(2026, 11, 17, 10))
  h.add(aNewest)
  h.add(row(at(2026, 11, 18, 8), 'recording'))
  h.add(row(at(2026, 11, 18, 9), 'recording'))
  const bShot = row(at(2026, 11, 18, 7))
  h.add(bShot)
  assert.deepEqual(h.getRecent(2, 'screenshot').map(i => i.id), [bShot.id, aNewest.id])
  assert.equal(h.getRecent(10).length, 6)
})

test('no cap', () => {
  const h = new DayHistory(tmp())
  for (let i = 0; i < 1100; i++) h.add(row(at(2026, 11, 16 + (i % 3), 8) + i))
  assert.equal(h.getStats().total, 1100)
})

// ── Task 2: recovery, corrupt files, prune, reset, legacy import ──

test('missing stats are rebuilt', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 17, 8), 'recording'))
  h.add(row(at(2026, 11, 18, 8)))
  const before = h.getStats()
  unlinkSync(join(root, 'history_stat.json'))
  assert.deepEqual(new DayHistory(root).getStats(), before)
})

test('stale stats are recounted', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 16, 8)))
  h.add(row(at(2026, 11, 17, 8)))
  h.add(row(at(2026, 11, 18, 8)))
  // Crash between the day write and the stats write: 11-18 gained a row the
  // stats never saw; 11-19 is a day file the stats don't list; 11-16's file
  // is gone but still listed.
  const f18 = dayFile(root, '2026-11-18')
  const items18 = JSON.parse(readFileSync(f18, 'utf8')).items
  writeFileSync(f18, JSON.stringify({ items: [row(at(2026, 11, 18, 9), 'recording'), ...items18] }))
  writeFileSync(dayFile(root, '2026-11-19'), JSON.stringify({ items: [row(at(2026, 11, 19, 8))] }))
  unlinkSync(dayFile(root, '2026-11-16'))
  const later = (Date.now() + 10_000) / 1000
  utimesSync(f18, later, later)
  utimesSync(dayFile(root, '2026-11-19'), later, later)
  const s = new DayHistory(root).getStats()
  assert.deepEqual(s.days, [
    { day: '2026-11-19', total: 1, screenshot: 1, recording: 0 },
    { day: '2026-11-18', total: 2, screenshot: 1, recording: 1 },
    { day: '2026-11-17', total: 1, screenshot: 1, recording: 0 },
  ])
  assert.equal(s.total, 4)
  assert.equal(s.recording, 1)
})

test('corrupt day file is set aside', () => {
  const root = tmp()
  new DayHistory(root)
  writeFileSync(dayFile(root, '2026-11-18'), '{not json')
  const h = new DayHistory(root)
  assert.deepEqual(h.getDays(['2026-11-18'])['2026-11-18'], [])
  const aside = readdirSync(join(root, 'history')).filter(f => /^2026-11-18\.corrupt-\d+\.json$/.test(f))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(root, 'history', aside[0]), 'utf8'), '{not json')
  assert.ok(!existsSync(dayFile(root, '2026-11-18')))
})

test('prune drops whole old days and old rows of the boundary day', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const old = row(at(2026, 11, 10, 8))
  const boundaryOld = row(at(2026, 11, 15, 8))
  const boundaryNew = row(at(2026, 11, 15, 20))
  const recent = row(at(2026, 11, 18, 8))
  for (const r of [old, boundaryOld, boundaryNew, recent]) h.add(r)
  const res = h.pruneOlderThan(at(2026, 11, 15, 12))
  assert.deepEqual(res.removed.map(r => r.id).sort(), [old.id, boundaryOld.id].sort())
  assert.deepEqual(res.days.sort(), ['2026-11-10', '2026-11-15'])
  assert.ok(!existsSync(dayFile(root, '2026-11-10')))
  assert.deepEqual(h.getDays(['2026-11-15'])['2026-11-15'].map(r => r.id), [boundaryNew.id])
  assert.equal(h.getStats().total, 2)
})

test('reset empties everything', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 17, 8)))
  h.add(row(at(2026, 11, 18, 8)))
  const removed = h.reset(3)
  assert.equal(removed.length, 2)
  assert.deepEqual(readdirSync(join(root, 'history')).filter(f => f.endsWith('.json')), [])
  assert.equal(h.getStats().total, 0)
  assert.equal(h.cleanupVersion, 3)
  assert.equal(new DayHistory(root).cleanupVersion, 3)
})

test('importLegacy merges and the day file wins', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const a = row(at(2026, 11, 18, 8), 'screenshot', { name: 'new' })
  h.add(a)
  const b = row(at(2026, 11, 12, 8), 'recording')
  const legacy = [{ ...a, name: 'old' }, b]
  const first = h.importLegacy(legacy, 2)
  assert.equal(first.added, 1)
  assert.deepEqual(first.days, ['2026-11-12'])
  assert.equal(h.get(a.id)?.name, 'new')
  assert.deepEqual(h.get(b.id), b)
  assert.equal(h.cleanupVersion, 2)
  assert.equal(h.importLegacy(legacy, 2).added, 0)
  assert.equal(new DayHistory(root).getStats().total, 2)
})

// ── Final review fixes ──

test('C1: rebuilt stats over existing day files never trigger the startup reset', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.importLegacy([row(at(2026, 11, 18, 8))], 1)
  writeFileSync(join(root, 'history_stat.json'), '') // zero-length after a power loss
  const again = new DayHistory(root)
  assert.deepEqual(again.cleanupIfBelow(1), [])
  assert.equal(again.getStats().total, 1)
  assert.equal(again.cleanupVersion, 1)
})

test('cleanupIfBelow resets when the stored version is older', () => {
  const root = tmp()
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 18, 8)))
  assert.equal(h.cleanupIfBelow(1).length, 1)
  assert.equal(h.getStats().total, 0)
  assert.deepEqual(h.cleanupIfBelow(1), [])
})

test('C2: a migration failing partway keeps the legacy cleanup version on disk', () => {
  const root = tmp()
  const h = new DayHistory(root)
  // The second day's tmp path is a directory, so its write throws.
  mkdirSync(join(root, 'history', '2026-11-12.json.tmp'))
  assert.throws(() => h.importLegacy([row(at(2026, 11, 18, 8)), row(at(2026, 11, 12, 8))], 1))
  const again = new DayHistory(root)
  assert.equal(again.cleanupVersion, 1)
  assert.deepEqual(again.cleanupIfBelow(1), [])
  assert.equal(again.getStats().total, 1)
})

test('I1: writeJsonAtomic retries a locked rename', () => {
  const dir = tmp()
  let calls = 0
  const flaky = (from: string, to: string) => {
    if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' })
    renameSync(from, to)
  }
  writeJsonAtomic(join(dir, 'x.json'), { a: 1 }, flaky)
  assert.equal(calls, 3)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8')), { a: 1 })
})

test('I2: a corrupt file that cannot be moved aside does not crash startup', () => {
  const root = tmp()
  new DayHistory(root)
  writeFileSync(dayFile(root, '2026-11-18'), '{not json')
  chmodSync(join(root, 'history'), 0o555)
  try {
    const h = new DayHistory(root)
    assert.deepEqual(h.getDays(['2026-11-18'])['2026-11-18'], [])
  } finally {
    chmodSync(join(root, 'history'), 0o755)
  }
  assert.equal(readFileSync(dayFile(root, '2026-11-18'), 'utf8'), '{not json')
})

test('M2: valid JSON with the wrong shape is set aside, not overwritten', () => {
  const root = tmp()
  new DayHistory(root)
  writeFileSync(dayFile(root, '2026-11-18'), '{"items":"x"}')
  const h = new DayHistory(root)
  h.add(row(at(2026, 11, 18, 9)))
  const aside = readdirSync(join(root, 'history')).filter(f => f.startsWith('2026-11-18.corrupt-'))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(root, 'history', aside[0]), 'utf8'), '{"items":"x"}')
})

test('deleting some rows updates totals and per-type counts on disk', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const keep = row(at(2026, 11, 18, 8))
  const gone1 = row(at(2026, 11, 18, 9), 'recording')
  const gone2 = row(at(2026, 11, 17, 9), 'recording')
  const keep2 = row(at(2026, 11, 17, 10))
  for (const r of [keep, gone1, gone2, keep2]) h.add(r)
  h.deleteMany([gone1.id, gone2.id])
  const onDisk = JSON.parse(readFileSync(join(root, 'history_stat.json'), 'utf8'))
  assert.deepEqual(onDisk, {
    version: 1, cleanupVersion: 0, total: 2, screenshot: 2, recording: 0,
    days: [
      { day: '2026-11-18', total: 1, screenshot: 1, recording: 0 },
      { day: '2026-11-17', total: 1, screenshot: 1, recording: 0 },
    ],
  })
  assert.deepEqual(new DayHistory(root).getStats(), onDisk)
})

test('updateMany gives the same files as one update per row', () => {
  const days = [at(2026, 11, 18, 10), at(2026, 11, 18, 11), at(2026, 11, 17, 9), at(2026, 11, 16, 8)]
  const rows = days.map(t => row(t))
  const patches = rows.map((r, i) => ({ id: r.id, patch: { fileKey: `1:${i}:99`, name: `renamed-${i}` } as Partial<HistoryItem> }))
  const one = tmp(), many = tmp()
  const a = new DayHistory(one), b = new DayHistory(many)
  for (const r of rows) { a.add(r); b.add(r) }
  for (const p of patches) a.update(p.id, p.patch)
  const written = b.updateMany(patches)
  assert.deepEqual([...written].sort(), ['2026-11-16', '2026-11-17', '2026-11-18'])
  for (const day of written) {
    assert.deepEqual(JSON.parse(readFileSync(dayFile(many, day), 'utf8')), JSON.parse(readFileSync(dayFile(one, day), 'utf8')))
  }
  assert.deepEqual(b.getStats(), a.getStats())
  assert.equal(b.get(rows[0].id)?.fileKey, '1:0:99')
  // Read back by a fresh instance: it's on disk, not only in the cache.
  assert.equal(new DayHistory(many).get(rows[3].id)?.name, 'renamed-3')
})

test('updateMany skips unknown ids, keeps the timestamp and writes nothing when nothing matches', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const r = row(at(2026, 11, 18, 10))
  h.add(r)
  const before = readFileSync(dayFile(root, '2026-11-18'), 'utf8')
  const mtime = () => readFileSync(dayFile(root, '2026-11-18'), 'utf8')
  assert.deepEqual(h.updateMany([{ id: 'nope', patch: { name: 'x' } }]), [])
  assert.deepEqual(h.updateMany([]), [])
  assert.equal(mtime(), before)
  assert.deepEqual(h.updateMany([{ id: 'nope', patch: { name: 'x' } }, { id: r.id, patch: { name: 'y', timestamp: 1 } }]), ['2026-11-18'])
  assert.equal(h.get(r.id)?.name, 'y')
  assert.equal(h.get(r.id)?.timestamp, r.timestamp)
})

test('an unknown id is looked up in the files once, then answered from the index', () => {
  const root = tmp()
  const h = new DayHistory(root)
  // More days than the day cache holds (30), so some are out of the cache.
  const rows = Array.from({ length: 35 }, (_, i) => row(at(2026, 10, 1 + (i % 28), 10) - (i >= 28 ? 40 * 86400000 : 0)))
  for (const r of rows) h.add(r)
  const fresh = new DayHistory(root)
  assert.equal(fresh.get('nope'), null)
  // Every day has been read now, and the newest ones have left the cache
  // again (the scan ends on the oldest). Break the newest day's file: a
  // second lookup that read the files again would move it aside as corrupt.
  const newest = fresh.getStats().days[0].day
  writeFileSync(dayFile(root, newest), '{ not json')
  assert.equal(fresh.get('nope'), null)
  assert.equal(readFileSync(dayFile(root, newest), 'utf8'), '{ not json')
  assert.deepEqual(readdirSync(join(root, 'history')).filter(f => f.includes('corrupt')), [])
  // Rows known before still resolve from the index.
  assert.equal(fresh.get(rows[0].id)?.id, rows[0].id)
})

test('updateMany writes nothing when the rows already hold the values', () => {
  const root = tmp()
  const h = new DayHistory(root)
  const r = row(at(2026, 11, 18, 10), 'screenshot', { fileKey: '1:2:3' })
  h.add(r)
  // A write would replace the file (tmp + rename): same inode means none.
  const ino = () => statSync(dayFile(root, '2026-11-18')).ino
  const before = ino()
  assert.deepEqual(h.updateMany([{ id: r.id, patch: { fileKey: '1:2:3' } }]), [])
  assert.equal(ino(), before)
  assert.deepEqual(h.updateMany([{ id: r.id, patch: { fileKey: '1:2:4' } }]), ['2026-11-18'])
  assert.notEqual(ino(), before)
})
