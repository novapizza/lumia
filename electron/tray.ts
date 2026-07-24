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
    // Assets ship at their display sizes (generate-icons.cjs): win 32×32
    // full-bleed; mac 22×22 base + tray-icon@2x.png alongside it, which
    // createFromPath auto-loads as the Retina representation. No resize()
    // here — resize flattens the image to a single representation, dropping
    // the @2x rep and leaving the menu bar icon pixelated on Retina.
    icon = nativeImage.createFromPath(trayIconPath)
    if (icon.isEmpty()) {
      // Fall back to an empty icon (same as the catch branch) but STILL create
      // the Tray — returning here would leave the app with no tray, which is
      // unrecoverable since close-hides-to-tray.
      console.error('Could not load tray icon.')
      icon = nativeImage.createEmpty()
    } else if (isMac) {
      // Template image: macOS renders the alpha silhouette in the menu bar's
      // foreground color, adapting to light/dark mode automatically.
      icon.setTemplateImage(true)
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
