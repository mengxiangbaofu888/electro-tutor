/**
 * 大模型客户端的测试。
 *
 * 这是分支最多、出错时用户最先看到的一层：协议拼装、流式解析、
 * JSON 模式降级重试、各家 HTTP 状态码翻译、网络异常提示、代理前缀。
 * 之前完全没有测试覆盖，而一旦回归，整个 App 的所有 AI 功能都会一起坏。
 *
 * 测试用本机起一个真的 HTTP 服务当替身，不联网、不花钱。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LLMConfig } from '../db/types';
import { chat, listModels, looksLikeItSawTheImage, resolveUrl, testVisionConnection, truncateText } from './client';
import { chatCompletionsUrl, isPrivateEndpoint, modelsUrl } from './presets';

/* ------------------------------ 替身服务 ------------------------------ */

type Handler = (
  req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> },
  res: {
    writeHead: (status: number, headers?: Record<string, string>) => void;
    write: (chunk: string) => void;
    end: (body?: string) => void;
  },
  body: string,
) => void;

/** 默认替身：返回一段正常的对话响应 */
const respondOk: Handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '默认应答' } }] }));
};

let server: Server;
let port = 0;
let handler: Handler = respondOk;
/**
 * 记录每次请求，方便断言发出去的到底是什么。
 * 必须在声明处就初始化：beforeAll 里的自检探针也会走到服务器的记录逻辑，
 * 那时代码还没进 beforeEach，若是 undefined 就会在处理器里抛异常、导致请求永不响应。
 */
let received: { url: string; method: string; auth: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        method: req.method ?? '',
        auth: String(req.headers.authorization ?? ''),
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  // 自检：确认本机回环这次真的通。
  // 并行跑多个测试文件时，"回环暂时不可用"偶发出现过一次——
  // 那种情况下 17 个依赖网络的用例会一起抛断言失败，很难看出真正的原因。
  // 这里主动探一次，把它变成一句能直接照做的错误。
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/__probe__`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    await probe.json();
  } catch (e) {
    throw new Error(
      `本机回环（127.0.0.1:${port}）在这次运行中不可用，无法测试 HTTP 层：` +
        `${e instanceof Error ? e.message : String(e)}。\n` +
        '这属于测试环境问题（并行运行较多测试文件时偶发），不是产品缺陷。\n' +
        '单独重跑即可：npx vitest run src/lib/llm/client.test.ts',
    );
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  handler = respondOk;
});

function cfg(patch: Partial<LLMConfig> = {}): LLMConfig {
  return {
    id: 'test',
    name: '测试',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'test-model',
    kind: 'text',
    temperature: 0.3,
    createdAt: 0,
    ...patch,
  };
}

const userMsg = [{ role: 'user' as const, content: '你好' }];

/** 拿一个确定没人监听的端口 */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

/* ============================== 空闲超时 ============================== */

describe('空闲超时（以前浏览器那条路完全没有超时，卡住就是永远卡住）', () => {
  it('服务端一直不回：到点就放弃，并说清是哪个模型、打到哪家', async () => {
    // 挂着一个永不响应的请求，模拟"模型名不对/服务商排队/网络半死"
    handler = () => {
      /* 故意什么都不做 */
    };
    const t0 = Date.now();
    const err = await chat(cfg(), userMsg, { idleTimeoutMs: 300 }).catch((e: Error) => e);
    const spent = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('没有收到任何数据');
    // 用户得知道"打到了谁"，不然只能干瞪眼
    expect((err as Error).message).toContain('test-model');
    expect((err as Error).message).toContain('127.0.0.1');
    // 而且真的会放弃，不是等满 45 秒
    expect(spent).toBeLessThan(3000);
  });

  it('模型名/地址的提示要能直接照做（引导去看模型列表和测试连接）', async () => {
    handler = () => {};
    const err = await chat(cfg(), userMsg, { idleTimeoutMs: 200 }).catch((e: Error) => e);
    expect((err as Error).message).toContain('获取模型列表');
    expect((err as Error).message).toContain('测试连接');
  });

  it('流式慢慢吐字不会被误杀（按"空闲"而不是"总时长"判定）', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '字' } }] })}\n\n`);
        if (n >= 6) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 80);
    };
    const chunks: string[] = [];
    // 每次间隔 80ms，空闲上限 200ms：整段耗时约 480ms > 200ms，
    // 但因为没有一次空闲超过 200ms，所以必须成功拿到全部内容。
    const r = await chat(cfg(), userMsg, {
      idleTimeoutMs: 200,
      onDelta: (c) => chunks.push(c),
    });
    expect(r.content).toBe('字字字字字字');
    expect(chunks).toHaveLength(6);
  });

  it('调用方自己取消（signal）不会被误报成超时', async () => {
    handler = () => {};
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const err = await chat(cfg(), userMsg, { idleTimeoutMs: 5000, signal: ctrl.signal }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).not.toContain('没有收到任何数据');
  });
});

