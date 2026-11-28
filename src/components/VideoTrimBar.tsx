import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Icon } from './Icon'
import { ICON_BUTTON, ACCENT_ICON_BUTTON } from './button-classes'
import { paintStrip, type StripSprite } from '../lib/filmstrip-build'
/** Format ms as m:ss.cc. Every time in the bar uses it: hundredths so a
 *  single-frame step (≈33 ms at the recorder's 30 fps) visibly changes the readout. */
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
 *  enough for the frames to be readable). Tile width follows from it.
 *  60 (2026-11-23, was 70): with the 6px overhang above and below, the
 *  frame is as tall as the 72px button stacks either side. */
const TRACK_HEIGHT_PX = 60
/** Landing bracket: 12px wide, 2px taller than the track at each end. */
const BRACKET_W = 12
const BRACKET_H = TRACK_HEIGHT_PX + 4
// The video editor's keys (Editor.tsx handles them) are in
// src/lib/editor-keys.ts and changeable in Settings › Hotkeys (2026-11-24).

/** Shortest selection the bar lets you make — matches MIN_TRIM_MS in main. */
export const MIN_TRIM_SELECTION_MS = 500

interface TrackProps {
  /** The filmstrip of the ORIGINAL recording (hooks/useFilmstrip.ts), or
   *  null while there is none yet: the track is empty until then. */
  filmstrip: StripSprite | null
  durationMs: number
  currentMs: number
  startMs: number
  endMs: number
  onChange: (startMs: number, endMs: number) => void
  onSeek: (ms: number) => void
  /** While a handle is dragged, the video shows that handle's frame
   *  (2026-11-23); `null` when the drag ends: back to the playhead. */
  onPreview: (ms: number | null) => void
  disabled: boolean
  /** The video is playing: the playhead shows its time bubble. */
  playing: boolean
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
  /** Our own player controls (2026-11-22; the native ones are gone). */
  playing: boolean
  onTogglePlay: () => void
  muted: boolean
  /** The recording has sound: only then is Mute shown. */
  hasAudio: boolean
  onToggleMute: () => void
}

type DragTarget = 'start' | 'end' | 'seek'

/** A time over a point of the track, in the tooltip's styling with a
 *  little triangle pointing down at it (like QuickTime Player). It sits
 *  above the handles' 6px overhang, out into the video area. */
function TimeBubble({ left, ms }: { left: string; ms: number }) {
  return (
    <div
      className="absolute bottom-full mb-[13px] -translate-x-1/2 z-30 pointer-events-none px-2 py-1 rounded-md bg-tooltip ring-1 ring-inset ring-tooltip-ring text-on-tooltip text-xs font-medium tabular-nums whitespace-nowrap"
      style={{ left }}
    >
      {formatPlayheadTime(ms)}
      {/* The triangle: the ring colour, with the fill 1px inside it; both
          start on the bubble's 1px inset edge, which the fill opens. */}
      <span className="absolute left-1/2 top-full -mt-px -translate-x-1/2 w-0 h-0 border-x-[6px] border-x-transparent border-t-[6px] border-t-tooltip-ring" />
      <span className="absolute left-1/2 top-full -mt-[2px] -translate-x-1/2 w-0 h-0 border-x-[5px] border-x-transparent border-t-[5px] border-t-tooltip" />
    </div>
  )
}

/** The filmstrip, two handles for the trim range, a playhead, and the area
 *  outside the selection dimmed. */
