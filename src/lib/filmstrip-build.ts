/* The filmstrip's drawing side (the numbers are filmstrip.ts): tiles and
   strips on canvases, and the one-off decode for a recording that has no
   strip yet. */
import {
  STRIP_TILE_W, STRIP_TILE_H, STRIP_MIME, STRIP_QUALITY,
  slotCount, tileForSlot, tileTimesMs, coverCrop, tilesInStrip, halvingSteps,
} from './filmstrip'

/** A strip ready to draw from: the saved picture or a freshly built canvas. */
export interface StripSprite {
  source: CanvasImageSource
  tiles: number
}

// The halving steps' canvases, kept between tiles (the recorder takes a
// tile every 100ms): one per step, resized only when the source changes.
const stepCanvases: HTMLCanvasElement[] = []

/** One tile: `source` (a video frame, the recorder's canvas) cover-cropped
 *  to the tile's 16:9 and brought down in steps of at most 2x
 *  (`halvingSteps` says why), plain bilinear at each. Every tile takes this
 *  one road, from the recorder and from the decode, so strips look alike.
 *  About 3ms from a 4K frame. */
export function drawTile(source: CanvasImageSource, srcW: number, srcH: number): HTMLCanvasElement {
  const tile = document.createElement('canvas')
  tile.width = STRIP_TILE_W
  tile.height = STRIP_TILE_H
  if (srcW <= 0 || srcH <= 0) return tile
  const crop = coverCrop(srcW, srcH, STRIP_TILE_W, STRIP_TILE_H)
  const steps = halvingSteps(crop.sw, crop.sh, STRIP_TILE_W, STRIP_TILE_H)
  let from: CanvasImageSource = source
  let sx = crop.sx, sy = crop.sy, sw = crop.sw, sh = crop.sh
  steps.forEach((step, i) => {
    const last = i === steps.length - 1
    let c = tile
    if (!last) {
      c = stepCanvases[i] ?? (stepCanvases[i] = document.createElement('canvas'))
      if (c.width !== step.w || c.height !== step.h) { c.width = step.w; c.height = step.h }
    }
    const ctx = c.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'low'
    ctx.drawImage(from, sx, sy, sw, sh, 0, 0, step.w, step.h)
    from = c
    sx = 0; sy = 0; sw = step.w; sh = step.h
  })
  return tile
}

/** Tiles side by side: the strip as it's saved. */
export function stripFromTiles(tiles: HTMLCanvasElement[]): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = STRIP_TILE_W * Math.max(1, tiles.length)
  c.height = STRIP_TILE_H
  const ctx = c.getContext('2d', { alpha: false })
  tiles.forEach((t, i) => ctx?.drawImage(t, i * STRIP_TILE_W, 0))
  return c
}

/** The strip as the data URL main saves ('' if it can't be encoded). */
export function encodeStrip(strip: HTMLCanvasElement): string {
  try {
    const url = strip.toDataURL(STRIP_MIME, STRIP_QUALITY)
    return url.startsWith(`data:${STRIP_MIME}`) ? url : ''
  } catch {
    return ''
  }
}

export interface BuildStripOptions {
  /** Stops the build at once (a wait in progress included): null comes back. */
  signal?: AbortSignal
  /** The recording's length if the caller knows it (the editor's player,
   *  the history row), for a file whose header has none. Read when needed. */
  durationMs?: number | (() => number | undefined)
}

/** Wait for `event` on the video: true when it fired; false on `failEvent`,
 *  after `ms`, or as soon as `signal` aborts. */
function waitFor(v: HTMLVideoElement, event: string, ms: number, signal?: AbortSignal, failEvent?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return }
    const done = (ok: boolean) => {
      clearTimeout(timer)
      v.removeEventListener(event, onOk)
      if (failEvent) v.removeEventListener(failEvent, onFail)
      signal?.removeEventListener('abort', onFail)
      resolve(ok)
    }
    const onOk = () => done(true)
    const onFail = () => done(false)
    const timer = setTimeout(onFail, ms)
    v.addEventListener(event, onOk)
    if (failEvent) v.addEventListener(failEvent, onFail)
    signal?.addEventListener('abort', onFail)
  })
}

