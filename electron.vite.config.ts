import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// electron-vite 5: dependency externalization is on by default via
// `build.externalizeDeps` (the old externalizeDepsPlugin is deprecated).
// uuid (v14+) and electron-store (v9+) are pure ESM — exclude them so they get
// bundled into the CJS main output instead of being emitted as require()s.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['uuid', 'electron-store'] },
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
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html')
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
