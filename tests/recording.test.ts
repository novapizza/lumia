import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECORDING_FPS, recordingFps, fpsFromFfmpegInfo } from '../shared/recording.ts'

test('recordingFps keeps a saved rate and falls back for rows without a usable one', () => {
  assert.equal(recordingFps(60), 60)
  assert.equal(recordingFps(24), 24)
  assert.equal(recordingFps(29.97), 29.97)
  // Recorded before the rate was saved, or a hand-edited row.
  assert.equal(recordingFps(undefined), RECORDING_FPS)
  assert.equal(recordingFps(null), RECORDING_FPS)
  assert.equal(recordingFps('60'), RECORDING_FPS)
  assert.equal(recordingFps(0), RECORDING_FPS)
  assert.equal(recordingFps(-30), RECORDING_FPS)
  assert.equal(recordingFps(NaN), RECORDING_FPS)
  assert.equal(recordingFps(Infinity), RECORDING_FPS)
  assert.equal(recordingFps(1000), RECORDING_FPS)
})

test('one frame of a recording, in ms, follows its own rate', () => {
  assert.equal(1000 / recordingFps(60), 1000 / 60)
  assert.equal(Math.round(1000 / recordingFps(undefined)), Math.round(1000 / RECORDING_FPS))
})

// Lines as ffmpeg printed them for real Lumia recordings (2026-11-27).
const INFO = (video: string) => `Input #0, matroska,webm, from 'recording.webm':
  Metadata:
    encoder         : Lavf61.7.100
  Duration: 00:00:19.20, start: 0.000000, bitrate: 4521 kb/s
  Stream #0:0(eng): Video: ${video}
  Stream #0:1(eng): Audio: opus, 48000 Hz, mono, fltp (default)`

test('fpsFromFfmpegInfo reads the video stream\'s rate as a whole number', () => {
  assert.equal(fpsFromFfmpegInfo(INFO('vp9 (Profile 0), yuv420p(tv, bt709), 3840x2160, SAR 1:1 DAR 16:9, 60 fps, 60 tbr, 1k tbn (default)')), 60)
  assert.equal(fpsFromFfmpegInfo(INFO('vp9 (Profile 0), yuv420p(tv, bt709), 1932x970, SAR 1:1 DAR 966:485, 29.50 fps, 29.50 tbr, 1k tbn (default)')), 30)
  assert.equal(fpsFromFfmpegInfo(INFO('vp8, yuv420p(progressive), 1280x720, 23.98 fps, 23.98 tbr, 1k tbn')), 24)
})

test('fpsFromFfmpegInfo: a file that names no rate, or no video, gives none', () => {
  assert.equal(fpsFromFfmpegInfo(INFO('vp9 (Profile 0), yuv420p(tv, bt709), 1280x612, SAR 1:1 DAR 320:153, 1k tbr, 1k tbn (default)')), undefined)
  assert.equal(fpsFromFfmpegInfo('recording.webm: No such file or directory'), undefined)
  assert.equal(fpsFromFfmpegInfo(''), undefined)
  // The audio line's numbers are never taken for a rate.
  assert.equal(fpsFromFfmpegInfo('  Stream #0:0: Audio: opus, 48000 Hz, mono, fltp'), undefined)
  assert.equal(fpsFromFfmpegInfo(INFO('vp9, yuv420p, 640x480, 1000 fps, 1k tbr, 1k tbn')), undefined)
})

