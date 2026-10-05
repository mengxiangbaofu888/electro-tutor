/**
 * 极简 Markdown 渲染器。
 * 不引入第三方依赖，覆盖讲义/解析里会用到的语法：
 * 标题、列表、加粗、行内代码、代码块、引用、表格、分割线。
 */
import type { ReactNode } from 'react';

/** 行内解析：**加粗**、`代码` */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    }
    last = match.index + token.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`k${key++}`}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], `h${key}`);
      if (level === 1) blocks.push(<h1 key={`k${key++}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`k${key++}`}>{content}</h2>);
      else blocks.push(<h3 key={`k${key++}`}>{content}</h3>);
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`k${key++}`} />);
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <table key={`k${key++}`}>
          <thead>
            <tr>
              {header.map((h, hi) => (
                <th key={hi}>{renderInline(h, `th${hi}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{renderInline(c, `td${ri}-${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={`k${key++}`}>{renderInline(buf.join(' '), `q${key}`)}</blockquote>);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={`k${key++}`}>
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ul${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`k${key++}`}>
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ol${ii}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落：把连续的普通行合成一段
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,4}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`k${key++}`}>{renderInline(para.join(' '), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
