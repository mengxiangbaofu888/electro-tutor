import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置：把 dist/ 包成安卓 App。
 *
 * 几个关键点：
 * - webDir 指向 Vite 的构建产物 dist/
 * - androidScheme 用 https：这样 WebView 的源是 https://localhost，
 *   属于安全上下文，IndexedDB 和 Service Worker 才能正常工作
 * - CapacitorHttp 打开：让网络请求走原生层，绕开浏览器跨域限制
 *   （代码里 src/lib/llm/client.ts 会自动检测原生环境并优先使用它）
 */
const config: CapacitorConfig = {
  appId: 'com.electrotutor.app',
  appName: '电工陪练',
  webDir: 'dist',
  android: {
    // 某些模型接口是 http，允许混合内容避免被拦
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
