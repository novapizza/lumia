export {}

interface AppSettings {
  defaultSavePath: string
  theme: 'dark' | 'light'
  activeWorkflowId: string
  googleDriveRefreshToken: string
  googleDriveAccessToken: string
  // Derived flag sent by settings:get in place of the raw tokens (which are
  // blanked before crossing the IPC boundary). True when a refresh token is
  // stored in the main process.
  googleDriveConnected?: boolean
  // Whether this build has the Google Drive credentials (settings:get);
  // without them Settings hides Uploads.
  googleDriveAvailable?: boolean
  googleDriveTokenExpiresAt: number
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  lastCaptureKind: 'image' | 'video' | 'scroll'
  lastImageMode: 'region' | 'window' | 'all-screen' | 'screen' | 'scrolling'
  lastVideoMode: 'region' | 'window' | 'screen'
  // Captures include Lumia's own windows (app stays visible during capture
  // and recording; the window picker can target Lumia). Image + video.
  captureSelfWindow: boolean
  /** Keep the image editor's edit steps after closing an image. */
  scrollCaptureToTop: boolean
  saveEditHistory: boolean
  /** Image editor: Space + drag pans; off, the Cursor tool pans. */
  keyToDrag: boolean
  /** When Lumia's window comes back after the capture overlay (see
   *  OpenLumiaWhen in electron/settings.ts). */
  openLumiaAfter: 'open' | 'success' | 'captures' | 'recordings' | 'never'
  /** Copy every image capture to the clipboard. */
  copyAfterCapture: boolean
  /** Seconds counted down before a recording starts: 0, 3 or 5. */
  recordCountdown: number
  /** The save folder as a path (settings:get resolves the default). */
  captureFolderPath?: string
  /** Capture actions in the menu-bar icon's menu (hotkey ids). */
  trayActions: string[]
  /** The app bar's light / dark button; off hides it (Settings › Appearance). */
  showThemeButton: boolean
  /** Editor keys the user changed, per editor (src/lib/editor-keys.ts). */
  editorKeys: { image?: Record<string, string>; video?: Record<string, string> }
  printScreenAsCapture: boolean
  autoUpdateWhenHidden: boolean
  /** Custom theme picks (raw hex; null = default), see shared/theme-colors.ts. */
  themeAccent: string | null
  themeLightBase: string | null
  themeDarkBase: string | null
  printScreenPromptShown: boolean
  wallpaperSource: import('../shared/wallpapers').WallpaperSourceId
  wallpaperCategory: string | null
  wallpaper4kOnly: boolean
  wallpaperGrid: Record<string, {
    photos: import('./types').WallpaperPhoto[]
    cursor?: string
    fetchedAt: number
  }> | null
  // Last toolbar color / stroke width the user picked in the editor.
  annotationStyle: { color: string; strokeWidth: number }
}

