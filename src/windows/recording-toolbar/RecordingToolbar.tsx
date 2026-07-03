import { useEffect, useRef, useState } from 'react'

// In-DOM tooltip rendered as a child of each button. Native HTML title
// tooltips can't be used here — Windows renders them as a separate
// top-level HWND (tooltips_class32) and macOS as a separate NSWindow via
// NSToolTipManager; neither inherits the toolbar's content protection, so
// the tooltip would leak into the recording. Rendering it inside the
// React tree keeps it in the same HWND/NSWindow that already has
// WDA_EXCLUDEFROMCAPTURE / NSWindowSharingNone applied.
function Tip({ text, show }: { text: string; show: boolean }) {
  return (
    <span
      className="absolute left-1/2 top-full -translate-x-1/2 mt-2 px-2 py-1 rounded-md text-[11px] whitespace-nowrap pointer-events-none transition-opacity"
      style={{
        background: 'rgba(20,20,28,0.95)',
        border: '1px solid rgba(255,255,255,0.1)',
        color: 'white',
        opacity: show ? 1 : 0,
        WebkitAppRegion: 'no-drag',
        // Keep above the pill for layering, in case any sibling has its
        // own paint order assumption. Within the tooltip's own HWND.
        zIndex: 10,
      } as React.CSSProperties}
    >
      {text}
    </span>
  )
}

type Phase = 'init' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'saving' | 'done' | 'error'

type Tool = 'none' | 'select' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'highlighter'

const ANNOTATE_TOOLS: { id: Tool; icon: string; label: string }[] = [
  // 'none' doubles as the select mode now — clicks pass through to the
  // recorded app on empty area, but clicking an existing stroke's outline
  // selects it for delete/drag. Picking any of the drawing tools below
  // re-locks the overlay for ink.
  { id: 'none',        icon: 'arrow_selector_tool', label: 'Cursor (interact / select)' },
  { id: 'pen',         icon: 'draw',          label: 'Pen' },
  { id: 'arrow',       icon: 'arrow_forward', label: 'Arrow' },
  { id: 'rect',        icon: 'crop_square',   label: 'Rectangle' },
  { id: 'ellipse',     icon: 'circle',        label: 'Ellipse' },
  { id: 'highlighter', icon: 'highlight',     label: 'Highlighter' },
]

const ANNOTATE_COLORS = [
  '#f87171', // red
  '#fbbf24', // amber
  '#34d399', // emerald
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#ffffff', // white
  '#000000', // black
]

const ANNOTATE_STROKE_PRESETS = [2, 4, 8, 14] as const

