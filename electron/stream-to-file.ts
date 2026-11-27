import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Save a fetch response's body to `dest` without holding it in memory
 * (2026-11-27: bringing a recording back from its upload read the whole file
 * into one Buffer first, gigabytes for a long one). Streamed into a temp file
 * beside `dest` and renamed over it once complete, so `dest` is never half
 * written; a failed or cancelled download leaves nothing behind. Returns the
 * bytes written. Node only (no Electron), unit-tested.
 */
export async function saveResponseTo(
  res: { body: unknown },
  dest: string,
  signal?: AbortSignal,
): Promise<number> {
  if (!res.body) throw new Error('Empty response')
  const tmp = `${dest}.part-${Date.now().toString(36)}`
  let bytes = 0
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength
          yield chunk
        }
      },
      createWriteStream(tmp),
      { signal },
    )
    await rename(tmp, dest)
    return bytes
  } catch (err) {
    await unlink(tmp).catch(() => { /* never created */ })
    throw err
  }
}
