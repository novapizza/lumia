import { useState, useEffect, useRef } from 'react'

interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  // Derived connected flag — the raw OAuth tokens are never sent to the
  // renderer (stripped by settings:get).
  googleDriveConnected: boolean
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  printScreenAsCapture: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  googleDriveConnected: false,
  googleDriveFolderId: '',
  launchAtStartup: true,
  historyRetentionDays: 0,
  printScreenAsCapture: false
}

const RETENTION_OPTIONS = [
  { value: 0, label: 'Keep forever' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days' },
  { value: 365, label: '1 year' },
]

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const originalRef = useRef<AppSettings>(DEFAULT_SETTINGS)
  const [gdriveConnecting, setGdriveConnecting] = useState(false)
  const [gdriveError, setGdriveError] = useState('')
  const [gdrivePicking, setGdrivePicking] = useState(false)
  const [gdriveFolderName, setGdriveFolderName] = useState('')
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const disconnectConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [printScreenWarning, setPrintScreenWarning] = useState<string>('')

  useEffect(() => {
    window.electronAPI?.getSettings().then(s => {
      // Pull out only the keys the Settings UI renders — everything else on
      // AppSettings is managed elsewhere (capture modes, save dialog path,
      // release gate).
      const ui: AppSettings = {
        theme: s.theme,
        googleDriveConnected: !!s.googleDriveConnected,
        googleDriveFolderId: s.googleDriveFolderId,
        launchAtStartup: s.launchAtStartup,
        historyRetentionDays: s.historyRetentionDays,
        printScreenAsCapture: s.printScreenAsCapture,
      }
      setSettings(ui)
      originalRef.current = ui
      setLoading(false)
    })
  }, [])

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const applyTheme = (mode: 'dark' | 'light' | 'system') => {
    const resolved = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode
    document.documentElement.classList.toggle('light', resolved === 'light')
  }

  const handleThemeChange = async (next: 'dark' | 'light' | 'system') => {
    update('theme', next)
    applyTheme(next)
    originalRef.current = { ...originalRef.current, theme: next }
    await window.electronAPI?.setSetting('theme', next)
    window.electronAPI?.setTitleBarTheme(next)
    window.dispatchEvent(new CustomEvent('lumia:theme-changed', { detail: next }))
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<'dark' | 'light' | 'system'>).detail
      setSettings(prev => ({ ...prev, theme: next }))
      originalRef.current = { ...originalRef.current, theme: next }
    }
    window.addEventListener('lumia:theme-changed', handler)
    return () => window.removeEventListener('lumia:theme-changed', handler)
  }, [])

  // The Browse button on the OAuth Connected page kicks off the picker
  // outside our IPC promise chain — listen for the resulting selection event
  // so the Settings UI's folder display stays in sync.
  useEffect(() => {
    window.electronAPI?.onGdriveFolderSelected(async () => {
      const s = await window.electronAPI?.getSettings()
      if (!s) return
      setSettings(prev => ({ ...prev, googleDriveFolderId: s.googleDriveFolderId }))
      originalRef.current = { ...originalRef.current, googleDriveFolderId: s.googleDriveFolderId }
    })
    // Without this, every visit to Settings adds a permanent ipcRenderer
    // listener (the preload wrapper never removes it) — MaxListenersExceeded
    // warnings + N redundant getSettings round-trips per folder selection.
    return () => window.electronAPI?.removeAllListeners('gdrive:folderSelected')
  }, [])

  const gdriveConnected = settings.googleDriveConnected

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const handleGdriveAuth = async () => {
    setGdriveConnecting(true)
    setGdriveError('')
    const result = await window.electronAPI?.gdriveStartAuth()
    setGdriveConnecting(false)
    if (result?.success) {
      const s = await window.electronAPI?.getSettings()
      if (s) {
        const next = { ...settings, googleDriveConnected: !!s.googleDriveConnected, googleDriveFolderId: s.googleDriveFolderId }
        setSettings(next)
        originalRef.current = next
      }
      // No auto-redirect to the picker — the Connected page in the browser
      // surfaces a "Browse Drive folders" button so the user picks the folder
      // there. Falling back to the in-app Browse button covers the case where
      // they close the tab first.
      return
    }
    if (!result?.cancelled) {
      setGdriveError(result?.error ?? 'Authorization failed')
    }
  }

  const handleGdriveCancelAuth = async () => {
    await window.electronAPI?.gdriveCancelAuth()
    // gdriveStartAuth's promise will resolve with { cancelled: true } and the
    // handler above will reset gdriveConnecting; no extra state work needed.
  }

  const handleGdriveDisconnect = async () => {
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true)
      if (disconnectConfirmTimerRef.current) clearTimeout(disconnectConfirmTimerRef.current)
      disconnectConfirmTimerRef.current = setTimeout(() => setConfirmingDisconnect(false), 3000)
      return
    }
    if (disconnectConfirmTimerRef.current) clearTimeout(disconnectConfirmTimerRef.current)
    setConfirmingDisconnect(false)
    await window.electronAPI?.gdriveDisconnect()
    setSettings(prev => {
      const next = { ...prev, googleDriveConnected: false, googleDriveFolderId: '' }
      originalRef.current = { ...originalRef.current, googleDriveConnected: false, googleDriveFolderId: '' }
      return next
    })
    setGdriveFolderName('')
  }

  const handleGdrivePickFolder = async () => {
    setGdrivePicking(true)
    setGdriveError('')
    const result = await window.electronAPI?.gdrivePickFolder()
    setGdrivePicking(false)
    if (result?.cancelled) return
    if (!result?.success) {
      setGdriveError(result?.error ?? 'Folder picker failed')
      return
    }
    if (result.folder) {
      update('googleDriveFolderId', result.folder.id)
      originalRef.current = { ...originalRef.current, googleDriveFolderId: result.folder.id }
      setGdriveFolderName(result.folder.name)
    }
  }

  const handleGdriveCancelPickFolder = async () => {
    await window.electronAPI?.gdriveCancelPickFolder()
  }

  const platform = window.electronAPI?.platform
  const supportsStartup = platform === 'win32' || platform === 'darwin'

  const handleLaunchAtStartupChange = async (next: boolean) => {
    update('launchAtStartup', next)
    originalRef.current = { ...originalRef.current, launchAtStartup: next }
    await window.electronAPI?.setSetting('launchAtStartup', next)
  }

  const handlePrintScreenAsCaptureChange = async (next: boolean) => {
    update('printScreenAsCapture', next)
    originalRef.current = { ...originalRef.current, printScreenAsCapture: next }
    setPrintScreenWarning('')
    const res = await window.electronAPI?.setPrintScreenAsCapture?.(next)
    // Toggle is saved + globalShortcut updated regardless; the warning only
    // surfaces a *registry* failure (Snipping Tool may keep the keystroke).
    if (res?.warning) setPrintScreenWarning(res.warning)
  }

  const handleHistoryRetentionChange = async (next: number) => {
    update('historyRetentionDays', next)
    originalRef.current = { ...originalRef.current, historyRetentionDays: next }
    await window.electronAPI?.setSetting('historyRetentionDays', next)
  }

  const NAV_ITEMS = [
    { id: 'general', icon: 'tune', label: 'General' },
    { id: 'appearance', icon: 'palette', label: 'Appearance' },
    { id: 'gdrive', icon: 'add_to_drive', label: 'Google Drive' },
    { id: 'hotkeys', icon: 'keyboard', label: 'Hotkeys' },
  ]

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-14 liquid-glass flex items-center justify-between px-6 flex-shrink-0 border-b border-white/5">
        <div>
          <h1 className="text-sm font-bold text-white leading-tight" style={{ fontFamily: 'Manrope, sans-serif' }}>Settings</h1>
          <p className="text-[11px] text-slate-500 leading-tight">Configure uploads, paths and integrations</p>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="w-48 flex-shrink-0 border-r border-white/5 p-3 space-y-0.5">
          {NAV_ITEMS.map(({ id, icon, label }) => (
            <button
              key={id}
              onClick={() => {
                setActiveSection(id)
                document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                activeSection === id
                  ? 'active-nav-bg text-primary'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">{icon}</span>
              <span className="text-xs font-semibold" style={{ fontFamily: 'Manrope, sans-serif' }}>{label}</span>
            </button>
          ))}
        </nav>

        {/* Content */}
        <div
          className="flex-1 overflow-y-auto p-8 space-y-6"
          onScroll={(e) => {
            const container = e.currentTarget
            for (const { id } of NAV_ITEMS) {
              const el = document.getElementById(`settings-${id}`)
              if (el) {
                const rect = el.getBoundingClientRect()
                const containerRect = container.getBoundingClientRect()
                if (rect.top >= containerRect.top && rect.top < containerRect.top + containerRect.height / 2) {
                  setActiveSection(id)
                  break
                }
              }
            }
          }}
        >
          <div className="max-w-xl space-y-6">

            {/* General */}
            <Section id="general" title="General" icon="tune">
              {supportsStartup && (
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-slate-300 block" style={{ fontFamily: 'Manrope, sans-serif' }}>
                      Launch at Startup
                    </span>
                    <p className="text-[11px] text-slate-500">
                      {platform === 'darwin'
                        ? 'Start Lumia automatically when you log in, minimized to the menu bar.'
                        : 'Start Lumia automatically when Windows boots, minimized to the system tray.'}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.launchAtStartup}
                    onChange={e => handleLaunchAtStartupChange(e.target.checked)}
                    className="w-4 h-4 accent-primary cursor-pointer flex-shrink-0"
                  />
                </label>
              )}

              <div className="space-y-1.5">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-slate-300 block" style={{ fontFamily: 'Manrope, sans-serif' }}>
                      Use PrintScreen for New Capture
                    </span>
                    <p className="text-[11px] text-slate-500">
                      {platform === 'win32'
                        ? 'Bind the PrtSc key to "New Capture". Lumia will also disable the Windows "PrintScreen opens Snipping Tool" shortcut so the keypress reaches us. Toggle off to give the key back to Windows.'
                        : 'Bind the PrintScreen key on an external keyboard to "New Capture". Built-in Mac keyboards don\'t have this key, so the toggle has no effect for them.'}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.printScreenAsCapture}
                    onChange={e => handlePrintScreenAsCaptureChange(e.target.checked)}
                    className="w-4 h-4 accent-primary cursor-pointer flex-shrink-0"
                  />
                </label>
                {printScreenWarning && (
                  <p className="text-[11px] text-amber-400 leading-snug" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    <span className="material-symbols-outlined text-[12px] align-middle mr-1">warning</span>
                    {printScreenWarning}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <span className="text-xs font-semibold text-slate-300 block" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    Delete history after
                  </span>
                  <p className="text-[11px] text-slate-500">
                    Automatically remove captures older than the selected period. Keep forever by default.
                  </p>
                </div>
                <select
                  value={settings.historyRetentionDays}
                  onChange={e => handleHistoryRetentionChange(Number(e.target.value))}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-primary/30 cursor-pointer flex-shrink-0"
                  style={{ fontFamily: 'Manrope, sans-serif' }}
                >
                  {RETENTION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </Section>

            {/* Appearance */}
            <Section id="appearance" title="Appearance" icon="palette">
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  {([
                    { value: 'light' as const, icon: 'light_mode', label: 'Light' },
                    { value: 'dark' as const, icon: 'dark_mode', label: 'Dark' },
                    { value: 'system' as const, icon: 'contrast', label: 'System' },
                  ]).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleThemeChange(opt.value)}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                        settings.theme === opt.value
                          ? 'bg-primary/15 text-primary border border-primary/30'
                          : 'bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10 hover:text-white'
                      }`}
                      style={{ fontFamily: 'Manrope, sans-serif' }}
                    >
                      <span className="material-symbols-outlined text-sm">{opt.icon}</span>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">Choose how Lumia looks. System will automatically match your OS preference.</p>
              </div>
            </Section>

            {/* Google Drive */}
            <Section id="gdrive" title="Google Drive" icon="add_to_drive">
              {gdriveConnected ? (
                <div className="flex items-center justify-between p-3 bg-secondary/10 border border-secondary/20 rounded-xl">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary text-lg">check_circle</span>
                    <span className="text-xs font-semibold text-secondary" style={{ fontFamily: 'Manrope, sans-serif' }}>Connected</span>
                  </div>
                  <button
                    onClick={handleGdriveDisconnect}
                    onBlur={() => {
                      if (disconnectConfirmTimerRef.current) clearTimeout(disconnectConfirmTimerRef.current)
                      setConfirmingDisconnect(false)
                    }}
                    title={confirmingDisconnect ? 'Click again to confirm' : 'Disconnect Google Drive'}
                    className={`flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
                      confirmingDisconnect
                        ? 'text-red-300 bg-red-500/25 border-red-500/50'
                        : 'text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border-red-500/20'
                    }`}
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    {confirmingDisconnect && <span className="material-symbols-outlined text-xs">warning</span>}
                    {confirmingDisconnect ? 'Confirm disconnect' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleGdriveAuth}
                      disabled={gdriveConnecting}
                      className="flex items-center gap-2 px-4 py-2.5 primary-gradient text-slate-900 font-bold rounded-xl text-xs hover:scale-[1.02] active:scale-95 transition-transform disabled:opacity-50 disabled:scale-100"
                      style={{ fontFamily: 'Manrope, sans-serif' }}
                    >
                      <span className="material-symbols-outlined text-sm">
                        {gdriveConnecting ? 'hourglass_empty' : 'add_to_drive'}
                      </span>
                      {gdriveConnecting ? 'Waiting for authorization…' : 'Connect Google Drive'}
                    </button>
                    {gdriveConnecting && (
                      <button
                        onClick={handleGdriveCancelAuth}
                        title="Cancel and try again"
                        className="flex items-center gap-1.5 px-3 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-slate-300 transition-colors"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                        Cancel
                      </button>
                    )}
                  </div>
                  {gdriveError && (
                    <p className="text-[11px] text-red-400 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">error</span>
                      {gdriveError}
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <input
                    value={gdriveFolderName ? `${gdriveFolderName} (${settings.googleDriveFolderId})` : settings.googleDriveFolderId}
                    readOnly
                    placeholder="No folder selected — required for Drive uploads"
                    title={settings.googleDriveFolderId || ''}
                    className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-4 py-2.5 text-sm text-slate-300 placeholder-slate-600 focus:outline-none cursor-default select-text truncate ${
                      gdriveConnected && !settings.googleDriveFolderId ? 'border-amber-500/40' : 'border-white/10'
                    }`}
                  />
                  <button
                    onClick={handleGdrivePickFolder}
                    disabled={!gdriveConnected || gdrivePicking}
                    title={!gdriveConnected ? 'Connect Google Drive first' : 'Browse Drive'}
                    className="flex items-center gap-1.5 px-3 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    <span className="material-symbols-outlined text-sm">{gdrivePicking ? 'hourglass_empty' : 'folder_open'}</span>
                    {gdrivePicking ? 'Opening…' : 'Browse'}
                  </button>
                  {gdrivePicking && (
                    <button
                      onClick={handleGdriveCancelPickFolder}
                      title="Cancel and try again"
                      className="flex items-center gap-1.5 px-3 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-slate-300 transition-colors"
                      style={{ fontFamily: 'Manrope, sans-serif' }}
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                      Cancel
                    </button>
                  )}
                </div>
                {gdriveConnected && !settings.googleDriveFolderId && (
                  <p className="text-[11px] text-amber-400 flex items-center gap-1 mt-1">
                    <span className="material-symbols-outlined text-sm">warning</span>
                    Pick a folder before sharing — Drive uploads will fail until then.
                  </p>
                )}
              </div>
            </Section>

            {/* Hotkeys */}
            <Section id="hotkeys" title="Keyboard Shortcuts" icon="keyboard">
              <HotkeyEditor />
              <p className="text-[11px] text-slate-500 mt-3">
                Tip: while a recording is in progress, pressing any of the video hotkeys stops it instead of starting a new one.
              </p>
            </Section>

          </div>
        </div>
      </div>
    </div>
  )
}

