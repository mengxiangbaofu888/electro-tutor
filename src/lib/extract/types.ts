/** 材料文本提取模块的公共类型定义 */

export interface ExtractResult {
  /** 提取出的正文，Markdown 或纯文本，已做基本清理（去页眉页脚重复空行等） */
  text: string;
  /** 建议的标题 */
  title?: string;
  /** 元信息，例如页数、字数 */
  meta?: Record<string, string | number>;
  /** 非致命警告，例如"第3页为扫描图片，未提取到文字" */
  warnings?: string[];
}
