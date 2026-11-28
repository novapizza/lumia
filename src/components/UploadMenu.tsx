import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalloutArrow, CALLOUT_GAP } from './CalloutArrow'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { uploadRowLabel, type UploadRow } from '../lib/upload-choice'

/** The Upload menu (2026-11-23, lib/upload-choice.ts): under the button that
 *  opened it, centred on it when the window allows; above it when there's no room below
 *  (a list row near the window's bottom), always 8px inside the window.
 *  A small triangle on the edge facing the button points at its centre
 *  (2026-11-23, like the trim bar's time bubbles), so the menu reads as
 *  that button's. Portaled to <body> so a card's clipping or hover layer
 *  can't hide it. Closes on a pick, a click outside, Esc, scroll, resize or the window
 *  losing focus. */
/** The triangle: an 8px square turned 45° (10px tried; smaller with the
 *  menu 2px closer, 2026-11-23), its two outer edges in the menu's line,
 *  its fill the menu's, half of it over the menu's edge. */
const ARROW = 8

export function UploadMenu({ anchor, anchorEl, rows, onPick, onClose }: {
  /** The button's rect. */
  anchor: DOMRect
  /** The button itself: a press on it is left to its own click, which
   *  closes the menu (a toggle), instead of closing here and reopening. */
  anchorEl?: HTMLElement
  rows: UploadRow[]
  onPick: (row: UploadRow) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Placed after a measure: below by default, flipped above when it would
  // run past the window's bottom edge, kept 8px inside every edge.
  const [pos, setPos] = useState<{ top: number; left: number; side: 'below' | 'above'; arrowLeft: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    // GAP: CALLOUT_GAP from the button (12px since 2026-11-26; 7 before);
    // the triangle sticks out 2px less, so its tip ends 2px short of the
    // button.
    const EDGE = 8, GAP = CALLOUT_GAP
    const below = anchor.bottom + GAP
    const above = anchor.top - GAP - height
    const side = below + height <= window.innerHeight - EDGE ? 'below' : 'above'
    const top = side === 'below' ? below : Math.max(EDGE, above)
    // Centred under the button when the window allows (2026-11-23; it was
    // right-aligned), else pushed in to stay EDGE inside the window.
    const centre = anchor.left + anchor.width / 2
    const left = Math.min(Math.max(EDGE, centre - width / 2), window.innerWidth - EDGE - width)
    // The triangle's centre over the button's centre, from the menu's left.
    const arrowLeft = Math.min(width - 16, Math.max(8, centre - left - ARROW / 2))
    setPos({ top, left, side, arrowLeft })
  }, [anchor])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorEl?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, anchorEl])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Upload"
      className="fixed z-[100] rounded-lg bg-elevated ring-1 ring-inset ring-line p-1 min-w-[180px] text-xs font-medium"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      {pos && <CalloutArrow side={pos.side === 'below' ? 'top' : 'bottom'} centre={pos.arrowLeft + ARROW / 2} />}
      {rows.map(row => (
        <button
          key={row.dest}
          type="button"
          role="menuitem"
          onClick={() => onPick(row)}
          className="relative w-full h-7 px-2.5 rounded-md flex items-center gap-2 text-left text-fg-secondary hover:bg-elevated-hover hover:text-fg"
        >
          {/* 16px, a control's icon (14px is for tags); the extension's
              popup rows copy this menu. */}
          <Icon name={row.link ? 'link' : 'add_to_drive'} className="text-[16px]" />
          {uploadRowLabel(row)}
        </button>
      ))}
    </div>,
    document.body,
  )
}
