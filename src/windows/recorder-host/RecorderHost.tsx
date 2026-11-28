import { useEffect, useRef } from 'react'
import { THUMBNAIL_WIDTH } from '../../lib/video-frame'
import { RECORDING_FPS } from '../../../shared/recording'
import { TileSampler, RecordedClock } from '../../lib/filmstrip'
import { drawTile, stripFromTiles, encodeStrip } from '../../lib/filmstrip-build'
import {
  WATERMARK_PT, WATERMARK_MARGIN_PT, WATERMARK_OPACITY, WATERMARK_MAX_W, WATERMARK_MAX_H, WATERMARK_MIN_PX, WATERMARK_INK_THRESHOLD,
} from '../../../shared/watermark'

interface RecordingTarget {
  kind: 'region' | 'window' | 'screen'
  sourceId: string
  displayId: number
  rect?: { x: number; y: number; width: number; height: number }
  displayDipSize: { width: number; height: number }
  displayScaleFactor: number
  outputSize?: { width: number; height: number }
}

// The rate recordings are made at (shared/recording.ts: 30 fps is plenty for
// screen content, and the desktop-capture → canvas pipeline only delivered
// ~34 fps in practice when asked for 60 — so the old 60 fps target sized the
// bitrate for frames that never arrived). It goes onto the recording's
// history row with the save, and the video editor steps by it.
const TARGET_FPS = RECORDING_FPS
// Bits-per-pixel-per-frame quality factor. The previous 0.25 @ 60 fps asked
// for ~28 Mbps on a 1932×970 region and produced ~250 MB per 2 min of
// mostly-static UI. 0.08 @ 30 fps puts 1920×1080 at ≈5 Mbps and 2560×1440 at
// ≈8.8 Mbps; text stays legible because the track is hinted as 'detail'
// (see buildOutputStream). The MediaRecorder default (~2.5 Mbps regardless of
// resolution) is still too low for high-DPI UI text, hence the explicit value.
const VIDEO_QUALITY_FACTOR = 0.08
// Hard ceiling so 4K/5K screens don't ask for more than screen content needs.
const VIDEO_BITRATE_CAP = 12_000_000
const VIDEO_BITRATE_FLOOR = 2_000_000
const AUDIO_BITRATE = 192_000
/** Keyframe spacing requested from MediaRecorder — bounds trim snapping (see onBegin). */
const KEYFRAME_INTERVAL_MS = 1000
// Region/window crops smaller than this (long-side, physical px) get
// uniformly upscaled to this baseline at draw time. Two reasons:
//   1. Players viewing the recording at full-screen or in the editor pane
//      would otherwise have to upscale a small video in real time, and
//      browser bilinear is visibly soft. Doing the upscale once at encode
//      time with high-quality canvas smoothing keeps subsequent playback
//      a pure downscale (which always looks crisper than upscale).
//   2. The encoder gets more pixels to spread bits over, so text strokes
//      survive intact. The bitrate is sized from the upscaled canvas, not
//      the raw crop (see onBegin).
// Trade-off: small-region recordings now produce noticeably bigger files.
const MIN_OUTPUT_LONG_SIDE = 1280

// Slice size for streaming the finished blob to disk over IPC. Bounded so peak
// transfer memory is one slice regardless of total recording length.
const SAVE_SLICE_BYTES = 16 * 1024 * 1024

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return 'video/webm'
}

function computeVideoBitrate(width: number, height: number, fps: number): number {
  const raw = Math.round(width * height * fps * VIDEO_QUALITY_FACTOR)
  return Math.max(VIDEO_BITRATE_FLOOR, Math.min(VIDEO_BITRATE_CAP, raw))
}

/** Headless renderer that owns the MediaRecorder. No user-facing UI — the
 *  toolbar (separate window) issues commands via main-process IPC. */
