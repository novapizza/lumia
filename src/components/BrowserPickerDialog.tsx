import { useState, useEffect } from 'react'

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

  useEffect(() => {
    let alive = true
    window.electronAPI?.getScrollExtensionPreviews?.().then(p => {
      if (alive) setPreviews(p ?? [])
    })
    return () => { alive = false }
  }, [])

  // ESC to dismiss
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pick = async (clientId: number) => {
    if (starting != null) return
    setStarting(clientId)
    setError('')
    const r = await window.electronAPI?.startScrollCaptureWith?.(clientId)
    if (r && !r.ok) {
      setError(r.error ?? 'Failed to start the capture')
      setStarting(null)
      return
    }
    // Session started — main pushes scroll-capture:open and the progress
    // dialog takes over from here.
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="glass-refractive rounded-3xl p-8 w-[560px] max-w-[92vw] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-secondary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-secondary text-lg">extension</span>
            </div>
            <h3 className="text-lg font-bold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Choose a browser
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Several browsers are connected — pick the one whose active tab you want to capture.
        </p>

        {/* Loading previews */}
        {previews === null && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <div className="w-8 h-8 border-2 border-secondary border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Fetching tab previews…
            </p>
          </div>
        )}

        {/* Browser cards */}
        {previews !== null && (
          <div className="grid grid-cols-2 gap-3">
            {previews.map(p => (
              <button
                key={p.clientId}
                onClick={() => pick(p.clientId)}
                disabled={starting != null}
                className={`group text-left rounded-xl overflow-hidden bg-white/[0.03] border transition-all duration-200
                            ${starting === p.clientId
                              ? 'border-secondary/50 ring-2 ring-secondary/30'
                              : 'border-white/[0.05] hover:border-secondary/30 hover:bg-secondary/[0.06]'}
                            disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer`}
              >
                <div className="aspect-video bg-slate-950 relative overflow-hidden">
                  {p.dataUrl ? (
                    <img src={p.dataUrl} className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="material-symbols-outlined text-slate-700 text-3xl">public</span>
                    </div>
                  )}
                  {starting === p.clientId && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-secondary border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <p className="text-xs font-bold text-white truncate" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    {p.browser}
                  </p>
                  <p className="text-[10px] text-slate-500 truncate mt-0.5" title={p.title || p.url}>
                    {p.title || p.url || 'No preview available'}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
            <span className="material-symbols-outlined text-red-400 text-sm flex-shrink-0">error</span>
            <p className="text-xs text-slate-300">{error}</p>
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-6 w-full px-6 py-2.5 rounded-2xl border border-slate-500/30 text-slate-300 text-sm font-semibold hover:bg-white/5 transition-colors"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
