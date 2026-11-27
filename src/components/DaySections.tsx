import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DayStat, HistoryItem } from '../types'
import { dayLabel, estimateDayHeight, placeholderHeight, pickAnchorClip, placeDelta, type MeasuredDay, type PlaceAnchor } from '../utils/dayHistory'
import { keepPlace, takePlace, takeOpenedClip } from '../lib/dashboard-place'

type Filter = 'all' | 'screenshot' | 'recording'

interface DaySectionsProps {
  /** Days with captures for the filter, newest first (from the stats). */
  days: DayStat[]
  /** Loaded days only. */
  rows: Map<string, HistoryItem[]>
  filter: Filter
  view: 'grid' | 'list'
  /** Classes for the scrolling container this component renders (it owns
   *  the container so its observers can use it as their root on mount). */
  className: string
  renderItem: (item: HistoryItem) => ReactNode
  gridClassName: string
  loadDays: (days: string[]) => void
  dropDays: (days: string[]) => void
  /** Days holding selected rows: never dropped. */
  pinnedDays: Set<string>
  emptyState: ReactNode
  /** Set in select mode: clicking a day's label hands over that day's
   *  (filtered, loaded) captures so the Dashboard can select them all. */
  onDayClick?: (items: HistoryItem[]) => void
  /** Selected rows, so a day's label can say Deselect when all of its
   *  captures are selected (a second click then deselects them). */
  selectedIds?: Set<string>
}

// Layout numbers for estimating a day's height before it loads. They match
// the grid (auto-fill minmax(220px, 1fr), gap-3) and list (gap-1) classes
// the Dashboard passes, and the section header + bottom padding below.
const HEADER_HEIGHT = 26 + 8 // header row (boxed day: 16px line + py-1 + border) + mb-0.5 + the items' pt-1.5
const SECTION_GAP = 32 // pb-8 on the day's items
const GRID_MIN = 220
const GRID_GAP = 12
const LIST_ROW = 52 // HistoryListRow h-[52px] (2026-11-23; was 50)
const LIST_GAP = 4

// The floating day label's box (see the header below).
const DAY_BOX = 'px-2.5 py-1 rounded-md bg-toolbar border border-line light-lift-xs' // edge line (line-subtle until 2026-11-21) // the toolbar's fill, solid so the clips don't show through

/** The current date, re-rendering the caller when the local day changes
 *  (so "Today" becomes "Yesterday" at midnight with the app open). A timer
 *  aims at the next midnight; window focus re-checks too, because a timer
 *  that spans system sleep fires late. */
function useToday(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const dayKey = (d: Date) => d.toDateString()
    let timer: ReturnType<typeof setTimeout>
    const check = () => setNow(prev => (dayKey(prev) === dayKey(new Date()) ? prev : new Date()))
    const schedule = () => {
      const t = new Date()
      const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
      timer = setTimeout(() => { check(); schedule() }, next.getTime() - t.getTime() + 1000)
    }
    schedule()
    window.addEventListener('focus', check)
    return () => { clearTimeout(timer); window.removeEventListener('focus', check) }
  }, [])
  return now
}

type ViewAnchor =
  | { kind: 'top' }
  | { kind: 'clip'; id: string; day: string; centre: number; fraction: number }
  | { kind: 'day'; day: string; fraction: number }

/** What's in the middle of the scroll area, to find again after a grid /
 *  list switch (see DaySections). */
function findViewAnchor(root: HTMLElement): ViewAnchor | null {
  if (root.scrollTop <= 0) return { kind: 'top' }
  const box = root.getBoundingClientRect()
  const midY = box.top + root.clientHeight / 2
  const midX = box.left + root.clientWidth / 2
  // The day across the middle line, and how far into it the line is.
  let day: string | undefined
  let fraction = 0
  for (const s of root.querySelectorAll<HTMLElement>('section[data-day]')) {
    const r = s.getBoundingClientRect()
    if (r.bottom <= midY) continue
    day = s.dataset.day!
    fraction = r.height > 0 ? Math.max(0, midY - r.top) / r.height : 0
    break
  }
  if (!day) return null
  // The clip closest to the middle of the area: by height first, then (in
  // the grid, where a row holds several) by how near the centre column.
  let best: { el: HTMLElement; dy: number; dx: number; cy: number } | null = null
  for (const el of root.querySelectorAll<HTMLElement>('[data-clip][data-id]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom < box.top || r.top > box.bottom) continue
    const cy = (r.top + r.bottom) / 2
    const dy = Math.abs(cy - midY)
    const dx = Math.abs((r.left + r.right) / 2 - midX)
    if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) best = { el, dy, dx, cy }
  }
  if (best) return { kind: 'clip', id: best.el.dataset.id!, day, centre: best.cy - box.top, fraction }
  return { kind: 'day', day, fraction }
}

