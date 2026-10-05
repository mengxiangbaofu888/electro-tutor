import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 单文件构建配置。
 *
 * 目的：把整个 App 打成一个**自包含的 HTML 文件**（CSS/JS 全部内联），
 * 双击就能用，不需要任何服务器，也不依赖 PWA。
 *
 * 用途：
 *  - 在没有服务器的环境里做渲染验证（headless 浏览器 file:// 无法加载 ES 模块，内联后可以）
 *  - 给用户一个"发到微信里就能打开"的离线版本
 *
 * 用法：npm run build:single
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    // 关掉分包，保证只产出一个 js
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
    // 单文件会比较大（含 pdfjs），放宽警告阈值
    chunkSizeWarningLimit: 8000,
  },
});
