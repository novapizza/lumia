import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import { getMainWindow, markQuitting } from './index'
import { dispatchLastCapture } from './capture'

let tray: Tray | null = null

export function setupTray() {
  const isMac = process.platform === 'darwin'
  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, `tray/${isMac ? 'mac' : 'win'}/tray-icon.png`)
    : join(__dirname, `../../resources/tray/${isMac ? 'mac' : 'win'}/tray-icon.png`)
  let icon: Electron.NativeImage


  try {
    icon = nativeImage.createFromPath(trayIconPath)
    if (icon.isEmpty()) {
      // Fall back to an empty icon (same as the catch branch) but STILL create
      // the Tray — returning here would leave the app with no tray, which is
      // unrecoverable since close-hides-to-tray.
      console.error('Could not load tray icon.')
      icon = nativeImage.createEmpty()
    } else if (isMac) {
      // macOS menu bar icons should be 22x22 points (44x44 px @2x Retina)
      // Resize to 22x22 so Electron treats it as 22pt, not 44pt
      icon = icon.resize({ width: 22, height: 22 })
      icon.setTemplateImage(true)
    } else {
      icon = icon.resize({ width: 32, height: 32 })
    }
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Lumia')
  tray.setContextMenu(buildMenu())

  tray.on('double-click', () => {
    const win = getMainWindow()
    if (win) { win.show(); win.focus() }
  })
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Lumia', enabled: false },
    { type: 'separator' },
    { label: 'New Capture', click: () => { void dispatchLastCapture() } },
    { type: 'separator' },
    {
      label: 'Open Lumia',
      click: () => {
        const win = getMainWindow()
        if (win) { win.show(); win.focus() }
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { markQuitting(); app.quit() } }
  ])
}

export function destroyTray() {
  tray?.destroy()
  tray = null
}
