import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UnsplashPhoto } from '../../types'

type Orientation = 'landscape' | 'portrait' | 'squarish' | 'any'

// Curated topic slugs from Unsplash — these are stable identifiers Unsplash
// publishes; if the slug ever 404s the empty state catches it. Keeping the
// list short and wallpaper-friendly. `featured` is the editorial feed (no
// topic, no query) and intentionally has no `slug`.
const TOPICS: { id: string; label: string; slug?: string; query?: string }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'wallpapers', label: 'Wallpapers', slug: 'wallpapers' },
  { id: 'nature', label: 'Nature', slug: 'nature' },
  { id: 'textures', label: 'Textures', slug: 'textures-patterns' },
  { id: 'architecture', label: 'Architecture', slug: 'architecture-interior' },
  { id: 'minimal', label: 'Minimal', query: 'minimal abstract' },
  { id: 'space', label: 'Space', query: 'galaxy space' },
  { id: 'dark', label: 'Dark', query: 'dark moody' },
]

const ORIENTATIONS: { id: Orientation; label: string; icon: string }[] = [
  { id: 'any',       label: 'Any',       icon: 'crop_free' },
  { id: 'landscape', label: 'Landscape', icon: 'crop_landscape' },
  { id: 'portrait',  label: 'Portrait',  icon: 'crop_portrait' },
  { id: 'squarish',  label: 'Square',    icon: 'crop_square' },
]

interface QueryState {
  topicId: string
  search: string
  orientation: Orientation
}

const INITIAL_STATE: QueryState = { topicId: 'featured', search: '', orientation: 'any' }

