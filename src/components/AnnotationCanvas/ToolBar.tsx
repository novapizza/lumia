import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DRAW_TOOLS, EXTRA_TOOLS, SELECT_TOOLS, COLORS, STROKE_PRESETS, type Tool, type ToolDef } from './tools'

interface Props {
  tool: Tool
  setTool: (t: Tool) => void
  color: string
  setColor: (c: string) => void
  strokeWidth: number
  setStrokeWidth: (w: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  /** Tools to hide (e.g. ['blur'] when background is a live video). */
  disabledTools?: Tool[]
  /** Rendered at the very left of the bar — used for mode-specific extras
   *  such as the Editor's "AI Blur" toggle. */
  extraLeft?: ReactNode
}

/** Shared Snipping-Tool-style bottom toolbar. Used by both the image editor
 *  and the video annotator so the two feel like siblings, not cousins. */
export default function AnnotationToolBar({
  tool, setTool,
  color, setColor,
  strokeWidth, setStrokeWidth,
  canUndo, canRedo, onUndo, onRedo, onClear,
  disabledTools = [],
  extraLeft,
}: Props) {
  const isHidden = (id: Tool) => disabledTools.includes(id)
  const filter = (list: ToolDef[]) => list.filter(t => !isHidden(t.id))

  // Render order matches the live annotation palette: Select first, the
  // common drawing tools next, then editor-only extras (blur / text).
  const groups: { key: string; tools: ToolDef[] }[] = [
    { key: 'cursor', tools: filter(SELECT_TOOLS) },
    { key: 'draw',   tools: filter(DRAW_TOOLS) },
    { key: 'extra',  tools: filter(EXTRA_TOOLS) },
  ].filter(g => g.tools.length > 0)

  // Color popover (mobile / narrow layouts)
  const colorBtnRef = useRef<HTMLButtonElement>(null)
  const colorPopoverRef = useRef<HTMLDivElement>(null)
  const [popover, setPopover] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!popover) return
    const onDown = (e: MouseEvent) => {
      if (colorPopoverRef.current?.contains(e.target as Node)) return
      if (colorBtnRef.current?.contains(e.target as Node)) return
      setPopover(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [popover])

  const openPopover = () => {
    const r = colorBtnRef.current?.getBoundingClientRect()
    if (!r) return
    setPopover({ left: r.left + r.width / 2, top: r.top - 8 })
  }

  return (
    <div className="liquid-glass border-t border-white/5 flex-shrink-0 flex flex-col">
      <div className="flex items-stretch h-12 px-3 gap-1">

        {/* ── Left: extras + tool groups ──────────────────────────────── */}
        <div className="flex items-stretch gap-1 flex-shrink-0">
          {extraLeft && (
            <>
              <div className="flex items-center gap-0.5 px-1">{extraLeft}</div>
              <div className="w-px h-7 bg-white/[0.06] self-center mx-1" />
            </>
          )}

          {groups.map((group) => {
            const active = group.tools.some(t => t.id === tool)
            return (
              <div key={group.key} className="flex items-center">
                <div className={`flex items-center gap-0.5 rounded-xl p-0.5 ${active ? 'bg-white/[0.06]' : ''}`}>
                  {group.tools.map(({ id, icon, label, shortcut }) => (
                    <button
                      key={id}
                      title={`${label} (${shortcut})`}
                      onClick={() => setTool(id)}
                      className={`relative flex items-center justify-center w-9 h-9 rounded-lg transition-all ${
                        tool === id
                          ? 'bg-primary/20 text-primary shadow-[0_0_12px_rgba(182,160,255,0.15)]'
                          : 'text-slate-400 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[18px]">{icon}</span>
                    </button>
                  ))}
                </div>
                <div className="w-px h-7 bg-white/[0.06] mx-1" />
              </div>
            )
          })}
        </div>

        {/* ── Middle: color + stroke ──────────────────────────────────── */}
        {/* data-style-controls: the Canvas text box keeps editing (and takes
            focus back) when focus lands here — picking a color / stroke is an
            edit of the text being typed, not the end of typing. */}
        <div className="flex-1 flex items-center gap-2 min-w-0 overflow-hidden" data-style-controls="">
          <div className="flex items-center gap-1 px-1 flex-shrink min-w-0">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className="relative flex-shrink-0 transition-all hover:scale-110 hidden lg:flex"
                title={c}
              >
                <div
                  className={`w-5 h-5 rounded-full border-2 transition-all ${
                    color === c ? 'border-white scale-125 shadow-[0_0_8px_rgba(255,255,255,0.3)]' : 'border-transparent hover:border-white/30'
                  }`}
                  style={{ background: c }}
                />
              </button>
            ))}

            {/* Compact popover trigger for narrow layouts */}
            <button
              ref={colorBtnRef}
              type="button"
              title="Pick a color"
              onClick={openPopover}
              className="relative w-5 h-5 flex-shrink-0 cursor-pointer group block lg:hidden"
            >
              <div className="w-5 h-5 rounded-full border-2 border-dashed border-white/20 group-hover:border-white/50 transition-colors flex items-center justify-center overflow-hidden">
                <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(red, yellow, lime, cyan, blue, magenta, red)` }} />
              </div>
            </button>

            {/* Native color picker — visible at lg+ */}
            <label className="relative w-5 h-5 flex-shrink-0 cursor-pointer group hidden lg:block" title="Custom color">
              <div className="w-5 h-5 rounded-full border-2 border-dashed border-white/20 group-hover:border-white/50 transition-colors flex items-center justify-center overflow-hidden">
                <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(red, yellow, lime, cyan, blue, magenta, red)` }} />
              </div>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
            </label>
          </div>

          <div className="w-px h-7 bg-white/[0.06] self-center flex-shrink-0 hidden min-[950px]:block" />

          <div className="hidden min-[950px]:flex items-center gap-2 px-2 min-w-0 flex-1">
            <div className="hidden xl:flex items-center gap-1 flex-shrink-0">
              {STROKE_PRESETS.map((w) => (
                <button
                  key={w}
                  onClick={() => setStrokeWidth(w)}
                  className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all ${
                    strokeWidth === w ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-white hover:bg-white/10'
                  }`}
                  title={`Stroke ${w}px`}
                >
                  <div
                    className="rounded-full flex-shrink-0"
                    style={{ background: 'currentColor', width: w + 4, height: w + 4 }}
                  />
                </button>
              ))}
            </div>
            <input
              type="range"
              min={1}
              max={20}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
              className="flex-1 min-w-0 max-w-[120px] accent-primary h-1"
            />
            <span className="text-[10px] text-slate-500 font-mono w-5 tabular-nums flex-shrink-0">{strokeWidth}</span>
          </div>
        </div>

        {/* ── Right: Undo / Redo / Clear ──────────────────────────────── */}
        <div className="flex items-center gap-0.5 px-1 flex-shrink-0">
          <div className="w-px h-7 bg-white/[0.06] self-center mr-1" />
          <ToolbarIconBtn icon="undo" label="Undo" disabled={!canUndo} onClick={onUndo} />
          <ToolbarIconBtn icon="redo" label="Redo" disabled={!canRedo} onClick={onRedo} />
          <ToolbarIconBtn icon="delete_sweep" label="Clear" onClick={onClear} variant="danger" />
        </div>

      </div>

      {/* Color popover (portaled to fixed — parent can have overflow-hidden) */}
      {popover && (
        <div
          ref={colorPopoverRef}
          data-style-controls=""
          className="fixed z-[100] glass-refractive rounded-xl p-2 flex items-center gap-1.5"
          style={{ left: popover.left, top: popover.top, transform: 'translate(-50%, -100%)', fontFamily: 'Manrope, sans-serif' }}
        >
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setColor(c); setPopover(null) }}
              className="relative flex-shrink-0 transition-all hover:scale-110"
              title={c}
            >
              <div
                className={`w-5 h-5 rounded-full border-2 transition-all ${
                  color === c ? 'border-white scale-125 shadow-[0_0_8px_rgba(255,255,255,0.3)]' : 'border-transparent hover:border-white/30'
                }`}
                style={{ background: c }}
              />
            </button>
          ))}
          <div className="w-px h-5 bg-white/10 mx-0.5" />
          <label className="relative w-5 h-5 flex-shrink-0 cursor-pointer group" title="Custom color">
            <div className="w-5 h-5 rounded-full border-2 border-dashed border-white/30 group-hover:border-white/60 transition-colors flex items-center justify-center overflow-hidden">
              <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(red, yellow, lime, cyan, blue, magenta, red)` }} />
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
          </label>
        </div>
      )}
    </div>
  )
}

function ToolbarIconBtn({
  icon, label, onClick, disabled, variant = 'neutral',
}: {
  icon: string
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'neutral' | 'danger'
}) {
  const color = variant === 'danger'
    ? 'text-slate-400 hover:text-red-400 hover:bg-red-500/10'
    : 'text-slate-400 hover:text-white hover:bg-white/10'
  return (
    <button
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all disabled:opacity-25 disabled:cursor-not-allowed ${color}`}
    >
      <span className="material-symbols-outlined text-[18px]">{icon}</span>
    </button>
  )
}
