import { app, desktopCapturer, net, screen } from 'electron'
import { getSettings, setSetting } from './settings'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import { join } from 'path'

import { WALLPAPER_USER_AGENT as USER_AGENT, WALLPAPER_TIMEOUT_MS as NET_TIMEOUT_MS, type WallpaperPhoto } from '../shared/wallpapers'

// Network guards: a 30 s abort timeout (shared/wallpapers.ts) so a stalled
// connection can't hang the UI forever, and a 50 MB accumulated-bytes cap so
// a runaway response can't blow up memory.
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

// Image hosts the photo bytes come from: Wikimedia Commons and Wallhaven.
// The download path must only fetch from these (no auth header is sent, but
// we still don't want the renderer steering downloads to arbitrary hosts).
const IMAGE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'w.wallhaven.cc']

function isWallpaperImageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname)
  } catch {
    return false
  }
}

// ── Set as Wallpaper ─────────────────────────────────────────────────────

function getWallpapersDir(): string {
  return join(app.getPath('userData'), 'wallpapers')
}

async function ensureWallpapersDir(): Promise<string> {
  const dir = getWallpapersDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Download a wallpaper image to userData/wallpapers/{id}.{jpg|jpeg|png}. Returns the
 * absolute path. If the file already exists with non-zero size we treat it as
 * a cache hit and skip the network call — Photo URLs are
 * content-stable, so a re-download would just spend bandwidth.
 *
 * Always uses `urls.full` (high quality at the cost of a few MB per photo).
 * Written beside its place first and moved in when complete, so a download
 * cut short never counts as a cached photo.
 */
export async function downloadWallpaper(photo: WallpaperPhoto): Promise<string> {
  const dir = await ensureWallpapersDir()
  // photo.id is renderer-supplied — sanitize before using it as a filename so
  // a crafted id (e.g. "../../foo") can't escape the wallpapers dir. Ids (commons-123,
  // wallhaven-4l59g2) are alphanumeric with - and _, so anything outside that set is dropped.
  const safeId = String(photo.id).replace(/[^A-Za-z0-9_-]/g, '')
  if (!safeId) throw new Error('Invalid photo id')
  const ext = /\.(jpe?g|png)(?:\?|$)/i.exec(String(photo.urls?.full ?? ''))?.[1]?.toLowerCase() ?? 'jpg'
  const filePath = join(dir, `${safeId}.${ext}`)

  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 0) return filePath
  } catch {
    // missing — fall through to download
  }

  // Only download from the photo sources' own image hosts; don't let a
  // renderer-supplied URL steer the fetch to an arbitrary host.
  if (!isWallpaperImageUrl(photo.urls.full)) {
    throw new Error('Refusing to download wallpaper from an unknown host')
  }

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    // Redirects are followed by hand, and only to the photo hosts: the
    // allow-list above would otherwise cover the first URL alone.
    const req = net.request({ url: photo.urls.full, method: 'GET', useSessionCookies: false, redirect: 'manual' })
    // Wikimedia asks for an identifying User-Agent (the app's name only).
    req.setHeader('User-Agent', USER_AGENT)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { req.abort() } catch { /* ignore */ }
      reject(new Error('Wallpaper download timed out'))
    }, NET_TIMEOUT_MS)
    req.on('redirect', (_status, _method, redirectUrl) => {
      if (isWallpaperImageUrl(redirectUrl)) { req.followRedirect(); return }
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { req.abort() } catch { /* ignore */ }
      reject(new Error('Refusing to download wallpaper from an unknown host'))
    })
    req.on('response', res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`Wallpaper download failed (HTTP ${res.statusCode})`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_DOWNLOAD_BYTES) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { req.abort() } catch { /* ignore */ }
          reject(new Error('Wallpaper download exceeded size cap'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks)) })
      res.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err) } })
    })
    req.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err) } })
    req.end()
  })

  const tmp = `${filePath}.part`
  try {
    await fs.writeFile(tmp, buffer)
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => { /* never written */ })
    throw err
  }
  return filePath
}

/**
 * Windows, every screen: SystemParametersInfoW(SPI_SETDESKWALLPAPER) via
 * koffi. The flags SPIF_UPDATEINIFILE | SPIF_SENDCHANGE persist the change
 * in the user's profile and broadcast WM_SETTINGCHANGE so Explorer repaints
 * immediately. (Some screens only: setWallpaperWindowsSome below. macOS:
 * setWallpaperMac, NSWorkspace per screen.)
 */
