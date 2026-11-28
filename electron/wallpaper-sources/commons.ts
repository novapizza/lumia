// Wikimedia Commons wallpaper adapter: pure (URL building and response parsing, no Electron).
// Photos come from Commons' Featured pictures, found by topic category, random order.
import type { WallpaperBatch, WallpaperPhoto, WallpaperQuery } from '../../shared/wallpapers.ts'
import { couldntReach, isDesktopShaped } from '../../shared/wallpapers.ts'

const API = 'https://commons.wikimedia.org/w/api.php'
const FEATURED = 'incategory:Featured_pictures_on_Wikimedia_Commons'

// Commons only renders thumbnails at standard widths (1600 and 2560 gave HTTP 400).
const SMALL_W = 500
const REGULAR_W = 1920 // the preview: sharp at dialog size on Retina (1280 was soft)
const FULL_W = 3840

function featured(...names: string[]): string {
  return 'incategory:' + names.map(n => `Featured_pictures_of_${n.replace(/ /g, '_')}`).join('|')
}
/** With every subcategory (animal and astronomy pictures sit in subcategories). */
function featuredTree(name: string): string {
  return `deepcat:"Featured pictures of ${name}"`
}

export const COMMONS_SEARCH: Record<string, string> = {
  landscapes: featured('landscapes'),
  mountains: featured('mountains'),
  lakes: featured('lakes', 'bodies of water'),
  waterfalls: featured('waterfalls', 'watercourses'),
  coast: featured('beaches', 'coasts', 'islands', 'lighthouses'),
  forests: featured('forests', 'trees'),
  sunsets: featured('sunsets', 'sunrises', 'twilights'),
  clouds: featured('clouds', 'fog'),
  space: featuredTree('astronomy'),
  cities: featured('cityscapes', 'skylines'),
  architecture: featured('buildings', 'architecture', 'bridges', 'castles'),
  interiors: featured('ceilings', 'building interiors'),
  flowers: featured('flowers'),
  birds: featured('birds in flight'),
  animals: featuredTree('mammals'),
}

interface RawPage {
  pageid: number
  title: string
  imageinfo?: {
    url: string
    descriptionurl: string
    thumburl?: string
    width: number
    height: number
    extmetadata?: Record<string, { value?: string }>
  }[]
}

/** Metadata values are HTML ("<a href=...>Name</a>"): text only. */
function plainText(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The artist's link from the metadata HTML, if it's a web page. */
function artistLink(html: string | undefined): string | null {
  const href = html?.match(/href="([^"]+)"/)?.[1]
  if (!href) return null
  const url = href.startsWith('//') ? `https:${href}` : href
  return /^https?:\/\//.test(url) ? url.replace(/&amp;/g, '&') : null
}

/** A thumbnail at a standard width, or the original when it isn't wider. */
function thumbAt(thumb500: string, original: string, width: number, w: number): string {
  if (width <= w) return original
  return thumb500.replace(/\?.*$/, '').replace(`/${SMALL_W}px-`, `/${w}px-`)
}

function toPhoto(page: RawPage, uhd: boolean): WallpaperPhoto | null {
  const info = page.imageinfo?.[0]
  if (!info?.thumburl) return null
  if (!isDesktopShaped(info.width, info.height, uhd)) return null
  const meta = info.extmetadata ?? {}
  const artist = plainText(meta.Artist?.value) || 'Unknown author'
  const name = plainText(meta.ObjectName?.value) || page.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '')
  return {
    id: `commons-${page.pageid}`,
    description: name || null,
    width: info.width,
    height: info.height,
    color: null,
    urls: {
      small: thumbAt(info.thumburl, info.url, info.width, SMALL_W),
      regular: thumbAt(info.thumburl, info.url, info.width, REGULAR_W),
      // A wide original would get a thumbnail under 4K high at 3840 wide: use the original then.
      full: info.height * FULL_W / info.width < 2160 ? info.url : thumbAt(info.thumburl, info.url, info.width, FULL_W),
    },
    links: { html: info.descriptionurl },
    user: { name: artist, link: artistLink(meta.Artist?.value) ?? info.descriptionurl },
    source: 'commons',
    license: plainText(meta.LicenseShortName?.value) || undefined,
  }
}

/** Random order, so `page` and `cursor` don't change the URL. */
export function commonsSearchUrl(q: WallpaperQuery): string {
  const keywords = q.keywords?.trim()
  let where: string
  if (keywords) {
    where = `${keywords} ${FEATURED}`
  } else {
    const fragment = q.categoryId ? COMMONS_SEARCH[q.categoryId] : undefined
    if (!fragment) throw new Error('Unknown category')
    where = fragment
  }
  const search = [where, q.uhd ? 'filew:>3839' : 'filew:>1919', 'filemime:image/jpeg'].join(' ')
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: search,
    gsrsort: 'random',
    gsrlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: String(SMALL_W),
    iiextmetadatafilter: 'Artist|LicenseShortName|ObjectName',
  })
  return `${API}?${params}`
}

export function commonsBatch(json: unknown, uhd: boolean): WallpaperBatch {
  const data = json as { query?: { pages?: RawPage[] }; error?: { info?: string } } | null
  if (data?.error) {
    console.warn('[wallpapers] Commons error', data.error.info)
    throw new Error(couldntReach('commons'))
  }
  const photos = (data?.query?.pages ?? [])
    .map(p => toPhoto(p, uhd))
    .filter((p): p is WallpaperPhoto => !!p)
  return { photos, done: photos.length === 0 }
}
