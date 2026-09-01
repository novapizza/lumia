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

export interface HistoryItem {
  id: string
  timestamp: number
  name: string
  filePath?: string
  dataUrl?: string
  // Preview JPEG (≤300 px wide) stored as a file under userData/thumbnails/
  // (see thumbnail.ts). Persisted; `thumbnailUrl` is derived from it on read.
  thumbnailFile?: string
  // Renderer-facing preview URL (`lumia-media://…` for thumbnailFile). Only
  // legacy rows still persist an inline data URL here — HistoryStore moves
  // those to files on startup.
  thumbnailUrl?: string
  size?: number
  type: 'screenshot' | 'recording'
  uploads: UploadResult[]
  // Computed at read time by history:get. True when filePath is set but the
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
  annotatedFilePath?: string
}
