/* The pages Lumia shows in the user's browser during the Google Drive
   connect flow (2026-11-26): the OAuth result pages ("Google Drive
   connected", "Couldn't connect Google Drive", "Couldn't open folder
   picker") and the folder picker page (resources/picker.html). They're
   drawn as one of the app's dialogs (STYLEGUIDE › Dialogs, the nearest
   rule), centred in the tab, in the app's theme (light / dark and the
   user's picks) and in Manrope, served by the same local server.

   No Electron imports: the HTML and CSS are built here from plain values,
   so the pages can be previewed outside the app. */

import { DEFAULTS, deriveRoles, type ThemeMode, type ThemePicks } from '../shared/theme-colors.ts'

/** Status roles, as in src/index.css (no custom theme moves them): the
 *  Drive pages use danger, the browser extension's UI all of them. */
const STATUS: Record<ThemeMode, Record<string, string>> = {
  dark: {
    'danger-subtle': '#371210', 'danger-text': '#e84b50',
    'warning-subtle': '#421e00', 'warning-text': '#e67a2a', 'success-text': '#6dd797',
    // The image clip colour (src/index.css): the extension's Region picker
    // draws its pick in it, like the capture overlay (2026-11-27).
    'kind-image': 'oklch(0.66 0.175 255)',
  },
  light: {
    'danger-subtle': '#ffecea', 'danger-text': '#c21725',
    'warning-subtle': '#ffead9', 'warning-text': '#b95a00', 'success-text': '#007742',
    'kind-image': 'oklch(0.55 0.175 255)',
  },
}

/** The Manrope weights the pages use: Body (400), Control and the
 *  message (500), Section (600). Served at /fonts/manrope-<weight>.woff2. */
export const PAGE_FONT_WEIGHTS = [400, 500, 600] as const

/** The path the pages load their stylesheet from. */
export const PAGE_CSS_PATH = '/lumia-page.css'

/** The roles for a mode with the user's picks, like the main window. */
export function pageRoles(mode: ThemeMode, picks: ThemePicks): Record<string, string> {
  return { ...DEFAULTS[mode], ...STATUS[mode], ...deriveRoles(picks, mode, { neutrals: true }) }
}

/** The stylesheet: the roles as CSS variables, then the dialog's look. */
export function pageCss(roles: Record<string, string>, mode: ThemeMode): string {
  const vars = Object.entries(roles).map(([k, v]) => `  --color-${k}: ${v};`).join('\n')
  const fonts = PAGE_FONT_WEIGHTS.map(w =>
    `@font-face { font-family: 'Manrope'; font-style: normal; font-weight: ${w}; font-display: block; src: url('/fonts/manrope-${w}.woff2') format('woff2'); }`,
  ).join('\n')
  // Icon lines (STYLEGUIDE › Icons): 1px at 14 / 16px, plus the 0.35px
  // boost for dark icons on a light ground.
  const iconLine = mode === 'light' ? '1.35px' : '1px'
  return `${fonts}
:root {
${vars}
  --color-focus: var(--color-accent);
  color-scheme: ${mode};
}
* { margin: 0; padding: 0; box-sizing: border-box; }
/* The tab is the window: its background under the dialogs' scrim, the
   box centred, at least 16px from the sides. Text isn't selectable, as in
   the app. */
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: linear-gradient(var(--color-scrim), var(--color-scrim)), var(--color-background);
  color: var(--color-fg);
  font-family: 'Manrope', sans-serif;
  user-select: none;
  cursor: default;
}
/* STYLEGUIDE › Dialogs: bg-elevated, border-line, rounded-lg, p-3, gap-3,
   400px like the PrintScreen prompt. */
.box {
  width: 400px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--color-elevated);
  border: 1px solid var(--color-line);
  border-radius: 8px;
}
/* Title (Section: 14px semibold fg) over the body (Body: 12px fg-secondary), gap-2. */
.text { display: flex; flex-direction: column; gap: 8px; }
h1 { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--color-fg); }
p { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-fg-secondary); }
p strong { font-weight: 500; color: var(--color-fg); }
/* A message inside, drawn like a toast of its kind: rounded-lg border-line
   px-3 py-2, the kind's pale fill, its 14px icon vertically centred however
   many lines, 12px medium fg, the reason in 11px medium fg-secondary. */
.message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-danger-subtle);
}
.message svg { flex-shrink: 0; width: 14px; height: 14px; color: var(--color-danger-text); }
.message .what { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--color-fg); }
.message .why { margin-top: 2px; font-size: 11px; line-height: 16px; font-weight: 500; color: var(--color-fg-secondary); overflow-wrap: break-word; }
/* A wait: the grey spinner (progress_activity, 16px) beside its label. */
.wait { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--color-fg-secondary); }
.wait svg { width: 16px; height: 16px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wait svg { animation: none; } }
svg { stroke-width: ${iconLine}; }
svg * { vector-effect: non-scaling-stroke; }
/* Buttons bottom right, gap-3. */
.buttons { display: flex; justify-content: flex-end; gap: 12px; }
/* ACCENT_BUTTON: h-8 px-2.5 rounded-lg, accent fill and edge, 12px medium
   on-accent; hover changes the fill only, instantly. The arrow cursor, as
   on every control. */
.accent {
  height: 32px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  cursor: default;
}
.accent:hover { background: var(--color-accent-hover); }
/* Focus ring: 2px focus, drawn inside the edge. */
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
[hidden] { display: none !important; }
`
}

