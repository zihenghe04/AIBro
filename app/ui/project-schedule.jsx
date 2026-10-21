import React, { useId, useLayoutEffect, useRef } from 'react';
import { Button, TextArea, EmptyState } from './halaska-kit.jsx';
import styles from './project-schedule.css';

if (!document.getElementById('halaska-project-schedule')) {
  const style = document.createElement('style'); style.id = 'halaska-project-schedule'; style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

function ScheduleAction({ marker, children, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (marker) ref.current?.querySelector('button')?.setAttribute(marker, ''); }, [marker]);
  return <span className="schedule-action" ref={ref}><Button {...props}>{children}</Button></span>;
}
const tone = status => ['todo', 'progress', 'done', 'blocked'].includes(status) ? status : 'todo';
function ScheduleTask({ task, onTask }) {
  return <li className={`schedule-task-row tone-${tone(task.status)}`} data-schedule-task={task.id}>
    <Button variant="ghost" size="sm" disabled={typeof onTask !== 'function'} title={text(task.title)}
      onClick={typeof onTask === 'function' ? event => onTask(task.id, event.currentTarget) : undefined}>
      <span className={`schedule-task-dot tone-${tone(task.status)}`} aria-hidden="true" />
      <span className="schedule-task-copy"><strong data-user-content>{text(task.title) || t('未命名任务', 'Untitled task')}</strong>
        <span className="schedule-task-meta"><span>{text(task.statusLabel)}</span>{text(task.time) && <time>{task.time}</time>}
          {text(task.invalidDate) && <span data-user-content>{task.invalidDate}</span>}</span></span>
      <span className="schedule-task-arrow" aria-hidden="true">↗</span>
    </Button>
  </li>;
}
// Today's timed tasks get a "now" divider; untimed tasks stay where they are.
function nowIndex(tasks, now = new Date()) {
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (!tasks.some(task => text(task.time))) return -1;
  const index = tasks.findIndex(task => text(task.time) && task.time > clock);
  return index < 0 ? tasks.length : index;
}
const taskList = (tasks, onTask, now = -1) => <ul className="schedule-task-list">{list(tasks).flatMap((task, index) => [
  index === now ? <li key="now" className="schedule-now-line" aria-hidden="true"><span>{t('现在', 'Now')}</span></li> : null,
  <ScheduleTask key={task.id} task={task} onTask={onTask} />])}
  {now === list(tasks).length && <li key="now" className="schedule-now-line" aria-hidden="true"><span>{t('现在', 'Now')}</span></li>}</ul>;
// Week navigation direction is presentation-only; it is derived from the first
// day shown, so the island stays a plain function of its props.
let shownWeek = { ts: null, direction: 'none' };
function weekDirection(ts) {
  if (ts !== shownWeek.ts) shownWeek = { ts, direction: shownWeek.ts == null || ts == null ? 'none' : ts > shownWeek.ts ? 'next' : 'prev' };
  return shownWeek.direction;
}

function SchedulePlan({ plan = {}, onPlanChange, onPlanComposition, onPlanToggle, onPlanPreview, onPlanSave, onPlanResolve }) {
  const inputRef = useRef(null), inputId = useId(), helpId = useId(), composing = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current?.querySelector('textarea');
    if (input) { input.id = inputId; input.setAttribute('aria-label', t('独立项目计划 Markdown', 'Standalone project plan Markdown')); input.setAttribute('aria-describedby', helpId); input.setAttribute('data-plan-input', ''); input.setAttribute('data-user-content', ''); }
  }, [inputId, helpId, plan.open]);
  const saveDisabled = !!plan.busy || !!plan.composing || !plan.dirty || !!plan.conflict || typeof onPlanSave !== 'function';
  return <details className="project-plan-panel" open={!!plan.open} onToggle={event => { if (event.currentTarget.open !== !!plan.open) onPlanToggle?.(event.currentTarget.open); }}>
    <summary><span>{t('独立项目计划', 'Standalone project plan')}</span><small>{plan.dirty ? t('未保存', 'Unsaved') : text(plan.value) ? t('Markdown', 'Markdown') : t('尚未填写', 'Empty')}</small></summary>
    <div className="project-plan-body">
      <p id={helpId} className="schedule-note">{t('保留原有项目计划，独立于项目记忆。支持 Markdown 源码编辑与只读预览。', 'Your original project plan, separate from project memory. Edit Markdown source or open a read-only preview.')}</p>
      <div ref={inputRef} onCompositionStart={() => { composing.current = true; onPlanComposition?.(true); }}
        onCompositionEnd={event => { composing.current = false; onPlanChange?.(event.target.value); onPlanComposition?.(false); }}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!event.isComposing && !event.nativeEvent?.isComposing && !composing.current && !saveDisabled) onPlanSave?.(); } }}>
        <TextArea value={text(plan.value)} onChange={onPlanChange} disabled={!!plan.busy} rows={8}
          placeholder={t('写下目标、范围与执行步骤…', 'Goals, scope and next steps…')} />
      </div>
      <div className="project-plan-actions">
        <ScheduleAction marker="data-plan-save" variant="primary" size="sm" disabled={saveDisabled} loading={!!plan.busy} onClick={onPlanSave}>{t('保存计划', 'Save plan')}</ScheduleAction>
        <ScheduleAction marker="data-plan-preview" variant="ghost" size="sm" disabled={!!plan.composing} onClick={onPlanPreview}
          aria-expanded={!!plan.preview}>{plan.preview ? t('关闭预览', 'Close preview') : t('预览', 'Preview')}</ScheduleAction>
        {!!plan.dirty && !plan.conflict && <ScheduleAction marker="data-plan-discard" variant="ghost" size="sm" disabled={!!plan.busy || !!plan.composing}
          onClick={() => onPlanResolve?.('saved')}>{t('放弃修改', 'Discard changes')}</ScheduleAction>}
        <span className="schedule-note" role="status" aria-live="polite">{plan.busy ? t('正在保存…', 'Saving…') : plan.saved && !plan.dirty ? t('已保存', 'Saved') : plan.dirty ? t('有未保存修改', 'Unsaved changes') : ''}</span>
      </div>
      {text(plan.error) && <p className="project-plan-error" role="alert">{plan.error}</p>}
      {!!plan.conflict && <div className="project-plan-conflict" role="alert">
        <p>{t('已保存版本发生变化。草稿仍在上方，请比较后选择继续编辑的版本。', 'The saved version changed. Your draft remains above. Compare the versions before continuing.')}</p>
        <details><summary>{t('比较已保存版本', 'Compare saved version')}</summary><pre data-user-content>{text(plan.savedVersion)}</pre>
          <div className="project-plan-actions">
            <Button variant="secondary" size="sm" disabled={!!plan.busy || !!plan.composing} onClick={() => onPlanResolve?.('draft')}>{t('保留草稿，继续编辑', 'Keep draft and continue editing')}</Button>
            <Button variant="ghost" size="sm" disabled={!!plan.busy || !!plan.composing} onClick={() => onPlanResolve?.('saved')}>{t('放弃草稿，载入此版本', 'Discard draft and load this version')}</Button>
          </div>
        </details>
      </div>}
      {!!plan.preview && <article className="project-plan-preview document-markdown" aria-label={t('项目计划只读预览', 'Read-only project plan preview')} data-user-content
        dangerouslySetInnerHTML={{ __html: text(plan.previewHTML) }} />}
    </div>
  </details>;
}

