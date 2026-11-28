/**
 * Where a capture came from: the app and window title under the captured
 * area, stored on the history row (`HistoryItem.source`) and shown in the
 * Dashboard's list view (2026-11-21).
 *
 * Resolved when the capture is confirmed, from the on-screen windows
 * front-to-back, Lumia's own windows excluded (the overlay and the hidden
 * main window never count, so asking at confirm time sees the same stack
 * the user saw at the hotkey):
 *   - a rect (region, window, recording area): the topmost window holding
 *     the rect's centre, else the topmost one touching the rect;
 *   - a display (monitor, full screen recording): the topmost window on it;
 *   - nothing (all screens): the frontmost window.
 *
 * macOS: the window-at-point helper's "list" query, which names each
 * window's app and title (titles need Screen Recording, which capture
 * already needs). Windows: the z-order walk in native-input, then the
 * title and exe name of the picked window. Elsewhere: no source.
 *
 * Region and screen captures (images and recordings) pass `onlyIfSingle`
 * (2026-11-23): they get a source only when the area shows one window, see
 * single-window.ts; with two or more windows showing they get
 * `{ multiple: true }` ("Region / Multiple"); otherwise (one window plus
 * desktop, or none) the row keeps just its kind.
 *
 * Never throws and never blocks a capture for long: any failure resolves to
 * undefined and the row simply has no source.
 */

import { screen } from 'electron'
import { listMacWindows } from './mac-window-pick'
import { getWindowSourceInfo, listTopLevelWindowsPhysical } from './native-input'
import type { CaptureSource } from './types'
import { singleWindowIndex, visibleWindowIndices } from './single-window'

interface Rect { x: number; y: number; width: number; height: number }
interface ListedWindow { rect: Rect; hwnd?: unknown; app?: string; title?: string }

/** What was captured, in global screen DIP; or a source known up front
 *  (the browser extension knows its tab). */
export type SourceArea =
  | { rect: Rect }
  | { display: Electron.Display }
  | { source: CaptureSource }
  | null

/** A display-local DIP rect (what the overlays and recording targets use)
 *  as a global one. */
export function globalRect(rect: Rect, displayId: number | null | undefined): Rect {
  const display = screen.getAllDisplays().find(d => d.id === displayId) ?? screen.getPrimaryDisplay()
  return { x: rect.x + display.bounds.x, y: rect.y + display.bounds.y, width: rect.width, height: rect.height }
}

async function listWindows(): Promise<ListedWindow[]> {
  if (process.platform === 'darwin') {
    return (await listMacWindows()).map(w => ({ rect: w, app: w.app, title: w.title }))
  }
  if (process.platform === 'win32') {
    return listTopLevelWindowsPhysical(false).map(w => ({
      rect: screen.screenToDipRect(null as never, { x: w.x, y: w.y, width: w.width, height: w.height }),
      hwnd: w.hwnd,
    }))
  }
  return []
}

const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
const touches = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export async function resolveCaptureSource(
  area: SourceArea,
  opts: { onlyIfSingle?: boolean } = {},
): Promise<CaptureSource | undefined> {
  if (area && 'source' in area) return clean(area.source)
  try {
    const wins = await listWindows()
    if (!wins.length) return undefined
    let pick: ListedWindow | undefined
    if (opts.onlyIfSingle) {
      // A screen counts by its work area (menu bar / taskbar / Dock aside).
      const rect = area && 'rect' in area ? area.rect : area && 'display' in area ? area.display.workArea : null
      if (!rect) return undefined
      const rects = wins.map(w => w.rect)
      // One window filling the area, else the one window that shows in it
      // with desktop around it (2026-11-24: a small window on an empty
      // screen used to get no source).
      let i = singleWindowIndex(rects, rect)
      if (i < 0) {
        const shown = visibleWindowIndices(rects, rect)
        if (shown.length >= 2) return { multiple: true }
        if (shown.length === 0) return undefined
        i = shown[0]
      }
      pick = wins[i]
    } else if (area && 'rect' in area) {
      const cx = area.rect.x + area.rect.width / 2
      const cy = area.rect.y + area.rect.height / 2
      pick = wins.find(w => contains(w.rect, cx, cy)) ?? wins.find(w => touches(w.rect, area.rect))
    } else if (area && 'display' in area) {
      pick = wins.find(w => touches(w.rect, area.display.bounds))
    }
    pick ??= wins[0]
    const info = process.platform === 'win32' && pick.hwnd ? getWindowSourceInfo(pick.hwnd) : { app: pick.app, title: pick.title }
    return clean(info)
  } catch (err) {
    console.warn('[capture-source] lookup failed:', err instanceof Error ? err.message : err)
    return undefined
  }
}

function clean(s: CaptureSource | undefined): CaptureSource | undefined {
  const app = s?.app?.trim() || undefined
  const title = s?.title?.trim() || undefined
  return app || title ? { app, title } : undefined
}
