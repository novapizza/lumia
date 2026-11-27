/* What the main window still owes recordings, and in which order (no DOM
   or Electron here: unit-tested). Two kinds of work, both needing a video
   decoder: a card preview for a recording that has none (found by a folder
   scan, a failed grab at save) and the video editor's filmstrip for one
   made before the recorder brought its own.

   Order (Jasper, 2026-11-27): what he's looking at first. Previews before
   any strip, since a blank card shows and a missing strip doesn't until
   the clip is opened; in each, the clips on screen first, in screen order,
   then the rest as they arrived. The next job is picked from the view at
   that moment, never from a list sorted once. */

/** A history row as far as this needs it (`needsPreview` / `needsStrip`
 *  are set by main on the rows it hands the window). */
export interface StripJobRow {
  id: string
  type: string
  filePath?: string
  annotatedFilePath?: string
  fileMissing?: boolean
  durationMs?: number
  needsPreview?: boolean
  needsStrip?: boolean
}

export interface StripJob {
  id: string
  /** The original recording: the strip is always of it. */
  filePath: string
  /** What the card stands for: the trimmed clip when there is one. */
  previewPath: string
  trimmed: boolean
  preview: boolean
  strip: boolean
  /** The original's length when the row knows it (a file whose remux
   *  failed has none in its header). */
  durationMs?: number
  /** Order of arrival. */
  seq: number
}

export type StripJobKind = 'preview' | 'strip'

export class StripJobs {
  private jobs = new Map<string, StripJob>()
  // Done or failed: not taken up again this session (a file that can't be
  // read would otherwise be tried on every reload of its day).
  private settled = { preview: new Set<string>(), strip: new Set<string>() }
  private seq = 0

  get size(): number { return this.jobs.size }

  /** A row main handed over (a day loaded or reloaded): note what it still
   *  needs. The latest row counts. */
  offer(row: StripJobRow): void {
    if (row.type !== 'recording' || !row.filePath || row.fileMissing) { this.jobs.delete(row.id); return }
    const preview = !!row.needsPreview && !this.settled.preview.has(row.id)
    const strip = !!row.needsStrip && !this.settled.strip.has(row.id)
    if (!preview && !strip) { this.jobs.delete(row.id); return }
    const had = this.jobs.get(row.id)
    this.jobs.set(row.id, {
      id: row.id,
      filePath: row.filePath,
      previewPath: row.annotatedFilePath || row.filePath,
      trimmed: !!row.annotatedFilePath,
      preview,
      strip,
      durationMs: row.durationMs,
      seq: had?.seq ?? this.seq++,
    })
  }

  /** The next thing to do with `visible` (ids, in screen order) on screen,
   *  or null when nothing is left. The job stays until it's settled, so one
   *  that was interrupted comes up again. */
  next(visible: string[]): { job: StripJob; kind: StripJobKind } | null {
    for (const kind of ['preview', 'strip'] as const) {
      for (const id of visible) {
        const job = this.jobs.get(id)
        if (job?.[kind]) return { job, kind }
      }
      let first: StripJob | null = null
      for (const job of this.jobs.values()) if (job[kind] && (!first || job.seq < first.seq)) first = job
      if (first) return { job: first, kind }
    }
    return null
  }

  /** Whether any job of that kind is waiting. */
  has(kind: StripJobKind): boolean {
    for (const job of this.jobs.values()) if (job[kind]) return true
    return false
  }

  /** That part is wanted again (its file was deleted outside Lumia): the
   *  row's next offer counts. */
  reopen(id: string, kind: StripJobKind): void {
    this.settled[kind].delete(id)
  }

  /** That part is done, or can't be done. */
  settle(id: string, kind: StripJobKind): void {
    this.settled[kind].add(id)
    const job = this.jobs.get(id)
    if (!job) return
    job[kind] = false
    if (!job.preview && !job.strip) this.jobs.delete(id)
  }
}
