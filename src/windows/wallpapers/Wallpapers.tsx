import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UnsplashPhoto } from '../../types'

interface Category {
  id: string
  label: string
  icon: string
  /** Editorial topic slug — preferred when set. Curated by Unsplash, gives
   *  consistently higher quality than free-text search. */
  topic?: string
  /** Free-text fallback when no editorial topic matches. */
  query?: string
  /** Tailwind gradient pair for the picker card backdrop. Strings are literal
   *  so the Tailwind v4 scanner picks them up (no dynamic interpolation). */
  gradient: string
  /** Marks user-added customs so the picker can render a delete affordance
   *  and route persistence accordingly. */
  isCustom?: boolean
}

// Built-in editorial topics (Unsplash slug). Quality is consistently higher
// than free-text search because Unsplash editors curate these pools.
const TOPIC_CATEGORIES: Category[] = [
  { id: 'wallpapers',   label: 'Wallpapers',   icon: 'wallpaper',       topic: 'wallpapers',            gradient: 'from-indigo-500/40 to-purple-800/50' },
  { id: 'nature',       label: 'Nature',       icon: 'park',            topic: 'nature',                gradient: 'from-emerald-500/40 to-emerald-800/50' },
  { id: 'architecture', label: 'Architecture', icon: 'apartment',       topic: 'architecture-interior', gradient: 'from-stone-500/40 to-stone-800/50' },
  { id: 'animals',      label: 'Animals',      icon: 'pets',            topic: 'animals',               gradient: 'from-amber-500/40 to-orange-900/50' },
  { id: 'textures',     label: 'Textures',     icon: 'texture',         topic: 'textures-patterns',     gradient: 'from-neutral-500/40 to-neutral-800/50' },
  { id: 'abstract',     label: 'Abstract',     icon: 'palette',         topic: 'experimental',          gradient: 'from-fuchsia-500/40 to-purple-900/50' },
  { id: '3d-renders',   label: '3D Renders',   icon: 'deployed_code',   topic: '3d-renders',            gradient: 'from-violet-500/40 to-blue-900/50' },
  { id: 'travel',       label: 'Travel',       icon: 'travel_explore',  topic: 'travel',                gradient: 'from-sky-500/40 to-cyan-800/50' },
  { id: 'film',         label: 'Film',         icon: 'camera_roll',     topic: 'film',                  gradient: 'from-yellow-700/40 to-orange-900/50' },
  { id: 'street',       label: 'Street',       icon: 'directions_walk', topic: 'street-photography',    gradient: 'from-slate-600/40 to-slate-900/50' },
  { id: 'arts',         label: 'Arts',         icon: 'museum',          topic: 'arts-culture',          gradient: 'from-rose-500/40 to-pink-900/50' },
]

// Free-text query categories — themes Unsplash doesn't have a topic slug for
// but are massive wallpaper pools in their own right. Lower curation but the
// keywords are mainstream enough that Unsplash search returns clean results.
const QUERY_CATEGORIES: Category[] = [
  { id: 'mountains',    label: 'Mountains',    icon: 'landscape',       query: 'mountains landscape',   gradient: 'from-slate-500/40 to-slate-800/50' },
  { id: 'ocean',        label: 'Ocean',        icon: 'water',           query: 'ocean sea',             gradient: 'from-cyan-500/40 to-blue-800/50' },
  { id: 'forest',       label: 'Forest',       icon: 'forest',          query: 'forest woodland',       gradient: 'from-green-600/40 to-emerald-900/50' },
  { id: 'sunset',       label: 'Sunset',       icon: 'wb_twilight',     query: 'sunset golden hour',    gradient: 'from-orange-500/40 to-rose-800/50' },
  { id: 'space',        label: 'Space',        icon: 'rocket_launch',   query: 'galaxy space stars',    gradient: 'from-violet-600/40 to-indigo-900/50' },
  { id: 'aurora',       label: 'Aurora',       icon: 'auto_awesome',    query: 'aurora borealis',       gradient: 'from-teal-400/40 to-purple-800/50' },
  { id: 'minimal',      label: 'Minimal',      icon: 'rectangle',       query: 'minimal abstract',      gradient: 'from-zinc-400/40 to-zinc-700/50' },
  { id: 'dark',         label: 'Dark',         icon: 'dark_mode',       query: 'dark moody',            gradient: 'from-slate-800/50 to-black/60' },
  { id: 'city',         label: 'City',         icon: 'location_city',   query: 'city skyline night',    gradient: 'from-sky-500/40 to-indigo-900/50' },
  { id: 'flowers',      label: 'Flowers',      icon: 'local_florist',   query: 'flowers',               gradient: 'from-pink-400/40 to-rose-800/50' },
  { id: 'cars',         label: 'Cars',         icon: 'directions_car',  query: 'cars automotive',       gradient: 'from-red-500/40 to-rose-900/50' },
]

