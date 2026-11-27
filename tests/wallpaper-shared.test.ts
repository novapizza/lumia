import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WALLPAPER_CATEGORIES,
  categoriesFor,
  DEFAULT_WALLPAPER_CATEGORY,
  isDesktopShaped,
  sourceName,
  tooManyRequests,
  couldntReach,
} from '../shared/wallpapers.ts'

test('isDesktopShaped keeps landscape desktop shapes only', () => {
  assert.equal(isDesktopShaped(2562, 1440, false), true)
  assert.equal(isDesktopShaped(2000, 1582, false), false)
  assert.equal(isDesktopShaped(7639, 2118, false), false)
  assert.equal(isDesktopShaped(1919, 1080, false), false)
  assert.equal(isDesktopShaped(3840, 2160, true), true)
  assert.equal(isDesktopShaped(3000, 1688, true), false)
  assert.equal(isDesktopShaped(3840, 2100, true), false)
})

test('WALLPAPER_CATEGORIES', () => {
  assert.equal(WALLPAPER_CATEGORIES.length, 25)
  const ids = WALLPAPER_CATEGORIES.map((c) => c.id)
  assert.equal(new Set(ids).size, 25)
  // Anime is Wallhaven's only (Jasper, 2026-11-25).
  assert.equal(categoriesFor('commons').length, 15)
  assert.ok(!categoriesFor('commons').some((c) => c.id === 'anime'))
  assert.equal(categoriesFor('wallhaven').length, 25)
  assert.equal(ids[0], 'landscapes')
  assert.ok(ids.includes(DEFAULT_WALLPAPER_CATEGORY))
})

test('messages', () => {
  assert.equal(sourceName('commons'), 'Wikimedia Commons')
  assert.equal(tooManyRequests('wallhaven'), 'Too many requests to Wallhaven. Try again in a minute.')
  assert.equal(couldntReach('commons', 503), "Couldn't reach Wikimedia Commons (HTTP 503)")
})

test('couldntReach without a status', () => {
  assert.equal(couldntReach('wallhaven'), "Couldn't reach Wallhaven")
  assert.equal(couldntReach('commons'), "Couldn't reach Wikimedia Commons")
})