const HOTKEY_ROWS: { action: string; label: string }[] = [
  { action: 'RectangleRegion',      label: 'Region (Screenshot)' },
  { action: 'ActiveWindow',         label: 'Window (Screenshot)' },
  { action: 'ActiveMonitor',        label: 'Screen (Screenshot)' },
  { action: 'PrintScreen',          label: 'All Screens (Screenshot)' },
  { action: 'ScrollingCapture',     label: 'Scrolling (Screenshot)' },
  { action: 'ScreenRecorder',       label: 'Region (Video)' },
  { action: 'ScreenRecorderWindow', label: 'Window (Video)' },
  { action: 'ScreenRecorderScreen', label: 'Screen (Video)' },
]

// Map a browser KeyboardEvent.code to the key portion of an Electron accelerator.
// Returns null when the key isn't a usable hotkey target (modifier-only, dead key, etc.).
function codeToAcceleratorKey(code: string, key: string): string | null {
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) {
    const tail = code.slice(6)
    if (/^\d$/.test(tail)) return `num${tail}`
    if (tail === 'Add') return 'numadd'
    if (tail === 'Subtract') return 'numsub'
    if (tail === 'Multiply') return 'nummult'
    if (tail === 'Divide') return 'numdiv'
    if (tail === 'Decimal') return 'numdec'
    if (tail === 'Enter') return 'Return'
  }
  if (code.startsWith('Key')) return code.slice(3)
  if (/^F\d{1,2}$/.test(code)) return code
  switch (code) {
    case 'Space':       return 'Space'
    case 'Enter':       return 'Return'
    case 'Tab':         return 'Tab'
    case 'Backspace':   return 'Backspace'
    case 'Delete':      return 'Delete'
    case 'Insert':      return 'Insert'
    case 'Home':        return 'Home'
    case 'End':         return 'End'
    case 'PageUp':      return 'PageUp'
    case 'PageDown':    return 'PageDown'
    case 'ArrowUp':     return 'Up'
    case 'ArrowDown':   return 'Down'
    case 'ArrowLeft':   return 'Left'
    case 'ArrowRight':  return 'Right'
    case 'Comma':       return ','
    case 'Period':      return '.'
    case 'Slash':       return '/'
    case 'Backslash':   return '\\'
    case 'Semicolon':   return ';'
    case 'Quote':       return '\''
    case 'BracketLeft': return '['
    case 'BracketRight':return ']'
    case 'Minus':       return '-'
    case 'Equal':       return '='
    case 'Backquote':   return '`'
  }
  // Modifier-only events have key like "Control"/"Shift"/"Alt"/"Meta" — reject.
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(key)) return null
  return null
}

