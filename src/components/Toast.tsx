import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { useToast, type ToastKind } from '../lib/toast'

/** The toast's box (2026-11-24): 32px tall like the buttons, rounded-lg, a
 *  `line` edge, 12px medium text, a 14px icon. A reason (`detail`) goes on a
 *  second line in fg-secondary.
 *  `onClose` adds the bare X at the right (Close, or `closeLabel`: the
 *  download's Cancel); its icon sits 12px from the edge like the left one,
 *  and the box stays 32px. `action` is a text button before it (the update
 *  toast's Restart); then the box is 40px, so the buttons sit 8px from its
 *  edge, as far as its 8px corner (4px in a 32px box looked cramped). */
export function ToastBox({ kind, icon, message, detail, action, onClose, closeLabel = 'Close', closeAria }: {
  kind: ToastKind
  icon: string
  message: ReactNode
  detail?: string
  action?: ReactNode
  onClose?: () => void
  /** The X's one-word tooltip. */
  closeLabel?: string
  /** The X's screen-reader name, when it says more than the tooltip. */
  closeAria?: string
}) {
  // The fill says how it went (2026-11-24, the Dashboard's look; a plain
  // elevated box with only the icon coloured was compared and dropped):
  // green, red, orange; a wait and the update stay elevated.
  const fill = kind === 'success' ? 'bg-success-subtle' : kind === 'error' ? 'bg-danger-subtle' : kind === 'warning' ? 'bg-warning-subtle' : 'bg-elevated'
  const iconColor = kind === 'success' ? 'text-success-text' : kind === 'error' ? 'text-danger-text' : kind === 'info' ? 'text-accent-text' : kind === 'warning' ? 'text-warning-text' : 'text-fg-secondary' // progress
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`${action ? 'min-h-10 pl-3 pr-2' : onClose ? 'min-h-8 pl-3 pr-[7px]' : 'min-h-8 px-3'} max-w-[420px] py-1.5 flex items-center gap-2 rounded-lg border border-line ${fill}`}
    >
      <Icon name={icon} className={`text-[14px] ${iconColor} ${kind === 'progress' ? 'animate-spin' : ''}`} />
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg leading-4">{message}</p>
        {detail && <p className="mt-0.5 text-[11px] font-medium text-fg-secondary leading-4 break-words">{detail}</p>}
      </div>
      {(action || onClose) && (
        <div className={`flex items-center gap-1.5 ${action ? 'ml-1' : '-my-1'}`}>
          {action}
          {onClose && (
            <button type="button" onClick={onClose} className={TOAST_CLOSE} data-tip={closeLabel} aria-label={closeAria ?? closeLabel}>
              <Icon name="close" className="text-[14px]" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A toast's text button (the update toast's Restart): 24px, accent. */
export const TOAST_ACTION =
  'h-6 px-3 rounded-md bg-accent text-on-accent text-xs font-medium hover:bg-accent-hover'
/** A toast's close / cancel button (ToastBox draws it): 24px, 14px icon,
 *  bare (a framed one was tried and dropped, 2026-11-24). */
const TOAST_CLOSE =
  'w-6 h-6 inline-flex items-center justify-center rounded-md text-fg-secondary hover:text-fg'

/** The main window's toasts, centred 8px under the AppBar (53px): first
 *  `children` (the update toast, which stays until closed), then the current
 *  toast (lib/toast.ts), 8px apart. The host starts at the bar's bottom edge
 *  and clips there, so each toast slides out from under the bar (`.toast-in`,
 *  index.css). It lets clicks through; a toast with buttons takes them back
 *  (`pointer-events-auto` in ToastSlot). */
export function ToastHost({ children }: { children?: ReactNode }) {
  const { shown: t, leaving } = useLeaving(useToast(), t => t.id)
  return (
    // 8px under the bar (pt-2; 12px tried). Keep .toast-in's start offset
    // in index.css the same.
    <div className="fixed top-[53px] inset-x-0 z-[80] pt-2 pb-3 overflow-hidden flex flex-col items-center gap-2 pointer-events-none">
      {children}
      {t && (
        <ToastSlot key={t.id} leaving={leaving}>
          <ToastBox kind={t.kind} icon={t.icon} message={t.message} detail={t.detail} action={t.action} onClose={t.onClose} closeLabel={t.closeLabel} closeAria={t.closeAria} />
        </ToastSlot>
      )}
    </div>
  )
}

/** One toast in the host: its entrance (or, `leaving`, its exit), and
 *  clicks for its buttons. Re-key it to play the entrance again. */
export function ToastSlot({ children, leaving }: { children: ReactNode; leaving?: boolean }) {
  return <div className={leaving ? 'toast-out pointer-events-none' : 'toast-in pointer-events-auto'}>{children}</div>
}

/** The exit's length: `.toast-out` in index.css, none under reduced motion. */
const exitMs = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300)

/** Keeps the last toast on screen while it leaves (2026-11-24): while
 *  `value` is set it's shown as is; when it goes null the previous one stays
 *  `leaving` for the exit, then goes. A new value (another key) replaces the
 *  shown one at once, without an exit. */
export function useLeaving<T>(value: T | null, keyOf: (v: T) => string | number): { shown: T | null; leaving: boolean } {
  const [state, setState] = useState<{ shown: T | null; leaving: boolean }>({ shown: value, leaving: false })
  const key = value ? keyOf(value) : null
  useEffect(() => {
    if (value) { setState({ shown: value, leaving: false }); return }
    setState(s => (s.shown ? { shown: s.shown, leaving: true } : s))
    const t = setTimeout(() => setState({ shown: null, leaving: false }), exitMs())
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return value ? { shown: value, leaving: false } : state
}