const COUNTDOWN_START = 3

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function RecordingToolbar() {
  const [phase, setPhase] = useState<Phase>('init')
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
  const [annotateColor, setAnnotateColor] = useState('#f87171')
  const [strokeWidth, setStrokeWidth] = useState<number>(4)

  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

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
    const handler = (s: { phase?: Phase; elapsedMs?: number; countdown?: number; micEnabled?: boolean; micAvailable?: boolean; annotationOn?: boolean; error?: string }) => {
      if (typeof s.micAvailable === 'boolean') setMicAvailable(s.micAvailable)
      if (s.phase === 'countdown') {
        // Start local countdown (main just kicks it off)
        setPhase('countdown')
        setCountdown(COUNTDOWN_START)
        if (countdownTimer.current) clearInterval(countdownTimer.current)
        let c = COUNTDOWN_START
        countdownTimer.current = setInterval(() => {
          c -= 1
          setCountdown(c)
          if (c <= 0) {
            if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null }
            window.electronAPI?.toolbarBegin?.()
          }
        }, 1000)
        return
      }
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
  const onAnnotateClear = () => window.electronAPI?.annotationClear?.()

  const isRecording = phase === 'recording'
  const isPaused = phase === 'paused'
  const isBusy = phase === 'stopping' || phase === 'saving'
  const showAnnotationRow = annotationOn && (isRecording || isPaused)

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-start pt-1.5 gap-1.5" style={{ fontFamily: 'Manrope, sans-serif' }}>
      <div
        ref={recordingPillRef}
        className="relative flex items-center gap-2 px-3 py-2 glass-refractive rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        style={{
          WebkitAppRegion: 'drag',
          background: 'rgba(20,20,28,0.85)',
          border: '1px solid rgba(255,255,255,0.08)',
          // glass-refractive applies backdrop-filter, which creates a
          // stacking context that traps Tip inside this pill. Bump the
          // recording pill above the annotation pill (z:10) at the
          // outer-wrapper level so tooltips dropping from this row paint
          // over the annotation row instead of being hidden behind it.
          zIndex: 20,
        } as React.CSSProperties}
      >
        {/* Countdown view */}
        {phase === 'countdown' && (
          <div className="flex items-center gap-3 px-3">
            <span className="text-xs font-bold uppercase tracking-widest text-red-400">Starting in</span>
            <span
              className="text-3xl font-black text-white tabular-nums"
              style={{ minWidth: 36, textAlign: 'center' }}
              key={countdown}
            >
              {countdown}
            </span>
            <div className="w-px h-6 bg-white/10" />
            {/* Mic toggle — RecorderHost has already pre-acquired the mic
                track during this countdown window, so flipping it here is
                instant and stays in effect once recording begins. Disabled
                when no mic was acquired (permission denied / no device). */}
            <ToolbarBtn
              icon={!micAvailable ? 'mic_off' : micEnabled ? 'mic' : 'mic_off'}
              label={!micAvailable ? 'No microphone available' : micEnabled ? 'Mute microphone' : 'Enable microphone'}
              onClick={handleMic}
              active={micAvailable && micEnabled}
              accent={micAvailable && micEnabled ? 'red' : 'neutral'}
              disabled={!micAvailable}
            />
          </div>
        )}

        {/* Saving / done / error view */}
        {(phase === 'stopping' || phase === 'saving') && (
          <div className="flex items-center gap-3 px-4">
            <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-semibold text-slate-200">Saving…</span>
          </div>
        )}
        {phase === 'done' && (
          <div className="flex items-center gap-3 px-4">
            <span className="material-symbols-outlined text-emerald-400">check_circle</span>
            <span className="text-xs font-semibold text-slate-200">Saved</span>
          </div>
        )}
        {phase === 'error' && (
          <div className="flex items-center gap-3 px-4">
            <span className="material-symbols-outlined text-red-400">error</span>
            <span className="text-xs font-semibold text-red-300 max-w-[320px] truncate" title={error}>{error || 'Recording failed'}</span>
          </div>
        )}

        {/* Recording / paused view */}
        {(isRecording || isPaused) && (
          <>
            {/* LIVE indicator */}
            <div className="flex items-center gap-2 pl-2 pr-1">
              <span
                className={`w-2.5 h-2.5 rounded-full bg-red-500 ${isRecording ? 'animate-pulse' : 'opacity-50'}`}
                style={{ boxShadow: isRecording ? '0 0 10px rgba(239,68,68,0.8)' : 'none' }}
              />
              <span
                className="text-sm font-black text-white tabular-nums"
                style={{ minWidth: 56, textAlign: 'center' }}
              >
                {formatTime(elapsed)}
              </span>
            </div>

            <div className="w-px h-6 bg-white/10" />

            {/* Mic toggle */}
            <ToolbarBtn
              icon={!micAvailable ? 'mic_off' : micEnabled ? 'mic' : 'mic_off'}
              label={!micAvailable ? 'No microphone available' : micEnabled ? 'Mute microphone' : 'Enable microphone'}
              onClick={handleMic}
              active={micAvailable && micEnabled}
              accent={micAvailable && micEnabled ? 'red' : 'neutral'}
              disabled={!micAvailable}
            />

            {/* Annotate (live drawing overlay on the recording display) */}
            <ToolbarBtn
              icon="edit"
              label={annotationOn ? 'Stop annotating' : 'Annotate on screen'}
              onClick={handleAnnotation}
              active={annotationOn}
            />

            {/* Pause / Resume */}
            {isRecording ? (
              <ToolbarBtn
                icon="pause"
                label="Pause"
                onClick={handlePause}
              />
            ) : (
              <ToolbarBtn
                icon="play_arrow"
                label="Resume"
                onClick={handleResume}
                accent="red"
                active
              />
            )}

            {/* Stop */}
            <ToolbarBtn
              icon="stop"
              label="Stop recording"
              onClick={handleStop}
              accent="red"
              active
              disabled={isBusy}
            />

            <div className="w-px h-6 bg-white/10" />

            {/* Cancel */}
            <ToolbarBtn
              icon="close"
              label="Cancel (discard)"
              onClick={handleCancel}
              disabled={isBusy}
              compact
            />
          </>
        )}
      </div>

      {/* Annotation row — same window, second pill below the recording
          row. Used to live in its own BrowserWindow that visually anchored
          to this one; merging eliminates an entire class of z-order bugs
          where the recording toolbar's transparent bottom strip swallowed
          clicks aimed at the palette's centre. */}
      {showAnnotationRow && (
        <div
          ref={annotationPillRef}
          className="relative flex items-center gap-1.5 px-2 py-1.5 rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
          style={{
            WebkitAppRegion: 'drag',
            background: 'rgba(20,20,28,0.92)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(20px)',
            // Below the recording pill's z:20 so tooltips dropping from
            // the row above paint over this pill's body.
            zIndex: 10,
          } as React.CSSProperties}
        >
          {/* Tool buttons */}
          {ANNOTATE_TOOLS.map(t => (
            <AnnotateToolBtn key={t.id} icon={t.icon} label={t.label} active={tool === t.id} onClick={() => pickTool(t.id)} />
          ))}

          <Sep />

          {/* Stroke size */}
          {ANNOTATE_STROKE_PRESETS.map(n => (
            <StrokeBtn key={n} size={n} active={strokeWidth === n} onClick={() => pickStroke(n)} />
          ))}

          <Sep />

          {/* Color swatches */}
          {ANNOTATE_COLORS.map(c => (
            <ColorBtn key={c} color={c} active={annotateColor === c} onClick={() => pickColor(c)} />
          ))}

          <Sep />

          {/* Undo + Clear + Close */}
          <AnnotateToolBtn icon="undo"         label="Undo"             onClick={onAnnotateUndo} />
          <AnnotateToolBtn icon="delete_sweep" label="Clear all"        onClick={onAnnotateClear} />
          <AnnotateToolBtn icon="close"        label="Close annotation" onClick={handleAnnotation} accent="red" />
        </div>
      )}
    </div>
  )
}

