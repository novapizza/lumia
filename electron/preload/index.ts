import { contextBridge, ipcRenderer } from 'electron'
import { themeCss, type ThemePicks } from '../../shared/theme-colors'

/* Custom themes (design/CUSTOM-THEMES.md): before the page paints, set the
   saved mode (main window, capture overlays and the recording windows; the
   recorder host doesn't draw) and
   write the user's picks as one <style id="lumia-theme">; rewrite it when
   main broadcasts a change. The preload runs before the HTML is parsed, so
   <html> may not exist yet: a MutationObserver (a microtask, before any
   paint) applies it the moment it does. */
{
  // The few DOM bits used here, typed locally: the main-process tsconfig
  // has no DOM lib (adding it would leak DOM globals into electron/).
  type El = { id: string; textContent: string | null; classList: { toggle(c: string, on: boolean): void }; appendChild(n: El): El }
  type Doc = { documentElement: El | null; createElement(tag: 'style'): El }
  type Observer = { observe(target: Doc, opts: { childList: boolean }): void; disconnect(): void }
  const g = globalThis as unknown as { document: Doc; MutationObserver: new (cb: () => void) => Observer }
  const document = g.document
  // A failure here means no custom theme, never no app: the bridge below
  // must still be exposed (final review).
  const fallback = { mode: 'dark' as const, picks: { accent: null, lightBase: null, darkBase: null }, neutrals: false }
  let initial: { mode: 'light' | 'dark'; picks: ThemePicks; neutrals: boolean } = fallback
  try { initial = (ipcRenderer.sendSync('theme:initial') as typeof initial | undefined) ?? fallback } catch { /* default theme */ }
  const safeCss = (picks: ThemePicks) => { try { return themeCss(picks, { neutrals: initial.neutrals }) } catch { return '' } }
  let css = safeCss(initial.picks)
  let styleEl: El | null = null
  const apply = (root: El) => {
    if (initial.neutrals) root.classList.toggle('light', initial.mode === 'light')
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'lumia-theme'
      root.appendChild(styleEl)
    }
    styleEl.textContent = css
  }
  if (document.documentElement) apply(document.documentElement)
  else {
    const mo = new g.MutationObserver(() => {
      if (!document.documentElement) return
      mo.disconnect()
      apply(document.documentElement)
    })
    mo.observe(document, { childList: true })
  }
  ipcRenderer.on('theme:changed', (_e, { picks, mode }: { picks: ThemePicks; mode?: 'light' | 'dark' }) => {
    css = safeCss(picks)
    if (styleEl) styleEl.textContent = css
    // With a mode (the capture overlays at each open): switch light / dark.
    if (mode && initial.neutrals) document.documentElement?.classList.toggle('light', mode === 'light')
  })
}

export type CaptureMode = 'all-screen' | 'region' | 'window' | 'screen'

