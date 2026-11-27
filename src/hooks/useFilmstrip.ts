import { useEffect, useRef, useState } from 'react'
import { buildStripFromVideo, encodeStrip, loadStrip, type StripSprite } from '../lib/filmstrip-build'
import { tilesInStrip } from '../lib/filmstrip'
import { editorBuildStarted, editorBuildDone, reportFileGone } from '../lib/strip-worker'

/** The filmstrip of the recording the video editor has open, or null until
 *  it's there.
 *
 *  Asked for when the editor opens (not when the trim bar mounts), so the
 *  saved strip is loaded by the time the bar draws its first frame. A
 *  recording without one (made before 2026-11-27, restored from the cloud,
 *  not reached by the background work yet) gets it decoded here, shown in
 *  one paint and saved for next time. `src` is the original recording: a
 *  trim doesn't change the strip. `durationMs`: the length the editor's
 *  player has found (0 until it has), for a file whose header has none. */
export function useFilmstrip(historyId: string | undefined, src: string | undefined, durationMs = 0): StripSprite | null {
  const [strip, setStrip] = useState<StripSprite | null>(null)
  const durationRef = useRef(durationMs)
  durationRef.current = durationMs
  useEffect(() => {
    setStrip(null)
    if (!historyId || !src) return
    let cancelled = false
    const abort = new AbortController()
    void (async () => {
      const saved = await window.electronAPI?.getFilmstrip?.(historyId).catch(() => null)
      if (cancelled) return
      if (saved?.url) {
        try {
          const loaded = await loadStrip(saved.url)
          if (!cancelled) setStrip(loaded)
          return
        } catch {
          // Unreadable, most likely deleted outside Lumia: main takes it
          // off the row if so, and it's built again below.
          void reportFileGone(historyId, 'strip')
        }
      }
      if (cancelled) return
      // The open clip comes first: the background work steps aside while
      // this one is built (strip-worker.ts).
      editorBuildStarted()
      let built: HTMLCanvasElement | null = null
      try {
        built = await buildStripFromVideo(src, { signal: abort.signal, durationMs: () => durationRef.current })
      } finally {
        editorBuildDone(built ? historyId : undefined)
      }
      if (!built || cancelled) return
      setStrip({ source: built, tiles: tilesInStrip(built.width) })
      void window.electronAPI?.saveFilmstrip?.(historyId, encodeStrip(built))
    })()
    return () => { cancelled = true; abort.abort() }
  }, [historyId, src])
  return strip
}
