import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WallpaperPhoto } from '../../types'
import {
  categoriesFor,
  DEFAULT_WALLPAPER_CATEGORY,
  sourceName,
  type WallpaperQuery,
  type WallpaperSourceId,
} from '../../../shared/wallpapers'
import { cacheKey, mergeBatch, readCache, shouldLoadMore, writeCache } from '../../lib/wallpaper-feed'

import { Icon } from '../../components/Icon'
import { BUTTON, ACCENT_BUTTON, ICON_BUTTON } from '../../components/button-classes'
import { CaretDivider } from '../../components/CaretDivider'
import { OnStrip } from '../../components/OnStrip'
import { MessageBox } from '../../components/MessageBox'
import { Segmented } from '../../components/Segmented'
import { Group, Row, Toggle } from '../../components/SettingsRows'
import { toast, toastError } from '../../lib/toast'

interface Category {
  id: string
  label: string
  icon: string
  /** A search: the words as typed (the search field, 2026-11-26). */
  keywords?: string
}

/* The categories' icons. The list itself (ids, labels) is shared with the
   main process (shared/wallpapers.ts); each source turns an id into its own
   search (electron/wallpaper-sources/). */
const CATEGORY_ICONS: Record<string, string> = {
  landscapes:   'landscape', // custom: snowy mountain + pine (Icon.tsx MountainTree)
  mountains:    'mountain',
  lakes:        'water',
  waterfalls:   'waterfall',
  coast:        'sailboat',
  forests:      'forest',
  sunsets:      'wb_twilight',
  clouds:       'foggy',
  space:        'telescope',
  cities:       'location_city',
  architecture: 'architecture',
  interiors:    'church',
  flowers:      'local_florist',
  birds:        'bird',
  animals:      'pets',
  abstract:     'shapes',
  dark:         'moon_star', // not the theme button's moon
  minimal:      'square',
  gradients:    'gradient',
  '3d':         'cube',
  fantasy:      'castle',
  scifi:        'rocket',
  anime:        'swords', // not Sparkles: that's Release notes in the Settings nav
  games:        'gamepad',
  cars:         'car',
}

/** The built-in categories a source offers (Anime is Wallhaven's only). */
function builtinsFor(source: WallpaperSourceId): Category[] {
  return categoriesFor(source).map(c => ({ id: c.id, label: c.label, icon: CATEGORY_ICONS[c.id] ?? 'image' }))
}

/** A search, shaped like a category so loading, caching and the end line
 *  treat both alike. */
function searchCategory(words: string): Category {
  return { id: `search:${words}`, label: words, icon: 'search', keywords: words }
}

const SOURCE_OPTIONS: { key: WallpaperSourceId; label: string }[] = [
  { key: 'commons', label: 'Wikimedia' },
  { key: 'wallhaven', label: 'Wallhaven' },
]

const SOURCE_DESCRIPTIONS: Record<WallpaperSourceId, string> = {
  commons: 'Free photos from Wikimedia Commons.',
  wallhaven: 'Wallpapers uploaded to Wallhaven.',
}

/** What the source is asked for: a built-in by id, a search as typed. */
function queryOf(cat: Category): Pick<WallpaperQuery, 'categoryId' | 'keywords'> {
  return cat.keywords ? { keywords: cat.keywords } : { categoryId: cat.id }
}

/** The photos shown: the batches loaded so far for the shown category. */
interface Feed {
  photos: WallpaperPhoto[]
  /** What the next page continues from (Wallhaven's seed). */
  cursor?: string
  /** Pages loaded (page 1 included). */
  batches: number
  /** The source has no more, or a batch added nothing new. */
  done: boolean
}

const EMPTY_FEED: Feed = { photos: [], batches: 0, done: false }

/** Settings › Wallpapers (2026-11-25; a page of its own, /wallpapers, until
 *  then). Photos come from Wikimedia Commons or Wallhaven (design/
 *  WALLPAPER-SOURCES.md), the same way for both: one category at a time, a
 *  click shows its photos straight away, and the box loads the next batch
 *  when its end scrolls into view. The categories and the 4K filter fold out
 *  of the row under the filter button (the Background panel's band and ^);
 *  the photos sit in a box that scrolls on its own so the section stays
 *  short; a photo opens the preview dialog, which sets the wallpaper. */
