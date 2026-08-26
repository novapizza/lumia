import { useState, useEffect, useRef, useCallback } from 'react'

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

const ACCENT = {
  capture: {
    border: 'rgba(182,160,255,0.8)',       // primary purple
    highlightBorder: 'rgba(96,165,250,0.9)', // blue for window/monitor hover
    highlightShadow: 'rgba(96,165,250,0.3)',
    highlightFill: 'rgba(96,165,250,0.06)',
    activeBg: 'rgba(59,130,246,0.06)',
    tabGlow: '0 0 12px rgba(182,160,255,0.35)',
  },
  record: {
    border: 'rgba(239,68,68,0.9)',          // red-500
    highlightBorder: 'rgba(239,68,68,0.9)',
    highlightShadow: 'rgba(239,68,68,0.3)',
    highlightFill: 'rgba(239,68,68,0.08)',
    activeBg: 'rgba(239,68,68,0.05)',
    tabGlow: '0 0 12px rgba(239,68,68,0.45)',
  },
} as const

function HintCard({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div
      className="absolute top-8 left-1/2 -translate-x-1/2 glass-refractive rounded-full px-6 py-3 text-sm text-white font-semibold pointer-events-none"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <span className="material-symbols-outlined text-sm mr-2 align-middle">{icon}</span>
      {children}
    </div>
  )
}

