import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StickerManifest, StickerCategory, StickerEntry } from '../types'

import { Icon } from './Icon'
import { Segmented } from './Segmented'
import { ICON_BUTTON } from './button-classes'
import { OnStrip } from './OnStrip'
import { MessageBox } from './MessageBox'
export interface PickedSticker {
  path: string
  dataUrl: string
  natural: { w: number; h: number }
}

interface Props {
  onSelect: (s: PickedSticker) => void
  /** A press on a sticker moved past the drag slop (2026-11-26): the Editor
   *  takes over the drag (the ghost, the drop) and closes the panel once
   *  the pointer leaves it. */
  onDragOut: (s: PickedSticker, clientX: number, clientY: number) => void
  onClose: () => void
  /** Pinned, like History: docked full height, a press outside or Esc
   *  doesn't close it, and it opens with the editor. */
  pinned: boolean
  onPin: (pinned: boolean) => void
  /** Focus the search when it opens (opened by the user, 2026-11-26). */
  focusSearch?: boolean
}

/** The sidebar's width, History's (2026-11-26): the Editor makes room for
 *  it when it's pinned. */
export const STICKER_PANEL_W = 200

// Two stickers across (2026-11-26; three before, too small in the 200px
// sidebar), sharing the width (so a classic Windows scroll bar shrinks them
// a little instead of overflowing).
const COLS = 2

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

/** How far a press moves before it's a drag, not a click (px). */
const DRAG_SLOP = 4

/** The manifest's names are lower case ("love"); tooltips are sentence case. */
function stickerLabel(s: StickerEntry): string {
  return s.name.charAt(0).toUpperCase() + s.name.slice(1)
}

/** Loads a sticker (or tab icon) through the main-process cache and renders it
 *  as an <img>. Reports the natural size on load so the Editor can place the
 *  sticker with the right aspect ratio. */
function RemoteSticker({
  path, className, onReady,
}: {
  path: string
  className?: string
  onReady?: (dataUrl: string, natural: { w: number; h: number }) => void
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
      <div className={`flex items-center justify-center text-fg-tertiary ${className ?? ''}`}>
        <Icon name="broken_image" className="text-[20px]" />
      </div>
    )
  }
  // Cached stickers load in a few ms: a blank cell while they do, no grey
  // placeholder flashing (STYLEGUIDE › Motion, 2026-11-26).
  if (!dataUrl) return <div className={className} />
  return (
    <img
      src={dataUrl}
      alt=""
      draggable={false}
      onLoad={e => onReady?.(dataUrl, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      className={`object-contain ${className ?? ''}`}
    />
  )
}

/** Click-and-drag horizontal scrolling for an overflow-x row. A plain click
 *  still selects a tab; only a drag past a few px scrolls the row and then
 *  swallows the trailing click so it doesn't fire on whatever tab the pointer
 *  happened to land on. `dragging` shows the closed hand while it scrolls.
 *  A mouse wheel's up / down scrolls it sideways too (2026-11-26); sideways
 *  trackpad swipes scroll it as they always did. */
function useDragScroll() {
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef({ down: false, startX: 0, startScroll: 0, moved: false })
  const [dragging, setDragging] = useState(false)
  // The row mounts once the sticker list is in, so the wheel listener goes
  // on through a callback ref (a non-passive one, to stop the page scroll).
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const setRef = useCallback((node: HTMLDivElement | null) => { ref.current = node; setEl(node) }, [])
  useEffect(() => {
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el])

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
      setDragging(true)
      try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    if (d.moved) el.scrollLeft = d.startScroll - dx
  }
  const end = () => { drag.current.down = false; setDragging(false) }
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) { e.stopPropagation(); drag.current.moved = false }
  }
  return {
    ref: setRef,
    dragging,
    props: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onClickCapture },
  }
}

/** The sticker sidebar (2026-11-26; a callout over the toolbar before):
 *  the History panel mirrored, at the canvas's left. Floating, from 20px
 *  under the AppBar to 7px above the toolbar; pinned, docked down to the
 *  toolbar's bottom edge (the toolbar's left edge makes room). Same frame,
 *  width, header, list spacing, row hover and pin as History. */
