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

export interface HistoryItem {
  id: string
  timestamp: number
  name: string
  filePath?: string
  dataUrl?: string
  thumbnailUrl?: string
  size?: number
  type: 'screenshot' | 'recording'
  uploads: UploadResult[]
  // Set by main on history:get when filePath is missing from disk. Never
  // persisted — the store keeps items even when files are gone so the user
  // can clean them up explicitly.
  fileMissing?: boolean
  // Vector annotations layered over the original. Re-editable: the Editor
  // replays each entry as its own commit on mount so native Undo steps back
  // through them one at a time.
  annotations?: AnnotationObject[]
  // Pixel-flat counterpart of `annotations`, written by the Editor on every
  // committing action (Copy/Share/upload — not Save).
  annotatedFilePath?: string
}

// ── OCR & Auto-Blur ──────────────────────────────────────────────

export type SensitiveCategory =
  | 'email'
  | 'phone'
  | 'credit-card'
  | 'ssn'
  | 'api-key'
  | 'jwt'
  | 'private-key'
  | 'password'
  | 'bearer-token'
  | 'ip-address'
  | 'url-credentials'

export interface SensitiveRegion {
  id: string
  category: SensitiveCategory
  text: string
  bbox: { x: number; y: number; width: number; height: number }
}

export interface AutoBlurResult {
  regions: SensitiveRegion[]
  ocrTimeMs: number
  detectTimeMs: number
}

export interface UnsplashPhoto {
  id: string
  description: string | null
  width: number
  height: number
  color: string | null
  blurHash: string | null
  urls: {
    raw: string
    full: string
    regular: string
    small: string
    thumb: string
  }
  links: {
    html: string
    downloadLocation: string
  }
  user: {
    name: string
    username: string
    link: string
  }
}
