import { useEffect } from 'react'
import { BUTTON, ACCENT_BUTTON } from './button-classes'

/** After Settings › General › Save to changed the folder (2026-11-27): the
 *  Dashboard now shows the new folder's files, and this offers to bring the
 *  previous folder's files (and their history) along. Drawn like the other
 *  dialogs (STYLEGUIDE › Dialogs): scrim, elevated box with a line edge,
 *  Section-rank title, Esc = Keep there. */
export function MoveFilesDialog({ count, from, to, onKeep, onMove }: {
  count: number
  from: string
  to: string
  onKeep: () => void
  onMove: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onKeep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const one = count === 1
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim">
      <div role="dialog" aria-modal="true" aria-labelledby="move-files-title" className="w-[400px] max-w-[calc(100vw-32px)] rounded-lg bg-elevated border border-line p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="move-files-title" className="text-sm font-semibold text-fg">Move your files?</h2>
          <p className="text-xs text-fg-secondary">
            {one ? '1 file is' : `${count} files are`} still in <strong className="font-medium text-fg">{from}</strong>. Move {one ? 'it' : 'them'} to <strong className="font-medium text-fg">{to}</strong> to keep {one ? 'it' : 'them'} in the Dashboard.
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={onKeep} className={BUTTON}>Keep there</button>
          <button onClick={onMove} className={ACCENT_BUTTON}>Move files</button>
        </div>
      </div>
    </div>
  )
}
