import { useEffect, useRef } from 'react'
import fixWebmDuration from 'fix-webm-duration'

interface RecordingTarget {
  kind: 'region' | 'window' | 'screen'
  sourceId: string
  displayId: number
  rect?: { x: number; y: number; width: number; height: number }
  displayDipSize: { width: number; height: number }
  displayScaleFactor: number
  outputSize?: { width: number; height: number }
}

const TARGET_FPS = 60
// Bits-per-pixel-per-frame quality factor. VP9 real-time mode is conservative
// for screen content with motion (scroll, animation), so we run hot: 0.25
// puts 1920×1080@60 at ≈30 Mbps and 1922×1200@60 at ≈34 Mbps. The
// MediaRecorder default is roughly 2.5 Mbps regardless of resolution, which
// crushes UI text on high-DPI displays.
const VIDEO_QUALITY_FACTOR = 0.25
// Hard ceiling so 4K@60 doesn't ask for the encoder to fill ~120 Mbps. WebM
// playback above ~50 Mbps gives diminishing returns for screen content.
const VIDEO_BITRATE_CAP = 50_000_000
const VIDEO_BITRATE_FLOOR = 4_000_000
const AUDIO_BITRATE = 192_000
// Region/window crops smaller than this (long-side, physical px) get
// uniformly upscaled to this baseline at draw time. Two reasons:
//   1. Players viewing the recording at full-screen or in the editor pane
//      would otherwise have to upscale a small video in real time, and
//      browser bilinear is visibly soft. Doing the upscale once at encode
//      time with high-quality canvas smoothing keeps subsequent playback
//      a pure downscale (which always looks crisper than upscale).
//   2. The encoder gets more pixels to spread bits over — at 0.25 bpp,
//      a 600×450 region was hitting the 4 Mbps floor; the same content
//      at 1280×960 lands at ~18 Mbps, so text strokes survive intact.
// Trade-off: small-region recordings now produce noticeably bigger files.
const MIN_OUTPUT_LONG_SIDE = 1280

