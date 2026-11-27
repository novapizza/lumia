/* Where Upload goes when there's more than one place (2026-11-23).
   R2 (the Lumia share link) and Google Drive can both be available: then a
   click on Upload opens a small menu with one row per destination, each
   either "Upload to …" (not there yet) or "Copy … link" (already there).
   With one row the button acts at once, no menu. Shared by the Dashboard's
   cards and list rows and the video editor. */

export type UploadDest = 'r2' | 'google-drive'

export const UPLOAD_DEST_NAME: Record<UploadDest, string> = {
  r2: 'Lumia',
  'google-drive': 'Google Drive',
}

export type UploadLinks = Partial<Record<UploadDest, string>>

export interface UploadRow {
  dest: UploadDest
  /** Already uploaded there: the row copies this link. */
  link?: string
}

/** The links a history row already has, per destination. */
export function uploadLinksOf(uploads: { destination: string; success: boolean; url?: string }[] | undefined): UploadLinks {
  const links: UploadLinks = {}
  for (const u of uploads ?? []) {
    if (!u.success || !u.url) continue
    if ((u.destination === 'r2' || u.destination === 'google-drive') && !links[u.destination]) links[u.destination] = u.url
  }
  return links
}

/** The menu's rows, R2 first: a destination with a link (copy it, even if
 *  that service is no longer set up), or one that's set up when the file
 *  is there to upload. */
export function uploadRows(opts: {
  r2Ready: boolean
  gdriveReady: boolean
  links: UploadLinks
  canUpload: boolean
}): UploadRow[] {
  const rows: UploadRow[] = []
  const ready: Record<UploadDest, boolean> = { r2: opts.r2Ready, 'google-drive': opts.gdriveReady }
  for (const dest of ['r2', 'google-drive'] as const) {
    const link = opts.links[dest]
    if (link) rows.push({ dest, link })
    else if (ready[dest] && opts.canUpload) rows.push({ dest })
  }
  return rows
}

/** The menu row's words. */
export function uploadRowLabel(row: UploadRow): string {
  return row.link ? `Copy ${UPLOAD_DEST_NAME[row.dest]} link` : `Upload to ${UPLOAD_DEST_NAME[row.dest]}`
}