/** Floating top bar: mode switcher + hint. Visible only on the active overlay. */
function ModeBar({
  mode, hint, icon, intent,
}: {
  mode: Mode
  hint: string
  icon: string
  intent: Intent
}) {
  const base = baseOf(mode)
  const accent = ACCENT[intent]

  const switchTo = (nextBase: Base) => {
    if (nextBase === base) return
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
  }

  const TabBtn = ({ value, label, tabIcon }: { value: Base; label: string; tabIcon: string }) => {
    const active = base === value
    return (
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); switchTo(value) }}
        className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1 transition-all ${
          active
            ? (intent === 'record'
                ? 'bg-red-500 text-white'
                : 'bg-primary text-slate-900')
            : 'text-slate-300 hover:text-white hover:bg-white/10'
        }`}
        style={{
          fontFamily: 'Manrope, sans-serif',
          boxShadow: active ? accent.tabGlow : undefined,
        }}
      >
        <span className="material-symbols-outlined text-[14px]">{tabIcon}</span>
        {label}
      </button>
    )
  }

  const IntentBtn = ({ value, label, iconName }: { value: Intent; label: string; iconName: string }) => {
    const active = intent === value
    return (
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); switchIntent(value) }}
        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold flex items-center gap-1 transition-all ${
          active
            ? (value === 'record' ? 'bg-red-500/20 text-red-200' : 'bg-primary/25 text-primary')
            : 'text-slate-400 hover:text-white'
        }`}
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <span className="material-symbols-outlined text-[13px]">{iconName}</span>
        {label}
      </button>
    )
  }

  return (
    <div
      className="absolute top-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div
        className="flex items-center gap-3 glass-refractive rounded-full pl-1.5 pr-3 py-1.5"
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
        {intent === 'record' && (
          <div className="ml-2 mr-1 flex items-center gap-1.5 text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
            <span className="text-[10px] font-bold uppercase tracking-widest">REC</span>
          </div>
        )}
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/5 border border-white/10">
          <IntentBtn value="capture" label="Image" iconName="photo_camera" />
          <IntentBtn value="record"  label="Video" iconName="videocam" />
        </div>
        <div className="w-px h-4 bg-white/10" />
        <div className="flex items-center gap-1">
          <TabBtn value="region" label="Region" tabIcon="crop" />
          <TabBtn value="window" label="Window" tabIcon="web_asset" />
          <TabBtn value="screen" label="Screen" tabIcon="monitor" />
        </div>
      </div>

      {/* Hint on its own row — never fights for space with the controls. */}
      <div className="flex items-center gap-2 glass-refractive rounded-full px-4 py-1 whitespace-nowrap">
        <span className="material-symbols-outlined text-sm text-white">{icon}</span>
        <span className="text-xs font-semibold text-white">{hint}</span>
      </div>
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
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null)
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [isActive, setIsActive] = useState(true)
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
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoveredWindowRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  const intent = intentOf(mode)
  const base = baseOf(mode)
  const accent = ACCENT[intent]

  useEffect(() => {
    window.electronAPI?.getOverlayMode().then(m => setMode(m as Mode))
  }, [])

  useEffect(() => {
    window.electronAPI?.onOverlaySetActive((active: boolean) => setIsActive(active))
    window.electronAPI?.onOverlayModeChanged?.((m) => {
      setMode(m as Mode)
      setStartPos(null)
      setCurrentPos(null)
      setIsDrawing(false)
      setHoveredWindow(null)
    })
    window.electronAPI?.onOverlayFrozenBgraChanged?.((data) => setFrozenBgr(data))
    return () => {
      window.electronAPI?.removeAllListeners('overlay:set-active')
      window.electronAPI?.removeAllListeners('overlay:mode-changed')
      window.electronAPI?.removeAllListeners('overlay:frozen-bgra-changed')
    }
  }, [])

  // Paint the BGRA buffer directly to the canvas. We swizzle B↔R in-place via
  // a Uint32Array view (4× fewer iterations than per-byte) — on a 4K image
  // that's ~10ms vs ~40ms. ImageData wants RGBA so the swizzle is mandatory.
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
    const srcU32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2)
    const out = new Uint8ClampedArray(src.byteLength)
    const outU32 = new Uint32Array(out.buffer)
    for (let i = 0; i < srcU32.length; i++) {
      const v = srcU32[i]
      outU32[i] = (v & 0xFF00FF00) | ((v & 0x00FF0000) >>> 16) | ((v & 0x000000FF) << 16)
    }
    ctx.putImageData(new ImageData(out, frozenBgr.width, frozenBgr.height), 0, 0)

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

  // Window-pick: poll window under cursor (throttled 80ms)
  const pollWindowAt = useCallback(async (x: number, y: number) => {
    if (base !== 'window' || !isActive) return
    const rect = await window.electronAPI?.getWindowAt(x, y)
    hoveredWindowRef.current = rect ?? null
    setHoveredWindow(rect ?? null)
  }, [base, isActive])

  // Wipe transient drawing state. Called on confirm AND cancel so that the
  // pre-warmed overlay window comes up clean on the next session — without
  // this, the prior session's rect lingers in React state and flashes on
  // reopen until the async overlay:mode-changed event resets it.
  const resetDrawState = useCallback(() => {
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
      if (pollRef.current) clearTimeout(pollRef.current)
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
      const x = e.clientX
      const y = e.clientY
      if (pollRef.current) clearTimeout(pollRef.current)
      pollRef.current = setTimeout(() => pollWindowAt(x, y), 80)
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
  const FrozenBgLayer = (
    <canvas
      ref={frozenCanvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none select-none"
      style={{ zIndex: 0, visibility: frozenBgReady ? 'visible' : 'hidden' }}
    />
  )

  // ── Monitor-pick / video-screen UI ───────────────────────────────────────
  if (base === 'screen') {
    const onClick = () => {
      if (!isActive) return
      if (intent === 'record') window.electronAPI?.confirmVideoScreen?.()
      else window.electronAPI?.confirmMonitorPick()
    }
    const hint = intent === 'record'
      ? 'Click to record this monitor · ESC to cancel'
      : 'Click to capture this monitor · ESC to cancel'
    return (
      <div
        className="fixed inset-0 select-none"
        style={{
          cursor: isActive ? 'pointer' : 'default',
          // Tint only over a transparent (video) overlay; over a frozen
          // snapshot any darken misrepresents the user's screen colors.
          background: !frozenBgReady && isActive ? accent.activeBg : 'transparent',
        }}
        onClick={onClick}
      >
        {FrozenBgLayer}
        {isActive && (
          <>
            <div
              className="absolute inset-4 pointer-events-none"
              style={{
                border: `3px dashed ${accent.highlightBorder}`,
                borderRadius: 8,
                boxShadow: `inset 0 0 0 1px ${accent.highlightShadow}`,
              }}
            />
            <ModeBar mode={mode} intent={intent} icon="monitor" hint={hint} />
          </>
        )}
      </div>
    )
  }

  // ── Window-pick / video-window UI ────────────────────────────────────────
  if (base === 'window') {
    const hint = intent === 'record'
      ? 'Click a window to record · Enter for active window · ESC to cancel'
      : 'Click a window · Enter for active window · ESC to cancel'
    return (
      <div
        className="fixed inset-0 select-none"
        style={{
          cursor: isActive ? 'crosshair' : 'default',
          background: !frozenBgReady && isActive ? 'rgba(0,0,0,0.03)' : 'transparent',
        }}
        onPointerMove={handleMouseMove}
        onPointerDown={handleMouseDown}
      >
        {FrozenBgLayer}

        {isActive && (
          <ModeBar mode={mode} intent={intent} icon="window" hint={hint} />
        )}

        {hoveredWindow && isActive && (
          <>
            <div
              className="absolute pointer-events-none"
              style={{
                left: hoveredWindow.x,
                top: hoveredWindow.y,
                width: hoveredWindow.width,
                height: hoveredWindow.height,
                border: `2px dashed ${accent.highlightBorder}`,
                boxShadow: `0 0 0 9999px rgba(0,0,0,0.08), inset 0 0 0 1px ${accent.highlightShadow}`,
                borderRadius: 4,
                background: accent.highlightFill,
              }}
            />
            <div
              className="absolute glass-refractive text-xs text-white px-3 py-1.5 rounded-full pointer-events-none font-mono"
              style={{
                left: hoveredWindow.x + hoveredWindow.width / 2,
                top: hoveredWindow.y + hoveredWindow.height + 10,
                transform: 'translateX(-50%)',
                fontFamily: 'Manrope, sans-serif',
              }}
            >
              {hoveredWindow.width} × {hoveredWindow.height}
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Region / scroll-region / video-region UI ─────────────────────────────
  const hint = mode === 'scroll-region'
    ? 'Drag to select scroll region · ESC to cancel'
    : intent === 'record'
      ? 'Drag to select recording area · ESC to cancel'
      : 'Drag to select region · ESC to cancel'
  const icon = mode === 'scroll-region' ? 'swipe_down' : intent === 'record' ? 'fiber_manual_record' : 'crop_free'

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 select-none"
      style={{
        cursor: isActive ? 'crosshair' : 'default',
        background: !frozenBgReady && isActive ? 'rgba(0,0,0,0.08)' : 'transparent',
      }}
      onPointerDown={handleMouseDown}
      onPointerMove={handleMouseMove}
      onPointerUp={handleMouseUp}
      onPointerCancel={handlePointerCancel}
    >
      {FrozenBgLayer}
      <style>{`
        @keyframes scroll-region-border-pulse {
          0%, 100% { border-color: rgba(56, 189, 248, 0.8); box-shadow: 0 0 0 9999px rgba(0,0,0,0.18); }
          50% { border-color: rgba(56, 189, 248, 0.4); box-shadow: 0 0 0 9999px rgba(0,0,0,0.18), 0 0 12px 2px rgba(56, 189, 248, 0.3); }
        }
        .scroll-region-pulse { animation: scroll-region-border-pulse 1.5s ease-in-out infinite; }
      `}</style>

      {isActive && (mode === 'region' || mode === 'video-region') && (
        <ModeBar mode={mode} intent={intent} icon={icon} hint={hint} />
      )}
      {isActive && mode === 'scroll-region' && (
        <HintCard icon={icon}>{hint}</HintCard>
      )}

      {rect && rect.width > 0 && rect.height > 0 && (
        <>
          <div
            className={`absolute pointer-events-none${mode === 'scroll-region' ? ' scroll-region-pulse' : ''}`}
            style={{
              left: rect.x, top: rect.y, width: rect.width, height: rect.height,
              background: 'transparent',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.18)',
              border: mode === 'scroll-region'
                ? '2px solid rgba(56, 189, 248, 0.8)'
                : `2px dashed ${accent.border}`,
              borderRadius: 4,
            }}
          />
          <div
            className="absolute glass-refractive text-xs text-white px-3 py-1.5 rounded-full pointer-events-none font-mono"
            style={{
              left: rect.x + rect.width / 2,
              top: rect.y + rect.height + 10,
              transform: 'translateX(-50%)',
              fontFamily: 'Manrope, sans-serif',
            }}
          >
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </>
      )}
    </div>
  )
}
