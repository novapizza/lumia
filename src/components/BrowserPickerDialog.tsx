import { useState, useEffect } from 'react'

import { Icon } from './Icon'
import { BUTTON } from './button-classes'
import { MessageBox } from './MessageBox'

interface BrowserPreview {
  clientId: number
  browser: string
  title: string
  url: string
  dataUrl: string | null
}

interface Props {
  onClose: () => void
}

/**
 * Shown when a Scroll extension capture is requested while MORE THAN ONE
 * browser has the Lumia extension connected. Each connected browser reports a
 * downscaled screenshot of its active tab; picking one starts the capture in
 * that browser (which then focuses itself and shows its in-page overlay).
 */
export default function BrowserPickerDialog({ onClose }: Props) {
  const [previews, setPreviews] = useState<BrowserPreview[] | null>(null)
  const [starting, setStarting] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [errorDetail, setErrorDetail] = useState('')

  useEffect(() => {
    let alive = true
    window.electronAPI?.getScrollExtensionPreviews?.().then(p => {
      if (alive) setPreviews(p ?? [])
    })
    return () => { alive = false }
  }, [])

  // Esc closes
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pick = async (clientId: number) => {
    if (starting != null) return
    setStarting(clientId)
    setError('')
    setErrorDetail('')
    const r = await window.electronAPI?.startScrollCaptureWith?.(clientId)
    if (r && !r.ok) {
      setError(r.error ?? "Couldn't start capture")
      setErrorDetail(r.detail ?? '')
      setStarting(null)
      return
    }
    // Session started — it ends in the editor (or a toast), like any capture.
    onClose()
  }

  // Dialog look (2026-11-25 review), like the PrintScreen prompt: a solid
  // elevated box over the scrim (no blur, no glass). The tab cards follow the
  // Dashboard's grid cards: a toolbar card, an inset line edge that steps to
  // line-strong under the pointer, no transitions.
  return (
    <div
      className="fixed inset-0 bg-scrim flex items-center justify-center z-[60]"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="browser-picker-title" className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg bg-elevated border border-line p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="browser-picker-title" className="text-sm font-semibold text-fg">Choose a browser</h2>
          <p className="text-xs text-fg-secondary">Lumia Scroll Capture is running in several browsers. Pick the tab to capture.</p>
        </div>

        {/* A real wait: each browser sends a preview of its active tab. */}
        {previews === null && (
          <div className="h-40 flex items-center justify-center gap-2 text-xs font-medium text-fg-secondary">
            <Icon name="progress_activity" className="text-[16px] animate-spin" />
            Loading previews…
          </div>
        )}

        {previews !== null && (
          <div className="grid grid-cols-2 gap-3">
            {previews.map(p => (
              <button
                key={p.clientId}
                onClick={() => pick(p.clientId)}
                disabled={starting != null}
                className="group relative text-left rounded-lg overflow-hidden bg-toolbar"
              >
                <div className="aspect-video bg-content relative overflow-hidden">
                  {p.dataUrl ? (
                    <img src={p.dataUrl} className="w-full h-full object-cover object-top select-none" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Icon name="public" className="text-[24px] text-fg-tertiary" />
                    </div>
                  )}
                  {/* Over the preview (media), so a raw scrim is fine here. */}
                  {starting === p.clientId && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <Icon name="progress_activity" className="text-[24px] text-white animate-spin" />
                    </div>
                  )}
                </div>
                <div className="px-2.5 py-2 border-t border-line">
                  <p className="text-[11px] font-semibold text-fg truncate">{p.browser}</p>
                  <p className="text-[10px] font-medium text-fg-secondary truncate mt-0.5">
                    {p.title || p.url || 'No preview'}
                  </p>
                </div>
                {/* Edge over everything, inside the card (like a clip card's):
                    line-strong under the pointer, accent while it starts. */}
                <div className={`absolute inset-0 rounded-lg pointer-events-none ${
                  starting === p.clientId
                    ? 'ring-(length:--selection-ring) ring-inset ring-accent'
                    : `ring-1 ring-inset ring-line ${starting == null ? 'group-hover:ring-line-strong' : ''}`
                }`} />
              </button>
            ))}
          </div>
        )}

        {/* Like an error toast. */}
        {error && <MessageBox kind="error" message={error} detail={errorDetail || undefined} />}

        <div className="flex justify-end">
          <button onClick={onClose} className={BUTTON}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
