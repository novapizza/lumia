// Ambient types for the renderer's build-time env (Vite / electron-vite).
// electron-vite exposes `RENDERER_VITE_*` (and `VITE_*`) vars to the renderer
// via import.meta.env.

interface ImportMetaEnv {
  readonly MODE: string
  readonly DEV: boolean
  readonly PROD: boolean
  readonly SSR: boolean
  readonly BASE_URL: string
  /** Public Chrome Web Store listing URL for the scroll-capture extension. */
  readonly RENDERER_VITE_CHROME_WEB_STORE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
