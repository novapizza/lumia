import { contextBridge, ipcRenderer } from 'electron'

export type CaptureMode = 'all-screen' | 'region' | 'window' | 'screen'
export type RecordMode = 'fullscreen' | 'window' | 'region'

contextBridge.exposeInMainWorld('electronAPI', {
  // Capture
  captureScreenshot: (mode: CaptureMode) =>
    ipcRenderer.invoke('capture:screenshot', mode),
  newCapture: () => ipcRenderer.invoke('capture:new'),

  // Recording
  getRecordingSources: () => ipcRenderer.invoke('record:getSources'),
  saveRecording: (buffer: ArrayBuffer, filename: string) =>
    ipcRenderer.invoke('record:save', buffer, filename),
  hideForRecording: () => ipcRenderer.invoke('record:hide'),
  showAfterRecording: () => ipcRenderer.invoke('record:show'),

  // Workflow
  runWorkflow: (templateId: string, imageData: string, destinationIndex?: number, historyId?: string) =>
    ipcRenderer.invoke('workflow:run', templateId, imageData, destinationIndex, historyId),
  runInlineAction: (actionType: 'clipboard' | 'save', imageData: string, historyId?: string) =>
    ipcRenderer.invoke('workflow:inlineAction', actionType, imageData, historyId),
  getTemplates: () => ipcRenderer.invoke('workflow:getTemplates'),
  saveTemplate: (template: unknown) => ipcRenderer.invoke('workflow:saveTemplate', template),
  deleteTemplate: (id: string) => ipcRenderer.invoke('workflow:deleteTemplate', id),

  // History
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteHistoryItem: (id: string) => ipcRenderer.invoke('history:delete', id),
  openHistoryFile: (filePath: string) => ipcRenderer.invoke('history:openFile', filePath),
  addHistoryItem: (item: unknown) => ipcRenderer.invoke('history:addCapture', item),
  readHistoryFile: (filePath: string) => ipcRenderer.invoke('history:readAsDataUrl', filePath),
  cleanupMissingHistory: () => ipcRenderer.invoke('history:cleanupMissing'),
  shareHistoryR2: (id: string) => ipcRenderer.invoke('history:shareR2', id),
  shareHistoryGoogleDrive: (id: string) => ipcRenderer.invoke('history:shareGoogleDrive', id),
  saveHistoryAnnotations: (id: string, annotations: unknown[], flattenedDataUrl?: string) =>
    ipcRenderer.invoke('history:saveAnnotations', id, annotations, flattenedDataUrl),

  // Hotkeys
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  getDefaultHotkeys: () => ipcRenderer.invoke('hotkeys:getDefaults'),
  setHotkeys: (hotkeys: Record<string, string>) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
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
  onGdriveConnected: (cb: () => void) => ipcRenderer.on('gdrive:connected', cb),
  onGdriveFolderSelected: (cb: () => void) => ipcRenderer.on('gdrive:folderSelected', cb),

  // Save file
  saveFile: (dataUrl: string, filePath: string) => ipcRenderer.invoke('capture:saveFile', dataUrl, filePath),

  // Read local file as ArrayBuffer (for video blob URL playback)
  readLocalFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),

  // App actions (for renderer custom menu)
  quitApp: () => ipcRenderer.invoke('app:quit'),
  toggleDevTools: () => ipcRenderer.invoke('devtools:toggle'),
  reloadWindow: () => ipcRenderer.invoke('window:reload'),
  forceReloadWindow: () => ipcRenderer.invoke('window:force-reload'),

  // Update native titlebar overlay colors on theme change (Windows)
  setTitleBarTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('titlebar:setTheme', theme),

  // Tell main the renderer has finished its critical initial work (data
  // fetches, fonts) so it can show() the BrowserWindow. Without this main
  // shows on ready-to-show with content still loading. fire-and-forget — main
  // listens with ipcMain.once and a fallback timer in case this never arrives.
  windowReady: () => ipcRenderer.send('window:ready'),

  // Navigation (tell main which view to show in the same window)
  navigate: (route: string) => ipcRenderer.invoke('navigate', route),

  // Renderer signals that a route has just mounted. Main uses this to wait
  // out the IPC + React-render delay before win.show(), otherwise the user
  // sees a flash of the previous route while the window comes up.
  notifyViewMounted: (route: string) => ipcRenderer.send('view:mounted', route),

  // Events from main → renderer
  onCaptureReady: (cb: (data: { dataUrl: string; source: string }) => void) => {
    ipcRenderer.on('capture:ready', (_e, data) => cb(data))
  },
  onNavigate: (cb: (route: string, state?: Record<string, unknown>) => void) => {
    ipcRenderer.on('navigate', (_e, route, state) => cb(route, state))
  },
  onRegionSelected: (cb: (rect: { x: number; y: number; width: number; height: number }) => void) => {
    ipcRenderer.on('region:selected', (_e, rect) => cb(rect))
  },
  onRecorderOpen: (cb: () => void) => { ipcRenderer.on('recorder:open', cb) },
  onRecorderStop: (cb: () => void) => { ipcRenderer.on('recorder:stop', cb) },
  onUpdateDownloaded: (cb: (version: string) => void) => { ipcRenderer.on('update:downloaded', (_e, version: string) => cb(version)) },
  onUpdateStatus: (cb: (data: { status: string; version?: string; percent?: number; error?: string }) => void) => {
    ipcRenderer.on('update:status', (_e, data) => cb(data))
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  isAutoUpdateAvailable: () => ipcRenderer.invoke('update:available'),
  onAbout: (cb: () => void) => { ipcRenderer.on('app:about', () => cb()) },
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Scrolling capture
  startScrollCapture: (opts: unknown) =>
    ipcRenderer.invoke('scroll-capture:start', opts),
  cancelScrollCapture: () =>
    ipcRenderer.invoke('scroll-capture:cancel'),
  onScrollCaptureProgress: (cb: (data: { frame: number; maxFrames: number }) => void) =>
    ipcRenderer.on('scroll-capture:progress', (_e, data) => cb(data)),
  onScrollCaptureResult: (cb: (data: { dataUrl: string }) => void) =>
    ipcRenderer.on('scroll-capture:result', (_e, data) => cb(data)),
  onScrollCaptureOpen: (cb: () => void) =>
    ipcRenderer.on('scroll-capture:open', cb),
  onScrollCaptureError: (cb: (data: { error: string }) => void) =>
    ipcRenderer.on('scroll-capture:error', (_e, data) => cb(data)),
  confirmScrollRegion: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('scroll-region:confirm', rect),
  cancelScrollRegion: () =>
    ipcRenderer.invoke('scroll-region:cancel'),
  getOverlayMode: () =>
    ipcRenderer.invoke('overlay:get-mode'),

  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  // Overlay-specific
  confirmRegion: (payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) =>
    ipcRenderer.invoke('region:confirm', payload),
  cancelRegion: () => ipcRenderer.invoke('region:cancel'),
  getWindowAt: (x: number, y: number) => ipcRenderer.invoke('window-pick:get-window-at', x, y),
  confirmWindowPick: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('window-pick:confirm', rect),
  cancelWindowPick: () => ipcRenderer.invoke('window-pick:cancel'),
  confirmMonitorPick: () => ipcRenderer.invoke('monitor-pick:confirm'),
  cancelMonitorPick: () => ipcRenderer.invoke('monitor-pick:cancel'),
  switchOverlayMode: (mode:
    | 'region' | 'window-pick' | 'monitor-pick'
    | 'video-region' | 'video-window' | 'video-screen'
  ) => ipcRenderer.invoke('overlay:switch-mode', mode),

  // Video file actions (operate on saved recording files)
  videoSaveAs:   (filePath: string) => ipcRenderer.invoke('video:save-as', filePath),
  videoCopyFile: (filePath: string) => ipcRenderer.invoke('video:copy-file', filePath),
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
  recorderReady: (ok: boolean, error?: string) => ipcRenderer.invoke('recorder:ready', ok, error),
  recorderStateChange: (state: string, payload?: unknown) =>
    ipcRenderer.invoke('recorder:state', state, payload),
  recorderTick: (elapsedMs: number) => ipcRenderer.invoke('recorder:tick', elapsedMs),
  recorderSaveBlob: (buffer: ArrayBuffer, thumbnailDataUrl: string, durationMs: number) =>
    ipcRenderer.invoke('recorder:save-blob', buffer, thumbnailDataUrl, durationMs),
  onRecorderBegin: (cb: () => void) => ipcRenderer.on('recorder:begin', cb),
  onRecorderPause: (cb: () => void) => ipcRenderer.on('recorder:pause', cb),
  onRecorderResume: (cb: () => void) => ipcRenderer.on('recorder:resume', cb),
  onRecorderStopRequest: (cb: () => void) => ipcRenderer.on('recorder:stop-request', cb),
  onRecorderCancelRequest: (cb: () => void) => ipcRenderer.on('recorder:cancel-request', cb),
  onRecorderMicToggle: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on('recorder:mic-toggle', (_e, enabled: boolean) => cb(enabled)),

  toolbarBegin: () => ipcRenderer.invoke('toolbar:begin'),
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
  annotationSetColor: (color: string) => ipcRenderer.invoke('annotation:set-color', color),
  annotationSetStroke: (size: number) => ipcRenderer.invoke('annotation:set-stroke', size),
  annotationClear: () => ipcRenderer.invoke('annotation:clear'),
  annotationUndo: () => ipcRenderer.invoke('annotation:undo'),
  // Hover-driven click-through for the live annotation overlay. The overlay
  // sits in pass-through mode while tool='none' so the user can interact
  // with the recorded app — cursor entering a stroke flips the overlay
  // back to capture so the click selects the shape (for delete/drag),
  // cursor leaving flips it back. Same pattern as toolbar:set-interactive.
  annotationOverlaySetInteractive: (interactive: boolean) =>
    ipcRenderer.send('annotation-overlay:set-interactive', interactive),
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
  onOverlayFrozenBgraChanged: (
    cb: (data: { buffer: Uint8Array; width: number; height: number } | null) => void
  ) => {
    ipcRenderer.on('overlay:frozen-bgra-changed', (_e, data) => cb(data))
  },
  notifyOverlayBgReady: () => ipcRenderer.send('overlay:bg-ready'),
  overlayDrawing: (drawing: boolean) => ipcRenderer.send('overlay:drawing', drawing),
  notifyRoute: (route: string) => ipcRenderer.send('app:route-changed', route),

  // OCR & Auto-Blur
  ocrScan: (dataUrl: string) =>
    ipcRenderer.invoke('ocr:scan', dataUrl),

  // Wallpapers (Unsplash)
  wallpapersRandom: (opts: {
    picks: Array<{ id: string; topic?: string; query?: string }>
    count?: number
    orientation?: 'landscape' | 'portrait' | 'squarish'
    preferFeatured?: boolean
  }) => ipcRenderer.invoke('wallpapers:random', opts),
  wallpapersTrackDownload: (downloadLocation: string) =>
    ipcRenderer.invoke('wallpapers:trackDownload', downloadLocation),
  wallpapersIsConfigured: () => ipcRenderer.invoke('wallpapers:isConfigured'),
  wallpapersSetAsWallpaper: (photo: unknown) =>
    ipcRenderer.invoke('wallpapers:setAsWallpaper', photo),

  // Clipboard
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  showSaveDialog: (opts: unknown) => ipcRenderer.invoke('dialog:save', opts),
  showOpenDialog: (opts: unknown) => ipcRenderer.invoke('dialog:open', opts),

  // App info
  platform: process.platform
})
