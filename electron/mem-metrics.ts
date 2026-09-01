import { app, BrowserWindow, type WebContents } from 'electron'
import log from 'electron-log'

// Per-process memory snapshots. An Electron app is a process tree (browser +
// GPU + one renderer per BrowserWindow + utilities) and Task Manager only
// shows the sum, so this is the one place that says *which* process is heavy.
// Two snapshots land in the log after every launch (settled + idle) so user
// bug reports carry a breakdown; set LUMIA_MEM_LOG_INTERVAL_MS to keep
// sampling while profiling.

const labels = new Map<number, string>() // webContents.id → label

/** Give a renderer a human-readable name in the snapshot (e.g. "main",
 *  "overlay:12345 1920x1080@1"). Unlabelled renderers fall back to their
 *  URL's hash route / file name. */
export function labelWebContents(wc: WebContents, label: string) {
  labels.set(wc.id, label)
  wc.once('destroyed', () => { labels.delete(wc.id) })
}

function rendererLabel(pid: number): string {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const wc = win.webContents
    if (wc.getOSProcessId() !== pid) continue
    const label = labels.get(wc.id)
    if (label) return label
    const url = wc.getURL()
    const hash = url.split('#')[1]
    return hash ? hash.split('?')[0] : (url.split('/').pop() ?? '?')
  }
  return '?'
}

const mb = (kb: number) => (kb / 1024).toFixed(1)

export function memorySnapshot(): string {
  let ws = 0
  let priv = 0
  let cpu = 0
  const rows = app.getAppMetrics().map(m => {
    // privateBytes is unavailable on macOS — rows sort by working set there.
    const p = m.memory.privateBytes ?? 0
    ws += m.memory.workingSetSize
    priv += p
    // CPU is the average since the previous snapshot (0 on the first one), in
    // percent of one core — so 100 = a full core busy, 3 ≈ one repaint loop.
    cpu += m.cpu.percentCPUUsage
    let name: string = m.type
    if (m.type === 'Tab') name = `renderer(${rendererLabel(m.pid)})`
    else if (m.type === 'Utility') name = `utility(${m.serviceName ?? m.name ?? '?'})`
    return { name, pid: m.pid, ws: m.memory.workingSetSize, priv: p, cpu: m.cpu.percentCPUUsage }
  }).sort((a, b) => (b.priv - a.priv) || (b.ws - a.ws))

  const heapUsed = (process.memoryUsage().heapUsed / 1048576).toFixed(1)
  const lines = rows.map(r =>
    `  ${r.name.padEnd(40)} pid=${String(r.pid).padEnd(6)} ws=${mb(r.ws).padStart(6)}MB  private=${mb(r.priv).padStart(6)}MB  cpu=${r.cpu.toFixed(1).padStart(5)}%`)
  return [
    `total ws=${mb(ws)}MB private=${mb(priv)}MB cpu=${cpu.toFixed(1)}% across ${rows.length} processes (main heapUsed=${heapUsed}MB)`,
    ...lines,
  ].join('\n')
}

/** Milliseconds since the process started — the "cold start" clock. */
export function uptimeMs(): number {
  return Math.round(process.uptime() * 1000)
}

/** One-line startup milestone (`[perf] window:ready at +812ms`). */
export function logMilestone(name: string) {
  log.info(`[perf] ${name} at +${uptimeMs()}ms`)
}

export function logMemory(tag: string) {
  try {
    log.info(`[mem] ${tag}\n${memorySnapshot()}`)
  } catch (err) {
    log.warn('[mem] snapshot failed', err)
  }
}

/** Startup snapshots at +10 s (renderers settled) and +60 s (idle), plus an
 *  optional periodic sampler when LUMIA_MEM_LOG_INTERVAL_MS is set. */
export function setupMemoryLogging() {
  setTimeout(() => logMemory('startup +10s'), 10_000)
  setTimeout(() => logMemory('startup +60s'), 60_000)
  const interval = Number(process.env.LUMIA_MEM_LOG_INTERVAL_MS)
  if (Number.isFinite(interval) && interval >= 1000) {
    setInterval(() => logMemory('periodic'), interval)
  }
}
