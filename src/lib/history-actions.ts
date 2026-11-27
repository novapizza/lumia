import type { HistoryItem } from '../types'
import { uploadLinksOf } from './upload-choice'

// Shared action handlers for history items. The same entry points drive the
// Dashboard card hover buttons and the list-row inline buttons, and should
// power any Editor-side "act on the current item" buttons too.
//
// All handlers take a `refreshHistory` callback so they can re-fetch the
// history after a mutation (orphan flips, new uploads) — keeps the UI honest
// without each caller reimplementing that glue.

/** The editor's location.state for a history row, the way the Dashboard
 *  opens a clip: a recording by its files and trim, an image by its ORIGINAL
 *  file (annotations ride along as vectors, Canvas replays them one commit
 *  each so Undo walks back through them). Null when the file can't be read;
 *  the caller decides what a missing file means. */
export async function editorStateFor(item: HistoryItem): Promise<Record<string, unknown> | null> {
  if (item.fileMissing) return null
  if (item.type === 'recording') {
    return { kind: 'video', filePath: item.filePath, trimmedFilePath: item.annotatedFilePath, trim: item.trim, fps: item.fps, name: item.name, historyId: item.id, annotations: item.annotations, uploadLinks: uploadLinksOf(item.uploads) }
  }
  let dataUrl: string | null | undefined = item.dataUrl
  if (!dataUrl && item.filePath) dataUrl = await window.electronAPI?.readHistoryFile(item.filePath) ?? null
  if (!dataUrl) return null
  return { kind: 'image', dataUrl, source: 'history', historyId: item.id, annotations: item.annotations, uploadLinks: uploadLinksOf(item.uploads) }
}

export interface CopyResult { ok: boolean; error?: string }
export interface ShareResult { ok: boolean; url?: string; error?: string }

export async function copyHistoryItem(
  item: HistoryItem,
  refreshHistory: () => Promise<void>,
): Promise<CopyResult> {
  if (item.fileMissing) return { ok: false, error: 'File missing on disk' }
  // Video: copy the file reference to clipboard (file on Win/Mac, path on
  // Linux). Image: copy the pixels via the builtin-clipboard workflow.
  if (item.type === 'recording') {
    // Trimmed copy (stored in annotatedFilePath) when present, else original.
    const videoPath = item.annotatedFilePath ?? item.filePath
    if (!videoPath) return { ok: false, error: 'No source file' }
    const res = await window.electronAPI?.videoCopyFile?.(videoPath)
    return { ok: !!res?.ok, error: res?.error }
  }
  let dataUrl: string | null | undefined = item.dataUrl
  // Prefer the annotated sidecar so Copy mirrors what Share sends out — the
  // user's final version with annotations, not the untouched original.
  const sourcePath = item.annotatedFilePath ?? item.filePath
  if (!dataUrl && sourcePath) {
    dataUrl = (await window.electronAPI?.readHistoryFile(sourcePath)) ?? null
    if (dataUrl === null) { await refreshHistory(); return { ok: false, error: 'File missing on disk' } }
  }
  if (!dataUrl) return { ok: false, error: 'No image data' }
  // Pass item.id as historyId so the workflow engine merges into the
  // existing entry instead of creating a duplicate row for a Copy action.
  await window.electronAPI?.runWorkflow('builtin-clipboard', dataUrl, undefined, item.id)
  return { ok: true }
}

export async function shareHistoryItem(
  item: HistoryItem,
  refreshHistory: () => Promise<void>,
): Promise<ShareResult> {
  // Already on R2: main hands back the existing link, no file needed.
  const onR2 = item.uploads?.some(u => u.destination === 'r2' && u.success && u.url)
  if (!onR2 && (item.fileMissing || !item.filePath)) return { ok: false, error: 'File missing on disk' }
  const res = await window.electronAPI?.shareHistoryR2(item.id)
  // Repopulate so the "Synced" badge flips on and the repeat-share fast path
  // in main has an up-to-date uploads array to short-circuit against.
  await refreshHistory()
  return { ok: !!res?.success, url: res?.url, error: res?.error }
}

export function getGoogleLink(item: HistoryItem): string | undefined {
  return item.uploads?.find(u => u.destination === 'google-drive' && u.success && u.url)?.url
}

export async function shareHistoryGoogleDrive(
  item: HistoryItem,
  refreshHistory: () => Promise<void>,
): Promise<ShareResult> {
  // Already on Drive: main hands back the existing link, no file needed.
  if (!getGoogleLink(item) && (item.fileMissing || !item.filePath)) return { ok: false, error: 'File missing on disk' }
  const res = await window.electronAPI?.shareHistoryGoogleDrive(item.id)
  await refreshHistory()
  return { ok: !!res?.success, url: res?.url, error: res?.error }
}
