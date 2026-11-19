import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Format ms as m:ss.cc. Every time in the bar uses it: hundredths so a
 *  single-frame step (≈17 ms at 60 fps) visibly changes the readout. */
export function formatPlayheadTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10))
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Format a length as seconds (17.53s), or 2m 05.30s past a minute, so it
 *  never reads like one of the timestamps around it. */
export function formatDuration(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10))
  const m = Math.floor(totalCs / 6000)
  const sec = (totalCs % 6000) / 100
  return m > 0 ? `${m}m ${sec.toFixed(2).padStart(5, '0')}s` : `${sec.toFixed(2)}s`
}

/** Track height in CSS px — the filmstrip is drawn at this height (tall
 *  enough for the frames to be readable). Tile width follows from it. */
const TRACK_HEIGHT_PX = 70
/** Landing bracket: 12px wide, 2px taller than the track at each end. */
const BRACKET_W = 12
const BRACKET_H = TRACK_HEIGHT_PX + 4
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

/** Shown in the middle of the bottom row. */
const INLINE_SHORTCUTS: readonly (readonly [keys: readonly string[], label: string])[] = [
  [['D'], 'Start'],
  [['F'], 'End'],
  [['←', '→'], 'Frame'],
  [['Shift', '←', '→'], '10 Frames'],
  [['Space'], 'Play'],
]

/** Shortest selection the bar lets you make — matches MIN_TRIM_MS in main. */
export const MIN_TRIM_SELECTION_MS = 500

interface TrackProps {
  /** Playable URL of the ORIGINAL recording — the filmstrip source. */
  videoSrc?: string
  durationMs: number
  currentMs: number
  startMs: number
  endMs: number
  onChange: (startMs: number, endMs: number) => void
  onSeek: (ms: number) => void
  disabled: boolean
}

interface ActionsProps {
  currentMs: number
  startMs: number
  endMs: number
  durationMs: number
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

/** The filmstrip, two handles for the trim range, a playhead, and the area
 *  outside the selection dimmed. */
function TrimTrack({
  videoSrc, durationMs, currentMs, startMs, endMs, onChange, onSeek, disabled,
}: TrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragTarget | null>(null)
  /** Where in the handle it was grabbed (ms from the handle's edge), so the
   *  handle doesn't jump to put its edge under the cursor. */
  const grabOffsetRef = useRef(0)
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

  // Not clamped to the track: the handles sit just outside it at the ends,
  // and applyDrag clamps every target anyway.
  const msAt = useCallback((clientX: number) => {
    const el = trackRef.current
    if (!el || durationMs <= 0) return 0
    const r = el.getBoundingClientRect()
    return Math.round(((clientX - r.left) / r.width) * durationMs)
  }, [durationMs])

  // The playhead never leaves the selection. A handle leaves it where it is
  // and only pushes it along when it runs into it; dragging the handle back
  // leaves the playhead where the push stopped.
  const applyDrag = useCallback((target: DragTarget, ms: number) => {
    if (target === 'start') {
      const s = Math.max(0, Math.min(ms, endMs - MIN_TRIM_SELECTION_MS))
      onChange(s, endMs)
      if (currentMs < s) onSeek(s)
    } else if (target === 'end') {
      const e = Math.min(durationMs, Math.max(ms, startMs + MIN_TRIM_SELECTION_MS))
      onChange(startMs, e)
      if (currentMs > e) onSeek(e)
    } else {
      onSeek(Math.min(endMs, Math.max(startMs, ms)))
    }
  }, [startMs, endMs, durationMs, currentMs, onChange, onSeek])

  const onPointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return // right-click opens the menu instead
    e.stopPropagation()
    e.preventDefault()
    const ms = msAt(e.clientX)
    grabOffsetRef.current = target === 'start' ? ms - startMs : target === 'end' ? ms - endMs : 0
    // A press outside the selection grabs the nearest handle and moves it
    // there, so the drag that follows keeps moving that handle.
    if (target === 'seek') {
      if (ms < startMs) target = 'start'
      else if (ms > endMs) target = 'end'
    }
    dragRef.current = target
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    applyDrag(target, ms - grabOffsetRef.current)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    // The button is up but no pointerup reached us: Electron drops it when
    // the release happens over a window drag region (title bar) or outside
    // the window. End the drag instead of following a cursor that let go.
    if ((e.buttons & 1) === 0) { dragRef.current = null; return }
    applyDrag(dragRef.current, msAt(e.clientX) - grabOffsetRef.current)
  }
  const onPointerUp = () => { dragRef.current = null }
  // Also end it if the capture is lost or the window loses focus mid-drag.
  useEffect(() => {
    const end = () => { dragRef.current = null }
    window.addEventListener('blur', end)
    return () => window.removeEventListener('blur', end)
  }, [])