/* ============================== 识图能力测试 ============================== */

describe('验证"这个模型到底能不能看图"', () => {
  it('真的把测试图发出去了（不是只发一句话）', async () => {
    handler = respondOk;
    await testVisionConnection(cfg({ kind: 'vision' }));
    expect(received).toHaveLength(1);
    expect(received[0].body).toContain('image_url');
    expect(received[0].body).toContain('data:image/png;base64,');
  });

  it('模型答出蓝色/圆形 → 判定它确实看到了图', () => {
    expect(looksLikeItSawTheImage('底色是蓝色，中间是一个圆形')).toBe(true);
    expect(looksLikeItSawTheImage('Blue, circle')).toBe(true);
  });

  it('模型答非所问 → 判定它没看图（多半不吃图片输入）', () => {
    expect(looksLikeItSawTheImage('抱歉，我无法查看图片')).toBe(false);
    expect(looksLikeItSawTheImage('')).toBe(false);
    expect(looksLikeItSawTheImage('这是一个测试')).toBe(false);
  });

  it('模型不支持图片输入时报错要能冒出来（不能假装成功）', async () => {
    handler = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model does not support image input' } }));
    };
    await expect(testVisionConnection(cfg({ kind: 'vision' }))).rejects.toThrow(/不支持|image/i);
  });
});

/* ============================== 请求拼装 ============================== */

describe('请求拼装', () => {
  it('POST 到 {baseUrl}/chat/completions，带上 Bearer 与模型名', async () => {
    const res = await chat(cfg(), userMsg);

    expect(res.content).toBe('默认应答');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/v1/chat/completions');
    expect(received[0].method).toBe('POST');
    expect(received[0].auth).toBe('Bearer sk-test');

    const body = JSON.parse(received[0].body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual(userMsg);
    expect(body.temperature).toBeCloseTo(0.3, 5);
  });

  it('接口地址结尾多一个斜杠也不会拼错', async () => {
    await chat(cfg({ baseUrl: `http://127.0.0.1:${port}/v1/` }), userMsg);
    expect(received[0].url).toBe('/v1/chat/completions');
  });

  it('代理前缀会把真实地址 URL 编码后拼上去', async () => {
    const target = 'https://api.deepseek.com/v1/chat/completions';
    expect(resolveUrl(target, 'https://proxy.example/?url=')).toBe(
      `https://proxy.example/?url=${encodeURIComponent(target)}`,
    );
    expect(resolveUrl(target, 'https://proxy.example/{url}')).toBe(
      `https://proxy.example/${encodeURIComponent(target)}`,
    );
    // 没配前缀就原样返回
    expect(resolveUrl(target, '')).toBe(target);
    expect(resolveUrl(target, undefined)).toBe(target);
  });

  it('配置不全时给出明确的中文提示，而不是发一个坏请求', async () => {
    await expect(chat(cfg({ baseUrl: '' }), userMsg)).rejects.toThrow(/接口地址/);
    await expect(chat(cfg({ model: '' }), userMsg)).rejects.toThrow(/模型 ID/);
    await expect(chat(cfg({ apiKey: '' }), userMsg)).rejects.toThrow(/API Key/);
    expect(received).toHaveLength(0);
  });
});

/* ============================== 流式 ============================== */

describe('流式输出', () => {
  it('逐块回调 onDelta，并把全文拼装返回', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"欧"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"姆"}}]}\n\n');
      res.write(': 这是注释行，应被忽略\n\n');
      res.write('data: {"choices":[{"delta":{"content":"定律"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const deltas: string[] = [];
    const res = await chat(cfg(), userMsg, { onDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(['欧', '姆', '定律']);
    expect(res.content).toBe('欧姆定律');
    // 流式请求要带 stream: true
    expect(JSON.parse(received[0].body).stream).toBe(true);
  });

  it('非流式响应提供了 onDelta 时，也会回调一次完整内容', async () => {
    const deltas: string[] = [];
    const res = await chat(cfg(), userMsg, { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['默认应答']);
    expect(res.content).toBe('默认应答');
  });
});

/* ============================== JSON 模式降级 ============================== */