export default function RecorderHost() {
  // Refs so IPC event handlers always read current values, not stale closures.
  const targetRef        = useRef<RecordingTarget | null>(null)
  const desktopStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef     = useRef<MediaStream | null>(null)
  const outStreamRef     = useRef<MediaStream | null>(null)
  const recorderRef      = useRef<MediaRecorder | null>(null)
  const chunksRef        = useRef<Blob[]>([])

  const videoElRef       = useRef<HTMLVideoElement | null>(null)
  const canvasElRef      = useRef<HTMLCanvasElement | null>(null)
  // Stop callback for the canvas draw loop. Stores a closure rather than a
  // bare handle so the same cleanup path works whether the loop runs on
  // requestVideoFrameCallback (preferred) or requestAnimationFrame (fallback).
  const drawLoopRef      = useRef<(() => void) | null>(null)

  // Timing: recorded time, which stops in a pause (RecordedClock). The
  // recording's length, the toolbar's timer and the filmstrip tiles' times
  // all read this one clock.
  const clockRef         = useRef(new RecordedClock())
  const tickTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  // Set while paused so the canvas draw loop can skip the expensive
  // composite (and the watermark blend) for the entire pause duration —
  // otherwise it keeps compositing every source frame the paused recorder
  // just discards.
  const pausedRef        = useRef(false)
  // The video editor's filmstrip, collected while recording (2026-11-27): a
  // small tile of the frame just drawn, every so often, so the strip is
  // there the moment the recording stops and the editor needn't decode it.
  const stripRef         = useRef<TileSampler<HTMLCanvasElement> | null>(null)

  useEffect(() => {
    let mounted = true

    // ── Acquire stream ──────────────────────────────────────────────────
    ;(async () => {
      try {
        const target = await window.electronAPI?.recorderGetTarget?.()
        if (!mounted) return
        if (!target) throw new Error('No recording target set')
        targetRef.current = target as RecordingTarget

        // Pin the stream to the display's exact physical resolution. With
        // only max constraints, Chromium delivers the stream at maxWidth ×
        // maxHeight ("crop-and-scale" mode), which:
        //   1. Doesn't match the display's aspect ratio — stretches non-
        //      uniformly so sx ≠ sy, breaking the crop math.
        //   2. Moves the stream into a coordinate space that has no clean
        //      mapping back to overlay DIP pixels.
        // Forcing min=max=physical locks the stream to native pixels, so
        // sx = sy = scaleFactor and the crop rect maps 1:1 with what the
        // user saw in the overlay.
        const physW = Math.max(1, Math.round(target.displayDipSize.width  * target.displayScaleFactor))
        const physH = Math.max(1, Math.round(target.displayDipSize.height * target.displayScaleFactor))
        const desktopStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // @ts-expect-error Electron-specific constraint
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: target.sourceId,
              minWidth:  physW,
              maxWidth:  physW,
              minHeight: physH,
              maxHeight: physH,
              maxFrameRate: TARGET_FPS,
            },
          },
        })
        if (!mounted) { desktopStream.getTracks().forEach(t => t.stop()); return }
        desktopStreamRef.current = desktopStream

        // Wait until the stream reports real frame dims. Without this, the
        // draw loop can run with zeros for a few frames and compute the
        // crop against bogus numbers.
        await new Promise<void>(resolve => {
          const t = desktopStream.getVideoTracks()[0]
          if (!t) return resolve()
          const check = () => {
            const s = t.getSettings()
            if (s.width && s.height) resolve()
            else requestAnimationFrame(check)
          }
          check()
        })

        // Decode the watermark (both inks) once. Failure here is non-fatal —
        // the recording still proceeds, just without the corner stamp.
        let logoImg: Marks | null = null
        try {
          const marks = await window.electronAPI?.recorderGetWatermark?.()
          if (marks) logoImg = { light: await loadImage(marks.light), dark: await loadImage(marks.dark) }
        } catch {
          logoImg = null
        }
        if (!mounted) return

        // Always pipe through a <canvas> so the watermark can be composited
        // onto every recorded frame (region/window already needed canvas for
        // cropping; screen mode now does too for parity).
        const outStream = buildOutputStream(
          desktopStream,
          target,
          logoImg,
          videoElRef,
          canvasElRef,
          drawLoopRef,
          pausedRef,
          sampleStripTile,
        )
        outStreamRef.current = outStream

        // Try to pre-acquire mic so the toggle is instant (muted by default).
        // If permission is denied, just proceed without it — user can still record.
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          if (!mounted) { micStream.getTracks().forEach(t => t.stop()); return }
          micStreamRef.current = micStream
          const track = micStream.getAudioTracks()[0]
          if (track) {
            track.enabled = false
            outStream.addTrack(track)
          }
        } catch {
          // No mic — continue without audio track at all.
        }

        // Report whether a mic track was actually acquired so the toolbar can
        // disable the mic toggle — otherwise it shows a "live" mic while no
        // audio is being captured.
        window.electronAPI?.recorderReady?.(true, undefined, micStreamRef.current != null)
      } catch (err: any) {
        console.error('[recorder-host] acquire failed', err)
        window.electronAPI?.recorderReady?.(false, err?.message ?? String(err))
      }
    })()

    // A tile for the filmstrip, from the frame just drawn. Only while the
    // recorder runs, on the recorder's own clock (the file's timeline: it
    // stops during a pause), so tiles and file line up.
    function sampleStripTile(canvas: HTMLCanvasElement) {
      const sampler = stripRef.current
      const r = recorderRef.current
      if (!sampler || !r || r.state !== 'recording' || !clockRef.current.running) return
      const ms = clockRef.current.at(Date.now())
      if (!sampler.due(ms)) return
      try { sampler.add(ms, drawTile(canvas, canvas.width, canvas.height)) } catch { /* no tile for this frame */ }
    }

    // ── Listen for control signals from main ────────────────────────────

    const onBegin = () => {
      const out = outStreamRef.current
      if (!out || recorderRef.current) return

      const mime = pickMimeType()

      // Size the bitrate from what is actually encoded: the output canvas,
      // which buildOutputStream sized (crop, small-region upscale, even dims).
      // Fall back to the target's dims if the canvas isn't sized yet.
      const target = targetRef.current
      const canvas = canvasElRef.current
      const outW = canvas?.width
        || target?.outputSize?.width
        || Math.round((target?.displayDipSize.width  ?? 1920) * (target?.displayScaleFactor ?? 1))
      const outH = canvas?.height
        || target?.outputSize?.height
        || Math.round((target?.displayDipSize.height ?? 1080) * (target?.displayScaleFactor ?? 1))
      const videoBitsPerSecond = computeVideoBitrate(outW, outH, TARGET_FPS)

      const hasAudio = out.getAudioTracks().length > 0
      const options: MediaRecorderOptions & {
        videoKeyFrameIntervalDuration?: number
        videoBitrateMode?: 'constant' | 'variable'
      } = {
        mimeType: mime,
        videoBitsPerSecond,
        // Variable bitrate: static stretches of UI spend far fewer bits than
        // the target, so the budget goes to scrolls and animations. Chromium's
        // default is already variable; set explicitly so it can't drift.
        videoBitrateMode: 'variable',
        // A keyframe every second keeps the lossless trim (ffmpeg -c copy,
        // which can only start a clip on a keyframe) accurate to ~1 s.
        // Chromium's default can space keyframes very far apart. Not in TS's
        // DOM lib yet; browsers that don't know it ignore it.
        videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
        ...(hasAudio ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
      }
      const recorder = new MediaRecorder(out, options)
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = finalizeRecording
      recorder.start(1000)
      recorderRef.current = recorder
      pausedRef.current = false

      clockRef.current.start(Date.now())
      stripRef.current = new TileSampler<HTMLCanvasElement>()
      if (tickTimerRef.current) clearInterval(tickTimerRef.current)
      // The toolbar timer only renders whole seconds, so only emit a tick when
      // the displayed second changes — a quarter of the IPC/re-render traffic
      // of ticking every 250ms unconditionally, while staying responsive.
      let lastSentSec = -1
      tickTimerRef.current = setInterval(() => {
        const r = recorderRef.current
        if (!r) return
        if (r.state === 'recording') {
          const ms = clockRef.current.at(Date.now())
          const sec = Math.floor(ms / 1000)
          if (sec !== lastSentSec) {
            lastSentSec = sec
            window.electronAPI?.recorderTick?.(ms)
          }
        }
      }, 250)
    }

    const onPause = () => {
      const r = recorderRef.current
      if (!r || r.state !== 'recording') return
      pausedRef.current = true
      r.pause()
      clockRef.current.pause(Date.now())
    }

    const onResume = () => {
      const r = recorderRef.current
      if (!r || r.state !== 'paused') return
      pausedRef.current = false
      clockRef.current.resume(Date.now())
      r.resume()
    }

    const onStopRequest = () => {
      const r = recorderRef.current
      if (!r) return
      // Stopped (from a pause the clock already stands still).
      clockRef.current.pause(Date.now())
      if (r.state !== 'inactive') r.stop()   // triggers onstop → finalizeRecording
    }

    const onCancelRequest = () => {
      const r = recorderRef.current
      if (r && r.state !== 'inactive') {
        r.ondataavailable = null as any
        r.onstop = null as any
        try { r.stop() } catch { /* ignore */ }
      }
      chunksRef.current = []
      stripRef.current = null
      teardownStreams()
    }

    const onMicToggle = (enabled: boolean) => {
      const mic = micStreamRef.current
      if (!mic) return
      const track = mic.getAudioTracks()[0]
      if (track) track.enabled = enabled
    }

    window.electronAPI?.onRecorderBegin?.(onBegin)
    window.electronAPI?.onRecorderPause?.(onPause)
    window.electronAPI?.onRecorderResume?.(onResume)
    window.electronAPI?.onRecorderStopRequest?.(onStopRequest)
    window.electronAPI?.onRecorderCancelRequest?.(onCancelRequest)
    window.electronAPI?.onRecorderMicToggle?.(onMicToggle)

    return () => {
      mounted = false
      window.electronAPI?.removeAllListeners?.('recorder:begin')
      window.electronAPI?.removeAllListeners?.('recorder:pause')
      window.electronAPI?.removeAllListeners?.('recorder:resume')
      window.electronAPI?.removeAllListeners?.('recorder:stop-request')
      window.electronAPI?.removeAllListeners?.('recorder:cancel-request')
      window.electronAPI?.removeAllListeners?.('recorder:mic-toggle')
      if (tickTimerRef.current) clearInterval(tickTimerRef.current)
      teardownStreams()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function teardownStreams() {
    if (drawLoopRef.current) {
      drawLoopRef.current()
      drawLoopRef.current = null
    }
    try { desktopStreamRef.current?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    try { micStreamRef.current?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    try { outStreamRef.current?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    desktopStreamRef.current = null
    micStreamRef.current = null
    outStreamRef.current = null
  }

  async function finalizeRecording() {
    const chunks = chunksRef.current
    chunksRef.current = []
    const durationMs = clockRef.current.at(Date.now())
    // This recording's tiles, taken now: the thumbnail below is awaited, and
    // the ref mustn't be read after that.
    const sampler = stripRef.current
    stripRef.current = null
    const blob = new Blob(chunks, { type: 'video/webm' })
    teardownStreams()

    // No duration patch here: MediaRecorder omits the duration AND the Cues
    // seek index, and the main process now rebuilds both in one pass with
    // `ffmpeg -c copy` after the file lands on disk (streams from disk, flat
    // memory) — far cheaper than the old in-renderer fix-webm-duration, which
    // read the whole blob into memory.

    let thumbnail = ''
    try { thumbnail = await extractThumbnail(blob) } catch { /* ignore */ }
    // The filmstrip from the tiles taken along the way ('' when there are
    // none: the editor then decodes it once, as for older recordings).
    let strip = ''
    try {
      const tiles = sampler?.pick(durationMs) ?? []
      if (tiles.length > 0) strip = encodeStrip(stripFromTiles(tiles))
    } catch { /* '' */ }

    window.electronAPI?.recorderStateChange?.('saving')
    try {
      // Stream the blob to disk in bounded slices. Materializing the whole
      // recording as one contiguous ArrayBuffer (and structured-cloning it
      // across IPC) OOM'd the renderer / blew the clone limit on long
      // recordings; slicing keeps peak transfer memory at one slice.
      await window.electronAPI?.recorderSaveBegin?.()
      for (let offset = 0; offset < blob.size; offset += SAVE_SLICE_BYTES) {
        const slice = blob.slice(offset, Math.min(offset + SAVE_SLICE_BYTES, blob.size))
        const buf = await slice.arrayBuffer()
        await window.electronAPI?.recorderSaveChunk?.(buf)
      }
      await window.electronAPI?.recorderSaveEnd?.(thumbnail, durationMs, TARGET_FPS, strip)
    } catch (err: any) {
      window.electronAPI?.recorderStateChange?.('error', { error: err?.message ?? String(err) })
    }
  }

  // Invisible host — hide any stray video/canvas elements.
  return (
    <div style={{ display: 'none' }}>
      <video ref={videoElRef} muted playsInline />
      <canvas ref={canvasElRef} />
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────

// The watermark's numbers are shared/watermark.ts, the same ones
// electron/watermark.ts stamps images with (the mark + name, 10%, ink by the
// brightness under it).
/** Frames between brightness checks under the mark (~1s at 30fps). */
const WATERMARK_INK_EVERY = 30
type Marks = { light: HTMLImageElement; dark: HTMLImageElement }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

/** Pipe the desktop stream through a <video> + <canvas> so MediaRecorder
 *  consumes a stream we control. Region/window crops via srcRect; screen
 *  mode draws the full frame. Either way the watermark logo is composited
 *  in the bottom-left every frame, matching the still-image stamp.
 *
 *  The DIP→stream-pixel scale is derived from actual frame dims at draw
 *  time. The desktop stream is pinned to the display's physical resolution
 *  upstream via getUserMedia min=max constraints, so sx and sy should
 *  match the display's scale factor. */
function buildOutputStream(
  desktopStream: MediaStream,
  target: RecordingTarget,
  logoImg: Marks | null,
  videoRef: React.MutableRefObject<HTMLVideoElement | null>,
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
  loopRef: React.MutableRefObject<(() => void) | null>,
  pausedRef: React.MutableRefObject<boolean>,
  /** Called with the output canvas after every drawn frame. */
  onFrame: (canvas: HTMLCanvasElement) => void,
): MediaStream {
  const video = videoRef.current!
  const canvas = canvasRef.current!

  // Output canvas dims: explicit outputSize for region/window crops, full
  // physical desktop dims for screen mode.
  const isCrop = (target.kind === 'region' || target.kind === 'window') && target.rect != null && target.outputSize != null
  let outW = isCrop
    ? target.outputSize!.width
    : Math.max(1, Math.round(target.displayDipSize.width  * target.displayScaleFactor))
  let outH = isCrop
    ? target.outputSize!.height
    : Math.max(1, Math.round(target.displayDipSize.height * target.displayScaleFactor))

  // Small region/window crops get upscaled uniformly so the encoder has more
  // pixels to work with and downstream players don't have to stretch a tiny
  // video at playback. Screen mode is left alone — it's already at native
  // physical resolution, and bumping a 4K screen further is pure waste.
  if (isCrop) {
    const longest = Math.max(outW, outH)
    if (longest < MIN_OUTPUT_LONG_SIDE) {
      const k = MIN_OUTPUT_LONG_SIDE / longest
      outW = Math.round(outW * k)
      outH = Math.round(outH * k)
    }
    // VP9 prefers even dimensions for its 4×4 transform blocks; odd dims work
    // but some macroblocks pad and the edge column ends up softer.
    if (outW % 2) outW += 1
    if (outH % 2) outH += 1
  }

  canvas.width = outW
  canvas.height = outH

  video.srcObject = desktopStream
  video.muted = true
  video.playsInline = true
  video.play().catch(() => { /* autoplay policy — muted is allowed */ })

  const ctx = canvas.getContext('2d', { alpha: false })!
  // Default smoothing quality is 'low' (bilinear) — the upscale step above
  // would visibly soften UI text. 'high' is bicubic-class on Chromium and
  // is what we want when drawImage stretches the source.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Pre-compute watermark placement off the output canvas dims, not the
  // source stream — the logo follows the recorded frame even if the stream
  // is larger (region crop) or matches it (screen).
  // A fixed size on screen (2026-11-27), like the image stamp: output px per
  // point (a small crop is upscaled, so its own ratio), capped for tiny
  // outputs, left off under WATERMARK_MIN_PX.
  const pxPerPt = isCrop ? outW / target.rect!.width : target.displayScaleFactor
  const logoAspect = logoImg ? logoImg.light.naturalWidth / logoImg.light.naturalHeight : 1
  let logoH = Math.round(WATERMARK_PT * pxPerPt)
  if (logoH * logoAspect > outW * WATERMARK_MAX_W) logoH = Math.floor(outW * WATERMARK_MAX_W / logoAspect)
  if (logoH > outH * WATERMARK_MAX_H) logoH = Math.floor(outH * WATERMARK_MAX_H)
  if (logoH < WATERMARK_MIN_PX) logoImg = null
  const logoW = Math.round(logoH * logoAspect)
  const logoMargin = Math.max(2, Math.round(WATERMARK_MARGIN_PT * pxPerPt))
  const logoX = logoMargin
  const logoY = outH - logoH - logoMargin
  // The ink follows what's under the mark, checked every WATERMARK_INK_EVERY
  // frames (a small getImageData of the drawn frame, before the stamp).
  let ink: 'light' | 'dark' = 'light'
  let framesSinceInk = WATERMARK_INK_EVERY

  const drawFrame = () => {
    // While paused, skip the composite entirely — the recorder discards these
    // frames anyway, so compositing + watermarking them is pure waste.
    if (pausedRef.current) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw <= 0 || vh <= 0) return
    // The recorded part of the stream, in stream px.
    const sx = vw / target.displayDipSize.width
    const sy = vh / target.displayDipSize.height
    let srcX = 0, srcY = 0, srcW = vw, srcH = vh
    if (isCrop) {
      const rectDip = target.rect!
      srcX = Math.max(0, Math.min(vw - 1, Math.round(rectDip.x * sx)))
      srcY = Math.max(0, Math.min(vh - 1, Math.round(rectDip.y * sy)))
      srcW = Math.max(1, Math.min(vw - srcX, Math.round(rectDip.width  * sx)))
      srcH = Math.max(1, Math.min(vh - srcY, Math.round(rectDip.height * sy)))
    }
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH)
    if (logoImg) {
      if (++framesSinceInk >= WATERMARK_INK_EVERY) {
        framesSinceInk = 0
        try {
          const d = ctx.getImageData(logoX, logoY, Math.max(1, logoW), Math.max(1, logoH)).data
          let sum = 0, n = 0
          for (let i = 0; i < d.length; i += 16) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++ }
          ink = n && sum / n >= WATERMARK_INK_THRESHOLD ? 'dark' : 'light'
        } catch { /* keep the last ink */ }
      }
      ctx.globalAlpha = WATERMARK_OPACITY
      ctx.drawImage(logoImg[ink], logoX, logoY, logoW, logoH)
      ctx.globalAlpha = 1
    }
    onFrame(canvas)
  }

  // Prefer requestVideoFrameCallback so we redraw exactly once per source
  // frame — no duplicates when the display refreshes faster than the stream,
  // no missed frames when motion is heavy. rAF, by contrast, is tied to
  // display vsync, so the source's frame cadence and the draw cadence drift
  // and the encoder ends up either re-encoding identical frames (wasting
  // bits) or skipping fresh ones (visible judder).
  let cancelled = false
  type RvfcVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
  }
  const v = video as RvfcVideo
  if (typeof v.requestVideoFrameCallback === 'function') {
    const tick = () => {
      if (cancelled) return
      drawFrame()
      v.requestVideoFrameCallback!(tick)
    }
    v.requestVideoFrameCallback(tick)
    loopRef.current = () => { cancelled = true }
  } else {
    let raf = 0
    const tick = () => {
      if (cancelled) return
      drawFrame()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    loopRef.current = () => { cancelled = true; cancelAnimationFrame(raf) }
  }

  const stream = canvas.captureStream(TARGET_FPS)
  // Screen recordings are mostly text and UI edges: ask the encoder to keep
  // detail sharp and give up frame rate first when bits run short.
  const track = stream.getVideoTracks()[0]
  if (track) track.contentHint = 'detail'
  return stream
}

/** Extract a JPEG thumbnail from ~25% into the recorded blob. Handles the
 *  "duration = Infinity" edge case that MediaRecorder WebM files exhibit. */
function extractThumbnail(blob: Blob): Promise<string> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    let durationKnown = false
    let settled = false

    const cleanup = () => { URL.revokeObjectURL(url); video.src = '' }

    // Single settle path: clears the watchdog and resolves exactly once. A
    // malformed/stalled webm can fire neither onseeked nor onerror, which
    // would otherwise hang finalize forever (the toolbar sticks at
    // 'stopping') — the watchdog bails with no thumbnail after a few seconds.
    const done = (val: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(val)
    }
    const timer = setTimeout(() => done(''), 5000)

    const drawFrame = () => {
      try {
        const w = Math.min(video.videoWidth || THUMBNAIL_WIDTH, THUMBNAIL_WIDTH)
        const h = video.videoHeight
          ? Math.round(w * video.videoHeight / video.videoWidth)
          : Math.round(w * 9 / 16)
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
        done(canvas.toDataURL('image/jpeg', 0.75))
      } catch {
        done('')
      }
    }

    video.onloadedmetadata = () => {
      const d = video.duration
      if (isFinite(d) && d > 0) {
        durationKnown = true
        video.currentTime = d * 0.25
      } else {
        video.currentTime = 1e101   // forces Chromium to parse length
      }
    }
    video.onseeked = () => {
      if (!durationKnown) {
        const d = video.duration
        durationKnown = true
        if (isFinite(d) && d > 0) { video.currentTime = d * 0.25; return }
      }
      drawFrame()
    }
    video.onerror = () => done('')
    video.src = url
  })
}