export default function StickerPicker({ onSelect, onDragOut, onClose, pinned, onPin, focusSearch = false }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Opened by the user: ready to type (on open only).
  useEffect(() => { if (focusSearch) searchRef.current?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
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

  // A press outside or Esc closes it, unless pinned (History's useDismiss).
  useEffect(() => {
    if (pinned) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      // A press on the Sticker button is left to its click, which toggles
      // the panel (closing here first would reopen it).
      if (panelRef.current?.contains(t) || t.closest?.('[data-sticker-button]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, pinned])

  // Dragging a sticker out (2026-11-26; native drag and drop before, which
  // didn't place it): a press on a sticker that moves past DRAG_SLOP hands
  // the drag to the Editor, which closes the panel, draws the ghost and
  // places the sticker where it's let go. A press that doesn't move is a
  // click (place in the middle). A sticker still loading can't be dragged.
  const pressRef = useRef<{ path: string; x: number; y: number } | null>(null)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pressRef.current
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) <= DRAG_SLOP) return
      pressRef.current = null
      const info = loadedRef.current.get(p.path)
      if (!info) return
      onDragOut({ path: p.path, dataUrl: info.dataUrl, natural: info.natural }, e.clientX, e.clientY)
    }
    const onUp = () => { pressRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [onDragOut])

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
      // data-sticker-panel: a drag out of the floating panel closes it once
      // the pointer leaves this box (Editor, handleStickerDragOut).
      data-sticker-panel=""
      style={{ '--pad': '10px', width: STICKER_PANEL_W } as React.CSSProperties}
      role="dialog"
      aria-label="Stickers"
      // History's classes, left for right (see HistoryPanel): floating
      // ends 7px above the 52px toolbar, pinned grows down to its bottom
      // edge; top and bottom glide 200ms.
      className={`absolute z-30 flex flex-col bg-toolbar overflow-hidden left-(--mx) rounded-lg ring-1 ring-inset ring-line transition-[top,bottom] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
        !pinned ? 'top-(--my) bottom-[calc(var(--my)+59px)]' : 'top-(--my) bottom-(--my)'
      }`}
    >
      {/* History's header mirrored: the search where its tabs are, the pin
          at the right, both --pad in. No autofocus: a pinned panel opens
          with the editor and would take the tool keys. */}
      <div className="flex items-center gap-3 h-12 pl-(--pad) pr-(--pad) flex-shrink-0 border-b border-line">
        {/* The field (2026-11-26): Settings › Wallpapers' search box, a
            32px framed field (elevated, line edge, accent edge while
            typing), the icon 7px in and 7px before the text. */}
        <div className="flex-1 min-w-0 h-8 flex items-center gap-[7px] pl-[7px] pr-1.5 rounded-lg border border-line bg-elevated focus-within:border-accent">
          <Icon name="search" className="text-[16px] text-fg-secondary flex-shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search stickers"
            className="flex-1 min-w-0 h-full bg-transparent outline-none text-xs font-medium text-fg placeholder:text-fg-tertiary"
          />
          {/* Clear (2026-11-26): Wallpapers' × at the field's end, shown
              while there's text; the field keeps focus. */}
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); searchRef.current?.focus() }}
              data-tip="Clear"
              aria-label="Clear search"
              className="w-5 h-5 flex-shrink-0 inline-flex items-center justify-center text-fg-secondary hover:text-fg"
            >
              <Icon name="close" className="text-[14px]" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onPin(!pinned)}
          aria-pressed={pinned}
          // The History panel's Pin: framed, the on-state strip while pinned.
          className={`${ICON_BUTTON} group/on relative`}
          data-tip={pinned ? 'Unpin' : 'Pin'}
          aria-label={pinned ? 'Unpin stickers' : 'Pin stickers to the side'}
        >
          <Icon name="pin" className="text-[16px]" />
          {pinned && <OnStrip />}
        </button>
      </div>

      {/* Body: History's list spacing (8px in, 4px gaps), filling the
          height. Loading, empty and error states as in Settings ›
          Wallpapers. */}
      {error ? (
        <div className="flex-1 p-2">
          <MessageBox kind="error" message="Couldn't load stickers" detail={error} />
        </div>
      ) : !manifest ? (
        // A real wait (the sticker list comes over the network).
        <div className="flex-1 flex items-center justify-center gap-2 text-xs font-medium text-fg-secondary">
          <Icon name="progress_activity" className="text-[16px] animate-spin" />
          Loading stickers…
        </div>
      ) : (
        <div className="flex-1 w-0 min-w-full overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2">
              <Icon name={query ? 'search_off' : 'sentiment_dissatisfied'} className="text-[24px] text-fg-tertiary" />
              <p className="text-xs font-medium text-fg-secondary">{query ? 'No stickers found' : 'Nothing here yet'}</p>
            </div>
          ) : (
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
              {visible.map(s => (
                // A button, so stickers are Tab stops (Enter / Space place
                // one); the arrow cursor like every control.
                <button
                  key={s.id}
                  type="button"
                  data-tip={stickerLabel(s)}
                  aria-label={stickerLabel(s)}
                  onClick={() => handlePick(s)}
                  // Drag onto the image to place it there (see pressRef).
                  onPointerDown={e => { if (e.button === 0) pressRef.current = { path: s.path, x: e.clientX, y: e.clientY } }}
                  className="aspect-square rounded-lg border border-transparent hover-overlay p-1 flex items-center justify-center"
                >
                  <RemoteSticker
                    path={s.path}
                    className="w-full h-full"
                    onReady={(dataUrl, natural) => loadedRef.current.set(s.path, { dataUrl, natural })}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Category tabs. Drag sideways to scroll them: the open hand on the
          row (the segments keep the arrow), closed while it scrolls. */}
      {manifest && !error && (
        <div
          ref={tabsDrag.ref}
          {...tabsDrag.props}
          className={`flex items-center h-12 px-2.5 border-t border-line flex-shrink-0 overflow-x-auto select-none [scrollbar-width:none] ${tabsDrag.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        >
          {/* Categories: the standard single select (2026-11-23), scrolling
              sideways inside this row when there are many; a search
              selects none. */}
          <div className="flex-shrink-0">
          <Segmented<string>
            value={query ? '' : activeId}
            onChange={id => { setQuery(''); setActiveId(id) }}
            options={[
              ...(recents.length > 0 ? [{ key: RECENT_ID, icon: 'schedule', title: 'Recent' }] : []),
              ...categories.map((c: StickerCategory) => ({
                key: c.id,
                title: c.name,
                content: <RemoteSticker path={c.icon} className="w-5 h-5 pointer-events-none" />,
              })),
            ]}
          />
          </div>
        </div>
      )}
    </div>
  )
}

