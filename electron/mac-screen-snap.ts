/**
 * macOS counterpart to native-screen.ts's Windows GDI fast path.
 *
 * Spawns a long-running Swift helper (`electron/helpers/screen-snap`) backed by
 * ScreenCaptureKit's SCScreenshotManager (macOS 14+) and speaks a line-based
 * control protocol on stdin. Replies are mixed text/binary: `ok <w> <h> <n>\n`
 * followed by exactly n bytes of raw BGRA pixels, or `err <reason>\n`.
 *
 * Why not desktopCapturer: on macOS 14/15 every getSources() call spins up a
 * fresh ScreenCaptureKit session and re-enumerates SCShareableContent, costing
 * 1–3 s at full display resolution — the dominant share of hotkey→overlay
 * latency. The helper enumerates content once (prewarmed at app start and on
 * display-config changes), keeps it cached, and a snap is then a single warm
 * captureImage call (~50–200 ms).
 *
 * Every failure mode (helper missing, macOS < 14, Screen Recording denied,
 * timeout, helper crash) resolves to null so callers fall back to
 * desktopCapturer. `err unsupported` latches a permanent disable so macOS ≤ 13
 * hosts don't pay a spawn attempt on every capture.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { app, nativeImage, screen } from 'electron'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import type { NativeCapture } from './native-screen'

interface SnapReply { width: number; height: number; data: Buffer }

interface Pending {
  resolve: (r: SnapReply | null) => void
  timer: NodeJS.Timeout
}

// Generous: a warm snap is ~50–200 ms; a cold one (content fetch included) may
// reach ~1 s. Past this the helper is presumed hung — kill it (the exit
// handler settles all pending requests as null → desktopCapturer fallback).
const SNAP_TIMEOUT_MS = 4000

let proc: ChildProcessWithoutNullStreams | null = null
let unsupported = false // macOS < 14 or binary missing — permanent fallback

// FIFO of in-flight requests — the helper is single-threaded and answers
// strictly in request order, so pairing replies to requests is positional.
let pending: Pending[] = []

// stdout parser state: a tiny header accumulator plus a chunk list for the
// binary payload. Payload chunks are only concatenated once, at completion —
// a 5K display's frame is ~59 MB and a rolling Buffer.concat per 64 KB pipe
// chunk would re-copy it hundreds of times.
// Annotated as the default Buffer<ArrayBufferLike> so reassigning subarray()
// views (also Buffer<ArrayBufferLike>) type-checks under @types/node 26.
let headBuf: Buffer = Buffer.alloc(0)
let payloadSize: { width: number; height: number } | null = null
let payloadNeed = 0
let payloadGot = 0
let payloadChunks: Buffer[] = []

function getBinaryPath(): string | null {
  // Dev: <project>/electron/helpers/screen-snap (resolved relative to out/main)
  const devPath = resolve(__dirname, '..', '..', 'electron', 'helpers', 'screen-snap')
  if (existsSync(devPath)) return devPath

  // Prod: bundled via electron-builder extraResources → Contents/Resources/screen-snap
  const prodPath = join(process.resourcesPath ?? app.getAppPath(), 'screen-snap')
  if (existsSync(prodPath)) return prodPath

  return null
}

function resetParser() {
  headBuf = Buffer.alloc(0)
  payloadSize = null
  payloadNeed = 0
  payloadGot = 0
  payloadChunks = []
}

function settleFront(reply: SnapReply | null) {
  const p = pending.shift()
  if (!p) return
  clearTimeout(p.timer)
  p.resolve(reply)
}

/** Kill the helper; its exit handler settles every pending request as null so
 *  callers fall through to desktopCapturer. Used on timeout and on protocol
 *  desync (a half-consumed binary payload can't be resynced line-wise). */
function killAndFlush() {
  const p = proc
  if (p) {
    try { p.kill() } catch { /* already gone */ }
  } else {
    for (const q of pending) { clearTimeout(q.timer); q.resolve(null) }
    pending = []
  }
}

function ingest(chunk: Buffer): void {
  let data: Buffer | null = chunk
  while (data && data.length > 0) {
    if (payloadSize) {
      // Binary payload mode: accumulate until payloadNeed bytes have arrived.
      const need = payloadNeed - payloadGot
      if (data.length < need) {
        payloadChunks.push(data)
        payloadGot += data.length
        return
      }
      payloadChunks.push(data.subarray(0, need))
      const body = Buffer.concat(payloadChunks, payloadNeed)
      const size = payloadSize
      data = data.subarray(need)
      payloadSize = null
      payloadNeed = 0
      payloadGot = 0
      payloadChunks = []
      settleFront({ width: size.width, height: size.height, data: body })
      continue
    }

    // Header mode: accumulate until newline (headers are tiny).
    headBuf = headBuf.length ? Buffer.concat([headBuf, data]) : data
    data = null
    const nl = headBuf.indexOf(0x0a)
    if (nl < 0) return
    const line = headBuf.subarray(0, nl).toString('utf8').trim()
    data = headBuf.subarray(nl + 1)
    headBuf = Buffer.alloc(0)

    if (line.startsWith('ok ')) {
      const [, w, h, n] = line.split(' ')
      const width = parseInt(w, 10)
      const height = parseInt(h, 10)
      const bytes = parseInt(n, 10)
      if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(bytes) ||
          width <= 0 || height <= 0 || bytes !== width * height * 4) {
        console.error('[mac-screen-snap] malformed header:', line)
        killAndFlush()
        return
      }
      payloadSize = { width, height }
      payloadNeed = bytes
      payloadGot = 0
      payloadChunks = []
      continue
    }
    if (line === 'ready') { // prewarm ack — nothing to hand back
      settleFront(null)
      continue
    }
    if (line.startsWith('err')) {
      if (line === 'err unsupported') {
        unsupported = true
        console.warn('[mac-screen-snap] helper reports unsupported (macOS < 14) — using desktopCapturer')
      } else {
        console.warn('[mac-screen-snap] helper error:', line)
      }
      settleFront(null)
      continue
    }
    console.error('[mac-screen-snap] unexpected line:', line)
    settleFront(null)
  }
}