export default function WallpapersSection() {
  // null until the settings arrive.
  const [source, setSource] = useState<WallpaperSourceId | null>(null)
  const [category, setCategory] = useState(DEFAULT_WALLPAPER_CATEGORY)
  const [uhd, setUhd] = useState(false)
  // Reset wallpaper: shown while Lumia has a wallpaper to put back
  // (wallpaperBefore in main, 2026-11-27).
  const [canReset, setCanReset] = useState(false)
  useEffect(() => {
    void window.electronAPI?.wallpapersCanReset?.().then(v => setCanReset(!!v)).catch(() => {})
  }, [])
  const resetWallpaper = async () => {
    try {
      const r = await window.electronAPI?.wallpapersReset()
      if (r?.ok) { setCanReset(false); toast('Wallpaper reset') }
      else toastError("Couldn't reset wallpaper", r?.error)
    } catch (err) {
      toastError("Couldn't reset wallpaper", err)
    }
  }
  // The search shown (null: the category is), and what the field holds.
  // Not saved: leaving Settings goes back to the category.
  const [searchWords, setSearchWords] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  // The field is a search button until clicked, then slides open; it folds
  // back when it's left empty with no search showing (Jasper, 2026-11-26).
  const [searchOpen, setSearchOpen] = useState(false)
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED)
  // 'first': page 1 (the full-height spinner); 'more': a later page (the
  // spinner row at the end).
  const [loading, setLoading] = useState<'first' | 'more' | null>(null)
  // `more`: a later page failed; its box then sits at the end of the photo
  // box, where the user is scrolled to (a page-1 error sits above them).
  const [error, setError] = useState<{ message: string; more: boolean } | null>(null)
  const [preview, setPreview] = useState<WallpaperPhoto | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Tracks the in-flight fetch so a fast click-then-click doesn't let an
  // older response overwrite a newer one.
  const requestTokenRef = useRef(0)
  // The first batch per source + category, for this visit only: it lives
  // in memory and goes when you leave Settings (Jasper, 2026-11-25; it was
  // saved in settings.json).
  const gridRef = useRef<unknown>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  // The field holds words that haven't been searched yet.
  const enterHint = searchInput.trim() !== '' && searchInput.trim() !== searchWords
  const builtins = useMemo(() => builtinsFor(source ?? 'commons'), [source])
  const shownCategory = builtins.find(c => c.id === category) ?? null
  // What the photo box shows: the search while there is one, else the category.
  const current = searchWords ? searchCategory(searchWords) : shownCategory

  /** Page 1 of a category: from the cache when it holds it, else fetched
   *  (and then cached). On an error the last photos stay, the message
   *  above them. */
  const load = useCallback(async (src: WallpaperSourceId, cat: Category, only4k: boolean) => {
    const token = ++requestTokenRef.current
    setError(null)
    const key = cacheKey(src, cat.id, only4k)
    const cached = readCache(gridRef.current, key, Date.now())
    if (cached && cached.photos.length > 0) {
      setFeed({ photos: cached.photos, cursor: cached.cursor, batches: 1, done: false })
      setLoading(null)
      scrollRef.current?.scrollTo({ top: 0 })
      return
    }
    setLoading('first')
    try {
      const res = await window.electronAPI?.wallpapersFetch(src, { ...queryOf(cat), uhd: only4k, page: 1 })
      if (token !== requestTokenRef.current) return
      if (!res) {
        setError({ message: 'Wallpapers API not available', more: false })
      } else if (!res.ok) {
        setError({ message: res.error, more: false })
      } else {
        const { photos } = mergeBatch([], res.batch.photos)
        setFeed({ photos, cursor: res.batch.cursor, batches: 1, done: res.batch.done || photos.length === 0 })
        scrollRef.current?.scrollTo({ top: 0 })
        // Only page 1 is cached: coming back shows it without a request.
        if (photos.length > 0) {
          gridRef.current = writeCache(gridRef.current, key, { photos, cursor: res.batch.cursor, fetchedAt: Date.now() })
        }
      }
    } catch (err) {
      if (token !== requestTokenRef.current) return
      setError({ message: err instanceof Error ? err.message : String(err), more: false })
    } finally {
      if (token === requestTokenRef.current) setLoading(null)
    }
  }, [])

  /** The next page, appended; photos already shown are dropped, and a batch
   *  that adds none ends the list. */
  const loadMore = useCallback(async () => {
    if (!source || !current || feed.photos.length === 0) return
    if (!shouldLoadMore({ loading: loading !== null, done: feed.done, error: error !== null })) return
    const token = ++requestTokenRef.current
    setLoading('more')
    try {
      const res = await window.electronAPI?.wallpapersFetch(source, {
        ...queryOf(current),
        uhd,
        page: feed.batches + 1,
        cursor: feed.cursor,
      })
      if (token !== requestTokenRef.current) return
      if (!res) {
        setError({ message: 'Wallpapers API not available', more: true })
      } else if (!res.ok) {
        setError({ message: res.error, more: true })
      } else {
        const { photos, added } = mergeBatch(feed.photos, res.batch.photos)
        setFeed({
          photos,
          cursor: res.batch.cursor ?? feed.cursor,
          batches: feed.batches + 1,
          done: res.batch.done || added === 0,
        })
      }
    } catch (err) {
      if (token !== requestTokenRef.current) return
      setError({ message: err instanceof Error ? err.message : String(err), more: true })
    } finally {
      if (token === requestTokenRef.current) setLoading(null)
    }
  }, [source, current, uhd, feed, loading, error])

  // The sentinel at the end of the photo box. Observed again after every
  // change, so a batch that leaves the end in view loads the next one.
  useEffect(() => {
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target) return
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) void loadMore() },
      { root, rootMargin: '0px 0px 120px 0px' },
    )
    io.observe(target)
    return () => io.disconnect()
  }, [loadMore])

  // Load the source, the shown category and the 4K filter, then page 1.
  useEffect(() => {
    let cancelled = false
    ;(window.electronAPI?.getSettings?.() ?? Promise.resolve(null)).then(settings => {
      if (cancelled) return
      const s = settings as
        | { wallpaperSource?: unknown; wallpaperCategory?: unknown; wallpaper4kOnly?: unknown; wallpaperGrid?: unknown }
        | null

      const src: WallpaperSourceId = s?.wallpaperSource === 'wallhaven' ? 'wallhaven' : 'commons'
      const only4k = s?.wallpaper4kOnly === true
      const allCats = builtinsFor(src)
      const savedId = typeof s?.wallpaperCategory === 'string' ? s.wallpaperCategory : null
      const cat = allCats.find(c => c.id === savedId) ?? allCats.find(c => c.id === DEFAULT_WALLPAPER_CATEGORY)!

      // A cache saved by an earlier build: drop it, nothing reads it now.
      if (s?.wallpaperGrid != null) void window.electronAPI?.setSetting('wallpaperGrid', null)
      setCategory(cat.id)
      setUhd(only4k)
      setSource(src)
      load(src, cat, only4k)
    })
    return () => { cancelled = true }
  }, [load])

  // A click shows that category straight away and saves it; it ends a
  // search.
  const showCategory = (cat: Category) => {
    if (!source) return
    if (!searchWords && cat.id === category && feed.photos.length > 0 && !error) return
    setSearchWords(null)
    setSearchInput('')
    setSearchOpen(false)
    setCategory(cat.id)
    void window.electronAPI?.setSetting('wallpaperCategory', cat.id)
    load(source, cat, uhd)
  }

  // Enter in the search field: the words as typed, from the current source.
  const runSearch = () => {
    if (!source) return
    const words = searchInput.trim()
    if (!words) { clearSearch(); return }
    if (words === searchWords && feed.photos.length > 0 && !error) return
    setSearchWords(words)
    load(source, searchCategory(words), uhd)
  }

  // The field's × or Esc: back to the category.
  const clearSearch = () => {
    setSearchInput('')
    setSearchOpen(false)
    if (!searchWords) return
    setSearchWords(null)
    if (source && shownCategory) load(source, shownCategory, uhd)
  }

  // Another source runs the same search or shows the same category; a
  // category it doesn't offer (Anime on Wikimedia) goes back to the default.
  const changeSource = (next: WallpaperSourceId) => {
    if (next === source) return
    setSource(next)
    void window.electronAPI?.setSetting('wallpaperSource', next)
    const offered = categoriesFor(next).some(c => c.id === category)
    const cat = offered ? builtinsFor(next).find(c => c.id === category)! : builtinsFor(next).find(c => c.id === DEFAULT_WALLPAPER_CATEGORY)!
    if (cat.id !== category) {
      setCategory(cat.id)
      void window.electronAPI?.setSetting('wallpaperCategory', cat.id)
    }
    load(next, searchWords ? searchCategory(searchWords) : cat, uhd)
  }

  const change4k = (next: boolean) => {
    setUhd(next)
    void window.electronAPI?.setSetting('wallpaper4kOnly', next)
    if (source && current) load(source, current, next)
  }

  // Blank until the settings arrive (a few ms), like the rest of Settings.
  if (!source) return null

  return (
    <>
    <Group>
      <Row label="Get photos from" description={SOURCE_DESCRIPTIONS[source]}>
        <Segmented value={source} onChange={changeSource} options={SOURCE_OPTIONS} />
      </Row>

      {/* A row of its own like every Settings toggle (2026-11-25; it sat
          inside the categories band, label left and toggle far right, which
          read awkwardly). Works for both sources. */}
      <Row label="Show 4K only" description="Only photos at least 3840×2160.">
        <Toggle checked={uhd} onChange={change4k} label="Show 4K only" />
      </Row>

      {canReset && (
        <Row label="Reset wallpaper" description="Puts back the wallpaper you had before Lumia changed it.">
          <button type="button" onClick={resetWallpaper} className={BUTTON}>Reset</button>
        </Row>
      )}

      {/* The row and the categories band under it, one block, so the
          group's dividing line doesn't double the band's ^ line. */}
      <div ref={rowRef}>
        {/* relative: the band's line and ^ sit on the row's bottom edge
            (where the group's line would be), the ^ rising 5px into the
            row's padding, so the folded row keeps its height. */}
        <div className="relative">
        <Row
          label="Change desktop wallpaper"
          description={searchWords
            ? `Results for ${searchWords}. Click one to preview it.`
            : current ? `Photos from ${current.label}. Click one to preview it.` : 'Click a photo to preview it.'}
        >
          <div className="flex items-center gap-3">
          {/* Search (2026-11-26; it replaced the saved "Add keywords"
              buttons): Enter searches the current source, × or Esc goes
              back to the category. Not on every keystroke (Wikimedia's rate
              limit). */}
          {/* Closed: a 32px framed search button. Open: the field slides
              to 192px (200ms on its width, the icon staying put; off under
              reduced motion). Esc or × clears it and folds it back; leaving
              it empty with no search showing folds it back too. */}
          <div
            className={`relative h-8 shrink-0 overflow-hidden rounded-lg border bg-elevated transition-[width] duration-200 ease-out motion-reduce:transition-none ${
              searchOpen ? 'w-48 border-line focus-within:border-accent' : 'w-8 border-line'
            }`}
          >
            {searchOpen ? (
              <>
                <Icon name="search" className="absolute left-[7px] top-1/2 -translate-y-1/2 text-[16px] text-fg-secondary pointer-events-none" />
                <input
                  autoFocus
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') runSearch()
                    else if (e.key === 'Escape') { e.stopPropagation(); clearSearch() }
                  }}
                  onBlur={() => { if (!searchInput.trim() && !searchWords) setSearchOpen(false) }}
                  placeholder="Search"
                  aria-label="Search wallpapers"
                  className={`h-full w-full pl-[30px] ${enterHint ? 'pr-[60px]' : 'pr-7'} bg-transparent text-xs font-medium text-fg placeholder:text-fg-tertiary outline-none`}
                />
                {/* Typed but not searched yet: a small keycap with the ↵
                    arrow saying how (Jasper, 2026-11-26; the word "Return"
                    / "Enter" was tried the same day). */}
                {enterHint && (
                  <kbd
                    aria-hidden
                    style={{ fontFamily: 'inherit' }}
                    className="absolute right-7 top-1/2 -translate-y-1/2 h-5 w-6 inline-flex items-center justify-center rounded-md border border-line text-fg-secondary pointer-events-none"
                  >
                    <Icon name="keyboard_return" className="text-[14px]" />
                  </kbd>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                data-tip="Search"
                aria-label="Search wallpapers"
                className="absolute inset-0 inline-flex items-center justify-center text-fg-secondary hover:bg-elevated-hover hover:text-fg"
              >
                <Icon name="search" className="text-[16px]" />
              </button>
            )}
            {searchOpen && (searchInput || searchWords) && (
              <button
                type="button"
                onClick={clearSearch}
                data-tip="Clear"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center text-fg-secondary hover:text-fg"
              >
                <Icon name="close" className="text-[14px]" />
              </button>
            )}
          </div>
          {/* Shows the categories; on while they're out
              (the on-state strip, like a callout's source). */}
          <button
            type="button"
            onClick={() => setFiltersOpen(o => !o)}
            data-caret-anchor
            data-tip="Filter"
            aria-label="Categories"
            aria-expanded={filtersOpen}
            className={`group/on relative ${ICON_BUTTON}`}
          >
            <Icon name="filter_alt" className="text-[16px]" />
            {filtersOpen && <OnStrip />}
          </button>
          </div>
        </Row>
        <div className="absolute inset-x-0 bottom-0 pointer-events-none">
          <CaretDivider panelRef={rowRef} open={filtersOpen} selector="[data-caret-anchor]" fill="var(--color-content)" />
        </div>
        </div>

        {/* The categories, folding out like the
            Background panel's options band (2026-11-25): the ^ under the
            filter button, a level down (content in the toolbar group),
            height gliding 200ms. Folded, only the group's line under the
            row is left. */}
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${filtersOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="bg-content px-3 py-3">
              <div className="flex flex-wrap gap-2">
              {builtins.map(cat => {
                // A search shows instead: no category marked meanwhile.
                const selected = !searchWords && cat.id === category
                // Framed like BUTTON; picked: the accent fill (the selected
                // segment's purple), which doesn't change under the pointer.
                const look = selected
                  ? 'bg-accent border-accent text-on-accent'
                  : 'bg-elevated border-line text-fg-secondary hover:bg-elevated-hover hover:text-fg'
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => showCategory(cat)}
                    aria-pressed={selected}
                    // Icon and name (icon-only with the name as tooltip
                    // tried and dropped, 2026-11-25).
                    className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium whitespace-nowrap ${look}`}
                  >
                    <Icon name={cat.icon} className="text-[16px]" />
                    {cat.label}
                  </button>
                )
              })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The photos in their own scroll box (Jasper, 2026-11-25), so the
          section stays short: about two and a half rows show, the rest
          scrolls. The box carries the padding so its scroll bar sits at the
          group's edge. */}
      <div ref={scrollRef} className="max-h-[320px] overflow-y-auto rounded-b-lg p-3 flex flex-col gap-3">
        {/* A failed fetch keeps the last photos. Page 1: the message sits
            above them; a later page: at the end (below). */}
        {error && !error.more && <ErrorBox message={error.message} />}
        {loading === 'first' ? (
          // A real wait (the photo source): the dialogs' grey spinner.
          <div className="h-32 flex items-center justify-center gap-2 text-xs font-medium text-fg-secondary">
            <Icon name="progress_activity" className="text-[16px] animate-spin" />
            Loading photos…
          </div>
        ) : feed.photos.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              {feed.photos.map(photo => (
                <PhotoCard key={photo.id} photo={photo} onClick={() => setPreview(photo)} />
              ))}
            </div>
            {/* The next batch: the same spinner, a row at the end. */}
            {loading === 'more' && (
              <div className="py-2 flex items-center justify-center gap-2 text-xs font-medium text-fg-secondary">
                <Icon name="progress_activity" className="text-[16px] animate-spin" />
                Loading photos…
              </div>
            )}
            {/* A later page failed: where its spinner row was, so it shows
                where the user is scrolled to. No more batches load until a
                category, source or 4K change. */}
            {error?.more && <ErrorBox message={error.message} />}
            {/* The source has nothing more: say so, so the end doesn't
                look like a fault (Caption rank, like the empty state). */}
            {feed.done && !loading && !error && current && (
              <p className="py-2 text-center text-xs font-medium text-fg-secondary">That's all for {current.label}.</p>
            )}
            {/* Loads the next batch when it comes into view; -mt-3 takes
                back the column gap, so it adds no height. */}
            <div ref={sentinelRef} aria-hidden className="h-0 -mt-3 shrink-0" />
          </>
        ) : !error && (
          // The Dashboard's empty state: a bare 24px icon over a Caption line.
          <div className="h-32 flex flex-col items-center justify-center gap-2">
            <Icon name="image_search" className="text-[24px] text-fg-tertiary" />
            <p className="text-xs font-medium text-fg-secondary">No photos found</p>
          </div>
        )}
      </div>
    </Group>
    {preview && <PreviewDialog photo={preview} onClose={() => setPreview(null)} onApplied={() => setCanReset(true)} />}
    </>
  )
}

/** A failed fetch, drawn like an error toast (STYLEGUIDE › Dialogs). */
function ErrorBox({ message }: { message: string }) {
  return <MessageBox kind="error" message="Couldn't load photos" detail={message} />
}

/** The image's alt text: its title, else who made it, else the source. */
function altText(photo: WallpaperPhoto): string {
  if (photo.description) return photo.description
  if (photo.user.name) return `Photo by ${photo.user.name}`
  return `Wallpaper from ${sourceName(photo.source)}`
}

/** A photo in the Dashboard's grid-card look (page review 2026-11-25):
 *  toolbar card, an inset line edge that steps to line-strong under the
 *  pointer, a status bar with the author (Commons) or the size (Wallhaven,
 *  whose uploader would take one more request per card). No zoom, no fade. */
function PhotoCard({ photo, onClick }: { photo: WallpaperPhoto; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group relative isolate overflow-hidden rounded-lg bg-toolbar text-left outline-none">
      {/* The photo's own average colour while it loads, when the source sends one. */}
      <div className="aspect-[4/3] relative overflow-hidden bg-content" style={photo.color ? { backgroundColor: photo.color } : undefined}>
        <img
          src={photo.urls.small}
          alt={altText(photo)}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover select-none"
        />
        <div className="absolute inset-x-0 bottom-0 z-10 h-6 px-2 flex items-center border-t border-line bg-toolbar text-fg-secondary text-[10px] font-medium">
          {photo.source === 'wallhaven'
            ? <span className="min-w-0 truncate tabular-nums">{photo.width}×{photo.height}</span>
            : <span className="min-w-0 truncate">{photo.user.name}</span>}
        </div>
      </div>
      <div className="absolute inset-0 z-10 rounded-lg ring-1 ring-inset ring-line group-hover:ring-line-strong pointer-events-none" />
      <div className="absolute inset-0 z-30 hidden group-focus-visible:block rounded-lg ring-2 ring-inset ring-focus pointer-events-none" />
    </button>
  )
}

/** The photo, its credit and Set as wallpaper. Page review 2026-11-25: the
 *  dialog look (STYLEGUIDE › Dialogs): scrim, solid elevated box, p-3,
 *  Cancel + the accent main action at the bottom right, no X beside Cancel.
 *  Credit: Commons "Photo by … on Wikimedia Commons (licence)"; Wallhaven
 *  "Uploaded by … to Wallhaven (original)", the uploader asked for when the
 *  dialog opens. */
/** The preview's last screen pick (display ids). */
const SCREENS_KEY = 'lumia:wallpaper-screens'

function PreviewDialog({
  photo,
  onClose,
  onApplied,
}: {
  photo: WallpaperPhoto
  onClose: () => void
  onApplied: () => void
}) {
  const [applying, setApplying] = useState(false)
  // More than one screen: Set as wallpaper first asks which (the screen
  // picker, 2026-11-27); with one it sets straight away.
  const [screenCount, setScreenCount] = useState(1)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    void window.electronAPI?.wallpapersScreens?.().then(list => setScreenCount(list?.length ?? 1)).catch(() => {})
  }, [])
  // Wallhaven: the uploader and the original link, from a second request.
  // Null while it runs; `{}` when it failed: then "Uploaded to Wallhaven"
  // without a name (Jasper, 2026-11-25), like a deleted uploader.
  const [credit, setCredit] = useState<Partial<WallpaperPhoto> | null>(null)
  // The sharp image, once it has loaded; until then the small thumbnail
  // fills the same frame.
  const [sharpLoaded, setSharpLoaded] = useState(false)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  // The credit + buttons row's real height (one or two lines of credit, a
  // title or not), measured so the dialog always fits the window.
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(44)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRowH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => { setSharpLoaded(false) }, [photo])

  useEffect(() => {
    // Esc with the screen picker open closes only the picker.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !applying && !picking) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, applying, picking])

  useEffect(() => {
    if (photo.source !== 'wallhaven') return
    let cancelled = false
    setCredit(null)
    Promise.resolve(window.electronAPI?.wallpapersCredit(photo))
      .then(extra => { if (!cancelled) setCredit(extra ?? {}) })
      .catch(() => { if (!cancelled) setCredit({}) })
    return () => { cancelled = true }
  }, [photo])

  const handleApply = () => {
    if (applying) return
    if (screenCount > 1) setPicking(true)
    else void apply()
  }
  const apply = async (ids?: number[]) => {
    if (applying) return
    setPicking(false)
    setApplying(true)
    try {
      const result = await window.electronAPI?.wallpapersSetAsWallpaper(photo, ids)
      if (result?.ok) {
        onApplied()
        toast('Wallpaper set')
        onClose()
      } else {
        toastError("Couldn't set wallpaper", result?.error)
      }
    } catch (err) {
      toastError("Couldn't set wallpaper", err)
    } finally {
      setApplying(false)
    }
  }

  // Links that open a web page: the one place the hand cursor goes
  // (STYLEGUIDE › Tooltips and cursors). Hover moves the underline's colour.
  const LINK = 'text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg cursor-pointer'
  const open = (url: string) => window.electronAPI?.openExternal(url)
  const sourceLink = (
    <button className={LINK} onClick={() => open(photo.links.html)}>{sourceName(photo.source)}</button>
  )
  const uploader = credit?.user

  // The frame takes the photo's own ratio, scaled to fit (2026-11-25: an
  // image capped only by max-height kept its natural width as a flex item,
  // leaving bars beside the picture). Box: 12px padding + 1px border a side;
  // at most 1152px wide, 16px from the window's sides; the height below.
  const BOX_EDGE = 26
  const PREVIEW_MAX_H = 480
  // At most 480px high (Jasper, 2026-11-25: it filled the window).
  const scale = Math.min(
    (Math.min(1152, viewport.w - 32) - BOX_EDGE) / photo.width,
    // Fits the smallest window (900×600) and any other: 16px above and
    // below, the box's edge, its 12px gap and the measured row.
    Math.min(PREVIEW_MAX_H, viewport.h - 32 - BOX_EDGE - 12 - rowH) / photo.height,
  )
  const frameW = Math.max(1, Math.floor(photo.width * scale))
  const frameH = Math.max(1, Math.floor(photo.height * scale))
  // Sharp enough for the frame on a Retina screen: Wallhaven's only image
  // past its 432px thumbnail is the full file; Wikimedia's 1920px version.
  const sharpSrc = photo.source === 'wallhaven' ? photo.urls.full : photo.urls.regular

  return (
    <div
      className="fixed inset-0 z-[60] bg-scrim flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget && !applying) onClose() }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="wallpaper-title" style={{ width: frameW + BOX_EDGE }} className="rounded-lg bg-elevated border border-line p-3 flex flex-col gap-3">
        <div
          className="relative rounded-md overflow-hidden bg-content"
          style={{ width: frameW, height: frameH, ...(photo.color ? { backgroundColor: photo.color } : {}) }}
        >
          {/* The card's thumbnail straight away, then the sharp image on
              top once loaded (no fade: no motion in the UI). */}
          <img src={photo.urls.small} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover" />
          <img
            key={sharpSrc}
            src={sharpSrc}
            alt={altText(photo)}
            onLoad={() => setSharpLoaded(true)}
            className={`absolute inset-0 w-full h-full object-cover ${sharpLoaded ? '' : 'opacity-0'}`}
          />
        </div>
        <div ref={rowRef} className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-10">
          <div className="min-w-0 flex flex-col gap-2">
            {photo.description && (
              <h2 id="wallpaper-title" className="truncate text-sm font-semibold text-fg first-letter:uppercase">{photo.description}</h2>
            )}
            {/* Commons names the author and the photo's licence, which its
                free licences ask for; Wallhaven the uploader (none when the
                account is deleted) and the original, when it knows it. */}
            <p id={photo.description ? undefined : 'wallpaper-title'} className="text-xs text-fg-secondary">
              {photo.source === 'commons' ? (
                <>
                  Photo by{' '}
                  <button className={LINK} onClick={() => open(photo.user.link)}>{photo.user.name}</button>
                  {' '}on {sourceLink}
                  {photo.license && ` (${photo.license})`}
                </>
              ) : credit ? (
                <>
                  Uploaded
                  {uploader?.name && (
                    <>
                      {' '}by{' '}
                      <button className={LINK} onClick={() => open(uploader.link)}>{uploader.name}</button>
                    </>
                  )}
                  {' '}to {sourceLink}
                  {credit?.origin && (
                    <>
                      {' '}(<button className={LINK} onClick={() => open(credit.origin!)}>original</button>)
                    </>
                  )}
                </>
              ) : (
                <>On {sourceLink}</>
              )}
              , <span className="tabular-nums">{photo.width}×{photo.height}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button onClick={onClose} disabled={applying} className={BUTTON}>Cancel</button>
            <button onClick={handleApply} disabled={applying} className={ACCENT_BUTTON}>
              {applying && <Icon name="progress_activity" className="text-[16px] animate-spin" />}
              {applying ? 'Setting wallpaper…' : 'Set as wallpaper'}
            </button>
          </div>
        </div>
        </div>
      </div>
      {picking && <ScreenPickerDialog onCancel={() => setPicking(false)} onPick={ids => void apply(ids)} />}
    </div>
  )
}

/** Which screens the wallpaper goes on (2026-11-27), after Set as wallpaper
 *  with more than one screen: a card per screen with a picture of what's on
 *  it now, so it's clear which is which. Drawn like the Browser picker
 *  (STYLEGUIDE › Dialogs; cards with an inset edge, the accent selection
 *  ring when picked). All picked to start with, the last pick remembered;
 *  Set is off with none. Esc / Cancel go back to the preview. */
function ScreenPickerDialog({ onCancel, onPick }: { onCancel: () => void; onPick: (ids: number[]) => void }) {
  const [screens, setScreens] = useState<{ id: number; label: string; width: number; height: number; preview?: string }[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  useEffect(() => {
    let alive = true
    void window.electronAPI?.wallpapersScreens?.(true).then(list => {
      if (!alive) return
      if (!list) { setScreens([]); return }
      setScreens(list)
      let saved: number[] = []
      try { saved = JSON.parse(localStorage.getItem(SCREENS_KEY) ?? '[]') } catch { /* none */ }
      const known = saved.filter(id => list.some(s => s.id === id))
      setPicked(new Set(known.length ? known : list.map(s => s.id)))
    }).catch(() => { if (alive) setScreens([]) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const toggle = (id: number) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const confirm = () => {
    const ids = [...picked]
    try { localStorage.setItem(SCREENS_KEY, JSON.stringify(ids)) } catch { /* not kept */ }
    onPick(ids)
  }
  return (
    <div className="fixed inset-0 z-[70] bg-scrim flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="screen-picker-title" className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg bg-elevated border border-line p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="screen-picker-title" className="text-sm font-semibold text-fg">Choose screens</h2>
          <p className="text-xs text-fg-secondary">Pick the screens to set the wallpaper on.</p>
        </div>
        {/* A real wait (a picture of each screen): blank, it's quick. */}
        {screens === null ? <div className="h-40" /> : (
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(screens.length, 1), 3)}, minmax(0, 1fr))` }}>
            {screens.map(s => {
              const on = picked.has(s.id)
              return (
                <button key={s.id} type="button" onClick={() => toggle(s.id)} aria-pressed={on} className="group relative text-left rounded-lg overflow-hidden bg-toolbar">
                  <div className="bg-content relative overflow-hidden" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
                    {s.preview
                      ? <img src={s.preview} className="w-full h-full object-cover select-none" />
                      : <div className="w-full h-full flex items-center justify-center"><Icon name="monitor" className="text-[24px] text-fg-tertiary" /></div>}
                  </div>
                  <div className="px-2.5 py-2 border-t border-line">
                    <p className="text-[11px] font-semibold text-fg truncate">{s.label}</p>
                  </div>
                  <div className={`absolute inset-0 rounded-lg pointer-events-none ${on ? 'ring-(length:--selection-ring) ring-inset ring-accent' : 'ring-1 ring-inset ring-line group-hover:ring-line-strong'}`} />
                </button>
              )
            })}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className={BUTTON}>Cancel</button>
          <button onClick={confirm} disabled={picked.size === 0} className={ACCENT_BUTTON}>Set as wallpaper</button>
        </div>
      </div>
    </div>
  )
}
