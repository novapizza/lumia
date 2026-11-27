/* The video editor's filmstrip, as numbers (no DOM here: unit-tested).

   A recording's strip is one small picture, kept beside its thumbnail:
   STRIP_TILES frames side by side, each STRIP_TILE_W x STRIP_TILE_H, tile i
   showing the recording at the middle of its i-th stretch. The recorder makes
   it while it records (TileSampler), older recordings get theirs decoded
   once (filmstrip-build.ts). The trim bar draws its slots from it in one
   paint, whatever the window's width. */

/** Frames kept per recording. The trim bar shows one slot per 16:9 tile of
 *  its track: 11 in the default window, 17 in a 1920px one. 20 covers
 *  windows up to 2280px with a frame of its own per slot; wider ones get
 *  wider slots. */
export const STRIP_TILES = 20
/** A tile: the 60px track's 16:9 tile (106.67 x 60) at 2x, nothing bigger. */
export const STRIP_TILE_W = 214
export const STRIP_TILE_H = 120
/** WebP at 0.2 (Jasper, 2026-11-27, picked by eye between 0.6 / 0.4 / 0.2
 *  on the real strip: "at this size, 0.2 is fine"): about 15 KB per
 *  recording, 0.74 MB for 44 (0.6 would be 1.27 MB). JPEG needs about twice
 *  the bytes for the same look. */
export const STRIP_MIME = 'image/webp'
export const STRIP_QUALITY = 0.2

/** How many slots a track `widthPx` wide shows: one per 16:9 tile of its
 *  height, at least one, never more than the strip holds. */
export function slotCount(widthPx: number, trackHeightPx: number, tiles = STRIP_TILES): number {
  const fit = Math.ceil(widthPx / (trackHeightPx * 16 / 9))
  return Math.min(Math.max(1, tiles), Math.max(1, fit))
}

/** The stored tile a slot shows: the one whose stretch of the recording
 *  holds the slot's middle. */
export function tileForSlot(slot: number, slots: number, tiles: number): number {
  const mid = (slot + 0.5) / Math.max(1, slots)
  return Math.min(Math.max(0, tiles - 1), Math.max(0, Math.floor(mid * tiles)))
}

/** The time each tile shows: the middle of its stretch, so the first and
 *  last aren't pinned to the very start / end (often a blank, or the click
 *  on Stop). */
export function tileTimesMs(durationMs: number, tiles = STRIP_TILES): number[] {
  return Array.from({ length: tiles }, (_, i) => ((i + 0.5) / tiles) * Math.max(0, durationMs))
}

/** The part of a `srcW` x `srcH` picture that fills `dstW` x `dstH`, cut
 *  evenly from the side that's too long. */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): { sx: number; sy: number; sw: number; sh: number } {
  const k = Math.max(dstW / srcW, dstH / srcH)
  const sw = Math.min(srcW, dstW / k)
  const sh = Math.min(srcH, dstH / k)
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh }
}

/** The sizes a `srcW` x `srcH` picture passes through on its way down to
 *  `dstW` x `dstH`: halved until less than 2x is left, then the last bit.
 *
 *  Why not one draw: asked to shrink a 4K frame 18x at once, Chromium gives
 *  one of two results depending on how it holds that frame (2026-11-27,
 *  measured: a frame held as a texture is point-sampled, thin white text
 *  comes out crisp and bright, and the smoothing quality is ignored; one
 *  held as a bitmap is averaged, the same text grey), so tiles of a still
 *  screen differed from one to the next. At 2x or less both give the same
 *  plain average. */
export function halvingSteps(srcW: number, srcH: number, dstW: number, dstH: number): { w: number; h: number }[] {
  const steps: { w: number; h: number }[] = []
  let w = srcW
  let h = srcH
  while (w / 2 >= dstW && h / 2 >= dstH) {
    w = Math.ceil(w / 2)
    h = Math.ceil(h / 2)
    steps.push({ w, h })
  }
  steps.push({ w: dstW, h: dstH })
  return steps
}

/** How many tiles a saved strip holds, from its width. */
export function tilesInStrip(widthPx: number): number {
  return Math.max(1, Math.round(widthPx / STRIP_TILE_W))
}

/** A recording's own time: it runs while the recorder runs and stops in a
 *  pause, like the file's timeline. `now` is any clock in ms (Date.now()).
 *  The recorder's length, its toolbar timer and the times of the filmstrip
 *  tiles all read it, so they can't drift apart. */
export class RecordedClock {
  private accumulated = 0
  private runStart: number | null = null

  get running(): boolean { return this.runStart !== null }

  /** A new recording begins. */
  start(now: number): void {
    this.accumulated = 0
    this.runStart = now
  }

  /** Paused, or stopped: what ran so far is kept. */
  pause(now: number): void {
    if (this.runStart === null) return
    this.accumulated += now - this.runStart
    this.runStart = null
  }

  resume(now: number): void {
    if (this.runStart === null) this.runStart = now
  }

  /** Recorded ms at `now`. */
  at(now: number): number {
    return this.accumulated + (this.runStart === null ? 0 : now - this.runStart)
  }
}

/** Collects tiles while a recording runs, so its strip exists when it stops.
 *
 *  Times are recorded time (the file's timeline: a pause stops the clock).
 *  A tile is taken every 100ms at first; whenever twice the strip's count is
 *  held, every other one is dropped and the spacing doubles, so the memory
 *  stays the same for a 5 second recording and a 2 hour one. `T` is the
 *  tile (a small canvas in the recorder, anything in tests). */
export class TileSampler<T> {
  private samples: { ms: number; tile: T }[] = []
  private intervalMs: number
  private nextDueMs = 0
  private readonly max: number

  constructor(tiles = STRIP_TILES, firstIntervalMs = 100) {
    this.max = Math.max(2, tiles * 2)
    this.intervalMs = firstIntervalMs
  }

  get size(): number { return this.samples.length }

  /** Whether the frame at `ms` should be kept. */
  due(ms: number): boolean { return ms >= this.nextDueMs }

  add(ms: number, tile: T): void {
    this.samples.push({ ms, tile })
    this.nextDueMs = ms + this.intervalMs
    if (this.samples.length < this.max) return
    this.samples = this.samples.filter((_, i) => i % 2 === 0)
    this.intervalMs *= 2
    this.nextDueMs = this.samples[this.samples.length - 1].ms + this.intervalMs
  }

  /** The strip's tiles for a recording `durationMs` long: for each tile's
   *  time the last frame taken at or before it (what the file shows then;
   *  a still screen delivers no new frames), else the first one. */
  pick(durationMs: number, tiles = STRIP_TILES): T[] {
    if (this.samples.length === 0) return []
    let i = 0
    return tileTimesMs(durationMs, tiles).map((t) => {
      while (i + 1 < this.samples.length && this.samples[i + 1].ms <= t) i++
      return this.samples[i].tile
    })
  }
}
