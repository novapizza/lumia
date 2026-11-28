import { Icon } from './Icon'

/** A message inside a dialog or a panel (STYLEGUIDE › Dialogs), drawn like a
 *  toast of its kind: rounded-lg, a line edge, px-3 py-2, the kind's pale
 *  fill, its 14px icon vertically centred however many lines, the message in
 *  12px medium fg, the reason (a raw error) on a second line in 11px medium
 *  fg-secondary. One definition since 2026-11-27 (the dialogs, the sticker
 *  sidebar and Settings › Wallpapers each drew their own). */
export function MessageBox({ kind, message, detail }: {
  kind: 'error' | 'warning'
  message: string
  detail?: string
}) {
  const error = kind === 'error'
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 ${error ? 'bg-danger-subtle' : 'bg-warning-subtle'}`}>
      <Icon name={error ? 'error' : 'warning'} className={`text-[14px] ${error ? 'text-danger-text' : 'text-warning-text'}`} />
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg leading-4">{message}</p>
        {detail && <p className="mt-0.5 text-[11px] font-medium text-fg-secondary leading-4 break-words">{detail}</p>}
      </div>
    </div>
  )
}