contextBridge.exposeInMainWorld('electronAPI', {
  // Capture
  captureScreenshot: (mode: CaptureMode) =>
    ipcRenderer.invoke('capture:screenshot', mode),

  // Recording

  // Workflow
  runWorkflow: (templateId: string, imageData: string, destinationIndex?: number, historyId?: string) =>
    ipcRenderer.invoke('workflow:run', templateId, imageData, destinationIndex, historyId),
  runInlineAction: (actionType: 'clipboard' | 'save', imageData: string, historyId?: string) =>
    ipcRenderer.invoke('workflow:inlineAction', actionType, imageData, historyId),
  getTemplates: () => ipcRenderer.invoke('workflow:getTemplates'),
  saveTemplate: (template: unknown) => ipcRenderer.invoke('workflow:saveTemplate', template),
  deleteTemplate: (id: string) => ipcRenderer.invoke('workflow:deleteTemplate', id),

  // History
  getHistoryStats: () => ipcRenderer.invoke('history:stats'),
  getPendingRecordingThumbnails: () => ipcRenderer.invoke('thumbnails:pending-recordings'),
  setRecordingThumbnail: (id: string, dataUrl: string) => ipcRenderer.invoke('thumbnails:set-recording', id, dataUrl),
  recordingThumbnailsDone: (allOk: boolean) => ipcRenderer.invoke('thumbnails:recordings-done', allOk),
  getHistoryDays: (days: string[]) => ipcRenderer.invoke('history:days', days),
  getEditHistory: (id: string) => ipcRenderer.invoke('editHistory:get', id),
  saveEditHistory: (id: string, data: unknown) => ipcRenderer.invoke('editHistory:save', id, data),
  getHistoryItem: (id: string) => ipcRenderer.invoke('history:get', id),
  getRecentHistory: (limit: number, type?: 'screenshot' | 'recording', opts?: { onDisk?: boolean }) => ipcRenderer.invoke('history:recent', limit, type, opts),
  onHistoryChanged: (cb: (p: { days?: string[] }) => void) => {
    const listener = (_e: unknown, p: { days?: string[] }) => cb(p)
    ipcRenderer.on('history:changed', listener)
    return () => { ipcRenderer.removeListener('history:changed', listener) }
  },
  // The video editor's filmstrip: the saved one's address, saving one a
  // renderer made (with a card preview for a recording that has none), and
  // whether the background work may run (not while recording).
  getFilmstrip: (id: string) => ipcRenderer.invoke('filmstrip:get', id),
  saveFilmstrip: (id: string, dataUrl: string, thumbnailDataUrl?: string) => ipcRenderer.invoke('filmstrip:save', id, dataUrl, thumbnailDataUrl),
  filmstripCanRun: () => ipcRenderer.invoke('filmstrip:canRun'),
  // A row's preview or strip failed to load in the window: main checks the
  // file and, if it's gone, clears it from the row so it's made again.
  reportFileGone: (id: string, kind: 'thumbnail' | 'strip') => ipcRenderer.invoke('history:fileGone', id, kind),
  deleteHistoryItem: (id: string) => ipcRenderer.invoke('history:delete', id),
  deleteHistoryItems: (ids: string[]) => ipcRenderer.invoke('history:deleteMany', ids),
  revealHistoryFile: (id: string) => ipcRenderer.invoke('history:reveal', id),
  addHistoryItem: (item: unknown) => ipcRenderer.invoke('history:addCapture', item),
  readHistoryFile: (filePath: string) => ipcRenderer.invoke('history:readAsDataUrl', filePath),
  cleanupMissingHistory: (ids: string[]) => ipcRenderer.invoke('history:cleanupMissing', ids),
  getMissingHistoryIds: () => ipcRenderer.invoke('history:missingIds'),
  getAllHistoryIds: (type?: 'screenshot' | 'recording') => ipcRenderer.invoke('history:allIds', type),
  shareHistoryR2: (id: string) => ipcRenderer.invoke('history:shareR2', id),
  shareHistoryGoogleDrive: (id: string) => ipcRenderer.invoke('history:shareGoogleDrive', id),
  downloadFromCloud: (id: string) => ipcRenderer.invoke('history:downloadFromCloud', id),
  restoreFromCloud: (id: string) => ipcRenderer.invoke('history:restoreFromCloud', id),
  cancelRestore: (id: string) => ipcRenderer.invoke('history:cancelRestore', id),
  saveHistoryAnnotations: (id: string, annotations: unknown[], flattenedDataUrl?: string) =>
    ipcRenderer.invoke('history:saveAnnotations', id, annotations, flattenedDataUrl),

  // Hotkeys
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  getDefaultHotkeys: () => ipcRenderer.invoke('hotkeys:getDefaults'),
  setHotkeys: (hotkeys: Record<string, string>) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  setHotkeyRecording: (recording: boolean) => ipcRenderer.invoke('hotkeys:setRecording', recording),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  setPrintScreenAsCapture: (enabled: boolean) =>
    ipcRenderer.invoke('printscreen:set-enabled', enabled),

  // Google Drive
  gdriveStartAuth: () => ipcRenderer.invoke('gdrive:startAuth'),
  gdriveCancelAuth: () => ipcRenderer.invoke('gdrive:cancelAuth'),
  gdriveDisconnect: () => ipcRenderer.invoke('gdrive:disconnect'),
  gdrivePickFolder: () => ipcRenderer.invoke('gdrive:pickFolder'),
  gdriveCancelPickFolder: () => ipcRenderer.invoke('gdrive:cancelPickFolder'),
  gdriveFolderName: (folderId: string) => ipcRenderer.invoke('gdrive:folderName', folderId),
  onGdriveConnected: (cb: () => void) => ipcRenderer.on('gdrive:connected', cb),
  onGdriveFolderSelected: (cb: () => void) => ipcRenderer.on('gdrive:folderSelected', cb),
  onWindowWillMove: (cb: () => void) => { ipcRenderer.on('window:will-move', () => cb()) },

  // Save file
  saveFile: (dataUrl: string, filePath: string) => ipcRenderer.invoke('capture:saveFile', dataUrl, filePath),

  // Read local file as ArrayBuffer (for video blob URL playback)

  // App actions (for renderer custom menu)

  // Update native titlebar overlay colors on theme change (Windows)
  setTitleBarTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('titlebar:setTheme', theme),
  // Custom picker drag: restyle every window without saving.
  previewThemePick: (key: 'themeAccent' | 'themeLightBase' | 'themeDarkBase', value: string) => ipcRenderer.send('theme:preview', key, value),

  // Tell main the renderer has finished its critical initial work (data
  // fetches, fonts) so it can show() the BrowserWindow. Without this main
  // shows on ready-to-show with content still loading. fire-and-forget — main
  // listens with ipcMain.once and a fallback timer in case this never arrives.
  windowReady: () => ipcRenderer.send('window:ready'),

  // Navigation (tell main which view to show in the same window)

  // Renderer signals that a route has just mounted. Main uses this to wait
  // out the IPC + React-render delay before win.show(), otherwise the user
  // sees a flash of the previous route while the window comes up.
  notifyViewMounted: (route: string) => ipcRenderer.send('view:mounted', route),

  // Events from main → renderer
  /** A message from main shown as an in-app toast (notify.ts: the app is
   *  visible, so no system notification). */
  onToast: (cb: (t: { message: string; kind?: 'success' | 'error' | 'warning' | 'info'; icon?: string; detail?: string }) => void) => {
    ipcRenderer.on('toast:show', (_e, t) => cb(t))
  },
  onNavigate: (cb: (route: string, state?: Record<string, unknown>) => void) => {
    ipcRenderer.on('navigate', (_e, route, state) => cb(route, state))
  },
  onUpdateDownloaded: (cb: (version: string) => void) => { ipcRenderer.on('update:downloaded', (_e, version: string) => cb(version)) },
  onUpdateStatus: (cb: (data: { status: string; version?: string; percent?: number; error?: string }) => void) => {
    ipcRenderer.on('update:status', (_e, data) => cb(data))
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  isAutoUpdateAvailable: () => ipcRenderer.invoke('update:available'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  showLogs: () => ipcRenderer.invoke('app:showLogs'),
  chooseCaptureFolder: () => ipcRenderer.invoke('settings:chooseCaptureFolder'),
  moveCaptureFiles: (from: string) => ipcRenderer.invoke('settings:moveCaptureFiles', from),
  openLicenses: () => ipcRenderer.invoke('app:openLicenses'),

  // Scrolling capture
  confirmScrollRegion: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('scroll-region:confirm', rect),
  cancelScrollRegion: () =>
    ipcRenderer.invoke('scroll-region:cancel'),
  // Unified scroll launcher (routes to extension bridge or classic screen
  // pipeline) + extension-bridge status for the Dashboard's Scroll tab
  launchScrollCapture: (method?: 'extension' | 'screen') =>
    ipcRenderer.invoke('scroll-capture:launch', method),
  getScrollExtensionStatus: () =>
    ipcRenderer.invoke('scroll-extension:status'),
  onScrollExtensionStatus: (cb: (status: { connected: boolean; browsers: string[] }) => void) =>
    ipcRenderer.on('scroll-extension:status', (_e, status) => cb(status)),
  openScrollExtensionFolder: () =>
    ipcRenderer.invoke('scroll-extension:open-folder'),
  // Multi-browser picker: live tab previews from every connected browser,
  // session start pinned to the picked one, and the main-pushed event that
  // tells the Dashboard to open the picker.
  getScrollExtensionPreviews: () =>
    ipcRenderer.invoke('scroll-extension:previews'),
  startScrollCaptureWith: (clientId: number) =>
    ipcRenderer.invoke('scroll-extension:start-with', clientId),
  onScrollExtensionPick: (cb: () => void) =>
    ipcRenderer.on('scroll-extension:pick', cb),
  getOverlayMode: () =>
    ipcRenderer.invoke('overlay:get-mode'),

  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  // Overlay-specific
  confirmRegion: (payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) =>
    ipcRenderer.invoke('region:confirm', payload),
  cancelRegion: () => ipcRenderer.invoke('region:cancel'),
  getWindowAt: (x: number, y: number) => ipcRenderer.invoke('window-pick:get-window-at', x, y),
  getWindowAtCursor: () => ipcRenderer.invoke('window-pick:get-window-at-cursor'),
  confirmWindowPick: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('window-pick:confirm', rect),
  // Enter shortcut: confirm the active (foreground) window. Main branches on
  // the current overlay mode, so this covers both capture and record intents.
  confirmActiveWindow: () => ipcRenderer.invoke('window-pick:confirm-active'),
  cancelWindowPick: () => ipcRenderer.invoke('window-pick:cancel'),
  confirmMonitorPick: () => ipcRenderer.invoke('monitor-pick:confirm'),
  cancelMonitorPick: () => ipcRenderer.invoke('monitor-pick:cancel'),
  switchOverlayMode: (mode:
    | 'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'
    | 'video-region' | 'video-window' | 'video-screen'
  ) => ipcRenderer.invoke('overlay:switch-mode', mode),

  // Video file actions (operate on saved recording files)
  videoSaveAs:   (filePath: string) => ipcRenderer.invoke('video:save-as', filePath),
  videoCopyFile: (filePath: string) => ipcRenderer.invoke('video:copy-file', filePath),
  videoTrim: (historyId: string, startMs: number, endMs: number, thumbnailDataUrl?: string) =>
    ipcRenderer.invoke('video:trim', historyId, startMs, endMs, thumbnailDataUrl),
  videoClearTrim: (historyId: string, thumbnailDataUrl?: string) =>
    ipcRenderer.invoke('video:clear-trim', historyId, thumbnailDataUrl),
  videoUploadR2: (filePath: string) => ipcRenderer.invoke('video:upload-r2', filePath),
  videoUploadGoogleDrive: (filePath: string) => ipcRenderer.invoke('video:upload-google-drive', filePath),

  // Video recording — overlay mode selection
  startVideoCapture: (mode: 'region' | 'window' | 'screen') =>
    ipcRenderer.invoke('video:start', mode),
  confirmVideoRegion: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('video:region-confirm', rect),
  confirmVideoWindow: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('video:window-confirm', rect),
  confirmVideoScreen: () => ipcRenderer.invoke('video:screen-confirm'),
  cancelVideo: () => ipcRenderer.invoke('video:cancel'),

  // Video recording — RecorderHost & Toolbar
  recorderGetTarget: () => ipcRenderer.invoke('recorder:get-target'),
  recorderGetWatermark: () => ipcRenderer.invoke('recorder:get-watermark'),
  recorderReady: (ok: boolean, error?: string, micAvailable?: boolean) =>
    ipcRenderer.invoke('recorder:ready', ok, error, micAvailable),
  recorderStateChange: (state: string, payload?: unknown) =>
    ipcRenderer.invoke('recorder:state', state, payload),
  recorderTick: (elapsedMs: number) => ipcRenderer.invoke('recorder:tick', elapsedMs),
  // Streamed save — the finished webm is forwarded to disk in bounded slices
  // (begin → chunk* → end) so a long recording never materializes one
  // contiguous ArrayBuffer or blows the structured-clone limit over IPC.
  recorderSaveBegin: () => ipcRenderer.invoke('recorder:save-begin'),
  recorderSaveChunk: (chunk: ArrayBuffer) => ipcRenderer.invoke('recorder:save-chunk', chunk),
  recorderSaveEnd: (thumbnailDataUrl: string, durationMs: number, fps?: number, stripDataUrl?: string) =>
    ipcRenderer.invoke('recorder:save-end', thumbnailDataUrl, durationMs, fps, stripDataUrl),
  onRecorderBegin: (cb: () => void) => ipcRenderer.on('recorder:begin', cb),
  onRecorderPause: (cb: () => void) => ipcRenderer.on('recorder:pause', cb),
  onRecorderResume: (cb: () => void) => ipcRenderer.on('recorder:resume', cb),
  onRecorderStopRequest: (cb: () => void) => ipcRenderer.on('recorder:stop-request', cb),
  onRecorderCancelRequest: (cb: () => void) => ipcRenderer.on('recorder:cancel-request', cb),
  onRecorderMicToggle: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on('recorder:mic-toggle', (_e, enabled: boolean) => cb(enabled)),

  toolbarBegin: () => ipcRenderer.invoke('toolbar:begin'),
  // Whether main has shown this toolbar yet (its countdown runs from then).
  toolbarIsShown: () => ipcRenderer.invoke('toolbar:is-shown'),
  toolbarPause: () => ipcRenderer.invoke('toolbar:pause'),
  toolbarResume: () => ipcRenderer.invoke('toolbar:resume'),
  toolbarStop: () => ipcRenderer.invoke('toolbar:stop'),
  toolbarCancel: () => ipcRenderer.invoke('toolbar:cancel'),
  toolbarToggleMic: (enabled: boolean) => ipcRenderer.invoke('toolbar:toggle-mic', enabled),
  toolbarToggleAnnotation: (enabled: boolean) => ipcRenderer.invoke('toolbar:toggle-annotation', enabled),
  // The recording toolbar window stays at a fixed size with empty
  // transparent area around the pills. setInteractive(true) tells main to
  // capture clicks (cursor over a pill); setInteractive(false) tells main
  // to pass clicks through (cursor over empty area). Renderer hit-tests
  // mousemove against pill bounds and only sends on transition.
  toolbarSetInteractive: (interactive: boolean) =>
    ipcRenderer.send('toolbar:set-interactive', interactive),
  onToolbarState: (cb: (state: unknown) => void) =>
    ipcRenderer.on('toolbar:state', (_e, state) => cb(state as any)),

  // Live annotation overlay (during recording)
  annotationGetState: () => ipcRenderer.invoke('annotation:get-state'),
  annotationSetTool: (tool: string) => ipcRenderer.invoke('annotation:set-tool', tool),
  // `mirror`: showing a selected shape's own style (not saved as the pick).
  annotationSetColor: (color: string, mirror?: boolean) => ipcRenderer.invoke('annotation:set-color', color, mirror),
  annotationSetStroke: (size: number, mirror?: boolean) => ipcRenderer.invoke('annotation:set-stroke', size, mirror),
  annotationClear: () => ipcRenderer.invoke('annotation:clear'),
  annotationUndo: () => ipcRenderer.invoke('annotation:undo'),
  annotationRedo: () => ipcRenderer.invoke('annotation:redo'),
  // The overlay's selection and Undo / Redo availability, for the toolbar.
  annotationReportEditState: (s: { selectedKind: string | null; canUndo: boolean; canRedo: boolean }) =>
    ipcRenderer.send('annotation:edit-state', s),
  annotationGetEditState: () => ipcRenderer.invoke('annotation:get-edit-state'),
  onAnnotationEditState: (cb: (s: { selectedKind: string | null; canUndo: boolean; canRedo: boolean }) => void) =>
    ipcRenderer.on('annotation:edit-state', (_e, s) => cb(s)),
  onAnnotationRedo: (cb: () => void) =>
    ipcRenderer.on('annotation:redo', () => cb()),
  // Hover-driven click-through for the live annotation overlay. The overlay
  // sits in pass-through mode while tool='none' so the user can interact
  // with the recorded app — cursor entering a stroke flips the overlay
  // back to capture so the click selects the shape (for delete/drag),
  // cursor leaving flips it back. Same pattern as toolbar:set-interactive.
  annotationOverlaySetInteractive: (interactive: boolean) =>
    ipcRenderer.send('annotation-overlay:set-interactive', interactive),
  // Keyboard focus for the drawing layer while a drawing tool or a
  // selection is active (the editor keys); back to the recorded app after.
  annotationOverlayWantFocus: (want: boolean) =>
    ipcRenderer.send('annotation-overlay:want-focus', want),
  onAnnotationState: (cb: (state: { tool: string; color: string; strokeWidth: number }) => void) =>
    ipcRenderer.on('annotation:state', (_e, state) => cb(state)),
  onAnnotationClear: (cb: () => void) =>
    ipcRenderer.on('annotation:clear', () => cb()),
  onAnnotationUndo: (cb: () => void) =>
    ipcRenderer.on('annotation:undo', () => cb()),
  onOverlayModeChanged: (cb: (mode: string) => void) => {
    ipcRenderer.on('overlay:mode-changed', (_e, mode) => cb(mode))
  },
  onOverlaySetActive: (cb: (active: boolean) => void) => {
    ipcRenderer.on('overlay:set-active', (_e, active) => cb(active))
  },
  // The mode bar's top on this overlay's display, px under its top edge.
  onOverlayBarTop: (cb: (top: number) => void) => {
    ipcRenderer.on('overlay:bar-top', (_e, top) => cb(top))
  },
  // Mission Control is up: the overlay stays shown but steps aside (live
  // screen, clicks pass through, no tint or frames).
  onOverlayAside: (cb: (aside: boolean) => void) => {
    ipcRenderer.on('overlay:aside', (_e, aside) => cb(aside))
  },
  onOverlayFrozenBgraChanged: (
    cb: (data: { buffer: Uint8Array; width: number; height: number } | null) => void
  ) => {
    ipcRenderer.on('overlay:frozen-bgra-changed', (_e, data) => cb(data))
  },
  notifyOverlayBgReady: () => ipcRenderer.send('overlay:bg-ready'),
  overlayDrawing: (drawing: boolean) => ipcRenderer.send('overlay:drawing', drawing),
  notifyRoute: (route: string) => ipcRenderer.send('app:route-changed', route),

  // Wallpapers (Wikimedia Commons, Wallhaven)
  wallpapersFetch: (source: string, query: unknown) =>
    ipcRenderer.invoke('wallpapers:fetch', source, query),
  wallpapersCredit: (photo: unknown) => ipcRenderer.invoke('wallpapers:credit', photo),
  r2IsConfigured: () => ipcRenderer.invoke('share:r2IsConfigured'),
  wallpapersSetAsWallpaper: (photo: unknown, screenIds?: number[]) =>
    ipcRenderer.invoke('wallpapers:setAsWallpaper', photo, screenIds),
  wallpapersScreens: (previews?: boolean) => ipcRenderer.invoke('wallpapers:screens', previews),
  wallpapersCanReset: () => ipcRenderer.invoke('wallpapers:canReset'),
  wallpapersReset: () => ipcRenderer.invoke('wallpapers:reset'),

  // Stickers (R2-hosted, manifest-driven)
  stickersManifest: (opts?: { force?: boolean }) => ipcRenderer.invoke('stickers:manifest', opts),
  stickersFetch: (relPath: string) => ipcRenderer.invoke('stickers:fetch', relPath),

  // Clipboard
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  showSaveDialog: (opts: unknown) => ipcRenderer.invoke('dialog:save', opts),
  showOpenDialog: (opts: unknown) => ipcRenderer.invoke('dialog:open', opts),

  // App info
  platform: process.platform
})
