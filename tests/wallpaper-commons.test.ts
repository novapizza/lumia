import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMONS_SEARCH, commonsSearchUrl, commonsBatch } from '../electron/wallpaper-sources/commons.ts'
import { categoriesFor } from '../shared/wallpapers.ts'

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/500px-X.jpg'
const page = (pageid: number, width: number, height: number) => ({
  pageid,
  title: 'File:X.jpg',
  imageinfo: [{
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    thumburl: THUMB,
    width,
    height,
    extmetadata: {
      Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Simonizer">Simonizer</a>' },
      LicenseShortName: { value: 'CC BY-SA 2.0 de' },
    },
  }],
})
const fixture = (...pages: unknown[]) => ({ query: { pages } })

test('every wallpaper category has a Commons search fragment', () => {
  for (const c of categoriesFor('commons')) assert.ok(COMMONS_SEARCH[c.id], c.id)
})

test('commonsSearchUrl for a category', () => {
  const p = new URL(commonsSearchUrl({ categoryId: 'landscapes', uhd: false, page: 1 })).searchParams
  assert.equal(p.get('gsrsearch'), 'incategory:Featured_pictures_of_landscapes filew:>1919 filemime:image/jpeg')
  assert.equal(p.get('gsrsort'), 'random')
  assert.equal(p.get('gsrlimit'), '50')
  assert.equal(p.get('iiurlwidth'), '500')
})

test('commonsSearchUrl with uhd asks for 3840 wide', () => {
  const p = new URL(commonsSearchUrl({ categoryId: 'landscapes', uhd: true, page: 1 })).searchParams
  assert.match(p.get('gsrsearch')!, /filew:>3839/)
})

test('commonsSearchUrl with keywords', () => {
  const p = new URL(commonsSearchUrl({ keywords: 'cyberpunk', uhd: false, page: 1 })).searchParams
  assert.equal(p.get('gsrsearch'), 'cyberpunk incategory:Featured_pictures_on_Wikimedia_Commons filew:>1919 filemime:image/jpeg')
})

test('commonsSearchUrl throws for an unknown category', () => {
  assert.throws(() => commonsSearchUrl({ categoryId: 'nope', uhd: false, page: 1 }), /Unknown category/)
})

test('commonsBatch keeps desktop-shaped photos', () => {
  const b = commonsBatch(fixture(page(123, 4302, 2860), page(5, 2000, 1582)), false)
  assert.equal(b.photos.length, 1)
  assert.equal(b.done, false)
  const p = b.photos[0]
  assert.equal(p.id, 'commons-123')
  assert.equal(p.user.name, 'Simonizer')
  assert.equal(p.user.link, 'https://commons.wikimedia.org/wiki/User:Simonizer')
  assert.equal(p.license, 'CC BY-SA 2.0 de')
  assert.equal(p.source, 'commons')
  assert.ok(p.urls.small.endsWith('/500px-X.jpg'))
  assert.ok(p.urls.regular.endsWith('/1920px-X.jpg'))
  assert.ok(p.urls.full.endsWith('/3840px-X.jpg'))
})

test('commonsBatch with uhd', () => {
  assert.equal(commonsBatch(fixture(page(123, 4302, 2860)), true).photos.length, 1)
  const b = commonsBatch(fixture(page(9, 3000, 2000)), true)
  assert.equal(b.photos.length, 0)
  assert.equal(b.done, true)
})

test('commons API error shows the plain message, not the raw text', () => {
  assert.throws(() => commonsBatch({ error: { info: 'internal detail' } }, false), /^Error: Couldn't reach Wikimedia Commons$/)
})

test('full uses the original when the 3840 thumbnail would be under 2160 high', () => {
  const wide = commonsBatch(fixture(page(1, 5000, 2200)), true).photos[0]
  assert.equal(wide.urls.full, 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg')
  const std = commonsBatch(fixture(page(2, 4000, 2250)), true).photos[0]
  assert.match(std.urls.full, /\/3840px-X\.jpg$/)
})
