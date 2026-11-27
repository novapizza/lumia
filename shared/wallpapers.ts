// Wallpaper sources: types and rules shared by main and renderer (no Electron or DOM imports).

/** What Lumia calls itself to the photo sources (Wikimedia asks for an
 *  identifying User-Agent; it names the app only), and how long a request
 *  may take. Used by the searches (electron/wallpaper-sources) and the
 *  photo download (electron/wallpapers.ts). */
export const WALLPAPER_USER_AGENT = 'Lumia/1.0 (desktop screenshot app)'
export const WALLPAPER_TIMEOUT_MS = 30_000

export type WallpaperSourceId = 'commons' | 'wallhaven'

export interface WallpaperPhoto {
  id: string
  description: string | null
  width: number
  height: number
  color: string | null
  urls: { small: string; regular: string; full: string }
  links: { html: string }
  user: { name: string; link: string }
  source: WallpaperSourceId
  license?: string
  /** The original source link, where Wallhaven knows it. */
  origin?: string
}

export interface WallpaperQuery {
  categoryId?: string
  keywords?: string
  uhd: boolean
  page: number
  cursor?: string
}

export interface WallpaperBatch {
  photos: WallpaperPhoto[]
  cursor?: string
  done: boolean
}

export interface WallpaperCategory {
  id: string
  label: string
  /** Only these sources offer it; all when left out. */
  sources?: WallpaperSourceId[]
}

export const WALLPAPER_CATEGORIES: WallpaperCategory[] = [
  { id: 'landscapes', label: 'Landscapes' },
  { id: 'mountains', label: 'Mountains' },
  { id: 'lakes', label: 'Lakes' },
  { id: 'waterfalls', label: 'Waterfalls' },
  { id: 'coast', label: 'Coast' },
  { id: 'forests', label: 'Forests' },
  { id: 'sunsets', label: 'Sunsets' },
  { id: 'clouds', label: 'Clouds' },
  { id: 'space', label: 'Space' },
  { id: 'cities', label: 'Cities' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'interiors', label: 'Interiors' },
  { id: 'flowers', label: 'Flowers' },
  { id: 'birds', label: 'Birds' },
  { id: 'animals', label: 'Animals' },
  // Wallhaven only: digital-art styles Wikimedia has no set for (Jasper,
  // 2026-11-26, from common wallpaper-site categories). Anime: Wallhaven's
  // own Anime section (2026-11-25).
  { id: 'abstract', label: 'Abstract', sources: ['wallhaven'] },
  { id: 'dark', label: 'Dark', sources: ['wallhaven'] },
  { id: 'minimal', label: 'Minimal', sources: ['wallhaven'] },
  { id: 'gradients', label: 'Gradients', sources: ['wallhaven'] },
  { id: '3d', label: '3D', sources: ['wallhaven'] },
  { id: 'fantasy', label: 'Fantasy', sources: ['wallhaven'] },
  { id: 'scifi', label: 'Sci-Fi', sources: ['wallhaven'] },
  { id: 'anime', label: 'Anime', sources: ['wallhaven'] },
  { id: 'games', label: 'Games', sources: ['wallhaven'] },
  { id: 'cars', label: 'Cars', sources: ['wallhaven'] },
]

export const DEFAULT_WALLPAPER_CATEGORY = 'landscapes'

/** The categories a source offers. */
export function categoriesFor(source: WallpaperSourceId): WallpaperCategory[] {
  return WALLPAPER_CATEGORIES.filter(c => !c.sources || c.sources.includes(source))
}

/** Ratio 1.3 to 2.4; at least 1920 wide, or at least 3840x2160 when `uhd`. */
export function isDesktopShaped(width: number, height: number, uhd: boolean): boolean {
  if (!(width > 0) || !(height > 0)) return false
  const ratio = width / height
  if (ratio < 1.3 || ratio > 2.4) return false
  return uhd ? width >= 3840 && height >= 2160 : width >= 1920
}

export function sourceName(source: WallpaperSourceId): string {
  return source === 'commons' ? 'Wikimedia Commons' : 'Wallhaven'
}

export function tooManyRequests(source: WallpaperSourceId): string {
  return `Too many requests to ${sourceName(source)}. Try again in a minute.`
}

export function couldntReach(source: WallpaperSourceId, status?: number): string {
  return status === undefined
    ? `Couldn't reach ${sourceName(source)}`
    : `Couldn't reach ${sourceName(source)} (HTTP ${status})`
}
