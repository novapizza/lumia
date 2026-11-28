import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WALLHAVEN_TERMS,
  wallhavenSearchUrl,
  wallhavenBatch,
  wallhavenCreditUrl,
  wallhavenCredit,
} from '../electron/wallpaper-sources/wallhaven.ts'
import { categoriesFor } from '../shared/wallpapers.ts'

const hit = {
  id: '4l59g2',
  url: 'https://wallhaven.cc/w/4l59g2',
  path: 'https://w.wallhaven.cc/full/4l/wallhaven-4l59g2.jpg',
  thumbs: {
    large: 'https://th.wallhaven.cc/lg/4l/4l59g2.jpg',
    original: 'https://th.wallhaven.cc/orig/4l/4l59g2.jpg',
    small: 'https://th.wallhaven.cc/small/4l/4l59g2.jpg',
  },
  dimension_x: 2562,
  dimension_y: 1440,
}
const tall = { ...hit, id: 'zzzzzz', dimension_x: 2000, dimension_y: 1582 }
const fixture = (page: number) => ({
  data: [hit, tall],
  meta: { current_page: page, last_page: 715, seed: 'onXroB' },
})

test('every category has a Wallhaven term', () => {
  for (const c of categoriesFor('wallhaven')) assert.ok(c.id in WALLHAVEN_TERMS, c.id)
})

test('search url, page 1', () => {
  const u = new URL(wallhavenSearchUrl({ categoryId: 'mountains', uhd: false, page: 1 }))
  assert.equal(u.origin + u.pathname, 'https://wallhaven.cc/api/v1/search')
  const p = u.searchParams
  assert.equal(p.get('q'), 'mountains')
  assert.equal(p.get('categories'), '110')
  assert.equal(p.get('purity'), '100')
  assert.equal(p.get('atleast'), '1920x1080')
  assert.equal(p.get('ratios'), 'landscape')
  assert.equal(p.get('sorting'), 'random')
  assert.equal(p.get('page'), '1')
  assert.equal(p.has('seed'), false)
})

test('search url, 4K page 2 with seed', () => {
  const p = new URL(
    wallhavenSearchUrl({ categoryId: 'mountains', uhd: true, page: 2, cursor: 'onXroB' }),
  ).searchParams
  assert.equal(p.get('atleast'), '3840x2160')
  assert.equal(p.get('page'), '2')
  assert.equal(p.get('seed'), 'onXroB')
})

test('keywords override category; unknown category throws', () => {
  const p = new URL(
    wallhavenSearchUrl({ categoryId: 'mountains', keywords: ' red fox ', uhd: false, page: 1 }),
  ).searchParams
  assert.equal(p.get('q'), 'red fox')
  assert.throws(() => wallhavenSearchUrl({ categoryId: 'nope', uhd: false, page: 1 }), /Unknown category/)
  assert.throws(() => wallhavenSearchUrl({ uhd: false, page: 1 }), /Unknown category/)
})

test('batch maps hits and drops non-desktop shapes', () => {
  const b = wallhavenBatch(fixture(1), false)
  assert.equal(b.photos.length, 1)
  const p = b.photos[0]
  assert.equal(p.id, 'wallhaven-4l59g2')
  assert.equal(p.urls.small, hit.thumbs.large)
  assert.equal(p.urls.regular, hit.thumbs.large)
  assert.equal(p.urls.full, hit.path)
  assert.equal(p.links.html, hit.url)
  assert.equal(p.user.name, '')
  assert.equal(p.source, 'wallhaven')
  assert.equal(p.description, null)
  assert.equal(p.color, null)
  assert.equal(b.cursor, 'onXroB')
  assert.equal(b.done, false)
  assert.equal(wallhavenBatch(fixture(715), false).done, true)
})

test('batch rejects bad shape', () => {
  assert.throws(() => wallhavenBatch({}, false))
  assert.throws(() => wallhavenBatch(null, false))
})

test('credit url strips prefix', () => {
  const photo = wallhavenBatch(fixture(1), false).photos[0]
  assert.equal(wallhavenCreditUrl(photo), 'https://wallhaven.cc/api/v1/w/4l59g2')
})

test('credit', () => {
  const none = wallhavenCredit({ data: { uploader: { username: 'deleted' }, source: '' } })
  assert.equal(none.user.name, '')
  assert.equal('origin' in none && none.origin !== undefined, false)
  const ok = wallhavenCredit({ data: { uploader: { username: 'ansel' }, source: 'https://example.com/a' } })
  assert.equal(ok.user.name, 'ansel')
  assert.equal(ok.user.link, 'https://wallhaven.cc/user/ansel')
  assert.equal(ok.origin, 'https://example.com/a')
  const bad = wallhavenCredit({ data: { uploader: { username: 'ansel' }, source: 'javascript:alert(1)' } })
  assert.equal(bad.origin, undefined)
})

test('credit url rejects an id that is not alphanumeric', () => {
  const photo = wallhavenBatch(fixture(1), false).photos[0]
  assert.equal(wallhavenCreditUrl({ ...photo, id: 'wallhaven-../x?y' }), null)
  assert.equal(wallhavenCreditUrl({ ...photo, id: '' }), null)
})

test('coast leaves out coast guard, landscapes leave out cities (Jasper, 2026-11-25)', () => {
  const q = (categoryId: string) => new URL(wallhavenSearchUrl({ categoryId, uhd: false, page: 1 })).searchParams.get('q')
  assert.equal(q('coast'), 'coast -"coast guard"')
  assert.equal(q('landscapes'), 'landscape -city')
})

test('anime searches the Anime section alone, with no word', () => {
  const p = new URL(wallhavenSearchUrl({ categoryId: 'anime', uhd: false, page: 1 })).searchParams
  assert.equal(p.get('q'), '')
  assert.equal(p.get('categories'), '010')
  const k = new URL(wallhavenSearchUrl({ categoryId: 'anime', keywords: 'city', uhd: false, page: 1 })).searchParams
  assert.equal(k.get('categories'), '110')
})
