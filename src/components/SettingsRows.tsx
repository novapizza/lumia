import type { ReactNode } from 'react'
import { Icon } from './Icon'

/* The Settings page's row kit (moved out of Settings.tsx 2026-11-25 so the
   Workflow page shares it): a flat group of rows, a row, a framed select, the on / off toggle
   (also in the editor's Background panel). */

/** One flat block of rows on the toolbar layer, like a list-view row:
 *  rounded-lg, line edge, rows split by line-subtle. */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  const rows = <div className="rounded-lg bg-toolbar border border-line divide-y divide-line-subtle">{children}</div>
  if (!title) return rows
  // A caption over the rows (Settings › General's subgroups, 2026-11-27),
  // drawn like the Hotkeys groups' captions without their fold.
  return (
    <div>
      <p className="mb-1.5 px-1 text-xs font-medium text-fg-secondary">{title}</p>
      {rows}
    </div>
  )
}

/** A setting: label (and a line of description) left, its control right.
 *  Labels start with a verb, what the row does: "Open at login", "Delete
 *  old captures" (Jasper, 2026-11-22). */
export function Row({ label, description, children }: { label: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-h-[50px] px-3 py-2.5 flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-fg">{label}</p>
        {/* 4px under the label, 2px more room below (2026-11-24; 2px / 0). */}
        {description && <div className="mt-1 mb-0.5 text-[10px] font-medium text-fg-secondary">{description}</div>}
      </div>
      {children}
    </div>
  )
}

/** A native select drawn as a framed button with a chevron. */
export function Select<V extends string | number>({ value, onChange, options, label, placeholder }: {
  value: V | ''
  onChange: (next: V) => void
  options: { value: V; label: string }[]
  label: string
  /** Shown while `value` is '' (an action picker like the Workflow page's
   *  "Add step"; the select then goes back to it after each pick). */
  placeholder?: string
}) {
  return (
    <div className="group/sel relative flex-shrink-0">
      <select
        value={value}
        aria-label={label}
        onChange={e => {
          const picked = options.find(o => String(o.value) === e.target.value)
          if (picked) onChange(picked.value)
        }}
        className="appearance-none h-8 pl-2.5 pr-7 rounded-lg bg-elevated border border-line text-xs font-medium text-fg-secondary hover:bg-elevated-hover hover:text-fg"
      >
        {placeholder !== undefined && <option value="" disabled hidden>{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="expand_more" className="absolute right-2 top-1/2 -translate-y-1/2 text-[16px] text-fg-secondary group-hover/sel:text-fg pointer-events-none" />
    </div>
  )
}

/** On / off switch (replaces the native checkboxes, 2026-11-22). Off: an
 *  elevated track with a grey knob; on: the accent track with a white knob.
 *  No slide: the knob jumps (no motion in the UI). */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      // The same see-through edge in both states, the fill clipped inside
      // it (bg-clip-padding), so on and off are the same size (2026-11-22:
      // an accent border merged with the fill and the on switch looked 1px
      // bigger all round).
      className={`group/tog relative w-[30px] h-[18px] rounded-full border border-line-strong bg-clip-padding flex-shrink-0 ${
        checked ? 'bg-accent hover:bg-accent-hover' : 'bg-elevated hover:bg-elevated-hover'
      }`}
    >
      <span
        // The knob slides (Jasper, 2026-11-22: one of the named animations;
        // only its position, colours stay instant; 160ms ease-out like the
        // Segmented pill, off under reduced motion).
        className={`absolute top-[2px] w-3 h-3 rounded-full transition-[left] duration-[160ms] ease-out motion-reduce:transition-none ${
          // Off knob: --toggle-knob-off / -hover (index.css), one step
          // lighter in light mode (2026-11-24).
          checked ? 'left-[14px] bg-on-accent' : 'left-[2px] bg-(--toggle-knob-off) group-hover/tog:bg-(--toggle-knob-off-hover)'
        }`}
      />
    </button>
  )
}
