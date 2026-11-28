import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { Icon } from '../../components/Icon'
import { toast, toastError } from '../../lib/toast'
import { ColorSwatches } from '../../components/ColorSwatches'
import { BUTTON, ACCENT_BUTTON, DANGER_BUTTON, ICON_BUTTON } from '../../components/button-classes'
import { OnStrip } from '../../components/OnStrip'
import WallpapersSection from './WallpapersSection'
import { Group, Row, Select, Toggle } from '../../components/SettingsRows'
import { codeToKey, conflictOf, eventToBinding, keyActions, keycapsOf, labelOf, modifierName, overridesOf, resolveKeymap, selectModifier, defaultKeymap, type EditorKind } from '../../lib/editor-keys'
import { clampAccent, clampBase, ACCENT_PRESETS, LIGHT_BASE_PRESETS, DARK_BASE_PRESETS, DEFAULTS } from '../../../shared/theme-colors'
import { OPEN_LUMIA_WHEN, RECORD_COUNTDOWNS, type OpenLumiaWhen } from '../../../shared/capture-settings'
import { useBadges, markNotesSeenSoon, downloadUpdate, installUpdate } from '../../lib/app-badges'
import { useTheme, useThemeMode } from '../../hooks/useTheme'
import { Segmented } from '../../components/Segmented'
import { MoveFilesDialog } from '../../components/MoveFilesDialog'

interface AppSettings {
  // Derived connected flag: the raw OAuth tokens are never sent to the
  // renderer (stripped by settings:get).
  googleDriveConnected: boolean
  // The build has Drive credentials; without them Uploads is hidden.
  googleDriveAvailable: boolean
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  printScreenAsCapture: boolean
  autoUpdateWhenHidden: boolean
  scrollCaptureToTop: boolean
  saveEditHistory: boolean
  keyToDrag: boolean
  openLumiaAfter: OpenLumiaWhen
  copyAfterCapture: boolean
  recordCountdown: number
  captureSelfWindow: boolean
  captureFolderPath: string
  trayActions: string[]
  showThemeButton: boolean
  themeAccent: string | null
  themeLightBase: string | null
  themeDarkBase: string | null
}

const DEFAULT_SETTINGS: AppSettings = {
  googleDriveConnected: false,
  googleDriveAvailable: false,
  googleDriveFolderId: '',
  launchAtStartup: true,
  historyRetentionDays: 0,
  printScreenAsCapture: false,
  autoUpdateWhenHidden: false,
  scrollCaptureToTop: false,
  saveEditHistory: true,
  keyToDrag: false,
  openLumiaAfter: 'open',
  copyAfterCapture: true,
  recordCountdown: 3,
  captureSelfWindow: false,
  captureFolderPath: '',
  trayActions: [],
  showThemeButton: true,
  themeAccent: null,
  themeLightBase: null,
  themeDarkBase: null,
}

// Swatch names (tooltips) for the presets in shared/theme-colors.ts, in order.
const named = (values: string[], names: string[]) => values.map((value, i) => ({ value, name: names[i] }))
// The same five hues in every row, column by column.
const PRESET_NAMES = ['Blue', 'Cyan', 'Green', 'Orange', 'Pink']
const ACCENT_SWATCHES = named(ACCENT_PRESETS, PRESET_NAMES)
const LIGHT_BASE_SWATCHES = named(LIGHT_BASE_PRESETS, PRESET_NAMES)
const DARK_BASE_SWATCHES = named(DARK_BASE_PRESETS, PRESET_NAMES)
const clampLight = (hex: string) => clampBase(hex, 'light')
const clampDark = (hex: string) => clampBase(hex, 'dark')

// The values are main's own lists (shared/capture-settings.ts); only their
// names live here.
const OPEN_LUMIA_LABELS: Record<OpenLumiaWhen, string> = {
  open: 'When it was open before',
  success: 'After a capture or recording',
  captures: 'After a capture',
  recordings: 'After a recording',
  never: 'Never',
}
const OPEN_LUMIA_OPTIONS: { value: OpenLumiaWhen; label: string }[] = OPEN_LUMIA_WHEN.map(value => ({ value, label: OPEN_LUMIA_LABELS[value] }))

const COUNTDOWN_OPTIONS: { value: number; label: string }[] = RECORD_COUNTDOWNS.map(value => ({ value, label: value === 0 ? 'Off' : `${value} seconds` }))

/** A folder path with the home directory as ~ (macOS / Linux), as Finder
 *  users read it; Windows paths stay as they are. */
function shortPath(p: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/.exec(p)
  return m ? `~${m[2] ?? ''}` : p
}

const RETENTION_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 7, label: 'After 7 days' },
  { value: 30, label: 'After 30 days' },
  { value: 90, label: 'After 90 days' },
  { value: 180, label: 'After 180 days' },
  { value: 365, label: 'After 1 year' },
]

/* Settings follows the Dashboard (2026-11-22): the nav column on the
   toolbar layer like the AppBar it hangs from, the scroll area on content,
   each section a heading over one flat group of rows (bg-toolbar, like the
   list view's rows) whose controls sit a step higher on elevated.
   Locked in 2026-11-23. */

