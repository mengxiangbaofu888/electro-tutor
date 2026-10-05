import { defineConfig } from 'vitest/config';

/**
 * 测试配置。
 *
 * 刻意和 vite.config.ts 分开：那边挂了 PWA 插件和分包配置，
 * 对跑单测没有好处，反而拖慢启动。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // db 层依赖 IndexedDB，用内存实现顶替
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default'],
  },
});
