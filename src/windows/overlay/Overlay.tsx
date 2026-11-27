import { BAR_TOP_DEFAULT } from '../../../shared/capture-bar'
import { useState, useEffect, useRef, useCallback } from 'react'

import { Segmented } from '../../components/Segmented'
import { TooltipLayer } from '../../components/TooltipLayer'
import { KIND_ICON } from '../../utils/captureLabels'

/** A camera pointer like macOS's screenshot one (Apple: "the screenshot you
 *  take is of an entire window"), for the window and monitor picks; the
 *  region pick keeps the crosshair (2026-11-22; both picks used the
 *  crosshair or the pointing hand). Chromium has no camera cursor and the
 *  system's own (HIServices cursors/screenshotwindow) is Apple's artwork, so
 *  this is our own drawing to its measurements, in its 28x25 frame: black
 *  body 20x13.5 (x 4 to 24, y 5 to 18.5, corners 2.5) with a raised top
 *  to y 3, a 1px white outline outside it (the stroke painted under the
 *  fill), a white lens ring 10px across centred on the click point (14,
 *  11.5), a 2px flash dot at 20,7, and the soft shadow macOS gives its
 *  pointers (blur 2, 45% black, 1px down). 1x and 2x so it stays sharp on
 *  Retina. */
const CAMERA_PATH = 'M6.5 5H9.6L10.9 3.6Q11.4 3 12.5 3H15.5Q16.6 3 17.1 3.6L18.4 5H21.5A2.5 2.5 0 0 1 24 7.5V16A2.5 2.5 0 0 1 21.5 18.5H6.5A2.5 2.5 0 0 1 4 16V7.5A2.5 2.5 0 0 1 6.5 5Z'
/** The Video modes' window and screen picks (2026-11-24): a video camera in
 *  the same style, frame and shadow, its body 15x13 (x 3 to 18, y 6 to 19,
 *  corners 2.5) with the lens wedge to x 25; click point in the body's
 *  middle (11, 12). */
