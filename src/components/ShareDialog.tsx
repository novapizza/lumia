import { useState, useEffect } from 'react'
import type { WorkflowResult, WorkflowTemplate } from '../types'

interface Props {
  imageDataUrl: string
  templateId?: string
  onClose: () => void
}

type Status = 'idle' | 'loading' | 'done' | 'error'

export default function ShareDialog({ imageDataUrl, templateId, onClose }: Props) {
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<WorkflowResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (templateId) {
      window.electronAPI?.getTemplates().then(ts => {
        setTemplate(ts.find(t => t.id === templateId) ?? null)
      })
    }
  }, [templateId])

  const handleRunWorkflow = async () => {
    if (!templateId) return
    setStatus('loading')
    try {
      const r = await window.electronAPI?.runWorkflow(templateId, imageDataUrl)
      setResult(r ?? null)
      setStatus('done')
    } catch (e) {
      setErrorMsg(String(e))
      setStatus('error')
    }
  }

  const handleCopy = async () => {
    setStatus('loading')
    try {
      await window.electronAPI?.runWorkflow('builtin-clipboard', imageDataUrl)
      setStatus('done')
      setTimeout(onClose, 1000)
    } catch (e) {
      setErrorMsg(String(e))
      setStatus('error')
    }
  }

  const handleSave = async () => {
    const res = await window.electronAPI?.showSaveDialog({
      defaultPath: `capture-${Date.now()}.png`,
      filters: [{ name: 'Images', extensions: ['png'] }]
    })
    if (!res || res.canceled || !res.filePath) return
    setStatus('loading')
    try {
      await window.electronAPI?.saveFile(imageDataUrl, res.filePath)
      // Pass dataUrl through so the main process can derive a thumbnail.
      // The full image is already on disk at res.filePath and won't be stored
      // in the history JSON — only a compact thumbnail ends up persisted.
      window.electronAPI?.addHistoryItem({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        name: res.filePath.split(/[\\/]/).pop() ?? 'capture',
        dataUrl: imageDataUrl,
        filePath: res.filePath,
        type: 'screenshot',
        uploads: []
      })
      setStatus('done')
      setTimeout(onClose, 1000)
    } catch (e) {
      setErrorMsg(String(e))
      setStatus('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="relative w-[400px] rounded-3xl overflow-hidden shadow-2xl liquid-glass"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Image preview ── */}
        <div className="relative bg-black/30" style={{ maxHeight: 280, overflow: 'hidden' }}>
          <img
            src={imageDataUrl}
            className="w-full h-auto block"
            style={{ maxHeight: 280, objectFit: 'contain' }}
            draggable={false}
          />
          {/* gradient fade bottom */}
          <div
            className="absolute inset-x-0 bottom-0 h-12 pointer-events-none"
            style={{ background: 'linear-gradient(to top, var(--color-surface), transparent)' }}
          />
          {/* close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/40 hover:bg-black/70 flex items-center justify-center text-white/60 hover:text-white transition-all"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {/* ── Content ── */}
        <div className="px-5 pb-5 pt-3">

          {status === 'idle' && (
            <div className="space-y-2.5">
              {/* Workflow button */}
              {templateId && template && (
                <button
                  onClick={handleRunWorkflow}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-all hover:brightness-110 active:scale-[0.98] primary-gradient"
                  style={{ fontFamily: 'Manrope, sans-serif' }}
                >
                  <div className="w-8 h-8 rounded-xl bg-black/20 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[18px] text-white/90">{template.icon}</span>
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-xs font-black text-slate-900 leading-tight">{template.name}</p>
                    <p className="text-[10px] text-slate-900 opacity-70 leading-tight mt-0.5">
                      {[
                        template.afterCapture.length > 0 && `${template.afterCapture.length} pre-step`,
                        template.destinations.length > 0 && `${template.destinations.length} upload`,
                        template.afterUpload.length > 0 && `${template.afterUpload.length} post-step`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-[20px] text-slate-900 opacity-70">chevron_right</span>
                </button>
              )}

              {/* Divider */}
              {templateId && (
                <div className="flex items-center gap-3 py-1">
                  <div className="flex-1 h-px bg-white/5" />
                  <span className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest">or</span>
                  <div className="flex-1 h-px bg-white/5" />
                </div>
              )}

              {/* Quick actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleCopy}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold text-slate-300 hover:text-white transition-all bg-white/[0.04] border border-white/10"
                  style={{ fontFamily: 'Manrope, sans-serif' }}
                >
                  <span className="material-symbols-outlined text-[16px] text-slate-400">content_copy</span>
                  Copy
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold text-slate-300 hover:text-white transition-all bg-white/[0.04] border border-white/10"
                  style={{ fontFamily: 'Manrope, sans-serif' }}
                >
                  <span className="material-symbols-outlined text-[16px] text-slate-400">save</span>
                  Save
                </button>
              </div>
            </div>
          )}

          {status === 'loading' && (
            <div className="flex items-center justify-center gap-3 py-5">
              <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span className="text-sm text-slate-400" style={{ fontFamily: 'Manrope, sans-serif' }}>Running…</span>
            </div>
          )}

          {status === 'done' && (
            <div className="space-y-1.5">
              {/* No-result fallback */}
              {!result && (
                <div className="flex items-center gap-3 py-3 px-4 rounded-xl bg-secondary/10 border border-secondary/20">
                  <span className="material-symbols-outlined text-secondary text-lg">check_circle</span>
                  <span className="text-sm font-semibold text-white" style={{ fontFamily: 'Manrope, sans-serif' }}>Done!</span>
                </div>
              )}

              {result?.copiedToClipboard && (
                <ResultRow icon="content_paste" label="Copied to clipboard" success />
              )}
              {result?.savedPath && (
                <ResultRow icon="save" label={result.savedPath.split(/[\\/]/).pop() ?? 'Saved'} success />
              )}
              {result?.uploads.map((u, i) => (
                <ResultRow
                  key={i}
                  icon={u.success ? 'cloud_done' : 'cloud_off'}
                  label={u.destination}
                  success={u.success}
                  error={u.error}
                  url={u.url}
                />
              ))}

              <button
                onClick={onClose}
                className="w-full mt-2 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition-colors bg-white/[0.04] border border-white/10"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Close
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-2">
              <div className="flex items-start gap-3 p-3 rounded-xl bg-tertiary/10 border border-tertiary/20">
                <span className="material-symbols-outlined text-tertiary text-lg flex-shrink-0">error</span>
                <p className="text-xs text-tertiary leading-relaxed">{errorMsg}</p>
              </div>
              <button
                onClick={() => setStatus('idle')}
                className="w-full py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition-colors bg-white/[0.04] border border-white/10"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ResultRow({ icon, label, success, error, url }: {
  icon: string
  label: string
  success: boolean
  error?: string
  url?: string
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
      style={{ background: success ? 'rgba(0,227,253,0.06)' : 'rgba(255,108,149,0.06)', border: `1px solid ${success ? 'rgba(0,227,253,0.15)' : 'rgba(255,108,149,0.15)'}` }}
    >
      <span className={`material-symbols-outlined text-base flex-shrink-0 ${success ? 'text-secondary' : 'text-tertiary'}`}>{icon}</span>
      <span className="flex-1 text-xs font-medium text-slate-200 truncate capitalize" style={{ fontFamily: 'Manrope, sans-serif' }}>
        {error ?? label}
      </span>
      {url && (
        <button
          onClick={() => window.electronAPI?.openExternal(url)}
          className="flex-shrink-0 flex items-center gap-1 text-[10px] font-bold text-primary hover:text-white transition-colors"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Open
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
        </button>
      )}
    </div>
  )
}
