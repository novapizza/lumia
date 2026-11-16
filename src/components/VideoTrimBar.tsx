import { useCallback, useRef } from 'react'

/** Format ms as m:ss.d (e.g. 0:03.2, 12:40.0). */
export function formatTrimTime(ms: number): string {
  const totalTenths = Math.max(0, Math.round(ms / 100))
  const tenths = totalTenths % 10
  const totalSec = Math.floor(totalTenths / 10)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`
}

/** Shortest selection the bar lets you make — matches MIN_TRIM_MS in main. */
export const MIN_TRIM_SELECTION_MS = 500

interface Props {
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
  durationMs, currentMs, startMs, endMs, onChange, onSeek,
  dirty, hasAppliedTrim, snappedMs, busy, disabled, onApply, onReset,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragTarget | null>(null)
  const pct = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0)

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
        className={`relative h-9 rounded-lg bg-white/[0.04] border border-white/10 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
        onPointerDown={onPointerDown('seek')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Dimmed regions outside the selection */}
        <div className="absolute inset-y-0 left-0 bg-black/50 rounded-l-lg pointer-events-none" style={{ width: `${pct(startMs)}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/50 rounded-r-lg pointer-events-none" style={{ width: `${100 - pct(endMs)}%` }} />
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
        {hasAppliedTrim && !dirty && snappedMs >= 250 && (
          <span className="text-amber-300/90" title="A lossless cut can only start on a keyframe">
            Clip starts {(snappedMs / 1000).toFixed(1)}s earlier (nearest keyframe)
          </span>
        )}
        <span className="text-slate-600 hidden md:inline">I / O set start / end at playhead · Space play</span>
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