function TrimTrack({
  filmstrip, durationMs, currentMs, startMs, endMs, onChange, onSeek, onPreview, disabled, playing,
}: TrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragTarget | null>(null)
  // The same, as state, for the time bubbles (2026-11-22).
  const [dragging, setDragging] = useState<DragTarget | null>(null)
  /** Where in the handle it was grabbed (ms from the handle's edge), so the
   *  handle doesn't jump to put its edge under the cursor. */
  const grabOffsetRef = useRef(0)
  const pct = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0)

  // The filmstrip is drawn from the recording's saved strip (2026-11-27; it
  // used to decode every frame again at each open, one seek per tile, and
  // show them one by one): one paint, before the bar's first frame when the
  // strip is there, and again at every width (cheap, so a resize needs no
  // settling wait). Measured and painted in layout effects for that.
  const filmstripRef = useRef<HTMLCanvasElement | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => setTrackWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const canvas = filmstripRef.current
    if (!canvas) return
    if (!filmstrip || trackWidth <= 0) { canvas.width = 0; canvas.height = 0; return }
    paintStrip(canvas, filmstrip, trackWidth, TRACK_HEIGHT_PX)
  }, [filmstrip, trackWidth])

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
    if (disabled || e.button !== 0) return // left button only (the right-click menu was removed, 2026-11-23)
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
    setDragging(target)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    applyDrag(target, ms - grabOffsetRef.current)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    // The button is up but no pointerup reached us: Electron drops it when
    // the release happens over a window drag region (title bar) or outside
    // the window. End the drag instead of following a cursor that let go.
    if ((e.buttons & 1) === 0) { dragRef.current = null; setDragging(null); return }
    applyDrag(dragRef.current, msAt(e.clientX) - grabOffsetRef.current)
  }
  const onPointerUp = () => { dragRef.current = null; setDragging(null) }
  // The video follows a dragged handle, and returns to the playhead after.
  const previewMs = dragging === 'start' ? startMs : dragging === 'end' ? endMs : null
  useEffect(() => { onPreview(previewMs) }, [previewMs, onPreview])
  // Also end it if the capture is lost or the window loses focus mid-drag.
  useEffect(() => {
    const end = () => { dragRef.current = null; setDragging(null) }
    window.addEventListener('blur', end)
    return () => window.removeEventListener('blur', end)
  }, [])

  // The strip's corners are rounded, except on a side whose handle has come
  // within its own width (12px) of that end: its straight inner edge would
  // leave a gap against the curve (2026-11-22).
  const squareLeft = trackWidth > 0 && (pct(startMs) / 100) * trackWidth < BRACKET_W
  const squareRight = trackWidth > 0 && (1 - pct(endMs) / 100) * trackWidth < BRACKET_W
  const corners = `${squareLeft ? 'rounded-l-none' : 'rounded-l-md'} ${squareRight ? 'rounded-r-none' : 'rounded-r-md'}`

  // Hovering outside the selection previews where a click would put the
  // nearest handle. Hidden over the handles themselves and while dragging.
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const onTrackPointerMove = (e: React.PointerEvent) => {
    onPointerMove(e)
    const overHandle = (e.target as HTMLElement).closest?.('[role="slider"]')
    setHoverMs(disabled || dragRef.current || overHandle ? null : msAt(e.clientX))
  }

  const landing = hoverMs === null ? null
    : hoverMs < startMs ? { ms: Math.max(0, hoverMs), side: 'start' as const }
    : hoverMs > endMs ? { ms: Math.min(durationMs, hoverMs), side: 'end' as const }
    : null

  return (
    // 16px side margin: room for the handles, which stick out 12px past the
    // strip's ends. 6px above and below: the frame bars overhang it by 6px.
    <div className="relative px-4 py-1.5">
      <div
        ref={trackRef}
        // Rounded 6px (2026-11-22): on the strip's own layers, not with
        // overflow-hidden here, which would clip the handles and bubbles.
        className={`relative bg-content ${corners}`}
        style={{ height: TRACK_HEIGHT_PX }}
        onPointerDown={onPointerDown('seek')}
        onPointerMove={onTrackPointerMove}
        onPointerLeave={() => setHoverMs(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        {/* Filmstrip: evenly spaced frames of the original recording */}
        <canvas
          ref={filmstripRef}
          className={`absolute inset-0 w-full h-full pointer-events-none ${corners}`}
          aria-hidden="true"
        />
        {/* Outside the selection: darkened in dark mode (70% black), lightened
            in light mode (70% white), so the cut-off frames sink into the bar
            (2026-11-22; dark was 65% black, then washed white and undone). */}
        <div className={`absolute inset-y-0 left-0 ${squareLeft ? '' : 'rounded-l-md'} bg-black/70 in-[.light]:bg-white/70 pointer-events-none`} style={{ width: `${pct(startMs)}%` }} />
        <div className={`absolute inset-y-0 right-0 ${squareRight ? '' : 'rounded-r-md'} bg-black/70 in-[.light]:bg-white/70 pointer-events-none`} style={{ width: `${100 - pct(endMs)}%` }} />
        {/* The strip's edge (2026-11-22): a 1px `line-subtle` ring just
            outside the strip, on the bar (an inset one over the frames read
            too strong: the see-through line let the frames shine through).
            The purple frame's bars and the handles cover it where the
            selection is; its corners follow the strip's. */}
        <div className={`absolute inset-0 ring-1 ring-line-subtle pointer-events-none ${corners}`} />
        {/* Playhead: a thin red line, 2px `danger` (Jasper, 2026-11-22).
            Tried before: white, white with a dark edge, accent 2 / 3 / 4px
            with white or line-strong edges. Under the purple frame and
            handles. */}
        <div
          className="absolute inset-y-0 w-0.5 bg-danger pointer-events-none"
          style={{ left: `${pct(currentMs)}%` }}
        />
        {/* Selection frame */}
        {/* The purple frame: plain accent bars, no shadow (2026-11-23,
            shadows tried and dropped). */}
        <div
          className="absolute -top-1.5 -bottom-1.5 border-y-[6px] border-accent pointer-events-none"
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
            className={`absolute -top-0.5 text-accent pointer-events-none ${landing.side === 'end' ? '-scale-x-100' : ''}`}
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
            className={`absolute -top-1.5 -bottom-1.5 w-3 bg-accent flex items-center justify-center ${
              h === 'start' ? 'rounded-l-md -translate-x-full' : 'rounded-r-md'
            } ${disabled ? '' : 'cursor-ew-resize'}`}
            style={{ left: `${pct(h === 'start' ? startMs : endMs)}%` }}
            onPointerDown={onPointerDown(h)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onPointerUp}
          >
            {/* A solid mix of on-accent into the accent (2026-11-27; it
                was on-accent at 60% opacity: colours shift, they don't
                fade). */}
            <div className="w-0.5 h-3 rounded bg-[color-mix(in_srgb,var(--color-on-accent)_60%,var(--color-accent))]" />
          </div>
        ))}
        {/* Time bubbles, QuickTime-style (2026-11-22): the start time over
            the start handle while it's dragged, the end time over the end
            handle, the playhead's time over the playhead while the video
            plays or the playhead is dragged. Centred on the handle (it sits
            12px outside its line) or on the playhead line. */}
        {dragging === 'start' && <TimeBubble left={`calc(${pct(startMs)}% - 6px)`} ms={startMs} />}
        {dragging === 'end' && <TimeBubble left={`calc(${pct(endMs)}% + 6px)`} ms={endMs} />}
        {/* The landing bracket gets its time too (2026-11-23), the triangle
            on the bracket's vertical stroke (1px outside the time's line). */}
        {landing && dragging === null && <TimeBubble left={`calc(${pct(landing.ms)}% ${landing.side === 'start' ? '-' : '+'} 1px)`} ms={landing.ms} />}
        {/* While a handle is dragged, the trimmed clip's length sits in the
            middle of the selection, over the frames (2026-11-22; it was in
            the handle's bubble). Tooltip styling, no triangle. */}
        {(dragging === 'start' || dragging === 'end') && (
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none px-2 py-1 rounded-md bg-tooltip ring-1 ring-inset ring-tooltip-ring text-on-tooltip text-xs font-medium tabular-nums whitespace-nowrap"
            style={{ left: `${(pct(startMs) + pct(endMs)) / 2}%` }}
          >
            {formatDuration(endMs - startMs)}
          </div>
        )}
        {(dragging === 'seek' || (playing && dragging === null)) && <TimeBubble left={`calc(${pct(currentMs)}% + 1px)`} ms={currentMs} />}
      </div>

    </div>
  )
}