function eventToAccelerator(e: React.KeyboardEvent | KeyboardEvent): string | null {
  const key = codeToAcceleratorKey(e.code, e.key)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey)  parts.push('Ctrl')
  if (e.metaKey)  parts.push(navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Super')
  if (e.altKey)   parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

function isAcceleratorValid(accel: string): boolean {
  // F-keys are fine alone; everything else needs at least one modifier so it
  // doesn't steal a plain keystroke globally.
  if (/^F\d{1,2}$/.test(accel)) return true
  return /\+/.test(accel) && /^(Ctrl|Cmd|Super|Alt|Shift)\+/.test(accel)
}

function HotkeyEditor() {
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})
  const [recordingAction, setRecordingAction] = useState<string | null>(null)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    window.electronAPI?.getHotkeys().then(h => { if (h) setHotkeys(h) })
  }, [])

  // Capture key events while recording. Window-level so the user doesn't have
  // to keep focus on the button. Also pauses global shortcuts in main so the
  // existing bindings don't fire on whatever keys the user is pressing.
  useEffect(() => {
    if (!recordingAction) return
    void window.electronAPI?.setHotkeyRecording(true)
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Esc with no modifiers cancels the recording.
      if (e.code === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecordingAction(null)
        setError('')
        return
      }
      const accel = eventToAccelerator(e)
      if (!accel) return // pure modifier press — keep listening
      if (!isAcceleratorValid(accel)) {
        setError('Shortcut must include Ctrl, Cmd, Alt, or Shift (or be an F-key).')
        return
      }
      const dupe = Object.entries(hotkeys).find(([a, k]) => a !== recordingAction && k === accel)
      if (dupe) {
        const dupeLabel = HOTKEY_ROWS.find(r => r.action === dupe[0])?.label ?? dupe[0]
        setError(`Already used by "${dupeLabel}". Pick a different combination.`)
        return
      }
      const next = { ...hotkeys, [recordingAction]: accel }
      setHotkeys(next)
      setRecordingAction(null)
      setError('')
      window.electronAPI?.setHotkeys(next).then(saved => { if (saved) setHotkeys(saved) })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      void window.electronAPI?.setHotkeyRecording(false)
    }
  }, [recordingAction, hotkeys])

  const handleReset = async () => {
    const restored = await window.electronAPI?.resetHotkeys()
    if (restored) setHotkeys(restored)
    setRecordingAction(null)
    setError('')
  }

  return (
    <>
      <div className="space-y-1">
        {HOTKEY_ROWS.map(({ action, label }) => {
          const isRecording = recordingAction === action
          const current = hotkeys[action] ?? ''
          return (
            <div key={action} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
              <span className="text-xs font-medium text-slate-300" style={{ fontFamily: 'Manrope, sans-serif' }}>{label}</span>
              <button
                type="button"
                onClick={() => {
                  setError('')
                  setRecordingAction(isRecording ? null : action)
                }}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
                  isRecording
                    ? 'bg-primary/20 border-primary/50 text-primary animate-pulse'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                }`}
              >
                {isRecording ? 'Press keys… (Esc to cancel)' : current || 'Click to set'}
              </button>
            </div>
          )
        })}
      </div>
      {error && (
        <p className="text-[11px] text-red-400 mt-3">{error}</p>
      )}
      <div className="flex items-center gap-3 mt-3">
        <p className="text-[11px] text-slate-500 flex-1">
          Click a shortcut, then press the new combination. Must include Ctrl, Cmd, Alt, or Shift.
        </p>
        <button
          type="button"
          onClick={handleReset}
          className="shrink-0 self-center text-[11px] font-medium text-slate-400 hover:text-slate-200 px-2.5 py-1 rounded-lg border border-white/10 hover:bg-white/5 whitespace-nowrap"
        >
          Reset to defaults
        </button>
      </div>
    </>
  )
}

function Section({ id, title, icon, children }: { id: string; title: string; icon: string; children: React.ReactNode }) {
  return (
    <div id={`settings-${id}`} className="card-organic p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary text-lg">{icon}</span>
        </div>
        <h3
          className="text-xs font-bold text-white uppercase tracking-[0.12em]"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          {title}
        </h3>
      </div>
      {children}
    </div>
  )
}

function Field({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-slate-300" style={{ fontFamily: 'Manrope, sans-serif' }}>{label}</label>
      {children}
      <p className="text-[11px] text-slate-500">{description}</p>
    </div>
  )
}
