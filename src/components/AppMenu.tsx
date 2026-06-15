import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

interface AppMenuProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

const isMac = window.electronAPI?.platform === 'darwin'

function shortcut(key: string): string {
  if (isMac) {
    return key
      .replace('CmdOrCtrl+', '⌘')
      .replace('Alt+', '⌥')
      .replace('Ctrl+', '⌃')
      .replace('Shift+', '⇧')
  }
  return key.replace('CmdOrCtrl+', 'Ctrl+')
}

type MenuItemDef =
  | { type: 'item'; label: string; icon: string; shortcut?: string; action: () => void }
  | { type: 'separator' }

export function AppMenu({ open, onClose, anchorRef }: AppMenuProps) {
  const navigate = useNavigate()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const [visible, setVisible] = useState(false)
  const [autoUpdateAvailable, setAutoUpdateAvailable] = useState(true)

  // Probe once whether the running process can apply updates. If not (e.g.
  // per-machine Windows install run by a non-admin user), there's no point
  // showing "Check for Updates" — the IPC would just return an error.
  useEffect(() => {
    window.electronAPI?.isAutoUpdateAvailable?.().then(setAutoUpdateAvailable).catch(() => {})
  }, [])

  // Compute position from anchor
  useEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    })
    // Trigger enter animation on next frame
    requestAnimationFrame(() => setVisible(true))
    return () => setVisible(false)
  }, [open, anchorRef])

  // Escape key & window blur
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, onClose])

  if (!open) return null

  const exec = (action: () => void) => {
    onClose()
    action()
  }

  const items: MenuItemDef[] = [
    { type: 'item', label: 'New Capture', icon: 'add_a_photo', action: () => window.electronAPI?.newCapture() },
    { type: 'separator' },
    { type: 'item', label: 'Settings', icon: 'settings', action: () => navigate('/settings') },
    ...(autoUpdateAvailable ? [{ type: 'item' as const, label: 'Check for Updates', icon: 'system_update', action: () => window.dispatchEvent(new Event('app:check-update')) }] : []),
    { type: 'separator' },
    { type: 'item', label: 'About Lumia', icon: 'info', action: () => window.dispatchEvent(new Event('app:show-about')) },
    { type: 'item', label: 'Quit Lumia', icon: 'power_settings_new', action: () => window.electronAPI?.quitApp() },
  ]

  // Dev-only items
  if (import.meta.env.DEV) {
    items.push(
      { type: 'separator' },
      { type: 'item', label: 'Toggle DevTools', icon: 'code', shortcut: shortcut(isMac ? 'Alt+CmdOrCtrl+I' : 'Ctrl+Shift+I'), action: () => window.electronAPI?.toggleDevTools() },
      { type: 'item', label: 'Reload', icon: 'refresh', shortcut: shortcut('CmdOrCtrl+R'), action: () => window.electronAPI?.reloadWindow() },
      { type: 'item', label: 'Force Reload', icon: 'sync', shortcut: shortcut('CmdOrCtrl+Shift+R'), action: () => window.electronAPI?.forceReloadWindow() },
    )
  }

  return createPortal(
    <>
      {/* Backdrop — click outside to close */}
      <div className="fixed inset-0 z-[89]" onClick={onClose} />

      {/* Menu panel */}
      <div
        ref={menuRef}
        className={`fixed z-[90] min-w-[220px] py-1.5 rounded-xl shadow-2xl
          glass-refractive border border-white/10
          transition-all duration-150 origin-top-right
          ${visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}
        style={{
          top: pos.top,
          right: pos.right,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {items.map((item, i) => {
          if (item.type === 'separator') {
            return <div key={i} className="my-1.5 border-t border-white/5" />
          }
          return (
            <button
              key={i}
              onClick={() => exec(item.action)}
              className="w-full flex items-center gap-3 px-3 py-2 mx-0 text-sm text-[var(--color-on-surface)] hover:bg-white/10 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-on-surface-variant)]">
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
              {item.shortcut && (
                <span className="text-xs text-[var(--color-on-surface-variant)] ml-4" style={{ fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif' }}>
                  {item.shortcut}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </>,
    document.body,
  )
}
