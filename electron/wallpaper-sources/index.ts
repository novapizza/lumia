import { net } from 'electron'
import type { WallpaperBatch, WallpaperPhoto, WallpaperQuery, WallpaperSourceId } from '../../shared/wallpapers'
import { couldntReach, tooManyRequests, WALLPAPER_USER_AGENT as USER_AGENT, WALLPAPER_TIMEOUT_MS as NET_TIMEOUT_MS } from '../../shared/wallpapers'
import { commonsBatch, commonsSearchUrl } from './commons'
import { wallhavenBatch, wallhavenCredit, wallhavenCreditUrl, wallhavenSearchUrl } from './wallhaven'

/* Network entry for the wallpaper sources (2026-11-25): Wikimedia Commons and
   Wallhaven. Both get the app's User-Agent (Wikimedia asks for one; it names
   the app only, nothing about the user). The pure URL / parsing code lives
   in commons.ts and wallhaven.ts. */

const MAX_BYTES = 10 * 1024 * 1024

function getJson(source: WallpaperSourceId, url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', useSessionCookies: false })
    req.setHeader('User-Agent', USER_AGENT)
    req.setHeader('Api-User-Agent', USER_AGENT)
    let settled = false
    const fail = (err: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(err) }
    const timer = setTimeout(() => {
      try { req.abort() } catch { /* ignore */ }
      fail(new Error(couldntReach(source)))
    }, NET_TIMEOUT_MS)
    req.on('response', res => {
      if (res.statusCode === 429) { fail(new Error(tooManyRequests(source))); return }
      if (res.statusCode < 200 || res.statusCode >= 300) { fail(new Error(couldntReach(source, res.statusCode))); return }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BYTES) { try { req.abort() } catch { /* ignore */ } fail(new Error(couldntReach(source))); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          console.warn('[wallpapers] bad response', err)
          reject(new Error(couldntReach(source)))
        }
      })
      res.on('error', err => { console.warn('[wallpapers] response error', err); fail(new Error(couldntReach(source))) })
    })
    req.on('error', err => { console.warn('[wallpapers] request error', err); fail(new Error(couldntReach(source))) })
    req.end()
  })
}

/** One batch of desktop-shaped photos from a source. Throws with the shared messages. */
export async function fetchWallpapers(source: WallpaperSourceId, q: WallpaperQuery): Promise<WallpaperBatch> {
  if (source === 'commons') return commonsBatch(await getJson(source, commonsSearchUrl(q)), q.uhd)
  return wallhavenBatch(await getJson(source, wallhavenSearchUrl(q)), q.uhd)
}

/** The uploader and original link, where the source needs a second call (Wallhaven). Never throws. */
export async function creditFor(photo: WallpaperPhoto): Promise<Partial<WallpaperPhoto>> {
  if (photo?.source !== 'wallhaven') return {}
  try {
    const url = wallhavenCreditUrl(photo)
    if (!url) return {}
    return wallhavenCredit(await getJson('wallhaven', url))
  } catch {
    return {}
  }
}
