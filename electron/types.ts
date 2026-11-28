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

// Structural snapshot of an annotation shape. Mirrors Canvas' DrawObject but
// kept loose (type: string) so main doesn't need to know the Tool union.
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
  /** Sticker only: manifest-relative R2 path (e.g. "cat-stickers/01-love.png").
   *  Stored instead of the data URL so history.json stays small; the renderer
   *  re-resolves it through the cached sticker fetch on reopen. */
  src?: string
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
  // Preview JPEG (≤300 px wide) stored as a file under userData/thumbnails/
  // (see thumbnail.ts). Persisted; `thumbnailUrl` is derived from it on read.
  thumbnailFile?: string
  // Recording only: the video editor's filmstrip, a small WebP beside the
  // thumbnail (thumbnail.ts, src/lib/filmstrip.ts). Made by the recorder
  // since 2026-11-27; older rows get one in the background or when the
  // editor opens them. Always of the original file: a trim doesn't change it.
  stripFile?: string
  // When thumbnailFile / stripFile were last written (ms): the version in
  // their address, so reading a row needs no file access (row-stamps.ts,
  // 2026-11-27). Absent on rows from before that until the next write.
  thumbnailStamp?: number
  stripStamp?: number
  // Recording only, never persisted (set on the rows history:days hands the
  // window): it has no card preview / no filmstrip yet, and the window
  // should make one (src/lib/strip-jobs.ts).
  needsPreview?: boolean
  needsStrip?: boolean
  // Renderer-facing preview URL (`lumia-media://…` for thumbnailFile). Only
  // legacy rows still persist an inline data URL here — HistoryStore moves
  // those to files on startup.
  thumbnailUrl?: string
  // File size in bytes of the file the row stands for (edited / trimmed copy,
  // else the original), read by history:days / history:recent. Never
  // persisted: set only on the IPC response.
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
  // Computed at read time by history:days / history:recent. True when filePath is set but the
  // file is gone from disk. Never persisted — set only on the IPC response.
  fileMissing?: boolean
  // Vector annotations layered over the original. Re-editable: the Editor
  // replays each entry as its own commit on mount so native Undo steps back
  // through them one at a time.
  annotations?: AnnotationObject[]
  // Sidecar PNG with annotations flattened into pixels. Kept in sync on
  // every saveHistoryAnnotations call that carries a flattened dataUrl, so
  // surfaces outside the Editor (Dashboard Share/Copy, thumbnail) operate
  // on the annotated version without re-running Konva.
  // Recordings reuse this field for the trimmed copy (see video:trim), so
  // Share / Save-As / delete cleanup all pick it up with no extra wiring.
  annotatedFilePath?: string
  // Fingerprints of filePath / annotatedFilePath ("dev:ino:size"), so a
  // file renamed or moved outside Lumia is found again (file-relink.ts,
  // 2026-11-27). Saved the first time Lumia sees the file.
  fileKey?: string
  annotatedFileKey?: string
  // Recording only: the applied trim, always cut from `filePath` (the
  // untouched original). `actualStartMs` is where the lossless cut really
  // begins — the keyframe at or before `startMs`.
  trim?: { startMs: number; endMs: number; actualStartMs: number }
  // Recording only: length of the original file (`filePath`) in ms, read from
  // its Duration header. Set when the recording is saved; older rows get it
  // filled in the background the first time their day is read.
  durationMs?: number
  // Recording only: the frame rate it was recorded at (shared/recording.ts),
  // saved with the recording since 2026-11-27. The video editor steps one
  // frame of it; rows without it step at the current rate.
  fps?: number
  // Screenshot only: pixel size of the file the card stands for (the edited
  // copy when there is one, else the original), read from its PNG header by
  // history:days / history:recent. Never persisted — set only on the IPC
  // response, like fileMissing.
  width?: number
  height?: number
}
