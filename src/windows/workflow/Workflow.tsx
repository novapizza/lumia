import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { WorkflowTemplate, UploadDestination, AfterCaptureStep, AfterUploadStep } from '../../types'
import { v4 as uuidv4 } from 'uuid'

import { Icon } from '../../components/Icon'
import { BUTTON, DANGER_BUTTON, ICON_BUTTON, DANGER_ICON_BUTTON } from '../../components/button-classes'
import { Group, Row, Select } from '../../components/SettingsRows'
import { toast, toastError } from '../../lib/toast'

/* Workflow page, redone on the Settings layout (2026-11-25 page review):
   the workflows in a nav column on the toolbar layer, the picked one on
   content as flat groups of rows (Settings' row kit). Changes save as they
   happen, like Settings; no Save button. The old page (glass cards, phase
   numbers, hover-only row actions, dashed add chips) is in git history. */

type Phase = 'afterCapture' | 'destinations' | 'afterUpload'
type Step = AfterCaptureStep | UploadDestination | AfterUploadStep

/** Row labels start with a verb, what the step does (Voice). */
const STEP_LABEL: Record<Step['type'], string> = {
  annotate: 'Open in editor',
  save: 'Save to folder',
  clipboard: 'Copy image',
  'google-drive': 'Upload to Google Drive',
  r2: 'Upload to Lumia',
  copyUrl: 'Copy link',
  notify: 'Show notification',
  openUrl: 'Open link',
  osShare: 'Share file',
}

const PHASES: { key: Phase; title: string; add: string }[] = [
  { key: 'afterCapture', title: 'After capture', add: 'Add step' },
  { key: 'destinations', title: 'Upload', add: 'Add destination' },
  { key: 'afterUpload', title: 'After upload', add: 'Add step' },
]

/** Text field at the framed controls' size; the accent edge while typing,
 *  like the image editor's text box. */
const INPUT =
  'h-8 px-2.5 rounded-lg bg-elevated border border-line text-xs font-medium text-fg placeholder:text-fg-tertiary outline-none focus:border-accent'

