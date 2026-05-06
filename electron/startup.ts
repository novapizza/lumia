import { app } from 'electron'
import { spawn } from 'child_process'

const HIDDEN_FLAG = '--hidden'

export function applyLaunchAtStartup(enabled: boolean) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  // In dev, skip — the entry would point at Electron's dev shell, not Lumia.
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: [HIDDEN_FLAG]
  })
  if (process.platform === 'win32') {
    void cleanupStaleWindowsRunEntries()
  }
}

export function wasLaunchedAtStartup(): boolean {
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAtLogin
  }
  if (process.platform === 'win32') {
    return process.argv.includes(HIDDEN_FLAG)
  }
  return false
}

// Older Lumia builds left a `com.lumia.app` entry in HKCU\...\Run alongside
// the `Lumia` entry that Electron now manages. Both fire at boot, spawning
// two Lumia.exe processes — the second hits the single-instance lock and
// surfaces the window via `second-instance`. Strip any non-`Lumia` Run entry
// that points at our executable so future boots only fire once.
function cleanupStaleWindowsRunEntries(): Promise<void> {
  return new Promise(resolve => {
    const exe = process.execPath
    const ps = [
      "$exe = '" + exe.replace(/'/g, "''") + "';",
      "$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';",
      "$key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue;",
      "if (-not $key) { exit 0 }",
      "foreach ($name in $key.GetValueNames()) {",
      "  if ($name -eq 'Lumia') { continue }",
      "  $val = [string]$key.GetValue($name);",
      "  if ($val -and $val.ToLower().Contains($exe.ToLower())) {",
      "    Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue;",
      "  }",
      "}"
    ].join(' ')
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps
    ], { windowsHide: true })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}
