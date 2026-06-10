import { useMemo } from 'react'

/**
 * Returns a `lumia-media://` URL that streams the given local file into a
 * <video> element with Range support (required for seeking/buffering). The
 * main-process protocol handler proxies the request to the file via net.fetch,
 * so the renderer never reads the whole recording into memory as a Blob (a
 * multi-hundred-MB recording would otherwise OOM both processes) — and there's
 * no object URL to leak.
 */
export function useLocalVideoUrl(filePath: string | undefined | null): string {
  return useMemo(
    () => (filePath ? `lumia-media://stream/?path=${encodeURIComponent(filePath)}` : ''),
    [filePath],
  )
}