declare global {
  interface Window {
    electronAPI: {
      captureScreenshot: (mode: 'all-screen' | 'region' | 'window' | 'screen') => Promise<string | void>

      // Recording

      runWorkflow: (templateId: string, imageData: string, destinationIndex?: number, historyId?: string) => Promise<import('./types').WorkflowResult>
      runInlineAction: (actionType: 'clipboard' | 'save', imageData: string, historyId?: string) => Promise<{ canceled?: boolean }>
      getTemplates: () => Promise<import('./types').WorkflowTemplate[]>
      saveTemplate: (template: import('./types').WorkflowTemplate) => Promise<import('./types').WorkflowTemplate>
      deleteTemplate: (id: string) => Promise<boolean>

      getHistoryStats: () => Promise<import('./types').HistoryStats>
      getPendingRecordingThumbnails: () => Promise<{ id: string; path: string; trimmed: boolean }[]>
      setRecordingThumbnail: (id: string, dataUrl: string) => Promise<boolean>
      recordingThumbnailsDone: (allOk: boolean) => Promise<void>
      getHistoryDays: (days: string[]) => Promise<Record<string, import('./types').HistoryItem[]>>
      /** An image's saved edit steps (null when none, or the setting is off). */
      getEditHistory: (id: string) => Promise<unknown>
      saveEditHistory: (id: string, data: unknown) => Promise<boolean>
      /** `onDisk`: only rows whose capture file is still there (still `limit` of them). */
      getHistoryItem: (id: string) => Promise<import('./types').HistoryItem | null>
      getRecentHistory: (limit: number, type?: 'screenshot' | 'recording', opts?: { onDisk?: boolean }) => Promise<import('./types').HistoryItem[]>
      /** `days` left out: every loaded day may have changed (files changed in the captures folder). */
      onHistoryChanged: (cb: (p: { days?: string[] }) => void) => () => void
      getFilmstrip: (id: string) => Promise<{ url: string } | null>
      saveFilmstrip: (id: string, dataUrl: string, thumbnailDataUrl?: string) => Promise<boolean>
      filmstripCanRun: () => Promise<boolean>
      reportFileGone: (id: string, kind: 'thumbnail' | 'strip') => Promise<boolean>
      deleteHistoryItem: (id: string) => Promise<boolean>
      deleteHistoryItems: (ids: string[]) => Promise<number>
      /** Show a clip's file in Finder / Explorer; false when it's gone. */
      revealHistoryFile: (id: string) => Promise<boolean>
      addHistoryItem: (item: import('./types').HistoryItem) => Promise<void>
      readHistoryFile: (filePath: string) => Promise<string | null>
      cleanupMissingHistory: (ids: string[]) => Promise<number>
      getMissingHistoryIds: () => Promise<string[]>
      /** Every history row's id (newest first), optionally one type only. */
      getAllHistoryIds: (type?: 'screenshot' | 'recording') => Promise<string[]>
      shareHistoryR2: (id: string) => Promise<import('./types').UploadResult>
      shareHistoryGoogleDrive: (id: string) => Promise<import('./types').UploadResult>
      downloadFromCloud: (id: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      restoreFromCloud: (id: string) => Promise<{ ok: boolean; item?: import('./types').HistoryItem; error?: string }>
      /** Stops a running restoreFromCloud for that row; it returns { error: 'cancelled' }. */
      cancelRestore: (id: string) => Promise<void>
      saveHistoryAnnotations: (id: string, annotations: import('./types').AnnotationObject[], flattenedDataUrl?: string) => Promise<import('./types').HistoryItem | null>

      getHotkeys: () => Promise<Record<string, string>>
      getDefaultHotkeys: () => Promise<Record<string, string>>
      setHotkeys: (hotkeys: Record<string, string>) => Promise<Record<string, string>>
      setHotkeyRecording: (recording: boolean) => Promise<void>
      getSettings: () => Promise<AppSettings>
      setSetting: (key: keyof AppSettings, value: unknown) => Promise<void>
      setPrintScreenAsCapture: (enabled: boolean) => Promise<{ warning?: string; detail?: string }>

      gdriveStartAuth: () => Promise<{ success: boolean; error?: string; cancelled?: boolean; denied?: boolean }>
      gdriveCancelAuth: () => Promise<{ ok: boolean }>
      gdriveDisconnect: () => Promise<{ success: boolean }>
      gdrivePickFolder: () => Promise<{ success: boolean; folder?: { id: string; name: string } | null; error?: string; cancelled?: boolean }>
      gdriveCancelPickFolder: () => Promise<{ ok: boolean }>
      gdriveFolderName: (folderId: string) => Promise<{ name: string } | { error: string }>
      onGdriveConnected: (cb: () => void) => void
      onGdriveFolderSelected: (cb: () => void) => void

      saveFile: (dataUrl: string, filePath: string) => Promise<string>

      setTitleBarTheme: (theme: 'dark' | 'light') => Promise<void>
      previewThemePick: (key: 'themeAccent' | 'themeLightBase' | 'themeDarkBase', value: string) => void
      windowReady: () => void
      notifyViewMounted: (route: string) => void
      /** A message from main shown as an in-app toast (the app is visible). */
      onToast: (cb: (t: { message: string; kind?: 'success' | 'error' | 'warning' | 'info'; icon?: string; detail?: string }) => void) => void
      onNavigate: (cb: (route: string, state?: Record<string, unknown>) => void) => void
      removeAllListeners: (channel: string) => void
      onWindowWillMove: (cb: () => void) => void

      confirmRegion: (payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) => Promise<void>
      cancelRegion: () => Promise<void>
      getWindowAt: (x: number, y: number) => Promise<{ x: number; y: number; width: number; height: number } | null>
      getWindowAtCursor: () => Promise<{ x: number; y: number; width: number; height: number } | null>
      confirmWindowPick: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
      confirmActiveWindow: () => Promise<string | null>
      cancelWindowPick: () => Promise<void>
      confirmMonitorPick: () => Promise<void>
      cancelMonitorPick: () => Promise<void>
      switchOverlayMode: (mode:
        | 'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'
        | 'video-region' | 'video-window' | 'video-screen'
      ) => Promise<void>
      onOverlayModeChanged: (cb: (mode: string) => void) => void
      onOverlaySetActive: (cb: (active: boolean) => void) => void
      onOverlayBarTop?: (cb: (top: number) => void) => void
      onOverlayAside?: (cb: (aside: boolean) => void) => void
      onOverlayFrozenBgraChanged: (
        cb: (data: { buffer: Uint8Array; width: number; height: number } | null) => void
      ) => void
      notifyOverlayBgReady: () => void
      overlayDrawing: (drawing: boolean) => void
      notifyRoute: (route: string) => void

      // Video file actions (operate on saved recording files)
      videoSaveAs:   (filePath: string) => Promise<{ canceled: boolean; savedPath?: string }>
      videoCopyFile: (filePath: string) => Promise<{ ok: boolean; fallback?: 'text'; error?: string }>
      /** Lossless trim of a history recording (original kept). Thumbnail is a small JPEG data URL of the new first frame. */
      videoTrim: (historyId: string, startMs: number, endMs: number, thumbnailDataUrl?: string) => Promise<{ ok: boolean; error?: string; item?: import('./types').HistoryItem | null }>
      /** Drop the trimmed copy and go back to the original recording. */
      videoClearTrim: (historyId: string, thumbnailDataUrl?: string) => Promise<{ ok: boolean; error?: string; item?: import('./types').HistoryItem | null }>
      videoUploadR2: (filePath: string) => Promise<import('./types').UploadResult>
      videoUploadGoogleDrive: (filePath: string) => Promise<import('./types').UploadResult>

      // Video recording — overlay mode selection
      startVideoCapture: (mode: 'region' | 'window' | 'screen') => Promise<void>
      confirmVideoRegion: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
      confirmVideoWindow: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
      confirmVideoScreen: () => Promise<void>
      cancelVideo: () => Promise<void>

      // Video recording — RecorderHost & Toolbar control
      recorderGetTarget: () => Promise<{
        kind: 'region' | 'window' | 'screen'
        sourceId: string
        displayId: number
        rect?: { x: number; y: number; width: number; height: number }   // overlay-local DIP (region/window)
        displayDipSize: { width: number; height: number }                // display DIP size — scale derived at draw time
        displayScaleFactor: number                                       // pins stream to exact physical dims
        outputSize?: { width: number; height: number }                   // physical-pixel output canvas dims (region/window)
      } | null>
      /** The watermark in both inks (white / near-black name), PNG data URLs. */
      recorderGetWatermark: () => Promise<{ light: string; dark: string } | null>
      recorderReady: (ok: boolean, error?: string, micAvailable?: boolean) => Promise<void>
      recorderStateChange: (state: 'countdown' | 'recording' | 'paused' | 'stopping' | 'saving' | 'done' | 'error', payload?: unknown) => Promise<void>
      recorderTick: (elapsedMs: number) => Promise<void>
      recorderSaveBegin: () => Promise<{ ok: boolean }>
      recorderSaveChunk: (chunk: ArrayBuffer) => Promise<{ ok: boolean }>
      /** `fps`: the rate the recorder ran at, saved on the row (`HistoryItem.fps`). */
      recorderSaveEnd: (thumbnailDataUrl: string, durationMs: number, fps?: number, stripDataUrl?: string) => Promise<{ filePath: string }>
      onRecorderBegin: (cb: () => void) => void
      onRecorderPause: (cb: () => void) => void
      onRecorderResume: (cb: () => void) => void
      onRecorderStopRequest: (cb: () => void) => void
      onRecorderCancelRequest: (cb: () => void) => void
      onRecorderMicToggle: (cb: (enabled: boolean) => void) => void

      // Toolbar commands (toolbar renderer → main → recorder host)
      toolbarBegin: () => Promise<void>
      toolbarIsShown?: () => Promise<boolean>
      toolbarPause: () => Promise<void>
      toolbarResume: () => Promise<void>
      toolbarStop: () => Promise<void>
      toolbarCancel: () => Promise<void>
      toolbarToggleMic: (enabled: boolean) => Promise<void>
      toolbarToggleAnnotation: (enabled: boolean) => Promise<void>
      toolbarSetInteractive: (interactive: boolean) => void
      onToolbarState: (cb: (state: {
        phase?: 'countdown' | 'recording' | 'paused' | 'stopping' | 'saving' | 'done' | 'error'
        elapsedMs?: number
        countdown?: number
        micEnabled?: boolean
        annotationOn?: boolean
        error?: string
      }) => void) => void

      // Live annotation overlay (during recording)
      annotationGetState: () => Promise<{ tool: string; color: string; strokeWidth: number }>
      annotationSetTool: (tool: string) => Promise<void>
      annotationSetColor: (color: string, mirror?: boolean) => Promise<void>
      annotationSetStroke: (size: number, mirror?: boolean) => Promise<void>
      annotationClear: () => Promise<void>
      annotationUndo: () => Promise<void>
      annotationRedo?: () => Promise<void>
      annotationReportEditState?: (s: { selectedKind: string | null; canUndo: boolean; canRedo: boolean }) => void
      annotationGetEditState?: () => Promise<{ selectedKind: string | null; canUndo: boolean; canRedo: boolean }>
      onAnnotationEditState?: (cb: (s: { selectedKind: string | null; canUndo: boolean; canRedo: boolean }) => void) => void
      onAnnotationRedo?: (cb: () => void) => void
      annotationOverlaySetInteractive: (interactive: boolean) => void
      annotationOverlayWantFocus?: (want: boolean) => void
      onAnnotationState: (cb: (state: { tool: string; color: string; strokeWidth: number }) => void) => void
      onAnnotationClear: (cb: () => void) => void
      onAnnotationUndo: (cb: () => void) => void

      // Wallpapers (Wikimedia Commons, Wallhaven)
      wallpapersFetch: (
        source: import('../shared/wallpapers').WallpaperSourceId,
        query: import('../shared/wallpapers').WallpaperQuery,
      ) => Promise<
        | { ok: true; batch: import('../shared/wallpapers').WallpaperBatch }
        | { ok: false; error: string }
      >
      /** Uploader and original link, where the source needs a second call. `{}` on failure. */
      wallpapersCredit: (photo: import('@/types').WallpaperPhoto) => Promise<Partial<import('@/types').WallpaperPhoto>>
      r2IsConfigured: () => Promise<boolean>
      /** `screenIds`: the screens to set it on (all when left out). */
      wallpapersSetAsWallpaper: (photo: import('@/types').WallpaperPhoto, screenIds?: number[]) => Promise<
        | { ok: true; filePath: string }
        | { ok: false; error: string }
      >
      /** The screens a wallpaper can go on, left to right; `previews`: with
       *  a small picture of each (a data URL). */
      wallpapersScreens: (previews?: boolean) => Promise<{ id: number; label: string; width: number; height: number; preview?: string }[]>
      /** Whether Reset has a wallpaper to put back. */
      wallpapersCanReset: () => Promise<boolean>
      /** Put back the wallpaper from before Lumia's first change. */
      wallpapersReset: () => Promise<{ ok: true } | { ok: false; error: string }>

      // Stickers (R2-hosted, manifest-driven)
      stickersManifest: (opts?: { force?: boolean }) => Promise<
        | { ok: true; manifest: import('@/types').StickerManifest }
        | { ok: false; error: string }
      >
      stickersFetch: (relPath: string) => Promise<
        | { ok: true; dataUrl: string }
        | { ok: false; error: string }
      >

      writeClipboardText: (text: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      showSaveDialog: (opts: unknown) => Promise<{ filePath?: string; canceled: boolean }>
      showOpenDialog: (opts: unknown) => Promise<{ filePaths: string[]; canceled: boolean }>

      onUpdateDownloaded: (cb: (version: string) => void) => void
      onUpdateStatus: (cb: (data: {
        status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
        version?: string
        percent?: number
        error?: string
      }) => void) => void
      installUpdate: () => Promise<void>
      downloadUpdate: () => Promise<{ ok: boolean; error?: string }>
      isAutoUpdateAvailable: () => Promise<boolean>
      getAppVersion: () => Promise<string>
      showLogs: () => Promise<void>
      /** Settings › General › Save to: the folder dialog. null when cancelled.
       *  `imported`: Lumia files already in the new folder, added to its
       *  history; `movable`: rows the previous folder (`from`) still has. */
      chooseCaptureFolder: () => Promise<{ folder?: string; from?: string; imported?: number; movable?: number; error?: string; reason?: string } | null>
      /** Move the previous save folder's files and rows into the current one. */
      moveCaptureFiles: (from: string) => Promise<{ moved: number; failed: number }>
      openLicenses: () => Promise<{ ok: true } | { error: string }>

      platform: NodeJS.Platform

      // Scrolling capture
      confirmScrollRegion(rect: { x: number; y: number; width: number; height: number }): Promise<void>
      cancelScrollRegion(): Promise<void>
      // Unified scroll launcher + extension-bridge status. `launchScrollCapture`
      // with no method goes by the app in front (a connected browser: the
      // extension, anything else: the screen scroll); an explicit
      // 'extension' returns { ok: false, error: 'extension-not-connected' }
      // instead of falling back, so the UI can show setup help.
      launchScrollCapture(method?: 'extension' | 'screen'): Promise<{ ok: boolean; error?: string }>
      // `outdated` lists browsers whose connected extension is older than the
      // copy this app ships (`bundledVersion`) — the app and extension update
      // on independent schedules, so the Dashboard nudges instead of assuming.
      getScrollExtensionStatus(): Promise<{ connected: boolean; browsers: string[]; clients: Array<{ id: number; browser: string; version: string; outdated: boolean }>; bundledVersion: string | null; outdated: string[] }>
      onScrollExtensionStatus(cb: (status: { connected: boolean; browsers: string[]; clients: Array<{ id: number; browser: string; version: string; outdated: boolean }>; bundledVersion: string | null; outdated: string[] }) => void): void
      openScrollExtensionFolder(): Promise<string>
      // Multi-browser picker: previews carry a downscaled JPEG of each
      // browser's active tab (null when the tab can't be photographed).
      getScrollExtensionPreviews(): Promise<Array<{ clientId: number; browser: string; title: string; url: string; dataUrl: string | null }>>
      startScrollCaptureWith(clientId: number): Promise<{ ok: boolean; error?: string; detail?: string }>
      onScrollExtensionPick(cb: () => void): void
      getOverlayMode(): Promise<'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'>
    }
  }
}
