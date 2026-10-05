/**
 * 「慕课整门导入」页：粘一个课程目录链接 → 抓课时 + 题库 → 自己挑要哪些 → 导入。
 *
 * 为什么要有"挑"这一步（用户明确要求的）：
 * 一门课自测题库动辄上千道，直接全导进去会把题库灌满；
 * 用户要的是"我一条条看、自己选"。
 *
 * 边界（界面上也要说清楚）：
 * · 只抓**公开**的课程目录与自测题库，不绕过登录；**视频抓不到**（要登录才能看）。
 * · 抓取走原生请求，所以**只有 APK 版能用**；网页版会明确提示，而不是报跨域错误。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, newId } from '../../lib/db/db';
import type { Outline, QuestionType, TrackId } from '../../lib/db/types';
import { TRACK_LABELS } from '../../lib/db/types';
import {
  MOOC_NEEDS_APP_MESSAGE,
  buildCourseMaterialContent,
  fetchMoocCourse,
  moocQuestionsToRows,
  type MoocCourse,
  type MoocHttp,
} from '../../lib/mooc/icourse163';
import { createMoocHttp } from '../../lib/platform/mooc-http';
import { importQuestionRows } from '../../lib/services/bank';
import { createOutlineFromTitles } from '../../lib/services/outline';
import { Alert, Badge, Button, Card, Field, Select, TextInput } from '../../components/ui';

const TRACK_OPTIONS = (Object.keys(TRACK_LABELS) as TrackId[]).map((k) => ({
  value: k,
  label: TRACK_LABELS[k],
}));

const TYPE_LABEL: Record<QuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  blank: '填空',
  short: '简答',
  calc: '计算',
};

/** 一次最多渲染多少条（1500 多道题全渲染会卡；让用户用筛选缩小范围） */
const RENDER_LIMIT = 200;

