// Wallhaven wallpaper adapter: pure (URL building and response parsing, no Electron).
// Safe-for-work wallpapers by topic term, random order; the uploader comes from a second call per photo.
import type { WallpaperBatch, WallpaperPhoto, WallpaperQuery } from '../../shared/wallpapers.ts'
import { couldntReach, isDesktopShaped } from '../../shared/wallpapers.ts'

const API = 'https://wallhaven.cc/api/v1'
const PREFIX = 'wallhaven-'

export const WALLHAVEN_TERMS: Record<string, string> = {
  landscapes: 'landscape -city', // cities have their own category (Jasper, 2026-11-25)
  mountains: 'mountains',
  lakes: 'lake',
  waterfalls: 'waterfall',
  coast: 'coast -"coast guard"', // a quoted phrase; -coastguard matches no tag (probed 2026-11-25)
  forests: 'forest',
  sunsets: 'sunset',
  clouds: 'clouds',
  space: 'space',
  cities: 'cityscape',
  architecture: 'architecture',
  interiors: 'interior',
  flowers: 'flowers',
  birds: 'birds',
  animals: 'animals',
  // Wallhaven-only categories (2026-11-26; counts at 1920+ wide when added).
  abstract: 'abstract', // 12,207
  dark: 'dark', // 29,043
  minimal: 'minimalism', // 18,879 (Wallhaven's tag)
  gradients: 'gradient', // 3,483
  '3d': '3D', // 23,789
  fantasy: 'fantasy art', // 27,608
  scifi: 'science fiction', // 10,115
  anime: '', // no word: the whole Anime section (categories=010)
  games: 'video games', // 64,139: studios' art, the rights risk Jasper accepted
  cars: 'car', // 31,343
}

interface RawHit {
  id: string
  url: string
  path: string
  thumbs: { large: string; small: string }
  dimension_x: number
  dimension_y: number
}

function toPhoto(hit: RawHit, uhd: boolean): WallpaperPhoto | null {
  if (!hit?.id || !hit.path || !hit.thumbs?.small || !hit.thumbs.large) return null
  if (!isDesktopShaped(hit.dimension_x, hit.dimension_y, uhd)) return null
  return {
    id: `${PREFIX}${hit.id}`,
    description: null,
    width: hit.dimension_x,
    height: hit.dimension_y,
    color: null,
    // Cards: the 432px 16:9 'large' thumbnail (the 300px 'small' one is a
    // 3:2 crop, soft on Retina). Preview: the full file (WallpapersSection).
    urls: { small: hit.thumbs.large, regular: hit.thumbs.large, full: hit.path },
    links: { html: hit.url },
    user: { name: '', link: hit.url },
    source: 'wallhaven',
  }
}

/** Page 1 has no seed; later pages carry the seed page 1 returned, so the random order holds. */
export function wallhavenSearchUrl(q: WallpaperQuery): string {
  const keywords = q.keywords?.trim()
  let term: string | undefined
  if (keywords) {
    term = keywords
  } else {
    term = q.categoryId ? WALLHAVEN_TERMS[q.categoryId] : undefined
    if (term === undefined) throw new Error('Unknown category')
  }
  // General + Anime for everything, Anime alone for the Anime category.
  const animeOnly = !keywords && q.categoryId === 'anime'
  const params = new URLSearchParams({
    q: term,
    categories: animeOnly ? '010' : '110',
    purity: '100',
    atleast: q.uhd ? '3840x2160' : '1920x1080',
    ratios: 'landscape',
    sorting: 'random',
    page: String(q.page),
  })
  if (q.cursor) params.set('seed', q.cursor)
  return `${API}/search?${params}`
}

export function wallhavenBatch(json: unknown, uhd: boolean): WallpaperBatch {
  const data = json as {
    data?: RawHit[]
    meta?: { current_page?: number; last_page?: number; seed?: string | null }
  } | null
  if (!data || !Array.isArray(data.data)) throw new Error(couldntReach('wallhaven'))
  const photos = data.data.map(h => toPhoto(h, uhd)).filter((p): p is WallpaperPhoto => !!p)
  const meta = data.meta
  const done = !meta || (meta.current_page ?? 1) >= (meta.last_page ?? 1)
  return { photos, cursor: meta?.seed || undefined, done }
}

export function wallhavenCreditUrl(photo: WallpaperPhoto): string | null {
  const raw = String(photo.id ?? '').startsWith(PREFIX) ? photo.id.slice(PREFIX.length) : String(photo.id ?? '')
  if (!/^[a-z0-9]+$/i.test(raw)) return null
  return `${API}/w/${raw}`
}

export function wallhavenCredit(json: unknown): Pick<WallpaperPhoto, 'user'> & { origin?: string } {
  const d = (json as { data?: { uploader?: { username?: string }; source?: string } } | null)?.data
  const username = d?.uploader?.username?.trim() ?? ''
  const name = username === 'deleted' ? '' : username
  const user = {
    name,
    link: name ? `https://wallhaven.cc/user/${encodeURIComponent(name)}` : 'https://wallhaven.cc',
  }
  const source = d?.source?.trim()
  return source && /^https?:\/\//i.test(source) ? { user, origin: source } : { user }
}