export default function Wallpapers() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [state, setState] = useState<QueryState>(INITIAL_STATE)
  const [searchInput, setSearchInput] = useState('')
  const [photos, setPhotos] = useState<UnsplashPhoto[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<UnsplashPhoto | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // Track the currently in-flight request so a fast topic-switch doesn't let a
  // stale response overwrite the new one. We compare each response's token
  // against the current ref before applying state.
  const requestTokenRef = useRef(0)

  useEffect(() => {
    window.electronAPI?.wallpapersIsConfigured?.().then(setConfigured)
  }, [])

  const fetchPage = useCallback(async (next: QueryState, pageNum: number, append: boolean) => {
    if (configured === false) return
    const token = ++requestTokenRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const topic = TOPICS.find(t => t.id === next.topicId)
      const opts: Parameters<NonNullable<typeof window.electronAPI>['wallpapersList']>[0] = {
        page: pageNum,
        perPage: 24,
      }
      if (next.orientation !== 'any') opts.orientation = next.orientation
      if (next.search.trim().length > 0) {
        opts.query = next.search.trim()
      } else if (topic?.slug) {
        opts.topic = topic.slug
      } else if (topic?.query) {
        opts.query = topic.query
      }
      const result = await window.electronAPI?.wallpapersList(opts)
      if (token !== requestTokenRef.current) return  // superseded
      if (!result) {
        setError('Wallpapers API not available')
        return
      }
      if (!result.ok) {
        setError(result.error)
        if (!append) setPhotos([])
        setHasMore(false)
        return
      }
      setPhotos(prev => append ? [...prev, ...result.photos] : result.photos)
      setHasMore(result.photos.length > 0 && pageNum < (result.totalPages || pageNum + 1))
    } catch (err) {
      if (token !== requestTokenRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (token === requestTokenRef.current) {
        if (append) setLoadingMore(false); else setLoading(false)
      }
    }
  }, [configured])

  // Initial + state-change loads. Search is debounced separately below so the
  // topic/orientation effect can fire immediately on click.
  useEffect(() => {
    if (configured === null) return
    setPage(1)
    fetchPage(state, 1, false)
  }, [state, configured, fetchPage])

  // Debounce search input → query state. 350ms is short enough to feel
  // responsive but long enough to skip per-keystroke API calls.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput !== state.search) {
        setState(s => ({ ...s, search: searchInput }))
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [searchInput, state.search])

  const loadMore = () => {
    if (loadingMore || loading || !hasMore) return
    const next = page + 1
    setPage(next)
    fetchPage(state, next, true)
  }

  const handleTopic = (topicId: string) => {
    if (state.topicId === topicId && !state.search) return
    setSearchInput('')
    setState({ topicId, search: '', orientation: state.orientation })
  }

  const handleOrientation = (orientation: Orientation) => {
    if (state.orientation === orientation) return
    setState(s => ({ ...s, orientation }))
  }

  const handleOpenPreview = (photo: UnsplashPhoto) => {
    setPreview(photo)
    if (photo.links.downloadLocation) {
      window.electronAPI?.wallpapersTrackDownload?.(photo.links.downloadLocation)
    }
  }

  const showEmpty = !loading && !error && photos.length === 0
  const activeTopic = useMemo(() => TOPICS.find(t => t.id === state.topicId), [state.topicId])

  if (configured === false) {
    return (
      <div className="h-full overflow-y-auto px-10 py-8">
        <Header />
        <div className="glass-card mt-8 max-w-2xl rounded-2xl p-8">
          <div className="flex items-start gap-4">
            <span className="material-symbols-outlined text-3xl text-amber-300">key_off</span>
            <div className="space-y-2">
              <h2 className="text-lg font-bold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Unsplash access key missing
              </h2>
              <p className="text-sm text-slate-400">
                Set <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">MAIN_VITE_UNSPLASH_ACCESS_KEY</code> in
                your <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">.env</code> and rebuild — the
                Wallpapers feature is gated behind a configured Unsplash app.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-10 py-8">
      <Header />

      {/* Search + filters */}
      <div className="mt-6 flex flex-col gap-4">
        <div className="relative max-w-xl">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[20px] text-slate-400 pointer-events-none">
            search
          </span>
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search wallpapers (e.g. mountains, neon city, ocean)"
            className="w-full pl-11 pr-10 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-white/20 transition"
            style={{ fontFamily: 'Inter, sans-serif' }}
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              aria-label="Clear search"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TOPICS.map(t => {
            const active = state.topicId === t.id && !state.search
            return (
              <button
                key={t.id}
                onClick={() => handleTopic(t.id)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${
                  active
                    ? 'bg-white text-slate-900 shadow-md'
                    : 'bg-white/[0.05] text-slate-300 hover:bg-white/[0.1] hover:text-white'
                }`}
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                {t.label}
              </button>
            )
          })}

          <div className="ml-auto flex items-center gap-1 rounded-full bg-white/[0.04] p-1">
            {ORIENTATIONS.map(o => {
              const active = state.orientation === o.id
              return (
                <button
                  key={o.id}
                  onClick={() => handleOrientation(o.id)}
                  title={o.label}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition ${
                    active
                      ? 'bg-white/15 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">{o.icon}</span>
                  <span className="hidden sm:inline">{o.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Status row */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500" style={{ fontFamily: 'Inter, sans-serif' }}>
          {state.search
            ? `Results for "${state.search}"`
            : activeTopic
              ? activeTopic.label
              : 'Featured'}
          {photos.length > 0 && ` · ${photos.length} photo${photos.length === 1 ? '' : 's'} loaded`}
        </p>
        {error && (
          <span className="text-xs text-rose-300">
            <span className="material-symbols-outlined align-middle text-[14px] mr-1">error</span>
            {error}
          </span>
        )}
      </div>

      {/* Grid */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {photos.map(photo => (
          <PhotoCard key={photo.id} photo={photo} onClick={() => handleOpenPreview(photo)} />
        ))}
        {loading && photos.length === 0 && Array.from({ length: 8 }).map((_, i) => (
          <div key={`skel-${i}`} className="aspect-[4/3] rounded-xl bg-white/[0.03] animate-pulse" />
        ))}
      </div>

      {showEmpty && (
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-slate-400">
          <span className="material-symbols-outlined text-4xl">image_search</span>
          <p className="text-sm">No wallpapers found. Try a different keyword or topic.</p>
        </div>
      )}

      {hasMore && photos.length > 0 && (
        <div className="mt-8 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-5 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-sm text-white border border-white/[0.08] transition disabled:opacity-50"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {preview && (
        <PreviewDialog
          photo={preview}
          onClose={() => setPreview(null)}
          onApplied={(message, type) => showToast(message, type)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[110] -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2">
          <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 shadow-2xl border backdrop-blur-md ${
            toast.type === 'success'
              ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-100'
              : 'bg-rose-500/15 border-rose-400/30 text-rose-100'
          }`}>
            <span className="material-symbols-outlined text-[18px]">
              {toast.type === 'success' ? 'check_circle' : 'error'}
            </span>
            <span className="text-sm font-medium" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {toast.message}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
        Wallpapers
      </h1>
      <p className="mt-1 text-sm text-slate-400" style={{ fontFamily: 'Inter, sans-serif' }}>
        High-quality desktop backgrounds from Unsplash. Browse, search, preview.
      </p>
    </div>
  )
}

function PhotoCard({ photo, onClick }: { photo: UnsplashPhoto; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.05] hover:border-white/20 transition-all"
      style={{ backgroundColor: photo.color ?? '#1a1a1f' }}
    >
      <img
        src={photo.urls.small}
        alt={photo.description ?? `Photo by ${photo.user.name}`}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="truncate text-xs font-medium text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
          {photo.user.name}
        </span>
        <span className="material-symbols-outlined text-[18px] text-white">open_in_full</span>
      </div>
    </button>
  )
}

// Unsplash branding requires UTM params on attribution links so traffic is
// correctly attributed back to the API consumer (Lumia). `?utm_source=lumia
// &utm_medium=referral` is the format they document.
function withUtm(url: string): string {
  const u = new URL(url)
  u.searchParams.set('utm_source', 'lumia')
  u.searchParams.set('utm_medium', 'referral')
  return u.toString()
}

function PreviewDialog({
  photo,
  onClose,
  onApplied,
}: {
  photo: UnsplashPhoto
  onClose: () => void
  onApplied: (message: string, type: 'success' | 'error') => void
}) {
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !applying) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, applying])

  const handleApply = async () => {
    if (applying) return
    setApplying(true)
    try {
      const result = await window.electronAPI?.wallpapersSetAsWallpaper(photo)
      if (result?.ok) {
        onApplied('Wallpaper applied', 'success')
        onClose()
      } else {
        onApplied(result?.error ?? 'Failed to apply wallpaper', 'error')
      }
    } catch (err) {
      onApplied(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-6"
      onClick={() => { if (!applying) onClose() }}
    >
      <div
        className="relative flex max-h-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-[#0a0a0e] border border-white/10 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          disabled={applying}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-50"
          aria-label="Close"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
        <div className="flex flex-1 min-h-0 items-center justify-center bg-black p-2">
          <img
            src={photo.urls.regular}
            alt={photo.description ?? `Photo by ${photo.user.name}`}
            className="max-h-[70vh] w-auto rounded-lg object-contain"
          />
        </div>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {photo.description ?? 'Untitled'}
            </p>
            <p className="text-xs text-slate-400">
              by{' '}
              <button
                className="text-slate-200 hover:text-white underline-offset-2 hover:underline"
                onClick={() => window.electronAPI?.openExternal(withUtm(photo.user.link))}
              >
                {photo.user.name}
              </button>
              {' · '}
              <button
                className="text-slate-400 hover:text-white underline-offset-2 hover:underline"
                onClick={() => window.electronAPI?.openExternal(withUtm(photo.links.html))}
              >
                Unsplash
              </button>
              {' · '}
              {photo.width}×{photo.height}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleApply}
              disabled={applying}
              className="flex items-center gap-2 px-4 py-2 rounded-xl primary-gradient text-slate-900 text-sm font-bold shadow-lg hover:scale-[1.02] active:scale-95 transition disabled:opacity-60 disabled:cursor-wait disabled:hover:scale-100"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              <span className="material-symbols-outlined text-[18px]">
                {applying ? 'hourglass_top' : 'wallpaper'}
              </span>
              {applying ? 'Applying…' : 'Set as wallpaper'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
