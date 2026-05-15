export {}

interface AppSettings {
  defaultSavePath: string
  theme: 'dark' | 'light' | 'system'
  activeWorkflowId: string
  googleDriveRefreshToken: string
  googleDriveAccessToken: string
  googleDriveTokenExpiresAt: number
  googleDriveFolderId: string
  launchAtStartup: boolean
  historyRetentionDays: number
  lastCaptureKind: 'image' | 'video'
  lastImageMode: 'region' | 'window' | 'all-screen' | 'screen' | 'scrolling'
  lastVideoMode: 'region' | 'window' | 'screen'
  printScreenAsCapture: boolean
  printScreenPromptShown: boolean
  wallpaperCategories: string[]
  wallpaperCustomCategories: Array<{ id: string; label: string; query: string }>
  wallpaperGrid: {
    photos: import('./types').UnsplashPhoto[]
    pickId: string
    fetchedAt: number
  } | null
}

declare global {
  interface Window {
    electronAPI: {
      captureScreenshot: (mode: 'all-screen' | 'region' | 'window' | 'screen') => Promise<string | void>
      newCapture: () => Promise<void>

      // Recording
      getRecordingSources: () => Promise<{ id: string; name: string; thumbnail: string }[]>
      saveRecording: (buffer: ArrayBuffer, filename: string) => Promise<string>
      hideForRecording: () => Promise<void>
      showAfterRecording: () => Promise<void>

      runWorkflow: (templateId: string, imageData: string, destinationIndex?: number, historyId?: string) => Promise<import('./types').WorkflowResult>
      runInlineAction: (actionType: 'clipboard' | 'save', imageData: string) => Promise<{ canceled?: boolean }>
      getTemplates: () => Promise<import('./types').WorkflowTemplate[]>
      saveTemplate: (template: import('./types').WorkflowTemplate) => Promise<import('./types').WorkflowTemplate>
      deleteTemplate: (id: string) => Promise<boolean>

      getHistory: () => Promise<import('./types').HistoryItem[]>
      deleteHistoryItem: (id: string) => Promise<boolean>
      openHistoryFile: (filePath: string) => Promise<void>
      addHistoryItem: (item: import('./types').HistoryItem) => Promise<void>
      readHistoryFile: (filePath: string) => Promise<string | null>
      cleanupMissingHistory: () => Promise<number>
      shareHistoryR2: (id: string) => Promise<import('./types').UploadResult>
      shareHistoryGoogleDrive: (id: string) => Promise<import('./types').UploadResult>
      saveHistoryAnnotations: (id: string, annotations: import('./types').AnnotationObject[], flattenedDataUrl?: string) => Promise<import('./types').HistoryItem | null>

      getHotkeys: () => Promise<Record<string, string>>
      getDefaultHotkeys: () => Promise<Record<string, string>>
      setHotkeys: (hotkeys: Record<string, string>) => Promise<Record<string, string>>
      resetHotkeys: () => Promise<Record<string, string>>
      setHotkeyRecording: (recording: boolean) => Promise<void>
      getSettings: () => Promise<AppSettings>
      setSetting: (key: keyof AppSettings, value: unknown) => Promise<void>
      setPrintScreenAsCapture: (enabled: boolean) => Promise<{ warning?: string }>

      gdriveStartAuth: () => Promise<{ success: boolean; error?: string; cancelled?: boolean }>
      gdriveCancelAuth: () => Promise<{ ok: boolean }>
      gdriveDisconnect: () => Promise<{ success: boolean }>
      gdrivePickFolder: () => Promise<{ success: boolean; folder?: { id: string; name: string } | null; error?: string; cancelled?: boolean }>
      gdriveCancelPickFolder: () => Promise<{ ok: boolean }>
      onGdriveConnected: (cb: () => void) => void
      onGdriveFolderSelected: (cb: () => void) => void

      saveFile: (dataUrl: string, filePath: string) => Promise<string>
      readLocalFile: (filePath: string) => Promise<ArrayBuffer>

      quitApp: () => Promise<void>
      toggleDevTools: () => Promise<void>
      reloadWindow: () => Promise<void>
      forceReloadWindow: () => Promise<void>
      setTitleBarTheme: (theme: 'dark' | 'light' | 'system') => Promise<void>
      windowReady: () => void
      navigate: (route: string) => void
      notifyViewMounted: (route: string) => void
      onCaptureReady: (cb: (data: { dataUrl: string; source: string }) => void) => void
      onNavigate: (cb: (route: string, state?: Record<string, unknown>) => void) => void
      onRegionSelected: (cb: (rect: { x: number; y: number; width: number; height: number }) => void) => void
      onRecorderOpen: (cb: () => void) => void
      onRecorderStop: (cb: () => void) => void
      removeAllListeners: (channel: string) => void

      confirmRegion: (payload: { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }) => Promise<void>
      cancelRegion: () => Promise<void>
      getWindowAt: (x: number, y: number) => Promise<{ x: number; y: number; width: number; height: number } | null>
      confirmWindowPick: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
      cancelWindowPick: () => Promise<void>
      confirmMonitorPick: () => Promise<void>
      cancelMonitorPick: () => Promise<void>
      switchOverlayMode: (mode:
        | 'region' | 'window-pick' | 'monitor-pick'
        | 'video-region' | 'video-window' | 'video-screen'
      ) => Promise<void>
      onOverlayModeChanged: (cb: (mode: string) => void) => void
      onOverlaySetActive: (cb: (active: boolean) => void) => void
      onOverlayFrozenBgChanged: (cb: (dataUrl: string | null) => void) => void
      notifyOverlayBgReady: () => void
      overlayDrawing: (drawing: boolean) => void
      notifyRoute: (route: string) => void

      // Video file actions (operate on saved recording files)
      videoSaveAs:   (filePath: string) => Promise<{ canceled: boolean; savedPath?: string }>
      videoCopyFile: (filePath: string) => Promise<{ ok: boolean; fallback?: 'text'; error?: string }>
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
      recorderGetWatermark: () => Promise<string | null>
      recorderReady: (ok: boolean, error?: string) => Promise<void>
      recorderStateChange: (state: 'countdown' | 'recording' | 'paused' | 'stopping' | 'saving' | 'done' | 'error', payload?: unknown) => Promise<void>
      recorderTick: (elapsedMs: number) => Promise<void>
      recorderSaveBlob: (buffer: ArrayBuffer, thumbnailDataUrl: string, durationMs: number) => Promise<{ filePath: string }>
      onRecorderBegin: (cb: () => void) => void
      onRecorderPause: (cb: () => void) => void
      onRecorderResume: (cb: () => void) => void
      onRecorderStopRequest: (cb: () => void) => void
      onRecorderCancelRequest: (cb: () => void) => void
      onRecorderMicToggle: (cb: (enabled: boolean) => void) => void

      // Toolbar commands (toolbar renderer → main → recorder host)
      toolbarBegin: () => Promise<void>
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
      annotationSetColor: (color: string) => Promise<void>
      annotationSetStroke: (size: number) => Promise<void>
      annotationClear: () => Promise<void>
      annotationUndo: () => Promise<void>
      annotationOverlaySetInteractive: (interactive: boolean) => void
      onAnnotationState: (cb: (state: { tool: string; color: string; strokeWidth: number }) => void) => void
      onAnnotationClear: (cb: () => void) => void
      onAnnotationUndo: (cb: () => void) => void

      // OCR & Auto-Blur
      ocrScan: (dataUrl: string) => Promise<import('@/types').AutoBlurResult>

      // Wallpapers (Unsplash)
      wallpapersRandom: (opts: {
        picks: Array<{ id: string; topic?: string; query?: string }>
        count?: number
        orientation?: 'landscape' | 'portrait' | 'squarish'
        preferFeatured?: boolean
      }) => Promise<
        | { ok: true; photos: import('@/types').UnsplashPhoto[]; pickId: string }
        | { ok: false; error: string }
      >
      wallpapersTrackDownload: (downloadLocation: string) => Promise<{ ok: true }>
      wallpapersIsConfigured: () => Promise<boolean>
      wallpapersSetAsWallpaper: (photo: import('@/types').UnsplashPhoto) => Promise<
        | { ok: true; filePath: string }
        | { ok: false; error: string }
      >

      writeClipboardText: (text: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      openPath: (path: string) => Promise<void>
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
      checkForUpdates: () => Promise<{ ok: boolean; dev?: boolean; error?: string }>
      isAutoUpdateAvailable: () => Promise<boolean>
      getAppVersion: () => Promise<string>
      onAbout: (cb: () => void) => void

      platform: NodeJS.Platform

      // Scrolling capture
      startScrollCapture(opts?: {
        delay?: number; maxFrames?: number;
        scrollMethod?: 'mouseWheel' | 'vscroll' | 'downArrow' | 'pageDown';
        scrollToTopFirst?: boolean
      }): Promise<{ ok: boolean; error?: string }>
      cancelScrollCapture(): Promise<void>
      onScrollCaptureProgress(cb: (data: { frame: number; maxFrames: number; phase?: 'capturing' | 'stitching' }) => void): void
      onScrollCaptureResult(cb: (data: { dataUrl: string }) => void): void
      onScrollCaptureOpen(cb: () => void): void
      onScrollCaptureError(cb: (data: { error: string }) => void): void
      confirmScrollRegion(rect: { x: number; y: number; width: number; height: number }): Promise<void>
      cancelScrollRegion(): Promise<void>
      getOverlayMode(): Promise<'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'>
    }
  }
}
