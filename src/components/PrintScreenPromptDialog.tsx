import { useState, useEffect } from 'react'

import { BUTTON, ACCENT_BUTTON } from './button-classes'
import { MessageBox } from './MessageBox'

/** First-run prompt asking whether to bind the physical PrintScreen key to
 *  Lumia's "New Capture" action. Fires once: on the first app launch where
 *  printScreenPromptShown is still false. Either button (Yes/No) marks it
 *  as shown so we never re-ask; the user can change their answer later in
 *  Settings › General.
 *
 *  Windows-only on purpose: built-in Mac keyboards don't have PrintScreen,
 *  so the prompt would be meaningless to most macOS users. Mac users on an
 *  external PC keyboard can opt in manually from Settings.
 */
export function PrintScreenPromptDialog() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState('')
  useEffect(() => {
    if (window.electronAPI?.platform !== 'win32') return
    window.electronAPI?.getSettings?.().then(s => {
      if (s && !s.printScreenPromptShown) setOpen(true)
    }).catch(() => { /* ignore — prompt will simply not show this session */ })
  }, [])

  const close = () => { setOpen(false); setWarning(''); setDetail('') }

  const handleYes = async () => {
    setBusy(true)
    try {
      const res = await window.electronAPI?.setPrintScreenAsCapture?.(true)
      // setPrintScreenAsCapture already flips printScreenPromptShown=true
      // server-side, so a "Yes" click costs one IPC instead of two.
      if (res?.warning) { setWarning(res.warning); setDetail(res.detail ?? '') }
      else              close()
    } finally {
      setBusy(false)
    }
  }

  const handleNo = async () => {
    setBusy(true)
    try {
      // Don't flip printScreenAsCapture — leave the default off. We only need
      // to record that we asked, so future launches stay quiet.
      await window.electronAPI?.setSetting?.('printScreenPromptShown', true)
      close()
    } finally {
      setBusy(false)
    }
  }

  // Esc is "Keep default", like a dialog's Cancel (it still records that we asked).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      e.preventDefault()
      if (warning) close()
      else void handleNo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null

  // Dialog look (2026-11-25 review): a solid elevated box with a line edge
  // over the scrim (no blur, no glass), Section-rank title, Body-rank text,
  // framed buttons with the main one in accent.
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim">
      <div role="dialog" aria-modal="true" aria-labelledby="printscreen-title" className="w-[400px] max-w-[calc(100vw-32px)] rounded-lg bg-elevated border border-line p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="printscreen-title" className="text-sm font-semibold text-fg">Use PrintScreen?</h2>
          <p className="text-xs text-fg-secondary">
            PrintScreen starts a new capture or recording, like your last one. Takes the key from the Snipping Tool.<br /><br />You can change this anytime in Settings › General.
          </p>
        </div>

        {/* Like a warning toast: it didn't go as asked, nothing broke. */}
        {warning && <MessageBox kind="warning" message={warning} detail={detail || undefined} />}

        <div className="flex justify-end gap-3">
          {warning ? (
            <button disabled={busy} onClick={close} className={ACCENT_BUTTON}>OK</button>
          ) : (
            <>
              <button disabled={busy} onClick={handleNo} className={BUTTON}>Keep default</button>
              <button disabled={busy} onClick={handleYes} className={ACCENT_BUTTON}>Use PrintScreen</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