/** Where the scroll area is, to come back to after the editor or Settings
 *  (PlaceAnchor): by the clip just opened if it shows, else the clip nearest
 *  the middle, else the day across the middle line. */
function readPlaceAnchor(root: HTMLElement, opened: string | null): PlaceAnchor | null {
  if (root.scrollTop <= 0) return { top: true }
  const box = root.getBoundingClientRect()
  if (box.height <= 0) return null
  const els = new Map<string, HTMLElement>()
  const clips = [...root.querySelectorAll<HTMLElement>('[data-clip][data-id]')].map((el) => {
    const r = el.getBoundingClientRect()
    els.set(el.dataset.id!, el)
    return { id: el.dataset.id!, top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  })
  const clip = pickAnchorClip(clips, box, opened)
  if (clip) {
    const section = els.get(clip.id)?.closest<HTMLElement>('section[data-day]')
    if (section) {
      const s = section.getBoundingClientRect()
      const centre = (clip.top + clip.bottom) / 2
      return { id: clip.id, day: section.dataset.day!, offset: centre - box.top, dayFraction: s.height > 0 ? (centre - s.top) / s.height : 0 }
    }
  }
  // No clip in view (days not loaded there): the day across the middle line.
  const midY = box.top + root.clientHeight / 2
  for (const s of root.querySelectorAll<HTMLElement>('section[data-day]')) {
    const r = s.getBoundingClientRect()
    if (r.bottom <= midY) continue
    return { day: s.dataset.day!, offset: root.clientHeight / 2, dayFraction: r.height > 0 ? Math.max(0, midY - r.top) / r.height : 0 }
  }
  return null
}

/** While the place is being put back, later arrivals (the reloaded days)
 *  may still move things: it's held this long, or until the user scrolls,
 *  clicks or presses a key. */
const PLACE_HOLD_MS = 1500

/** Load a day when its section is within one screen of the viewport, drop it
 *  when it is more than three screens away. */
const LOAD_SCREENS = 1
const DROP_SCREENS = 3

/**
 * One section per day. A day that isn't loaded is an empty block (its
 * measured height if it was loaded before, else an estimate), so the scroll
 * position never jumps; it loads when it comes near the viewport and is
 * dropped from memory again when it is far away.
 */
export function DaySections({
  days, rows, filter, view, className, renderItem, gridClassName, loadDays, dropDays, pinnedDays, emptyState, onDayClick, selectedIds,
}: DaySectionsProps) {
  const scrollRoot = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState(0)
  // Height of a day when it was dropped, keyed by filter + view + day and
  // kept with the count and width it was measured at (placeholderHeight).
  // The place this Dashboard's predecessor left (2026-11-27), for this
  // filter and view; and the day heights it had measured.
  const [keptPlace] = useState(() => takePlace(`${filter}|${view}`))
  const measured = useRef(new Map<string, MeasuredDay>(keptPlace?.measured ?? []))
  const sections = useRef(new Map<string, Element>())
  const nearObs = useRef<IntersectionObserver | null>(null)
  const farObs = useRef<IntersectionObserver | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const pinnedRef = useRef(pinnedDays)
  pinnedRef.current = pinnedDays
  const countOf = (stat: DayStat) => (filter === 'all' ? stat.total : stat[filter])
  const keyOf = (day: string) => `${filter}|${view}|${day}`
  // Latest render values for the observer callbacks.
  const ctx = useRef({ keyOf, width: 0, counts: new Map<string, number>() })

  useLayoutEffect(() => {
    const root = scrollRoot.current
    if (!root) return
    // Content width: clientWidth minus the scroll area's side padding.
    const contentWidth = () => {
      const cs = getComputedStyle(root)
      return root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    }
    const ro = new ResizeObserver(() => {
      setWidth(contentWidth())
      setViewport(root.clientHeight)
    })
    ro.observe(root)
    setWidth(contentWidth())
    setViewport(root.clientHeight)
    return () => ro.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    const root = scrollRoot.current
    if (!root || viewport === 0) return
    const near = new IntersectionObserver(entries => {
      const want = entries
        .filter(e => e.isIntersecting)
        .map(e => (e.target as HTMLElement).dataset.day!)
        .filter(d => !rowsRef.current.has(d))
      if (want.length) loadDays(want)
    }, { root, rootMargin: `${viewport * LOAD_SCREENS}px 0px` })
    const far = new IntersectionObserver(entries => {
      const drop: string[] = []
      for (const e of entries) {
        if (e.isIntersecting) continue
        const d = (e.target as HTMLElement).dataset.day!
        if (!rowsRef.current.has(d) || pinnedRef.current.has(d)) continue
        const c = ctx.current
        measured.current.set(c.keyOf(d), { height: e.boundingClientRect.height, count: c.counts.get(d) ?? 0, width: c.width })
        drop.push(d)
      }
      if (drop.length) dropDays(drop)
    }, { root, rootMargin: `${viewport * DROP_SCREENS}px 0px` })
    for (const el of sections.current.values()) { near.observe(el); far.observe(el) }
    nearObs.current = near
    farObs.current = far
    return () => { near.disconnect(); far.disconnect(); nearObs.current = null; farObs.current = null }
  }, [scrollRoot, viewport, loadDays, dropDays])

  // Back where it was after the editor or Settings (2026-11-27; it came
  // back at the top). The anchor clip (the one that was opened, else the
  // one nearest the middle) is put back at its old height in a layout
  // effect, so the first painted frame is already in place: the days are
  // there from the start (useDayHistory starts from what it held). Applied
  // again while reloaded days arrive, then let go. If the clip is gone
  // (deleted meanwhile) its day stands in.
  const placeKey = useRef('')
  placeKey.current = `${filter}|${view}`
  const restoring = useRef<PlaceAnchor | null>(keptPlace && !('top' in keptPlace.anchor) ? keptPlace.anchor : null)
  useLayoutEffect(() => {
    const root = scrollRoot.current
    if (!root) return
    // The DOM is still whole and scrolled when a layout effect is cleaned up.
    return () => {
      const anchor = readPlaceAnchor(root, takeOpenedClip())
      if (anchor) keepPlace({ key: placeKey.current, anchor, measured: [...measured.current] })
    }
  }, [])
  useLayoutEffect(() => {
    const root = scrollRoot.current
    const anchor = restoring.current
    if (!root || !anchor || 'top' in anchor || width <= 0 || days.length === 0) return
    const clip = anchor.id ? root.querySelector<HTMLElement>(`[data-clip][data-id="${CSS.escape(anchor.id)}"]`) : null
    const delta = placeDelta(anchor, root.getBoundingClientRect().top, clip?.getBoundingClientRect(), sections.current.get(anchor.day)?.getBoundingClientRect())
    if (delta !== null && Math.abs(delta) >= 0.5) root.scrollTop += delta
  }, [width, days, rows, view])
  useEffect(() => {
    if (!restoring.current) return
    const events = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    const letGo = () => {
      restoring.current = null
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, letGo, true)
    }
    const timer = setTimeout(letGo, PLACE_HOLD_MS)
    for (const e of events) window.addEventListener(e, letGo, { capture: true, passive: true })
    return letGo
  }, [])

  // One stable ref callback per day, so a re-render doesn't unobserve and
  // re-observe every section (which would re-fire both observers).
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const sectionRef = useCallback((day: string) => {
    let cb = refCallbacks.current.get(day)
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const prev = sections.current.get(day)
        if (prev) {
          nearObs.current?.unobserve(prev)
          farObs.current?.unobserve(prev)
          sections.current.delete(day)
        }
        if (el) {
          sections.current.set(day, el)
          nearObs.current?.observe(el)
          farObs.current?.observe(el)
        } else {
          refCallbacks.current.delete(day)
        }
      }
      refCallbacks.current.set(day, cb)
    }
    return cb
  }, [])

  // Same place across a grid / list switch (2026-11-21): before the
  // switch renders, note the clip closest to the middle of the scroll area
  // and where its centre sits; after the switch, scroll so the same clip's
  // card or row is centred at the same height. When no clip is in view
  // (only unloaded days there), the day across the middle line and how far
  // into it the line is, as a fraction of its height. At the very top it
  // stays at the top. Read in render, from the DOM the
  // old view still shows (a layout effect would see the new one).
  const lastView = useRef(view)
  const viewAnchor = useRef<ViewAnchor | null>(null)
  if (view !== lastView.current) {
    lastView.current = view
    viewAnchor.current = scrollRoot.current ? findViewAnchor(scrollRoot.current) : null
  }
  useLayoutEffect(() => {
    const root = scrollRoot.current
    const anchor = viewAnchor.current
    viewAnchor.current = null
    if (!root || !anchor) return
    const rootTop = root.getBoundingClientRect().top
    if (anchor.kind === 'top') { root.scrollTop = 0; return }
    if (anchor.kind === 'clip') {
      const el = root.querySelector<HTMLElement>(`[data-clip][data-id="${CSS.escape(anchor.id)}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        root.scrollTop += (r.top + r.bottom) / 2 - rootTop - anchor.centre
        return
      }
    }
    const section = sections.current.get(anchor.day)
    if (!section) return
    const r = section.getBoundingClientRect()
    root.scrollTop += r.top + r.height * anchor.fraction - (rootTop + root.clientHeight / 2)
  }, [view])

  const columns = view === 'grid' ? Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN + GRID_GAP))) : 1
  ctx.current = { keyOf, width, counts: new Map(days.map(d => [d.day, countOf(d)])) }

  const estimate = (count: number) => {
    if (view === 'list') return estimateDayHeight(count, 1, LIST_ROW, LIST_GAP, HEADER_HEIGHT) + SECTION_GAP
    const cardWidth = (width - GRID_GAP * (columns - 1)) / columns
    const rowHeight = (cardWidth * 3) / 4 // 4:3 thumbnail cards, no info bar
    return estimateDayHeight(count, columns, rowHeight, GRID_GAP, HEADER_HEIGHT) + SECTION_GAP
  }

  const now = useToday()
  return (
    // Out of the Tab order (tabIndex -1): Chromium would make a scroller a
    // Tab stop of its own. The Dashboard scrolls it with the arrow keys
    // without focus (data-scroll-area marks it for that).
    <div ref={scrollRoot} className={className} tabIndex={-1} data-scroll-area>
      {days.length === 0 && emptyState}
      {days.map(stat => {
        const count = countOf(stat)
        const loaded = rows.get(stat.day)
        const items = loaded && (filter === 'all' ? loaded : loaded.filter(i => i.type === filter))
        const daySelected = !!items && items.length > 0 && !!selectedIds && items.every(i => selectedIds.has(i.id))
        return (
          <section
            key={stat.day}
            data-day={stat.day}
            ref={sectionRef(stat.day)}
            style={items ? undefined : { height: placeholderHeight(measured.current.get(keyOf(stat.day)), count, width, () => estimate(count)) }}
          >
            {/* Sticky at the top of the list's content box (top-0): the list
                has pt-3, and a sticky element counts from inside that padding,
                so the label rests and sticks at the same spot, 12px under the
                toolbar, with the clips showing through above it. (top-1 plus
                pt-1 added up to 8px, 2026-11-20.) It sits 8px above its own
                clips (mb-0.5 + the items' pt-1.5), closer to them than to the
                toolbar, so it reads as theirs. A sticky element can't leave
                its section, so when the section ends the next day's header,
                which starts right there, pushes it out. For that the gap
                between days is padding on the items (pb-8), not on the
                section, and a sticky element keeps its margin inside its
                section, so the label's own mb-0.5 is exactly the 2px left
                between the two labels while one pushes the other. z-30 keeps
                it over the cards' badges (z-10) and outline (z-20).
                The row has no background: the day sits centred in a box that
                floats over the clips, in the toolbar strip's fill (bg-toolbar):
                lighter than the clips' area in dark mode, a step greyer than
                white in light. */}
            {/* The sticky strip spans the area's width but lets clicks
                through (pointer-events-none, 2026-11-22): it used to catch
                clicks meant for the clips under it (and, in select mode,
                count them as background clicks). Only the label catches
                them. */}
            <div className="sticky top-0 z-30 flex items-center justify-center mb-0.5 pointer-events-none">
              {/* text-fg (fg-secondary until 2026-11-21). */}
              <h4 className="text-xs font-semibold text-fg whitespace-nowrap pointer-events-auto">
                {/* A button only in select mode (once the day has loaded):
                    a click selects every capture of the day, or deselects
                    them when they're all selected already. */}
                {onDayClick && items ? (
                  <button
                    onClick={() => onDayClick(items)}
                    data-tip={daySelected ? 'Deselect day' : 'Select day'}
                    aria-label={`${daySelected ? 'Deselect' : 'Select'} all from ${dayLabel(stat.day, now)}`}
                    // the buttons' hover
                    // layer, inside the 1px border at radius 6 - 1 = 5px.
                    className={`${DAY_BOX} hover-overlay hover-overlay-md`}
                  >
                    {dayLabel(stat.day, now)}
                  </button>
                ) : (
                  <span className={`block ${DAY_BOX}`}>{dayLabel(stat.day, now)}</span>
                )}
              </h4>
            </div>
            {items && <div className={`pt-1.5 pb-8 ${gridClassName}`}>{items.map(item => renderItem(item))}</div>}
          </section>
        )
      })}
    </div>
  )
}
