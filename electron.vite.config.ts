import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// electron-vite 6 (Vite 8 / Rolldown): dependency externalization is on by default via
// `build.externalizeDeps` (the old externalizeDepsPlugin is deprecated).
// uuid (v14+) and electron-store (v9+) are pure ESM — exclude them so they get
// bundled into the CJS main output instead of being emitted as require()s.
// ffmpeg-static is a devDependency (GPL — must never ship) that main only
// require()s in dev, so it's listed in `include` to stay an external require
// (dev resolves it from node_modules) instead of being inlined into the bundle.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['uuid', 'electron-store'], include: ['ffmpeg-static'] },
      lib: {
        entry: resolve(__dirname, 'electron/index.ts')
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      // electron-vite leaves every target unminified by default. The renderer
      // bundles are parsed by the main window *and* by one pooled overlay per
      // display, so ship them minified with Vite 8's Oxc minifier (react-dom alone
      // is ~540 KB → ~180 KB).
      minify: 'oxc',
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          // Lean entry for the pooled capture overlays (see src/overlay-main.tsx).
          overlay: resolve(__dirname, 'src/overlay.html'),
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
