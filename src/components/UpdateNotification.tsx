import { useState, useEffect } from 'react'

import { ToastBox, ToastSlot, useLeaving, TOAST_ACTION } from './Toast'
import { cleanError } from '../lib/toast'
import { useBadges, setUpdate, setLatest, getUpdate, installUpdate } from '../lib/app-badges'

/** Update progress lives in the shared badge store (lib/app-badges), which
 *  Settings › About and the dots read too. Lumia checks by itself (launch,
 *  every 4h; there's no manual check since 2026-11-22), and nothing
 *  downloads or installs without the user: a found version shows Update in
 *  Settings, Update downloads it, Restart installs it. Unless the user
 *  opted into "Auto-update Lumia", where main downloads on its own.
 *  This toast offers Restart once downloaded, and reports a failed
 *  download. Rendered inside ToastHost (App), above the other toasts.
 *  Ready stays until closed: it offers Restart (2.5s like other toasts was
 *  tried and dropped, 2026-11-24). A failed download goes after 4s. */
export function UpdateNotification() {
  const { update } = useBadges()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const downloadedVersion = update?.phase === 'ready' && dismissed !== update.version ? update.version : null
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI?.onUpdateDownloaded((v) => {
      setDownloadError(null)
      setUpdate({ phase: 'ready', version: v })
    })

    window.electronAPI?.onUpdateStatus?.((s) => {
      const current = getUpdate()
      if (s.status === 'available' && s.version) {
        // Found by a check: Settings offers Update.
        if (current?.phase !== 'downloading' && current?.phase !== 'ready') {
          setUpdate({ phase: 'available', version: s.version })
        }
      } else if (s.status === 'downloading' && current && current.phase === 'available') {
        setUpdate({ ...current, phase: 'downloading' })
      } else if (s.status === 'error' && current?.phase === 'downloading') {
        // A failed download: back to Update, and say why.
        setUpdate({ ...current, phase: 'available' })
        setDownloadError(s.error ?? '')
      } else if (s.status === 'not-available') {
        // Settings' version row says "Latest version"; no toast.
        setLatest(true)
      }
      // Check errors stay quiet: a check is only a ping.
    })

    return () => {
      window.electronAPI?.removeAllListeners('update:downloaded')
      window.electronAPI?.removeAllListeners('update:status')
    }
  }, [])

  useEffect(() => {
    if (downloadError === null) return
    const t = setTimeout(() => setDownloadError(null), 4000)
    return () => clearTimeout(t)
  }, [downloadError])

  // What the toast shows, kept on screen while it leaves (useLeaving).
  const current: { key: string; error?: string } | null = downloadedVersion
    ? { key: `ready-${downloadedVersion}` }
    : downloadError !== null ? { key: 'error', error: downloadError } : null
  const { shown, leaving } = useLeaving(current, c => c.key)
  if (!shown) return null

  if (shown.error === undefined) {
    const version = shown.key.slice('ready-'.length)
    return (
      <ToastSlot key={shown.key} leaving={leaving}>
        <ToastBox
          kind="info"
          icon="system_update"
          message="New update downloaded"
          action={<button onClick={installUpdate} className={TOAST_ACTION}>Restart</button>}
          onClose={() => setDismissed(version)}
        />
      </ToastSlot>
    )
  }

  return (
    <ToastSlot key={shown.key} leaving={leaving}>
      <ToastBox kind="error" icon="error" message="Couldn't download update" detail={cleanError(shown.error)} onClose={() => setDownloadError(null)} />
    </ToastSlot>
  )
}
