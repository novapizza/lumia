import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StripJobs } from '../src/lib/strip-jobs.ts'

const rec = (id: string, needs: { preview?: boolean; strip?: boolean } = { strip: true }, extra: Record<string, unknown> = {}) => ({
  id, type: 'recording' as const, filePath: `/v/${id}.webm`,
  ...(needs.preview ? { needsPreview: true } : {}), ...(needs.strip ? { needsStrip: true } : {}), ...extra,
})
/** Run the queue to its end the way the worker does, with `visible` on screen. */
function drain(q: StripJobs, visible: () => string[]): string[] {
  const order: string[] = []
  for (let pick = q.next(visible()); pick; pick = q.next(visible())) {
    order.push(`${pick.kind}:${pick.job.id}`)
    q.settle(pick.job.id, pick.kind)
  }
  return order
}

test('previews go ahead of every strip', () => {
  const q = new StripJobs()
  q.offer(rec('a'))                                   // strip only
  q.offer(rec('b', { preview: true, strip: true }))   // both
  q.offer(rec('c'))
  q.offer(rec('d', { preview: true, strip: true }))
  assert.deepEqual(drain(q, () => []), ['preview:b', 'preview:d', 'strip:a', 'strip:b', 'strip:c', 'strip:d'])
})

test('what is on screen goes first, in screen order, in each of the two', () => {
  const q = new StripJobs()
  for (const id of ['a', 'b', 'c', 'd', 'e']) q.offer(rec(id, { preview: true, strip: true }))
  assert.deepEqual(drain(q, () => ['d', 'b']), [
    'preview:d', 'preview:b', 'preview:a', 'preview:c', 'preview:e',
    'strip:d', 'strip:b', 'strip:a', 'strip:c', 'strip:e',
  ])
})

test('the pick follows the view at that moment, not a list sorted once', () => {
  const q = new StripJobs()
  for (const id of ['a', 'b', 'c', 'd']) q.offer(rec(id))
  let visible = ['c']
  const first = q.next(visible)!
  assert.equal(first.job.id, 'c')
  q.settle('c', 'strip')
  visible = ['d']                                      // scrolled on
  assert.equal(q.next(visible)!.job.id, 'd')
  q.settle('d', 'strip')
  visible = []                                         // the editor is open: nothing in view
  assert.equal(q.next(visible)!.job.id, 'a')
})

test('the 15 blank recordings of 17 to 20 Nov: every preview before the first strip', () => {
  const q = new StripJobs()
  // 29 recordings that only need a strip, then the 15 that need both
  for (let i = 0; i < 29; i++) q.offer(rec(`new${i}`))
  for (let i = 0; i < 15; i++) q.offer(rec(`old${i}`, { preview: true, strip: true }))
  const order = drain(q, () => ['new3', 'new4'])       // the Dashboard shows newer clips
  assert.equal(order.length, 15 + 44)
  assert.ok(order.slice(0, 15).every(o => o.startsWith('preview:old')))
  assert.deepEqual(order.slice(15, 17), ['strip:new3', 'strip:new4'])
})

test('a job that was interrupted stays; one that is settled is not offered again this session', () => {
  const q = new StripJobs()
  q.offer(rec('a'))
  assert.equal(q.next([])!.job.id, 'a')                // started, then the editor needed the decoder
  assert.equal(q.next([])!.job.id, 'a')                // still there
  q.settle('a', 'strip')
  assert.equal(q.next([]), null)
  q.offer(rec('a'))                                    // its day reloads: the row still says it needs one
  assert.equal(q.next([]), null)
})

test('has: whether a kind of work is waiting', () => {
  const q = new StripJobs()
  q.offer(rec('a'))
  assert.equal(q.has('strip'), true)
  assert.equal(q.has('preview'), false)
  q.offer(rec('b', { preview: true, strip: true }))
  assert.equal(q.has('preview'), true)
  q.settle('b', 'preview')
  assert.equal(q.has('preview'), false)
})

test('reopen: a preview deleted outside Lumia is made again when its row comes back', () => {
  const q = new StripJobs()
  q.offer(rec('a', { preview: true }))
  q.settle('a', 'preview')
  q.offer(rec('a', { preview: true }))                 // settled: ignored
  assert.equal(q.next([]), null)
  q.reopen('a', 'preview')
  q.offer(rec('a', { preview: true }))
  assert.equal(q.next([])!.kind, 'preview')
})

test('a reloaded row carries the latest needs', () => {
  const q = new StripJobs()
  q.offer(rec('a', { preview: true, strip: true }))
  q.offer(rec('a', { strip: true }))                   // its preview arrived another way
  assert.deepEqual(drain(q, () => []), ['strip:a'])
})

test('images, missing files and rows without a path are left out', () => {
  const q = new StripJobs()
  q.offer({ id: 'img', type: 'screenshot', filePath: '/v/i.png', needsPreview: true })
  q.offer(rec('gone', { preview: true, strip: true }, { fileMissing: true }))
  q.offer({ id: 'nopath', type: 'recording', needsStrip: true })
  assert.equal(q.next([]), null)
  assert.equal(q.size, 0)
})

test('a trimmed recording\'s preview comes from the trimmed clip', () => {
  const q = new StripJobs()
  q.offer(rec('t', { preview: true }, { annotatedFilePath: '/v/t-trimmed.webm' }))
  const { job } = q.next([])!
  assert.equal(job.previewPath, '/v/t-trimmed.webm')
  assert.equal(job.trimmed, true)
  assert.equal(job.filePath, '/v/t.webm')
})

test('a job carries the row\'s known length, for a file whose header has none', () => {
  const q = new StripJobs()
  q.offer(rec('a', { strip: true }, { durationMs: 12_345 }))
  assert.equal(q.next([])!.job.durationMs, 12_345)
  q.offer(rec('b'))
  q.settle('a', 'strip')
  assert.equal(q.next([])!.job.durationMs, undefined)
})
