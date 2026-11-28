/** Width of history thumbnails. Main downsizes to the same width
 *  (THUMB_MAX_WIDTH in electron/thumbnail.ts): sharp on Retina for the
 *  largest Dashboard card, 4:3-cropped from a 16:9 capture. */
export const THUMBNAIL_WIDTH = 960

/**
 * One video frame as a JPEG data URL, at most `maxWidth` wide. `at` is a
 * time in ms, or a fraction of the duration (new recordings use 0.25).
 * Resolves undefined if the video can't be read within 5 s, or as soon as
 * `signal` aborts.
 */
export function grabVideoFrame(
  src: string,
  at: { ms: number } | { fraction: number },
  maxWidth = THUMBNAIL_WIDTH,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return }
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    // lumia-media sends CORS headers to the app's own pages; without this
    // the canvas is tainted and toDataURL throws.
    v.crossOrigin = 'anonymous'
    let done = false
    const finish = (out?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      v.removeAttribute('src')
      v.load() // drop the media pipeline right away
      resolve(out)
    }
    const onAbort = () => finish(undefined)
    const timer = setTimeout(() => finish(undefined), 5000)
    signal?.addEventListener('abort', onAbort)
    v.addEventListener('error', () => finish(undefined), { once: true })
    v.addEventListener('loadeddata', () => {
      const d = v.duration
      v.currentTime = 'fraction' in at
        ? (Number.isFinite(d) && d > 0 ? d * at.fraction : 0.05)
        : Math.max(0, at.ms / 1000 + 0.05)
    }, { once: true })
    v.addEventListener('seeked', () => {
      try {
        const k = Math.min(1, maxWidth / (v.videoWidth || maxWidth))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(v.videoWidth * k))
        c.height = Math.max(1, Math.round(v.videoHeight * k))
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
        finish(c.toDataURL('image/jpeg', 0.85))
      } catch {
        finish(undefined)
      }
    }, { once: true })
    v.src = src
  })
}