function ToolbarBtn({
  icon, label, onClick, active = false, accent = 'neutral', disabled = false, compact = false,
}: {
  icon: string
  label: string
  onClick: () => void
  active?: boolean
  accent?: 'neutral' | 'red'
  disabled?: boolean
  compact?: boolean
}) {
  const [hover, setHover] = useState(false)
  const base = 'relative flex items-center justify-center rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed'
  const size = compact ? 'w-7 h-7' : 'w-9 h-9'
  let color: string
  if (active && accent === 'red') {
    color = 'bg-red-500/90 text-white hover:bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.5)]'
  } else if (active) {
    color = 'bg-white/15 text-white hover:bg-white/25'
  } else {
    color = 'text-slate-300 hover:text-white hover:bg-white/10'
  }
  return (
    <button
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`${base} ${size} ${color}`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className={`material-symbols-outlined ${compact ? 'text-[16px]' : 'text-[18px]'}`}>{icon}</span>
      <Tip text={label} show={hover && !disabled} />
    </button>
  )
}

function Sep() {
  return <div className="w-px h-5 bg-white/10 mx-0.5" />
}

function AnnotateToolBtn({
  icon, label, onClick, active = false, accent,
}: {
  icon: string
  label: string
  onClick: () => void
  active?: boolean
  accent?: 'red'
}) {
  const [hover, setHover] = useState(false)
  let cls = 'text-slate-300 hover:text-white hover:bg-white/10'
  if (active) cls = 'bg-white/20 text-white'
  if (accent === 'red') cls = 'text-slate-300 hover:text-white hover:bg-red-500/70'
  return (
    <button
      onClick={onClick}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-all ${cls}`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className="material-symbols-outlined text-[18px]">{icon}</span>
      <Tip text={label} show={hover} />
    </button>
  )
}

function StrokeBtn({ size, active, onClick }: { size: number; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      aria-label={`Stroke ${size}px`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative w-7 h-7 rounded-full flex items-center justify-center transition-all ${
        active ? 'bg-white/20' : 'hover:bg-white/10'
      }`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span
        className="rounded-full bg-white"
        style={{
          width: Math.min(18, Math.max(3, size * 1.2)),
          height: Math.min(18, Math.max(3, size * 1.2)),
        }}
      />
      <Tip text={`Stroke ${size}px`} show={hover} />
    </button>
  )
}

function ColorBtn({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      aria-label={`Color ${color}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative w-6 h-6 rounded-full transition-all ${
        active ? 'ring-2 ring-white ring-offset-2 ring-offset-[rgb(20,20,28)]' : 'hover:scale-110'
      }`}
      style={{
        WebkitAppRegion: 'no-drag',
        backgroundColor: color,
        border: color === '#ffffff' || color === '#000000' ? '1px solid rgba(255,255,255,0.2)' : 'none',
      } as React.CSSProperties}
    >
      <Tip text={color} show={hover} />
    </button>
  )
}
