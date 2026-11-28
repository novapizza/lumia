import { useEffect, useRef, useState } from 'react'
import { swatchClass, swatchFill, SWATCH_ROW } from '../../lib/swatch'

import { Icon } from '../../components/Icon'
import { Segmented } from '../../components/Segmented'
import { TooltipLayer } from '../../components/TooltipLayer'
import { ToastBox } from '../../components/Toast'
import { ICON_BUTTON, DANGER_ICON_BUTTON } from '../../components/button-classes'
import { OnStrip } from '../../components/OnStrip'
import { DEFAULT_ANNOTATION_COLOR } from '../../../shared/annotation'
import { SELECT_TOOLS, DRAW_TOOLS, EXTRA_TOOLS, COLORS, type Tool } from '../../components/AnnotationCanvas/tools'
import { StrokeControl, COLOR_NAMES, toolTip } from '../../components/AnnotationCanvas/ToolBar'
import { resolveKeymap, type Keymap } from '../../lib/editor-keys'

// Style review 2026-11-24: solid bars like the editor toolbar and the capture
// overlay, framed 32px icon buttons, colour-only hovers, one-word tooltips
// through TooltipLayer (mounted here: standalone windows don't get App's).
// It renders inside this window, so the window's content protection keeps
// tooltips out of the recording too (a native `title` tooltip is a window of
// its own and would leak). The recording itself wears the video colour
// (kind-video), as the border and the clip cards do.

type Phase = 'init' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'saving' | 'done' | 'error'

/** The image editor's tools in its order, without Sticker and Blur
 *  (2026-11-24, Jasper): the drawing layer is the editor's canvas. 'none'
 *  is the cursor: clicks pass through to the recorded app, a click on a
 *  shape selects it. */
const ANNOTATE_TOOLS = [...SELECT_TOOLS, ...DRAW_TOOLS, ...EXTRA_TOOLS].filter(t => t.id !== 'blur')

/** The bars: solid toolbar fill, inset line edge, 10px padding. */
const BAR = 'relative flex items-center p-2.5 rounded-lg bg-toolbar ring-1 ring-inset ring-line select-none'
/** Stop: the main action, in the video colour; under the pointer
 *  kind-video-hover, the accent's own hover step (2026-11-27; a colour-mix
 *  written in place before). */
const STOP_BUTTON =
  'w-8 h-8 inline-flex items-center justify-center rounded-lg border flex-shrink-0 enabled:bg-kind-video enabled:border-kind-video enabled:text-on-accent enabled:hover:bg-kind-video-hover disabled:bg-elevated disabled:border-line disabled:text-fg-disabled'
/** Clear all: the image editor's eraser (the shared DANGER_ICON_BUTTON;
 *  Discard wears it too, 2026-11-27: every delete is grey at rest and
 *  danger-text under the pointer). */
const CLEAR_BUTTON = DANGER_ICON_BUTTON
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

