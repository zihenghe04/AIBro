import React, { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button, Heading, TextInput, TextArea } from './halaska-kit.jsx';
import { KitCheckbox, KitSelect } from './kit-controls.jsx';
import styles from './task-detail.css';

if (!document.getElementById('task-detail-styles')) {
  const style = document.createElement('style'); style.id = 'task-detail-styles';
  style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
const copy = value => JSON.parse(JSON.stringify(value));
function Field({ id, label, multiline, required, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const input = ref.current.querySelector('input,textarea');
    input.id = id; input.name = id; input.required = !!required;
    input.setAttribute('aria-label', label); input.autocomplete = 'off';
  }, [id, label, required]);
  const Component = multiline ? TextArea : TextInput;
  return <div className="task-detail-field" ref={ref}><label htmlFor={id}>{label}</label><Component {...props} /></div>;
}
function Choice({ id, label, ...props }) {
  return <div className="task-detail-field"><label htmlFor={id}>{label}</label><KitSelect id={id} label={label} {...props} /></div>;
}
function Dependency({ item, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current.querySelector('input').dataset.dependencyId = item.id; }, [item.id]);
  return <div ref={ref} data-dependency-row={item.id}><KitCheckbox id={`taskDependency-${item.id}`} {...props} /></div>;
}
function Source({ kind, item, busy, onOpen }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const button = ref.current.querySelector('button');
    button.dataset.taskSourceType = kind; button.dataset.taskSourceId = item.id;
  }, [kind, item.id]);
  return <div ref={ref} className="task-detail-source"><Button variant="ghost" size="sm" disabled={busy} onClick={event => onOpen?.(kind, item.id, event.currentTarget)}><span className="task-detail-source-title">{item.name || item.title || item.id}</span><span className="task-detail-source-action">{t(kind === 'import' ? '预览' : '打开', kind === 'import' ? 'Preview' : 'Open')}</span></Button></div>;
}
const translatedOptions = rows => rows.map(([value, zh, en]) => ({ value, label: t(zh, en) }));