/** Lucide's CircleAlert (the error toast's icon), 1px line. */
export const ALERT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export type ResultPage = {
  /** The tab's title. */
  tab: string
  title: string
  /** The body paragraph, as HTML (callers escape what they put in). A line
   *  that stands apart follows a blank line: `<br><br>`. */
  body: string
  /** A failure: what went wrong, and the raw reason under it. */
  error?: { message: string; detail?: string }
  /** The main action, a link. */
  action?: { label: string; href: string }
}

/** One of the OAuth result pages. */
export function resultPage(page: ResultPage): string {
  const error = page.error
    ? `<div class="message" role="alert">${ALERT_ICON}<div><div class="what">${escapeHtml(page.error.message)}</div>${
      page.error.detail ? `<div class="why">${escapeHtml(page.error.detail)}</div>` : ''
    }</div></div>`
    : ''
  const action = page.action
    ? `<div class="buttons"><a class="accent" href="${escapeHtml(page.action.href)}">${escapeHtml(page.action.label)}</a></div>`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="${PAGE_CSS_PATH}">
<title>${escapeHtml(page.tab)}</title>
</head>
<body>
<main class="box">
<div class="text"><h1>${escapeHtml(page.title)}</h1><p>${page.body}</p></div>
${error}${action}
</main>
</body>
</html>`
}

/** Where it's done in the app, for the pages' body lines. */
const IN_SETTINGS = 'in Lumia (Settings › Uploads)'

/** Signed in and the tokens saved: on to the folder. `pickHref`: the link
 *  that starts the folder picker (the sign-in's own key goes with it). */
export function connectedPage(pickHref = '/pick-folder'): string {
  return resultPage({
    tab: 'Google Drive connected',
    title: 'Google Drive connected',
    body: `Choose the folder your uploads go to.<br><br>You can change it anytime ${IN_SETTINGS}.`,
    action: { label: 'Choose folder', href: pickHref },
  })
}

/** Google sent an error back (or no code), or the code exchange failed. */
export function connectFailedPage(reason: { oauthError?: string | null; exchangeError?: string }): string {
  const error = reason.exchangeError !== undefined
    ? { message: "Sign-in didn't finish", detail: reason.exchangeError }
    : reason.oauthError === 'access_denied'
      ? { message: "Access wasn't allowed" }
      : reason.oauthError
        ? { message: 'Google returned an error', detail: reason.oauthError }
        : { message: "Sign-in didn't finish" }
  return resultPage({
    tab: "Couldn't connect Google Drive",
    title: "Couldn't connect Google Drive",
    body: `Try again ${IN_SETTINGS}.`,
    error,
  })
}

/** The Connected page's Choose folder couldn't start the picker. */
export function pickerFailedPage(detail: string): string {
  return resultPage({
    tab: "Couldn't open folder picker",
    title: "Couldn't open folder picker",
    body: `Try again ${IN_SETTINGS}.`,
    error: { message: "Picker didn't start", detail },
  })
}
