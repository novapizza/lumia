import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'

// Self-hosted fonts. Each `*.css` brings its woff2 alongside; Vite bundles
// them into out/renderer/assets/. Importing them here (before index.css) so
// the @font-face rules are registered before any class consumes them, and
// before app code paints anything.
//
// `latin-{weight}.css` ships only the Latin subset — drops cyrillic/greek/
// vietnamese/latin-ext that would otherwise inflate the installer by ~1.4 MB
// without any user-visible benefit (Lumia's UI is English-only).
import '@fontsource/manrope/latin-300.css'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'

import './index.css'

// Platform class for the `mac:` Tailwind variant (index.css). macOS has no
// title bar: the traffic lights sit on the sidebar and page headers are the
// drag regions, so layout differs from Windows.
if (window.electronAPI?.platform === 'darwin') {
  document.documentElement.classList.add('mac')
}

// Standalone transparent windows (annotation overlay, palette, recording
// toolbar/border, recorder host) must have a transparent
// body from the very first paint — otherwise the dark gradient body that
// the main app routes use shows up for one frame and looks like a flash
// when the BrowserWindow appears. Set this synchronously before React
// renders so even ready-to-show fires against an already-clear body.
const TRANSPARENT_HASHES = [
  '#/annotation-overlay',
  '#/recording-toolbar',
  '#/recording-border',
  '#/recorder-host',
]
if (TRANSPARENT_HASHES.some(h => window.location.hash === h || window.location.hash.startsWith(h + '?') || window.location.hash.startsWith(h + '/'))) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.backgroundImage = 'none'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <App />
  </HashRouter>
)