async function setWallpaperWindows(filePath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const SystemParametersInfoW = user32.func(
    'bool __stdcall SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, str16 pvParam, uint32_t fWinIni)'
  )
  const SPI_SETDESKWALLPAPER = 0x0014
  const SPIF_UPDATEINIFILE = 0x01
  const SPIF_SENDCHANGE    = 0x02
  const ok = SystemParametersInfoW(
    SPI_SETDESKWALLPAPER,
    0,
    filePath,
    SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
  )
  if (!ok) throw new Error('SystemParametersInfoW returned false')
}

// macOS, per screen (2026-11-27): NSWorkspace through JavaScript for
// Automation (osascript -l JavaScript), keyed by NSScreenNumber, which is
// Electron's display.id (CGDirectDisplayID). The screen's own options
// (scaling, fill colour) are kept. Current Space only, like System Events'
// `every desktop` before.
const MAC_READ = `ObjC.import('AppKit')
function run() {
  const ws = $.NSWorkspace.sharedWorkspace
  const screens = $.NSScreen.screens
  const out = []
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i)
    const url = ws.desktopImageURLForScreen(s)
    out.push({ id: Number(ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber'))), path: url.isNil() ? null : ObjC.unwrap(url.path) })
  }
  return JSON.stringify(out)
}`
const MAC_SET = `ObjC.import('AppKit')
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0])
  const ids = argv.slice(1).map(Number)
  const ws = $.NSWorkspace.sharedWorkspace
  const screens = $.NSScreen.screens
  let set = 0
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i)
    const id = Number(ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber')))
    if (ids.length && ids.indexOf(id) < 0) continue
    if (ws.setDesktopImageURLForScreenOptionsError(url, s, ws.desktopImageOptionsForScreen(s), null)) set++
  }
  return String(set)
}`

function osascript(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message))
      else resolve(String(stdout).trim())
    })
  })
}

/** Each screen's current wallpaper file (null when macOS won't say, e.g.
 *  an Aerial). */
async function readWallpapersMac(): Promise<{ id: number; path: string | null }[]> {
  try { return JSON.parse(await osascript(MAC_READ, [])) } catch (err) { console.warn('[wallpapers] could not read the screens\' wallpapers', (err as Error).message); return [] }
}

/** Set `filePath` on the screens `ids` (all when empty). */
async function setWallpaperMac(filePath: string, ids: number[]): Promise<void> {
  const set = Number(await osascript(MAC_SET, [filePath, ...ids.map(String)]))
  if (!set) throw new Error('macOS did not take the wallpaper')
}

// Windows, some screens (2026-11-27): IDesktopWallpaper (per monitor)
// through PowerShell, since SystemParametersInfoW can only do all of them.
// Monitors are matched by their rectangle (physical pixels) to the picked
// displays' (screen.dipToScreenRect). Values go in through the environment,
// not the command line, so no quoting can break.
const WIN_COM = `
$ErrorActionPreference = 'Stop'
# UTF-8 out: Node reads stdout as UTF-8, PowerShell writes the console's
# old code page, which garbles a path with an ü (a username like Jürgen).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct LumiaRect { public int Left, Top, Right, Bottom; }
[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ILumiaDesktopWallpaper {
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  LumiaRect GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
}
[ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")] public class LumiaDesktopWallpaperClass {}
"@
$dw = [ILumiaDesktopWallpaper](New-Object LumiaDesktopWallpaperClass)
`
const WIN_SET_SOME = WIN_COM + `
# @(): one picked screen must stay a list of rectangles, not unroll into
# one rectangle's numbers.
$targets = @($env:LUMIA_WP_RECTS.Split(';') | ForEach-Object { , @($_.Split(',') | ForEach-Object { [int]$_ }) })
$set = 0
for ($i = 0; $i -lt $dw.GetMonitorDevicePathCount(); $i++) {
  $id = $dw.GetMonitorDevicePathAt($i)
  try { $r = $dw.GetMonitorRECT($id) } catch { continue }
  $cx = ($r.Left + $r.Right) / 2; $cy = ($r.Top + $r.Bottom) / 2
  foreach ($t in $targets) {
    if ($cx -ge $t[0] -and $cx -lt $t[2] -and $cy -ge $t[1] -and $cy -lt $t[3]) { $dw.SetWallpaper($id, $env:LUMIA_WP_PATH); $set++; break }
  }
}
Write-Output $set
`
// Every monitor's wallpaper, for Reset: [{ id, path }] by device path.
const WIN_READ_ALL = WIN_COM + `
$out = @()
for ($i = 0; $i -lt $dw.GetMonitorDevicePathCount(); $i++) {
  $id = $dw.GetMonitorDevicePathAt($i)
  try { $out += [pscustomobject]@{ id = $id; path = $dw.GetWallpaper($id) } } catch { }
}
ConvertTo-Json -InputObject @($out) -Compress
`
// Put wallpapers back per monitor: LUMIA_WP_PAIRS = [{ id, path }].
const WIN_SET_BY_ID = WIN_COM + `
$set = 0
foreach ($p in @($env:LUMIA_WP_PAIRS | ConvertFrom-Json)) {
  try { $dw.SetWallpaper($p.id, $p.path); $set++ } catch { }
}
Write-Output $set
`

