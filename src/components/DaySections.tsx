import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DayStat, HistoryItem } from '../types'
import { dayLabel, estimateDayHeight, placeholderHeight, type MeasuredDay } from '../utils/dayHistory'

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
}

// Layout numbers for estimating a day's height before it loads. They match
// the grid (auto-fill minmax(220px, 1fr), gap-3) and list (gap-1) classes
// the Dashboard passes, and the section header + bottom padding below.
const HEADER_HEIGHT = 32 + 16 // header row + mb-4
const SECTION_GAP = 32 // pb-8
const GRID_MIN = 220
const GRID_GAP = 12
const CARD_INFO = 52 // name + date under the 16:9 thumbnail
const LIST_ROW = 56
const LIST_GAP = 4

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
  days, rows, filter, view, className, renderItem, gridClassName, loadDays, dropDays, pinnedDays, emptyState,
}: DaySectionsProps) {
  const scrollRoot = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState(0)
  // Height of a day when it was dropped, keyed by filter + view + day and
  // kept with the count and width it was measured at (placeholderHeight).
  const measured = useRef(new Map<string, MeasuredDay>())
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
    const ro = new ResizeObserver(() => {
      setWidth(root.clientWidth)
      setViewport(root.clientHeight)
    })
    ro.observe(root)
    setWidth(root.clientWidth)
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

  const columns = view === 'grid' ? Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN + GRID_GAP))) : 1
  ctx.current = { keyOf, width, counts: new Map(days.map(d => [d.day, countOf(d)])) }

  const estimate = (count: number) => {
    if (view === 'list') return estimateDayHeight(count, 1, LIST_ROW, LIST_GAP, HEADER_HEIGHT) + SECTION_GAP
    const cardWidth = (width - GRID_GAP * (columns - 1)) / columns
    const rowHeight = (cardWidth * 9) / 16 + CARD_INFO
    return estimateDayHeight(count, columns, rowHeight, GRID_GAP, HEADER_HEIGHT) + SECTION_GAP
  }

  const now = new Date()
  return (
    <div ref={scrollRoot} className={className}>
      {days.length === 0 && emptyState}
      {days.map(stat => {
        const count = countOf(stat)
        const loaded = rows.get(stat.day)
        const items = loaded && (filter === 'all' ? loaded : loaded.filter(i => i.type === filter))
        return (
          <section
            key={stat.day}
            data-day={stat.day}
            ref={sectionRef(stat.day)}
            className="pb-8"
            style={items ? undefined : { height: placeholderHeight(measured.current.get(keyOf(stat.day)), count, width, () => estimate(count)) }}
          >
            <div className="flex items-center gap-4 mb-4">
              <h4
                className="text-[11px] font-bold tracking-[0.15em] uppercase text-slate-500 whitespace-nowrap"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                {dayLabel(stat.day, now)}
              </h4>
              <div className="flex-1 h-px bg-white/5" />
              <span className="text-[10px] text-slate-600 font-medium">{count}</span>
            </div>
            {items && <div className={gridClassName}>{items.map(item => renderItem(item))}</div>}
          </section>
        )
      })}
    </div>
  )
}