describe('JSON 模式', () => {
  it('请求体带 response_format', async () => {
    await chat(cfg(), userMsg, { jsonMode: true });
    expect(JSON.parse(received[0].body).response_format).toEqual({ type: 'json_object' });
  });

  it('服务商不支持时自动去掉 response_format 重试一次', async () => {
    handler = (_req, res) => {
      if (received.length === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }));
    };

    const res = await chat(cfg(), userMsg, { jsonMode: true });

    expect(res.content).toBe('{"a":1}');
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0].body).response_format).toBeDefined();
    expect(JSON.parse(received[1].body).response_format).toBeUndefined();
  });

  it('重试也失败时，报原始状态码的错', async () => {
    handler = (_req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end('还是不行');
    };
    await expect(chat(cfg(), userMsg, { jsonMode: true })).rejects.toThrow(/422/);
  });
});

/* ============================== 错误翻译 ============================== */

describe('HTTP 错误翻译成人话', () => {
  const cases: [number, RegExp][] = [
    [401, /API Key 不正确或已失效/],
    [403, /没有这个模型的权限/],
    [404, /接口地址不对/],
    [429, /触发限流或余额不足/],
    [500, /服务商暂时故障/],
    [503, /服务商暂时故障/],
    [418, /请求失败（418）/],
  ];

  for (const [status, pattern] of cases) {
    it(`${status} → ${pattern.source}`, async () => {
      handler = (_req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(`服务端说：${status}`);
      };
      await expect(chat(cfg(), userMsg)).rejects.toThrow(pattern);
      // 服务端返回的内容要带进错误里，方便排查
      await expect(chat(cfg(), userMsg)).rejects.toThrow(new RegExp(`服务端说：${status}`));
    });
  }

  it('连不上时提示可能是跨域，也可能是网络不通', async () => {
    const p = await deadPort();
    const config = cfg({ baseUrl: `http://127.0.0.1:${p}/v1` });
    await expect(chat(config, userMsg)).rejects.toThrow(/网络请求被拦截/);
    await expect(chat(config, userMsg)).rejects.toThrow(/跨域/);
  });

  it('服务端把错误包在 200 的 error 字段里也能识别', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '余额不足' } }));
    };
    await expect(chat(cfg(), userMsg)).rejects.toThrow(/余额不足/);
  });
});

/* ============================== 模型列表 ============================== */

describe('获取模型列表', () => {
  it('解析 OpenAI 风格的 data 数组，跳过没有 id 的项', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, {}, 'glm-4-flash'] }));
    };
    expect(await listModels(cfg())).toEqual(['deepseek-chat', 'deepseek-reasoner', 'glm-4-flash']);
    expect(received[0].url).toBe('/v1/models');
    expect(received[0].method).toBe('GET');
  });

  it('鉴权失败时给出和对话一致的中文提示', async () => {
    handler = (_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    };
    await expect(listModels(cfg())).rejects.toThrow(/API Key/);
  });
});

/* ============================== 上下文截断 ============================== */

describe('truncateText', () => {
  it('没超长就原样返回', () => {
    expect(truncateText('短文本', 100)).toBe('短文本');
  });

  it('超长时保留头尾、中间省略（而不是砍掉结尾）', () => {
    const text = `开头${'中间内容'.repeat(100)}结尾`;
    const out = truncateText(text, 60);
    expect(out.length).toBeLessThanOrEqual(60 + 60); // 省略标记本身占一些字符
    expect(out.startsWith('开头')).toBe(true);
    expect(out.endsWith('结尾')).toBe(true);
    expect(out).toContain('省略');
  });
});

/* ============================== 地址拼装（presets） ============================== */

describe('接口地址拼装', () => {
  it('容错各种写法', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(modelsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/models');
    expect(modelsUrl('https://api.deepseek.com/v1/models')).toBe('https://api.deepseek.com/v1/models');
  });
});

describe('是不是局域网地址（决定要不要警告明文传输）', () => {
  it('本机与私有网段算局域网', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://192.168.1.10:11434/v1',
      'http://10.0.2.2:11434/v1', // 安卓模拟器访问宿主机
      'http://172.16.5.5/v1',
      'http://172.31.255.1/v1',
      'http://nas.local/v1',
    ]) {
      expect(isPrivateEndpoint(url), url).toBe(true);
    }
  });

  it('公网地址不算，172 的边界也要判对', () => {
    for (const url of [
      'https://api.deepseek.com/v1',
      'http://api.example.com/v1',
      'http://8.8.8.8/v1',
      'http://172.15.0.1/v1', // 不在 172.16~172.31 范围内
      'http://172.32.0.1/v1',
      'http://192.169.1.1/v1', // 不是 192.168
    ]) {
      expect(isPrivateEndpoint(url), url).toBe(false);
    }
  });

  it('地址写得不合法时当作非局域网（宁可不放过警告）', () => {
    expect(isPrivateEndpoint('随便写的东西')).toBe(false);
    expect(isPrivateEndpoint('')).toBe(false);
  });
});