export function ProjectScheduleSurface({ available = false, range = '', currentWeek = false, weekCount = 0, openCount = 0,
  days = [], unscheduled = [], invalid = [], onWeek, onTask, plan, ...planActions }) {
  if (!available) return <section className="project-schedule-kit"><EmptyState title={t('项目当前不可用', 'Project unavailable')} /></section>;
  return <section className="project-schedule-kit" aria-label={t('项目排期', 'Project schedule')}>
    <header className="schedule-toolbar">
      <div className="schedule-nav">
        <ScheduleAction marker="data-schedule-prev" variant="ghost" size="sm" aria-label={t('上一周', 'Previous week')} disabled={typeof onWeek !== 'function'} onClick={() => onWeek?.(-1)}>‹</ScheduleAction>
        <h2 className="schedule-range">{text(range)}{currentWeek && <small>{t('本周', 'This week')}</small>}</h2>
        <ScheduleAction marker="data-schedule-next" variant="ghost" size="sm" aria-label={t('下一周', 'Next week')} disabled={typeof onWeek !== 'function'} onClick={() => onWeek?.(1)}>›</ScheduleAction>
      </div>
      <div className="schedule-toolbar-tail"><span className="schedule-note">{t(`本周 ${count(weekCount)} 项 · 待完成 ${count(openCount)} 项`, `${count(weekCount)} this week · ${count(openCount)} open`)}</span>
        <ScheduleAction marker="data-schedule-today" variant="ghost" size="sm" disabled={currentWeek || typeof onWeek !== 'function'} onClick={() => onWeek?.(0)}>{t('回到本周', 'This week')}</ScheduleAction></div>
    </header>
    <div className="schedule-week-list" key={list(days)[0]?.ts ?? 'week'} data-week-direction={weekDirection(list(days)[0]?.ts ?? null)}>{list(days).map(day => {
      const past = !day.isToday && Number.isFinite(day.ts) && day.ts < Date.now(), tasks = list(day.tasks);
      return <section key={day.ts} className={`schedule-day${day.isToday ? ' is-today' : ''}${past ? ' is-past' : ''}${tasks.length ? '' : ' is-empty'}`} aria-label={`${day.label} ${day.month}/${day.day}`}>
        <header className="schedule-day-head"><strong>{day.label}</strong><time className="schedule-day-date">{day.month}/{day.day}</time>{day.isToday && <small>{t('今天', 'Today')}</small>}</header>
        <div className="schedule-day-body">{tasks.length ? taskList(tasks, onTask, day.isToday ? nowIndex(tasks) : -1) : <p className="schedule-day-empty">{t('无安排', 'No tasks')}</p>}</div>
      </section>;
    })}</div>
    {!!list(unscheduled).length && <section className="schedule-extra" aria-label={t('未安排', 'Unscheduled')}><header><h3>{t('未安排', 'Unscheduled')}</h3><span className="schedule-note">{list(unscheduled).length}</span></header>{taskList(unscheduled, onTask)}</section>}
    {!!list(invalid).length && <section className="schedule-extra schedule-invalid" aria-label={t('待修正日期', 'Dates to correct')}><header><h3>{t('待修正日期', 'Dates to correct')}</h3><span className="schedule-note">{list(invalid).length}</span></header><p className="schedule-note">{t('这些任务的日期无法识别，打开任务即可修正。', 'These dates could not be read. Open a task to correct it.')}</p>{taskList(invalid, onTask)}</section>}
    <SchedulePlan plan={plan} {...planActions} />
  </section>;
}
