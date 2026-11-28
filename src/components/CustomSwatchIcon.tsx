import { Icon } from './Icon'
import { isLight } from '../lib/is-light'

/** The icon on every Custom swatch (2026-11-25: the image toolbar, Settings'
 *  colour rows, the Background panel):
 *  - `add`: no custom colour yet, a grey + on the elevated fill;
 *  - `edit`: a custom colour that isn't in use, a pencil on it (a click
 *    takes it back);
 *  - `clear`: the custom colour is in use, an × on it (a click clears it).
 *  Pencil and × in black or white, whichever reads on `on`, their line set
 *  by that ground, not the theme (dark ink gets the 0.35px boost). 12px:
 *  smaller than the four icon sizes, the 24px swatch's exception. */
export function CustomSwatchIcon({ state, on }: { state: 'add' | 'edit' | 'clear'; on?: string }) {
  if (state === 'add') return <Icon name="add" className="text-[14px] text-fg-secondary" />
  return (
    <Icon
      name={state === 'clear' ? 'close' : 'pencil'}
      className={`text-[12px] ${on && isLight(on)
        ? 'text-black [--icon-line:var(--icon-stroke-sm-dark-ink)]'
        : 'text-white [--icon-line:var(--icon-stroke-sm)]'}`}
    />
  )
}
