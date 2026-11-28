import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A spot in the AppBar a page can fill with its own controls (the
 *  Dashboard's filters, the editor's file actions). The AppBar hands its
 *  slot element to the provider; a page renders <AppBarControls> and its
 *  children are portalled there. Pages that don't use it leave the slot
 *  empty. (A second, lead slot after the logo held the editor's Back for a
 *  day, 2026-11-23; removed when Back took the gear's place.) */
const SlotContext = createContext<{
  el: HTMLElement | null
  setEl: (el: HTMLElement | null) => void
  closeTo: string | null
  setCloseTo: (to: string | null) => void
  /** The history row the pop-over shows, so Settings opened from it can
   *  reopen it on close (2026-11-23). */
  returnId: string | null
  setReturnId: (id: string | null) => void
}>({
  el: null,
  setEl: () => {},
  closeTo: null,
  setCloseTo: () => {},
  returnId: null,
  setReturnId: () => {},
})

export function AppBarSlotProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [closeTo, setCloseTo] = useState<string | null>(null)
  const [returnId, setReturnId] = useState<string | null>(null)
  return <SlotContext.Provider value={{ el, setEl, closeTo, setCloseTo, returnId, setReturnId }}>{children}</SlotContext.Provider>
}

/** A page shown as a pop-over (the editor, 2026-11-23) adds a Back arrow
 *  leading to `to` at the start of the AppBar's right side, while it's
 *  mounted. The Settings gear stays. */
export function useAppBarClose(to: string | null, returnId: string | null = null) {
  const { setCloseTo, setReturnId } = useContext(SlotContext)
  useEffect(() => {
    setCloseTo(to)
    return () => setCloseTo(null)
  }, [to, setCloseTo])
  useEffect(() => {
    setReturnId(returnId)
    return () => setReturnId(null)
  }, [returnId, setReturnId])
}

/** The AppBar's side: the history row Settings should return to, if any. */
export function useAppBarReturnId() {
  return useContext(SlotContext).returnId
}

/** The AppBar's side: where its Back arrow leads, or null for none. */
export function useAppBarCloseTo() {
  return useContext(SlotContext).closeTo
}

/** The AppBar's side: pass as `ref` on the slot element. */
export function useAppBarSlotRef() {
  return useContext(SlotContext).setEl
}

/** A page's side: renders its children into the AppBar slot. */
export function AppBarControls({ children }: { children: ReactNode }) {
  const { el } = useContext(SlotContext)
  return el ? createPortal(children, el) : null
}
