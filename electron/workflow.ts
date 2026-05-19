import { clipboard, dialog, nativeImage, shell } from 'electron'
import { writeFile, mkdir, copyFile } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { TemplateStore } from './templates'
import type { WorkflowResult, UploadResult, UploadDestination } from './types'
import { uploadImageDataUrlToDrive } from './google-drive-service'
import { uploadToR2 } from './uploaders/r2'
import { HistoryStore } from './history'
import { resolveSaveStartDir, rememberSaveDir } from './settings'
import { localTimestamp } from './utils'
import { makeThumbnail } from './thumbnail'
import { getMainWindow, openHistoryItemInEditor, isMainDismissed } from './index'
import { showNotification } from './notify'
import { v4 as uuidv4 } from 'uuid'

export class WorkflowEngine {
  private historyStore = new HistoryStore()

  constructor(private templateStore: TemplateStore) {}

  async run(templateId: string, imageData: string, destinationIndex?: number, historyId?: string): Promise<WorkflowResult> {
    const template = this.templateStore.getById(templateId)
    if (!template) throw new Error(`Template not found: ${templateId}`)

    // ID the notify-click handler will use to surface this capture in the
    // Editor. Reuses the caller's historyId when re-sharing from history;
    // otherwise we mint one upfront so the eventual history.add (below) and
    // the click handler agree on the same row.
    const clickHistoryId = historyId ?? uuidv4()

    const result: WorkflowResult = {
      templateId,
      uploads: [],
      copiedToClipboard: false
    }

    // ── After-capture phase (sequential) ──
    for (const step of template.afterCapture) {
      if (step.type === 'clipboard') {
        const img = nativeImage.createFromDataURL(imageData)
        clipboard.writeImage(img)
        result.copiedToClipboard = true
      }

      if (step.type === 'save') {
        // Empty path = "surface a Save button in the editor only". The button
        // calls runInlineAction('save', ...) which opens a Save-As dialog.
        // Skip here so destination clicks don't silently auto-save a duplicate.
        if (!step.path || !step.path.trim()) continue
        const ts = localTimestamp()
        const ext = imageData.startsWith('data:image/jpeg') ? 'jpg' : 'png'
        const filename = `capture-${ts}.${ext}`
        await mkdir(step.path, { recursive: true })
        const filePath = join(step.path, filename)
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '')
        await writeFile(filePath, Buffer.from(base64, 'base64'))
        result.savedPath = filePath
      }

      // 'annotate' is handled by the renderer before calling workflow:run
    }

    // ── Upload phase (parallel, or single if destinationIndex given) ──
    const dests = destinationIndex !== undefined
      ? [template.destinations[destinationIndex]].filter(Boolean)
      : template.destinations

    if (dests.length > 0) {
      const uploadResults = await Promise.allSettled(
        dests.map(dest => this.upload(dest, imageData))
      )

      result.uploads = uploadResults.map((r, i) => {
        const dest = dests[i]
        if (r.status === 'fulfilled') return r.value
        return {
          destination: dest.type,
          success: false,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      })
    }

    // ── After-upload phase (sequential) ──
    const successUrls = result.uploads.filter(u => u.success && u.url).map(u => u.url!)

    for (const step of template.afterUpload) {
      if (step.type === 'copyUrl' && successUrls.length > 0) {
        const text = step.which === 'all' ? successUrls.join('\n') : successUrls[0]
        clipboard.writeText(text)
      }

      if (step.type === 'openUrl' && successUrls[0]) {
        shell.openExternal(successUrls[0])
      }

      if (step.type === 'osShare' && result.savedPath) {
        shell.openPath(result.savedPath)
      }

      if (step.type === 'notify') {
        const uploaded = result.uploads.filter(u => u.success).length
        const failed = result.uploads.filter(u => !u.success).length
        const parts: string[] = []
        if (result.copiedToClipboard) parts.push('Copied to clipboard')
        if (result.savedPath) parts.push('Saved to disk')
        if (uploaded > 0) parts.push(`Uploaded to ${uploaded} destination${uploaded > 1 ? 's' : ''}`)
        if (failed > 0) parts.push(`${failed} upload${failed > 1 ? 's' : ''} failed`)

        const fromTray = isMainDismissed()
        showNotification({
          body: parts.join(' · ') || 'Capture complete',
          thumbnailDataUrl: imageData,
          onClick: () => { void openHistoryItemInEditor(clickHistoryId, fromTray) },
        })
      }
    }

    // ── Save to history ──
    // When the Editor is acting on an existing history item (annotations, a
    // prior capture), merge the new uploads into it rather than adding a
    // duplicate row. Without this, clicking Share on a history-opened item
    // created a second identical entry every time.
    if (historyId) {
      const existing = this.historyStore.getAll().find(i => i.id === historyId)
      if (existing) {
        const nextByDest = new Map(result.uploads.map(u => [u.destination, u]))
        const mergedUploads: UploadResult[] = [
          ...(existing.uploads ?? []).filter(u => !nextByDest.has(u.destination)),
          ...result.uploads,
        ]
        this.historyStore.update(historyId, { uploads: mergedUploads })
      }
    } else {
      this.historyStore.add({
        id: clickHistoryId,
        timestamp: Date.now(),
        name: `capture-${localTimestamp()}`,
        thumbnailUrl: makeThumbnail(imageData),
        filePath: result.savedPath,
        type: 'screenshot',
        uploads: result.uploads,
      })
    }

    // Send result to renderer for the upload summary toast
    getMainWindow()?.webContents.send('workflow:result', result)

    return result
  }

