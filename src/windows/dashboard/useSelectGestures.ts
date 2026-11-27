import { toastError } from '../../lib/toast'
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/** Mouse gestures for the Dashboard's select mode (2026-11-21), all handled
 *  on the clip area's wrapper so the cards and list rows need nothing but a
 *  `data-id` next to their `data-clip`:
 *
 *  - Drag to select, like Finder: press anywhere in the clip area (on a
 *    clip or between them) and drag more than 4px; a rectangle follows the
 *    pointer. Works outside select mode too: the drag turns select mode on,
 *    and if it ends with nothing selected, select mode turns off again. A plain drag replaces the selection with the clips it
 *    touches; Shift-drag adds them to it; Cmd-drag (Ctrl on Windows) flips
 *    them (touched selected clips drop out). Near the area's top or bottom
 *    edge the area scrolls,
 *    faster the closer the pointer gets. The click that ends a drag is
 *    swallowed, so it doesn't toggle or open a clip or leave select mode.
 *  - Shift-click, like Finder (2026-11-21): the last plain-clicked clip is
 *    the anchor and stays put; each Shift-click selects every clip from the
 *    anchor to this one, in screen order, and drops the range the previous
 *    Shift-click made. So Shift-clicking further down grows the range,
 *    Shift-clicking back up (or past the anchor) shrinks it and deselects
 *    what's no longer in it. What was selected before the first
 *    Shift-click (earlier clicks, a drag, a day) stays. A click that
 *    deselects a clip drops the anchor; a Shift-click without one ranges
 *    from the top of the clicked clip's day, which becomes the anchor (as
 *    Finder does from the top of the list). Only clips of loaded days count
 *    (days far off screen are dropped from memory).
 *  - Click on the background (not a clip, day label or control) calls
 *    onBackgroundClick (the Dashboard leaves select mode, 2026-11-22) and
 *    drops the anchor.
 */

const DRAG_THRESHOLD = 4
const EDGE = 48            // px from the area's top / bottom where auto-scroll starts
const MAX_SCROLL_STEP = 24 // px per frame at the very edge

/** Clicks on these never count as background and never start a drag. */
const CONTROLS = 'button, a, input, label, select, textarea'

export interface Marquee { left: number; top: number; width: number; height: number }

