/* Makes what strip-jobs.ts lists, in the main window, one at a time: card
   previews for recordings that have none, then filmstrips (2026-11-27).
   The order is strip-jobs.ts's; this file adds what needs the page: which
   clips are on screen right now, the decoder, and stepping aside for the
   video editor. */
import type { HistoryItem } from '../types'
import { StripJobs } from './strip-jobs'
import { buildStripFromVideo, encodeStrip, mediaUrl } from './filmstrip-build'
import { grabVideoFrame } from './video-frame'

const jobs = new StripJobs()
let running = false
/** The video editor is building the open clip's strip: nothing else decodes. */
let editorBuilds = 0
/** What's being decoded here, so it can be interrupted: by the editor
 *  (either kind), or a strip by a card preview that turns up. */
let current: { abort: AbortController; kind: 'preview' | 'strip' } | null = null
let retry: ReturnType<typeof setTimeout> | undefined

/** A breath between two strips (each is 0.2 to 1.2 s of decoding). */
const STRIP_GAP_MS = 300
/** Asked again this long after a recording was found running. */
const RECORDING_RETRY_MS = 5000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The clips on screen in the Dashboard at this moment, top to bottom
 *  (none when another page is up). Asked at every pick, so scrolling or
 *  opening the editor changes what comes next. */
function clipsOnScreen(): string[] {
  const area = document.querySelector<HTMLElement>('[data-scroll-area]')
  if (!area) return []
  const box = area.getBoundingClientRect()
  const ids: string[] = []
  for (const el of area.querySelectorAll<HTMLElement>('[data-clip][data-id]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > box.top && r.top < box.bottom && el.dataset.id) ids.push(el.dataset.id)
  }
  return ids
}

async function run(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      if (editorBuilds > 0) return // started again when the editor is done
      if (jobs.size === 0) return
      if (!(await window.electronAPI?.filmstripCanRun?.())) {
        clearTimeout(retry)
        retry = setTimeout(() => { void run() }, RECORDING_RETRY_MS)
        return
      }
      if (editorBuilds > 0) return
      // Picked last, right before the work: from what's waiting and what's
      // on screen now, not from before the question to main.
      const pick = jobs.next(clipsOnScreen())
      if (!pick) return
      const { job, kind } = pick
      const abort = new AbortController()
      current = { abort, kind }
      if (kind === 'preview') {
        // The frame the recorder takes: a quarter in (a trimmed clip's first).
        const frame = await grabVideoFrame(mediaUrl(job.previewPath), job.trimmed ? { ms: 0 } : { fraction: 0.25 }, undefined, abort.signal).catch(() => undefined)
        current = null
        // Interrupted by the editor: the job stays and comes up again.
        if (abort.signal.aborted) continue
        if (frame) await window.electronAPI?.saveFilmstrip?.(job.id, '', frame)
        jobs.settle(job.id, 'preview')
        continue
      }
      const built = await buildStripFromVideo(mediaUrl(job.filePath), { signal: abort.signal, durationMs: job.durationMs })
      current = null
      if (abort.signal.aborted) continue
      if (built) await window.electronAPI?.saveFilmstrip?.(job.id, encodeStrip(built))
      jobs.settle(job.id, 'strip')
      await sleep(STRIP_GAP_MS)
    }
  } catch (err) {
    console.warn('[filmstrip] background work stopped', err)
  } finally {
    running = false
  }
}

/** Rows main just handed over (a day loaded or reloaded). */
export function offerRows(rows: HistoryItem[]): void {
  for (const row of rows) jobs.offer(row)
  // A blank card showed up while a strip is in the works: the strip is
  // dropped (and done again later), so the card doesn't wait a second or
  // three behind it.
  if (current?.kind === 'strip' && jobs.has('preview')) current.abort.abort()
  if (jobs.size > 0) void run()
}

// Reports already sent, so an image that keeps failing asks once.
const reported = new Set<string>()

/** A row's card preview or strip failed to load in the window. Main checks
 *  whether the file is really gone and, if so, takes it off the row; the
 *  preview is then made again (by main for an image, by this worker for a
 *  recording once its day has reloaded). Asked once per file and session. */
export function reportFileGone(id: string, kind: 'thumbnail' | 'strip'): Promise<boolean> {
  const key = `${kind}:${id}`
  if (reported.has(key)) return Promise.resolve(false)
  reported.add(key)
  // Before asking: the row's reload can arrive ahead of main's answer.
  jobs.reopen(id, kind === 'thumbnail' ? 'preview' : 'strip')
  return window.electronAPI?.reportFileGone?.(id, kind).catch(() => false) ?? Promise.resolve(false)
}

/** The video editor starts building the open clip's strip: whatever is
 *  being decoded here, a strip or a preview, is dropped at once (its waits
 *  end with the abort) and done again later, so the editor doesn't wait or
 *  share the decoder. */
export function editorBuildStarted(): void {
  editorBuilds++
  current?.abort.abort()
}

/** The editor's build ended; `builtId`: it made that recording's strip, so
 *  it's off the list. */
export function editorBuildDone(builtId?: string): void {
  editorBuilds = Math.max(0, editorBuilds - 1)
  if (builtId) jobs.settle(builtId, 'strip')
  if (editorBuilds === 0 && jobs.size > 0) void run()
}
