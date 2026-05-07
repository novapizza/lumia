import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Plant a Start Menu shortcut whose IPropertyStore carries
 * PKEY_AppUserModel_ID = `com.lumia.app`. Without this shortcut on disk,
 * Windows shell has no launcher registered for our AUMID, so toast
 * activations from `pnpm dev` go nowhere — banner and Action Center
 * clicks both silently no-op.
 *
 * The NSIS installer plants this shortcut for packaged builds (with the
 * AUMID embedded by electron-builder), so this helper is a no-op there.
 *
 * The shortcut points at the dev-mode Electron binary + project root, so
 * a toast click triggers a fresh `electron.exe <project>` which our
 * single-instance lock denies → fires `app.on('second-instance')` on the
 * running dev process. From that handler we replay the latched
 * notification click.
 */
export function ensureDevStartMenuShortcut(): void {
  if (process.platform !== 'win32' || app.isPackaged) return

  const startMenu = join(
    app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs'
  )
  const shortcutPath = join(startMenu, 'Lumia (dev).lnk')
  const targetPath = process.execPath
  const projectRoot = app.getAppPath()
  const scriptPath = join(projectRoot, 'electron', 'dev-shortcut.ps1')

  if (!existsSync(scriptPath)) {
    console.warn('[dev-shortcut] script missing, skipping:', scriptPath)
    return
  }

  // PowerShell parses the arg string verbatim; quote-wrapping the project
  // root is what `electron.exe` will see when the user clicks the shortcut,
  // so it tolerates spaces in the path.
  const electronArgs = `"${projectRoot}"`

  const psArgs = [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-NonInteractive',
    '-File', scriptPath,
    '-ShortcutPath', shortcutPath,
    '-TargetPath', targetPath,
    '-Arguments', electronArgs,
    '-WorkingDirectory', projectRoot,
    // Distinct from the packaged AUMID `com.lumia.app` so an
    // installed-side-by-side production build doesn't claim toast
    // activations meant for this dev process.
    '-AppId', 'com.lumia.app.dev',
  ]

  const proc = spawn('powershell.exe', psArgs, { windowsHide: true })
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.on('error', err => console.error('[dev-shortcut] spawn failed:', err))
  proc.on('close', code => {
    if (code !== 0) {
      console.error(`[dev-shortcut] PowerShell exited ${code}:`, stderr.trim())
    }
  })
}
