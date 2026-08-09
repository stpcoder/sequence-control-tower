import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // The OpenCode SDK publishes ESM-only conditional exports. Bundle it into
    // Electron's CommonJS main output so packaged startup never attempts a
    // disallowed `require("@opencode-ai/sdk/v2/client")`.
    plugins: [externalizeDepsPlugin({ exclude: ['@opencode-ai/sdk'] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  },
})