// Settings › General › Countdown (0, 3 or 5); main sends it with the
// countdown signal. 3 until told.
const COUNTDOWN_START = 3

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function RecordingToolbar() {
  // The page opens on "Starting in 3" (2026-11-24): main builds the toolbar
  // ahead, hidden, and sends `countdown` as it shows it; the count runs from
  // then, while the recorder host acquires its stream.
  const [phase, setPhase] = useState<Phase>('countdown')
  const [elapsed, setElapsed] = useState(0)
  const [countdown, setCountdown] = useState(COUNTDOWN_START)
  const [micEnabled, setMicEnabled] = useState(false)
  // Whether a microphone track was actually acquired by the recorder host.
  // When false the mic toggle is disabled — otherwise it would show a "live"
  // mic while no audio is being captured. Defaults true until told otherwise.
  const [micAvailable, setMicAvailable] = useState(true)
  const [annotationOn, setAnnotationOn] = useState(false)
  const [error, setError] = useState<string>('')

  // Annotation tool state. Lives here now that the palette is merged into
  // the recording toolbar — main process is still the source of truth, we
  // just mirror it for instant button-state feedback.
  const [tool, setTool] = useState<Tool>('none')
  const [annotateColor, setAnnotateColor] = useState(DEFAULT_ANNOTATION_COLOR)
  const [strokeWidth, setStrokeWidth] = useState<number>(4)

  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // The countdown has started (signal or the late is-shown ask), once.
  const countdownStartedRef = useRef(false)

  // Refs on each visible pill so the hover hit-test below can ask the OS
  // window to capture clicks only when the cursor is actually over a pill.
  // Keeps the empty transparent area between/around pills click-through to
  // whatever's beneath the toolbar window.
  const recordingPillRef = useRef<HTMLDivElement>(null)
  const annotationPillRef = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(false)

  // Body transparent
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
  }, [])

  // Hover-driven click-through. The toolbar window starts in
  // setIgnoreMouseEvents(true, forward:true) — clicks pass through to the
  // recorded app, but mousemove events still reach the renderer. We
  // hit-test the cursor against each pill's bounding rect on every move
  // and tell main to flip ignoreMouseEvents off only while the cursor is
  // over a pill. Sending IPC only on transition keeps traffic bounded.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const insidePill = (ref: React.RefObject<HTMLDivElement | null>) => {
        const el = ref.current
        if (!el) return false
        const r = el.getBoundingClientRect()
        return e.clientX >= r.left && e.clientX <= r.right &&
               e.clientY >= r.top  && e.clientY <= r.bottom
      }
      const inside = insidePill(recordingPillRef) || insidePill(annotationPillRef)
      if (inside !== interactiveRef.current) {
        interactiveRef.current = inside
        window.electronAPI?.toolbarSetInteractive?.(inside)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [])

  // Listen for state updates from main
  useEffect(() => {
    const startCountdown = (seconds = COUNTDOWN_START) => {
      countdownStartedRef.current = true
      setPhase('countdown')
      setCountdown(seconds)
      if (countdownTimer.current) clearInterval(countdownTimer.current)
      // Off: recording starts as soon as the host's stream is ready.
      if (seconds <= 0) { window.electronAPI?.toolbarBegin?.(); return }
      let c = seconds
      countdownTimer.current = setInterval(() => {
        c -= 1
        setCountdown(c)
        if (c <= 0) {
          if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null }
          // Main starts recording now, or once the host's stream is ready.
          window.electronAPI?.toolbarBegin?.()
        }
      }, 1000)
    }
    const handler = (s: { phase?: Phase; elapsedMs?: number; countdown?: number; micEnabled?: boolean; micAvailable?: boolean; annotationOn?: boolean; error?: string }) => {
      if (typeof s.micAvailable === 'boolean') setMicAvailable(s.micAvailable)
      if (s.phase === 'countdown') { startCountdown(s.countdown); return }
      // Any non-countdown phase means the countdown is over (begin fired, or
      // the session errored / was cancelled): stop the local countdown timer
      // so it can't call toolbarBegin() and start a recording the user was
      // trying to abort. (s.phase is already narrowed to exclude 'countdown'
      // here by the early return above.)
      if (s.phase && countdownTimer.current) {
        clearInterval(countdownTimer.current)
        countdownTimer.current = null
      }
      // Some state messages (e.g. mic toggle) carry only a payload field
      // and intentionally omit `phase` so they don't disturb the current
      // toolbar phase — for instance, toggling mic mid-countdown must not
      // flip the toolbar to 'recording' before MediaRecorder actually starts.
      if (s.phase) setPhase(s.phase)
      if (typeof s.elapsedMs === 'number') setElapsed(s.elapsedMs)
      if (typeof s.micEnabled === 'boolean') setMicEnabled(s.micEnabled)
      if (typeof s.annotationOn === 'boolean') setAnnotationOn(s.annotationOn)
      if (s.error) setError(s.error)
    }
    window.electronAPI?.onToolbarState?.(handler)
    // Shown before this page was listening: the countdown signal was missed.
    window.electronAPI?.toolbarIsShown?.().then(async shown => {
      if (!shown) return
      const s = await window.electronAPI?.getSettings?.().catch(() => null)
      // The signal, a begin or a cancel may have come meanwhile: start only
      // if nothing has.
      if (countdownStartedRef.current || phaseRef.current !== 'countdown') return
      startCountdown(s?.recordCountdown)
    }).catch(() => { /* signal comes */ })
    return () => { window.electronAPI?.removeAllListeners?.('toolbar:state') }
  }, [])

  // Mirror the annotation state from main. Fetch once at mount and listen
  // for live broadcasts after — main pushes a fresh state object on every
  // tool/color/stroke change AND on each openAnnotation (which resets tool
  // to 'none'). Keeping this in sync ahead of time means the annotation row
  // mounts with the correct active swatches immediately, instead of paint
  // once with defaults and re-render once the fetch resolves (a noticeable
  // flicker on toggle-on).
  useEffect(() => {
    window.electronAPI?.annotationGetState?.().then((s) => {
      if (!s) return
      setTool(s.tool as Tool)
      setAnnotateColor(s.color)
      setStrokeWidth(s.strokeWidth)
    }).catch(() => { /* ignore */ })
    window.electronAPI?.onAnnotationState?.((s) => {
      setTool(s.tool as Tool)
      setAnnotateColor(s.color)
      setStrokeWidth(s.strokeWidth)
    })
    return () => { window.electronAPI?.removeAllListeners?.('annotation:state') }
  }, [])

  // The overlay's selection and Undo / Redo availability (as the image
  // editor's toolbar has them).
  const [edit, setEdit] = useState<{ selectedKind: string | null; canUndo: boolean; canRedo: boolean }>({ selectedKind: null, canUndo: false, canRedo: false })
  useEffect(() => {
    window.electronAPI?.annotationGetEditState?.().then(s => { if (s) setEdit(s) }).catch(() => { /* ignore */ })
    window.electronAPI?.onAnnotationEditState?.(s => setEdit(s))
    return () => { window.electronAPI?.removeAllListeners?.('annotation:edit-state') }
  }, [])

  // The editor's keys, for the tools' tooltips (they work while drawing).
  const [keymap, setKeymap] = useState<Keymap | undefined>(undefined)
  useEffect(() => {
    const mac = navigator.platform.toLowerCase().includes('mac')
    window.electronAPI?.getSettings?.().then(s => setKeymap(resolveKeymap('image', s?.editorKeys?.image, mac))).catch(() => { /* names only */ })
  }, [])

  // Esc during the countdown cancels, like the X (2026-11-24; the toolbar
  // has focus then).
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phaseRef.current === 'countdown') { e.preventDefault(); window.electronAPI?.toolbarCancel?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Cleanup countdown interval on unmount
  useEffect(() => {
    return () => { if (countdownTimer.current) clearInterval(countdownTimer.current) }
  }, [])

  const handleStop   = () => window.electronAPI?.toolbarStop?.()
  const handleCancel = () => window.electronAPI?.toolbarCancel?.()
  const handlePause  = () => window.electronAPI?.toolbarPause?.()
  const handleResume = () => window.electronAPI?.toolbarResume?.()
  const handleMic    = () => {
    if (!micAvailable) return
    const next = !micEnabled
    setMicEnabled(next)
    window.electronAPI?.toolbarToggleMic?.(next)
  }
  const handleAnnotation = () => {
    const next = !annotationOn
    setAnnotationOn(next)
    window.electronAPI?.toolbarToggleAnnotation?.(next)
  }

  const pickTool = (t: Tool) => { setTool(t); window.electronAPI?.annotationSetTool?.(t) }
  const pickColor = (c: string) => { setAnnotateColor(c); window.electronAPI?.annotationSetColor?.(c) }
  const pickStroke = (n: number) => { setStrokeWidth(n); window.electronAPI?.annotationSetStroke?.(n) }
  const onAnnotateUndo = () => window.electronAPI?.annotationUndo?.()
  const onAnnotateRedo = () => window.electronAPI?.annotationRedo?.()
  const onAnnotateClear = () => window.electronAPI?.annotationClear?.()

  const isRecording = phase === 'recording'
  const isPaused = phase === 'paused'
  const isBusy = phase === 'stopping' || phase === 'saving'
  // Saving, saved and failed show as the app's toast (ToastBox, 2026-11-24)
  // in the bar's place, not as text in the bar.
  const asToast = isBusy || phase === 'done' || phase === 'error'
  const showAnnotationRow = annotationOn && (isRecording || isPaused)
  // Options follow the tool, or the selected shape's kind (as in the image
  // editor): stroke and colours for the drawing tools, none for the cursor
  // with nothing selected.
  // (The same rules as AnnotationCanvas/ToolBar.tsx: colours for the line
  // tools and Text; a line width, a text size or a blur strength.)
  const optionsOf = edit.selectedKind && edit.selectedKind !== 'none' ? edit.selectedKind : tool
  const showColours = ['pen', 'highlighter', 'arrow', 'rect', 'ellipse', 'text'].includes(optionsOf)
  const strokeKind: 'line' | 'size' | 'strength' | null =
    optionsOf === 'text' ? 'size' : optionsOf === 'blur' ? 'strength'
    : ['pen', 'highlighter', 'arrow', 'rect', 'ellipse'].includes(optionsOf) ? 'line' : null

  const micButton = (
    <button
      type="button"
      onClick={handleMic}
      disabled={!micAvailable}
      aria-pressed={micAvailable && micEnabled}
      className={`${ICON_BUTTON} group/on relative`}
      style={NO_DRAG}
      data-tip={!micAvailable ? 'No microphone' : micEnabled ? 'Mute' : 'Microphone'}
      aria-label={!micAvailable ? 'No microphone available' : micEnabled ? 'Mute microphone' : 'Turn on microphone'}
    >
      <Icon name={micAvailable && micEnabled ? 'mic' : 'mic_off'} className="text-[16px]" />
      {micAvailable && micEnabled && <OnStrip />}
    </button>
  )

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-start pt-1.5 gap-1.5">
      <TooltipLayer />
      <div
        ref={recordingPillRef}
        className={asToast ? '' : `${BAR} gap-10`}
        // Above the annotation bar, so tooltips from this row paint over it.
        style={{ WebkitAppRegion: 'drag', zIndex: 20 } as React.CSSProperties}
      >
        {/* Countdown */}
        {phase === 'countdown' && (
          <>
            <div className="flex items-center gap-3 pl-1">
              {/* At 0 (the count's end, or Countdown off) until recording
                  starts: no number. */}
              {countdown > 0 ? <>
                <span className="text-xs font-medium text-fg-secondary">Starting in</span>
                <span className="w-6 text-center text-[21px] font-semibold leading-none text-fg tabular-nums" key={countdown}>{countdown}</span>
              </> : <span className="text-xs font-medium text-fg-secondary">Starting…</span>}
            </div>
            {/* The mic was acquired during the countdown, so this is instant
                and carries into the recording. */}
            {micButton}
          </>
        )}

        {/* Saving / saved / failed: the app's toast */}
        {isBusy && <ToastBox kind="progress" icon="progress_activity" message="Saving video…" />}
        {phase === 'done' && <ToastBox kind="success" icon="check_circle" message="Video saved" />}
        {phase === 'error' && <ToastBox kind="error" icon="error" message="Couldn't record video" detail={error || undefined} />}

        {/* Recording / paused */}
        {(isRecording || isPaused) && (
          <>
            {/* Live: the video dot (grey while paused) and the time. */}
            <div className="flex items-center gap-2 pl-1">
              <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-kind-video' : 'bg-fg-tertiary'}`} />
              <span className="min-w-[38px] text-xs font-medium text-fg tabular-nums">{formatTime(elapsed)}</span>
            </div>

            <div className="flex items-center gap-3">
              {micButton}
              <button
                type="button"
                onClick={handleAnnotation}
                aria-pressed={annotationOn}
                className={`${ICON_BUTTON} group/on relative`}
                style={NO_DRAG}
                data-tip="Draw"
                aria-label={annotationOn ? 'Stop drawing on screen' : 'Draw on screen'}
              >
                <Icon name="edit" className="text-[16px]" />
                {annotationOn && <OnStrip />}
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={isRecording ? handlePause : handleResume}
                disabled={isBusy}
                className={ICON_BUTTON}
                style={NO_DRAG}
                data-tip={isRecording ? 'Pause' : 'Resume'}
                aria-label={isRecording ? 'Pause recording' : 'Resume recording'}
              >
                <Icon name={isRecording ? 'pause' : 'play_arrow'} className="text-[16px]" />
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={isBusy}
                className={STOP_BUTTON}
                style={NO_DRAG}
                data-tip="Stop"
                aria-label="Stop and save the recording"
              >
                <Icon name="stop" className="text-[16px]" />
              </button>
            </div>

            <button
              type="button"
              onClick={handleCancel}
              disabled={isBusy}
              className={DANGER_ICON_BUTTON}
              style={NO_DRAG}
              data-tip="Discard"
              aria-label="Discard the recording"
            >
              <Icon name="close" className="text-[16px]" />
            </button>
          </>
        )}
      </div>

      {/* Drawing row: the image editor's toolbar (tools, stroke, colours),
          then Undo, Clear and Close. Same window as the row above (its own
          window used to lose z-order fights with it). */}
      {showAnnotationRow && (
        <div
          ref={annotationPillRef}
          className={`${BAR} gap-10`}
          style={{ WebkitAppRegion: 'drag', zIndex: 10 } as React.CSSProperties}
        >
          <div className="flex items-center gap-3" style={NO_DRAG}>
            <Segmented<Tool>
              value={tool}
              onChange={pickTool}
              options={ANNOTATE_TOOLS.map(t => ({ key: t.id, icon: t.icon, title: t.label, tip: toolTip(t.label, t.id, keymap) }))}
            />
            {strokeKind && <StrokeControl kind={strokeKind} value={strokeWidth} onChange={pickStroke} />}
            {/* No Custom colour: left out while Custom opened macOS's colour
                panel, a window of its own that would show in the recording.
                The in-app picker (2026-11-24) has no such window, but the
                row stays without Custom (decided 2026-11-25). */}
            {showColours && <div className={`${SWATCH_ROW} p-1 -m-1`}>
              {COLORS.map(c => {
                const on = annotateColor.toLowerCase() === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pickColor(c)}
                    data-tip={COLOR_NAMES[c] ?? c}
                    aria-label={COLOR_NAMES[c] ?? c}
                    aria-pressed={on}
                    className={swatchClass(on)}
                    style={{ background: swatchFill(c) }}
                  />
                )
              })}
            </div>}
          </div>

          <div className="flex items-center gap-3" style={NO_DRAG}>
            <button type="button" onClick={onAnnotateUndo} disabled={!edit.canUndo} className={ICON_BUTTON} data-tip="Undo" aria-label="Undo">
              <Icon name="undo" className="text-[16px]" />
            </button>
            <button type="button" onClick={onAnnotateRedo} disabled={!edit.canRedo} className={ICON_BUTTON} data-tip="Redo" aria-label="Redo">
              <Icon name="redo" className="text-[16px]" />
            </button>
            <button type="button" onClick={onAnnotateClear} className={CLEAR_BUTTON} data-tip="Clear" aria-label="Clear all drawings">
              <Icon name="cleaning_services" className="text-[16px]" />
            </button>
            <button type="button" onClick={handleAnnotation} className={ICON_BUTTON} data-tip="Close" aria-label="Stop drawing on screen">
              <Icon name="close" className="text-[16px]" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

