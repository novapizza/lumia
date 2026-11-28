import { app, type BrowserWindow } from 'electron'
import { join } from 'path'

/** Load one of the renderer's hash routes into a window: the dev server
 *  while developing, the built page otherwise. For the recording windows
 *  and the live drawing layer (video.ts and annotation.ts each had a copy). */
export function loadRoute(win: BrowserWindow, route: string): void {
  if (!app.isPackaged) {
    win.loadURL(`http://localhost:5173/#${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  }
}
