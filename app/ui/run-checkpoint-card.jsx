import React from 'react';
import { Button, Card, StatusBadge } from './halaska-kit.jsx';
import styles from '../run-checkpoint.css';

if (!document.getElementById('halaska-run-checkpoint-styles')) {
  const style = document.createElement('style');
  style.id = 'halaska-run-checkpoint-styles';
  style.textContent = styles;
  document.head.appendChild(style);
}

const t = (zh, en) => /^en(?:-|$)/i.test(globalThis.WorkstationI18n?.getLanguage?.() || document.documentElement.lang || '') ? en : zh;

// The host owns execution, persistence and the phase transition. Rendering or
// pressing a button cannot acknowledge a save or advance this card by itself.
export function RunCheckpointCard({ phase, actionCount = 0, hasSavedResult = false, at, busy = false, error = '', onContinue, onSave, onHistory }) {
  if (!['prepared', 'applied', 'committed'].includes(phase)) return null;
  const committed = phase === 'committed';
  const prepared = phase === 'prepared';
  const committedLabel = hasSavedResult === true ? t('结果已保存', 'Results saved') : t('已完成', 'Completed');
  const title = committed ? committedLabel : prepared
    ? t('整理计划已保留', 'Organization plan retained')
    : t('操作已应用，等待保存确认', 'Changes applied, awaiting save confirmation');
  const description = prepared
    ? t('继续时会重新校验计划与当前权限，再执行尚未应用的本机操作。', 'Continuing rechecks the plan and current permissions before applying the remaining local operations.')
    : t('继续保存现有结果，不会重新调用模型或再次执行这些操作。', 'Continue saving the existing results without calling the model or executing these operations again.');
  const loadingLabel = prepared ? t('正在校验并继续整理…', 'Checking and continuing…') : t('正在保存现有结果…', 'Saving existing results…');
  const actionLabel = prepared ? t('继续完成整理', 'Continue organization') : t('继续保存结果', 'Continue saving results');
  const action = prepared ? onContinue : onSave;
  const count = typeof actionCount === 'number' && Number.isFinite(actionCount) ? Math.max(0, Math.floor(actionCount)) : 0;
  const timestamp = typeof at === 'number' && at > 0 && Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? new Date(at) : null;
  const errorText = typeof error === 'string' ? error : '';
  if (committed) return <section className="run-checkpoint-card run-checkpoint-saved" data-checkpoint-phase={phase}
    aria-label={t('执行恢复与保存状态', 'Execution recovery and save status')}>
    <StatusBadge status="online" pulse={false}>{committedLabel}</StatusBadge>
    {count > 0 && <span className="run-checkpoint-saved-count" title={timestamp?.toLocaleString()}>
      {t(`${count} 项本机操作`, `${count} local ${count === 1 ? 'operation' : 'operations'}`)}
    </span>}
    {typeof onHistory === 'function' && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onHistory}>
      {t('查看执行记录', 'View execution record')}
    </Button>}
  </section>;

  return <section className="run-checkpoint-card" data-checkpoint-phase={phase}
    aria-label={t('执行恢复与保存状态', 'Execution recovery and save status')} aria-busy={busy || undefined}>
    <Card padding={committed ? 12 : 16} style={{ minWidth: 0, borderRadius: 14, boxShadow: 'none', background: 'var(--panel)' }}>
      <header className="run-checkpoint-heading">
        <div className="run-checkpoint-status" role="status" aria-live="polite" aria-atomic="true">
          <h4>{title}</h4>
          {!committed && busy && <span className="run-checkpoint-progress">{loadingLabel}</span>}
        </div>
        <StatusBadge status={committed ? 'online' : 'pending'} pulse={false}>
          {committed ? t('已保存', 'Saved') : prepared ? t('可继续', 'Ready to continue') : t('待保存确认', 'Awaiting confirmation')}
        </StatusBadge>
      </header>
      {!committed && <p className="run-checkpoint-description">{description}</p>}
      {(count > 0 || timestamp) && <div className="run-checkpoint-metadata">
        {count > 0 && <span>{t(`${count} 项本机操作`, `${count} local ${count === 1 ? 'operation' : 'operations'}`)}</span>}
        {timestamp && <time dateTime={timestamp.toISOString()} title={t('状态记录时间', 'Recorded at')}>
          {timestamp.toLocaleString(t('zh-CN', 'en-US'), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </time>}
      </div>}
      {errorText && <p className="run-checkpoint-error" role="alert" data-user-content="">{errorText}</p>}
      {(!committed || typeof onHistory === 'function') && <div className="run-checkpoint-actions">
        {!committed && <Button size="sm" variant="accent" type="button" disabled={busy || typeof action !== 'function'} loading={busy}
          onClick={action} style={{ minHeight: 34, height: 'auto', whiteSpace: 'normal', lineHeight: 1.5, textAlign: 'center' }}>
          {busy ? loadingLabel : actionLabel}
        </Button>}
        {typeof onHistory === 'function' && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onHistory}
          style={{ minHeight: 34, height: 'auto', whiteSpace: 'normal', lineHeight: 1.5, textAlign: 'center' }}>
          {t('查看执行记录', 'View execution record')}
        </Button>}
      </div>}
    </Card>
  </section>;
}
