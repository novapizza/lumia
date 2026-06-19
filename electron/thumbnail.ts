import { nativeImage } from 'electron'

// Shrink a data-URL image to a lightweight thumbnail for history.json.
// Full-resolution base64 bloats the store quickly; we keep only a small JPEG
// for UI display and rely on `filePath` for any non-display usage.
// Returns `undefined` on failure rather than the original data URL: returning
// the original would store a multi-MB full-resolution image inline in
// history.json. `HistoryItem.thumbnailUrl` is optional, so callers already
// tolerate a missing thumbnail (the UI just renders no preview for that row).
export function makeThumbnail(dataUrl: string, maxWidth = 300, quality = 60): string | undefined {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return undefined
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return undefined
    const { width } = img.getSize()
    const resized = width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img
    const buf = resized.toJPEG(quality)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}
