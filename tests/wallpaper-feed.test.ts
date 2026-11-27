import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheKey,
  readCache,
  writeCache,
  mergeBatch,
  shouldLoadMore,
  CACHE_TTL_MS,
  CACHE_ENTRIES,
} from '../src/lib/wallpaper-feed.ts'
import type { WallpaperPhoto } from '../shared/wallpapers'

function photo(id: string): WallpaperPhoto {
  return {
    id,
    description: null,
    width: 1920,
    height: 1080,
    color: null,
    urls: { small: 's', regular: 'r', full: 'f' },
    links: { html: 'h' },
    user: { name: 'n', link: 'l' },
    source: 'commons',
  }
}

test('constants', () => {
  assert.equal(CACHE_ENTRIES, 10)
  assert.equal(CACHE_TTL_MS, 86_400_000)
})

test('cacheKey', () => {
  assert.equal(cacheKey('wallhaven', 'mountains', true), 'wallhaven:mountains:uhd')
  assert.equal(cacheKey('commons', 'landscapes', false), 'commons:landscapes:any')
})

test('readCache returns a fresh entry', () => {
  const entry = { photos: [photo('a')], fetchedAt: 1000 }
  assert.deepEqual(readCache({ k: entry }, 'k', 1000 + CACHE_TTL_MS), entry)
})

test('readCache drops a stale entry', () => {
  const entry = { photos: [photo('a')], fetchedAt: 1000 }
  assert.equal(readCache({ k: entry }, 'k', 1000 + CACHE_TTL_MS + 1), null)
})

test('readCache treats the old single-object shape and junk as no cache', () => {
  assert.equal(readCache({ photos: [photo('a')], pickId: 'x', fetchedAt: 1 }, 'photos', 2), null)
  assert.equal(readCache({ photos: [photo('a')], pickId: 'x', fetchedAt: 1 }, 'k', 2), null)
  assert.equal(readCache(null, 'k', 2), null)
  assert.equal(readCache('x', 'k', 2), null)
  assert.equal(readCache({ k: { photos: 'no', fetchedAt: 1 } }, 'k', 2), null)
})

test('writeCache keeps the 10 newest', () => {
  let grid: Record<string, unknown> = {}
  for (let i = 0; i < 11; i++) {
    grid = writeCache(grid, `k${i}`, { photos: [], fetchedAt: i + 1 })
  }
  assert.equal(Object.keys(grid).length, 10)
  assert.equal('k0' in grid, false)
  assert.equal('k10' in grid, true)
})

test('writeCache replaces an existing key', () => {
  const g1 = writeCache({}, 'k', { photos: [photo('a')], fetchedAt: 1 })
  const g2 = writeCache(g1, 'k', { photos: [photo('b')], fetchedAt: 2 })
  assert.equal(Object.keys(g2).length, 1)
  assert.equal(g2.k.photos[0].id, 'b')
})

test('writeCache starts fresh from the old shape', () => {
  const g = writeCache({ photos: [photo('a')], pickId: 'x', fetchedAt: 1 }, 'k', { photos: [], fetchedAt: 5 })
  assert.deepEqual(Object.keys(g), ['k'])
})

test('mergeBatch drops shown ids', () => {
  const r = mergeBatch([photo('a'), photo('b')], [photo('b'), photo('c')])
  assert.deepEqual(r.photos.map((p) => p.id), ['a', 'b', 'c'])
  assert.equal(r.added, 1)
})

test('shouldLoadMore', () => {
  const base = { loading: false, done: false, error: false }
  assert.equal(shouldLoadMore(base), true)
  assert.equal(shouldLoadMore({ ...base, loading: true }), false)
  assert.equal(shouldLoadMore({ ...base, done: true }), false)
  assert.equal(shouldLoadMore({ ...base, error: true }), false)
})
