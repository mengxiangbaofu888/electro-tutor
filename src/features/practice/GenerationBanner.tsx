/**
 * 全局的"出题任务"横幅。
 *
 * 为什么要有它（用户实测反馈）：
 *   "如果正在生成题目，我却点了我的或者首页其他的一些东西，他回来就没了。"
 * 出题任务其实跑在模块级单例里（services/generation-runner.ts），
 * 切页面并不会打断它；但如果只有练习页显示进度，用户就会以为任务没了。
 * 所以这里在**每个页面底部**都显示一条状态，并提供暂停/继续/取消。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cancelGeneration,
  getGenerationState,
  isGenerationActive,
  pauseGeneration,
  resetGeneration,
  resumeGeneration,
  subscribeGeneration,
  type GenerationState,
} from '../../lib/services/generation-runner';
import { Button } from '../../components/ui';

export function GenerationBanner() {
  const navigate = useNavigate();
  const [gen, setGen] = useState<GenerationState>(getGenerationState);

  useEffect(() => subscribeGeneration(setGen), []);

  const active = isGenerationActive(gen);
  const justFinished = !active && gen.status === 'done';
  if (!active && !justFinished) return null;

  return (
    <div className="generation-banner">
      <div className="grow">
        <div className="small">
          {active ? (gen.status === 'paused' ? '⏸ ' : '⏳ ') : '✅ '}
          <b>{gen.note || '正在准备出题…'}</b>
        </div>
        <div className="small faint">
          {active
            ? '出题在后台继续，切页面不会中断'
            : `已存进题库${gen.thenStart ? '，去练习页就能用' : ''}`}
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {gen.status === 'running' && (
          <Button size="sm" variant="ghost" onClick={pauseGeneration}>
            暂停
          </Button>
        )}
        {gen.status === 'paused' && (
          <Button size="sm" variant="primary" onClick={resumeGeneration}>
            继续
          </Button>
        )}
        {active ? (
          <Button size="sm" variant="danger" onClick={cancelGeneration}>
            取消
          </Button>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => navigate('/practice')}>
              去练习
            </Button>
            <Button size="sm" variant="ghost" onClick={resetGeneration}>
              知道了
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
