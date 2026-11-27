import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Rest this long on an element before its tooltip shows. */
const SHOW_DELAY_MS = 750 // 2026-11-24 (was 1000; 500 tried)
/** Within this long after a tooltip hid, the next one shows at once (sliding
 *  along a row of buttons). */
const SWITCH_WINDOW_MS = 300
/** Distance from the element's edge, always the same (2026-11-20). */
const GAP = 7 // the gap every pop-up keeps to its element: tooltips, time bubbles, the Upload menu, the sticker panel (2026-11-23; was 8)
const EDGE = 4
/** A [data-tip-follow] tooltip's room for the pointer itself: it keeps GAP
 *  below the arrow's tip plus this (about the arrow's height). */
const POINTER_H = 16

/** x follows the pointer; top / bottom are the element's edges. */
interface Tip { text: string; x: number; top: number; bottom: number }

/**
 * Tooltips for icon-only controls: give the element `data-tip="Label"`
 * (and an `aria-label`) instead of `title`. One layer, mounted once in App,
 * finds the nearest `[data-tip]` under the pointer. macOS native `title`
 * tooltips in Chromium are unreliable between adjacent buttons (often only
 * the first one you rest on shows), so icon buttons use this instead.
 *
 * Fixed dark colours in both themes (it floats over media and UI alike),
 * no animation. Always GAP below the element (above it when there's no room
 * underneath), whatever the pointer's height; only its horizontal position
 * follows the pointer. The one exception, `data-tip-follow` on the element
 * (the Dashboard's clips, 2026-11-27: big areas, the file name): it follows
 * the pointer both ways, GAP under the arrow. `data-tip-key`: shown only
 * while Cmd (Ctrl on Windows) is held, at once, no delay.
 */
/** GAP under `bottom` (above `top` when there's no room underneath),
 *  centred on `x`, kept inside the window. */
function place(box: HTMLElement, x: number, top: number, bottom: number): { left: number; top: number } {
  const { width, height } = box.getBoundingClientRect()
  let y = bottom + GAP
  if (y + height > window.innerHeight - EDGE) y = top - GAP - height
  const left = Math.min(Math.max(EDGE, x - width / 2), window.innerWidth - width - EDGE)
  return { left, top: y }
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: Element | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let hiddenAt = 0
    let visible = false
    let px = 0
    let py = 0
    let pinnedX = false
    let follow = false
    // The element's edges, for moving a shown tooltip sideways.
    let edges = { top: 0, bottom: 0 }
    // [data-tip-key] tips (the clips' file names, 2026-11-27) show only
    // while Cmd (Ctrl on Windows) is held, and then at once.
    const mac = document.documentElement.classList.contains('mac')
    let keyHeld = false
    let hoverTarget: Element | null = null
    const tipAt = (t: Element | null): Element | null => {
      const el = t?.closest?.('[data-tip]') ?? null
      return el && el.hasAttribute('data-tip-key') && !keyHeld ? null : el
    }
    const syncKey = (held: boolean) => {
      if (held === keyHeld) return
      keyHeld = held
      const el = tipAt(hoverTarget)
      if (el === current) return
      hide()
      if (!el) return
      current = el
      show(el)
    }

    const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
    const hide = () => {
      clear()
      if (visible) hiddenAt = Date.now()
      visible = false
      current = null
      setTip(null)
    }
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip')
      if (!text || !el.isConnected) return
      visible = true
      const r = el.getBoundingClientRect()
      // Inside a [data-tip-center] area (the image editor's toolbar,
      // 2026-11-23) the tooltip sits centred on its element, like a
      // callout on its button; elsewhere it follows the pointer sideways.
      const centred = !!el.closest('[data-tip-center]')
      pinnedX = centred
      follow = el.hasAttribute('data-tip-follow')
      edges = { top: r.top, bottom: r.bottom }
      if (follow) setTip({ text, x: px, top: py, bottom: py + POINTER_H })
      else setTip({ text, x: centred ? r.left + r.width / 2 : px, top: r.top, bottom: r.bottom })
    }

    // Sideways only: the height comes from the element, not the pointer
    // (both ways for a data-tip-follow element).
    const onMove = (e: PointerEvent) => {
      px = e.clientX
      py = e.clientY
      syncKey(mac ? e.metaKey : e.ctrlKey)
      // Moved here, on the element itself, not through a render (state + a
      // layout effect left it a frame or two behind the pointer; 2026-11-27).
      const box = boxRef.current
      // Its element went (a clip deleted, a day dropped): no tip left behind.
      if (visible && current && !current.isConnected) { hide(); return }
      if (!visible || pinnedX || !box) return
      const p = follow ? place(box, px, py, py + POINTER_H) : place(box, px, edges.top, edges.bottom)
      box.style.left = `${p.left}px`
      box.style.top = `${p.top}px`
    }
    const onOver = (e: PointerEvent) => {
      px = e.clientX
      py = e.clientY
      hoverTarget = e.target as Element | null
      keyHeld = mac ? e.metaKey : e.ctrlKey
      const el = tipAt(hoverTarget)
      if (el === current) return
      const wasVisible = visible
      hide()
      if (!el) return
      current = el
      if (wasVisible || el.hasAttribute('data-tip-key') || Date.now() - hiddenAt < SWITCH_WINDOW_MS) show(el)
      else timer = setTimeout(() => { if (current === el) show(el) }, SHOW_DELAY_MS)
    }
    const onLeaveWindow = (e: PointerEvent) => { if (!e.relatedTarget) { hoverTarget = null; hide() } }
    const onKey = (e: KeyboardEvent) => syncKey(mac ? e.metaKey : e.ctrlKey)
    const onBlur = () => { keyHeld = false; hide() }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerout', onLeaveWindow)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    // A window resize closes it (2026-11-26): what it points at moves.
    window.addEventListener('resize', hide)
    return () => {
      clear()
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerout', onLeaveWindow)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // Place it once its size is known: GAP under the element, above it if it
  // would leave the bottom of the window; centred on the pointer sideways,
  // kept inside the window.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!tip || !box) { setPos(null); return }
    setPos(place(box, tip.x, tip.top, tip.bottom))
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      className="fixed z-[1000] pointer-events-none px-2 py-1 rounded-md bg-tooltip ring-1 ring-inset ring-tooltip-ring text-on-tooltip text-xs font-medium whitespace-nowrap"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {tip.text}
    </div>,
    document.body,
  )
}
