// The image editor's saved edit steps (History › Edits, 2026-11-23): one
// JSON file per history row under userData/edit-history/<id>.json, in the
// compact form from src/lib/edit-steps.ts (packHistory). Kept out of the
// history day files so the Dashboard never reads them. Removed with the
// row (HistoryStore) and when the row's drawings are dropped. Node fs only.

import { mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

/** Ids are app-made; anything else is refused so a path can't be built. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/
/** A runaway history is dropped rather than written. */
const MAX_BYTES = 8 * 1024 * 1024

export class EditHistoryStore {
  private readonly dir: string
  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'edit-history')
  }

  private file(id: string): string | null {
    return SAFE_ID.test(id) ? join(this.dir, `${id}.json`) : null
  }

  async get(id: string): Promise<unknown> {
    const f = this.file(id)
    if (!f) return null
    try { return JSON.parse(await readFile(f, 'utf8')) } catch { return null }
  }

  async save(id: string, data: unknown): Promise<boolean> {
    const f = this.file(id)
    if (!f || !data || typeof data !== 'object') return false
    const text = JSON.stringify(data)
    if (text.length > MAX_BYTES) return false
    await mkdir(this.dir, { recursive: true })
    const tmp = `${f}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, f)
    return true
  }

  /** Deletes every saved history (the setting turned off, 2026-11-23). */
  async clear(): Promise<void> {
    try { await rm(this.dir, { recursive: true, force: true }) } catch (err) {
      console.error('[edit-history] failed to clear', err)
    }
  }

  async remove(id: string): Promise<void> {
    const f = this.file(id)
    if (!f) return
    try { await unlink(f) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error('[edit-history] failed to remove', id, err)
    }
  }
}
