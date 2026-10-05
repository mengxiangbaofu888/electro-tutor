import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * UI 预览构建配置（**不参与正式发布**）。
 *
 * 和 vite.single.config.ts 的区别是入口：这里用 preview.html → src/preview.tsx，
 * 那个入口会先注入内存版 IndexedDB 和一批示例数据，于是整份产物
 * 可以在 file:// 下直接渲染，方便截图检查界面。
 *
 * 关键点：必须关掉代码分割（codeSplitting: false），把动态 import 也打进同一个文件——
 * file:// 下加载额外的 chunk 会被浏览器拦掉。
 *
 * 用法：node scripts/build-preview.mjs
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: 'preview.html',
      output: {
        manualChunks: undefined,
        codeSplitting: false,
      },
    },
    chunkSizeWarningLimit: 8000,
  },
});
