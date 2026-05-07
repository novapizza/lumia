import { NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import logo from '../assets/logo.png'

type ThemeMode = 'dark' | 'light' | 'system'

interface NavItem { to: string; icon: string; label: string }

const NAV_DASHBOARD: NavItem = { to: '/dashboard',  icon: 'space_dashboard', label: 'Dashboard' }
const NAV_WALLPAPERS: NavItem = { to: '/wallpapers', icon: 'wallpaper',       label: 'Wallpapers' }
// Workflow tab hidden temporarily — route still wired, reachable via /#/workflow.
// const NAV_WORKFLOW: NavItem = { to: '/workflow',  icon: 'rocket_launch',    label: 'Workflow' }
const NAV_SETTINGS: NavItem = { to: '/settings',   icon: 'settings',         label: 'Settings' }

function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

export function Sidebar() {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  // Wallpapers is gated behind MAIN_VITE_UNSPLASH_ACCESS_KEY at build time —
  // when the key is absent, the whole feature is dead weight, so hide the
  // sidebar entry entirely. Initial value true so the entry doesn't flash
  // hidden→shown for the common case (key present); the only flicker is the
  // entry briefly appearing on launch for keyless builds, which is acceptable.
  const [wallpapersEnabled, setWallpapersEnabled] = useState(true)

  useEffect(() => {
    window.electronAPI?.wallpapersIsConfigured?.().then(setWallpapersEnabled)
  }, [])

  const navItems: NavItem[] = [
    NAV_DASHBOARD,
    ...(wallpapersEnabled ? [NAV_WALLPAPERS] : []),
    NAV_SETTINGS,
  ]

  const applyTheme = (resolved: 'dark' | 'light') => {
    if (resolved === 'light') {
      document.documentElement.classList.add('light')
    } else {
      document.documentElement.classList.remove('light')
    }
  }

  useEffect(() => {
    window.electronAPI?.getSettings().then(s => {
      const mode = s.theme ?? 'system'
      setThemeMode(mode)
      applyTheme(resolveTheme(mode))
      window.electronAPI?.setTitleBarTheme(mode)
    })
  }, [])

  // Listen for OS theme changes when mode is 'system'
  useEffect(() => {
    if (themeMode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      applyTheme(e.matches ? 'dark' : 'light')
      window.electronAPI?.setTitleBarTheme('system')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [themeMode])

  const cycleTheme = async () => {
    const order: ThemeMode[] = ['dark', 'light', 'system']
    const idx = order.indexOf(themeMode)
    const next = order[(idx + 1) % order.length]
    setThemeMode(next)
    applyTheme(resolveTheme(next))
    await window.electronAPI?.setSetting('theme', next)
    window.electronAPI?.setTitleBarTheme(next)
    window.dispatchEvent(new CustomEvent('lumia:theme-changed', { detail: next }))
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<ThemeMode>).detail
      setThemeMode(next)
      applyTheme(resolveTheme(next))
    }
    window.addEventListener('lumia:theme-changed', handler)
    return () => window.removeEventListener('lumia:theme-changed', handler)
  }, [])

  const themeIcon = themeMode === 'dark' ? 'dark_mode' : themeMode === 'light' ? 'light_mode' : 'contrast'
  const themeLabel = themeMode === 'dark' ? 'Dark' : themeMode === 'light' ? 'Light' : 'System'

  const handleCapture = async () => {
    await window.electronAPI?.newCapture()
  }

  return (
    <aside
      className="fixed left-0 top-10 h-[calc(100vh-2.5rem)] w-64 flex flex-col p-6 pt-5 gap-6 z-50 glass-refractive refractive-glow-lg"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >

      {/* Nav links */}
      <nav className="flex-1 space-y-1">
        {navItems.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-4 px-4 py-3 rounded-xl text-sm transition-all duration-300 font-medium ` +
              (isActive
                ? 'active-nav-bg text-primary'
                : 'text-slate-400 hover:text-slate-100 hover:scale-[1.02]')
            }
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
            {label}
          </NavLink>
        ))}

      </nav>

      {/* New Capture CTA */}
      <div className="mt-auto space-y-4">
        <button
          onClick={handleCapture}
          className="w-full primary-gradient text-slate-900 font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-95 transition-all duration-300 text-sm uppercase tracking-wider shadow-lg"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[20px]">add_a_photo</span>
          New Capture
        </button>

        {/* User row + theme toggle */}
        <div className="flex items-center gap-3 p-2">
          <div className="relative">
            <img src={logo} alt="Lumia" className="w-9 h-9 rounded-xl" draggable={false} />
            <div
              className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-secondary rounded-full border-2"
              style={{ borderColor: '#0f172a', boxShadow: '0 0 8px rgba(0,227,253,0.6)' }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-white">Lumia</p>
            <p className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Ready</p>
          </div>
          <button
            onClick={cycleTheme}
            className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-all flex-shrink-0"
            title={`Theme: ${themeLabel}`}
          >
            <span className="material-symbols-outlined text-[18px]">
              {themeIcon}
            </span>
          </button>
        </div>
      </div>
    </aside>
  )
}