const BUILTIN_CATEGORIES: Category[] = [...TOPIC_CATEGORIES, ...QUERY_CATEGORIES]

/** Default visual treatment for a user-added custom category — neutral
 *  gradient so it doesn't fight built-ins for attention, but still legible. */
const CUSTOM_GRADIENT = 'from-slate-600/40 to-slate-900/50'
const CUSTOM_ICON = 'tag'

interface CustomEntry { id: string; label: string; query: string }

function customsToCategories(customs: CustomEntry[]): Category[] {
  return customs.map(c => ({
    id: c.id,
    label: c.label,
    icon: CUSTOM_ICON,
    query: c.query,
    gradient: CUSTOM_GRADIENT,
    isCustom: true,
  }))
}

// At least one favorite is needed to make a random call; no upper bound — the
// user can pick all of them if they want broad rotation.
const MIN_PICK = 1
// Unsplash's `/photos/random` caps `count` at 30 per request. We ask for the
// max so a single Refresh fills a dense grid for one full API call.
const RANDOM_COUNT = 30

type Mode = 'loading' | 'picker' | 'gallery'

export default function Wallpapers() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [favorites, setFavorites] = useState<string[]>([])
  const [customs, setCustoms] = useState<Category[]>([])
  const [mode, setMode] = useState<Mode>('loading')
  const [draft, setDraft] = useState<string[]>([])
  const [photos, setPhotos] = useState<UnsplashPhoto[]>([])
  const [activePickId, setActivePickId] = useState<string | null>(null)
  const [loadingPhotos, setLoadingPhotos] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<UnsplashPhoto | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the in-flight random-fetch so a fast Refresh-then-Refresh doesn't
  // let an older response overwrite a newer one.
  const requestTokenRef = useRef(0)

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // Lookup against the union of built-ins and customs. Passed in by the
  // caller so we don't capture stale customs state across refreshes.
  const fetchPhotos = useCallback(async (ids: string[], allCategories: Category[]) => {
    const picks = ids
      .map(id => allCategories.find(c => c.id === id))
      .filter((c): c is Category => !!c && (!!c.topic || !!c.query))
      .map(c => ({ id: c.id, topic: c.topic, query: c.query }))
    if (picks.length === 0) return
    const token = ++requestTokenRef.current
    setLoadingPhotos(true)
    setError(null)
    try {
      const res = await window.electronAPI?.wallpapersRandom({ picks, count: RANDOM_COUNT })
      if (token !== requestTokenRef.current) return
      // On any error path we surface the message via the inline banner but
      // keep the previously-rendered photos + activePickId in place — the
      // user can keep browsing the last successful batch instead of staring
      // at an empty grid because Unsplash hiccuped. Same reasoning for the
      // catch branch below.
      if (!res) {
        setError('Wallpapers API not available')
      } else if (!res.ok) {
        setError(res.error)
      } else {
        setPhotos(res.photos)
        setActivePickId(res.pickId)
        // Persist so subsequent visits read from cache rather than hitting
        // Unsplash again — only Refresh / changed favorites should re-fetch.
        window.electronAPI?.setSetting('wallpaperGrid', {
          photos: res.photos,
          pickId: res.pickId,
          fetchedAt: Date.now(),
        })
      }
    } catch (err) {
      if (token !== requestTokenRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (token === requestTokenRef.current) setLoadingPhotos(false)
    }
  }, [])

  // Bootstrap: load configured flag + favorites + cached grid in one shot.
  // Decide whether to render cache, fetch fresh, or send the user to the
  // picker. We only fire a fetch on first-ever visit (favorites set, no cache
  // yet) — afterwards visits read from cache until the user clicks Refresh.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.electronAPI?.wallpapersIsConfigured?.() ?? Promise.resolve(false),
      window.electronAPI?.getSettings?.() ?? Promise.resolve(null),
    ]).then(([conf, settings]) => {
      if (cancelled) return
      setConfigured(Boolean(conf))
      const s = settings as
        | {
            wallpaperCategories?: unknown
            wallpaperCustomCategories?: unknown
            wallpaperGrid?: unknown
          }
        | null

      // Hydrate customs first — favorites ids are validated against the
      // union of built-ins + customs, otherwise valid custom selections from
      // a prior session would be silently dropped.
      const rawCustoms = s?.wallpaperCustomCategories
      const loadedCustoms: Category[] = Array.isArray(rawCustoms)
        ? customsToCategories(
            (rawCustoms as unknown[]).filter((c): c is CustomEntry =>
              !!c && typeof c === 'object' &&
              typeof (c as CustomEntry).id === 'string' &&
              typeof (c as CustomEntry).label === 'string' &&
              typeof (c as CustomEntry).query === 'string'
            )
          )
        : []
      setCustoms(loadedCustoms)
      const allCats = [...BUILTIN_CATEGORIES, ...loadedCustoms]

      const cats = s?.wallpaperCategories
      const stored = Array.isArray(cats)
        ? (cats as unknown[]).filter((id): id is string => typeof id === 'string' && allCats.some(c => c.id === id))
        : []
      setFavorites(stored)

      if (stored.length === 0) {
        setMode('picker')
        return
      }

      const cache = s?.wallpaperGrid as
        | { photos?: UnsplashPhoto[]; pickId?: string }
        | null
        | undefined
      if (cache && Array.isArray(cache.photos) && cache.photos.length > 0) {
        setPhotos(cache.photos)
        setActivePickId(typeof cache.pickId === 'string' ? cache.pickId : null)
        setMode('gallery')
        return
      }

      // Favorites set but no cache (first-ever visit, or cache cleared) —
      // need one fetch to populate. After this it's cache-only until Refresh.
      setMode('gallery')
      if (conf) fetchPhotos(stored, allCats)
    })
    return () => { cancelled = true }
  }, [fetchPhotos])

  const allCategories = useMemo(() => [...BUILTIN_CATEGORIES, ...customs], [customs])

  const toggleDraft = (id: string) => {
    setDraft(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // Inline form state lives in the parent so adding a custom while editing
  // favorites can immediately auto-select it (and so we can persist on add).
  const persistCustoms = (next: Category[]) => {
    window.electronAPI?.setSetting(
      'wallpaperCustomCategories',
      next
        .filter(c => c.isCustom)
        .map(c => ({ id: c.id, label: c.label, query: c.query ?? c.label })),
    )
  }

  const addCustom = (label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    const id = `custom-${Date.now().toString(36)}`
    const newCat: Category = {
      id,
      label: trimmed,
      icon: CUSTOM_ICON,
      query: trimmed,
      gradient: CUSTOM_GRADIENT,
      isCustom: true,
    }
    setCustoms(prev => {
      const next = [...prev, newCat]
      persistCustoms(next)
      return next
    })
    // Auto-select the new pill so the user doesn't have to click twice.
    setDraft(prev => prev.includes(id) ? prev : [...prev, id])
  }

  const deleteCustom = (id: string) => {
    setCustoms(prev => {
      const next = prev.filter(c => c.id !== id)
      persistCustoms(next)
      return next
    })
    setDraft(prev => prev.filter(x => x !== id))
    setFavorites(prev => prev.filter(x => x !== id))
  }

  const saveFavorites = async () => {
    if (draft.length < MIN_PICK) return
    // If the favorite set actually changed, drop the stale cache and refetch
    // — otherwise the user would land on a gallery still showing photos from
    // categories they no longer want.
    const changed = draft.length !== favorites.length || draft.some(id => !favorites.includes(id))
    await window.electronAPI?.setSetting('wallpaperCategories', draft)
    if (changed) {
      await window.electronAPI?.setSetting('wallpaperGrid', null)
    }
    setFavorites(draft)
    setMode('gallery')
    if (changed && configured) fetchPhotos(draft, allCategories)
  }

  const startEdit = () => {
    setDraft(favorites)
    setMode('picker')
  }

  const cancelEdit = () => {
    if (favorites.length > 0) setMode('gallery')
  }

  const handleOpenPreview = (photo: UnsplashPhoto) => {
    setPreview(photo)
  }

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

  if (mode === 'loading' || configured === null) {
    return (
      <div className="h-full overflow-y-auto px-10 py-8">
        <Header />
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[4/3] rounded-xl bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (mode === 'picker') {
    return (
      <PickerView
        draft={draft}
        customs={customs}
        onToggle={toggleDraft}
        onSave={saveFavorites}
        onCancel={favorites.length > 0 ? cancelEdit : null}
        onAddCustom={addCustom}
        onDeleteCustom={deleteCustom}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto px-10 py-8">
      <GalleryHeader
        favorites={favorites}
        allCategories={allCategories}
        activePickId={activePickId}
        onRefresh={() => fetchPhotos(favorites, allCategories)}
        onEdit={startEdit}
        loading={loadingPhotos}
      />

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{error}</span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {loadingPhotos
          ? Array.from({ length: 12 }).map((_, i) => (
              <div key={`skel-${i}`} className="aspect-[4/3] rounded-xl bg-white/[0.03] animate-pulse" />
            ))
          : photos.map(photo => (
              <PhotoCard key={photo.id} photo={photo} onClick={() => handleOpenPreview(photo)} />
            ))}
      </div>

      {!loadingPhotos && photos.length === 0 && !error && (
        <div className="mt-12 flex flex-col items-center gap-3 text-center text-slate-400">
          <span className="material-symbols-outlined text-4xl">image_search</span>
          <p className="text-sm">No wallpapers returned. Try refreshing or pick different categories.</p>
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
        High-quality desktop backgrounds from Unsplash, picked from your favorite categories.
      </p>
    </div>
  )
}

function GalleryHeader({
  favorites,
  allCategories,
  activePickId,
  onRefresh,
  onEdit,
  loading,
}: {
  favorites: string[]
  allCategories: Category[]
  activePickId: string | null
  onRefresh: () => void
  onEdit: () => void
  loading: boolean
}) {
  // Highlight the chip for the category main just rolled — gives a visual
  // cue that Refresh rotates between favorites instead of mixing them.
  const activeId = activePickId && favorites.includes(activePickId) ? activePickId : null
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-3xl font-extrabold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Wallpapers
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {favorites.map(id => {
            const cat = allCategories.find(c => c.id === id)
            if (!cat) return null
            const active = id === activeId
            return (
              <span
                key={id}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition ${
                  active
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'bg-white/[0.06] text-slate-200'
                }`}
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                <span className="material-symbols-outlined text-[14px]">{cat.icon}</span>
                {cat.label}
              </span>
            )
          })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-slate-200 transition hover:bg-white/[0.08]"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[16px]">tune</span>
          Edit favorites
        </button>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-xl primary-gradient px-4 py-2 text-xs font-bold text-slate-900 shadow-md transition hover:scale-[1.02] active:scale-95 disabled:cursor-wait disabled:opacity-60 disabled:hover:scale-100"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>
            {loading ? 'progress_activity' : 'refresh'}
          </span>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
    </div>
  )
}

function PickerView({
  draft,
  customs,
  onToggle,
  onSave,
  onCancel,
  onAddCustom,
  onDeleteCustom,
}: {
  draft: string[]
  customs: Category[]
  onToggle: (id: string) => void
  onSave: () => void
  onCancel: (() => void) | null
  onAddCustom: (label: string) => void
  onDeleteCustom: (id: string) => void
}) {
  const count = draft.length
  const canSave = count >= MIN_PICK
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  const submitNew = () => {
    const v = newLabel.trim()
    if (!v) {
      setAdding(false)
      return
    }
    onAddCustom(v)
    setNewLabel('')
    setAdding(false)
  }

  return (
    <div className="h-full overflow-y-auto px-10 py-8 pb-28">
      <div>
        <h1 className="text-3xl font-extrabold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Pick your favorites
        </h1>
        <p className="mt-1 text-sm text-slate-400" style={{ fontFamily: 'Inter, sans-serif' }}>
          Pick the categories you'd like wallpapers from — as few or as many as you want. Add your own
          keywords if none of the built-ins fit. Lumia rotates through your picks every time you click
          Refresh.
        </p>
      </div>

      {/* Tag-style picker — flex-wrap so the row density adapts to whatever
          width the user is on, and each pill stays compact instead of
          stretching to fill a grid cell. Selected pills get the category's
          accent gradient so the choice stays visually distinct. Custom pills
          show a × delete affordance; built-ins don't. */}
      <div className="mt-8 flex flex-wrap gap-2">
        {[...BUILTIN_CATEGORIES, ...customs].map(cat => {
          const selected = draft.includes(cat.id)
          return (
            <div key={cat.id} className="group relative">
              <button
                type="button"
                onClick={() => onToggle(cat.id)}
                aria-pressed={selected}
                className={`relative flex items-center gap-2 overflow-hidden rounded-full text-sm transition-all ${
                  cat.isCustom ? 'pl-3.5 pr-7 py-2' : 'px-3.5 py-2'
                } ${
                  selected
                    ? `bg-gradient-to-br ${cat.gradient} text-white ring-1 ring-white/40 shadow-md`
                    : 'bg-white/[0.05] text-slate-300 ring-1 ring-white/10 hover:bg-white/[0.1] hover:text-white'
                }`}
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                <span className="material-symbols-outlined text-[18px]">{cat.icon}</span>
                <span className="font-medium">{cat.label}</span>
                {selected && (
                  <span className="material-symbols-outlined ml-0.5 text-[16px]">check</span>
                )}
              </button>
              {cat.isCustom && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onDeleteCustom(cat.id) }}
                  aria-label={`Delete ${cat.label}`}
                  // Sits on top of the pill in the right-edge gutter we left
                  // via pr-7. Always visible at low opacity so the affordance
                  // is discoverable; hover/group-hover brightens it.
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full bg-black/30 text-white/70 opacity-60 transition hover:bg-black/60 hover:text-white group-hover:opacity-100"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              )}
            </div>
          )
        })}

        {/* Add-custom affordance: pill that turns into a tiny inline form
            when clicked. Enter submits, Escape/blur with empty cancels. */}
        {adding ? (
          <div className="flex items-center gap-1 rounded-full bg-white/[0.08] ring-1 ring-white/20 pl-3 pr-1 py-1">
            <span className="material-symbols-outlined text-[18px] text-slate-300">tag</span>
            <input
              autoFocus
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitNew()
                else if (e.key === 'Escape') { setNewLabel(''); setAdding(false) }
              }}
              onBlur={submitNew}
              placeholder="e.g. cyberpunk"
              className="w-32 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            />
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={submitNew}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-900 shadow"
              aria-label="Add"
            >
              <span className="material-symbols-outlined text-[16px]">check</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-full border border-dashed border-white/20 px-3.5 py-2 text-sm text-slate-300 transition hover:border-white/40 hover:bg-white/[0.04] hover:text-white"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Add custom
          </button>
        )}
      </div>

      {/* Sticky footer with selection count + actions. Pinned to viewport so the
          user can scroll the grid without losing the Save button. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-[#07070b]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-10 py-3">
          <div className="text-sm text-slate-300" style={{ fontFamily: 'Manrope, sans-serif' }}>
            <span className={canSave ? 'font-bold text-white' : 'text-slate-400'}>
              {count}
            </span>
            <span className="text-slate-500"> selected</span>
            {!canSave && (
              <span className="ml-2 text-xs text-slate-500">
                Pick at least {MIN_PICK}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onCancel && (
              <button
                onClick={onCancel}
                className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm text-slate-200 transition hover:bg-white/[0.08]"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Cancel
              </button>
            )}
            <button
              onClick={onSave}
              disabled={!canSave}
              className="flex items-center gap-1.5 rounded-xl primary-gradient px-5 py-2 text-sm font-bold text-slate-900 shadow-lg transition hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              Save & continue
            </button>
          </div>
        </div>
      </div>
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
