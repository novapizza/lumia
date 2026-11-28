import { useState, useEffect } from 'react'
import type { WorkflowResult, WorkflowTemplate } from '../types'

import { Icon } from './Icon'
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="relative w-[400px] rounded-3xl overflow-hidden liquid-glass"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Image preview ── */}
        <div className="relative bg-canvas" style={{ maxHeight: 280, overflow: 'hidden' }}>
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
            className="absolute top-3 right-3 w-7 h-7 rounded-md bg-black/40 hover:bg-black/70 flex items-center justify-center text-white/60 hover:text-white transition-all"
          >
            <Icon name="close" className="text-[14px]" />
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
                 
                >
                  <div className="w-8 h-8 rounded-xl bg-on-accent/10 flex items-center justify-center flex-shrink-0">
                    <Icon name={template.icon} className="text-[20px] text-on-accent" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-xs font-black text-on-accent leading-tight">{template.name}</p>
                    <p className="text-[10px] text-on-accent opacity-70 leading-tight mt-0.5">
                      {[
                        template.afterCapture.length > 0 && `${template.afterCapture.length} pre-step`,
                        template.destinations.length > 0 && `${template.destinations.length} upload`,
                        template.afterUpload.length > 0 && `${template.afterUpload.length} post-step`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Icon name="chevron_right" className="text-[20px] text-on-accent opacity-70" />
                </button>
              )}

              {/* Divider */}
              {templateId && (
                <div className="flex items-center gap-3 py-1">
                  <div className="flex-1 h-px bg-fill" />
                  <span className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-widest">or</span>
                  <div className="flex-1 h-px bg-fill" />
                </div>
              )}

              {/* Quick actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleCopy}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold text-fg-secondary hover:text-fg transition-all bg-fill border border-line"
                 
                >
                  <Icon name="content_copy" className="text-[16px] text-fg-secondary" />
                  Copy
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-semibold text-fg-secondary hover:text-fg transition-all bg-fill border border-line"
                 
                >
                  <Icon name="save" className="text-[16px] text-fg-secondary" />
                  Save
                </button>
              </div>
            </div>
          )}

          {status === 'loading' && (
            <div className="flex items-center justify-center gap-3 py-5">
              <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <span className="text-sm text-fg-secondary">Running…</span>
            </div>
          )}

          {status === 'done' && (
            <div className="space-y-1.5">
              {/* No-result fallback */}
              {!result && (
                <div className="flex items-center gap-3 py-3 px-4 rounded-xl bg-accent/10 border border-accent/20">
                  <Icon name="check_circle" className="text-accent-text text-[20px]" />
                  <span className="text-sm font-semibold text-fg">Done!</span>
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
                className="w-full mt-2 py-2.5 rounded-xl text-xs font-bold text-fg-secondary hover:text-fg transition-colors bg-fill border border-line"
               
              >
                Close
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-2">
              <div className="flex items-start gap-3 p-3 rounded-xl bg-danger-subtle border border-danger/25">
                <Icon name="error" className="text-danger-text text-[20px] flex-shrink-0" />
                <p className="text-xs text-danger-text leading-relaxed">{errorMsg}</p>
              </div>
              <button
                onClick={() => setStatus('idle')}
                className="w-full py-2.5 rounded-xl text-xs font-bold text-fg-secondary hover:text-fg transition-colors bg-fill border border-line"
               
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
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${success ? 'bg-accent/[0.06] border-accent/15' : 'bg-danger-subtle border-danger/25'}`}>
      <Icon name={icon} className={`text-[16px] flex-shrink-0 ${success ? 'text-accent-text' : 'text-danger-text'}`} />
      <span className="flex-1 text-xs font-medium text-fg truncate capitalize">
        {error ?? label}
      </span>
      {url && (
        <button
          onClick={() => window.electronAPI?.openExternal(url)}
          className="flex-shrink-0 flex items-center gap-1 text-[10px] font-bold text-accent-text hover:text-fg transition-colors cursor-pointer"
         
        >
          Open
          <Icon name="open_in_new" className="text-[14px]" />
        </button>
      )}
    </div>
  )
}
