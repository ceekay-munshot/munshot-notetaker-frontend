import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// The UI is a React SPA built to ./dist and served by the Cloudflare Worker
// (worker/index.js) as static assets. All data comes from the Worker's /api/*
// routes. In local dev, `vite` runs the SPA and proxies /api to the Worker dev
// server (`wrangler dev`, default :8787) so the real backend is exercised.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.WORKER_ORIGIN || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