/** The trim bar's controls (2026-11-22, compact layout): play / pause and
 *  mute stacked left of the filmstrip, Trim and Reset stacked right of it,
 *  all 32px icon buttons. A button that can't act shows disabled rather
 *  than going, so the stacks keep their shape. */
function SideControls({ side, ...p }: ActionsProps & { side: 'left' | 'right' }) {
  const isFullRange = p.startMs <= 0 && p.endMs >= p.durationMs
  if (side === 'left') {
    return (
      <div className="flex flex-col gap-2 flex-shrink-0">
        <button onClick={p.onTogglePlay} className={ICON_BUTTON} data-tip={p.playing ? 'Pause' : 'Play'} aria-label={p.playing ? 'Pause' : 'Play'}>
          <Icon name={p.playing ? 'pause' : 'play_arrow'} className="text-[16px]" />
        </button>
        <button
          onClick={p.onToggleMute}
          disabled={!p.hasAudio}
          className={ICON_BUTTON}
          data-tip={!p.hasAudio ? 'No sound' : p.muted ? 'Unmute' : 'Mute'}
          aria-label={!p.hasAudio ? 'The video has no sound' : p.muted ? 'Unmute' : 'Mute'}
        >
          <Icon name={p.muted || !p.hasAudio ? 'volume_off' : 'volume_up'} className="text-[16px]" />
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 flex-shrink-0">
      <button
        onClick={p.onApply}
        disabled={p.disabled || p.busy || !p.dirty || (isFullRange && !p.hasAppliedTrim)}
        className={ACCENT_ICON_BUTTON}
        data-tip={p.busy ? 'Trimming…' : 'Trim'}
        aria-label="Cut the video to the selection (the original is kept)"
      >
        {p.busy
          ? <Icon name="progress_activity" className="text-[16px] animate-spin" />
          : <Icon name="cut" className="text-[16px]" />}
      </button>
      <button
        onClick={p.onReset}
        disabled={p.disabled || p.busy || !(p.hasAppliedTrim || p.dirty)}
        className={ICON_BUTTON}
        data-tip="Reset"
        aria-label={p.hasAppliedTrim ? 'Remove the trim and use the full video' : 'Discard selection changes'}
      >
        <Icon name="restart_alt" className="text-[16px]" />
      </button>
    </div>
  )
}

/** How long the pointer may rest before the floating controls fade out. */
const CONTROLS_IDLE_MS = 3000
/** The fade itself: Tailwind classes for a floating control, shown or not.
 *  300ms opacity, none under reduced motion (a motion Jasper asked for). */
export const autoHideClass = (shown: boolean) =>
  `transition-opacity duration-300 ease-out motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0 pointer-events-none'}`

export interface AutoHide {
  shown: boolean
  /** Spread on each floating control: the pointer on it or keyboard focus
   *  in it keeps everything shown. */
  hold: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: (e: React.FocusEvent<HTMLElement>) => void
  }
}

