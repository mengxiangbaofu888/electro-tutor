/**
 * App 外壳：顶部标题栏 + 路由 + 底部导航。
 */
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { HomePage } from './features/home/HomePage';
import { IngestPage } from './features/ingest/IngestPage';
import { BookAddPage } from './features/book/BookAddPage';
import { MoocImportPage } from './features/mooc/MoocImportPage';
import { OutlineListPage } from './features/outline/OutlineListPage';
import { OutlineDetailPage } from './features/outline/OutlineDetailPage';
import { PracticePage } from './features/practice/PracticePage';
import { ExamPage } from './features/exam/ExamPage';
import { ReportPage } from './features/report/ReportPage';
import { WrongBookPage } from './features/wrong/WrongBookPage';
import { KnowledgePage } from './features/knowledge/KnowledgePage';
import { SettingsPage } from './features/settings/SettingsPage';

const NAV = [
  { to: '/', icon: '🏠', label: '首页' },
  { to: '/materials', icon: '📚', label: '材料' },
  { to: '/outlines', icon: '🗺️', label: '大纲' },
  { to: '/practice', icon: '✏️', label: '练习' },
  { to: '/me', icon: '👤', label: '我的' },
];

/** 路由 → 标题。返回 null 表示不显示系统标题栏（页面自己画） */
function titleFor(pathname: string): { title: string; back?: boolean } | null {
  if (pathname === '/') return { title: '电工陪练' };
  if (pathname === '/materials') return { title: '学习材料' };
  if (pathname === '/outlines') return { title: '知识大纲' };
  if (pathname.startsWith('/outlines/')) return { title: '编辑大纲', back: true };
  if (pathname === '/practice') return { title: '出题与练习' };
  if (pathname.startsWith('/exam/')) return { title: '答题中' };
  if (pathname.startsWith('/report/')) return { title: '学习报告', back: true };
  if (pathname === '/wrong') return { title: '错题本', back: true };
  if (pathname === '/knowledge') return { title: '掌握度与薄弱点', back: true };
  if (pathname === '/me') return { title: '我的' };
  return { title: '电工陪练' };
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const header = titleFor(location.pathname);

  return (
    <div className="app">
      {header && (
        <header className="app-header">
          {header.back && (
            <button className="btn ghost sm" onClick={() => navigate(-1)}>
              ‹ 返回
            </button>
          )}
          <h1>{header.title}</h1>
        </header>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/materials" element={<IngestPage />} />
          <Route path="/book" element={<BookAddPage />} />
          <Route path="/book/:materialId" element={<BookAddPage />} />
          <Route path="/mooc" element={<MoocImportPage />} />
          <Route path="/outlines" element={<OutlineListPage />} />
          <Route path="/outlines/:outlineId" element={<OutlineDetailPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/exam/:attemptId" element={<ExamPage />} />
          <Route path="/report/:attemptId" element={<ReportPage />} />
          <Route path="/wrong" element={<WrongBookPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/me" element={<SettingsPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </main>

      <nav className="bottom-nav">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
