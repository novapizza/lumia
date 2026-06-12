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
import { spawn } from 'child_process'
import { rename, unlink } from 'fs/promises'
import { dirname, join, basename } from 'path'
import { app } from 'electron'

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
