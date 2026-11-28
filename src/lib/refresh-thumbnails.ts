import { grabVideoFrame } from './video-frame'

let started = false

/**
 * Renderer half of the one-time thumbnail refresh (electron/thumbnail-refresh.ts):
 * grabs a fresh, larger frame for every recording whose thumbnail is still at
 * an old size, one at a time, and hands each to main. Runs once per launch
 * from the Dashboard; main returns an empty list once the refresh is done.
 */
export async function refreshRecordingThumbnails(): Promise<void> {
  if (started) return
  started = true
  const api = window.electronAPI
  if (!api?.getPendingRecordingThumbnails) return
  const rows = await api.getPendingRecordingThumbnails()
  if (rows.length === 0) { await api.recordingThumbnailsDone(true); return }
  let ok = 0
  for (const r of rows) {
    const src = `lumia-media://stream/?path=${encodeURIComponent(r.path)}`
    const dataUrl = await grabVideoFrame(src, r.trimmed ? { ms: 0 } : { fraction: 0.25 })
    if (dataUrl && await api.setRecordingThumbnail(r.id, dataUrl)) ok++
  }
  console.log(`[thumbnail] refreshed ${ok}/${rows.length} recording thumbnail(s)`)
  // Only a clean pass ends the refresh; otherwise the next launch retries
  // the rows still at an old size.
  await api.recordingThumbnailsDone(ok === rows.length)
}
