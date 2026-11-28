import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import logo from '../assets/logo.svg'
import { Icon } from './Icon'
import { useTheme } from '../hooks/useTheme'
import { useAppBarCloseTo, useAppBarReturnId, useAppBarSlotRef } from './AppBarSlot'
import { editorStateFor } from '../lib/history-actions'
import { useBadges } from '../lib/app-badges'
import { ICON_BUTTON_FRAME, ICON_LINK } from './button-classes'
import { OnStrip } from './OnStrip'

const isMac = window.electronAPI?.platform === 'darwin'

// Framed like the page's controls next to them (the Dashboard's Select and
// filters): 32px, bg-elevated, border-line, 16px icon. (Settings' on state
// on its own page is the accent icon + bottom strip, below.)
// ICON_LINK: the shared framed button with a plain `hover:` (Back and
// Settings are links, which `:enabled` never matches).
const iconButton = () => ICON_LINK

/** The window's top bar on every page but the editor, and its drag region.
 *  macOS: 53px (52px + the edge line, 2026-11-23), the traffic lights (20,19; 14px circles, centred on the bar) sit at its left, the app name
 *  starts 16px after them (x 96). Windows: 40px, the right 128px are kept free for the
 *  native window controls (titleBarOverlay). Left: icon + name (1.5x size),
 *  back to the Dashboard. Right: a slot the page fills with its own controls
 *  (the Dashboard's filters, see AppBarSlot), then theme and Settings. */