/** The recording's length in ms, or 0. A MediaRecorder file whose remux
 *  failed has no length in its header (`duration` is Infinity): then what
 *  the caller knows, else a seek far past the end, which makes Chromium
 *  read the file's real length (the editor's player and the recorder's
 *  thumbnail do the same). */
async function lengthOf(v: HTMLVideoElement, opts: BuildStripOptions): Promise<number> {
  const finite = (ms: number | undefined): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0
  if (finite(v.duration * 1000)) return v.duration * 1000
  const known = typeof opts.durationMs === 'function' ? opts.durationMs() : opts.durationMs
  if (finite(known)) return known
  const seeked = waitFor(v, 'seeked', 5000, opts.signal)
  v.currentTime = 1e101
  await seeked
  return finite(v.duration * 1000) ? v.duration * 1000 : 0
}

/** Decode a recording's strip: one seek per tile on a throwaway <video>
 *  (the user's player is never touched), about 30ms a tile at 4K. For
 *  recordings made before the recorder sampled its own tiles, and after a
 *  restore from the cloud. Resolves null when the file can't be read or the
 *  build was aborted.
 *
 *  lumia-media sends CORS headers to the app's own pages, so with
 *  `crossOrigin` the canvas stays readable and the strip can be saved. */
export async function buildStripFromVideo(src: string, opts: BuildStripOptions = {}): Promise<HTMLCanvasElement | null> {
  const { signal } = opts
  if (signal?.aborted) return null
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  try {
    const loaded = waitFor(v, 'loadeddata', 10000, signal, 'error')
    v.src = src
    if (!(await loaded) || v.videoWidth <= 0) return null
    const durationMs = await lengthOf(v, opts)
    if (signal?.aborted || durationMs <= 0) return null
    const tiles: HTMLCanvasElement[] = []
    let drawn = 0
    for (const t of tileTimesMs(durationMs)) {
      const seeked = waitFor(v, 'seeked', 3000, signal)
      v.currentTime = t / 1000
      const ok = await seeked
      if (signal?.aborted) return null
      // A frame that never arrived repeats the one before it.
      if (ok) { tiles.push(drawTile(v, v.videoWidth, v.videoHeight)); drawn++ }
      else tiles.push(tiles[tiles.length - 1] ?? drawTile(v, 0, 0))
    }
    return drawn > 0 ? stripFromTiles(tiles) : null
  } catch (err) {
    console.warn('[filmstrip] could not build frames', err)
    return null
  } finally {
    v.removeAttribute('src')
    v.load() // release the media pipeline right away
  }
}

/** A saved strip, loaded and ready to draw. */
export function loadStrip(url: string): Promise<StripSprite> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ source: img, tiles: tilesInStrip(img.naturalWidth) })
    img.onerror = () => reject(new Error('strip load failed'))
    img.src = url
  })
}

/** Draw the strip into the trim bar's canvas, `widthPx` x `heightPx` CSS px:
 *  one slot per 16:9 tile of the track, each showing the stored tile of its
 *  time, cover-cropped (slots are a little narrower than 16:9). One paint. */
export function paintStrip(canvas: HTMLCanvasElement, strip: StripSprite, widthPx: number, heightPx: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const W = Math.round(widthPx * dpr)
  const H = Math.round(heightPx * dpr)
  if (W <= 0 || H <= 0) return
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const slots = slotCount(widthPx, heightPx, strip.tiles)
  for (let s = 0; s < slots; s++) {
    const x0 = Math.round((s * W) / slots)
    const x1 = Math.round(((s + 1) * W) / slots)
    const tile = tileForSlot(s, slots, strip.tiles)
    const { sx, sy, sw, sh } = coverCrop(STRIP_TILE_W, STRIP_TILE_H, x1 - x0, H)
    ctx.drawImage(strip.source, tile * STRIP_TILE_W + sx, sy, sw, sh, x0, 0, x1 - x0, H)
  }
}

/** The `lumia-media://` address of a local file (as useLocalVideoUrl makes it). */
export function mediaUrl(filePath: string): string {
  return `lumia-media://stream/?path=${encodeURIComponent(filePath)}`
}