export default function Workflow() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [activeId, setActiveId] = useState('')
  const [gdriveConnected, setGdriveConnected] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      window.electronAPI?.getTemplates(),
      window.electronAPI?.getSettings(),
    ]).then(([t, s]) => {
      const list = t ?? []
      setTemplates(list)
      const saved = s?.activeWorkflowId ?? ''
      const active = list.some(x => x.id === saved) ? saved : 'builtin-r2'
      setActiveId(active)
      // Opens on the default workflow: there's no empty "pick one" state.
      setSelectedId(list.some(x => x.id === active) ? active : list[0]?.id ?? '')
      setGdriveConnected(!!s?.googleDriveConnected)
    }).finally(() => setLoading(false))
  }, [])

  // Saves as you go. Typing (name, folder) waits 400ms; the last pending
  // write goes out when the page closes.
  const pending = useRef<WorkflowTemplate | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const t = pending.current
    pending.current = null
    if (t) window.electronAPI?.saveTemplate(t).catch(err => toastError("Couldn't save workflow", err))
  }
  useEffect(() => flush, [])

  const update = (next: WorkflowTemplate, typing = false) => {
    setTemplates(prev => prev.map(t => (t.id === next.id ? next : t)))
    if (pending.current && pending.current.id !== next.id) flush()
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    if (typing) timer.current = setTimeout(flush, 400)
    else flush()
  }

  const select = (id: string) => { flush(); setSelectedId(id) }

  const makeDefault = (id: string) => {
    setActiveId(id)
    void window.electronAPI?.setSetting('activeWorkflowId', id)
  }

  const create = async () => {
    flush()
    const blank: WorkflowTemplate = {
      id: uuidv4(),
      name: 'New workflow',
      icon: 'bolt',
      afterCapture: [],
      destinations: [],
      afterUpload: [{ type: 'notify' }],
    }
    try {
      const saved = (await window.electronAPI?.saveTemplate(blank)) ?? blank
      setTemplates(prev => [...prev, saved])
      setSelectedId(saved.id)
    } catch (err) {
      toastError("Couldn't add workflow", err)
    }
  }

  const remove = async (id: string) => {
    if (pending.current?.id === id) { pending.current = null; flush() }
    try {
      await window.electronAPI?.deleteTemplate(id)
    } catch (err) {
      toastError("Couldn't delete workflow", err)
      return
    }
    const rest = templates.filter(t => t.id !== id)
    setTemplates(rest)
    // The default goes back to the built-in upload workflow.
    if (activeId === id) makeDefault('builtin-r2')
    setSelectedId(activeId === id ? 'builtin-r2' : activeId)
    toast('Workflow deleted')
  }

  const selected = templates.find(t => t.id === selectedId) ?? null

  // Blank while the templates load (a few ms), like Settings.
  if (loading) return <div className="h-full bg-content" />

  return (
    <div className="h-full flex overflow-hidden">
      {/* The workflows, as Settings' section list: toolbar layer, the
          picked one in the accent purple, the others grey, fg under the
          pointer. The default one carries a star at its right end. */}
      <nav className="w-48 flex-shrink-0 bg-toolbar border-r border-line px-3 py-3 flex flex-col gap-1 overflow-y-auto" aria-label="Workflows">
        {templates.map(t => {
          const on = t.id === selectedId
          return (
            <button
              key={t.id}
              onClick={() => select(t.id)}
              aria-current={on ? 'true' : undefined}
              className={`h-8 px-2.5 flex-shrink-0 flex items-center gap-2 rounded-lg text-xs font-medium text-left ${
                on ? 'bg-accent text-on-accent' : 'text-fg-secondary hover:text-fg'
              }`}
            >
              <Icon name={t.icon} className="text-[16px] flex-shrink-0" />
              <span className="truncate">{t.name}</span>
              {t.id === activeId && <Icon name="star" className="ml-auto text-[14px] flex-shrink-0" />}
            </button>
          )
        })}
        <button
          onClick={() => void create()}
          className="h-8 px-2.5 flex-shrink-0 flex items-center gap-2 rounded-lg text-xs font-medium text-left text-fg-secondary hover:text-fg"
        >
          <Icon name="add" className="text-[16px]" />
          New workflow
        </button>
      </nav>

      <div className="flex-1 overflow-y-auto bg-content">
        {selected && (
          <div className="max-w-xl mx-auto px-5 pt-5 pb-8 space-y-6">
            <section>
              <div className="mb-2 px-1">
                <h2 className="text-sm font-semibold text-fg truncate">{selected.name}</h2>
                {selected.builtIn && (
                  <p className="mt-1 text-[10px] font-medium text-fg-secondary">Built in, can't be changed.</p>
                )}
              </div>
              <Group>
                {!selected.builtIn && (
                  <Row label="Rename">
                    <input
                      value={selected.name}
                      onChange={e => update({ ...selected, name: e.target.value }, true)}
                      onBlur={() => { if (!selected.name.trim()) update({ ...selected, name: 'New workflow' }) }}
                      aria-label="Workflow name"
                      className={`${INPUT} w-48`}
                    />
                  </Row>
                )}
                <Row
                  label="Use by default"
                  description={selected.id === activeId ? 'Run in the editor uses this workflow.' : 'Run in the editor uses the starred workflow.'}
                >
                  <button
                    onClick={() => makeDefault(selected.id)}
                    disabled={selected.id === activeId}
                    className={BUTTON}
                  >
                    {selected.id === activeId ? 'Default' : 'Make default'}
                  </button>
                </Row>
                {!selected.builtIn && (
                  <Row label="Delete workflow">
                    <button onClick={() => void remove(selected.id)} className={DANGER_BUTTON}>Delete</button>
                  </Row>
                )}
              </Group>
            </section>

            {PHASES.map(phase => (
              <PhaseGroup
                key={phase.key}
                phase={phase}
                template={selected}
                gdriveConnected={gdriveConnected}
                onChange={update}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** One phase: a caption over a group of step rows, then the Add row. */
function PhaseGroup({ phase, template, gdriveConnected, onChange }: {
  phase: typeof PHASES[number]
  template: WorkflowTemplate
  gdriveConnected: boolean
  onChange: (next: WorkflowTemplate, typing?: boolean) => void
}) {
  const steps = template[phase.key] as Step[]
  const editable = !template.builtIn
  const set = (next: Step[], typing = false) => onChange({ ...template, [phase.key]: next }, typing)
  const patch = (i: number, p: Partial<Step>, typing = false) =>
    set(steps.map((s, j) => (j === i ? ({ ...s, ...p } as Step) : s)), typing)
  const move = (from: number, to: number) => {
    const next = [...steps]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    set(next)
  }

  const addOptions: { value: Step['type']; label: string }[] =
    phase.key === 'afterCapture'
      ? [{ value: 'annotate', label: STEP_LABEL.annotate }, { value: 'save', label: STEP_LABEL.save }, { value: 'clipboard', label: STEP_LABEL.clipboard }]
      : phase.key === 'destinations'
        ? [{ value: 'r2', label: STEP_LABEL.r2 }, ...(gdriveConnected ? [{ value: 'google-drive' as const, label: STEP_LABEL['google-drive'] }] : [])]
        : [{ value: 'copyUrl', label: STEP_LABEL.copyUrl }, { value: 'notify', label: STEP_LABEL.notify }, { value: 'openUrl', label: STEP_LABEL.openUrl }, { value: 'osShare', label: STEP_LABEL.osShare }]

  const add = (type: Step['type']) => {
    const step: Step =
      type === 'save' ? { type: 'save', path: '' }
      : type === 'copyUrl' ? { type: 'copyUrl', which: 'first' }
      : { type } as Step
    set([...steps, step])
  }

  const chooseFolder = async (i: number) => {
    const res = await window.electronAPI?.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res && !res.canceled && res.filePaths[0]) patch(i, { path: res.filePaths[0] } as Partial<Step>)
  }

  return (
    <section>
      <p className="mb-1.5 px-1 text-xs font-medium text-fg-secondary">{phase.title}</p>
      <Group>
        {steps.length === 0 && !editable && (
          <div className="min-h-[50px] px-3 flex items-center text-[11px] font-medium text-fg-secondary">No steps</div>
        )}
        {steps.map((step, i) => {
          let description: ReactNode
          let config: ReactNode = null
          if (step.type === 'save') {
            description = step.path
              ? <span className="select-text">{step.path}</span>
              : <span className="text-warning-text">Choose a folder. Nothing is saved without one.</span>
            if (editable) config = <button onClick={() => void chooseFolder(i)} className={BUTTON}>Choose</button>
          } else if (step.type === 'google-drive' && editable) {
            config = (
              <input
                value={step.folderId ?? ''}
                onChange={e => patch(i, { folderId: e.target.value || undefined } as Partial<Step>, true)}
                placeholder="Folder from Settings"
                aria-label="Drive folder ID"
                className={`${INPUT} w-40`}
              />
            )
          } else if (step.type === 'google-drive' && step.folderId) {
            description = step.folderId
          } else if (step.type === 'r2' && editable) {
            config = (
              <input
                value={step.bucket ?? ''}
                onChange={e => patch(i, { bucket: e.target.value || undefined } as Partial<Step>, true)}
                placeholder="Default bucket"
                aria-label="Bucket"
                className={`${INPUT} w-40`}
              />
            )
          } else if (step.type === 'r2' && step.bucket) {
            description = step.bucket
          }
          return (
            <Row key={i} label={STEP_LABEL[step.type] ?? step.type} description={description}>
              {editable && (
                <div className="flex items-center gap-3 flex-shrink-0">
                  {config}
                  {/* Up / Down stay (disabled) at the ends so the columns
                      keep their place, like the list rows' actions. */}
                  <div className="flex items-center gap-3">
                    <button onClick={() => move(i, i - 1)} disabled={i === 0} className={ICON_BUTTON} data-tip="Up" aria-label="Move up">
                      <Icon name="arrow_upward" className="text-[16px]" />
                    </button>
                    <button onClick={() => move(i, i + 1)} disabled={i === steps.length - 1} className={ICON_BUTTON} data-tip="Down" aria-label="Move down">
                      <Icon name="arrow_downward" className="text-[16px]" />
                    </button>
                    <button
                      onClick={() => set(steps.filter((_, j) => j !== i))}
                      className={DANGER_ICON_BUTTON}
                      data-tip="Remove"
                      aria-label={`Remove ${STEP_LABEL[step.type] ?? step.type}`}
                    >
                      <Icon name="delete" className="text-[16px]" />
                    </button>
                  </div>
                </div>
              )}
            </Row>
          )
        })}
        {editable && (
          <Row label={phase.add}>
            <Select<Step['type']>
              value=""
              placeholder="Choose…"
              onChange={add}
              options={addOptions}
              label={phase.add}
            />
          </Row>
        )}
      </Group>
    </section>
  )
}
