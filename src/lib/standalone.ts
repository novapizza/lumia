// The capture overlay is not a route any more — it has its own entry
// (src/overlay.html) so the per-display pooled renderers stay lean.
const STANDALONE_ROUTES = ['/recording-toolbar', '/recording-border', '/recorder-host', '/annotation-overlay']

/** A standalone window (recording toolbar / border, recorder host,
 *  annotation overlay): rendered by App, but no AppBar. They take the app's
 *  theme from main (useFullTheme, 2026-11-24; they were always dark). */
export function isStandaloneHash(): boolean {
  const hash = window.location.hash.replace(/^#/, '')
  return STANDALONE_ROUTES.some(r => hash === r || hash.startsWith(r + '?') || hash.startsWith(r + '/'))
}
