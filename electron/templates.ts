import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { WorkflowTemplate } from './types'

// Originals are auto-saved to ~/Pictures/Lumia/ by capture.ts — workflows no
// longer include a redundant save step. The editor's Save button opens a
// Save-As dialog (handled by `runInlineAction('save')`) for user-chosen paths.

const BUILT_IN: WorkflowTemplate[] = [
  {
    id: 'builtin-clipboard',
    name: 'Copy to Clipboard',
    icon: 'content_paste',
    builtIn: true,
    afterCapture: [{ type: 'clipboard' }],
    destinations: [],
    afterUpload: [{ type: 'notify' }]
  },
  {
    id: 'builtin-r2',
    name: 'Annotate & Share Link',
    icon: 'cloud_upload',
    builtIn: true,
    // `save` with empty path is a marker: it surfaces a "Save" button in the
    // editor (via deriveActions) but workflow.ts skips executing it during
    // destination clicks — so the button opens a Save-As dialog on demand
    // rather than silently writing a duplicate file every time you upload.
    afterCapture: [
      { type: 'annotate' },
      { type: 'save', path: '' },
      { type: 'clipboard' }
    ],
    destinations: [{ type: 'r2' }, { type: 'google-drive' }],
    afterUpload: [
      { type: 'copyUrl', which: 'first' },
      { type: 'notify' }
    ]
  }
]

export class TemplateStore {
  private store: Store<{ templates: WorkflowTemplate[] }>

  constructor() {
    this.store = new Store<{ templates: WorkflowTemplate[] }>({
      name: 'templates',
      defaults: { templates: [] },
      // A corrupted templates.json should reset to empty (built-ins still
      // apply) rather than crash on first read.
      clearInvalidConfig: true
    })
  }

  getAll(): WorkflowTemplate[] {
    const user = this.store.get('templates')
    return [...BUILT_IN, ...user]
  }

  save(template: WorkflowTemplate): WorkflowTemplate {
    const user = this.store.get('templates')
    if (!template.id) template.id = uuidv4()
    const idx = user.findIndex(t => t.id === template.id)
    if (idx >= 0) user[idx] = template
    else user.push(template)
    this.store.set('templates', user)
    return template
  }

  delete(id: string): boolean {
    const user = this.store.get('templates')
    const filtered = user.filter(t => t.id !== id)
    if (filtered.length === user.length) return false
    this.store.set('templates', filtered)
    return true
  }

  getById(id: string): WorkflowTemplate | undefined {
    return this.getAll().find(t => t.id === id)
  }
}
