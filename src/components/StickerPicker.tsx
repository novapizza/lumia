import { useEffect, useMemo, useRef, useState } from 'react'
import type { StickerManifest, StickerCategory, StickerEntry } from '../types'

export interface PickedSticker {
  path: string
  dataUrl: string
  natural: { w: number; h: number }
}

interface Props {
  onSelect: (s: PickedSticker) => void
  onClose: () => void
}

const RECENTS_KEY = 'lumia.sticker.recents'
const RECENTS_MAX = 16

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function pushRecentSticker(path: string): void {
  try {
    const next = [path, ...loadRecents().filter(p => p !== path)].slice(0, RECENTS_MAX)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch { /* ignore quota / parse errors */ }
}

/** Loads a sticker (or tab icon) through the main-process cache and renders it
 *  as an <img>. Reports the natural size on load so the Editor can place the
 *  sticker with the right aspect ratio. */
function RemoteSticker({
  path, className, onReady, onPick, title,
}: {
  path: string
  className?: string
  onReady?: (dataUrl: string, natural: { w: number; h: number }) => void
  onPick?: () => void
  title?: string
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    window.electronAPI.stickersFetch(path)
      .then(r => { if (alive) { if (r.ok) setDataUrl(r.dataUrl); else setFailed(true) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [path])

  if (failed) {
    return (
      <div className={`flex items-center justify-center text-slate-600 ${className ?? ''}`} title="Failed to load">
        <span className="material-symbols-outlined text-[18px]">broken_image</span>
      </div>
    )
  }
  if (!dataUrl) {
    return <div className={`animate-pulse bg-white/5 rounded-lg ${className ?? ''}`} />
  }
  return (
    <img
      src={dataUrl}
      title={title}
      draggable={false}
      onClick={onPick}
      onLoad={e => onReady?.(dataUrl, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      className={`object-contain ${onPick ? 'cursor-pointer' : ''} ${className ?? ''}`}
    />
  )
}

/** Click-and-drag horizontal scrolling for an overflow-x row. A plain click
 *  still selects a tab; only a drag past a few px scrolls the row and then
 *  swallows the trailing click so it doesn't fire on whatever tab the pointer
 *  happened to land on. */
function useDragScroll() {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef({ down: false, startX: 0, startScroll: 0, moved: false })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    drag.current = { down: true, startX: e.clientX, startScroll: el.scrollLeft, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    const d = drag.current
    if (!el || !d.down) return
    const dx = e.clientX - d.startX
    // Grab the pointer only once we're sure it's a drag (past the 4px slop) so
    // a steady click still reaches the tab button underneath.
    if (!d.moved && Math.abs(dx) > 4) {
      d.moved = true
      try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    if (d.moved) el.scrollLeft = d.startScroll - dx
  }
  const end = () => { drag.current.down = false }
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) { e.stopPropagation(); drag.current.moved = false }
  }
  return {
    ref,
    props: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onClickCapture },
  }
}

export default function StickerPicker({ onSelect, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [manifest, setManifest] = useState<StickerManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string>('')
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>(() => loadRecents())
  const tabsDrag = useDragScroll()
  // Data URL + natural size captured as each thumbnail loads, so a pick has
  // everything ready without a second fetch.
  const loadedRef = useRef<Map<string, { dataUrl: string; natural: { w: number; h: number } }>>(new Map())

  useEffect(() => {
    let alive = true
    window.electronAPI.stickersManifest()
      .then(r => {
        if (!alive) return
        if (r.ok) {
          setManifest(r.manifest)
          setActiveId(r.manifest.categories[0]?.id ?? '')
        } else {
          setError(r.error)
        }
      })
      .catch(e => { if (alive) setError(e?.message ?? 'Failed to load stickers') })
    return () => { alive = false }
  }, [])

  // Outside-click / Escape to close.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const categories = manifest?.categories ?? []
  const allStickers = useMemo(
    () => categories.flatMap(c => c.stickers),
    [categories],
  )
  const stickerByPath = useMemo(() => {
    const m = new Map<string, StickerEntry>()
    for (const s of allStickers) m.set(s.path, s)
    return m
  }, [allStickers])

  // What to show: search across everything, else the active category (with a
  // synthetic "Recent" category pinned first when there's history).
  const RECENT_ID = '__recent__'
  const visible: StickerEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      return allStickers.filter(s => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    }
    if (activeId === RECENT_ID) {
      return recents.map(p => stickerByPath.get(p)).filter((s): s is StickerEntry => !!s)
    }
    return categories.find(c => c.id === activeId)?.stickers ?? []
  }, [query, activeId, categories, allStickers, recents, stickerByPath])

  const handlePick = (s: StickerEntry) => {
    const info = loadedRef.current.get(s.path)
    // Clicked before the thumbnail finished loading (rare) — fetch on demand.
    if (!info) {
      window.electronAPI.stickersFetch(s.path).then(r => {
        if (r.ok) { pushRecentSticker(s.path); setRecents(loadRecents()); onSelect({ path: s.path, dataUrl: r.dataUrl, natural: { w: 256, h: 256 } }) }
      })
      return
    }
    pushRecentSticker(s.path)
    setRecents(loadRecents())
    onSelect({ path: s.path, dataUrl: info.dataUrl, natural: info.natural })
  }

  return (
    <div
      ref={panelRef}
      className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[70] w-[360px] max-h-[440px] flex flex-col liquid-glass rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
      style={{ backdropFilter: 'blur(20px)' }}
    >
      {/* Search */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/5 flex-shrink-0">
        <span className="material-symbols-outlined text-[18px] text-slate-500">search</span>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search stickers"
          className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-slate-500"
        />
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors" title="Close">
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      {/* Body */}
      {error ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center px-6">
          <span className="material-symbols-outlined text-2xl text-slate-600">cloud_off</span>
          <p className="text-xs text-slate-500">Couldn’t load stickers.<br />{error}</p>
        </div>
      ) : !manifest ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-slate-600">
              <span className="material-symbols-outlined text-2xl">
                {query ? 'search_off' : 'sentiment_dissatisfied'}
              </span>
              <p className="text-xs">{query ? 'No matches' : 'Nothing here yet'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5">
              {visible.map(s => (
                <div
                  key={s.id}
                  className="aspect-square rounded-xl hover:bg-white/10 transition-colors p-1.5 flex items-center justify-center"
                >
                  <RemoteSticker
                    path={s.path}
                    title={s.name}
                    className="w-full h-full"
                    onReady={(dataUrl, natural) => loadedRef.current.set(s.path, { dataUrl, natural })}
                    onPick={() => handlePick(s)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Category tabs */}
      {manifest && !error && (
        <div
          ref={tabsDrag.ref}
          {...tabsDrag.props}
          className="flex items-center gap-1 px-2 py-2 border-t border-white/5 flex-shrink-0 overflow-x-auto cursor-grab active:cursor-grabbing select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {recents.length > 0 && (
            <TabButton active={activeId === RECENT_ID && !query} onClick={() => { setQuery(''); setActiveId(RECENT_ID) }} title="Recent">
              <span className="material-symbols-outlined text-[20px]">schedule</span>
            </TabButton>
          )}
          {categories.map((c: StickerCategory) => (
            <TabButton key={c.id} active={activeId === c.id && !query} onClick={() => { setQuery(''); setActiveId(c.id) }} title={c.name}>
              <RemoteSticker path={c.icon} className="w-6 h-6" />
            </TabButton>
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
        active ? 'bg-primary/20 text-primary' : 'text-slate-400 hover:text-white hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}
