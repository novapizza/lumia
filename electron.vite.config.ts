import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // uuid is pure ESM (v14+) — bundle it instead of emitting a CJS require()
    plugins: [externalizeDepsPlugin({ exclude: ['uuid'] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/index.ts')
      }
    }
  },
  preload: {
    // uuid is pure ESM (v14+) — bundle it instead of emitting a CJS require()
    plugins: [externalizeDepsPlugin({ exclude: ['uuid'] })],
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