  // Hovering outside the selection previews where a click would put the
  // nearest handle. Hidden over the handles themselves and while dragging.
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const onTrackPointerMove = (e: React.PointerEvent) => {
    onPointerMove(e)
    const overHandle = (e.target as HTMLElement).closest?.('[role="slider"]')
    setHoverMs(disabled || dragRef.current || overHandle ? null : msAt(e.clientX))
  }

  // Right-click menu: "Start here" / "End here" at the clicked spot.
  const [menu, setMenu] = useState<{ x: number; y: number; ms: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (disabled || durationMs <= 0) return
    const ms = Math.min(durationMs, Math.max(0, msAt(e.clientX)))
    setMenu({ x: e.clientX, y: e.clientY, ms })
  }
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  // Opens up from the cursor; nudged left if it would run off the right edge.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const overflow = el.getBoundingClientRect().right - (window.innerWidth - 8)
    if (overflow > 0) el.style.left = `${menu.x - overflow}px`
  }, [menu])
  const canStartAt = (ms: number) => ms <= endMs - MIN_TRIM_SELECTION_MS
  const canEndAt = (ms: number) => ms >= startMs + MIN_TRIM_SELECTION_MS
  const pickFromMenu = (target: 'start' | 'end') => {
    if (menu) applyDrag(target, menu.ms)
    setMenu(null)
  }
  // Hidden while the menu is open.
  const landing = hoverMs === null || menu ? null
    : hoverMs < startMs ? { ms: Math.max(0, hoverMs), side: 'start' as const }
    : hoverMs > endMs ? { ms: Math.min(durationMs, hoverMs), side: 'end' as const }
    : null

  return (
    // 16px side margin: room for the handles, which stick out 12px past the
    // strip's ends. 12px above it and 6px below: the frame bars overhang it
    // by 6px, so they keep 6px clear of the edge and of the row below.
    <div className="relative px-4 pt-3 pb-1.5">
      <div
        ref={trackRef}
        className={`relative bg-white/[0.04] ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
        style={{ height: TRACK_HEIGHT_PX }}
        onPointerDown={onPointerDown('seek')}
        onPointerMove={onTrackPointerMove}
        onPointerLeave={() => setHoverMs(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onContextMenu={onContextMenu}
      >
        {/* Filmstrip — evenly spaced frames of the original recording */}
        <canvas
          ref={filmstripRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          aria-hidden="true"
        />
        {/* Dimmed regions outside the selection */}
        <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none" style={{ width: `${pct(startMs)}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none" style={{ width: `${100 - pct(endMs)}%` }} />
        {/* Selection frame */}
        <div
          className="absolute -top-1.5 -bottom-1.5 border-y-[6px] border-tertiary pointer-events-none"
          style={{ left: `${pct(startMs)}%`, width: `${pct(endMs) - pct(startMs)}%` }}
        />
        {/* Where a click would land the nearest handle, drawn as a bracket
             opening toward what stays: "[" for start, "]" for end (mirrored).
             Its 2px arms sit right against the filmstrip's top and bottom
             edges, its vertical stroke sits where the handle's inner edge
             will, and the arm tips are round. Corner radius = its 2px
             overhang, so the curve never reaches into the strip (same rule
             as the handles: 6px radius, 6px overhang). SVG because CSS
             borders can't round the open ends. */}
        {landing && (
          <svg
            className={`absolute -top-0.5 text-tertiary pointer-events-none ${landing.side === 'end' ? '-scale-x-100' : ''}`}
            width={BRACKET_W}
            height={BRACKET_H}
            viewBox={`0 0 ${BRACKET_W} ${BRACKET_H}`}
            style={{ left: `calc(${pct(landing.ms)}% - ${landing.side === 'start' ? 2 : BRACKET_W - 2}px)` }}
            aria-hidden="true"
          >
            {/* Centerline of a 2px stroke: 1px in from each edge, 1px corner
                arcs (2px outside radius), round caps reaching the full width */}
            <path
              d={`M ${BRACKET_W - 1} 1 H 2 A 1 1 0 0 0 1 2 V ${BRACKET_H - 2} A 1 1 0 0 0 2 ${BRACKET_H - 1} H ${BRACKET_W - 1}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
          </svg>
        )}
        {/* Handles */}
        {(['start', 'end'] as const).map(h => (
          <div
            key={h}
            role="slider"
            aria-label={h === 'start' ? 'Trim start' : 'Trim end'}
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={h === 'start' ? startMs : endMs}
            className={`absolute -top-1.5 -bottom-1.5 w-3 bg-tertiary flex items-center justify-center ${
              h === 'start' ? 'rounded-l-md -translate-x-full' : 'rounded-r-md'
            } ${disabled ? '' : 'cursor-ew-resize'}`}
            style={{ left: `${pct(h === 'start' ? startMs : endMs)}%` }}
            onPointerDown={onPointerDown(h)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onPointerUp}
          >
            <div className="w-0.5 h-3 rounded bg-slate-900/60" />
          </div>
        ))}
        {/* Playhead */}
        <div
          className="absolute inset-y-0 w-0.5 bg-white shadow pointer-events-none"
          style={{ left: `${pct(currentMs)}%` }}
        />
      </div>

      {/* Right-click menu. Portaled to <body> so no ancestor with a
           transform or backdrop-filter becomes its containing block. */}
      {menu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[100] glass-refractive rounded-xl p-1 min-w-[150px] text-[12px]"
          style={{ left: menu.x, top: menu.y, transform: 'translateY(-100%)' }}
          onContextMenu={e => e.preventDefault()}
        >
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-slate-500 tabular-nums">{formatPlayheadTime(menu.ms)}</div>
          {([['start', 'Start here', canStartAt], ['end', 'End here', canEndAt]] as const).map(([target, label, can]) => (
            <button
              key={target}
              type="button"
              role="menuitem"
              disabled={!can(menu.ms)}
              onClick={() => pickFromMenu(target)}
              className="w-full h-7 px-2.5 rounded-lg text-left font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** The row under the track: the trim readout, the shortcuts and the
 *  Apply / Reset buttons. */
function TrimActions({
  currentMs, startMs, endMs, durationMs, dirty, hasAppliedTrim, snappedMs, busy, disabled, onApply, onReset,
}: ActionsProps) {
  const lengthMs = endMs - startMs
  const isFullRange = startMs <= 0 && endMs >= durationMs
  // Same height, padding and spacing as the editor's top toolbar (h-10,
  // px-3, gap-2, h-7 buttons). Three columns so the shortcuts sit in the
  // true center; the side columns grow (pushing it off-center) rather than
  // overlap when space runs out.
  return (
    <div className="h-10 px-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px]">
      {/* A small copy of the bar, in timeline order: start and end on the
           handle color, the playhead on white in the middle, then the
           length as a duration. Same 28px height as the buttons and the
           handles' 6px corners; the white is square like the filmstrip. */}
      <div className="flex items-center gap-3 min-w-0 tabular-nums whitespace-nowrap">
        {/* text-[#fff], not text-white: light mode remaps .text-white to dark grey */}
        <span className="h-7 p-[3px] rounded-md bg-tertiary flex items-center font-semibold text-[#fff]">
          <span className="px-2">{formatPlayheadTime(startMs)}</span>
          <span className="h-full px-2 bg-white text-[#2d2f33] flex items-center">{formatPlayheadTime(currentMs)}</span>
          <span className="px-2">{formatPlayheadTime(endMs)}</span>
        </span>
        <span className="text-slate-400 font-semibold">{formatDuration(lengthMs)}</span>
        {hasAppliedTrim && !dirty && snappedMs >= 250 && (
          <span className="flex items-center gap-1 text-amber-300/90" title="A lossless cut can only start on a keyframe">
            <span className="material-symbols-outlined text-[14px]">info</span>
            Cut starts {(snappedMs / 1000).toFixed(1)}s earlier (keyframe)
          </span>
        )}
      </div>
      {/* Shortcuts, centered in the row */}
      <div className="flex items-center justify-center gap-3 text-slate-500">
        {INLINE_SHORTCUTS.map(([keys, label]) => (
          <span key={label} className="flex items-center gap-1">
            {keys.map(k => (
              <kbd key={k} className="px-1 h-[18px] leading-[18px] rounded bg-white/[0.06] text-slate-400 font-semibold text-[10px]" style={{ fontFamily: 'inherit' }}>{k}</kbd>
            ))}
            <span className="ml-0.5">{label}</span>
          </span>
        ))}
      </div>
      <div className="col-start-3 flex items-center justify-end gap-2">
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

/** Trim bar at the bottom of the video editor: the track over the readout
 *  row, in one panel. Purely presentational: the Editor owns the numbers
 *  and talks to main. */
export default function VideoTrimBar(props: TrackProps & ActionsProps) {
  return (
    <div className="flex-shrink-0 liquid-glass border-t border-white/5 select-none" style={{ fontFamily: 'Manrope, sans-serif' }}>
      <TrimTrack {...props} />
      <TrimActions {...props} />
    </div>
  )
}