function startHelper(): boolean {
  if (proc) return true
  if (process.platform !== 'darwin' || unsupported) return false
  const bin = getBinaryPath()
  if (!bin) {
    unsupported = true
    console.warn('[mac-screen-snap] screen-snap binary not found — using desktopCapturer')
    return false
  }

  try {
    // argv[1]: our PID — the helper excludes this process's windows from the
    // capture at the compositor level (window-at-point convention). Lets the
    // freeze run without waiting for the main window's hide to settle.
    proc = spawn(bin, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    console.error('[mac-screen-snap] failed to spawn helper:', err)
    proc = null
    return false
  }
  resetParser()

  // Identity-guard the handlers (see mac-window-pick.ts): a kill + respawn can
  // race this child's async 'exit', and cleanup must never touch the NEW proc.
  const p = proc
  p.stdout.on('data', (chunk: Buffer) => {
    if (proc === p) ingest(chunk)
  })
  p.stderr.on('data', chunk => {
    console.warn('[mac-screen-snap] stderr:', String(chunk).trim())
  })
  const cleanup = () => {
    if (proc !== p) return
    proc = null
    resetParser()
    for (const q of pending) { clearTimeout(q.timer); q.resolve(null) }
    pending = []
  }
  p.on('exit', cleanup)
  p.on('error', err => {
    console.error('[mac-screen-snap] helper error:', err)
    cleanup()
  })

  return true
}

function request(cmd: string): Promise<SnapReply | null> {
  return new Promise<SnapReply | null>(res => {
    if (!proc) { res(null); return }
    const timer = setTimeout(() => {
      console.warn('[mac-screen-snap] request timed out — killing helper for respawn')
      killAndFlush()
    }, SNAP_TIMEOUT_MS)
    pending.push({ resolve: res, timer })
    try {
      proc.stdin.write(cmd + '\n')
    } catch {
      // Write failed — unwind the just-queued entry and force a respawn.
      pending.pop()
      clearTimeout(timer)
      res(null)
      try { proc?.kill() } catch { /* */ }
      proc = null
    }
  })
}

/** Capture a full display via the ScreenCaptureKit helper. Returns null on any
 *  failure so the caller falls back to desktopCapturer. */
export async function captureDisplayMacSnap(
  display: Electron.Display
): Promise<NativeCapture | null> {
  if (process.platform !== 'darwin' || unsupported) return null
  if (!startHelper() || !proc) return null

  const sf = display.scaleFactor || 1
  const physW = Math.max(1, Math.round(display.size.width * sf))
  const physH = Math.max(1, Math.round(display.size.height * sf))
  const reply = await request(`snap ${display.id} ${physW} ${physH}`)
  if (!reply) return null

  try {
    // createFromBitmap (NOT createFromBuffer) — raw BGRA in, no decode. The
    // reply buffer rides along as `raw` so downstream consumers don't have to
    // toBitmap() the pixels straight back out.
    const image = nativeImage.createFromBitmap(reply.data, { width: reply.width, height: reply.height })
    return { image, raw: { buffer: reply.data, width: reply.width, height: reply.height } }
  } catch (err) {
    console.error('[mac-screen-snap] createFromBitmap failed:', err)
    return null
  }
}

/** Cheap availability probe for capture-policy decisions (e.g. whether the
 *  hide-before-freeze settle wait can be skipped because the snapshot excludes
 *  Lumia's windows anyway). Optimistic: true until the helper proves unusable
 *  (binary missing / macOS < 14 latch `unsupported`) — a transient failure
 *  after an optimistic skip is compensated inside freezeAllDisplays(). */
export function macSnapAvailable(): boolean {
  return process.platform === 'darwin' && !unsupported
}

let displayListenersInstalled = false

/** Fire-and-forget warm-up: spawns the helper and has it fetch + cache
 *  SCShareableContent (~200–500 ms) off the capture critical path. Re-runs on
 *  display-config changes so the helper's SCDisplay cache never goes stale
 *  right when the user hits a hotkey. */
export function prewarmMacScreenSnap(): void {
  if (process.platform !== 'darwin' || unsupported) return

  if (!displayListenersInstalled) {
    displayListenersInstalled = true
    const re = () => prewarmMacScreenSnap()
    screen.on('display-added', re)
    screen.on('display-removed', re)
    screen.on('display-metrics-changed', re)
  }

  if (!startHelper() || !proc) return
  void request('prewarm')
}
