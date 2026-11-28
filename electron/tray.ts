import { dockTrace } from './dock-trace'
import { Tray, Menu, nativeImage, app, screen } from 'electron'
import { join } from 'path'
import { getMainWindow, markQuitting, isDockIconHidden } from './index'
import { listMacWindows } from './mac-window-pick'
import { dispatchLastCapture } from './capture'
import { getHotkeys, runCaptureAction } from './hotkeys'
import { getSettings } from './settings'
import { isRecordingActive, requestStop as requestVideoStop } from './video'

let tray: Tray | null = null

export function setupTray() {
  const isMac = process.platform === 'darwin'
  // Dev builds use resources/tray-dev/ (same icon with a "D" badge, made by
  // scripts/make-dev-tray-icons.py) so a dev instance is easy to tell apart
  // from the installed app. tray-dev/ is not in extraResources, so it never ships.
  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, `tray/${isMac ? 'mac' : 'win'}/tray-icon.png`)
    : join(__dirname, `../../resources/tray-dev/${isMac ? 'mac' : 'win'}/tray-icon.png`)
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
  tray.setToolTip(app.isPackaged ? 'Lumia' : 'Lumia (dev)')
  // Built at every open (2026-11-27): it follows Settings › General › Menu
  // bar, the hotkeys shown beside the items, and whether a recording runs.
  if (isMac) {
    // Opened by hand (2026-11-24): over a full-screen app, macOS shows the
    // menu of an app with a Dock icon on that app's own desktop, so the icon
    // only highlighted. While a full-screen app shows, Lumia is a menu-bar
    // app (no Dock icon) for as long as the menu is open.
    const open = async () => {
      const menu = buildMenu()
      const switchPolicy = !isDockIconHidden() && await fullScreenAppShowing()
      if (switchPolicy) {
        // The same switch as closing the window to the menu bar (dock.hide),
        // which is the case that worked. No pause before the menu (a 120ms
        // one made the icon's highlight flash, 2026-11-24).
        dockTrace('tray menu over a full-screen app: app.dock.hide()')
        app.dock?.hide()
        menu.once('menu-will-close', () => { if (!isDockIconHidden()) { dockTrace("tray menu closed: setActivationPolicy('regular')"); app.setActivationPolicy('regular') } })
      }
      tray?.popUpContextMenu(menu)
    }
    tray.on('click', () => { void open() })
    tray.on('right-click', () => { void open() })
  } else {
    // By hand on Windows too, so it's built at the open (a set context menu
    // is fixed until it's replaced).
    tray.on('right-click', () => { tray?.popUpContextMenu(buildMenu()) })
  }

  tray.on('double-click', () => {
    const win = getMainWindow()
    if (win) { win.show(); win.focus() }
  })
}

/** Is a full-screen app showing on any display? A window covers the whole
 *  display (no menu bar), with only windows of the same app in front of it
 *  (a full-screen Safari has its slide-down toolbar as a separate window in
 *  front, 2026-11-24). */
async function fullScreenAppShowing(): Promise<boolean> {
  const wins = await listMacWindows()
  return screen.getAllDisplays().some(d => {
    const b = d.bounds
    const onDisplay = wins.filter(w => (w.layer ?? 0) === 0 &&
      w.x < b.x + b.width && w.x + w.width > b.x && w.y < b.y + b.height && w.y + w.height > b.y)
    const app = onDisplay[0]?.app
    for (const w of onDisplay) {
      if (w.app !== app) return false
      if (Math.abs(w.x - b.x) <= 1 && Math.abs(w.y - b.y) <= 1 &&
          Math.abs(w.width - b.width) <= 1 && Math.abs(w.height - b.height) <= 1) return true
    }
    return false
  })
}

/** The capture actions the menu can carry (a switch per row in Settings › Hotkeys,
 *  `trayActions`), in Settings › Hotkeys' order and with its names. */
export const TRAY_ACTIONS: { action: string; label: string; video?: boolean }[] = [
  { action: 'RectangleRegion', label: 'Capture region' },
  { action: 'ActiveWindow', label: 'Capture window' },
  { action: 'ActiveMonitor', label: 'Capture full screen' },
  { action: 'PrintScreen', label: 'Capture all screens' },
  { action: 'ScrollingCapture', label: 'Capture scroll' },
  { action: 'ScreenRecorder', label: 'Record region', video: true },
  { action: 'ScreenRecorderWindow', label: 'Record window', video: true },
  { action: 'ScreenRecorderScreen', label: 'Record screen', video: true },
]

function buildMenu() {
  // New capture / New recording by the last kind (2026-11-27, "New
  // Capture" before: "capture" is images only, record is videos), then the
  // picked actions with their hotkeys shown (not
  // registered: the global shortcut does that). While recording, the record
  // items give way to one Stop recording; a top "New recording" is that
  // Stop recording (2026-11-27: it stayed "New recording" and did nothing,
  // and with no record action picked the menu had no Stop at all). No
  // "Lumia" heading (2026-11-27): the icon says whose menu it is.
  const picked = new Set(getSettings().trayActions ?? [])
  const hotkeys = getHotkeys()
  const recording = isRecordingActive()
  const lastIsVideo = getSettings().lastCaptureKind === 'video'
  const items: Electron.MenuItemConstructorOptions[] = [
    recording && lastIsVideo
      ? { label: 'Stop recording', click: () => requestVideoStop() }
      : {
          label: lastIsVideo ? 'New recording' : 'New capture',
          click: () => { dispatchLastCapture().catch(err => console.error('[tray] capture failed', err)) }
        },
  ]
  let stopShown = recording && lastIsVideo
  for (const { action, label, video } of TRAY_ACTIONS) {
    if (!picked.has(action)) continue
    if (video && recording) {
      if (!stopShown) items.push({ label: 'Stop recording', click: () => requestVideoStop() })
      stopShown = true
      continue
    }
    const key = hotkeys[action]
    items.push({
      label,
      ...(key ? { accelerator: key, registerAccelerator: false } : {}),
      click: () => runCaptureAction(action),
    })
  }
  // An image captured during the recording makes the top item New capture;
  // the recording still needs its Stop even with no record action picked.
  if (recording && !stopShown) items.push({ label: 'Stop recording', click: () => requestVideoStop() })
  return Menu.buildFromTemplate([
    ...items,
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
