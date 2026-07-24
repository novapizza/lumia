/**
 * macOS counterpart to Win32's getWindowAtPointPhysical.
 *
 * Spawns a long-running Swift helper (`electron/helpers/window-at-point`) and
 * speaks line-delimited JSON over its stdio. The helper queries CoreGraphics'
 * CGWindowListCopyWindowInfo, which is fast enough to drive the overlay's
 * 80 ms hover poll without per-call execFile cold-start overhead.
 *
 * The helper is lazy-spawned on first call and lives until the app exits.
 * If it dies, the next call respawns it.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import readline from 'readline'

export interface WindowRect { x: number; y: number; width: number; height: number }

let proc: ChildProcessWithoutNullStreams | null = null

// Each pending query is { resolve } awaiting one stdout line. Lines arrive in
// the same order writes are sent (the helper is single-threaded), so a FIFO
// queue is enough to pair them up.
type LineHandler = (line: string) => void
let lineQueue: LineHandler[] = []

// Latest pending request — if a new query arrives while another is in flight,
// we drop the older request. Keeps the overlay highlight glued to the current
// cursor position even if the helper momentarily lags.
let pendingRequest: { x: number; y: number; resolve: (rect: WindowRect | null) => void } | null = null
let busy = false

function getBinaryPath(): string | null {
  // Dev: <project>/electron/helpers/window-at-point (resolved relative to out/main)
  const devPath = resolve(__dirname, '..', '..', 'electron', 'helpers', 'window-at-point')
  if (existsSync(devPath)) return devPath

  // Prod: bundled via electron-builder extraResources → Contents/Resources/window-at-point
  const prodPath = join(process.resourcesPath ?? app.getAppPath(), 'window-at-point')
  if (existsSync(prodPath)) return prodPath

  return null
}

function startHelper(): boolean {
  if (proc) return true
  if (process.platform !== 'darwin') return false
  const bin = getBinaryPath()
  if (!bin) {
    console.warn('[mac-window-pick] window-at-point binary not found — pick mode will return null')
    return false
  }

  try {
    proc = spawn(bin, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    console.error('[mac-window-pick] failed to spawn helper:', err)
    proc = null
    return false
  }

  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line: string) => {
    const handler = lineQueue.shift()
    if (handler) handler(line)
  })

  proc.stderr.on('data', chunk => {
    console.warn('[mac-window-pick] stderr:', chunk.toString().trim())
  })

  // Capture the child this handler belongs to. The write-failure path in
  // pump() can synchronously kill + null `proc` and a fresh helper may spawn
  // before this child's 'exit' fires; without the identity guard, cleanup
  // would then null the NEW proc, orphaning the live child and triggering a
  // respawn. Bail unless the module-level proc is still the one we registered.
  const p = proc
  const cleanup = () => {
    if (proc !== p) return
    proc = null
    // Resolve any outstanding handlers as null so callers don't hang.
    for (const h of lineQueue) h('null')
    lineQueue = []
    busy = false
    if (pendingRequest) {
      pendingRequest.resolve(null)
      pendingRequest = null
    }
  }
  p.on('exit', cleanup)
  p.on('error', err => {
    console.error('[mac-window-pick] helper error:', err)
    cleanup()
  })

  return true
}

function pump(): void {
  if (busy || !pendingRequest || !proc) return
  const { x, y, resolve } = pendingRequest
  pendingRequest = null
  busy = true

  lineQueue.push((line: string) => {
    busy = false
    let rect: WindowRect | null = null
    if (line && line !== 'null') {
      try {
        const obj = JSON.parse(line)
        if (typeof obj.x === 'number' && typeof obj.y === 'number' &&
            typeof obj.width === 'number' && typeof obj.height === 'number') {
          rect = { x: obj.x, y: obj.y, width: obj.width, height: obj.height }
        }
      } catch { /* swallow — malformed line, treat as null */ }
    }
    resolve(rect)
    pump()
  })

  try {
    proc.stdin.write(`${x} ${y}\n`)
  } catch (err) {
    // Write failed — treat the just-queued handler as resolved-null and kill
    // the proc so the next call respawns.
    busy = false
    const handler = lineQueue.pop()
    handler?.('null')
    try { proc.kill() } catch { /* */ }
    proc = null
  }
}

/** Spawn the helper ahead of first use so the first window-pick hotkey after
 *  launch doesn't pay the process spawn on its critical path. Fire-and-forget
 *  from app.whenReady(); no-op off macOS (startHelper platform-gates). */
export function prewarmMacWindowPick(): void {
  startHelper()
}

/**
 * Query the topmost non-Lumia window at (x, y) in macOS screen-DIP / points
 * (top-left origin). Returns the window's bounds in the same coord space, or
 * null if there's no match (or the helper is unavailable).
 */
export function getMacWindowAtPoint(x: number, y: number): Promise<WindowRect | null> {
  return new Promise<WindowRect | null>(res => {
    if (!startHelper() || !proc) {
      res(null)
      return
    }

    // Drop any older pending request — caller only cares about the latest cursor pos.
    if (pendingRequest) {
      pendingRequest.resolve(null)
    }
    pendingRequest = { x, y, resolve: res }
    pump()
  })
}

/**
 * Enumerate all eligible on-screen windows (same filters as the point query),
 * front-to-back — the first entry is the frontmost (≈ active) window. Bounds
 * are in macOS screen-DIP / points, top-left origin.
 *
 * Bypasses the drop-latest pendingRequest slot: this is a one-shot query, not
 * hover polling, so it must never be discarded in favor of a newer hover
 * request. Handler push + stdin write happen synchronously together, so FIFO
 * line pairing with in-flight point queries stays correct. An older helper
 * binary that predates "list" replies "null" → resolves to [].
 */
export function listMacWindows(): Promise<WindowRect[]> {
  return new Promise<WindowRect[]>(res => {
    if (!startHelper() || !proc) {
      res([])
      return
    }

    lineQueue.push((line: string) => {
      try {
        const arr = JSON.parse(line)
        if (!Array.isArray(arr)) { res([]); return }
        res(arr.filter((o): o is WindowRect =>
          o && typeof o.x === 'number' && typeof o.y === 'number' &&
          typeof o.width === 'number' && typeof o.height === 'number'
        ))
      } catch {
        res([])
      }
    })

    try {
      proc.stdin.write('list\n')
    } catch {
      const handler = lineQueue.pop()
      handler?.('null')
      try { proc.kill() } catch { /* */ }
      proc = null
    }
  })
}