  async runInlineAction(actionType: 'clipboard' | 'save', imageData: string, historyId?: string): Promise<{ canceled?: boolean }> {
    if (actionType === 'clipboard') {
      const img = nativeImage.createFromDataURL(imageData)
      clipboard.writeImage(img)
      return {}
    }

    // 'save' — always prompt the user for a location so they can pick the folder.
    const ts = localTimestamp()
    const ext = imageData.startsWith('data:image/jpeg') ? 'jpg' : 'png'
    const filename = `capture-${ts}.${ext}`
    const startDir = await resolveSaveStartDir()

    const opts: Electron.SaveDialogOptions = {
      defaultPath: join(startDir, filename),
      filters: [{ name: 'Image', extensions: [ext] }]
    }
    const mainWin = getMainWindow()
    const result = mainWin
      ? await dialog.showSaveDialog(mainWin, opts)
      : await dialog.showSaveDialog(opts)

    if (result.canceled || !result.filePath) return { canceled: true }

    await mkdir(dirname(result.filePath), { recursive: true })

    // When the editor was launched against an existing history row, prefer
    // copying the on-disk file (original or annotated sidecar) over writing
    // the dataURL. The dataURL is a fresh Konva canvas re-render and goes
    // through a decode → drawImage (with default imageSmoothingEnabled) →
    // encode round-trip — that introduces sub-pixel noise that hurts PNG
    // compression (~+30-40% file size) and drops the iCCP chunk we attached
    // at capture time. copyFile preserves bytes exactly, including color
    // metadata. Caller is responsible for flushing pending annotation saves
    // (Editor.handleExport awaits saveHistoryAnnotations) so the sidecar is
    // on disk before we get here.
    const source = historyId ? this.resolveSourceForCopy(historyId) : null
    if (source) {
      try {
        await copyFile(source, result.filePath)
        rememberSaveDir(dirname(result.filePath))
        return {}
      } catch (err) {
        // Source disappeared between resolution and copy — fall through to
        // the dataURL write so the user still gets a file.
        console.warn('[workflow] save copyFile failed, falling back to dataURL write', err)
      }
    }

    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(result.filePath, Buffer.from(base64, 'base64'))
    rememberSaveDir(dirname(result.filePath))
    return {}
  }

  /** Pick the on-disk source for a Save-As: annotated sidecar when present
   *  (user has annotations), otherwise the original capture file. Returns
   *  null when neither exists or the history row is gone. */
  private resolveSourceForCopy(historyId: string): string | null {
    const item = this.historyStore.getAll().find(i => i.id === historyId)
    if (!item) return null
    const candidate = item.annotatedFilePath || item.filePath
    return candidate || null
  }

  private async upload(dest: UploadDestination, imageData: string): Promise<UploadResult> {
    switch (dest.type) {
      case 'google-drive': return this.uploadToGoogleDrive(imageData, dest.folderId)
      case 'r2': return this.uploadToR2(imageData, dest.bucket)
    }
  }

  private async uploadToR2(imageData: string, bucket?: string): Promise<UploadResult> {
    return uploadToR2(
      imageData,
      import.meta.env.MAIN_VITE_R2_ACCOUNT_ID,
      import.meta.env.MAIN_VITE_R2_ACCESS_KEY_ID,
      import.meta.env.MAIN_VITE_R2_SECRET_ACCESS_KEY,
      bucket || import.meta.env.MAIN_VITE_R2_BUCKET,
      import.meta.env.MAIN_VITE_R2_PUBLIC_URL
    )
  }

  private async uploadToGoogleDrive(imageData: string, folderId?: string): Promise<UploadResult> {
    return uploadImageDataUrlToDrive(imageData, folderId)
  }
}