// A framed text button, like the AppBar's icon buttons: 32px, elevated,
// grey label that turns fg under the pointer. Disabled: fg-disabled, no hover.
// (BUTTON lives in components/button-classes.ts, shared with the editor.)

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // After Save to changed the folder: the offer to move the previous
  // folder's files (MoveFilesDialog).
  const [moveOffer, setMoveOffer] = useState<{ count: number; from: string; to: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeSection, setActiveSection] = useState('general')
  const [gdriveConnecting, setGdriveConnecting] = useState(false)
  const [gdrivePicking, setGdrivePicking] = useState(false)
  // Drive folder names by id: only the id is stored, so the name is looked
  // up in Drive (gdrive:folderName) or taken from the picker. null = the
  // lookup failed (the id is shown instead); no entry = not known yet.
  const [folderNames, setFolderNames] = useState<Record<string, string | null>>({})
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const disconnectConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [printScreenWarning, setPrintScreenWarning] = useState<{ message: string; detail?: string } | null>(null)
  const [appVersion, setAppVersion] = useState('')
  // Hide "Check for updates" when this process can't apply updates (e.g. a
  // per-machine Windows install run by a non-admin user).
  const [autoUpdateAvailable, setAutoUpdateAvailable] = useState(true)
  const [licensesError, setLicensesError] = useState('')
  // New-things dots (lib/app-badges): unseen release notes, a downloaded
  // update. The installed version and the release list come from there too
  // (2026-11-22).
  const badges = useBadges()
  // Appearance shows only the base of the mode on screen (2026-11-22).
  const themeMode = useThemeMode()
  // Light / dark here while the app bar's button is hidden (2026-11-25).
  const { toggle: toggleTheme } = useTheme()
  const shownVersion = badges.installedVersion || appVersion
  const releases = badges.releases
  const shownDate = releases.find(r => r.version === shownVersion)?.date
  // Older releases merged per minor line (final 2026-11-23), one fold
  // "Version 2.4" for 2.4.0 to 2.4.3, their notes newest first. The current
  // line (the latest release's, e.g. 2.6) isn't merged: each of its
  // releases keeps its own fold under its full number. versions is newest
  // first; merged is set on the folds of an older line.
  const releaseGroups = useMemo(() => {
    const lineOf = (v: string) => v.split('.').slice(0, 2).join('.')
    const current = releases[0] ? lineOf(releases[0].version) : ''
    const groups: { key: string; versions: string[]; notes: typeof releases[number]['notes']; merged: boolean }[] = []
    releases.forEach(r => {
      const line = lineOf(r.version)
      const last = groups[groups.length - 1]
      if (line !== current && last?.merged && lineOf(last.key) === line) {
        last.versions.push(r.version)
        last.notes = [...last.notes, ...r.notes]
      } else {
        groups.push({ key: r.version, versions: [r.version], notes: r.notes, merged: line !== current })
      }
    })
    return groups
  }, [releases])
  // Release notes ("What's new" until 2026-11-22): every release folds by
  // its caption, all closed on every visit (nothing is saved). The one
  // exception (2026-11-24; the latest used to start open): the installed
  // release while its notes carry the new dot starts open, and stays open
  // for this visit after the dot goes; the next visit has it closed again.
  // The set holds the releases flipped from that default.
  const [badgedRelease, setBadgedRelease] = useState<string | null>(null)
  useEffect(() => {
    if (badges.notesDot && badges.installedVersion) setBadgedRelease(badges.installedVersion)
  }, [badges.notesDot, badges.installedVersion])
  const [flippedReleases, setFlippedReleases] = useState<Set<string>>(() => new Set())
  // The older lines' folds wait behind Show more (final 2026-11-23),
  // closed again on every visit like the folds.
  const [showOlderReleases, setShowOlderReleases] = useState(false)
  const toggleRelease = (v: string) => setFlippedReleases(prev => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v); else next.add(v)
    return next
  })
  const location = useLocation()
  const scrollRef = useRef<HTMLDivElement>(null)
  // Set while a nav click (or a link to a section) scrolls the page, so the
  // scroll spy doesn't move the selection to a neighbour when the section
  // can't reach the top (the last ones). The user's own wheel, key or
  // pointer input on the scroll area hands the selection back to the spy.
  const jumpLockRef = useRef(false)

  // The body is user-select: none, and Chromium keeps a selection when you
  // click on unselectable parts, so the selectable bits here (version,
  // Drive folder) would stay highlighted. A press outside the selected text
  // clears it, like everywhere else on macOS.
  useEffect(() => {
    // (It used to keep the selection when the press was on anything the
    // range touched, which includes the scroll area and the page column
    // around it, so background clicks never cleared it.) A press inside
    // selectable text is left to the browser, which starts a new selection
    // there; any other press clears.
    const onDown = (e: MouseEvent) => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      const target = e.target as Element | null
      if (target?.closest?.('.select-text, input, textarea')) return
      sel.removeAllRanges()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  useEffect(() => {
    window.electronAPI?.getAppVersion?.().then(setAppVersion).catch(() => {})
    window.electronAPI?.isAutoUpdateAvailable?.().then(setAutoUpdateAvailable).catch(() => {})
  }, [])

  useEffect(() => {
    window.electronAPI?.getSettings().then(s => {
      // Pull out only the keys the Settings UI renders; everything else on
      // AppSettings is managed elsewhere (capture modes, save dialog path,
      // release gate).
      setSettings({
        googleDriveConnected: !!s.googleDriveConnected,
        googleDriveAvailable: !!s.googleDriveAvailable,
        googleDriveFolderId: s.googleDriveFolderId,
        launchAtStartup: s.launchAtStartup,
        historyRetentionDays: s.historyRetentionDays,
        printScreenAsCapture: s.printScreenAsCapture,
        autoUpdateWhenHidden: !!s.autoUpdateWhenHidden,
        scrollCaptureToTop: !!s.scrollCaptureToTop,
        saveEditHistory: s.saveEditHistory !== false,
        keyToDrag: s.keyToDrag === true,
        openLumiaAfter: OPEN_LUMIA_OPTIONS.some(o => o.value === s.openLumiaAfter) ? s.openLumiaAfter : 'open',
        copyAfterCapture: s.copyAfterCapture !== false,
        captureSelfWindow: s.captureSelfWindow === true,
        recordCountdown: COUNTDOWN_OPTIONS.some(o => o.value === s.recordCountdown) ? s.recordCountdown : 3,
        captureFolderPath: s.captureFolderPath ?? '',
        trayActions: Array.isArray(s.trayActions) ? s.trayActions : [],
        showThemeButton: s.showThemeButton !== false,
        themeAccent: s.themeAccent ?? null,
        themeLightBase: s.themeLightBase ?? null,
        themeDarkBase: s.themeDarkBase ?? null,
      })
      setLoading(false)
    })
  }, [])

  // Bytes the saved edit steps take; shown while Keep edit history is on.

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  // Custom theme picks (design/CUSTOM-THEMES.md): saved raw; main
  // broadcasts the change and every window restyles itself (no local style
  // writes here). A base for the mode that isn't showing never switches the
  // mode: only the AppBar's moon / sun does.
  const setThemePick = (key: 'themeAccent' | 'themeLightBase' | 'themeDarkBase', value: string | null) => {
    update(key, value)
    window.electronAPI?.setSetting(key, value)
  }
  // The Custom picker's drag: every window restyles live (main broadcasts,
  // nothing saved), at most once a frame; the release saves.
  const previewFrame = useRef<number | null>(null)
  const previewPick = (key: 'themeAccent' | 'themeLightBase' | 'themeDarkBase', hex: string) => {
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current)
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null
      window.electronAPI?.previewThemePick(key, hex)
    })
  }
  const pickAccent = useCallback((v: string | null) => setThemePick('themeAccent', v), [])
  const pickLightBase = useCallback((v: string | null) => setThemePick('themeLightBase', v), [])
  const pickDarkBase = useCallback((v: string | null) => setThemePick('themeDarkBase', v), [])

  // The Browse button on the OAuth Connected page kicks off the picker
  // outside our IPC promise chain; listen for the resulting selection event
  // so the folder shown here stays in sync.
  useEffect(() => {
    window.electronAPI?.onGdriveFolderSelected(async () => {
      const s = await window.electronAPI?.getSettings()
      if (!s) return
      setSettings(prev => ({ ...prev, googleDriveFolderId: s.googleDriveFolderId }))
    })
    // Without this, every visit to Settings adds a permanent ipcRenderer
    // listener (the preload wrapper never removes it): MaxListenersExceeded
    // warnings + N redundant getSettings round-trips per folder selection.
    return () => window.electronAPI?.removeAllListeners('gdrive:folderSelected')
  }, [])

  // Look up the chosen folder's name once per id (also after a pick in the
  // browser's Connected page, which only hands back the id).
  useEffect(() => {
    const id = settings.googleDriveFolderId
    if (!settings.googleDriveConnected || !id || id in folderNames) return
    let live = true
    window.electronAPI?.gdriveFolderName(id).then(res => {
      if (live) setFolderNames(prev => ({ ...prev, [id]: 'name' in res ? res.name : null }))
    }).catch(() => { if (live) setFolderNames(prev => ({ ...prev, [id]: null })) })
    return () => { live = false }
  }, [settings.googleDriveConnected, settings.googleDriveFolderId, folderNames])

  // Jump to a section. Instant, no smooth scroll (no motion in the UI).
  const jumpTo = (id: string) => {
    setActiveSection(id)
    jumpLockRef.current = true
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' })
  }

  // Open at a section when linked with { state: { section } } (Wallpapers'
  // Back arrow returns to its section). Keyed on location.key so a repeat
  // link re-scrolls.
  useEffect(() => {
    if (loading) return
    const section = (location.state as { section?: string } | null)?.section
    if (!section) return
    requestAnimationFrame(() => jumpTo(section))
  }, [location.key, loading])

  const gdriveConnected = settings.googleDriveConnected

  // Blank while the settings load (2026-11-24; a spinner until then): the
  // IPC round trip is a few ms, so the spinner only ever flashed.
  if (loading) return <div className="h-full bg-content" />


  const handleGdriveAuth = async () => {
    setGdriveConnecting(true)
    const result = await window.electronAPI?.gdriveStartAuth()
    setGdriveConnecting(false)
    if (result?.success) {
      const s = await window.electronAPI?.getSettings()
      if (s) {
        setSettings(prev => ({ ...prev, googleDriveConnected: !!s.googleDriveConnected, googleDriveFolderId: s.googleDriveFolderId }))
      }
      // No auto-redirect to the picker: the Connected page in the browser
      // has a "Browse Drive folders" button so the user picks the folder
      // there. The in-app Browse button covers the case where they close
      // the tab first.
      return
    }
    // Failures are toasts like everywhere else (2026-11-26; a red line
    // under the section printed Google's raw code, e.g. "access_denied").
    // The browser tab explains it too.
    if (result?.denied) toast('Google Drive not connected', { kind: 'warning', detail: "Access wasn't allowed" })
    else if (!result?.cancelled) toastError("Couldn't connect Google Drive", result?.error)
  }

  const handleGdriveCancelAuth = async () => {
    await window.electronAPI?.gdriveCancelAuth()
    // gdriveStartAuth's promise resolves with { cancelled: true } and the
    // handler above resets gdriveConnecting.
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
    setSettings(prev => ({ ...prev, googleDriveConnected: false, googleDriveFolderId: '' }))
  }

  const handleGdrivePickFolder = async () => {
    setGdrivePicking(true)
    const result = await window.electronAPI?.gdrivePickFolder()
    setGdrivePicking(false)
    if (result?.cancelled) return
    if (!result?.success) {
      toastError("Couldn't open folder picker", result?.error)
      return
    }
    if (result.folder) {
      update('googleDriveFolderId', result.folder.id)
      const { id, name } = result.folder
      setFolderNames(prev => ({ ...prev, [id]: name }))
    }
  }

  const handleGdriveCancelPickFolder = async () => {
    await window.electronAPI?.gdriveCancelPickFolder()
  }

  const platform = window.electronAPI?.platform
  const supportsStartup = platform === 'win32' || platform === 'darwin'

  const handleLaunchAtStartupChange = async (next: boolean) => {
    update('launchAtStartup', next)
    await window.electronAPI?.setSetting('launchAtStartup', next)
  }

  const handlePrintScreenAsCaptureChange = async (next: boolean) => {
    update('printScreenAsCapture', next)
    setPrintScreenWarning(null)
    const res = await window.electronAPI?.setPrintScreenAsCapture?.(next)
    // Saved + globalShortcut updated regardless; the warning only surfaces a
    // *registry* failure (Snipping Tool may keep the keystroke).
    if (res?.warning) setPrintScreenWarning({ message: res.warning, detail: res.detail })
  }

  const handleAutoUpdateWhenHiddenChange = async (next: boolean) => {
    update('autoUpdateWhenHidden', next)
    await window.electronAPI?.setSetting('autoUpdateWhenHidden', next)
  }

  const handleHistoryRetentionChange = async (next: number) => {
    update('historyRetentionDays', next)
    await window.electronAPI?.setSetting('historyRetentionDays', next)
  }

  const NAV_ITEMS = [
    { id: 'general', icon: 'tune', label: 'General' },
    { id: 'appearance', icon: 'palette', label: 'Appearance' },
    { id: 'uploads', icon: 'add_to_drive', label: 'Uploads' }, // the clips' Upload icon (2026-11-22)
    { id: 'hotkeys', icon: 'keyboard', label: 'Hotkeys' },
    { id: 'wallpapers', icon: 'wallpaper', label: 'Wallpapers' },
    { id: 'whats-new', icon: 'auto_awesome', label: 'Release notes' },
    { id: 'about', icon: 'info', label: 'About' },
    // Uploads only in builds with the Drive credentials (2026-11-26).
  ].filter(item => item.id !== 'uploads' || settings.googleDriveAvailable)

  // Scroll spy: the last section whose heading has reached the top of the
  // area, or the last one once the area is scrolled to the bottom.
  const onScroll = () => {
    if (jumpLockRef.current) return
    const area = scrollRef.current
    if (!area) return
    const top = area.getBoundingClientRect().top
    let current = NAV_ITEMS[0].id
    if (area.scrollTop + area.clientHeight >= area.scrollHeight - 2) {
      current = NAV_ITEMS[NAV_ITEMS.length - 1].id
    } else {
      for (const { id } of NAV_ITEMS) {
        const el = document.getElementById(`settings-${id}`)
        if (el && el.getBoundingClientRect().top - top <= 48) current = id
      }
    }
    setActiveSection(current)
  }
  const releaseJumpLock = () => { jumpLockRef.current = false }

  const folderId = settings.googleDriveFolderId
  const folderName = folderId ? folderNames[folderId] : undefined

  return (
    <div className="h-full flex overflow-hidden">
      {/* Section list: on the toolbar layer, under the AppBar. Selected item
          in the accent purple with on-accent label and icon, like the
          Dashboard's segments; the others grey, fg under the pointer. */}
      <nav className="w-48 flex-shrink-0 bg-toolbar border-r border-line px-3 pt-3 flex flex-col gap-1" aria-label="Settings sections">
        {NAV_ITEMS.map(({ id, icon, label }) => {
          // New-things dot at the item's right end: unseen release notes on
          // Release notes, a downloaded update on About. White on the selected
          // (purple) item.
          const dot = (id === 'whats-new' && badges.notesDot) || (id === 'about' && badges.updateDot)
          return (
            <button
              key={id}
              onClick={() => {
                jumpTo(id)
                if (id === 'whats-new' && badges.notesDot) markNotesSeenSoon()
              }}
              aria-current={activeSection === id ? 'true' : undefined}
              className={`h-8 px-2.5 flex items-center gap-2 rounded-lg text-xs font-medium text-left ${
                activeSection === id ? 'bg-accent text-on-accent' : 'text-fg-secondary hover:text-fg'
              }`}
            >
              <Icon name={icon} className="text-[16px]" />
              {label}
              {dot && <span className={`ml-auto w-1.5 h-1.5 rounded-full ${activeSection === id ? 'bg-on-accent' : 'bg-accent'}`} aria-label="New" />}
            </button>
          )
        })}
      </nav>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-content"
        onScroll={onScroll}
        onWheel={releaseJumpLock}
        onKeyDown={releaseJumpLock}
        onPointerDown={releaseJumpLock}
      >
        <div className="max-w-xl mx-auto px-5 pt-5 pb-8 space-y-6">

          <Section id="general" title="General">
            {/* Grouped (2026-11-27): the section had grown to eleven rows. */}
            <div className="space-y-4">
              {supportsStartup && <Group title="Startup">
                <Row
                  label={platform === 'darwin' ? 'Open at login' : 'Start with Windows'}
                  description={platform === 'darwin'
                    ? 'Starts hidden in the menu bar.'
                    : 'Starts hidden in the system tray.'}
                >
                  <Toggle checked={settings.launchAtStartup} onChange={handleLaunchAtStartupChange} label={platform === 'darwin' ? 'Open at login' : 'Start with Windows'} />
                </Row>
              </Group>}
              <Group title="Capturing and recording">
                <Row
                  label="Use PrintScreen"
                  description={
                    <>
                      {/* The key replays the last capture (dispatchLastCapture:
                          same kind and mode, so it can start a recording). */}
                      {platform === 'win32'
                        ? 'Starts a capture or recording like your last. Replaces the Snipping Tool.'
                        : 'Starts a capture or recording like your last. External keyboards only.'}
                      {printScreenWarning && <span className="block mt-1 text-warning-text">{printScreenWarning.message}</span>}
                      {printScreenWarning?.detail && <span className="block">{printScreenWarning.detail}</span>}
                    </>
                  }
                >
                  <Toggle checked={settings.printScreenAsCapture} onChange={handlePrintScreenAsCaptureChange} label="Use PrintScreen" />
                </Row>
                {/* The recording toolbar's "Starting in" (RecordingToolbar.tsx;
                    main sends the seconds with the countdown signal). */}
                {/* A verb-first title (2026-11-27; "Countdown" before). */}
                <Row label="Count down before recording" description="Defines how long Lumia waits before it records.">
                  <Select
                    value={settings.recordCountdown}
                    onChange={v => { update('recordCountdown', v); void window.electronAPI?.setSetting('recordCountdown', v) }}
                    options={COUNTDOWN_OPTIONS}
                    label="Count down before recording"
                  />
                </Row>
                {/* captureSelfWindow (capture.ts, video.ts): Lumia's window
                    isn't hidden before a capture or recording, and the window
                    pick can choose it. Its switch was in the Dashboard's
                    removed launcher (2026-11-27). */}
                <Row label="Show Lumia window" description="Lumia's window stays visible in captures and recordings.">
                  <Toggle
                    checked={settings.captureSelfWindow}
                    onChange={v => { update('captureSelfWindow', v); void window.electronAPI?.setSetting('captureSelfWindow', v) }}
                    label="Show Lumia window"
                  />
                </Row>
                {/* Screen scroll only (scroll-region:confirm); the extension
                    always captures the whole page. */}
                <Row label="Scroll to top first" description="Scroll captures start at the top, not where you are.">
                  <Toggle
                    checked={settings.scrollCaptureToTop}
                    onChange={v => { update('scrollCaptureToTop', v); void window.electronAPI?.setSetting('scrollCaptureToTop', v) }}
                    label="Scroll to top first"
                  />
                </Row>
                {/* Image captures only (sendCaptureToEditor in capture.ts); on,
                    as it always was. Recordings are never copied. */}
                <Row label="Copy to clipboard" description="Lumia copies each new image so you can paste it.">
                  <Toggle
                    checked={settings.copyAfterCapture}
                    onChange={v => { update('copyAfterCapture', v); void window.electronAPI?.setSetting('copyAfterCapture', v) }}
                    label="Copy to clipboard"
                  />
                </Row>
                {/* Whether Lumia's window comes back after the capture overlay
                    (2026-11-27, Jasper's five options; claimEditorAfterCapture
                    and restoreFromOverlayCancel in electron/index.ts). After a
                    success it comes back with the editor. */}
                <Row label="Open Lumia after capturing or recording" description="Defines when Lumia's window opens after overlay closes.">
                  <Select
                    value={settings.openLumiaAfter}
                    onChange={v => { update('openLumiaAfter', v); void window.electronAPI?.setSetting('openLumiaAfter', v) }}
                    options={OPEN_LUMIA_OPTIONS}
                    label="Open Lumia after capturing or recording"
                  />
                </Row>
              </Group>
              <Group title="Editor">
                {/* The image editor's History › Edits after closing an image
                    (2026-11-23). Off stops saving and deletes the saved steps
                    (main, settings:set). */}
                <Row
                  label="Keep edit history"
                  // The "Off:" form like the other toggles; the saved size isn't
                  // shown any more, it's negligible (Jasper, 2026-11-27).
                  description="Images keep their editing steps even after the editor is closed."
                >
                  <Toggle
                    checked={settings.saveEditHistory}
                    onChange={v => {
                      update('saveEditHistory', v)
                      void window.electronAPI?.setSetting('saveEditHistory', v)
                    }}
                    label="Keep edit history"
                  />
                </Row>
                {/* Image editor panning (2026-11-24): on, the drag key (Hotkeys
                    › Image editor › Pan, Space by default) + drag pans; off,
                    the Cursor tool is the hand (Canvas.tsx). */}
                <Row label="Hold key to pan" description="Pan the image editor by holding a key, so the cursor tool can draw a selection box.">
                  <Toggle
                    checked={settings.keyToDrag}
                    onChange={v => { update('keyToDrag', v); void window.electronAPI?.setSetting('keyToDrag', v) }}
                    label="Hold key to pan"
                  />
                </Row>
              </Group>
              <Group title="Files">
                {/* Where new captures and recordings go (capture-folder.ts):
                    the path, then Change for the OS folder dialog. Files saved
                    before stay where they are. */}
                <Row label="Save to" description="Defines where Lumia saves your images and videos.">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="min-w-0 truncate text-xs font-medium text-fg-secondary" data-tip={settings.captureFolderPath}>{shortPath(settings.captureFolderPath)}</span>
                    <button
                      onClick={async () => {
                        const r = await window.electronAPI?.chooseCaptureFolder()
                        if (r?.error) { toastError(r.error, r.reason); return }
                        if (!r?.folder) return
                        update('captureFolderPath', r.folder)
                        if (r.imported) toast(r.imported === 1 ? 'Added 1 file from this folder' : `Added ${r.imported} files from this folder`, { kind: 'info' })
                        if (r.movable && r.from) setMoveOffer({ count: r.movable, from: r.from, to: r.folder })
                      }}
                      className={`${BUTTON} shrink-0`}
                    >
                      Change
                    </button>
                  </div>
                </Row>
                {/* Pruning removes the rows and unlinks the original and the
                    edited copy (HistoryStore.unlinkItemFiles), never an upload.
                    Uploaded rows go too: open question, design/DEV-QUESTIONS.md. */}
                <Row label="Delete old files" description="Defines when Lumia deletes old files and their history. Uploads stay online.">
                  <Select
                    value={settings.historyRetentionDays}
                    onChange={handleHistoryRetentionChange}
                    options={RETENTION_OPTIONS}
                    label="Delete old files"
                  />
                </Row>
              </Group>
            </div>
            {/* Outside the groups: their divide-y would draw a line on it. */}
            {moveOffer && (
              <MoveFilesDialog
                count={moveOffer.count}
                from={shortPath(moveOffer.from)}
                to={shortPath(moveOffer.to)}
                onKeep={() => setMoveOffer(null)}
                onMove={async () => {
                  const { from } = moveOffer
                  setMoveOffer(null)
                  toast('Moving files…', { kind: 'progress' })
                  try {
                    const r = await window.electronAPI?.moveCaptureFiles(from)
                    if (!r) return
                    if (r.failed > 0) toastError(r.failed === 1 ? "Couldn't move 1 file" : `Couldn't move ${r.failed} files`, r.moved > 0 ? `${r.moved} moved` : undefined)
                    else toast(r.moved === 1 ? 'Moved 1 file' : `Moved ${r.moved} files`)
                  } catch (err) {
                    toastError("Couldn't move files", err)
                  }
                }}
              />
            )}
          </Section>

          {/* Theme gets its own rework later; for now the Dashboard's
              segmented control. */}
          <Section id="appearance" title="Appearance">
            {/* Custom themes (2026-11-22): accent, then a base per mode.
                Light or dark itself is the AppBar's moon / sun. */}
            <Group>
              {/* The app bar's moon / sun (2026-11-25): hidden, the mode
                  theme is picked in the row below instead. */}
              <Row label="Show theme button" description="Switches light and dark in the app bar.">
                <Toggle
                  checked={settings.showThemeButton}
                  label="Show theme button"
                  onChange={v => {
                    update('showThemeButton', v)
                    void window.electronAPI?.setSetting('showThemeButton', v)
                    window.dispatchEvent(new CustomEvent('lumia:theme-button', { detail: v }))
                  }}
                />
              </Row>
              {!settings.showThemeButton && (
                <Row label="Choose theme">
                  <Segmented<'light' | 'dark'>
                    value={themeMode}
                    onChange={m => { if (m !== themeMode) void toggleTheme() }}
                    options={[{ key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' }]}
                  />
                </Row>
              )}
              <Row label="Choose accent" description="Selected items, on states and dots.">
                <div className="flex items-center gap-3">
                  {settings.themeAccent !== null && <ResetButton label="accent" onClick={() => pickAccent(null)} />}
                  <ColorSwatches value={settings.themeAccent} defaultColor={DEFAULTS.dark.accent} presets={ACCENT_SWATCHES} onChange={pickAccent} clamp={clampAccent} label="accent" kind="accent" onPreview={hex => previewPick('themeAccent', hex)} />
                </div>
              </Row>
              {/* Only the base of the mode on screen (2026-11-22); the other
                  mode's row shows after the moon / sun flips it. */}
              {themeMode === 'light' && <Row label="Choose light base" description="Tints the window in light mode.">
                <div className="flex items-center gap-3">
                  {settings.themeLightBase !== null && <ResetButton label="light base" onClick={() => pickLightBase(null)} />}
                  <ColorSwatches value={settings.themeLightBase} defaultColor={DEFAULTS.light.background} presets={LIGHT_BASE_SWATCHES} onChange={pickLightBase} clamp={clampLight} label="light base" kind="light" onPreview={hex => previewPick('themeLightBase', hex)} />
                </div>
              </Row>}
              {themeMode === 'dark' && <Row label="Choose dark base" description="Tints the window in dark mode.">
                <div className="flex items-center gap-3">
                  {settings.themeDarkBase !== null && <ResetButton label="dark base" onClick={() => pickDarkBase(null)} />}
                  <ColorSwatches value={settings.themeDarkBase} defaultColor={DEFAULTS.dark.background} presets={DARK_BASE_SWATCHES} onChange={pickDarkBase} clamp={clampDark} label="dark base" kind="dark" onPreview={hex => previewPick('themeDarkBase', hex)} />
                </div>
              </Row>}
            </Group>
          </Section>

          {/* Named for what it's for, not the one service in it (2026-11-22);
              each destination is a captioned group, like the hotkeys'. */}
          {settings.googleDriveAvailable && <Section id="uploads" title="Uploads">
            <h3 className="mb-1.5 px-1 text-xs font-medium text-fg-secondary">Google Drive</h3>
            <Group>
              <Row
                label="Connect your account"
                description={
                  gdriveConnecting ? 'Waiting for you to sign in in the browser.'
                  : gdriveConnected ? (
                    <span className="inline-flex items-center gap-1 text-success-text">
                      <Icon name="check_circle" className="text-[14px]" />
                      Connected
                    </span>
                  ) : 'Sign in with your Google account.'
                }
              >
                {gdriveConnecting ? (
                  <button onClick={handleGdriveCancelAuth} className={BUTTON}>Cancel</button>
                ) : gdriveConnected ? (
                  // Two-step disconnect: the first click arms it for 3s.
                  <button
                    onClick={handleGdriveDisconnect}
                    onBlur={() => {
                      if (disconnectConfirmTimerRef.current) clearTimeout(disconnectConfirmTimerRef.current)
                      setConfirmingDisconnect(false)
                    }}
                    // DANGER_BUTTON (grey, red under the pointer, like every
                    // delete); armed, red on the danger-subtle fill.
                    className={confirmingDisconnect
                      ? 'h-8 px-2.5 inline-flex items-center rounded-lg border border-line bg-danger-subtle text-xs font-medium text-danger-text hover:text-danger-text-hover flex-shrink-0'
                      : DANGER_BUTTON}
                  >
                    {confirmingDisconnect ? 'Confirm disconnect' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    onClick={handleGdriveAuth}
                    className={ACCENT_BUTTON}
                  >
                    Connect
                  </button>
                )}
              </Row>
              <Row
                label="Choose folder"
                description={
                  !gdriveConnected ? 'Connect an account first.'
                  : !folderId ? <span className="text-warning-text">Pick a folder. Drive uploads fail without one.</span>
                  : folderName === undefined ? 'Looking up…'
                  : <span className="select-text">{folderName ?? folderId}</span>
                }
              >
                {gdrivePicking ? (
                  <button onClick={handleGdriveCancelPickFolder} className={BUTTON}>Cancel</button>
                ) : (
                  <button onClick={handleGdrivePickFolder} disabled={!gdriveConnected} className={BUTTON}>
                    Browse
                  </button>
                )}
              </Row>
            </Group>
          </Section>}

          <Section id="hotkeys" title="Hotkeys">
            <div className="space-y-4">
              <HotkeyEditor
                trayActions={settings.trayActions}
                onTrayActionsChange={next => {
                  update('trayActions', next)
                  void window.electronAPI?.setSetting('trayActions', next)
                }}
              />
              {/* The editors' keys, changeable like the capture shortcuts
                  (2026-11-24; read-only lists until then). */}
              <EditorKeyEditor kind="image" title="Image editor" keyToDrag={settings.keyToDrag} />
              <EditorKeyEditor kind="video" title="Video editor" keyToDrag={settings.keyToDrag} />
            </div>
          </Section>

          {/* The wallpaper browser (WallpapersSection.tsx): the AppBar's
              page until 2026-11-20, then a page opened from here, in the
              section itself since 2026-11-25. Always shown since then:
              photos come from Wikimedia Commons or Wallhaven, picked in
              the section (no key needed). */}
          <Section id="wallpapers" title="Wallpapers">
            <WallpapersSection />
          </Section>

          {/* Release notes bundled with the app (src/whats-new.ts), newest
              first; the installed version is marked. */}
          <Section id="whats-new" title="Release notes">
            <div className="space-y-4">
              {releaseGroups.filter(r => showOlderReleases || !r.merged).map((r) => {
                const open = (!!badgedRelease && r.versions.includes(badgedRelease)) !== flippedReleases.has(r.key)
                const caption = (
                  <>
                    <span>
                      {/* Older lines by their minor line ("Version 2.4"), the current line's releases by their full number. */}
                      {r.merged ? `Version ${r.key.split('.').slice(0, 2).join('.')}` : `Version ${r.key}`}
                      {r.versions.includes(shownVersion) && ' (installed)'}
                    </span>
                    {badges.notesDot && r.versions.includes(badges.installedVersion) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                    )}
                  </>
                )
                return (
                <div key={r.key}>
                  {/* No date (2026-11-22). The new release's dot follows the
                      caption's text (the far right end was tried); it goes
                      with the nav item's. The caption is a button with a
                      chevron (right = closed, down = open), grey turning fg
                      on hover like the segments. */}
                  <h3 className={`${open ? 'mb-1.5' : ''} text-xs font-medium text-fg-secondary tabular-nums`}>
                    <button
                      type="button"
                      onClick={() => toggleRelease(r.key)}
                      aria-expanded={open}
                      // The fold caption's spacing (CollapsibleGroup's):
                      // gap-1, the chevron flush with the caption's px-1.
                      className="px-1 flex items-center gap-1 text-fg-secondary hover:text-fg"
                    >
                      <Icon name={open ? 'expand_more' : 'chevron_right'} className="text-[14px]" />
                      {caption}
                    </button>
                  </h3>
                  {open && (<>
                  {/* One cell per release, its notes as a bulleted list (a
                      row per note was tried). Selectable, to copy a note;
                      I-beam over it, per the macOS pointer rules.
                      Selection fix (2026-11-22): a drag started beside a
                      line used to select from the first line's start
                      (the press landed on the list itself, or on a native
                      ::marker, not on a line). So the list has no padding
                      or gaps of its own: each line's block spans the cell's
                      full width and carries the spacing as padding, and the
                      bullets are drawn ::before (not selectable) instead
                      of list markers. */}
                  <Group>
                    <ul className="py-1.5 text-[11px] leading-4 text-fg-secondary select-text cursor-text">
                      {r.notes.map((note, i) => (
                        // A short bold call-out, a sentence, and sub-points
                        // when there's more (whats-new.ts › format).
                        // A 14px icon in place of the bullet says what kind
                        // of change it is (2026-11-22): sparkle = new,
                        // wand = improved (final 2026-11-23; trending up
                        // and gauge dropped), bug = fix, wrench =
                        // maintenance. (The nav's Sparkles means Release notes.) Not
                        // selectable, like the bullets were.
                        <li key={i} className="relative pl-7 pr-3 py-1">
                          <Icon
                            name={note.kind === 'fix' ? 'bug_report' : note.kind === 'internal' ? 'build' : note.kind === 'improve' ? 'auto_fix_high' : 'sparkle'}
                            title={note.kind === 'fix' ? 'Fix' : note.kind === 'internal' ? 'Maintenance' : note.kind === 'improve' ? 'Improved' : 'New'}
                            // 10px with a 0.75px line (Jasper, 2026-11-22): an
                            // exception to the four icon sizes and the fixed
                            // line widths, so the marks stay as quiet as the
                            // bullets they replace. The ! beats .icon's own
                            // stroke rule. Centred on the first line: 4px
                            // padding + half the 16px line - half the icon =
                            // 7px (0.5lh measured the icon's own, smaller
                            // line height and sat it high).
                            className="absolute left-3.5 top-[7px] text-[10px] text-fg-tertiary select-none [stroke-width:0.75px]!"
                          />
                          {/* A colon when a sentence or a sub-list follows (a lead-in to a list takes one). */}
                          <span className="font-semibold text-fg">{note.title}{(note.text || note.points) && ':'}</span>
                          {note.text && <> {note.text}</>}
                          {note.points && (
                            <ul className="pt-1">
                              {note.points.map((p, j) => (
                                <li key={j} className="relative pl-4 py-0.5 before:content-[''] before:absolute before:left-0.5 before:top-[calc(0.125rem+0.5lh-2px)] before:w-1 before:h-1 before:rounded-full before:border before:border-fg-tertiary">
                                  {p}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Group>
                  </>)}
                </div>
                )
              })}
              {/* Show more / Show less for the older lines (2026-11-22),
                  under the current line's folds, styled like a caption. */}
              {releaseGroups.some(r => r.merged) && (
                <button
                  type="button"
                  onClick={() => setShowOlderReleases(v => !v)}
                  aria-expanded={showOlderReleases}
                  // block: inline, it sat in a line box with the parent's
                  // taller line height, which pushed it further down than
                  // the gap between the folds.
                  // Control rank (12px medium), like the fold captions above it.
                  className="block px-1 text-xs font-medium text-fg-secondary hover:text-fg"
                >
                  {showOlderReleases ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          </Section>

          {/* No logo or name: the AppBar shows both on every page. */}
          <Section id="about" title="About">
            <Group>
              {/* The version, and a newer one when Lumia's own checks find
                  it (no manual check since 2026-11-22). Then step by step
                  with the user's consent: Update downloads it, Restart
                  installs it. Both carry the new-things dot (like a changed
                  hotkey's); it goes with the install. Same title in every
                  state; installs that can't update themselves just show it. */}
              {/* With its release date from the release notes (2026-11-24),
                  as the list view writes dates; a version with no entry
                  there (an unreleased dev build) shows the number only. */}
              <Row
                label={`Version ${shownVersion}${shownDate ? `, released ${shownDate}` : ''}`}
                description={!autoUpdateAvailable ? undefined
                  : badges.update ? `Version ${badges.update.version} ${
                    badges.update.phase === 'available' ? 'is available'
                    : badges.update.phase === 'downloading' ? 'is downloading'
                    : 'is ready'
                  }`
                  // Only once a check has said so (none after a failed
                  // check, none in dev builds, which never check).
                  : badges.latest ? 'Latest version' : undefined}
              >
                {autoUpdateAvailable && badges.update && (badges.update.phase === 'downloading' ? (
                  <button disabled className={BUTTON}>Updating…</button>
                ) : (
                  <button onClick={badges.update.phase === 'ready' ? installUpdate : downloadUpdate} className={`${BUTTON} relative`}>
                    {badges.update.phase === 'ready' ? 'Restart' : 'Update'}
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent pointer-events-none" />
                  </button>
                ))}
                {/* Latest version: Update shown disabled, so the button's
                    place reads the same in every state. Same condition as
                    the "Latest version" subtitle. */}
                {autoUpdateAvailable && !badges.update && badges.latest && (
                  <button disabled className={BUTTON}>Update</button>
                )}
              </Row>
              {autoUpdateAvailable && (
                // The user's opt-in to silent updates (main:
                // applyAutoUpdateSetting): found versions download by
                // themselves and install once Lumia has sat hidden for 30s,
                // never mid-recording.
                <Row
                  label="Auto-update Lumia"
                  description={platform === 'darwin'
                    ? 'Automatically downloads and installs updates while Lumia is in the menu bar.'
                    : 'Automatically downloads and installs updates while Lumia is in the system tray.'}
                >
                  <Toggle checked={settings.autoUpdateWhenHidden} onChange={handleAutoUpdateWhenHiddenChange} label="Auto-update Lumia" />
                </Row>
              )}
              <Row
                label="View licenses"
                description={licensesError
                  ? <span className="text-danger-text">{licensesError}</span>
                  : 'Open-source software Lumia includes.'}
              >
                <button
                  onClick={async () => {
                    const res = await window.electronAPI?.openLicenses()
                    setLicensesError(res && 'error' in res ? res.error : '')
                  }}
                  className={BUTTON}
                >
                  {platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'}
                </button>
              </Row>
              <Row label="Find log files" description="Attach them to a bug report.">
                <button onClick={() => window.electronAPI?.showLogs()} className={BUTTON}>
                  {platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'}
                </button>
              </Row>
            </Group>
          </Section>



        </div>
      </div>
    </div>
  )
}

const HOTKEY_GROUPS: { title: string; note?: string; rows: { action: string; label: string }[] }[] = [
  {
    title: 'Image',
    rows: [
      { action: 'RectangleRegion', label: 'Capture region' },
      { action: 'ActiveWindow',    label: 'Capture window' },
      { action: 'ActiveMonitor',   label: 'Capture full screen' },
      { action: 'PrintScreen',     label: 'Capture all screens' },
      { action: 'ScrollingCapture', label: 'Capture scroll' },
    ],
  },
  {
    title: 'Video',
    // Any video hotkey stops a recording in progress.
    note: 'Press again to stop recording',
    rows: [
      { action: 'ScreenRecorder',       label: 'Record region' },
      { action: 'ScreenRecorderWindow', label: 'Record window' },
      { action: 'ScreenRecorderScreen', label: 'Record screen' },
    ],
  },
]

// Capture accelerators and editor keys share one format and one recorder
// (src/lib/editor-keys.ts, 2026-11-24).
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

function eventToAccelerator(e: KeyboardEvent): string | null {
  return eventToBinding(e, IS_MAC)
}

function isAcceleratorValid(accel: string): boolean {
  // F-keys are fine alone; everything else needs at least one modifier so it
  // doesn't steal a plain keystroke globally.
  if (/^F\d{1,2}$/.test(accel)) return true
  return /\+/.test(accel) && /^(Ctrl|Cmd|Super|Alt|Shift)\+/.test(accel)
}

function HotkeyEditor({ trayActions, onTrayActionsChange }: {
  /** The actions in the menu-bar icon's menu (2026-11-27), switched per row. */
  trayActions: string[]
  onTrayActionsChange: (next: string[]) => void
}) {
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})
  const [recordingAction, setRecordingAction] = useState<string | null>(null)
  const [error, setError] = useState<string>('')
  // The built-in bindings, to mark rows whose shortcut was changed.
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  useSingleRecorder(recordingAction !== null, () => setRecordingAction(null))

  useEffect(() => {
    window.electronAPI?.getHotkeys().then(h => { if (h) setHotkeys(h) })
    window.electronAPI?.getDefaultHotkeys().then(d => { if (d) setDefaults(d) })
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
      if (!accel) return // pure modifier press, keep listening
      if (!isAcceleratorValid(accel)) {
        setError('Add Ctrl, Cmd, Alt or Shift, or use an F-key.')
        return
      }
      const dupe = Object.entries(hotkeys).find(([a, k]) => a !== recordingAction && k === accel)
      if (dupe) {
        const dupeLabel = HOTKEY_GROUPS.flatMap(g => g.rows).find(r => r.action === dupe[0])?.label ?? dupe[0]
        setError(`${accel} is already used by ${dupeLabel}.`)
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

  // One row back to its default. Refused while another row holds that
  // default (two actions can't share a shortcut).
  const resetOne = (action: string) => {
    const accel = defaults[action]
    if (!accel) return
    const holder = Object.entries(hotkeys).find(([a, k]) => a !== action && k === accel)
    if (holder) {
      const holderLabel = HOTKEY_GROUPS.flatMap(g => g.rows).find(r => r.action === holder[0])?.label ?? holder[0]
      setError(`${accel} is used by ${holderLabel}. Change that one first.`)
      return
    }
    const next = { ...hotkeys, [action]: accel }
    setHotkeys(next)
    setRecordingAction(null)
    setError('')
    window.electronAPI?.setHotkeys(next).then(saved => { if (saved) setHotkeys(saved) })
  }

  return (
    <div className="space-y-4">
      {HOTKEY_GROUPS.map(({ title, note, rows }) => (
        <CollapsibleGroup key={title} title={title} note={note} hint="Switch an action on to add it to the menu bar icon's menu.">
            {rows.map(({ action, label }) => {
              const isRecording = recordingAction === action
              const current = hotkeys[action] ?? ''
              const changed = !!defaults[action] && current !== defaults[action]
              return (
                <Row key={action} label={label}>
                  <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Changed rows get a reset button left of the shortcut
                      (framed icon button, like the AppBar's). */}
                  {changed && (
                    <button
                      type="button"
                      onClick={() => resetOne(action)}
                      data-tip="Reset"
                      aria-label={`Reset ${label} to ${defaults[action]}`}
                      className={RESET_BUTTON}
                    >
                      <Icon name="restart_alt" className="text-[16px]" />
                    </button>
                  )}
                  <ShortcutButton
                    binding={current}
                    recording={isRecording}
                    label={label}
                    onClick={() => {
                      setError('')
                      setRecordingAction(isRecording ? null : action)
                    }}
                    onCancel={() => { setRecordingAction(null); setError('') }}
                  />
                  {/* In the menu-bar icon's menu (2026-11-27; a separate
                      Settings group felt clumsy): 12px after the shortcut. */}
                  <span data-tip="Menu bar" className="ml-1 flex">
                    <Toggle
                      checked={trayActions.includes(action)}
                      onChange={v => onTrayActionsChange(
                        HOTKEY_GROUPS.flatMap(g => g.rows).map(r => r.action)
                          .filter(a => a === action ? v : trayActions.includes(a)),
                      )}
                      label={`Show ${label} in the menu bar`}
                    />
                  </span>
                  </div>
                </Row>
              )
            })}
        </CollapsibleGroup>
      ))}
      {/* No how-to line and no reset-all (2026-11-22): the waiting button
          says "Press keys" with an "Esc cancels" tooltip, the video note
          sits in its caption, and each changed row has its own reset. */}
      {/* Body rank's size, in danger-text (Jasper, 2026-11-27; grey was tried). */}
      {error && <p className="px-1 text-xs text-danger-text">{error}</p>}
    </div>
  )
}

/** A shortcut as keycaps (2026-11-24: capture shortcuts took the editor
 *  lists' look, ⌘ ⌥ ⌃ ⇧ on macOS); a click starts recording. While it
 *  listens it's a 32px framed button in the on state: "Press keys" in `fg`
 *  and the 3px accent strip along its bottom edge, masked inside the border
 *  (like Select in select mode; it was an accent-text keycap the same day).
 *  A press anywhere else cancels (`onCancel`), as Esc does. Hover: the caps
 *  step up their fill and text, as a framed button does. */
function ShortcutButton({ binding, recording, label, hold, onClick, onCancel }: {
  binding: string
  recording: boolean
  label: string
  /** A key held while dragging (Pan, straight line): "(hold)" before the
   *  keycaps (2026-11-24). */
  hold?: boolean
  onClick: () => void
  onCancel: () => void
}) {
  const caps = keycapsOf(binding, IS_MAC)
  const ref = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    if (!recording) return
    // Capture phase, so a press on another row's keycaps cancels this one
    // before its own click starts recording there.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) cancelRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [recording])
  // Keycaps at the framed buttons' size (2026-11-24; 24px, 6px corners
  // before): 32px tall, at least square, 8px corners.
  const CAP = 'min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-lg bg-elevated border border-line text-xs font-medium tabular-nums group-hover/keys:bg-elevated-hover'
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={recording}
      aria-label={recording ? `Recording a shortcut for ${label}` : `Change ${label}${binding ? `, now ${binding}` : ''}`}
      data-tip={recording ? 'Esc cancels' : undefined}
      className="group/keys group/on flex items-center gap-1 rounded-md flex-shrink-0"
    >
      {hold && <span className="mr-1 text-xs font-medium text-fg-tertiary">(hold)</span>}
      {recording ? (
        <span className="relative h-8 px-2.5 inline-flex items-center rounded-lg bg-elevated border border-line text-xs font-medium text-fg group-hover/keys:bg-elevated-hover">
          Press keys
          <OnStrip />
        </span>
      ) : caps.length ? (
        caps.map((c, i) => (
          <kbd key={i} className={`${CAP} text-fg-secondary group-hover/keys:text-fg`} style={{ fontFamily: 'inherit' }}>{c}</kbd>
        ))
      ) : (
        <span className={`${CAP} text-fg-tertiary group-hover/keys:text-fg`}>Not set</span>
      )}
    </button>
  )
}

/** One shortcut records at a time across the capture and editor groups:
 *  starting one tells the others to stop (their key listeners would all
 *  catch the same press). */
const RECORD_EVENT = 'lumia:shortcut-record'
function useSingleRecorder(active: boolean, stop: () => void) {
  const token = useRef(Math.random().toString(36))
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail !== token.current) stopRef.current() }
    window.addEventListener(RECORD_EVENT, on)
    return () => window.removeEventListener(RECORD_EVENT, on)
  }, [])
  useEffect(() => {
    if (active) window.dispatchEvent(new CustomEvent(RECORD_EVENT, { detail: token.current }))
  }, [active])
}

/** A keycap that can't be changed (the Pan row's drags): a changeable
 *  one's look without its hover. */
const FIXED_CAP = 'min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-lg bg-elevated border border-line text-xs font-medium text-fg-secondary'

const RESET_BUTTON = ICON_BUTTON

/** One editor's keys (Settings › Hotkeys › Image editor / Video editor,
 *  2026-11-24), changeable like the capture shortcuts. Press keys take any
 *  key, with or without modifiers; hold keys (pan, straight line) take one
 *  key on its own: a modifier, recorded when it's let go with nothing else
 *  pressed, or a plain key. Refused: a key another action of this editor
 *  uses, a capture shortcut (it would fire instead), and for Pan the select
 *  modifier (⌘ / Ctrl adds shapes to the selection). Only changed keys are
 *  stored (`editorKeys`). The Pan row shows while General › Hold key to pan
 *  is on. */
function EditorKeyEditor({ kind, title, keyToDrag }: { kind: EditorKind; title: string; keyToDrag: boolean }) {
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [captureKeys, setCaptureKeys] = useState<Record<string, string>>({})
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  const map = useMemo(() => resolveKeymap(kind, overrides, IS_MAC), [kind, overrides])
  useSingleRecorder(recording !== null, () => setRecording(null))
  const defaults = useMemo(() => defaultKeymap(kind, IS_MAC), [kind])

  useEffect(() => {
    window.electronAPI?.getSettings().then(s => setOverrides(s?.editorKeys?.[kind] ?? {}))
  }, [kind])
  // Capture shortcuts, re-read when recording starts (they may have just
  // changed above).
  useEffect(() => {
    if (recording) window.electronAPI?.getHotkeys().then(h => { if (h) setCaptureKeys(h) })
  }, [recording])

  const save = (next: Record<string, string>) => {
    const stored = overridesOf(kind, next, IS_MAC)
    setOverrides(stored)
    void window.electronAPI?.getSettings().then(s => {
      void window.electronAPI?.setSetting('editorKeys', { ...(s?.editorKeys ?? {}), [kind]: stored })
    })
  }

  // Why `binding` can't go on action `id`, or '' if it can.
  const refusal = (id: string, binding: string): string => {
    const text = keycapsOf(binding, IS_MAC).join(IS_MAC ? '' : '+')
    if (id === 'pan' && binding === selectModifier(IS_MAC)) return `${text} adds shapes to the selection.`
    const other = conflictOf(map, id, binding)
    if (other) return `${text} is already used by ${labelOf(kind, other)}.`
    const capture = Object.entries(captureKeys).find(([, k]) => k === binding)?.[0]
    if (capture) {
      const name = HOTKEY_GROUPS.flatMap(g => g.rows).find(r => r.action === capture)?.label ?? capture
      return `${text} is used by ${name}.`
    }
    return ''
  }

  useEffect(() => {
    if (!recording) return
    const action = keyActions(kind).find(a => a.id === recording)
    if (!action) return
    void window.electronAPI?.setHotkeyRecording(true)
    // A hold key's modifier, recorded on release if nothing else was pressed.
    let pendingModifier: string | null = null
    const commit = (binding: string) => {
      const why = refusal(recording, binding)
      if (why) { setError(why); return }
      save({ ...map, [recording]: binding })
      setRecording(null)
      setError('')
    }
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (e.code === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecording(null)
        setError('')
        return
      }
      if (action.hold) {
        const mod = modifierName(e.key, IS_MAC)
        if (mod) { pendingModifier = pendingModifier ? null : mod; return }
        pendingModifier = null
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
          setError('Use one key on its own, a modifier or a plain key.')
          return
        }
        const key = codeToKey(e.code)
        if (key) commit(key)
        return
      }
      const binding = eventToBinding(e, IS_MAC)
      if (binding) commit(binding)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!action.hold || !pendingModifier) return
      if (modifierName(e.key, IS_MAC) === pendingModifier) commit(pendingModifier)
      pendingModifier = null
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      void window.electronAPI?.setHotkeyRecording(false)
    }
  // refusal / save read the latest map and capture keys through this render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, map, captureKeys])

  // One row back to its default; refused while another action holds it.
  const resetOne = (id: string) => {
    const binding = defaults[id]
    const other = conflictOf(map, id, binding)
    if (other) {
      setError(`${keycapsOf(binding, IS_MAC).join(IS_MAC ? '' : '+')} is used by ${labelOf(kind, other)}. Change that one first.`)
      return
    }
    save({ ...map, [id]: binding })
    setRecording(null)
    setError('')
  }

  return (
    <div>
      <CollapsibleGroup title={title}>
        {keyActions(kind).map(({ id, label, hold }) => {
          const changed = map[id] !== defaults[id]
          // Pan (2026-11-27): one row, "(hold) Space + Left-drag or
          // Right-drag"; only the key changes. Right-drag pans in every tool
          // (Canvas.tsx); the key + left drag only with General › Hold key to
          // pan on, so without it the row is Right-drag alone.
          if (id === 'pan' && !keyToDrag) {
            return (
              <Row key={id} label={label}>
                <div className="flex items-center gap-1 flex-shrink-0"><kbd className={FIXED_CAP} style={{ fontFamily: 'inherit' }}>Right-drag</kbd></div>
              </Row>
            )
          }
          return (
            <Row key={id} label={label}>
              <div className="flex items-center gap-2 flex-shrink-0">
                {changed && (
                  <button type="button" onClick={() => resetOne(id)} data-tip="Reset" aria-label={`Reset ${label} to ${defaults[id]}`} className={RESET_BUTTON}>
                    <Icon name="restart_alt" className="text-[16px]" />
                  </button>
                )}
                <ShortcutButton
                  binding={map[id]}
                  recording={recording === id}
                  label={label}
                  hold={hold}
                  onClick={() => { setError(''); setRecording(recording === id ? null : id) }}
                  onCancel={() => { setRecording(null); setError('') }}
                />
                {id === 'pan' && <>
                  <kbd className={FIXED_CAP} style={{ fontFamily: 'inherit' }}>Left-drag</kbd>
                  <span className="mx-1 text-xs font-medium text-fg-tertiary">or</span>
                  <kbd className={FIXED_CAP} style={{ fontFamily: 'inherit' }}>Right-drag</kbd>
                </>}
              </div>
            </Row>
          )
        })}
      </CollapsibleGroup>
      {error && <p className="mt-2 px-1 text-xs text-danger-text">{error}</p>}
    </div>
  )
}

/** A section: its heading (the nav's scroll target) over its content. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-5">
      <h2 className="mb-2 px-1 text-sm font-semibold text-fg">{title}</h2>
      {children}
    </section>
  )
}

/** A captioned Group whose caption folds it (the Hotkeys section,
 *  2026-11-23). Starts collapsed on every visit; not remembered. */
function CollapsibleGroup({ title, note, hint, children }: {
  title: string
  note?: string
  /** A line under the open caption (2026-11-27: the hotkeys' menu-bar
   *  switches, said in each group so it isn't missed). */
  hint?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={`${open ? 'mb-1.5 ' : ''}px-1 flex items-center gap-1 text-xs font-medium text-fg-secondary hover:text-fg`}
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} className="text-[14px]" />
        {/* The note (Video's "press again to stop recording") only while open, in parentheses (2026-11-24; a " · " divider before). */}
        {open && note ? `${title} (${note[0].toLowerCase()}${note.slice(1)})` : title}
      </button>
      {open && hint && <p className="-mt-0.5 mb-1.5 px-1 text-[10px] font-medium text-fg-secondary">{hint}</p>}
      {open && <Group>{children}</Group>}
    </div>
  )
}




/** The hotkeys editor's reset button: back to the default. */
function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tip="Reset"
      aria-label={`Reset ${label} to default`}
      className={ICON_BUTTON}
    >
      <Icon name="restart_alt" className="text-[16px]" />
    </button>
  )
}

