import { execFile } from 'child_process'

// macOS: which app is on the other end of a localhost socket. The browser
// extension names its browser from the user-agent brands, which Arc (and
// other Chromium browsers) don't list, so Arc reported itself as "Chrome"
// and the focus assist activated (launched) Google Chrome mid-capture, which
// made the extension cancel. The socket's peer process can't lie: it's a
// helper inside the real browser's bundle. No Electron imports (unit-tested).

/** The outermost `.app` in a process path, as an app name for AppleScript
 *  ("Arc", "Google Chrome"); null when the process isn't inside an app. */
export function appNameFromProcessPath(path: string): string | null {
  const m = /^(.*?)\.app\//.exec(path)
  if (!m) return null
  const name = m[1].slice(m[1].lastIndexOf('/') + 1)
  return name || null
}

/** From `lsof -Fp` output for one connection (both ends are listed), the
 *  PID that isn't ours. */
export function peerPidFromLsof(output: string, ownPid: number): number | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith('p')) continue
    const pid = Number(line.slice(1))
    if (Number.isInteger(pid) && pid !== ownPid) return pid
  }
  return null
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** The app owning the client end of a connection to us whose client port is
 *  `peerPort` (macOS only; null when it can't be found). ~30 ms. */
export async function macAppForPeerPort(peerPort: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const lsof = await run('lsof', ['-nP', `-iTCP@127.0.0.1:${peerPort}`, '-sTCP:ESTABLISHED', '-Fp'])
  const pid = peerPidFromLsof(lsof, process.pid)
  if (pid == null) return null
  const path = (await run('ps', ['-o', 'comm=', '-p', String(pid)])).trim()
  return appNameFromProcessPath(path)
}
