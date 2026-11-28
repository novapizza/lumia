import { useEffect, useState } from 'react'
import { isStandaloneHash } from '../lib/standalone'

export type ThemeMode = 'dark' | 'light'

/** Standalone windows (recording toolbar, border, recorder host,
 *  annotation overlay) render through App too, but stay dark: their panels
 *  are fixed dark, so light text roles would vanish on them (final review,
 *  custom themes). Only the main window takes light mode. */
function applyTheme(mode: ThemeMode) {
  if (isStandaloneHash()) return
  document.documentElement.classList.toggle('light', mode === 'light')
}

/** The saved theme, applied as `html.light`. There is no "System" mode: main
 *  matches the OS on first launch (resolveFirstLaunchTheme) and from then on
 *  the user's last pick is kept. `toggle` flips dark/light, saves it and tells
 *  every other useTheme instance (and Settings) via `lumia:theme-changed`. */
export function useTheme() {
  // The preload already set html.light from the saved mode before the first
  // paint (custom themes, 2026-11-22), so start from it: no dark-then-light
  // flash. The getSettings read below stays as the fallback.
  const [mode, setMode] = useState<ThemeMode>(() =>
    document.documentElement.classList.contains('light') ? 'light' : 'dark')

  useEffect(() => {
    window.electronAPI?.getSettings().then(s => {
      const m: ThemeMode = s.theme === 'light' ? 'light' : 'dark'
      setMode(m)
      applyTheme(m)
      // Only the main window owns the title bar.
      if (!isStandaloneHash()) window.electronAPI?.setTitleBarTheme(m)
    })
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<ThemeMode>).detail
      setMode(next)
      applyTheme(next)
    }
    window.addEventListener('lumia:theme-changed', handler)
    return () => window.removeEventListener('lumia:theme-changed', handler)
  }, [])

  const toggle = async () => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark'
    setMode(next)
    applyTheme(next)
    await window.electronAPI?.setSetting('theme', next)
    window.electronAPI?.setTitleBarTheme(next)
    window.dispatchEvent(new CustomEvent('lumia:theme-changed', { detail: next }))
  }

  return { mode, toggle }
}

/** The current mode, read-only (no settings read, no title bar call): for
 *  views that only show something per mode, like Settings › Appearance's
 *  base row. Follows the AppBar's moon / sun via `lumia:theme-changed`. */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(() =>
    document.documentElement.classList.contains('light') ? 'light' : 'dark')
  useEffect(() => {
    const handler = (e: Event) => setMode((e as CustomEvent<ThemeMode>).detail)
    window.addEventListener('lumia:theme-changed', handler)
    return () => window.removeEventListener('lumia:theme-changed', handler)
  }, [])
  return mode
}
