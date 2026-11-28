/* The recording frame rate, for the three things that need it: the recorder
   (RecorderHost.tsx records at it), main (it's saved on the recording's
   history row) and the video editor (←/→ step one frame of it). It used to
   be written in the recorder and again in the editor, and the two drifted
   apart when the recorder went from 60 to 30 (2026-11-27). */

/** Frames per second new recordings are made at. 30 is plenty for screen
 *  content: the desktop-capture → canvas pipeline only delivered ~34 fps
 *  when asked for 60. */
export const RECORDING_FPS = 30

/** A recording's frame rate from its history row (`HistoryItem.fps`), or the
 *  current rate when the row has none (recorded before 2026-11-27) or holds
 *  something that isn't a usable rate. */
export function recordingFps(fps: unknown): number {
  return typeof fps === 'number' && Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : RECORDING_FPS
}

/** The frame rate ffmpeg reports for a file's video stream, from the text
 *  `ffmpeg -i` prints ("… 3840x2160, …, 60 fps, 60 tbr, 1k tbn"), as a whole
 *  number; undefined when it names none (MediaRecorder files often carry no
 *  rate: "… 1k tbr, 1k tbn"). For recordings saved before the rate was kept
 *  on their row. */
export function fpsFromFfmpegInfo(text: string): number | undefined {
  const line = text.split('\n').find(l => /Stream #.*Video:/.test(l))
  const m = line && /,\s*(\d+(?:\.\d+)?)\s*fps\b/.exec(line)
  if (!m) return undefined
  const fps = Math.round(Number(m[1]))
  return fps >= 1 && fps <= 240 ? fps : undefined
}
