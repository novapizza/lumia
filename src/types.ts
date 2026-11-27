export interface WorkflowTemplate {
  id: string
  name: string
  icon: string
  builtIn?: boolean
  afterCapture: AfterCaptureStep[]
  destinations: UploadDestination[]
  afterUpload: AfterUploadStep[]
}

export type AfterCaptureStep =
  | { type: 'annotate' }
  | { type: 'save'; path: string }
  | { type: 'clipboard' }

export type UploadDestination =
  | { type: 'google-drive'; folderId?: string }
  | { type: 'r2'; bucket?: string }

export type AfterUploadStep =
  | { type: 'copyUrl'; which: 'first' | 'all' }
  | { type: 'openUrl' }
  | { type: 'notify'; message?: string }
  | { type: 'osShare' }

export interface UploadResult {
  destination: string
  success: boolean
  url?: string
  error?: string
}

export interface WorkflowResult {
  templateId: string
  uploads: UploadResult[]
  savedPath?: string
  copiedToClipboard: boolean
}

// Persisted shape of an annotation stroke/shape. Structurally matches
// Canvas' DrawObject but typed loosely so main can round-trip without
// depending on renderer enums.
export interface AnnotationObject {
  id: string
  type: string
  points?: number[]
  x?: number; y?: number
  width?: number; height?: number
  radiusX?: number; radiusY?: number
  text?: string
  color: string
  strokeWidth: number
  fill?: string
  isBlur?: boolean
}

/** The app and window a capture came from (electron/capture-source.ts). */
export interface CaptureSource {
  /** App name: macOS the owner name ("Google Chrome"), Windows the exe name
   *  without ".exe" ("chrome"), the browser for extension captures. */
  app?: string
  /** Window title, or the page title for extension captures. */
  title?: string
  /** A region or screen showing two or more windows (2026-11-23): no app or
   *  title, shown as "Region / Multiple". */
  multiple?: boolean
}

/** How a clip was captured (HistoryItem.captureMode). */
export type ClipCaptureMode = 'region' | 'window' | 'screen' | 'scroll'

export interface HistoryItem {
  id: string
  timestamp: number
  name: string
  filePath?: string
  dataUrl?: string
  thumbnailUrl?: string
  size?: number
  type: 'screenshot' | 'recording'
  // Where it was captured: the app and window under the captured area,
  // resolved at confirm time. Absent on rows from before 2026-11-21 and
  // when the OS wouldn't say.
  source?: CaptureSource
  // How it was captured: a region, one window, a whole screen, or a page
  // scrolled by the browser extension. Set from 2026-11-21; the list view
  // shows the source only for window and scroll captures, and names the
  // kind for the others ("Region", "Screen").
  captureMode?: ClipCaptureMode
  uploads: UploadResult[]
  // Set by main on history:days / history:recent when filePath is missing from disk. Never
  // persisted — the store keeps items even when files are gone so the user
  // can clean them up explicitly.
  fileMissing?: boolean
  // Vector annotations layered over the original. Re-editable: the Editor
  // replays each entry as its own commit on mount so native Undo steps back
  // through them one at a time.
  annotations?: AnnotationObject[]
  // Pixel-flat counterpart of `annotations`, written by the Editor on every
  // committing action (Copy/Share/upload — not Save).
  // Recordings reuse this field for the trimmed copy, so every "edited copy
  // if present, else original" consumer picks up the trim automatically.
  annotatedFilePath?: string
  // Recording only: the applied trim (cut from the original). Absent = untrimmed.
  trim?: VideoTrim
  // Recording only: length of the original file in ms (the trimmed length is
  // trim.endMs - trim.actualStartMs). Absent until main has read it.
  durationMs?: number
  // Recording only, set by main on the rows it hands over: no card preview
  // / no filmstrip yet (src/lib/strip-jobs.ts makes them).
  needsPreview?: boolean
  needsStrip?: boolean
  // Recording only: the frame rate it was recorded at (absent on rows from
  // before 2026-11-27; see shared/recording.ts recordingFps).
  fps?: number
  // Screenshot only: pixel size of the file the card stands for (the edited
  // copy when there is one, else the original), read from its PNG header by
  // history:days / history:recent. Never persisted — set only on the IPC
  // response, like fileMissing.
  width?: number
  height?: number
}

/** Applied trim on a recording. `startMs`/`endMs` are what the user picked;
 *  `actualStartMs` is where the lossless cut really begins (the keyframe at
 *  or before `startMs`). */
export interface VideoTrim {
  startMs: number
  endMs: number
  actualStartMs: number
}

/** One sticker within a category. `path` is relative to the stickers base URL
 *  and doubles as the cache key + the argument passed to `stickersFetch`. */
export interface StickerEntry {
  id: string
  name: string
  path: string
}

export interface StickerCategory {
  id: string
  name: string
  /** Relative path to the category's tab icon (the WhatsApp-style top tab). */
  icon: string
  stickers: StickerEntry[]
}

export interface StickerManifest {
  version: number
  categories: StickerCategory[]
}

export type { WallpaperPhoto } from '../shared/wallpapers'

/** Totals from history_stat.json (mirror of electron/history-days.ts). */
export interface DayStat { day: string; total: number; screenshot: number; recording: number }

export interface HistoryStats {
  version: 1
  cleanupVersion: number
  total: number
  screenshot: number
  recording: number
  /** Days with at least one capture, newest first. */
  days: DayStat[]
}
