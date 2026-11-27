import { type MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from './Icon'

/** An action on one clip (Copy, Upload / Copy link, Download, Delete), shown when the
 *  pointer is over the clip: a grid card's hover buttons and a list row's
 *  actions are the same button. 32px like every icon button, 16px icon,
 *  solid `bg-toolbar` with a `line-strong` edge, so it reads the same over a
 *  light or a dark thumbnail. No unavailable state: an action that can't run
 *  isn't rendered (2026-11-21).
 *
 *  `bare`: no fill or edge, just the icon in the 32px hit area — the list
 *  rows, where the buttons are always shown and the row's own edge frames
 *  them (four framed boxes per row read heavy down a long list).
 *
 *  `unavailable`: shown but can't run (list rows, 2026-11-21: they keep
 *  every action in place so the columns hold, where the card hides what
 *  can't run). fg-disabled, clicks do nothing; aria-disabled rather than
 *  disabled, so the tooltip still shows (Chromium sends a disabled button
 *  no pointer events). */
export function ClipActionButton({ icon, label, onClick, spinning, bare, unavailable, danger, noTip }: {
  icon: string
  label: string
  /** No tooltip (Upload while its menu is open, 2026-11-23). */
  noTip?: boolean
  onClick: (e: ReactMouseEvent) => void
  spinning?: boolean
  bare?: boolean
  unavailable?: boolean
  /** Delete: grey like the others at rest, plain danger-text under the
   *  pointer (2026-11-27, Jasper, for every delete button; danger-text-hover
   *  on hover from 2026-11-22, red at rest tried twice). */
  danger?: boolean
}) {
  return (
    <button
      onClick={unavailable ? (e) => e.stopPropagation() : onClick}
      disabled={spinning}
      aria-disabled={unavailable || undefined}
      // fg-secondary at rest, text-fg
      // under the pointer. Framed (card) buttons also step their fill up
      // (bg-toolbar-hover; the AppBar buttons' overlay layer was tried);
      // bare (list) buttons, on the row's bg-toolbar, get the same fill
      // and a line-subtle border under the pointer (line-strong, line tried)
      // (2026-11-22; icon only, then fill only, before). The border is
      // there, transparent, at rest, so nothing moves. Bare buttons rested at text-fg from 2026-11-21 until
      // this. No hover when it can't run.
      className={`w-8 h-8 rounded-lg flex items-center justify-center ${unavailable ? 'text-fg-disabled' : danger ? 'text-fg-secondary hover:text-danger-text' : 'text-fg-secondary hover:text-fg'} ${bare ? (unavailable ? '' : 'border border-transparent hover:bg-toolbar-hover hover:border-line-subtle') : `border bg-toolbar border-line-strong ${unavailable ? '' : 'hover:bg-toolbar-hover'}`}`}
      data-tip={noTip ? undefined : label}
      aria-label={label}
    >
      <Icon name={icon} className={`text-[16px] ${spinning ? 'animate-spin' : ''}`} />
    </button>
  )
}
