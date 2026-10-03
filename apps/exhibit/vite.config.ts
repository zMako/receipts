import { defineConfig } from 'vite'

// API_TARGET lets a second server instance (for isolated testing) be targeted without editing this file.
const target = process.env.API_TARGET ?? 'http://localhost:8787'

export default defineConfig({
  server: {
    port: Number(process.env.EXHIBIT_PORT ?? 5173),
    // Public demo through a cloudflared quick tunnel.
    allowedHosts: ['.trycloudflare.com', 'localhost'],
    proxy: {
      '/api': target,
      '/live': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
})
