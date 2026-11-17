import { useCallback, useEffect, useRef, useState } from 'react'

/** Format ms as m:ss.d (e.g. 0:03.2, 12:40.0). */
export function formatTrimTime(ms: number): string {
  const totalTenths = Math.max(0, Math.round(ms / 100))
  const tenths = totalTenths % 10
  const totalSec = Math.floor(totalTenths / 10)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`
}

/** Format ms as m:ss.cc — the playhead readout needs hundredths so a
 *  single-frame step (≈17 ms at 60 fps) visibly changes it. */
export function formatPlayheadTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10))
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Track height in CSS px — the filmstrip is drawn at this height (tall
 *  enough for the frames to be readable). Tile width follows from it. */
const TRACK_HEIGHT_PX = 70
/** Upper bound on filmstrip tiles, whatever the window width. */
const MAX_FILMSTRIP_FRAMES = 40

/** Paint evenly spaced frames of `src` side by side into `canvasRef` (one
 *  ~16:9 tile per slot, cover-cropped), sized to the track's `widthPx`.
 *
 *  Drawn straight onto a canvas rather than turned into <img> data URLs on
 *  purpose: lumia-media:// is cross-origin to the renderer, so a canvas that
 *  receives a video frame is tainted and toDataURL() throws. A tainted canvas
 *  can still be DISPLAYED — it just can't be read back — which is all a
 *  filmstrip needs, and it avoids opening the protocol to CORS reads.
 *
 *  Uses its own throwaway <video> (one seek per tile) so the user's player is
 *  never disturbed, and drops the decoder when done. Tiles are painted into
 *  an offscreen canvas and copied over: progressively on the first build, in
 *  one go on a rebuild after a resize so the old strip stays up meanwhile. */
function useFilmstrip(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  src: string | undefined,
  durationMs: number,
  widthPx: number,
) {
  const paintedRef = useRef(false)
  useEffect(() => {
    paintedRef.current = false
    const c = canvasRef.current
    if (c) { c.width = 0; c.height = 0 }
  }, [src, canvasRef])
  useEffect(() => {
    const visible = canvasRef.current
    if (!visible || !src || durationMs <= 0 || widthPx <= 0) return
    let cancelled = false
    const progressive = !paintedRef.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.round(widthPx * dpr)
    const H = Math.round(TRACK_HEIGHT_PX * dpr)
    const count = Math.min(MAX_FILMSTRIP_FRAMES, Math.max(1, Math.ceil(widthPx / (TRACK_HEIGHT_PX * 16 / 9))))
    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const ctx = off.getContext('2d')
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'

    const present = () => {
      if (visible.width !== W || visible.height !== H) { visible.width = W; visible.height = H }
      visible.getContext('2d')?.drawImage(off, 0, 0)
    }
    const seekTo = (sec: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); resolve(false) }, 3000)
      const onSeeked = () => { clearTimeout(timer); resolve(true) }
      v.addEventListener('seeked', onSeeked, { once: true })
      v.currentTime = sec
    })

    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        v.addEventListener('loadeddata', () => resolve(), { once: true })
        v.addEventListener('error', () => reject(new Error(v.error?.message || 'load failed')), { once: true })
        v.src = src
      })
      if (!ctx || cancelled) return
      const vw = v.videoWidth || 16
      const vh = v.videoHeight || 9
      for (let i = 0; i < count && !cancelled; i++) {
        // Sample the middle of each slot so the first/last tiles aren't
        // pinned to the very start/end (often a blank or the stop click).
        const ok = await seekTo(((i + 0.5) / count) * durationMs / 1000)
        if (cancelled) return
        if (!ok) continue
        const x0 = Math.round((i * W) / count)
        const x1 = Math.round(((i + 1) * W) / count)
        const tw = x1 - x0
        // Cover-crop the frame into the tile.
        const k = Math.max(tw / vw, H / vh)
        const sw = tw / k
        const sh = H / k
        ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x0, 0, tw, H)
        if (i > 0) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x0, 0, Math.max(1, Math.round(dpr)), H) }
        if (progressive) present()
      }
      if (!cancelled) { present(); paintedRef.current = true }
    }
    run().catch((err) => { console.warn('[filmstrip] could not build frames', err) }).finally(() => {
      v.removeAttribute('src')
      v.load() // release the media pipeline right away
    })
    return () => { cancelled = true }
  }, [canvasRef, src, durationMs, widthPx])
}

/** Shortest selection the bar lets you make — matches MIN_TRIM_MS in main. */
export const MIN_TRIM_SELECTION_MS = 500

interface Props {
  /** Playable URL of the ORIGINAL recording — the filmstrip source. */
  videoSrc?: string
  durationMs: number
  currentMs: number
  startMs: number
  endMs: number
  onChange: (startMs: number, endMs: number) => void
  onSeek: (ms: number) => void
  /** Selection differs from what's applied — Apply is meaningful. */
  dirty: boolean
  /** A trim is currently applied to the recording. */
  hasAppliedTrim: boolean
  /** How far the applied cut starts before the picked start (keyframe snap). */
  snappedMs: number
  busy: boolean
  disabled: boolean
  onApply: () => void
  onReset: () => void
}

type DragTarget = 'start' | 'end' | 'seek'

/** Timeline under the video player: two handles for the trim range, a
 *  playhead, and the area outside the selection dimmed. Purely presentational
 *  — the Editor owns the numbers and talks to main. */
export default function VideoTrimBar({
  videoSrc, durationMs, currentMs, startMs, endMs, onChange, onSeek,
  dirty, hasAppliedTrim, snappedMs, busy, disabled, onApply, onReset,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragTarget | null>(null)
  const pct = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0)

  // The filmstrip is rebuilt when the track width settles after a resize.
  const filmstripRef = useRef<HTMLCanvasElement | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => setTrackWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(measure, 250) })
    ro.observe(el)
    return () => { clearTimeout(timer); ro.disconnect() }
  }, [])
  useFilmstrip(filmstripRef, videoSrc, durationMs, trackWidth)

  const msAt = useCallback((clientX: number) => {
    const el = trackRef.current
    if (!el || durationMs <= 0) return 0
    const r = el.getBoundingClientRect()
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.round(k * durationMs)
  }, [durationMs])

  const applyDrag = useCallback((target: DragTarget, ms: number) => {
    if (target === 'start') {
      const s = Math.min(ms, endMs - MIN_TRIM_SELECTION_MS)
      onChange(Math.max(0, s), endMs)
      onSeek(Math.max(0, s))
    } else if (target === 'end') {
      const e = Math.max(ms, startMs + MIN_TRIM_SELECTION_MS)
      onChange(startMs, Math.min(durationMs, e))
      onSeek(Math.min(durationMs, e))
    } else {
      onSeek(ms)
    }
  }, [startMs, endMs, durationMs, onChange, onSeek])

  const onPointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    if (disabled) return
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = target
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    applyDrag(target, msAt(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    applyDrag(dragRef.current, msAt(e.clientX))
  }
  const onPointerUp = () => { dragRef.current = null }

  const lengthMs = endMs - startMs
  const isFullRange = startMs <= 0 && endMs >= durationMs

  return (
    <div className="flex-shrink-0 liquid-glass border-t border-white/5 px-4 py-3 select-none" style={{ fontFamily: 'Manrope, sans-serif' }}>
      {/* Track */}
      <div
        ref={trackRef}
        className={`relative rounded-lg bg-white/[0.04] border border-white/10 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
        style={{ height: TRACK_HEIGHT_PX }}
        onPointerDown={onPointerDown('seek')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Filmstrip — evenly spaced frames of the original recording */}
        <canvas
          ref={filmstripRef}
          className="absolute inset-0 w-full h-full rounded-lg pointer-events-none"
          aria-hidden="true"
        />
        {/* Dimmed regions outside the selection */}
        <div className="absolute inset-y-0 left-0 bg-black/65 rounded-l-lg pointer-events-none" style={{ width: `${pct(startMs)}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/65 rounded-r-lg pointer-events-none" style={{ width: `${100 - pct(endMs)}%` }} />
        {/* Selection frame */}
        <div
          className="absolute inset-y-0 border-y-2 border-tertiary pointer-events-none"
          style={{ left: `${pct(startMs)}%`, width: `${pct(endMs) - pct(startMs)}%` }}
        />
        {/* Handles */}
        {(['start', 'end'] as const).map(h => (
          <div
            key={h}
            role="slider"
            aria-label={h === 'start' ? 'Trim start' : 'Trim end'}
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={h === 'start' ? startMs : endMs}
            className={`absolute -top-0.5 -bottom-0.5 w-3 bg-tertiary flex items-center justify-center ${
              h === 'start' ? 'rounded-l-md -translate-x-full' : 'rounded-r-md'
            } ${disabled ? '' : 'cursor-ew-resize'}`}
            style={{ left: `${pct(h === 'start' ? startMs : endMs)}%` }}
            onPointerDown={onPointerDown(h)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="w-0.5 h-3 rounded bg-slate-900/60" />
          </div>
        ))}
        {/* Playhead */}
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-white shadow pointer-events-none"
          style={{ left: `${pct(currentMs)}%` }}
        />
      </div>

      {/* Readout + actions */}
      <div className="mt-2 flex items-center gap-3 text-[11px]">
        <span className="text-slate-300 font-semibold tabular-nums">
          {formatTrimTime(startMs)} – {formatTrimTime(endMs)}
          <span className="text-slate-500 font-normal"> · {(lengthMs / 1000).toFixed(1)}s</span>
        </span>
        <span className="text-slate-400 tabular-nums" title="Playhead">
          <span className="material-symbols-outlined text-[13px] align-[-2px] mr-0.5">play_arrow</span>
          {formatPlayheadTime(currentMs)}
        </span>
        {hasAppliedTrim && !dirty && snappedMs >= 250 && (
          <span className="text-amber-300/90" title="A lossless cut can only start on a keyframe">
            Clip starts {(snappedMs / 1000).toFixed(1)}s earlier (nearest keyframe)
          </span>
        )}
        <span className="text-slate-600 hidden md:inline">I / O set start / end · ←/→ frame (Shift ×10) · Space play</span>
        <div className="flex-1" />
        {(hasAppliedTrim || dirty) && (
          <button
            onClick={onReset}
            disabled={disabled || busy}
            className="h-7 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white font-semibold disabled:opacity-40 flex items-center gap-1.5"
            title={hasAppliedTrim ? 'Remove the trim and use the full recording' : 'Discard selection changes'}
          >
            <span className="material-symbols-outlined text-[14px]">undo</span>
            Reset
          </button>
        )}
        <button
          onClick={onApply}
          disabled={disabled || busy || !dirty || (isFullRange && !hasAppliedTrim)}
          className="h-7 px-2.5 rounded-lg primary-gradient text-slate-900 font-bold hover:brightness-110 disabled:opacity-40 flex items-center gap-1.5"
          title="Cut the recording to the selection (the original is kept)"
        >
          {busy
            ? <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
            : <span className="material-symbols-outlined text-[14px]">cut</span>}
          {busy ? 'Trimming…' : 'Apply trim'}
        </button>
      </div>
    </div>
  )
}
