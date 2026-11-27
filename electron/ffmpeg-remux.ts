// Make a MediaRecorder WebM seekable, losslessly, via a bundled ffmpeg.
//
// MediaRecorder emits a "streaming" WebM: the Segment has no Cues element (the
// timestamp→byte-offset seek index) and usually no Duration. The result plays
// from the start but the scrubber is dead in EVERY player (Lumia, VLC,
// browsers) — it's a property of the file, not the player.
//
// `ffmpeg -i in.webm -c copy out.webm` rebuilds the container with a proper
// SeekHead + Cues + Duration. `-c copy` means NO re-encode — the audio/video
// bitstream is untouched, only container metadata is rewritten — and ffmpeg
// streams both input and output from disk, so memory stays flat regardless of
// file size (unlike the previous in-memory ts-ebml remux, which ballooned a
// 200 MB recording to ~2 GB of RAM).
import { spawn, type ChildProcess } from 'child_process'
import { rename, unlink } from 'fs/promises'
import { dirname, join, basename } from 'path'
import { app } from 'electron'
import { fpsFromFfmpegInfo } from '../shared/recording'

/** Resolve the ffmpeg binary.
 *  - Packaged: the afterPack hook (build/embed-ffmpeg.cjs) places a per-arch
 *    binary in Resources. ffmpeg-static can't be used here because it only
 *    ships the build-host's arch, which would be wrong for the cross-arch
 *    installers.
 *  - Dev: ffmpeg-static's host-arch binary is exactly right. */
function resolveFfmpegPath(): string | null {
  if (app.isPackaged) {
    return join(process.resourcesPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('ffmpeg-static') as string | null) ?? null
  } catch {
    return null
  }
}

/** Losslessly remux a WebM in place so it has a Cues seek index + Duration.
 *  Returns true on success. On any failure the original file is left intact
 *  (it still plays, just may not seek) — a recording is never lost. */
export async function remuxWebmInPlace(filePath: string): Promise<boolean> {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    console.warn('[ffmpeg] binary not found — skipping seekable remux')
    return false
  }

  // Write to a sibling temp file, then atomically replace, so an interrupted
  // ffmpeg can never leave a truncated recording at the real path.
  const tmp = join(dirname(filePath), `.${basename(filePath)}.remux.webm`)

  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(
      ffmpeg,
      ['-y', '-i', filePath, '-c', 'copy', '-f', 'webm', tmp],
      { windowsHide: true },
    )
    let tail = ''
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000) })
    proc.on('error', (err) => { console.error('[ffmpeg] spawn failed', err); resolve(false) })
    proc.on('close', (code) => {
      if (code === 0) return resolve(true)
      console.error(`[ffmpeg] remux exited ${code}: ${tail.slice(-500)}`)
      resolve(false)
    })
  })

  if (!ok) {
    await unlink(tmp).catch(() => { /* nothing to clean */ })
    return false
  }
  try {
    await rename(tmp, filePath)
    return true
  } catch (err) {
    console.error('[ffmpeg] replacing original failed', err)
    await unlink(tmp).catch(() => { /* ignore */ })
    return false
  }
}

// ── Lossless trim ──────────────────────────────────────────────────────────
//
// `ffmpeg -ss S -i in.webm -t D -c copy out.webm` cuts by time WITHOUT
// decoding: compressed packets are copied straight from input to output, so
// memory stays at a few MB and CPU near zero regardless of clip length — the
// job is disk-bound, about as slow as a file copy. No chunking/buffering on
// our side is needed (or helpful: splitting would add a keyframe snap at every
// chunk boundary).
//
// Trade-off of stream copy: the output can only START on a keyframe, so ffmpeg
// begins at the keyframe at or before S. The clip may start slightly early but
// never drops requested footage. Recordings ask MediaRecorder for a keyframe
// every second (RecorderHost) to keep that snap small.

export interface TrimResult {
  ok: boolean
  error?: string
  /** Output duration ffmpeg reported (ms). Longer than end−start when the
   *  start snapped back to an earlier keyframe. Undefined if unparseable. */
  outputDurationMs?: number
}

/** Trims longer than this are treated as hung and killed. Stream copy runs at
 *  disk speed, so even multi-GB recordings finish well inside it. */
const TRIM_TIMEOUT_MS = 5 * 60 * 1000

// One trim at a time app-wide: a second request while one runs is rejected
// rather than queued, so a double-click can't start two disk-heavy copies.
let activeTrim: ChildProcess | null = null
let quitHookInstalled = false

export function isTrimRunning(): boolean {
  return activeTrim !== null
}

