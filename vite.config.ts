import { defineConfig } from 'vite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    {
      name: 'boot-splash-assets',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const mark = readFileSync(new URL('./public/agent-mark-144.webp', import.meta.url))
          const theme = readFileSync(new URL('./public/boot-theme.js', import.meta.url))
          const revision = createHash('sha256').update(theme).digest('hex').slice(0, 16)
          return html.replace('__BOOT_MARK_IMAGE__', 'data:image/webp;base64,' + mark.toString('base64'))
            .replace('src="/boot-theme.js"', `src="/boot-theme.js?v=${revision}"`)
        },
      },
    },
  ],
  build: {
    rollupOptions: {
      input: ['index.html', 'appeal/index.html'],
      output: {
        // 把体积大且极少变化的基础库拆成独立 chunk，发版后用户可继续命中缓存
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query', 'zustand'],
          // 多个页面复用的图标一起交付，避免手机首次切页时逐个请求微小模块。
          'icons': ['lucide-react'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      }
    }
  }
})
