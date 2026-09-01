import ReactDOM from 'react-dom/client'
import Overlay from './windows/overlay/Overlay'

// Lean renderer entry for the pooled capture overlays (src/overlay.html).
// Every display keeps one of these renderers alive for the whole session, so
// anything imported here is paid once per monitor. Load only what the
// overlay's own toolbar renders with: the Inter weights it uses, the Material
// Symbols subset and the shared stylesheet — no router, no dashboard/editor
// chunks, no Manrope (headline font, unused here).
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import './assets/fonts/material-symbols.css'
import './index.css'

// Transparent from the very first paint — the dark body the main app routes
// use would otherwise show for a frame when the window surfaces.
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
document.body.style.backgroundImage = 'none'

ReactDOM.createRoot(document.getElementById('root')!).render(<Overlay />)