export function MoocImportPage({ http: injected }: { http?: MoocHttp | null } = {}) {
  const navigate = useNavigate();
  // 注入的通道优先（测试用）；未注入则用平台的（App 里是原生请求，网页版是 null）
  const channel = injected === undefined ? createMoocHttp() : injected;

  const [url, setUrl] = useState('');
  const [track, setTrack] = useState<TrackId>('fundamental');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [course, setCourse] = useState<MoocCourse | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<'all' | QuestionType>('all');
  const [keyword, setKeyword] = useState('');

  const filtered = useMemo(() => {
    if (!course) return [];
    const kw = keyword.trim();
    return course.questions.filter(
      (q) => (typeFilter === 'all' || q.type === typeFilter) && (!kw || q.stem.includes(kw)),
    );
  }, [course, typeFilter, keyword]);

  const pickedCount = picked.size;

  async function grab() {
    if (!channel) {
      setMessage({ tone: 'warn', text: MOOC_NEEDS_APP_MESSAGE });
      return;
    }
    if (!url.trim()) {
      setMessage({ tone: 'error', text: '先把课程链接粘进来。' });
      return;
    }
    setBusy('grab');
    setMessage(null);
    setCourse(null);
    setPicked(new Set());
    try {
      const c = await fetchMoocCourse({ url: url.trim(), http: channel, onProgress: setProgress });
      setCourse(c);
      setPicked(new Set(c.questions.map((q) => q.remoteId)));
      setMessage({
        tone: 'ok',
        text:
          `抓到 ${c.lessons.length} 个课时、${c.questions.length} 道自测题。` +
          '下面按题型/关键词筛一筛，勾好要哪些再导入（默认全选）。',
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  function toggle(remoteId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(remoteId)) next.delete(remoteId);
      else next.add(remoteId);
      return next;
    });
  }

  async function doImport() {
    if (!course || !pickedCount) return;
    setBusy('import');
    setMessage(null);
    try {
      const chosen = course.questions.filter((q) => picked.has(q.remoteId));
      setProgress(`正在保存课程材料与 ${chosen.length} 道题…`);

      // 1) 课程本身存成一条材料：以后可以拿它去「大纲」页生成知识大纲
      const materialId = newId();
      const materialTitle = `慕课：${course.courseTitle}`;
      await db.materials.put({
        id: materialId,
        title: materialTitle,
        sourceType: 'url',
        sourceRef: `https://www.icourse163.org/course/${course.courseId}?tid=${course.termId}`,
        content: buildCourseMaterialContent(course),
        charCount: buildCourseMaterialContent(course).length,
        track,
        createdAt: Date.now(),
        // 课时目录就是这个材料**自带的**结构：有它就能直接拼大纲，不用调模型
        sections: course.lessons.map((l) => l.name),
      });

      // 2) 大纲：同名就复用，避免重复导入时建出一堆同名大纲
      const outlineTitle = `慕课：${course.courseTitle}`;
      const existing = (await db.outlines.toArray()).find((o) => o.title === outlineTitle);
      const outlineId = existing?.id ?? newId();
      if (!existing) {
        const outline: Outline = {
          id: outlineId,
          title: outlineTitle,
          track,
          materialIds: [materialId],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.outlines.put(outline);
      }

      // 3) 题目走和 CSV 导入**同一条路**（知识点按课时名自动匹配/新建）
      setProgress(`正在把 ${chosen.length} 道题写进题库…`);
      const result = await importQuestionRows({
        rows: moocQuestionsToRows(chosen),
        outlineId,
      });

      setMessage({
        tone: result.imported ? 'ok' : 'warn',
        text:
          `导入完成：${result.imported} 道题入库` +
          (result.createdPoints ? `，自动新建了 ${result.createdPoints} 个知识点` : '') +
          '。' +
          (result.warnings.length ? ` 有 ${result.warnings.length} 条提示（见控制台/下方）。` : '') +
          ' 去「练习」页就能用它们出卷了。',
      });
      setProgress('');
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  const typeCounts = useMemo(() => {
    const out: Partial<Record<QuestionType, number>> = {};
    for (const q of course?.questions ?? []) out[q.type] = (out[q.type] ?? 0) + 1;
    return out;
  }, [course]);

  return (
    <>
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}
      {progress && <Alert tone="ok">{progress}</Alert>}

      <Card title="🎓 慕课整门导入" extra={<Badge tone="primary">Beta</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          把中国大学MOOC（icourse163）的**课程链接**粘进来，App 自己去抓
          <b>课时目录</b>和<b>课程自测题</b>，然后你一条条挑要哪些。
          不用再一节课一个链接地复制。
        </p>
        <Field
          label="课程链接"
          hint="在课程页面复制地址，要带 ?tid= 的那一串，例如 …/learn/CZMEC-1001754242?tid=1488467453"
        >
          <TextInput value={url} placeholder="https://www.icourse163.org/learn/…?tid=…" onChange={setUrl} />
        </Field>
        <Field label="导入到哪条学习线">
          <Select value={track} onChange={(v) => setTrack(v as TrackId)} options={TRACK_OPTIONS} />
        </Field>
        <div className="btn-row">
          <Button variant="primary" loading={busy === 'grab'} onClick={grab}>
            抓取这门课
          </Button>
        </div>
        <Alert tone="warn">
          说明：**视频抓不到**——慕课的视频要登录才能看，本功能不绕过登录。
          视频课时会列在抓到的课时清单里，想看就点开官方页面看；能真抓到的是**课程自测题库（含答案）**。
        </Alert>
      </Card>

      {course && (
        <>
          <Card title={`📚 ${course.courseTitle}`} extra={<Badge>{course.lessons.length} 个课时</Badge>}>
            <div className="col" style={{ gap: 2, maxHeight: 220, overflow: 'auto' }}>
              {course.lessons.map((l, i) => (
                <div key={l.id} className="small muted">
                  {i + 1}. {l.name}
                </div>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <Button
                loading={busy === 'outline'}
                onClick={async () => {
                  setBusy('outline');
                  setMessage(null);
                  try {
                    const outline = await createOutlineFromTitles({
                      title: `慕课：${course.courseTitle}`,
                      track,
                      titles: course.lessons.map((l) => l.name),
                    });
                    setMessage({
                      tone: 'ok',
                      text:
                        `已用这 ${course.lessons.length} 个课时名直接建好大纲「${outline.outline.title}」` +
                        `（${outline.points.length} 个知识点）—— **没有调用模型，秒出、不花钱**。` +
                        '因为课时目录本身就是现成的结构，让模型再"归纳"一遍只会更慢还可能改错名字。',
                    });
                    navigate(`/outlines/${outline.outline.id}`);
                  } catch (e) {
                    setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
                  } finally {
                    setBusy('');
                  }
                }}
              >
                用课时列表直接建大纲（不调模型）
              </Button>
            </div>
          </Card>

          <Card
            title="📝 挑要导入的题"
            extra={<Badge tone={pickedCount ? 'primary' : undefined}>已选 {pickedCount} / {course.questions.length}</Badge>}
          >
            <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
              <Button
                size="sm"
                variant={typeFilter === 'all' ? 'primary' : 'ghost'}
                onClick={() => setTypeFilter('all')}
              >
                全部 {course.questions.length}
              </Button>
              {(Object.keys(typeCounts) as QuestionType[]).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={typeFilter === t ? 'primary' : 'ghost'}
                  onClick={() => setTypeFilter(t)}
                >
                  {TYPE_LABEL[t]} {typeCounts[t]}
                </Button>
              ))}
            </div>

            <Field label="按题干里的字找">
              <TextInput value={keyword} placeholder="例如：星三角 / 触电 / 万用表" onChange={setKeyword} />
            </Field>

            <div className="btn-row" style={{ marginBottom: 10 }}>
              <Button
                size="sm"
                onClick={() => setPicked((p) => new Set([...p, ...filtered.map((q) => q.remoteId)]))}
              >
                全选当前筛选结果（{filtered.length}）
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setPicked((p) => {
                    const next = new Set(p);
                    for (const q of filtered) next.delete(q.remoteId);
                    return next;
                  })
                }
              >
                取消当前筛选结果
              </Button>
            </div>

            {filtered.length === 0 && <div className="small faint">没有符合条件的题。</div>}
            {filtered.slice(0, RENDER_LIMIT).map((q) => (
              <label key={q.remoteId} className="card tight" style={{ display: 'block', cursor: 'pointer' }}>
                <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto', marginTop: 3 }}
                    checked={picked.has(q.remoteId)}
                    onChange={() => toggle(q.remoteId)}
                  />
                  <div className="grow">
                    <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                      <Badge>{TYPE_LABEL[q.type]}</Badge>
                      <span className="small faint">{q.pointName}</span>
                    </div>
                    <div style={{ fontSize: 13.5 }}>{q.stem}</div>
                    <div className="small faint" style={{ marginTop: 2 }}>
                      答案：{Array.isArray(q.answer) ? q.answer.join(' / ') : q.answer}
                    </div>
                  </div>
                </div>
              </label>
            ))}
            {filtered.length > RENDER_LIMIT && (
              <div className="small faint">
                共 {filtered.length} 道，只显示前 {RENDER_LIMIT} 道。用上面的题型/关键词缩小范围，
                或者直接点「全选当前筛选结果」。
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 12 }}>
              <Button variant="primary" loading={busy === 'import'} disabled={!pickedCount} onClick={doImport}>
                导入选中的 {pickedCount} 道题
              </Button>
              <Button variant="ghost" onClick={() => navigate('/practice')}>
                直接去练习
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
