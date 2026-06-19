import { app } from 'electron'
import { spawn } from 'child_process'
import log from 'electron-log'

const HIDDEN_FLAG = '--hidden'
// Force the HKCU\...\Run value name on Windows. Without this, Electron defaults
// to the AUMID (`com.lumia.app`), which collides with `cleanupStaleWindowsRunEntries`
// below — that script preserves only the literal `Lumia` entry and was wiping
// the AUMID-named one Electron had just written, leaving autostart silently broken.
const WIN_RUN_ENTRY_NAME = 'Lumia'

export function applyLaunchAtStartup(enabled: boolean) {
  log.info('[startup] applyLaunchAtStartup called', {
    enabled,
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath
  })
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    log.info('[startup] applyLaunchAtStartup: unsupported platform, skipping')
    return
  }
  // In dev, skip — the entry would point at Electron's dev shell, not Lumia.
  if (!app.isPackaged) {
    log.info('[startup] applyLaunchAtStartup: dev build, skipping')
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: [HIDDEN_FLAG],
    ...(process.platform === 'win32' ? { name: WIN_RUN_ENTRY_NAME } : {})
  })
  // Read back what the OS actually stored — diverges from `enabled` when an
  // external policy (Task Manager Startup-tab toggle, Group Policy, third-party
  // startup manager) overrides our write, or when setLoginItemSettings silently
  // no-ops.
  const after = process.platform === 'win32'
    ? app.getLoginItemSettings({ args: [HIDDEN_FLAG], path: process.execPath })
    : app.getLoginItemSettings()
  log.info('[startup] setLoginItemSettings done, OS readback', after)
  if (process.platform === 'win32') {
    void cleanupStaleWindowsRunEntries()
  }
}

export function wasLaunchedAtStartup(): boolean {
  let result = false
  if (process.platform === 'darwin') {
    result = app.getLoginItemSettings().wasOpenedAtLogin
  } else if (process.platform === 'win32') {
    result = process.argv.includes(HIDDEN_FLAG)
  }
  log.info('[startup] wasLaunchedAtStartup', {
    result,
    platform: process.platform,
    argv: process.argv
  })
  return result
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
      "if (-not $key) { Write-Output 'NO_RUN_KEY'; exit 0 }",
      "foreach ($name in $key.GetValueNames()) {",
      "  $val = [string]$key.GetValue($name);",
      "  Write-Output (\"SEEN|\" + $name + \"|\" + $val);",
      "  if ($name -eq '" + WIN_RUN_ENTRY_NAME + "') { Write-Output (\"KEEP|\" + $name); continue }",
      "  if ($val -and $val.ToLower().Contains($exe.ToLower())) {",
      "    Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue;",
      "    Write-Output (\"REMOVED|\" + $name);",
      "  }",
      "}"
    ].join(' ')
    log.info('[startup] cleanupStaleWindowsRunEntries: spawning PowerShell', { exe })
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', err => {
      log.warn('[startup] cleanup PowerShell spawn error', err)
      resolve()
    })
    child.on('close', code => {
      log.info('[startup] cleanup PowerShell finished', {
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      })
      resolve()
    })
  })
}
