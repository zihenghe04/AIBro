import React, { useState } from 'react';
import { Button, EmptyState } from './halaska-kit.jsx';
import { KitSelect, KitSegmentedControl } from './kit-controls.jsx';
import { Plus, GripVertical, Circle, CircleDot, PauseCircle, CheckCircle2, ArrowUpRight } from 'lucide-react';
import styles from './project-board.css';
import { layoutMotion } from './planning-motion.js';

const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const states = ['todo', 'in_progress', 'blocked', 'done'];
const labels = () => ({ todo: t('待开始', 'To do'), in_progress: t('进行中', 'In progress'), blocked: t('受阻', 'Blocked'), done: t('已完成', 'Done') });
const statusIcons = { todo: Circle, in_progress: CircleDot, blocked: PauseCircle, done: CheckCircle2 };

function parseDue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? { date: new Date(value), dateOnly: false } : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number), calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(0, 0, 0, 0);
  if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const dateOnly = value.length === 10;
  if (!dateOnly) {
    const clock = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59) return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { date, dateOnly } : null;
}
// Presentation only: the chip tone never changes or reorders a task.
function dueTone(parsed, done, now = new Date()) {
  if (!parsed || done) return '';
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const due = parsed.dateOnly ? new Date(parsed.date.getUTCFullYear(), parsed.date.getUTCMonth(), parsed.date.getUTCDate()) : parsed.date;
  if (parsed.dateOnly ? due < day : due < now) return 'is-overdue';
  const dueDay = new Date(due); dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay - day) / 864e5);
  return days === 0 ? 'is-today' : days > 0 && days <= 2 ? 'is-soon' : '';
}
function DueDate({ value, done }) {
  if (!value) return <span className="project-task-undated">{t('未排期', 'Unscheduled')}</span>;
  const parsed = parseDue(value);
  if (!parsed) return <span className="project-task-due-chip is-invalid">{t('日期待修正', 'Check date')}</span>;
  const { date, dateOnly } = parsed, tone = dueTone(parsed, done);
  // Calendar-only deadlines must not shift to the previous day in US timezones.
  const shown = dateOnly ? new Date(`${value}T12:00:00`) : date;
  const label = shown.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return <time className={`project-task-due-chip${tone ? ' ' + tone : ''}`} dateTime={dateOnly ? value : date.toISOString()} title={t('截止日期', 'Due date')}>
    {tone === 'is-overdue' ? t(`已逾期 · ${label}`, `Overdue · ${label}`) : tone === 'is-today' ? t(`今天 · ${label}`, `Today · ${label}`) : label}</time>;
}

function TaskRow({ task, board, busy, onOpen, onStatus, onDragStart, onDragEnd }) {
  const [dragging, setDragging] = useState(false), Icon = statusIcons[task.status] || Circle, done = task.status === 'done';
  return <li className={`project-task-item${board ? ' is-board-item' : ''}${dragging ? ' is-dragging' : ''}`} data-board-task={task.id} data-task-status={task.status} data-motion-done={done ? 'true' : 'false'} aria-busy={busy || undefined}
    draggable={!!board && !busy} onDragStart={event => {
      if (!board || busy || onDragStart?.(task.id) !== true) { event.preventDefault(); return; }
      event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; setDragging(true);
    }} onDragEnd={() => { setDragging(false); onDragEnd?.(); }}>
    {/* The same guarded status action as the selector; done reopens to To do. */}
    <button type="button" className={`project-task-state-icon status-${task.status}`} disabled={busy || typeof onStatus !== 'function'} aria-pressed={done}
      aria-label={done ? t(`标记为未完成：${task.title}`, `Mark incomplete: ${task.title}`) : t(`标记为已完成：${task.title}`, `Mark complete: ${task.title}`)}
      onClick={() => onStatus?.(task.id, done ? 'todo' : 'done')}><Icon size={17} aria-hidden="true" /></button>
    <div className="project-task-copy">
      <Button variant="ghost" size="sm" style={{ padding: 0, height: 'auto', justifyContent: 'flex-start', textAlign: 'left' }} onClick={event => onOpen?.(task.id, event.currentTarget)} title={task.title}>
        <span className="project-task-title" data-user-content>{task.title}</span>
        <ArrowUpRight className="project-task-open-hint" size={13} aria-hidden="true" />
      </Button>
      {task.prerequisitesIncomplete && <span className="project-task-prerequisite">{t('前置任务未就绪', 'Prerequisites not ready')}</span>}
    </div>
    <span className="project-task-due"><DueDate value={task.dueAt} done={done} /></span>
    <div className="project-task-status-select"><KitSelect value={task.status} options={states.map(value => ({ value, label: labels()[value] }))} disabled={busy}
      label={t(`更改任务状态：${task.title}`, `Change task status: ${task.title}`)} attributes={{ 'data-task-status-select': task.id }} onChange={status => onStatus?.(task.id, status)} /></div>
    {board && <span className="project-task-drag-hint" aria-hidden="true"><GripVertical size={14} /></span>}
  </li>;
}