/** Auto-hide for the editors' floating controls: the video trim bar
 *  (2026-11-23; a round close button shared it for a while) and the image
 *  toolbar (2026-11-25). Shown on load; fade out when the pointer rests for
 *  CONTROLS_IDLE_MS or `busy` turns on (video: playback starts; image: a
 *  stroke starts or the text box opens); back on any pointer move in the
 *  window or when `busy` turns off. While `ignoreMoves` is on (image: a
 *  stroke is being drawn, the pointer moves all the time) pointer moves
 *  don't bring them back. Never hide while the pointer is on one of them
 *  (they hide after it leaves and rests) or one has keyboard focus, nor
 *  while `keepShown` is on (image: the sticker panel is open, 2026-11-26);
 *  the idle wait starts again when it goes off. */
export function useAutoHideControls(busy: boolean, ignoreMoves = false, keepShown = false): AutoHide {
  const [shown, setShown] = useState(true)
  const overRef = useRef(false)
  const focusRef = useRef(false)
  const keepRef = useRef(keepShown)
  keepRef.current = keepShown
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideSoon = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (!overRef.current && !focusRef.current && !keepRef.current) setShown(false)
    }, CONTROLS_IDLE_MS)
  }, [])
  useEffect(() => {
    if (keepShown) { clearTimeout(timerRef.current); setShown(true) }
    else hideSoon()
  }, [keepShown, hideSoon])
  const ignoreMovesRef = useRef(ignoreMoves)
  ignoreMovesRef.current = ignoreMoves
  useEffect(() => {
    const onMove = () => { if (ignoreMovesRef.current) return; setShown(true); hideSoon() }
    window.addEventListener('pointermove', onMove)
    hideSoon()
    return () => { window.removeEventListener('pointermove', onMove); clearTimeout(timerRef.current) }
  }, [hideSoon])
  const wasBusyRef = useRef(busy)
  useEffect(() => {
    if (busy === wasBusyRef.current) return
    wasBusyRef.current = busy
    if (busy) {
      clearTimeout(timerRef.current)
      if (!overRef.current && !focusRef.current && !keepRef.current) setShown(false)
    } else {
      setShown(true)
      hideSoon()
    }
  }, [busy, hideSoon])
  const hold = useMemo<AutoHide['hold']>(() => ({
    onPointerEnter: () => { overRef.current = true },
    onPointerLeave: () => { overRef.current = false; hideSoon() },
    onFocus: () => { focusRef.current = true; setShown(true) },
    onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focusRef.current = false; hideSoon() } },
  }), [hideSoon])
  return { shown, hold }
}