export function AppBar() {
  const { mode, toggle } = useTheme()
  // Settings › Appearance › Show theme button (2026-11-25).
  const [showTheme, setShowTheme] = useState(true)
  useEffect(() => {
    window.electronAPI?.getSettings().then(s => setShowTheme(s.showThemeButton !== false))
    const onChange = (e: Event) => setShowTheme((e as CustomEvent<boolean>).detail)
    window.addEventListener('lumia:theme-button', onChange)
    return () => window.removeEventListener('lumia:theme-button', onChange)
  }, [])
  const slotRef = useAppBarSlotRef()
  const closeTo = useAppBarCloseTo()
  const returnId = useAppBarReturnId()
  const location = useLocation()
  const navigate = useNavigate()
  // Settings opened from the editor (2026-11-23): its close reopens that
  // row in the editor, as it is now (edits, trim), else the Dashboard.
  const editorReturn = (location.state as { returnToEditor?: string } | null)?.returnToEditor
  const closeSettings = async (e: React.MouseEvent) => {
    if (!editorReturn) return
    e.preventDefault()
    // Any failure (row gone, lookup failed) still closes, to the Dashboard.
    let state: Record<string, unknown> | null = null
    try {
      const item = await window.electronAPI?.getHistoryItem(editorReturn)
      state = item ? await editorStateFor(item) : null
    } catch (err) {
      console.warn('[appbar] return to editor failed', err)
    }
    navigate(state ? '/editor' : '/dashboard', state ? { state } : undefined)
  }
  const { settingsDot } = useBadges()
  const path = location.pathname
  const onSettings = path === '/settings'


  const themeIcon = mode === 'dark' ? 'dark_mode' : 'light_mode'
  const themeLabel = mode === 'dark' ? 'Dark' : 'Light'

  return (
    // Windows (2026-11-23, final): 52px like macOS (was 40), and
    // mirrored: the app's buttons (Settings, Theme) then the page's controls
    // on the left, the logo on the right next to the native window controls
    // (titleBarOverlay, ~138px wide; pr-[160px] leaves ~20px before them).
    <header
      // 53px (2026-11-23): 52px of content, then the 1px edge line inside
      // the bar's bottom (pb-px), so the buttons sit exactly centred in the
      // space above the line (10px above and below). At 52px with the line
      // inside, they sat 0.5px low. The traffic lights (y 19) and the
      // Windows controls (52px) centre on those same top 52px.
      className={`relative z-10 edge-b flex-shrink-0 flex items-center justify-between app-drag select-none bg-toolbar h-[53px] pb-px ${
        isMac ? 'pl-24 pr-5' : 'flex-row-reverse pl-5 pr-[160px]'
      }`}
    >
      {/* Left, right after the traffic lights on macOS (moved from the
          window's centre, 2026-11-20): the bar's pl-24 puts the logo at
          x 96, gap-4 (16px) after the green light, which ends at x 80. */}
      {/* Not a link any more (2026-11-22; it led to the Dashboard, whose
          other way back is the Settings gear, which now closes Settings).
          Part of the window's drag area like the rest of the bar. A hover
          animation (a spin, then a moving camera shutter) was tried and
          dropped. */}
      <div className={`flex items-center gap-1.5 h-10 ${isMac ? 'pr-2.5' : 'pl-2.5'}`}>
        <img src={logo} alt="" className="w-[30px] h-[30px] rounded-lg flex-shrink-0" draggable={false} />
        <span className="text-[21px] leading-none font-extrabold text-fg select-none">Lumia</span>
      </div>

      {/* Right: the page's controls (empty on most pages), then the app's
          own buttons. gap-10 between the two groups, well over the gap-3
          inside each (gap-2 until 2026-11-21: the missing-files badge on
          its button's corner crowded Select), so they read as separate
          sets. */}
      <div className={`flex items-center gap-10 ${isMac ? '' : 'flex-row-reverse'}`}>
      {/* A page shown as a pop-over (the editor) gets a Back arrow as its
          own group at the start of the right side, gap-10 before the page's
          controls; the gear stays (2026-11-23; it replaced the gear before). */}
      {closeTo && (
        <NavLink to={closeTo} className={iconButton()} data-tip="Back" aria-label="Back to Dashboard">
          <Icon name="arrow_back" className="text-[16px]" />
        </NavLink>
      )}
      <div ref={slotRef} className="flex items-center gap-3 empty:hidden" />
      <div className={`flex items-center gap-3 ${isMac ? '' : 'flex-row-reverse'}`}>
        {showTheme && <button onClick={toggle} className={iconButton()} data-tip="Theme" aria-label={`Theme: ${themeLabel}`}>
          {/* Final 2026-11-23: the moon and sun as a plain filter
              button icon, no fill, outline in the button's grey, fg under
              the pointer (from the button's classes). Before: filled in the
              accent (2026-11-20), with 1px grey outlines on the moon and the
              sun's disc and purple rays, then all purple. Tried and dropped:
              no outlines, grey rays, a lighter purple outline on the disc,
              Lucide's own Moon. */}
          <Icon name={themeIcon} className="text-[16px]" />
        </button>}
        {/* On the Settings page (2026-11-22) the gear stays
            and shows as on, like the Dashboard's Select in select mode: the
            icon in fg (not the accent: on/off icons stay neutral, the strip
            says on; 2026-11-22) and a 3px accent strip along the bottom
            edge, masked inside the border. A click goes back to the Dashboard,
            tooltip "Close". Was (2026-11-20): it turned into a grey Back
            arrow linking to the Dashboard. */}
        {onSettings ? (
          <NavLink
            to="/dashboard"
            onClick={closeSettings}
            className={`${ICON_BUTTON_FRAME} group/set group/on relative text-fg hover:bg-elevated-hover`}
            data-tip="Close"
            aria-label="Close Settings"
            aria-current="page"
          >
            <Icon name="settings" className="text-[16px]" />
            {/* Something new in Settings: the same dot as on the off gear. */}
            {settingsDot && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent group-hover/set:bg-accent-text-hover pointer-events-none" />}
            <OnStrip />
          </NavLink>
        ) : (
          <NavLink to="/settings" state={returnId ? { returnToEditor: returnId } : undefined} className={`${iconButton()} relative`} data-tip="Settings" aria-label={settingsDot ? 'Settings, something new' : 'Settings'}>
            <Icon name="settings" className="text-[16px]" />
            {/* Something new inside (unseen release notes, a downloaded
                update): a 6px accent dot inside the top-right corner, like
                a changed hotkey's. The on-state gear (Settings page) shows
                it too. */}
            {settingsDot && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent pointer-events-none" />}
          </NavLink>
        )}
      </div>
      </div>
    </header>
  )
}
