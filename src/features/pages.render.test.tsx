/**
 * 页面渲染冒烟测试。
 *
 * 目的：确保每个页面在"还没有数据"的初始状态下都能渲染出来，而不是白屏。
 * 这类问题（空数组越界、hook 用错、模块导入就崩）在类型检查里发现不了，
 * 只有真正渲染一次才暴露。
 *
 * 说明：这里用 react-dom/server 做一次首屏渲染，不执行 useEffect，
 * 因此不涉及数据库读写，也不需要真实浏览器。
 */
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExamPage } from './exam/ExamPage';
import { HomePage } from './home/HomePage';
import { IngestPage } from './ingest/IngestPage';
import { KnowledgePage } from './knowledge/KnowledgePage';
import { OutlineDetailPage } from './outline/OutlineDetailPage';
import { OutlineListPage } from './outline/OutlineListPage';
import { PracticePage } from './practice/PracticePage';
import { ReportPage } from './report/ReportPage';
import { SettingsPage } from './settings/SettingsPage';
import { WrongBookPage } from './wrong/WrongBookPage';

/** 所有页面组件，以及它们在没有数据时应该出现的文案 */
const PAGES: [name: string, Page: ComponentType, expectText: string][] = [
  ['首页', HomePage, '加载中'],
  ['材料导入', IngestPage, '加载中'],
  ['大纲列表', OutlineListPage, '加载中'],
  ['大纲详情', OutlineDetailPage, '加载中'],
  ['出题练习', PracticePage, '加载中'],
  ['答题', ExamPage, '加载中'],
  ['学习报告', ReportPage, '加载中'],
  ['错题本', WrongBookPage, '加载中'],
  ['掌握度地图', KnowledgePage, '加载中'],
  ['我的（设置）', SettingsPage, '加载中'],
];

describe('页面渲染冒烟', () => {
  for (const [name, Page, expectText] of PAGES) {
    it(`${name} 在无数据时能渲染出加载态，而不是白屏`, () => {
      const html = renderToString(
        <MemoryRouter>
          <Page />
        </MemoryRouter>,
      );
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain(expectText);
    });
  }
});