// Own every editable field. The controller's imperative draft adapter updates
// this state synchronously, so a document round-trip cannot leave controlled
// inputs displaying a restored DOM value while React still holds old values.
export function TaskDetailSurface({ taskId, title, location, initial = {}, projects = [], workflowOptions = [], dependencies = [], deliverables = {}, materials = [], knowledge = [], busy = false, error = '', notificationSupported = false, notificationStatus = '', onNotifications, onReady, onSave, onCancel, onDelete, onOpen }) {
  const [fields, setFields] = useState(() => ({ ...initial.fields }));
  const [checklist, setChecklist] = useState(() => copy(initial.checklist || []));
  const [dependsOn, setDependsOn] = useState(() => [...(initial.dependencies || [])]);
  const [groups, setGroups] = useState(() => ({ properties: false, completion: false, sources: false, ...(initial.groups || {}) }));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const current = useRef(null), composing = useRef(false), cancelAnchor = useRef(null);
  const dirty = JSON.stringify({ fields, checklist, dependencies: [...dependsOn].sort() }) !== JSON.stringify({ fields: initial.fields || {}, checklist: initial.checklist || [], dependencies: [...(initial.dependencies || [])].sort() });
  current.current = { fields, checklist, dependencies: dependsOn, groups, busy, dirty, onCancel };
  const requestCancel = () => {
    if (current.current.busy) return;
    if (current.current.dirty) { cancelAnchor.current = document.activeElement; setConfirmDiscard(true); }
    else current.current.onCancel?.();
  };
  useLayoutEffect(() => {
    if (confirmDiscard) document.getElementById('taskContinueEditing')?.focus({ preventScroll: true });
  }, [confirmDiscard]);
  useLayoutEffect(() => {
    onReady?.({
      capture: () => copy({ fields: current.current.fields, checklist: current.current.checklist, dependencies: current.current.dependencies, groups: current.current.groups }),
      requestCancel,
      restore: draft => flushSync(() => {
        if (draft.fields) setFields(previous => ({ ...previous, ...draft.fields }));
        if (draft.checklist) setChecklist(copy(draft.checklist));
        if (draft.dependencies) setDependsOn([...draft.dependencies]);
        if (draft.groups) setGroups({ ...draft.groups });
      }),
    });
  }, [taskId, onReady]);
  const set = (id, value) => { if (!busy) setFields(previous => ({ ...previous, [id]: value })); };
  const field = (id, label, props = {}) => <Field id={id} label={label} value={fields[id] || ''} onChange={value => set(id, value)} disabled={busy} {...props} />;
  const choice = (id, label, options, onChange) => <Choice id={id} label={label} value={fields[id] || ''} options={options} onChange={onChange || (value => set(id, value))} disabled={busy} />;
  const group = (name, label, children) => <details className="task-detail-group" data-task-group={name} open={!!groups[name]} onToggle={event => {
    const open = event.currentTarget.open; setGroups(previous => previous[name] === open ? previous : { ...previous, [name]: open });
  }}><summary>{label}</summary><div className="task-detail-group-content">{children}</div></details>;
  const kind = fields.taskDeliverableKind || '';
  const pool = (deliverables[kind] || []).filter(item => item.id !== taskId && (!fields.taskProjectInput || (item.projectId || '') === fields.taskProjectInput));
  const references = [{ value: '', label: t('选择…', 'Choose…') }, ...pool.map(item => ({ value: item.id, label: item.title || item.id }))];
  if (fields.taskDeliverableRef && !references.some(item => item.value === fields.taskDeliverableRef)) references.push({ value: fields.taskDeliverableRef, label: t('原关联产出已不可用', 'Original deliverable unavailable') });
  const destinations = [{ value: '', label: t('未归属项目', 'No project') }, ...projects.map(item => ({ value: item.id, label: item.name }))];
  if (fields.taskProjectInput && !destinations.some(item => item.value === fields.taskProjectInput)) destinations.push({ value: fields.taskProjectInput, label: t('原归属项目已不可用', 'Original project unavailable') });
  const reminders = translatedOptions([['inherit', '跟随本机设置', 'Use device settings'], ['off', '不提醒', 'Off'], ['0', '到点提醒', 'At deadline'], ['15', '提前 15 分钟', '15 minutes before'], ['60', '提前 1 小时', '1 hour before'], ['1440', '提前 1 天', '1 day before']]);
  if (!reminders.some(item => item.value === fields.taskReminderInput)) reminders.push({ value: fields.taskReminderInput, label: t(`提前 ${fields.taskReminderInput} 分钟`, `${fields.taskReminderInput} minutes before`) });
  const addItem = () => {
    const text = (fields.newChecklistItem || '').trim(); if (busy || !text) return;
    setChecklist(previous => [...previous, { text, done: false }]); set('newChecklistItem', '');
  };
  return <form id="taskForm" className="task-detail-surface" data-user-content data-task-dirty={dirty ? 'true' : 'false'} aria-busy={busy || undefined}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.key !== 'Enter') return;
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
      if (event.target.id === 'newChecklistItem') { event.preventDefault(); addItem(); }
    }}
    onSubmit={event => { event.preventDefault(); if (!busy && !composing.current) onSave?.(); }}>
    <header className="task-detail-header"><div><div id="taskDialogTitle"><Heading level={2}>{t('任务详情', 'Task details')}</Heading></div><p id="taskDialogBreadcrumb">{location}</p></div><Button variant="ghost" size="sm" disabled={busy} aria-label={t('关闭', 'Close')} onClick={requestCancel}>×</Button></header>
    <section className="task-detail-main" aria-label={t('任务内容', 'Task content')}>
      {field('taskTitleInput', t('任务名称', 'Task name'), { required: true })}
      {field('taskDescriptionInput', t('详情', 'Details'), { multiline: true, rows: 3, placeholder: t('背景、验收标准或下一步', 'Context, acceptance criteria or next step') })}
      <div className="task-detail-primary-properties">
        {choice('taskStatusInput', t('状态', 'Status'), translatedOptions([['todo', '待开始', 'To do'], ['in_progress', '进行中', 'In progress'], ['blocked', '受阻', 'Blocked'], ['done', '已完成', 'Done']]))}
        {choice('taskPriorityInput', t('优先级', 'Priority'), translatedOptions([['low', '低', 'Low'], ['medium', '中', 'Medium'], ['high', '高', 'High']]))}
        <div title={t('分类独立于空间、项目和优先级；与灵动岛待办共用。', 'Shared with island tasks; separate from space, project and priority.')}>{choice('taskWorkflowInput', t('任务分类', 'Task category'), [{ value: '', label: t('未分类', 'Uncategorized') }, ...workflowOptions])}</div>
        {field('taskDueInput', t('截止日期', 'Due date'), { type: 'date' })}
      </div>
    </section>
    <section className="task-detail-checklist" aria-labelledby="taskChecklistLabel"><h3 id="taskChecklistLabel">{t('检查清单', 'Checklist')}</h3>
      <div id="taskChecklist">{checklist.length ? checklist.map((item, index) => <div key={index} className={`task-detail-check ${item.done ? 'is-done' : ''}`} data-check-index={index}>
        <KitCheckbox id={`taskCheck-${index}`} checked={!!item.done} label={item.text} disabled={busy} onChange={done => { if (!busy) setChecklist(previous => previous.map((row, n) => n === index ? { ...row, done } : row)); }} />
        <Button variant="ghost" size="sm" disabled={busy} aria-label={t(`移除检查项：${item.text}`, `Remove item: ${item.text}`)} onClick={() => setChecklist(previous => previous.filter((_, n) => n !== index))}>×</Button>
      </div>) : <p className="task-detail-empty">{t('还没有检查项', 'No checklist items')}</p>}</div>
      <div className="task-detail-check-add">{field('newChecklistItem', t('新检查项', 'New checklist item'), { placeholder: t('拆成一个具体步骤', 'Add a concrete step') })}<Button id="addChecklistItem" variant="secondary" size="sm" disabled={busy || !(fields.newChecklistItem || '').trim()} onClick={addItem}>{t('添加', 'Add')}</Button></div>
    </section>
    {group('properties', t('更多属性', 'More properties'), <div className="task-detail-properties">
      {choice('taskWorkspaceInput', t('所属空间', 'Space'), translatedOptions([['日常', '日常', 'Daily'], ['课程', '课程', 'Courses'], ['科研', '科研', 'Research']]), workspace => { if (!busy) setFields(previous => ({ ...previous, taskWorkspaceInput: workspace, taskProjectInput: projects.find(item => item.id === previous.taskProjectInput)?.workspace === workspace ? previous.taskProjectInput : '' })); })}
      {choice('taskProjectInput', t('归属项目', 'Project'), destinations, projectId => { if (!busy) setFields(previous => ({ ...previous, taskProjectInput: projectId, taskWorkspaceInput: projects.find(item => item.id === projectId)?.workspace || previous.taskWorkspaceInput })); })}
      {field('taskStartInput', t('开始日期', 'Start date'), { type: 'date' })}
      {field('taskTimeInput', t('截止时间（本地，可选）', 'Due time (local, optional)'), { type: 'time' })}
      {choice('taskReminderInput', t('提醒', 'Reminder'), reminders)}
      <div className="task-detail-notifications"><small>{t('仅填写日期时，按当天 09:00 提醒。', 'All-day tasks use a 09:00 reminder.')}</small>{notificationSupported && <Button id="taskEnableNotifications" variant="ghost" size="sm" disabled={busy} onClick={onNotifications}>{t('开启本机通知', 'Enable device notifications')}</Button>}<small id="taskNotificationStatus" role="status">{notificationStatus}</small></div>
    </div>)}
    {group('completion', t('前置任务与产出要求', 'Prerequisites and deliverable'), <>
      <div id="taskDependencyFields" className="task-detail-dependencies"><h3>{t('前置任务', 'Prerequisites')}</h3>{dependencies.length ? dependencies.map(item => <Dependency key={item.id} item={item} checked={dependsOn.includes(item.id)} disabled={busy} label={item.available ? item.title : t('已不可用的前置任务，可取消此关联', 'Unavailable prerequisite; remove this link')} description={item.available && item.status === 'done' ? t('已完成', 'Done') : undefined}
        onChange={checked => { if (!busy) setDependsOn(previous => checked ? [...new Set([...previous, item.id])] : previous.filter(id => id !== item.id)); }} />) : <p className="task-detail-empty">{t('没有可选的前置任务', 'No prerequisites available')}</p>}</div>
      <div className="task-detail-deliverable">{choice('taskDeliverableKind', t('产出要求（可选）', 'Deliverable (optional)'), translatedOptions([['', '无', 'None'], ['note', '需存在一条笔记', 'Requires a note'], ['task', '需存在一个已完成任务', 'Requires a completed task'], ['text', '内容需包含关键词', 'Requires a keyword']]), value => { if (!busy) setFields(previous => ({ ...previous, taskDeliverableKind: value, taskDeliverableRef: value === previous.taskDeliverableKind ? previous.taskDeliverableRef : '' })); })}
        <div id="taskDeliverableValue">{kind === 'text' ? field('taskDeliverableRef', t('关键词', 'Keyword')) : ['note', 'task'].includes(kind) ? choice('taskDeliverableRef', t('关联产出', 'Deliverable reference'), references) : null}</div>
      </div>
    </>)}
    {group('sources', t(`关联材料与知识 · ${materials.length + knowledge.length}`, `Sources and knowledge · ${materials.length + knowledge.length}`), <div className="task-detail-sources">
      <h3>{t('关联材料', 'Source files')}</h3>{materials.length ? materials.map(item => <Source key={item.id} kind="import" item={item} busy={busy} onOpen={onOpen} />) : <p className="task-detail-empty">{t('暂无关联材料', 'No source files')}</p>}
      <h3>{t('关联知识', 'Related knowledge')}</h3>{knowledge.length ? knowledge.map(item => <Source key={item.id} kind="note" item={item} busy={busy} onOpen={onOpen} />) : <p className="task-detail-empty">{t('暂无关联知识', 'No related knowledge')}</p>}
    </div>)}
    {error && <p className="task-detail-error" role="alert">{error}</p>}
    {confirmDiscard && <section className="task-detail-discard" role="alertdialog" aria-labelledby="taskDiscardTitle" aria-describedby="taskDiscardDescription"><h3 id="taskDiscardTitle">{t('放弃未保存的修改？', 'Discard unsaved changes?')}</h3><p id="taskDiscardDescription">{t('这些输入尚未保存到任务。', 'These changes have not been saved to the task.')}</p><div><Button id="taskContinueEditing" variant="secondary" disabled={busy} onClick={() => { setConfirmDiscard(false); cancelAnchor.current?.isConnected && cancelAnchor.current.focus?.({ preventScroll: true }); }}>{t('继续编辑', 'Keep editing')}</Button><Button id="taskDiscardChanges" variant="primary" disabled={busy} onClick={onCancel}>{t('放弃修改', 'Discard changes')}</Button></div></section>}
    <footer className="task-detail-actions"><Button id="deleteTask" variant="ghost" size="sm" disabled={busy} onClick={onDelete}>{t('移入回收站', 'Move to Trash')}</Button><div><Button id="cancelTask" variant="secondary" disabled={busy} onClick={requestCancel}>{dirty ? t('放弃修改', 'Discard changes') : t('关闭', 'Close')}</Button><Button id="saveTask" type="submit" variant="primary" loading={busy}>{busy ? t('正在保存…', 'Saving…') : t('保存任务', 'Save task')}</Button></div></footer>
  </form>;
}