/** Trim bar at the bottom of the video editor: the controls stacked either
 *  side of the filmstrip. Purely presentational: the Editor owns the
 *  numbers and talks to main, and the auto-hide (useAutoHideControls). */
export default function VideoTrimBar({ autoHide, ...props }: TrackProps & ActionsProps & { autoHide: AutoHide }) {
  return (
    // The toolbar layer with an inside top edge, like the AppBar's bottom
    // one (2026-11-22; it was glass).
    // Final 2026-11-23: floating over the video, 20px in from the
    // window's sides (the AppBar's edge offset: traffic lights, gear), 24px
    // up from the bottom; was a full-width bar under it
    // (`flex-shrink-0 bg-toolbar edge-t`). The whole group fades as one.
    <div
      // The edge is drawn inside (ring-inset, 2026-11-23), like the AppBar's
      // edge line: the 10px padding runs from the bar's outer edge, so a
      // time bubble overlaps it by 2px, as the Upload menu does the AppBar.
      className={`absolute left-(--mx) right-(--mx) bottom-(--my) z-20 rounded-lg bg-toolbar ring-1 ring-inset ring-line select-none ${autoHideClass(autoHide.shown)}`}
      {...autoHide.hold}
    >
      {/* No row under the strip (2026-11-22): the bubbles show the time
          while playing or dragging, the callout the length. 10px all round
          (2026-11-23), the AppBar buttons' space above and below on its
          52px bar; buttons to a fully extended trim arm 10px too (gap-1.5
          + the 4px the track's px-4 leaves beside a 12px handle). */}
      <div className="flex items-center gap-1.5 p-2.5">
        <SideControls side="left" {...props} />
        <div className="flex-1 min-w-0"><TrimTrack {...props} /></div>
        <SideControls side="right" {...props} />
      </div>
    </div>
  )
}
