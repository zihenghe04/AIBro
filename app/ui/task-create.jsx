import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button, TextInput, TextArea, Heading } from './halaska-kit.jsx';
import { KitSelect } from './kit-controls.jsx';
import styles from './task-create.css';

if (!document.getElementById('task-create-styles')) {
  const style = document.createElement('style'); style.id = 'task-create-styles';
  style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
function Field({ id, label, multiline, required, maxLength, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const input = ref.current.querySelector('input,textarea');
    input.id = id; input.name = id; input.required = !!required;
    input.setAttribute('aria-label', label); input.autocomplete = 'off';
    if (maxLength) input.maxLength = maxLength;
  }, [id, label, required, maxLength]);
  const Component = multiline ? TextArea : TextInput;
  return <div className="task-create-field" ref={ref}><label htmlFor={id}>{label}</label><Component {...props} /></div>;
}

export function TaskCreateForm({ initial = {}, projects = [], workflowOptions = [], busy = false, error = '', onSubmit, onCancel }) {
  const [values, setValues] = useState(() => ({ title: '', description: '', workspace: '日常', projectId: '', status: 'todo', priority: 'medium', workflowCategory: '', startAt: '', dueAt: '', ...initial }));
  const [details, setDetails] = useState(false);
  const composing = useRef(false);
  const set = (key, value) => { if (!busy) setValues(previous => ({ ...previous, [key]: value })); };
  const project = projects.find(item => item.id === values.projectId);
  const options = (rows) => rows.map(([value, zh, en]) => ({ value, label: t(zh, en) }));
  return <form id="planningCreateForm" className="task-create-form" data-dirty={JSON.stringify(values) !== JSON.stringify({ title: '', description: '', workspace: '日常', projectId: '', status: 'todo', priority: 'medium', workflowCategory: '', startAt: '', dueAt: '', ...initial }) ? 'true' : 'false'} data-user-content aria-busy={busy || undefined}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
    onSubmit={event => { event.preventDefault(); if (!busy && !composing.current) onSubmit?.({ ...values, workflowCategory: values.workflowCategory || null }); }}>
    <header className="task-create-heading"><div id="planningCreateDialogTitle"><Heading level={2}>{t('添加任务', 'Add task')}</Heading></div><Button variant="ghost" size="sm" disabled={busy} aria-label={t('关闭', 'Close')} onClick={onCancel}>×</Button></header>
    <div className="task-create-content">
    <p className="task-create-location">{project?.name || t(values.workspace, ({ 日常: 'Daily', 课程: 'Courses', 科研: 'Research' })[values.workspace] || values.workspace)}</p>
    <Field id="planningTaskTitle" label={t('任务名称', 'Task name')} value={values.title} onChange={value => set('title', value)} required maxLength={500} disabled={busy} placeholder={t('下一步要完成什么？', 'What needs to happen next?')} />
    <Field id="planningTaskDescription" label={t('详情（可选）', 'Details (optional)')} value={values.description} onChange={value => set('description', value)} multiline rows={3} maxLength={20000} disabled={busy} placeholder={t('背景、目标或验收标准', 'Context, goal or acceptance criteria')} />
    <div className="task-create-dates"><Field id="planningTaskDue" label={t('截止日期（可选）', 'Due date (optional)')} type="date" value={values.dueAt || ''} onChange={value => set('dueAt', value)} disabled={busy} />
      <div className="task-create-field" title={t('分类独立于空间、项目和优先级；与灵动岛待办共用。', 'Shared with island tasks; separate from space, project and priority.')}><label htmlFor="planningTaskWorkflow">{t('任务分类', 'Task category')}</label><KitSelect id="planningTaskWorkflow" label={t('任务分类', 'Task category')} disabled={busy} value={values.workflowCategory || ''} options={[{ value: '', label: t('未分类', 'Uncategorized') }, ...workflowOptions]} onChange={value => set('workflowCategory', value)} /></div></div>
      <Button variant="ghost" size="sm" disabled={busy} aria-expanded={details} aria-controls="taskCreateDetails" onClick={() => setDetails(!details)}>{details ? t('收起属性', 'Fewer properties') : t('更多属性', 'More properties')}</Button>
    {details && <div id="taskCreateDetails" className="task-create-details">
      <div><label htmlFor="planningTaskWorkspace">{t('所属空间', 'Space')}</label><KitSelect id="planningTaskWorkspace" label={t('所属空间', 'Space')} disabled={busy} value={values.workspace} options={options([['日常', '日常', 'Daily'], ['课程', '课程', 'Courses'], ['科研', '科研', 'Research']])}
        onChange={workspace => setValues(previous => ({ ...previous, workspace, projectId: projects.find(item => item.id === previous.projectId)?.workspace === workspace ? previous.projectId : '' }))} /></div>
      <div><label htmlFor="planningTaskProject">{t('归属项目', 'Project')}</label><KitSelect id="planningTaskProject" label={t('归属项目', 'Project')} disabled={busy} value={values.projectId || ''} options={[{ value: '', label: t('未归属项目', 'No project') }, ...projects.map(item => ({ value: item.id, label: item.name }))]}
        onChange={projectId => setValues(previous => ({ ...previous, projectId, workspace: projects.find(item => item.id === projectId)?.workspace || previous.workspace }))} /></div>
      <div><label htmlFor="planningTaskStatus">{t('状态', 'Status')}</label><KitSelect id="planningTaskStatus" label={t('状态', 'Status')} disabled={busy} value={values.status} onChange={value => set('status', value)} options={options([['todo', '待开始', 'To do'], ['in_progress', '进行中', 'In progress'], ['blocked', '受阻', 'Blocked'], ['done', '已完成', 'Done']])} /></div>
      <div><label htmlFor="planningTaskPriority">{t('优先级', 'Priority')}</label><KitSelect id="planningTaskPriority" label={t('优先级', 'Priority')} disabled={busy} value={values.priority} onChange={value => set('priority', value)} options={options([['low', '低', 'Low'], ['medium', '中', 'Medium'], ['high', '高', 'High']])} /></div>
      <Field id="planningTaskStart" label={t('开始日期（可选）', 'Start date (optional)')} type="date" value={values.startAt || ''} onChange={value => set('startAt', value)} disabled={busy} />
    </div>}
    {error && <p className="planning-error" role="alert" id="planningCreateError">{error}</p>}
    </div>
    <footer className="task-create-actions"><Button variant="secondary" disabled={busy} onClick={onCancel}>{t('取消', 'Cancel')}</Button><Button type="submit" id="planningCreateSubmit" variant="primary" loading={busy}>{busy ? t('正在保存…', 'Saving…') : t('添加任务', 'Add task')}</Button></footer>
  </form>;
}
