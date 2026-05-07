import { Notification, nativeImage, app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface NotifyOptions {
  body: string
  /** Falls back to 'Lumia' when omitted. */
  title?: string
  /** Inline dataUrl (e.g. the captured image). */
  thumbnailDataUrl?: string
  /** Absolute path to an image file on disk. */
  thumbnailPath?: string
  /** Fired when the user clicks the toast body (both standard and
   *  toastXml notifications). Errors are swallowed so a bad handler
   *  can't crash the main process. */
  onClick?: () => void
}

const DEFAULT_TITLE = 'Lumia'
// Windows Toast hero image renders well at these bounds — anything
// wider gets downscaled by the shell anyway and bloats the temp file.
const MAX_IMAGE_WIDTH = 1024

// Live notifications keep their JS handlers attached. Without this list
// once `showNotification()` returns the local `n` reference goes out of
// scope and V8 may collect it before the user clicks the toast — at
// which point Electron has nothing to fire `click` on.
//
// We *don't* drop entries on 'close': on Windows that event fires when
// the banner trickles into Action Center, but the toast is still
// interactive there. Dropping early would let GC sweep the JS handler
// and Action Center clicks would silently no-op.
//
// Bounded ring (newest at index 0) caps memory at ~32 toasts × a few KB
// each — beyond that the oldest is evicted, accepting that very stale
// Action Center clicks may stop working in long-running sessions.
const liveNotifications: Notification[] = []
const MAX_LIVE_NOTIFICATIONS = 32

// Most-recent click callback. On Windows, when the user clicks a toast
// for an *already running* app, WinRT activates the AUMID — which trips
// our single-instance lock and surfaces as `app.on('second-instance')`
// instead of `notification.on('click')`. We fall back to invoking this
// callback in that handler so toast clicks still work in packaged builds.
let pendingNotificationClick: (() => void) | null = null
export function consumePendingNotificationClick(): (() => void) | null {
  const cb = pendingNotificationClick
  pendingNotificationClick = null
  return cb
}

/**
 * Single entry point for all toast notifications.
 *
 * Windows: builds a custom `toastXml` with a hero image so the
 * screenshot renders above the text (the default `icon` option only
 * produces a tiny app-logo badge). The image is written to the OS
 * temp dir first because WinRT toasts load images through the
 * file:/// URI scheme and won't accept data URLs.
 *
 * Other platforms: falls back to the standard `icon` field — macOS's
 * stock notification UI doesn't expose an inline-image slot so text
 * is all we can guarantee.
 */
export function showNotification(opts: NotifyOptions): void {
  if (!Notification.isSupported()) return

  const title = opts.title ?? DEFAULT_TITLE
  const imagePath = prepareImagePath(opts.thumbnailDataUrl, opts.thumbnailPath)

  // toastXml is the only path that lets us declare an activation handler
  // (`<toast launch="..." activationType="protocol">`). A plain
  // Notification produces a toast with no activation metadata, so clicks
  // on Windows are silent no-ops even with the AUMID registered. Dev
  // needs the AUMID-bearing Start Menu shortcut already on disk for the
  // toast to render at all — `ensureDevStartMenuShortcut()` plants it.
  const useToastXml = process.platform === 'win32' && !!imagePath

  const safeClick = opts.onClick
    ? () => { try { opts.onClick!() } catch { /* swallow */ } }
    : undefined

  // Latch the most recent callback so `second-instance` can replay it
  // on Windows packaged builds, where toast activation reaches us as
  // an instance launch rather than as `notification.on('click')`.
  if (safeClick) pendingNotificationClick = safeClick

  // Pin the JS object so V8 can't sweep it away mid-flight (which
  // silently detaches the click handler). Newest at the front; oldest
  // beyond the cap is evicted so the list stays bounded.
  const wire = (n: Notification) => {
    liveNotifications.unshift(n)
    if (liveNotifications.length > MAX_LIVE_NOTIFICATIONS) {
      liveNotifications.length = MAX_LIVE_NOTIFICATIONS
    }
    if (safeClick) n.on('click', safeClick)
  }

  const drop = (n: Notification) => {
    const idx = liveNotifications.indexOf(n)
    if (idx >= 0) liveNotifications.splice(idx, 1)
  }

  try {
    if (useToastXml && imagePath) {
      const xml = buildToastXml(title, opts.body, imagePath)
      const n = new Notification({ toastXml: xml })
      wire(n)
      // If WinRT rejects the XML (bad AUMID, malformed path, etc.), fall
      // back to a plain text toast so the user still sees something.
      n.on('failed', () => {
        drop(n)
        const fallback = new Notification({ title, body: opts.body, icon: imagePath })
        wire(fallback)
        fallback.show()
      })
      n.show()
      return
    }
    const n = new Notification({ title, body: opts.body, icon: imagePath })
    wire(n)
    n.show()
  } catch { /* silent */ }
}

// Resolve a usable on-disk image path. If we're given an inline data URL
// we decode → optionally downscale → write to the temp dir; the OS
// recycles that directory on its own so we don't track cleanup.
function prepareImagePath(dataUrl?: string, filePath?: string): string | undefined {
  try {
    if (filePath) return filePath
    if (!dataUrl) return undefined

    let img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return undefined
    const { width } = img.getSize()
    if (width > MAX_IMAGE_WIDTH) img = img.resize({ width: MAX_IMAGE_WIDTH, quality: 'good' })

    const buf = img.toPNG()
    const tempPath = join(app.getPath('temp'), `lumia-notif-${randomUUID()}.png`)
    writeFileSync(tempPath, buf)
    return tempPath
  } catch {
    return undefined
  }
}

// Minimal ToastGeneric template with a hero image. `placement="hero"`
// puts the image above the text — swap to no placement for an inline
// image below the body, or to `appLogoOverride` to replace the app
// icon badge instead.
//
// `<toast launch="lumia:notify" activationType="protocol">` is what
// makes the toast clickable: without it, Windows has no idea what to do
// when the user taps the body and silently no-ops. Protocol activation
// asks Windows to open the URL `lumia:notify` (or `lumia-dev:notify` in
// dev), which our registered scheme handler resolves by spawning
// electron — that hits our single-instance lock and replays the pending
// notification click.
function buildToastXml(title: string, body: string, imagePath: string): string {
  // Windows WinRT toasts want each path segment percent-encoded. The
  // easiest way to get that right across drive letters and UUIDs is to
  // pass the slashed path through `encodeURI`, which preserves the
  // `file:///` scheme but escapes spaces / unicode / the like.
  const src = encodeURI(`file:///${imagePath.replace(/\\/g, '/')}`)
  const protocol = app.isPackaged ? 'lumia' : 'lumia-dev'
  const launch = `${protocol}:notify`
  return [
    `<toast launch="${escapeXml(launch)}" activationType="protocol">`,
      '<visual>',
        '<binding template="ToastGeneric">',
          `<text>${escapeXml(title)}</text>`,
          `<text>${escapeXml(body)}</text>`,
          `<image placement="hero" src="${escapeXml(src)}"/>`,
        '</binding>',
      '</visual>',
    '</toast>',
  ].join('')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