// fix-webm-duration reads the entire blob into memory to rewrite the EBML
// header, so for very large recordings it's itself an OOM hazard. Above this
// size we skip the duration patch (the file stays playable, just without a
// seekbar duration) rather than risk crashing the finalize.
const DURATION_PATCH_MAX_BYTES = 1_500_000_000
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

  // Timing
  const runStartRef      = useRef<number>(0)
  const accumulatedMsRef = useRef<number>(0)
  const tickTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  // Set while paused so the canvas draw loop can skip the expensive
  // composite (and the watermark blend) for the entire pause duration —
  // otherwise it keeps compositing every source frame the paused recorder
  // just discards.
  const pausedRef        = useRef(false)

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

        // Decode the watermark logo once. Failure here is non-fatal — the
        // recording still proceeds, just without the corner stamp.
        let logoImg: HTMLImageElement | null = null
        try {
          const logoDataUrl = await window.electronAPI?.recorderGetWatermark?.()
          if (logoDataUrl) logoImg = await loadImage(logoDataUrl)
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

    // ── Listen for control signals from main ────────────────────────────

    const onBegin = () => {
      const out = outStreamRef.current
      if (!out || recorderRef.current) return

      const mime = pickMimeType()

      // Resolve actual output dimensions for bitrate sizing. Region/window
      // record from the canvas (outputSize); screen mode passes the full
      // physical desktop stream through.
      const target = targetRef.current
      const outW = target?.outputSize?.width
        ?? Math.round((target?.displayDipSize.width  ?? 1920) * (target?.displayScaleFactor ?? 1))
      const outH = target?.outputSize?.height
        ?? Math.round((target?.displayDipSize.height ?? 1080) * (target?.displayScaleFactor ?? 1))
      const videoBitsPerSecond = computeVideoBitrate(outW, outH, TARGET_FPS)

      const hasAudio = out.getAudioTracks().length > 0
      const recorder = new MediaRecorder(out, {
        mimeType: mime,
        videoBitsPerSecond,
        ...(hasAudio ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
      })
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = finalizeRecording
      recorder.start(1000)
      recorderRef.current = recorder
      pausedRef.current = false

      runStartRef.current = Date.now()
      accumulatedMsRef.current = 0
      if (tickTimerRef.current) clearInterval(tickTimerRef.current)
      // The toolbar timer only renders whole seconds, so only emit a tick when
      // the displayed second changes — a quarter of the IPC/re-render traffic
      // of ticking every 250ms unconditionally, while staying responsive.
      let lastSentSec = -1
      tickTimerRef.current = setInterval(() => {
        const r = recorderRef.current
        if (!r) return
        if (r.state === 'recording') {
          const ms = accumulatedMsRef.current + (Date.now() - runStartRef.current)
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
      accumulatedMsRef.current += Date.now() - runStartRef.current
    }

    const onResume = () => {
      const r = recorderRef.current
      if (!r || r.state !== 'paused') return
      pausedRef.current = false
      runStartRef.current = Date.now()
      r.resume()
    }

    const onStopRequest = () => {
      const r = recorderRef.current
      if (!r) return
      if (r.state === 'paused') accumulatedMsRef.current += 0
      else if (r.state === 'recording') accumulatedMsRef.current += Date.now() - runStartRef.current
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
    const durationMs = accumulatedMsRef.current
    let blob = new Blob(chunks, { type: 'video/webm' })
    teardownStreams()

    // MediaRecorder streams WebM progressively and never writes the duration
    // cue, so without this patch `<video>.duration` is Infinity and no player
    // (Lumia, VLC, browsers) can show a correct timeline. Inject the real
    // duration into the EBML header before the file touches disk. Skip for
    // huge recordings — fix-webm-duration buffers the whole blob and would
    // itself OOM (the file is still playable, just without a seekbar length).
    if (durationMs > 0 && blob.size <= DURATION_PATCH_MAX_BYTES) {
      try { blob = await fixWebmDuration(blob, durationMs, { logger: false }) }
      catch { /* fall back to unpatched blob — still playable, just no duration */ }
    }

    let thumbnail = ''
    try { thumbnail = await extractThumbnail(blob) } catch { /* ignore */ }

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
      await window.electronAPI?.recorderSaveEnd?.(thumbnail, durationMs)
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

// Watermark constants. Mirror electron/watermark.ts so the corner stamp on
// recorded frames matches the one applied to still images.
const WATERMARK_SIZE_PCT = 0.025
const WATERMARK_OPACITY = 0.2
const WATERMARK_MARGIN_PCT = 0.15

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
  logoImg: HTMLImageElement | null,
  videoRef: React.MutableRefObject<HTMLVideoElement | null>,
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
  loopRef: React.MutableRefObject<(() => void) | null>,
  pausedRef: React.MutableRefObject<boolean>,
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
  const logoW = Math.max(12, Math.round(Math.min(outW, outH) * WATERMARK_SIZE_PCT))
  const logoAspect = logoImg ? logoImg.naturalHeight / logoImg.naturalWidth : 1
  const logoH = Math.round(logoW * logoAspect)
  const logoMargin = Math.max(2, Math.round(logoW * WATERMARK_MARGIN_PCT))
  const logoX = logoMargin
  const logoY = outH - logoH - logoMargin

  const drawFrame = () => {
    // While paused, skip the composite entirely — the recorder discards these
    // frames anyway, so compositing + watermarking them is pure waste.
    if (pausedRef.current) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw <= 0 || vh <= 0) return
    if (isCrop) {
      const rectDip = target.rect!
      const sx = vw / target.displayDipSize.width
      const sy = vh / target.displayDipSize.height
      const srcX = Math.max(0, Math.min(vw - 1, Math.round(rectDip.x * sx)))
      const srcY = Math.max(0, Math.min(vh - 1, Math.round(rectDip.y * sy)))
      const srcW = Math.max(1, Math.min(vw - srcX, Math.round(rectDip.width  * sx)))
      const srcH = Math.max(1, Math.min(vh - srcY, Math.round(rectDip.height * sy)))
      ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH)
    } else {
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, outW, outH)
    }
    if (logoImg) {
      ctx.globalAlpha = WATERMARK_OPACITY
      ctx.drawImage(logoImg, logoX, logoY, logoW, logoH)
      ctx.globalAlpha = 1
    }
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

  return canvas.captureStream(TARGET_FPS)
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
        const w = Math.min(video.videoWidth || 640, 640)
        const h = video.videoHeight
          ? Math.round(w * video.videoHeight / video.videoWidth)
          : 360
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
