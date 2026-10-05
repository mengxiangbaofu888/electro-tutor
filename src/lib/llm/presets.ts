/**
 * 大模型服务商预设。
 *
 * 全部走 OpenAI 兼容协议：POST {baseUrl}/chat/completions
 * 只要服务商支持这个协议，就可以在「自定义」里接入。
 */
import type { LLMConfig } from '../db/types';

export interface ProviderPreset {
  /** 显示名 */
  label: string;
  /** 默认接口地址（到 /v1 这一层，不带 /chat/completions） */
  baseUrl: string;
  /** 常用文本模型 */
  textModels: string[];
  /** 常用视觉模型 */
  visionModels: string[];
  /** 申请地址 */
  consoleUrl: string;
  /** 备注 */
  note: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    label: 'DeepSeek（推荐主力，最便宜）',
    baseUrl: 'https://api.deepseek.com/v1',
    textModels: ['deepseek-chat', 'deepseek-reasoner'],
    visionModels: [],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文强、价格极低。没有视觉模型，识图请配 GLM-4V。',
  },
  glm: {
    label: '智谱 GLM（推荐做识图）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    textModels: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    visionModels: ['glm-4v-flash', 'glm-4v-plus'],
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 与 glm-4v-flash 是免费档，非常适合做识图和批量出题。',
  },
  qwen: {
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    textModels: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    visionModels: ['qwen-vl-plus', 'qwen-vl-max'],
    consoleUrl: 'https://bailian.console.aliyun.com/',
    note: '视觉模型对中文电路图识别效果不错。',
  },
  doubao: {
    label: '字节豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    textModels: ['doubao-pro-32k'],
    visionModels: ['doubao-vision-pro-32k'],
    consoleUrl: 'https://console.volcengine.com/ark',
    note: '注意：火山方舟的「模型 ID」通常需要填接入点 ID（ep-xxxxxxxx），不是模型名。',
  },
  ollama: {
    label: '本地 Ollama（完全离线）',
    baseUrl: 'http://localhost:11434/v1',
    textModels: ['qwen2.5:7b', 'llama3.1:8b'],
    visionModels: ['llava:7b', 'qwen2.5vl:7b'],
    consoleUrl: 'https://ollama.com/download',
    note: '手机要连电脑上的 Ollama，需填电脑局域网 IP，例如 http://192.168.1.10:11434/v1。',
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    textModels: [],
    visionModels: [],
    consoleUrl: '',
    note: '填写形如 https://your-host/v1 的地址即可。',
  },
};

export function makeConfig(partial: Partial<LLMConfig> = {}): LLMConfig {
  return {
    id: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    kind: 'text',
    temperature: 0.6,
    createdAt: Date.now(),
    ...partial,
  };
}

/** 拼接最终的 chat/completions 地址，容忍用户多填/少填斜杠 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/** 拼接模型列表地址（用于「获取模型列表」按钮） */
export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/models')) return trimmed;
  return `${trimmed}/models`;
}

/**
 * 判断接口地址是不是「局域网 / 本机」——这类地址用 http 是正常的
 * （本地跑的 Ollama、vLLM 基本都只监听内网）。
 *
 * 用途：填了公网 http 地址时提示用户 API Key 会明文传输。
 */
export function isPrivateEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (/^10\./.test(host)) return true; // 含安卓模拟器访问宿主机的 10.0.2.2
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}
