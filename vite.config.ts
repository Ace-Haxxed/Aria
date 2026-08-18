import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Tauri expects a fixed port and fails if it is not available.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/android/**', '**/ios/**'],
    },
  },

  // Strip diagnostics from the shipped bundle. Nothing user-facing should
  // depend on the console, and a release build has no devtools open to read it.
  esbuild: {
    drop: process.env.TAURI_ENV_DEBUG ? [] : ['console', 'debugger'],
  },

  // Tauri uses Chromium on Windows and WebKit on macOS/Linux, so the build
  // target follows the platform rather than browserslist.
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    outDir: 'dist',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split the dependencies that dominate the bundle. The markdown
        // pipeline in particular is only needed once a reply arrives, so
        // keeping it out of the entry chunk shortens time-to-interactive.
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'],
        },
      },
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
