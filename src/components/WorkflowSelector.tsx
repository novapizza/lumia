import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowTemplate } from '../types'

import { Icon } from './Icon'
interface WorkflowSelectorProps {
  templates: WorkflowTemplate[]
  selectedId: string
  onSelect: (id: string) => void
}

export function WorkflowSelector({ templates, selectedId, onSelect }: WorkflowSelectorProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const selected = templates.find(t => t.id === selectedId)

  // Compute position from trigger
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left })
    requestAnimationFrame(() => setVisible(true))
    return () => setVisible(false)
  }, [open])

  // Escape key & window blur
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onBlur = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const handleSelect = (id: string) => {
    onSelect(id)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 h-8 pl-2.5 pr-2 rounded-xl bg-fill hover:bg-fill-hover border border-line text-fg text-[12px] transition-all flex-shrink-0"
      >
        <Icon name="rocket_launch" className="text-[14px] text-accent-text" />
        <span className="font-medium max-w-[110px] truncate">{selected?.name ?? 'Select workflow'}</span>
        <Icon name="expand_more" className="text-[14px] text-fg-tertiary" />
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[89]" onClick={() => setOpen(false)} />
          <div
            className={`fixed z-[90] min-w-[200px] max-h-[280px] overflow-y-auto py-1.5 rounded-xl
              glass-refractive border border-line
              transition-all duration-150 origin-top-left
              ${visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}
            style={{ top: pos.top, left: pos.left, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {templates.map(t => (
              <button
                key={t.id}
                onClick={() => handleSelect(t.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
                  t.id === selectedId ? 'bg-fill-hover text-fg' : 'text-fg hover:bg-fill-hover'
                }`}
              >
                <Icon name={t.icon} className="text-[20px] text-fg-secondary" />
                <span className="flex-1 text-left text-xs">{t.name}</span>
                {t.id === selectedId && (
                  <Icon name="check" className="text-[14px] text-accent-text" />
                )}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