const VIDEO_PATH = 'M5.5 6H15.5A2.5 2.5 0 0 1 18 8.5V10.3L23.6 7.3Q25 6.6 25 8.1V16.9Q25 18.4 23.6 17.7L18 14.7V16.5A2.5 2.5 0 0 1 15.5 19H5.5A2.5 2.5 0 0 1 3 16.5V8.5A2.5 2.5 0 0 1 5.5 6Z'
function pointerSvg(scale: number, path: string, extra: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${28 * scale}" height="${25 * scale}" viewBox="0 0 28 25">`
    + `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="0.45"/></filter></defs>`
    + `<g filter="url(#s)">`
    + `<path d="${path}" fill="#000" stroke="#fff" stroke-width="2" stroke-linejoin="round" paint-order="stroke"/>`
    + extra
    + `</g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
function pointer(path: string, extra: string, hx: number, hy: number): string {
  return `-webkit-image-set(${pointerSvg(1, path, extra)} 1x, ${pointerSvg(2, path, extra)} 2x) ${hx} ${hy}, ${pointerSvg(1, path, extra)} ${hx} ${hy}, default`
}
const CAMERA_CURSOR = pointer(CAMERA_PATH,
  `<circle cx="14" cy="11.5" r="4.25" fill="none" stroke="#fff" stroke-width="1.5"/><circle cx="20" cy="7" r="1" fill="#fff"/>`, 14, 11)
const VIDEO_CURSOR = pointer(VIDEO_PATH, '', 11, 12)

interface Rect { x: number; y: number; width: number; height: number }

type Mode =
  | 'region' | 'scroll-region' | 'window-pick' | 'monitor-pick'
  | 'video-region' | 'video-window' | 'video-screen'

type Intent = 'capture' | 'record'
type Base = 'region' | 'window' | 'screen'

function intentOf(mode: Mode): Intent {
  return mode.startsWith('video-') ? 'record' : 'capture'
}

function baseOf(mode: Mode): Base | 'scroll' {
  if (mode === 'scroll-region') return 'scroll'
  if (mode === 'region' || mode === 'video-region') return 'region'
  if (mode === 'window-pick' || mode === 'video-window') return 'window'
  if (mode === 'monitor-pick' || mode === 'video-screen') return 'screen'
  return 'region'
}

// One look for every mode (design review 2026-11-24): the pick is framed by
// a 1px line in the clip type's colour and everything outside it is dimmed.
// No red in Video mode (red means danger; the recording border during an
// actual recording stays red), no dashes, no tint over the pick (it would
// misrepresent the screen's colours).
/** The frame wears the clip type's colour (2026-11-24, trying it): blue
 *  for Image, pink for Video, as on the clip cards' type icon. */
const KIND_COLOR = { capture: 'var(--color-kind-image)', record: 'var(--color-kind-video)' } as const
/** The capture overlay's dim; a box-shadow ring, not a shadow. */
const DIM = 'rgba(0,0,0,0.18)'
/** Over a transparent overlay (video modes have no frozen snapshot), a
 *  barely-there fill so the window still takes the clicks. */
const CATCH = 'rgba(0,0,0,0.03)'

/** The pick's size, under it: a small solid box (11px, tabular digits). */
function SizeLabel({ rect }: { rect: Rect }) {
  return (
    <div
      className="absolute h-6 px-2 flex items-center rounded-md bg-toolbar ring-1 ring-inset ring-line text-[11px] font-medium tabular-nums text-fg pointer-events-none whitespace-nowrap"
      style={{ left: rect.x + rect.width / 2, top: rect.y + rect.height + 8, transform: 'translateX(-50%)' }}
    >
      {Math.round(rect.width)} × {Math.round(rect.height)}
    </div>
  )
}

/** Floating bar at the top of the active display: Image / Video and the
 *  area. Each area's how-to is its segment's tooltip (no hint row). */
function ModeBar({ mode, intent, session, top }: { mode: Mode; intent: Intent; session: number; top: number }) {
  const base = baseOf(mode)

  const switchTo = (nextBase: Base | 'scroll') => {
    if (nextBase === base) return
    // Scroll (Image only, 2026-11-23): the classic screen scroll on a dragged
    // region. Remembered like the other tools since 2026-11-27.
    if (nextBase === 'scroll') {
      window.electronAPI?.switchOverlayMode?.('scroll-region')
      window.electronAPI?.setSetting?.('lastImageMode', 'scrolling')
      return
    }
    const next: Mode = intent === 'record'
      ? (nextBase === 'region' ? 'video-region' : nextBase === 'window' ? 'video-window' : 'video-screen')
      : (nextBase === 'region' ? 'region' : nextBase === 'window' ? 'window-pick' : 'monitor-pick')
    window.electronAPI?.switchOverlayMode?.(next)
    window.electronAPI?.setSetting?.(intent === 'record' ? 'lastVideoMode' : 'lastImageMode', nextBase)
  }

  const switchIntent = (nextIntent: Intent) => {
    if (nextIntent === intent) return
    // Region/Window map 1:1; capture's screen is 'monitor-pick', record's is 'video-screen'.
    const safeBase: Base = base === 'region' || base === 'window' || base === 'screen' ? base : 'region'
    const next: Mode = nextIntent === 'record'
      ? (safeBase === 'region' ? 'video-region' : safeBase === 'window' ? 'video-window' : 'video-screen')
      : (safeBase === 'region' ? 'region' : safeBase === 'window' ? 'window-pick' : 'monitor-pick')
    window.electronAPI?.switchOverlayMode?.(next)
    window.electronAPI?.setSetting?.('lastCaptureKind', nextIntent === 'record' ? 'video' : 'image')
    // The tool carried over counts as picked for the other kind too.
    window.electronAPI?.setSetting?.(nextIntent === 'record' ? 'lastVideoMode' : 'lastImageMode', safeBase)
  }

  const record = intent === 'record'
  // Scroll is Image only; in Video it stays, disabled, so the bar keeps its
  // width and nothing shifts between the two (2026-11-24).
  const areas: { key: Base | 'scroll'; label: string; icon: string; tip: string; disabled?: boolean }[] = [
    { key: 'region', label: 'Region', icon: KIND_ICON.region, tip: 'Drag to select an area' },
    { key: 'window', label: 'Window', icon: KIND_ICON.window, tip: 'Click a window, or press Enter for the active one' },
    { key: 'screen', label: 'Screen', icon: KIND_ICON.screen, tip: record ? 'Click to record this screen' : 'Click to capture this screen' },
    record
      ? { key: 'scroll', label: 'Scroll', icon: KIND_ICON.scroll, tip: 'Image only', disabled: true }
      : { key: 'scroll', label: 'Scroll', icon: KIND_ICON.scroll, tip: 'Drag over the area to scroll, Esc stops' },
  ]

  return (
    <div
      // `top`: at the display's menu bar's bottom edge, from main
      // (shared/capture-bar.ts; 32px where there's no menu bar). The
      // recording toolbar's window is placed by the same number.
      className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3 p-2.5 rounded-lg bg-toolbar ring-1 ring-inset ring-line cursor-default"
      style={{ top }}
      // The overlay root drives region/window picking off POINTER events, so
      // we must swallow pointer events here too — stopping only the mouse
      // events lets `pointerdown` bubble through and start a drag (region) or
      // confirm a window-pick (window) instead of switching modes, which also
      // setPointerCapture-steals the tab's click. Keep the mouse handlers for
      // screen mode, whose root listens on `onClick`.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Keyed by session: a fresh control at each open puts the pill where
          it belongs at once (2026-11-24: the pooled overlay's controls slid
          from the last session's pick to this one's). */}
      <Segmented<Intent>
        key={`intent-${session}`}
        value={intent}
        onChange={switchIntent}
        pillColor={KIND_COLOR[intent]}
        options={[
          // The clip type icons from the Dashboard's cards (2026-11-24).
          { key: 'capture', label: 'Image', icon: 'image' },
          { key: 'record', label: 'Video', icon: 'smart_display' },
        ]}
      />
      <Segmented<Base | 'scroll'> key={`area-${session}`} value={base} onChange={switchTo} options={areas} pillColor={KIND_COLOR[intent]} />
    </div>
  )
}

export default function Overlay() {
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.style.background = ''
      document.documentElement.style.background = ''
    }
  }, [])

  const [mode, setMode] = useState<Mode>('region')
  // Bumped each time main (re)opens the pooled overlay, even in the same mode.
  const [session, setSession] = useState(0)

  // No focus left on a control (2026-11-24, as App.tsx does in the main
  // window): a click doesn't keep it, and each open starts with none (the
  // window taking focus could land it on the first button, ringed).
  useEffect(() => {
    const drop = () => { const el = document.activeElement as HTMLElement | null; if (el && el !== document.body) el.blur() }
    const onClick = (e: MouseEvent) => { if (e.detail > 0) drop() }
    const onFocus = () => setTimeout(drop, 0)
    document.addEventListener('click', onClick, true)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null
    if (el && el !== document.body) el.blur()
  }, [session])
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null)
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  // Starts inactive (2026-11-27; it started active): a pooled overlay sits
  // parked and invisible over its display from launch, and while "active"
  // its page asks for the crosshair. Main only said "inactive" to overlays
  // that had been opened once, so a never-used one kept asking, and the +
  // showed over everything as soon as Lumia became the active app (Open
  // Lumia), until a click on the main window. Every reveal sends the real
  // state first (`overlay:set-active`, index.ts), as it always did.
  const [isActive, setIsActive] = useState(false)
  // The mode bar's top on this display, sent by main at every open.
  const [barTop, setBarTop] = useState(BAR_TOP_DEFAULT)
  // Mission Control is up: shown but stepped aside (live screen, clicks pass
  // through); the bar stays, the tint and frames go.
  const [aside, setAside] = useState(false)
  const [hoveredWindow, setHoveredWindow] = useState<Rect | null>(null)
  // Frozen snapshot pushed from main at hotkey-press time as raw BGRA bytes
  // (no PNG encode round-trip — saves ~500-1000ms on 4K displays). The
  // overlay's <canvas> paints it via putImageData. `frozenBgReady` flips
  // true once the bitmap has been committed to the canvas and the GPU has
  // had a frame to display it; main gates win.setOpacity(1) on that ack
  // so the overlay only surfaces after the bg is visible.
  const [frozenBgr, setFrozenBgr] = useState<
    { buffer: Uint8Array; width: number; height: number } | null
  >(null)
  const [frozenBgReady, setFrozenBgReady] = useState(false)
  const frozenCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const hoveredWindowRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  const intent = intentOf(mode)
  const base = baseOf(mode)

  useEffect(() => {
    window.electronAPI?.getOverlayMode().then(m => setMode(m as Mode))
  }, [])

  useEffect(() => {
    window.electronAPI?.onOverlaySetActive((active: boolean) => setIsActive(active))
    window.electronAPI?.onOverlayBarTop?.((top: number) => { if (Number.isFinite(top) && top >= 0) setBarTop(top) })
    window.electronAPI?.onOverlayAside?.((a: boolean) => {
      setAside(a)
      if (a) { setHoveredWindow(null); setStartPos(null); setCurrentPos(null); setIsDrawing(false) }
    })
    window.electronAPI?.onOverlayModeChanged?.((m) => {
      setMode(m as Mode)
      setStartPos(null)
      setCurrentPos(null)
      setIsDrawing(false)
      setHoveredWindow(null)
      pickRef.current.gen++
      pickRef.current.next = null
      setSession(n => n + 1)
    })
    window.electronAPI?.onOverlayFrozenBgraChanged?.((data) => setFrozenBgr(data))
    return () => {
      window.electronAPI?.removeAllListeners('overlay:set-active')
      window.electronAPI?.removeAllListeners('overlay:bar-top')
      window.electronAPI?.removeAllListeners('overlay:aside')
      window.electronAPI?.removeAllListeners('overlay:mode-changed')
      window.electronAPI?.removeAllListeners('overlay:frozen-bgra-changed')
    }
  }, [])

  // Paint the BGRA buffer directly to the canvas — via a WebCodecs VideoFrame
  // when available (no CPU swizzle), else a B↔R swizzle into RGBA ImageData.
  // Two rAFs after putImageData guarantees the GPU has shown the bitmap, then
  // we ack main so it can ramp opacity to 1.
  useEffect(() => {
    const canvas = frozenCanvasRef.current
    if (!frozenBgr) {
      setFrozenBgReady(false)
      // Parked between captures (main sends null from closeAllOverlays):
      // release the canvas backing store so the previous snapshot's bitmap
      // — and its GPU texture — is freed instead of idling until next time.
      if (canvas) { canvas.width = 0; canvas.height = 0 }
      return
    }
    if (!canvas) return

    canvas.width = frozenBgr.width
    canvas.height = frozenBgr.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // BGRA → RGBA into a FRESH buffer — never mutate the IPC buffer in place.
    // This effect re-runs on `mode` changes, and the swap is an involution, so
    // an in-place swizzle would re-corrupt (red/blue swapped) on every other
    // mode switch. Reading from the untouched source each time keeps it
    // correct. For each px (little-endian BB GG RR AA → uint32 0xAARRGGBB),
    // swap the B and R bytes.
    const src = frozenBgr.buffer
    // Fast path: hand the BGRA bytes to the GPU as-is via a WebCodecs
    // VideoFrame ('BGRX' — alpha ignored) and drawImage it. Skips the JS
    // swizzle loop, the second full-frame RGBA allocation and putImageData's
    // CPU-side copy.
    let painted = false
    if (typeof VideoFrame !== 'undefined') {
      try {
        const frame = new VideoFrame(src, {
          format: 'BGRX',
          codedWidth: frozenBgr.width,
          codedHeight: frozenBgr.height,
          timestamp: 0,
        })
        try { ctx.drawImage(frame, 0, 0) } finally { frame.close() }
        painted = true
      } catch { /* fall back to the swizzle path below */ }
    }
    if (!painted) {
      const srcU32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2)
      const out = new Uint8ClampedArray(src.byteLength)
      const outU32 = new Uint32Array(out.buffer)
      for (let i = 0; i < srcU32.length; i++) {
        const v = srcU32[i]
        outU32[i] = (v & 0xFF00FF00) | ((v & 0x00FF0000) >>> 16) | ((v & 0x000000FF) << 16)
      }
      ctx.putImageData(new ImageData(out, frozenBgr.width, frozenBgr.height), 0, 0)
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFrozenBgReady(true)
        window.electronAPI?.notifyOverlayBgReady?.()
      })
    })
    // `mode` in deps: if the React tree shifts on mode change and the canvas
    // ref is reattached to a fresh DOM node, re-paint instead of leaving it
    // blank. Re-painting against the existing canvas is a no-op cost-wise.
  }, [frozenBgr, mode])

  // Window pick: one lookup at a time. A move while one is out parks the
  // newest point, sent as soon as the answer is back, so the frame follows
  // the pointer as fast as lookups return (2026-11-24; it waited for the
  // pointer to rest 80ms). `gen` drops answers that arrive after a confirm,
  // a cancel or a mode switch.
  const pickRef = useRef({ busy: false, next: null as { x: number; y: number } | 'cursor' | null, gen: 0 })
  const liveRef = useRef({ base, isActive: isActive && !aside })
  liveRef.current = { base, isActive: isActive && !aside }

  const lookupWindow = useCallback((at: { x: number; y: number } | null) => {
    const q = pickRef.current
    if (q.busy) { q.next = at ?? 'cursor'; return }
    const { base: b, isActive: active } = liveRef.current
    if (b !== 'window' || !active) return
    const gen = q.gen
    q.busy = true
    const req = at ? window.electronAPI?.getWindowAt(at.x, at.y) : window.electronAPI?.getWindowAtCursor?.()
    Promise.resolve(req).then(rect => {
      if (gen !== pickRef.current.gen) return
      hoveredWindowRef.current = rect ?? null
      setHoveredWindow(rect ?? null)
    }).catch(() => { /* keep the last frame */ }).finally(() => {
      q.busy = false
      const next = q.next
      q.next = null
      if (next) lookupWindow(next === 'cursor' ? null : next)
    })
  }, [])

  // Frame the window under a still pointer as soon as the pick opens.
  useEffect(() => {
    if (base === 'window' && isActive && !aside) lookupWindow(null)
  }, [base, isActive, aside, session, lookupWindow])

  // Wipe transient drawing state. Called on confirm AND cancel so that the
  // pre-warmed overlay window comes up clean on the next session — without
  // this, the prior session's rect lingers in React state and flashes on
  // reopen until the async overlay:mode-changed event resets it.
  const resetDrawState = useCallback(() => {
    pickRef.current.gen++
    pickRef.current.next = null
    setStartPos(null)
    setCurrentPos(null)
    setIsDrawing(false)
    setHoveredWindow(null)
    hoveredWindowRef.current = null
  }, [])

  const cancel = useCallback(() => {
    resetDrawState()
    if (mode === 'scroll-region') window.electronAPI?.cancelScrollRegion()
    else if (mode === 'window-pick') window.electronAPI?.cancelWindowPick()
    else if (mode === 'monitor-pick') window.electronAPI?.cancelMonitorPick()
    else if (mode === 'region') window.electronAPI?.cancelRegion()
    else window.electronAPI?.cancelVideo?.()
  }, [mode, resetDrawState])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { cancel(); return }
    // Window picker: Enter confirms the active (foreground) window without
    // hunting for it with the cursor. Main resolves which window that is and
    // routes to the capture or record confirm path based on the overlay mode.
    if (e.key === 'Enter' && base === 'window' && isActive) {
      e.preventDefault()
      resetDrawState()
      window.electronAPI?.confirmActiveWindow?.()
    }
  }, [cancel, base, isActive, resetDrawState])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // ── Region / scroll-region handlers ──────────────────────────────────────
  const getRect = (): Rect | null => {
    if (!startPos || !currentPos) return null
    return {
      x: Math.min(startPos.x, currentPos.x),
      y: Math.min(startPos.y, currentPos.y),
      width: Math.abs(currentPos.x - startPos.x),
      height: Math.abs(currentPos.y - startPos.y),
    }
  }

  const handleMouseDown = (e: React.PointerEvent) => {
    if (!isActive) return
    if (base === 'window') {
      const x = e.clientX
      const y = e.clientY
      pickRef.current.next = null
      window.electronAPI?.getWindowAt(x, y).then(rect => {
        if (!rect) return
        resetDrawState()
        if (intent === 'record') window.electronAPI?.confirmVideoWindow?.(rect)
        else window.electronAPI?.confirmWindowPick(rect)
      })
      return
    }
    // Capture the pointer so a drag that ends past the display edge (onto an
    // adjacent monitor) still delivers pointerup here — otherwise the drag
    // would wedge isDrawing=true and hold the overlay:drawing lock until ESC.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    setStartPos({ x: e.clientX, y: e.clientY })
    setCurrentPos({ x: e.clientX, y: e.clientY })
    setIsDrawing(true)
    window.electronAPI?.overlayDrawing(true)
  }

  const handleMouseMove = (e: React.PointerEvent) => {
    if (base === 'window') {
      lookupWindow({ x: e.clientX, y: e.clientY })
      return
    }
    if (!isDrawing) return
    setCurrentPos({ x: e.clientX, y: e.clientY })
  }

  // Pointer drag interrupted (e.g. OS took the pointer, display unplugged):
  // unwind cleanly so the overlay:drawing lock is released.
  const handlePointerCancel = () => {
    if (base === 'window' || !isDrawing) return
    setIsDrawing(false)
    window.electronAPI?.overlayDrawing(false)
    resetDrawState()
  }

  const handleMouseUp = async () => {
    if (base === 'window') return
    if (!isDrawing) return
    setIsDrawing(false)
    window.electronAPI?.overlayDrawing(false)
    const rect = getRect()
    if (!rect || rect.width < 10 || rect.height < 10) {
      // Tiny / no drag — treat as a non-confirmation but still wipe so the
      // next session doesn't inherit the stub rect.
      resetDrawState()
      return
    }
    resetDrawState()
    if (mode === 'scroll-region') {
      await window.electronAPI?.confirmScrollRegion(rect)
    } else if (mode === 'video-region') {
      await window.electronAPI?.confirmVideoRegion?.(rect)
    } else {
      await window.electronAPI?.confirmRegion({ dataUrl: '', rect })
    }
  }

  const rect = getRect()

  // Full-bleed snapshot rendered to a <canvas> via putImageData on the raw
  // BGRA bytes from main. Always in the DOM so the ref is bound when bgra
  // arrives; hidden via visibility until the first paint commits to avoid
  // a flash of empty canvas. Tint is intentionally not layered on top — any
  // blanket darken misrepresents the user's on-screen colors to the picker,
  // and the picker UI elements already convey "capture mode active". For
  // inactive overlays (cursor on another display) the snapshot still shows
  // so the user can see what's on each monitor.
  //
  // Video modes never show it (2026-11-24): a recording starts from the live
  // screen, so the pick does too. A session opened for an image and switched
  // to Video used to keep the still picture over playing video.
  const showFrozen = frozenBgReady && intent === 'capture'
  const FrozenBgLayer = (
    <canvas
      ref={frozenCanvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none select-none"
      style={{ zIndex: 0, visibility: showFrozen ? 'visible' : 'hidden' }}
    />
  )

  // ── Monitor-pick / video-screen UI ───────────────────────────────────────
  if (base === 'screen') {
    const onClick = () => {
      if (!isActive) return
      if (intent === 'record') window.electronAPI?.confirmVideoScreen?.()
      else window.electronAPI?.confirmMonitorPick()
    }
    return (
      <div
        className="fixed inset-0 select-none"
        style={{
          cursor: isActive && !aside ? (intent === 'record' ? VIDEO_CURSOR : CAMERA_CURSOR) : 'default',
          background: !showFrozen && isActive && !aside ? CATCH : 'transparent',
        }}
        onClick={onClick}
      >
        {FrozenBgLayer}
        {/* The picked screen is framed; the others are dimmed. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={aside ? undefined : isActive ? { boxShadow: `inset 0 0 0 1px ${KIND_COLOR[intent]}` } : { background: DIM }}
        />
        {isActive && (
          <>
            <ModeBar mode={mode} intent={intent} session={session} top={barTop} />
            <TooltipLayer />
          </>
        )}
      </div>
    )
  }

  // ── Window-pick / video-window UI ────────────────────────────────────────
  if (base === 'window') {
    return (
      <div
        className="fixed inset-0 select-none"
        style={{
          cursor: isActive && !aside ? (intent === 'record' ? VIDEO_CURSOR : CAMERA_CURSOR) : 'default',
          background: !showFrozen && isActive && !aside ? CATCH : 'transparent',
        }}
        onPointerMove={handleMouseMove}
        onPointerDown={handleMouseDown}
      >
        {FrozenBgLayer}

        {hoveredWindow && isActive && !aside && (
          <>
            <div
              className="absolute pointer-events-none"
              style={{
                left: hoveredWindow.x,
                top: hoveredWindow.y,
                width: hoveredWindow.width,
                height: hoveredWindow.height,
                border: `1px solid ${KIND_COLOR[intent]}`,
                boxShadow: `0 0 0 9999px ${DIM}`,
              }}
            />
            <SizeLabel rect={hoveredWindow} />
          </>
        )}

        {isActive && (
          <>
            <ModeBar mode={mode} intent={intent} session={session} top={barTop} />
            <TooltipLayer />
          </>
        )}
      </div>
    )
  }

  // ── Region / scroll-region / video-region UI ─────────────────────────────
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 select-none"
      style={{
        cursor: isActive && !aside ? 'crosshair' : 'default',
        background: !showFrozen && isActive && !aside ? CATCH : 'transparent',
      }}
      onPointerDown={handleMouseDown}
      onPointerMove={handleMouseMove}
      onPointerUp={handleMouseUp}
      onPointerCancel={handlePointerCancel}
    >
      {FrozenBgLayer}

      {rect && rect.width > 0 && rect.height > 0 && !aside && (
        <>
          <div
            className="absolute pointer-events-none"
            style={{
              left: rect.x, top: rect.y, width: rect.width, height: rect.height,
              border: `1px solid ${KIND_COLOR[intent]}`,
              boxShadow: `0 0 0 9999px ${DIM}`,
            }}
          />
          <SizeLabel rect={rect} />
        </>
      )}

      {isActive && (
        <>
          <ModeBar mode={mode} intent={intent} session={session} top={barTop} />
          <TooltipLayer />
        </>
      )}
    </div>
  )
}
