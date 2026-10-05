/** 材料文本提取模块统一出口：文件 / 网页 / B 站字幕 → 文本 */

export type { ExtractResult } from './types';
export { extractFromFile } from './file';
export { extractFromUrl, extractBilibiliSubtitle } from './url';