function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 20_000,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message))
      else resolve(String(stdout).trim())
    })
  })
}

async function setWallpaperWindowsSome(filePath: string, ids: number[]): Promise<void> {
  const rects = screen.getAllDisplays().filter(d => ids.includes(d.id)).map(d => {
    const r = screen.dipToScreenRect(null, d.bounds)
    return `${r.x},${r.y},${r.x + r.width},${r.y + r.height}`
  })
  if (rects.length === 0) throw new Error('No such screen')
  const out = await powershell(WIN_SET_SOME, { LUMIA_WP_PATH: filePath, LUMIA_WP_RECTS: rects.join(';') })
  if (!Number(out)) throw new Error('Windows did not take the wallpaper')
}

/** Every monitor's wallpaper by device path, or null when Windows won't say. */
async function readWallpapersWindows(): Promise<Record<string, string> | null> {
  try {
    const list = JSON.parse(await powershell(WIN_READ_ALL)) as { id: string; path: string }[]
    const out: Record<string, string> = {}
    for (const m of list) if (m.id) out[m.id] = m.path ?? ''
    return Object.keys(out).length ? out : null
  } catch (err) {
    console.warn('[wallpapers] could not read the monitors\' wallpapers', (err as Error).message)
    return null
  }
}

/** Windows' wallpaper for all screens before Lumia's first change (the
 *  registry value Explorer keeps; '' = none, a plain colour). */
