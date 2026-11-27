import { useEffect, useState } from 'react'

/** Role colours read from the theme's CSS variables (index.css, a custom
 *  theme's <style id="lumia-theme">), for things drawn outside CSS: the
 *  annotation canvas's selection frame and delete handle (Konva can't take
 *  Tailwind classes). Re-read when the theme changes: the <html> class
 *  (light / dark) or the custom theme's style element. */
export function useRoleColors<K extends string>(names: readonly K[]): Record<K, string> {
  const read = () => {
    const cs = getComputedStyle(document.documentElement)
    return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(`--color-${n}`).trim()])) as Record<K, string>
  }
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const update = () => setColors(prev => {
      const next = read()
      return names.every(n => prev[n] === next[n]) ? prev : next
    })
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    mo.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
    // names is a constant list at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A role added to the list after the first read (a hot reload keeps the
  // old state) would come back undefined and draw nothing: read it now.
  return names.every(n => n in colors) ? colors : read()
}
