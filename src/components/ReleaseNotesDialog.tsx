import { useState, useEffect } from 'react'
import logo from '../assets/logo.png'

interface ReleaseNote {
  version: string
  highlights: { icon: string; title: string; description: string }[]
}

const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2.1.0',
    highlights: [
      { icon: 'fast_forward', title: 'Seekable recordings', description: 'Screen recordings now scrub correctly in Lumia, VLC, and browsers — the timeline finally works.' },
      { icon: 'memory', title: 'Long recordings, low memory', description: 'Long captures stream to disk instead of piling up in memory, so they no longer fail or balloon RAM when saving.' },
      { icon: 'visibility_off', title: 'Offline auto-blur', description: 'Auto-blur of sensitive content (emails, keys, cards) now works fully offline.' },
      { icon: 'verified', title: 'Stability & security', description: 'Dozens of fixes across capture, recording, the editor, and uploads, plus hardened token and local-file handling.' },
    ],
  },
  {
    version: '1.0.2',
    highlights: [
      { icon: 'undo', title: 'Undo & Redo', description: 'Full undo/redo support in the annotation editor with cross-platform hotkeys (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y)' },
      { icon: 'history', title: 'History Panel', description: 'New History section in the editor sidebar with Undo, Redo, and Clear buttons' },
      { icon: 'memory', title: 'Bounded History', description: 'Up to 100 annotation states are tracked — no memory bloat on long editing sessions' },
    ],
  },
  {
    version: '1.0.1',
    highlights: [
      { icon: 'palette', title: 'New App Icons', description: 'Fresh platform-native icons for macOS and Windows' },
      { icon: 'menu', title: 'In-App Menu', description: 'Custom dropdown menu replacing the native Electron menu' },
      { icon: 'rocket_launch', title: 'Workflow Selector', description: 'Quickly switch workflows from the Editor top bar' },
      { icon: 'keyboard', title: 'Dev Shortcuts', description: 'DevTools, Reload, and Force Reload now use standard platform shortcuts' },
      { icon: 'bug_report', title: 'Tray Icon Fix', description: 'System tray icon now works correctly in packaged builds' },
    ],
  },
]

export function ReleaseNotesDialog() {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [note, setNote] = useState<ReleaseNote | null>(null)

  const showForVersion = (v: string) => {
    const found = RELEASE_NOTES.find(r => r.version === v)
    if (found) {
      setNote(found)
      setOpen(true)
    }
  }

  // Auto-show on first launch after update
  useEffect(() => {
    let cancelled = false
    async function check() {
      const [appVersion, settings] = await Promise.all([
        window.electronAPI?.getAppVersion(),
        window.electronAPI?.getSettings(),
      ])
      if (cancelled || !appVersion) return

      setVersion(appVersion)

      if (settings?.lastSeenReleaseVersion !== appVersion) {
        showForVersion(appVersion)
        if (!RELEASE_NOTES.find(r => r.version === appVersion)) {
          window.electronAPI?.setSetting('lastSeenReleaseVersion', appVersion)
        }
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  // Manual trigger via custom event
  useEffect(() => {
    const handler = () => {
      if (version) showForVersion(version)
      else window.electronAPI?.getAppVersion().then((v: string) => { setVersion(v); showForVersion(v) })
    }
    window.addEventListener('app:show-release-notes', handler)
    return () => window.removeEventListener('app:show-release-notes', handler)
  }, [version])

  const handleClose = () => {
    setOpen(false)
    window.electronAPI?.setSetting('lastSeenReleaseVersion', version)
  }

  if (!open || !note) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
      <div
        className="glass-card rounded-3xl p-8 flex flex-col items-center gap-6 w-[504px] max-h-[80vh] shadow-2xl border border-white/10"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <img src={logo} alt="Lumia" className="w-16 h-16 rounded-2xl" />
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--color-on-surface)]" style={{ fontFamily: 'Manrope, sans-serif' }}>
            What's New in Lumia
          </h2>
          <p className="text-sm text-secondary font-semibold mt-1">Version {note.version}</p>
        </div>

        {/* Feature list */}
        <div className="w-full space-y-3 overflow-y-auto">
          {note.highlights.map((h, i) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-2xl bg-white/5 border border-white/5">
              <div className="w-8 h-8 rounded-xl bg-secondary/10 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-secondary text-sm">{h.icon}</span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--color-on-surface)]" style={{ fontFamily: 'Manrope, sans-serif' }}>{h.title}</p>
                <p className="text-xs text-[var(--color-on-surface-variant)] mt-0.5">{h.description}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Close */}
        <button
          onClick={handleClose}
          className="w-[120px] primary-gradient text-slate-900 font-bold text-sm py-3 rounded-2xl hover:scale-[1.02] transition-transform cursor-pointer"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
