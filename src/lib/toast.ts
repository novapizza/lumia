import { useSyncExternalStore, type ReactNode } from 'react'

/* One toast at a time for the main window (2026-11-24; the Dashboard, the
   editor and Wallpapers each had their own). `toast()` replaces whatever is
   showing. <ToastHost> (components/Toast.tsx, in App) draws it.

   Text standard (design/STYLEGUIDE.md › Voice › Toasts):
   - The outcome, past tense, sentence case, no closing period:
     "Image copied", "Link copied", "Saved to Downloads".
   - Names keep their capitals: Downloads (the folder), Drive, Lumia.
   - Name the thing when the action alone is unclear: Image / Video / Link.
   - No articles ("the", "a"): "Couldn't remove trim", "Couldn't set wallpaper".
   - Two outcomes: "and" for one subject ("Captured and copied"), a comma
     when the subject changes ("Uploaded, link copied").
   - Failures start "Couldn't": "Couldn't upload". The raw error goes on a
     second line (`detail`), never into the message.
   - Partly failed: the failed count of the total in parentheses:
     "Couldn't upload image (1 of 2)".
   - A wait ends in "…" and shows a spinner: "Downloading…".
   - No em dashes, no " · ", no "successfully", no "clipboard".
   - A length in the app's units, in parentheses: "Video recorded (12s)",
     "(1m 05s)" (formatDuration, utils/captureLabels.ts), never a clock. */

/** `info`: news, not the result of something the user did (the update
 *  toast); accent icon, never tinted. `warning`: it didn't go as asked but
 *  nothing broke ("Download canceled", "File path copied instead"); orange
 *  icon, like Missing. */
export type ToastKind = 'success' | 'error' | 'progress' | 'info' | 'warning'

export interface ToastData {
  id: number
  kind: ToastKind
  message: string
  icon: string
  detail?: string
  /** A text button at the right (ToastBox › action). */
  action?: ReactNode
  /** The X at the right and what it does (the download's Cancel). */
  onClose?: () => void
  closeLabel?: string
  closeAria?: string
}

const DEFAULT_ICON: Record<ToastKind, string> = {
  success: 'check_circle',
  error: 'error',
  progress: 'progress_activity',
  info: 'system_update',
  warning: 'warning',
}

let current: ToastData | null = null
let nextId = 1
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

/** Error text as it arrives from IPC: drop Electron's "Error invoking remote
 *  method '…': Error: " wrapper so only the reason is left. */
export function cleanError(err: unknown): string | undefined {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined
  if (!raw) return undefined
  return raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^(\w*Error): /, '').trim() || undefined
}

export function toast(message: string, opts: { kind?: ToastKind; icon?: string; detail?: unknown; duration?: number; action?: ReactNode; onClose?: () => void; closeLabel?: string; closeAria?: string } = {}): void {
  const kind = opts.kind ?? 'success'
  const detail = cleanError(opts.detail)
  current = { id: nextId++, kind, message, icon: opts.icon ?? DEFAULT_ICON[kind], detail: detail && detail !== message ? detail : undefined, action: opts.action, onClose: opts.onClose, closeLabel: opts.closeLabel, closeAria: opts.closeAria }
  if (timer) clearTimeout(timer)
  timer = null
  // A wait stays until the next toast or dismissToast(); an error with a
  // reason stays a little longer so the reason can be read.
  const ms = opts.duration ?? (kind === 'progress' ? 0 : current.detail ? 4000 : 2500)
  if (ms > 0) timer = setTimeout(dismissToast, ms)
  emit()
}

/** A failure: "Couldn't …", the reason (an Error, a string or undefined) on
 *  the second line. */
export function toastError(message: string, reason?: unknown): void {
  toast(message, { kind: 'error', detail: reason })
}

export function dismissToast(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!current) return
  current = null
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function useToast(): ToastData | null {
  return useSyncExternalStore(subscribe, () => current)
}