export function useSelectGestures({ enabled, busy, selectedIds, setSelectedIds, onBackgroundClick, onDragEnter, onDragCancel }: {
  /** Select mode is on (clicks, Shift-click, background click). Drags work either way. */
  enabled: boolean
  busy: boolean
  selectedIds: Set<string>
  setSelectedIds: (next: Set<string>) => void
  onBackgroundClick: () => void
  /** A drag began outside select mode: turn it on. */
  onDragEnter: () => void
  /** That drag ended with nothing selected: turn select mode off again. */
  onDragCancel: () => void
}) {
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds
  const anchorRef = useRef<string | null>(null)
  // The Shift-click range: the selection it was added to, and the ids it
  // added, so the next Shift-click can swap it for a new range.
  const rangeRef = useRef<{ base: Set<string>; ids: string[] } | null>(null)
  const swallowClick = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Leaving select mode drops the anchor and ends any drag.
  useEffect(() => {
    if (!enabled) {
      anchorRef.current = null
      rangeRef.current = null
      cleanupRef.current?.()
    }
  }, [enabled])
  useEffect(() => () => cleanupRef.current?.(), [])

  const scrollAreaOf = (wrapper: HTMLElement) => wrapper.querySelector<HTMLElement>('[data-scroll-area]')

  /** A press on the scroll area's own scroll bar isn't a click in the area. */
  const onScrollbar = (area: HTMLElement, e: { target: EventTarget | null; clientX: number }) =>
    e.target === area && e.clientX >= area.getBoundingClientRect().left + area.clientWidth

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (busy || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest(CONTROLS)) return
    const area = scrollAreaOf(e.currentTarget)
    if (!area || !area.contains(target) || onScrollbar(area, e)) return

    // Start point in the area's content coordinates, so the rectangle stays
    // put on the page while the area scrolls under it.
    const box0 = area.getBoundingClientRect()
    const startX = e.clientX - box0.left
    const startY = e.clientY - box0.top + area.scrollTop
    const startClientX = e.clientX
    const startClientY = e.clientY
    let lastX = e.clientX
    let lastY = e.clientY
    let active = false
    let raf = 0
    // What the drag starts from: nothing (plain drag replaces), or the
    // current selection (Shift adds, Cmd / Ctrl flips). A Shift press that
    // doesn't move stays a Shift-click (range, in onClickCapture).
    const mode: 'replace' | 'add' | 'toggle' = e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'add' : 'replace'
    const base = mode === 'replace' || !enabled ? new Set<string>() : new Set(selectedRef.current)
    // Started outside select mode: the drag turns it on, and turns it off
    // again if it ends with nothing selected.
    const startedOutside = !enabled
    let count = base.size

    const update = () => {
      const box = area.getBoundingClientRect()
      const curX = Math.min(Math.max(lastX - box.left, 0), area.clientWidth)
      const curY = Math.min(Math.max(lastY - box.top + area.scrollTop, 0), area.scrollHeight)
      const x1 = Math.min(startX, curX), x2 = Math.max(startX, curX)
      const y1 = Math.min(startY, curY), y2 = Math.max(startY, curY)

      // The rectangle on screen, clipped to the area's visible box.
      const top = Math.max(y1 - area.scrollTop, 0)
      const bottom = Math.min(y2 - area.scrollTop, area.clientHeight)
      setMarquee(bottom > top
        ? { left: box.left + x1, top: box.top + top, width: x2 - x1, height: bottom - top }
        : null)

      const next = new Set(base)
      for (const el of area.querySelectorAll<HTMLElement>('[data-clip][data-id]')) {
        const r = el.getBoundingClientRect()
        const rx1 = r.left - box.left, rx2 = r.right - box.left
        const ry1 = r.top - box.top + area.scrollTop, ry2 = r.bottom - box.top + area.scrollTop
        if (rx1 < x2 && rx2 > x1 && ry1 < y2 && ry2 > y1) {
          const id = el.dataset.id!
          if (mode === 'toggle' && base.has(id)) next.delete(id)
          else next.add(id)
        }
      }
      count = next.size
      const cur = selectedRef.current
      if (next.size !== cur.size || [...next].some(id => !cur.has(id))) setSelectedIds(next)
    }

    const tick = () => {
      const box = area.getBoundingClientRect()
      let step = 0
      if (lastY < box.top + EDGE) step = -Math.ceil(MAX_SCROLL_STEP * Math.min(1, (box.top + EDGE - lastY) / EDGE))
      else if (lastY > box.bottom - EDGE) step = Math.ceil(MAX_SCROLL_STEP * Math.min(1, (lastY - (box.bottom - EDGE)) / EDGE))
      if (step) {
        const before = area.scrollTop
        area.scrollTop += step
        if (area.scrollTop !== before) update()
      }
      raf = requestAnimationFrame(tick)
    }

    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX
      lastY = ev.clientY
      if (!active) {
        if (Math.hypot(lastX - startClientX, lastY - startClientY) < DRAG_THRESHOLD) return
        active = true
        rangeRef.current = null
        if (startedOutside) onDragEnter()
        raf = requestAnimationFrame(tick)
      }
      update()
    }

    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', end)
      cancelAnimationFrame(raf)
      setMarquee(null)
      cleanupRef.current = null
    }
    const onUp = () => {
      if (active) {
        // The click that follows this release must not toggle a clip or
        // leave select mode. Reset on the next tick in case no click comes.
        swallowClick.current = true
        setTimeout(() => { swallowClick.current = false }, 0)
        if (startedOutside && count === 0) onDragCancel()
      }
      end()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', end)
    cleanupRef.current = end
  }, [enabled, busy, setSelectedIds, onDragEnter, onDragCancel])

  /** Capture phase: runs before the cards' own click handlers. */
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    // Before the select-mode check: a drag that turned select mode off
    // again must not let its closing click open a clip.
    if (swallowClick.current) {
      swallowClick.current = false
      e.stopPropagation()
      e.preventDefault()
      return
    }
    // Cmd+click (Ctrl+click on Windows) on a clip shows its file in Finder /
    // Explorer (2026-11-27), in select mode too; not on its buttons.
    const reveal = document.documentElement.classList.contains('mac') ? e.metaKey : e.ctrlKey
    if (reveal) {
      const t = e.target as HTMLElement
      const c = t.closest<HTMLElement>('[data-clip][data-id]')
      if (c && !t.closest('button')) {
        e.stopPropagation()
        e.preventDefault()
        void window.electronAPI?.revealHistoryFile(c.dataset.id!).then(ok => { if (!ok) toastError("Couldn't find the file") })
        return
      }
    }
    if (!enabled) return
    const target = e.target as HTMLElement
    const clip = target.closest<HTMLElement>('[data-clip][data-id]')
    if (!clip) return
    const id = clip.dataset.id!
    const area = scrollAreaOf(e.currentTarget)
    if (e.shiftKey && area && !busy) {
      const ids = [...area.querySelectorAll<HTMLElement>('[data-clip][data-id]')].map(el => el.dataset.id!)
      // No anchor (nothing clicked yet, or the last click deselected): the
      // first clip of this clip's day is the anchor.
      if (!anchorRef.current || !ids.includes(anchorRef.current)) {
        const first = clip.closest('section[data-day]')?.querySelector<HTMLElement>('[data-clip][data-id]')
        anchorRef.current = first?.dataset.id ?? null
        rangeRef.current = null
      }
      const a = anchorRef.current ? ids.indexOf(anchorRef.current) : -1
      const b = ids.indexOf(id)
      if (a !== -1 && b !== -1) {
        e.stopPropagation()
        e.preventDefault()
        // The selection without the last Shift-click's range. If the
        // selection changed some other way since (a day label, a toggle),
        // it is the base as it stands now.
        const cur = selectedRef.current
        let base = cur
        const last = rangeRef.current
        if (last) {
          const expected = new Set([...last.base, ...last.ids])
          if (expected.size === cur.size && [...cur].every(x => expected.has(x))) base = last.base
        }
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
        setSelectedIds(new Set([...base, ...range]))
        rangeRef.current = { base: new Set(base), ids: range }
        return
      }
    }
    // A plain click (handled by the clip itself) starts a new Shift-click
    // range. It sets the anchor if it selects the clip; if it deselects it,
    // there is no anchor.
    anchorRef.current = selectedRef.current.has(id) ? null : id
    rangeRef.current = null
  }, [enabled, busy, setSelectedIds])

  /** Bubble phase: a click that reached the wrapper without hitting a clip
   *  or a control is a background click. */
  const onClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!enabled || busy) return
    const target = e.target as HTMLElement
    if (target.closest(`[data-clip], ${CONTROLS}`)) return
    const area = scrollAreaOf(e.currentTarget)
    if (area && onScrollbar(area, e)) return
    anchorRef.current = null
    rangeRef.current = null
    onBackgroundClick()
  }, [enabled, busy, onBackgroundClick])

  // Images are draggable by default; a press-and-drag on a thumbnail must
  // start the rectangle, not an HTML drag of the picture.
  const onDragStart = useCallback((e: ReactDragEvent) => { e.preventDefault() }, [])

  return { marquee, wrapperProps: { onPointerDown, onClickCapture, onClick, onDragStart } }
}