function Column({ status, tasks, busyIds, canDrop, onDrop, ...actions }) {
  const [over, setOver] = useState(false);
  return <section className={`project-board-column${over ? ' is-over' : ''}`} data-board-status={status} aria-label={labels()[status]}
    onDragOver={event => { if (canDrop?.()) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
    onDrop={event => { event.preventDefault(); setOver(false); if (canDrop?.()) onDrop?.(status); }}>
    <h3><span className="project-board-column-title"><span className={`project-board-column-dot status-${status}`} aria-hidden="true" />{labels()[status]}</span><span className="project-board-column-count">{tasks.length}</span></h3>
    <ul className="project-task-items">{tasks.map(task => <TaskRow key={task.id} task={task} board busy={busyIds.includes(task.id)} {...actions} />)}</ul>
    {!tasks.length && <p className="project-board-empty-column">{t('暂无任务', 'No tasks')}</p>}
  </section>;
}

export function ProjectBoardPanel({ available = true, tasks = [], mode = 'list', busyIds = [], onMode, onOpen, onStatus, onCreate, onDragStart, onDragEnd, canDrop, onDrop }) {
  const actions = { onOpen, onStatus, onDragStart, onDragEnd };
  return <section className="project-tasks-kit" aria-label={t('项目任务', 'Project tasks')} ref={layoutMotion('data-board-task')} data-motion-mode={mode}>
    <style>{styles}</style>
    {available && <div className="project-tasks-toolbar">
      <KitSegmentedControl value={mode} onChange={onMode} label={t('任务显示方式', 'Task view')} options={[
        { value: 'list', label: t('列表', 'List') }, { value: 'board', label: t('看板', 'Board') }
      ]} />
      {onCreate && <Button size="sm" variant="primary" onClick={onCreate}><Plus size={14} aria-hidden="true" />{t('添加任务', 'Add task')}</Button>}
    </div>}
    {!available ? <EmptyState title={t('项目当前不可用', 'Project unavailable')} /> : !tasks.length ? <div className="project-tasks-empty"><EmptyState title={t('还没有任务', 'No tasks yet')} description={t('添加这个项目的下一步。', 'Add the next step for this project.')} /></div> : mode === 'board'
      ? <div className="project-task-board" id="projectTaskBoard">{states.map(status => <Column key={status} status={status} tasks={tasks.filter(task => task.status === status)} busyIds={busyIds} canDrop={canDrop} onDrop={onDrop} {...actions} />)}</div>
      : <ul className="project-task-items is-task-list" aria-label={t('任务列表', 'Task list')}>{tasks.map(task => <TaskRow key={task.id} task={task} busy={busyIds.includes(task.id)} {...actions} />)}</ul>}
  </section>;
}
