/**
 * 探测各大模型服务商是否允许浏览器直连（CORS）。
 *
 * 为什么需要这个：网页版（PWA）是在浏览器里直接请求大模型接口的。
 * 如果服务商不返回 Access-Control-Allow-Origin，浏览器就会拦下请求，
 * 用户只会看到"网络请求被拦截"。这时只能改用 APK（原生请求不受跨域限制），
 * 或者自己搭一个代理前缀。
 *
 * 探测方式：发一个预检请求（OPTIONS + Origin），看服务商怎么回。
 * 预检不需要 API Key，所以任何人在任何网络下都能跑。
 *
 * 用法：npm run probe:cors
 *      node scripts/probe-cors.mjs http://192.168.1.10:5173
 */
const ORIGIN = process.argv[2] ?? 'http://localhost:5173';

const PROVIDERS = [
  ['DeepSeek', 'https://api.deepseek.com/v1/chat/completions'],
  ['智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
  ['阿里通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
  ['字节豆包（火山方舟）', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
  ['OpenAI', 'https://api.openai.com/v1/chat/completions'],
];

function pick(headers, name) {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
}

console.log(`模拟浏览器来源：${ORIGIN}\n`);
console.log('服务商                 预检(OPTIONS)  Allow-Origin            结论');
console.log('─'.repeat(90));

for (const [label, url] of PROVIDERS) {
  const prefix = label.padEnd(22);
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
      signal: AbortSignal.timeout(20000),
    });
    const allowOrigin = pick(res.headers, 'access-control-allow-origin');
    const allowHeaders = pick(res.headers, 'access-control-allow-headers');

    let verdict;
    if (allowOrigin === '*' || allowOrigin === ORIGIN) {
      // 光放行来源还不够：带 Bearer 的请求还需要放行 authorization 头
      const okHeaders = !allowHeaders || /authorization/i.test(allowHeaders);
      verdict = okHeaders ? '✅ 浏览器可直连' : '⚠️ 放行来源但可能不放行 authorization 头';
    } else {
      verdict = '❌ 未放行跨域 → 需用 APK 或代理前缀';
    }
    console.log(`${prefix}${String(res.status).padEnd(14)}${(allowOrigin ?? '(无)').padEnd(24)}${verdict}`);
  } catch (e) {
    console.log(`${prefix}${'请求失败'.padEnd(14)}${'—'.padEnd(24)}❌ 连不上：${e.message.slice(0, 40)}`);
  }
}

console.log('\n说明：');
console.log('  · 服务商策略会变，这里只是"当下观测值"，随时可以重跑本脚本确认。');
console.log('  · 即使标 ❌，装成 APK 走原生请求（CapacitorHttp）就没有跨域限制了。');
console.log('  · 也可以在「我的 → 模型配置」里填代理前缀来绕过。');
