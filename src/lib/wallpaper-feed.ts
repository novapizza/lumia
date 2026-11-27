// Pure helpers for the Wallpapers grid: photo cache, batch merging, load-more rule.
import type { WallpaperPhoto, WallpaperSourceId } from '../../shared/wallpapers'

export const CACHE_ENTRIES = 10
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type Grid = Record<string, { photos: WallpaperPhoto[]; cursor?: string; fetchedAt: number }>

export function cacheKey(source: WallpaperSourceId, categoryId: string, uhd: boolean): string {
  return `${source}:${categoryId}:${uhd ? 'uhd' : 'any'}`
}

function isEntry(v: unknown): v is Grid[string] {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return Array.isArray(e.photos) && typeof e.fetchedAt === 'number'
}

/** The old single-object shape ({ photos, pickId, fetchedAt }) has no entry-shaped values, so it reads as empty. */
function asGrid(grid: unknown): Grid {
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return {}
  const out: Grid = {}
  for (const [k, v] of Object.entries(grid)) if (isEntry(v)) out[k] = v
  return out
}

export function readCache(grid: unknown, key: string, now: number): Grid[string] | null {
  const entry = asGrid(grid)[key]
  if (!entry) return null
  if (now - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry
}

export function writeCache(grid: unknown, key: string, entry: Grid[string]): Grid {
  const next = { ...asGrid(grid), [key]: entry }
  const keep = Object.entries(next)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, CACHE_ENTRIES)
  return Object.fromEntries(keep)
}

export function mergeBatch(
  shown: WallpaperPhoto[],
  incoming: WallpaperPhoto[],
): { photos: WallpaperPhoto[]; added: number } {
  const seen = new Set(shown.map((p) => p.id))
  const fresh: WallpaperPhoto[] = []
  for (const p of incoming) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    fresh.push(p)
  }
  return { photos: [...shown, ...fresh], added: fresh.length }
}

/** No cap on batches (Jasper, 2026-11-25): loading stops only when the
 *  source has nothing more (`done`) or a request failed. */
export function shouldLoadMore(s: { loading: boolean; done: boolean; error: boolean }): boolean {
  return !s.loading && !s.done && !s.error
}