async function readWallpaperWindows(): Promise<string | null> {
  // Through PowerShell in UTF-8, not `reg query` (its output is in the
  // console's old code page).
  try {
    return await powershell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper`)
  } catch {
    return null
  }
}

// ── Reset (2026-11-27) ───────────────────────────────────────────────────
// The wallpaper as it was before Lumia's first change, kept in settings
// (`wallpaperBefore`) until Reset puts it back: per screen on macOS (each
// screen's file, taken the first time Lumia changes that screen), one path
// on Windows (the registry's, all screens). Taken once, so several tries in
// a row still go back to the user's own.

type WallpaperBefore = { all?: string; screens?: Record<string, string>; monitors?: Record<string, string> }

async function rememberBefore(ids: number[]): Promise<void> {
  const before: WallpaperBefore = { ...(getSettings().wallpaperBefore ?? {}) }
  if (process.platform === 'darwin') {
    const screens = { ...(before.screens ?? {}) }
    for (const { id, path } of await readWallpapersMac()) {
      if (ids.length && !ids.includes(id)) continue
      if (path && !(String(id) in screens)) screens[String(id)] = path
    }
    before.screens = screens
  } else if (process.platform === 'win32') {
    // Every monitor's own wallpaper (IDesktopWallpaper), so Reset puts each
    // back, whichever ones Lumia changed; the registry's one path when that
    // can't be read.
    if (!before.monitors && before.all === undefined) {
      const monitors = await readWallpapersWindows()
      if (monitors) before.monitors = monitors
      else {
        const path = await readWallpaperWindows()
        if (path !== null) before.all = path
      }
    }
  }
  if (hasBefore(before)) setSetting('wallpaperBefore', before)
  else console.warn('[wallpapers] the current wallpaper could not be read: no Reset for this change')
}

function hasBefore(b: WallpaperBefore | null | undefined): boolean {
  return !!b && (b.all !== undefined || Object.keys(b.screens ?? {}).length > 0 || Object.keys(b.monitors ?? {}).length > 0)
}

export function canResetWallpaper(): boolean {
  return hasBefore(getSettings().wallpaperBefore)
}

/** Put the remembered wallpaper back and forget it. Screens no longer
 *  connected are skipped. */
export async function resetDesktopWallpaper(): Promise<void> {
  const b = getSettings().wallpaperBefore
  if (!b) return
  if (process.platform === 'darwin') {
    const present = new Set(screen.getAllDisplays().map(d => String(d.id)))
    const byPath = new Map<string, number[]>()
    for (const [id, path] of Object.entries(b.screens ?? {})) {
      if (!present.has(id)) continue
      byPath.set(path, [...(byPath.get(path) ?? []), Number(id)])
    }
    for (const [path, ids] of byPath) await setWallpaperMac(path, ids)
  } else if (process.platform === 'win32') {
    if (b.monitors && Object.keys(b.monitors).length) {
      const pairs = Object.entries(b.monitors).map(([id, path]) => ({ id, path }))
      if (!Number(await powershell(WIN_SET_BY_ID, { LUMIA_WP_PAIRS: JSON.stringify(pairs) }))) throw new Error('Windows did not take the wallpaper')
    } else if (b.all !== undefined) await setWallpaperWindows(b.all)
  }
  setSetting('wallpaperBefore', null)
}

/** The screens a wallpaper can go on, left to right, for the screen
 *  picker: the OS's display name (or "Screen 2"), its shape, and with
 *  `previews` a small picture of what's on it now (desktopCapturer). */
export async function wallpaperScreens(previews = false): Promise<{ id: number; label: string; width: number; height: number; preview?: string }[]> {
  const shots = new Map<string, string>()
  if (previews) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 400 } })
      for (const s of sources) if (s.display_id && !s.thumbnail.isEmpty()) shots.set(s.display_id, s.thumbnail.toDataURL())
    } catch { /* cards without a picture */ }
  }
  return screen.getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => ({ id: d.id, label: d.label || `Screen ${i + 1}`, width: d.bounds.width, height: d.bounds.height, preview: shots.get(String(d.id)) }))
}

/**
 * Cap on how many JPGs we keep under userData/wallpapers/. Each file is
 * ~3–6 MB at full-res, so 20 ≈ 60–120 MB ceiling. Tuned to be invisible in
 * normal use but bounded enough that a heavy user setting hundreds of
 * wallpapers doesn't fill their disk.
 */
const WALLPAPER_CACHE_KEEP = 20

/**
 * Best-effort cleanup of older wallpapers under userData/wallpapers/. Sorts
 * files by mtime descending and unlinks anything past the keep cap. The
 * currently-applied file is filtered out by path as a second line of defense
 * so we never yank the file the OS just started displaying — even though
 * setDesktopWallpaper refreshes its mtime first, which alone should keep it
 * at the top of the sort.
 *
 * Failures are swallowed: a stale prune shouldn't bubble up and fail an
 * already-successful apply.
 */
async function pruneWallpapersDir(keep: number, currentFile: string): Promise<void> {
  try {
    const dir = getWallpapersDir()
    const names = await fs.readdir(dir)
    if (names.length <= keep) return
    const stats = await Promise.all(
      names.map(async name => {
        const full = join(dir, name)
        try {
          const s = await fs.stat(full)
          return { full, mtime: s.mtimeMs, isFile: s.isFile() }
        } catch {
          return null
        }
      })
    )
    const files = stats
      .filter((s): s is { full: string; mtime: number; isFile: boolean } => !!s && s.isFile)
      .sort((a, b) => b.mtime - a.mtime)
    // The wallpaper Reset will put back stays too, should it be one of ours.
    const b = getSettings().wallpaperBefore
    const kept = new Set([currentFile, b?.all, ...Object.values(b?.screens ?? {}), ...Object.values(b?.monitors ?? {})].filter(Boolean))
    const toDelete = files.slice(keep).filter(f => !kept.has(f.full))
    await Promise.all(toDelete.map(f => fs.unlink(f.full).catch(() => undefined)))
  } catch (err) {
    console.warn('[wallpapers] prune failed', err)
  }
}

/** Set the photo on the screens `screenIds` (every screen when empty or
 *  when it names them all). */
export async function setDesktopWallpaper(photo: WallpaperPhoto, screenIds: number[] = []): Promise<{ filePath: string }> {
  const filePath = await downloadWallpaper(photo)
  const all = screen.getAllDisplays().map(d => d.id)
  const ids = screenIds.filter(id => all.includes(id))
  // Picked screens that are all gone (unplugged since): not every screen.
  if (screenIds.length > 0 && ids.length === 0) throw new Error('No such screen')
  const some = ids.length > 0 && ids.length < all.length
  await rememberBefore(some ? ids : [])
  if (process.platform === 'win32') {
    if (some) await setWallpaperWindowsSome(filePath, ids)
    else await setWallpaperWindows(filePath)
  } else if (process.platform === 'darwin') {
    await setWallpaperMac(filePath, some ? ids : [])
  } else {
    throw new Error(`Setting wallpaper is not supported on ${process.platform}`)
  }
  // Refresh mtime on a cache-hit re-apply so the pruner sees this file as
  // recently used and keeps it at the top of the LRU. Without this, applying
  // an older cached wallpaper would leave its mtime pointing back to the
  // original download timestamp and the pruner could delete the very file
  // we just told the OS to render.
  const now = new Date()
  await fs.utimes(filePath, now, now).catch(() => undefined)
  void pruneWallpapersDir(WALLPAPER_CACHE_KEEP, filePath)
  return { filePath }
}
