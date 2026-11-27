import { useCallback, useEffect, useRef, useState } from 'react'
import { CustomSwatchIcon } from './CustomSwatchIcon'
import { ColorPicker } from './ColorPicker'
import { swatchClass, swatchFill, SWATCH_ROW } from '../lib/swatch'
import type { PickerKind } from '../../shared/theme-colors'

/** A row of colour swatches for Settings › Appearance (custom themes,
 *  design/CUSTOM-THEMES.md): the default (`null`) first, then the presets,
 *  then Custom (our own picker, ColorPicker: only colours that can be had).
 *  `value` is the raw pick as saved;
 *  every swatch shows its colour through `clamp`, so a Custom pick outside
 *  its band shows what the theme will really use. The selected swatch gets
 *  an accent ring (the changed-from-default dot was dropped, 2026-11-22:
 *  the Reset button already says it). */
export function ColorSwatches({ kind, value, defaultColor, presets, onChange, onPreview, clamp, label }: {
  /** Which band the Custom picker shows. */
  kind: PickerKind
  value: string | null
  /** The colour the default swatch is drawn in (today's value). */
  defaultColor: string
  presets: { value: string; name: string }[]
  onChange: (next: string | null) => void
  /** The Custom picker being dragged: restyle live, don't save. */
  onPreview: (hex: string) => void
  clamp: (hex: string) => string
  /** What the row picks, for the aria labels ("accent"). */
  label: string
}) {
  // While the picker is open, Custom is the selected swatch and shows the
  // picker's colour live (2026-11-22: a click on + takes the row to Custom
  // at once, on the colour the picker opens on, and saves it).
  const [draft, setDraft] = useState<string | null>(null)
  const closePicker = useCallback(() => setDraft(null), [])
  const current = value?.toLowerCase() ?? null
  const pickerOpen = draft !== null
  const isCustom = pickerOpen || (current !== null && !presets.some(p => p.value === current))
  // The last Default / preset value in use, for the Custom swatch's clear.
  const lastPresetRef = useRef<string | null>(isCustom ? null : current)
  useEffect(() => { if (!isCustom) lastPresetRef.current = current }, [isCustom, current])
  const openPicker = () => {
    if (pickerOpen) return
    const start = current !== null ? clamp(current) : clamp(defaultColor)
    setDraft(start)
    if (start !== current) onChange(start)
  }

  const swatch = (key: string, color: string, selected: boolean, name: string, onClick: () => void, children?: React.ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      data-tip={name}
      aria-label={`${name} ${label}`}
      aria-pressed={selected}
      // The one swatch look (lib/swatch.ts), on the row's toolbar ground.
      className={swatchClass(selected)}
      style={{ background: swatchFill(color) }}
    >
      {children}
    </button>
  )

  return (
    <div className={`${SWATCH_ROW} relative flex-shrink-0`}>
      {swatch('default', defaultColor, !pickerOpen && current === null, 'Default', () => onChange(null))}
      {presets.map(p => swatch(p.value, clamp(p.value), !pickerOpen && current === p.value, p.name, () => onChange(p.value)))}
      {swatch(
        'custom',
        draft ?? (isCustom ? clamp(current!) : 'var(--color-elevated)'),
        isCustom,
        isCustom ? 'Clear' : 'Custom',
        isCustom ? () => { closePicker(); onChange(lastPresetRef.current) } : openPicker,
        // + until a custom colour is in use, then × (2026-11-25, every
        // Custom swatch): a click clears it, back to the swatch in use
        // before it (Default when there was none).
        <CustomSwatchIcon state={isCustom ? 'clear' : 'add'} on={isCustom ? draft ?? clamp(current!) : undefined} />,
      )}
      {pickerOpen && (
        <ColorPicker
          kind={kind}
          initial={draft}
          onPreview={hex => { setDraft(hex); onPreview(hex) }}
          onPick={onChange}
          onClose={closePicker}
          label={label}
        />
      )}
    </div>
  )
}
