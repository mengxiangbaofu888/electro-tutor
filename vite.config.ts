import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base 用相对路径，方便后续套 Capacitor 壳时以 file:// 加载
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: '电工陪练 - AI 出题与批改',
        short_name: '电工陪练',
        description:
          '导入电工/PLC 学习材料，自动生成知识大纲、出题组卷、批改评分，并针对薄弱点持续自进化。',
        lang: 'zh-CN',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 必须包含 mjs：pdfjs 的 worker 会被打成独立的 .mjs 资源，
        // 漏掉它会导致离线状态下 PDF 解析 404。
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest,woff2}'],
        // pdfjs 的 worker 比较大，放宽单文件缓存上限
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // 注意：Vite 8 底层是 rolldown，manualChunks 必须是函数，不能是对象
        manualChunks(id: string) {
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