/** Container duration of a media file, read with `ffmpeg -i <file>` (demux
 *  only — works with the minimal build, which has no ffprobe). ffmpeg exits
 *  non-zero because no output is given; the header it prints is all we need.
 *
 *  NOTE: the progress `time=` stamp of the trim run itself is NOT usable for
 *  this — with stream copy it reports the requested length even when the cut
 *  snapped back to an earlier keyframe. The output's Duration header is the
 *  real length (verified: 4.0 s asked → 4.30 s file with 1 s keyframes,
 *  9.30 s file with a single keyframe at 0). */
async function probeDurationMs(ffmpeg: string, file: string): Promise<number | undefined> {
  return (await probeInfo(ffmpeg, file)).durationMs
}

/** What `ffmpeg -i` says about a file: its length, and its video stream's
 *  frame rate when the header names one. Both undefined when the file can't
 *  be read. */
async function probeInfo(ffmpeg: string, file: string): Promise<{ durationMs?: number; fps?: number }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
    let err = ''
    proc.stderr?.on('data', (d) => { if (err.length < 8000) err += d.toString() })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* ignore */ } }, 15_000)
    proc.on('error', () => { clearTimeout(timer); resolve({}) })
    proc.on('close', () => {
      clearTimeout(timer)
      const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(err)
      if (!m) return resolve({})
      const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
      resolve({ durationMs: Number.isFinite(ms) ? Math.round(ms) : undefined, fps: fpsFromFfmpegInfo(err) })
    })
  })
}

/** Length of a media file in ms from its Duration header, or undefined when
 *  ffmpeg is missing or the file has no readable header. */
export async function probeWebmDurationMs(file: string): Promise<number | undefined> {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) return undefined
  return probeDurationMs(ffmpeg, file)
}

/** Length and (when the header names one) frame rate of a media file, from
 *  one ffmpeg run. `{}` when ffmpeg is missing or the file can't be read. */
export async function probeWebmInfo(file: string): Promise<{ durationMs?: number; fps?: number }> {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) return {}
  return probeInfo(ffmpeg, file)
}

/** Losslessly cut [startMs, endMs) of `src` into a new file at `dst`. The
 *  source is never modified. Output goes to a sibling temp file first and is
 *  renamed into place only on success, so a failed/killed trim never leaves a
 *  truncated file at `dst`. */
export async function trimWebm(src: string, dst: string, startMs: number, endMs: number): Promise<TrimResult> {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) return { ok: false, error: 'Video tools are missing from this install' }
  if (activeTrim) return { ok: false, error: 'Another trim is already running' }

  if (!quitHookInstalled) {
    quitHookInstalled = true
    // Never leave an orphan ffmpeg writing to disk after the app is gone.
    app.on('will-quit', () => { try { activeTrim?.kill('SIGKILL') } catch { /* ignore */ } })
  }

  const tmp = join(dirname(dst), `.${basename(dst)}.trim.webm`)
  const sec = (ms: number) => (ms / 1000).toFixed(3)

  const result = await new Promise<TrimResult>((resolve) => {
    const proc = spawn(
      ffmpeg,
      [
        '-y',
        '-ss', sec(startMs),          // input-side seek: jumps via the Cues index, no decode
        '-i', src,
        '-t', sec(endMs - startMs),   // duration (unambiguous, unlike -to with input -ss)
        '-map', '0',                  // keep every stream (video + mic audio)
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'webm',
        tmp,
      ],
      { windowsHide: true },
    )
    activeTrim = proc
    // Only the tail of stderr is kept — ffmpeg's progress output is unbounded
    // on long inputs and we only need the last lines for an error report.
    let tail = ''
    proc.stderr?.on('data', (d) => { tail = (tail + d.toString()).slice(-4000) })
    const timer = setTimeout(() => {
      console.error('[ffmpeg] trim timed out — killing')
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
    }, TRIM_TIMEOUT_MS)
    proc.on('error', (err) => {
      clearTimeout(timer)
      console.error('[ffmpeg] trim spawn failed', err)
      resolve({ ok: false, error: 'Could not start the video tool' })
    })
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ ok: true })
      console.error(`[ffmpeg] trim exited ${code ?? signal}: ${tail.slice(-500)}`)
      resolve({ ok: false, error: signal ? 'Trim was cancelled' : 'Trim failed' })
    })
  }).finally(() => { activeTrim = null })

  if (!result.ok) {
    await unlink(tmp).catch(() => { /* nothing to clean */ })
    return result
  }
  try {
    await rename(tmp, dst)
  } catch (err) {
    console.error('[ffmpeg] moving trimmed file into place failed', err)
    await unlink(tmp).catch(() => { /* ignore */ })
    return { ok: false, error: 'Could not save the trimmed file' }
  }
  return { ok: true, outputDurationMs: await probeDurationMs(ffmpeg, dst) }
}
