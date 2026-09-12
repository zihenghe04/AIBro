(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlanningWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SPACES = ['日常', '课程', '科研'];
  const STATUSES = { todo: '待开始', in_progress: '进行中', done: '已完成', blocked: '受阻' };
  const PRIORITIES = { low: '低', medium: '中', high: '高' };
  const TYPES = { task: '任务', note: '知识', import: '资料', project: '项目' };
  const DAY = 86400000;
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const active = value => !!value?.id && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt;
  const workspace = value => SPACES.includes(value) ? value : '日常';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const keyFor = (type, id) => JSON.stringify([type, id]);
  const byName = (a, b) => String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''), 'zh-CN') || String(a.id).localeCompare(String(b.id));
  let hooks = {}, createDialog, moveDialog, creating = false, moving = false;
  const stateNow = () => hooks.getState?.() || {};
  const clock = () => hooks.now?.() ?? Date.now();
  const doc = () => hooks.document || globalThis.document;
  const $ = selector => doc().querySelector(selector);

  function timelineScale(extent, options = {}) {
    if (!extent) return null;
    const d3 = options.d3 || globalThis.d3;
    let min = extent.min, max = extent.max;
    if (min === max) { const day = new Date(min); day.setHours(0, 0, 0, 0); min = day.getTime(); day.setDate(day.getDate()+1); max = day.getTime(); }
    const span = max-min, hourly = span <= 2 * DAY;
    const budget = Math.max(2, Math.min(6, Math.floor((options.width || 440) / (hourly ? 80 : 75))));
    let values;
    if (d3?.scaleTime) {
      const scale = d3.scaleTime().domain([min,max]);
      values = hourly ? scale.ticks(budget).map(Number) : scale.ticks(d3.timeDay.every(Math.max(1, Math.ceil(span / DAY / budget)))).map(Number);
    } else if (hourly) {
      const hour = 3600000, stride = [1,2,3,6,12,24].find(value => value * hour >= span / budget) || 24;
      const first = Math.ceil(min / (stride * hour)) * stride * hour;
      values = Array.from({ length: Math.max(0, Math.floor((max-first)/(stride*hour))+1) }, (_,i) => first+i*stride*hour);
    } else {
      const first = new Date(min); first.setHours(0,0,0,0); if (+first < min) first.setDate(first.getDate()+1);
      const stride = Math.max(1,Math.ceil(span / DAY / budget)); values=[];
      for (let date = first; +date <= max; date.setDate(date.getDate()+stride)) values.push(+date);
    }
    if (!values?.length) values = [min,max];
    const dayLabel = value => dateField(value).slice(5);
    const minDay = dateField(min);
    const seen = new Set();
    const ticks = values.map(value => {
      const date = new Date(value), clock = `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const label = hourly ? `${dateField(value) === minDay ? '' : dayLabel(value)+' '}${clock}` : dayLabel(value);
      return { value, label, full: hourly ? `${dateField(value)} ${clock}` : dateField(value), position: (value-min)/span*100 };
    }).filter(tick => !seen.has(tick.label) && seen.add(tick.label));
    return { min, max, span, ticks, hourly, caption: minDay === dateField(max-1) ? minDay : `${minDay} — ${dateField(max)}` };
  }

  function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? { timestamp: value, dateOnly: false } : null;
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(0, 0, 0, 0);
    if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
    const dateOnly = value.length === 10;
    let timestamp;
    if (dateOnly) { const local = new Date(0); local.setFullYear(year, month - 1, day); local.setHours(0, 0, 0, 0); timestamp = local.getTime(); }
    else {
      const time = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) return null;
      timestamp = Date.parse(value);
    }
    return Number.isFinite(timestamp) ? { timestamp, dateOnly } : null;
  }
  function dateField(value) {
    const parsed = parseDate(value); if (!parsed) return '';
    if (parsed.dateOnly) return value;
    const local = new Date(parsed.timestamp);
    return `${String(local.getFullYear()).padStart(4, '0')}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  }
  function inputDate(value, label, previous) {
    const text = String(value || '').trim(); if (!text) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !parseDate(text)) throw new Error(`${label}无效，请选择真实的日历日期。`);
    return dateField(previous) === text ? previous : text;
  }
  function validateDates(startAt, dueAt) {
    const start = parseDate(startAt), due = parseDate(dueAt);
    if (startAt && !start) throw new Error('开始日期无效。');
    if (dueAt && !due) throw new Error('截止日期无效。');
    // A date-only deadline covers that calendar day, including timed starts.
    const dueEnd = due?.dateOnly ? nextDay(due.timestamp) - 1 : due?.timestamp;
    if (start && due && start.timestamp > dueEnd) throw new Error('截止日期不能早于开始日期。');
    return { start, due };
  }
  function nextDay(timestamp) { const next = new Date(timestamp); next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0); return next.getTime(); }
  function scopeInfo(state, scope = {}) {
    const projects = new Map(list(state.projects).filter(active).map(project => [project.id, project]));
    const project = scope.projectId ? projects.get(scope.projectId) : null;
    const valid = (!scope.projectId || !!project) && (!scope.workspace || SPACES.includes(scope.workspace)) && (!project || !scope.workspace || workspace(project.workspace) === scope.workspace);
    const matches = item => active(item) && (!item.projectId || projects.has(item.projectId)) && valid && (!scope.projectId || item.projectId === scope.projectId) && (!scope.workspace || workspace(projects.get(item.projectId)?.workspace || item.workspace) === scope.workspace);
    return { projects, project, valid, matches };
  }
  function destination(state, input = {}) {
    if (input.projectId) {
      const project = list(state.projects).find(item => item.id === input.projectId && active(item));
      if (!project) throw new Error('目标项目已归档、删除或不可用，请重新选择。');
      return { projectId: project.id, project: project.name || '未命名项目', workspace: workspace(project.workspace) };
    }
    if (!SPACES.includes(input.workspace)) throw new Error('请选择日常、课程或科研空间。');
    return { projectId: null, project: null, workspace: input.workspace };
  }
  function planCreate(state, input = {}, context = {}) {
    const title = String(input.title || '').trim(), description = String(input.description || '').trim();
    if (!title) throw new Error('请填写任务名称。');
    if (title.length > 500) throw new Error('任务名称不能超过 500 个字符。');
    if (description.length > 20000) throw new Error('任务详情不能超过 20000 个字符。');
    const status = input.status || 'todo', priority = input.priority || 'medium';
    if (!Object.hasOwn(STATUSES, status)) throw new Error('任务状态无效。');
    if (!Object.hasOwn(PRIORITIES, priority)) throw new Error('任务优先级无效。');
    const startAt = input.startAt || null, dueAt = input.dueAt || null; validateDates(startAt, dueAt);
    const target = destination(state, input);
    const id = context.uid ? context.uid('task') : `task_${globalThis.crypto.randomUUID()}`;
    if (typeof id !== 'string' || !id || list(state.tasks).some(task => task.id === id)) throw new Error('任务编号冲突，请重试。');
    const now = context.now ?? Date.now();
    return { id, title, description, ...target, status, priority, startAt, dueAt, checklist: [], sourceAttachmentIds: [], createdAt: now, updatedAt: now, completedAt: status === 'done' ? now : null };
  }
  function planMove(state, ids, target, context = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请选择 1 至 2000 个任务。');
    const unique = [...new Set(ids)], info = scopeInfo(state, context.scope || {});
    const tasks = unique.map(id => list(state.tasks).find(task => task.id === id && info.matches(task)));
    if (tasks.some(task => !task)) throw new Error('所选任务已归档、删除或移出当前范围，请重新选择。');
    const patch = destination(state, target), now = context.now ?? Date.now();
    const updates = tasks.filter(task => task.projectId !== patch.projectId || workspace(task.workspace) !== patch.workspace || (task.project || null) !== patch.project).map(task => ({ id: task.id, patch: { ...patch, updatedAt: now } }));
    return { updates, count: updates.length, selectedCount: unique.length, destination: patch };
  }
  function derive(state, scope = {}, options = {}) {
    const info = scopeInfo(state, scope), now = options.now ?? Date.now();
    const tasks = list(state.tasks).filter(info.matches), notes = list(state.notes).filter(info.matches), imports = list(state.imports).filter(info.matches);
    const projects = [...info.projects.values()].filter(project => info.valid && (!scope.projectId || project.id === scope.projectId) && (!scope.workspace || workspace(project.workspace) === scope.workspace)).sort(byName);
    const counts = { total: tasks.length, done: 0, todo: 0, in_progress: 0, blocked: 0, overdue: 0, notes: notes.length, imports: imports.length, projects: projects.length };
    const timeline = []; let unscheduled = 0, invalidDates = 0;
    for (const task of tasks) {
      counts[Object.hasOwn(STATUSES, task.status) ? task.status : 'todo'] += 1;
      const start = parseDate(task.startAt), due = parseDate(task.dueAt);
      if (task.status !== 'done' && due && now >= (due.dateOnly ? nextDay(due.timestamp) : due.timestamp)) counts.overdue += 1;
      let invalid = !!task.startAt && !start || !!task.dueAt && !due;
      if (start && due && start.timestamp > (due.dateOnly ? nextDay(due.timestamp) - 1 : due.timestamp)) invalid = true;
      if (invalid) { invalidDates += 1; continue; }
      if (!start && !due) { unscheduled += 1; continue; }
      const kind = start && due ? 'range' : due ? 'deadline' : 'start';
      // Date-only end labels stay exact; do not manufacture a start for deadlines.
      timeline.push({ id: task.id, type: 'task', title: task.title || '未命名任务', status: task.status || 'todo', projectId: task.projectId || null,
        workspace: workspace(info.projects.get(task.projectId)?.workspace || task.workspace), startAt: task.startAt || null, dueAt: task.dueAt || null,
        start: start?.timestamp ?? null, end: due?.timestamp ?? null, kind,
        datePrecision: !!(start?.dateOnly || due?.dateOnly),
        durationDays: kind === 'range' ? Math.round((Date.parse(`${dateField(task.dueAt)}T00:00:00Z`) - Date.parse(`${dateField(task.startAt)}T00:00:00Z`)) / DAY) : null,
        durationMs: kind === 'range' && due.timestamp >= start.timestamp ? due.timestamp - start.timestamp : null });
    }
    timeline.sort((a, b) => (a.start ?? a.end) - (b.start ?? b.end) || String(a.id).localeCompare(String(b.id)));
    const points = timeline.flatMap(item => [item.start, item.end].filter(value => value !== null));
    const extent = points.length ? points.reduce((bounds, value) => ({ min: Math.min(bounds.min, value), max: Math.max(bounds.max, value) }), { min: Infinity, max: -Infinity }) : null;
    const progress = projects.map(project => { const owned = tasks.filter(task => task.projectId === project.id), done = owned.filter(task => task.status === 'done').length; return { id: project.id, name: project.name || '未命名项目', workspace: workspace(project.workspace), total: owned.length, done, percent: owned.length ? Math.round(done / owned.length * 100) : null }; });
    const nodes = projects.map(project => ({ key: keyFor('project', project.id), type: 'project', id: project.id, title: project.name || '未命名项目', workspace: workspace(project.workspace) }));
    const edges = [], unassigned = [];
    for (const [type, items] of [['task', tasks], ['note', notes], ['import', imports]]) for (const item of items) {
      const node = { key: keyFor(type, item.id), type, id: item.id, title: item.title || item.name || `未命名${TYPES[type]}`, projectId: item.projectId || null };
      nodes.push(node);
      if (item.projectId) edges.push({ from: keyFor('project', item.projectId), to: node.key, relation: 'project_membership' });
      else unassigned.push(node);
    }
    return { validScope: info.valid, scope: { ...scope }, counts, percent: tasks.length ? Math.round(counts.done / tasks.length * 100) : null,
      projects: progress, timeline, extent, unscheduled, invalidDates, graph: { nodes, edges, unassigned } };
  }

  function projectOptions(state, selected = '') {
    return '<option value="">未归属项目</option>' + list(state.projects).filter(active).sort((a, b) => SPACES.indexOf(workspace(a.workspace)) - SPACES.indexOf(workspace(b.workspace)) || byName(a, b)).map(project => `<option data-i18n-template="${esc(workspace(project.workspace))} · {project}" data-i18n-vars="${esc(JSON.stringify({project:project.name || '未命名项目'}))}" value="${esc(project.id)}"${project.id === selected ? ' selected' : ''}>${esc(workspace(project.workspace))} · ${esc(project.name || '未命名项目')}</option>`).join('');
  }
  const spaceOptions = value => SPACES.map(space => `<option${space === value ? ' selected' : ''}>${space}</option>`).join('');
  function bindDestination(space, project) {
    project.onchange = () => { const selected = list(stateNow().projects).find(item => item.id === project.value && active(item)); if (selected) space.value = workspace(selected.workspace); };
    space.onchange = () => { const selected = list(stateNow().projects).find(item => item.id === project.value && active(item)); if (selected && workspace(selected.workspace) !== space.value) project.value = ''; };
  }
  function ensureDialog(kind) {
    if (kind === 'create' && createDialog) return createDialog;
    if (kind === 'move' && moveDialog) return moveDialog;
    const dialog = doc().createElement('dialog'); dialog.id = kind === 'create' ? 'planningCreateDialog' : 'planningMoveDialog'; dialog.className = 'planning-dialog';
    dialog.setAttribute('aria-labelledby', `${dialog.id}Title`); doc().body.append(dialog);
    if (kind === 'create') createDialog = dialog; else moveDialog = dialog;
    return dialog;
  }
  function showDialog(dialog) { if (!dialog.open) dialog.showModal(); }
  function defaultDestination(scope) {
    if (scope?.projectId) return destination(stateNow(), scope);
    return destination(stateNow(), { workspace: scope?.workspace || '日常' });
  }
  async function persist() { if (await hooks.save?.() === false) throw new Error('任务尚未保存，请检查工作区状态后重试。'); }
  function createTask(scope = {}) {
    if (creating) { hooks.toast?.('任务正在保存，请稍候。'); return false; }
    let target; try { target = defaultDestination(scope); } catch (error) { hooks.toast?.(error.message); return false; }
    const dialog = ensureDialog('create'); if (dialog.open) { $('#planningTaskTitle')?.focus(); return true; }
    dialog.innerHTML = `<form id="planningCreateForm"><div class="dialog-header"><div><p class="eyebrow">手动安排</p><h2 id="${dialog.id}Title">添加任务</h2></div><button type="button" class="icon" data-planning-cancel aria-label="关闭">×</button></div>
      <label for="planningTaskTitle">任务名称</label><input id="planningTaskTitle" autocomplete="off" maxlength="500" required placeholder="下一步要完成什么？" />
      <label for="planningTaskDescription">详情</label><textarea id="planningTaskDescription" maxlength="20000" placeholder="目标、背景或验收标准（可选）"></textarea>
      <div class="planning-form-grid"><div><label for="planningTaskWorkspace">所属空间</label><select id="planningTaskWorkspace">${spaceOptions(target.workspace)}</select></div><div><label for="planningTaskProject">归属项目 · 所有空间</label><select id="planningTaskProject">${projectOptions(stateNow(), target.projectId)}</select></div>
      <div><label for="planningTaskStatus">状态</label><select id="planningTaskStatus">${Object.entries(STATUSES).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}</select></div><div><label for="planningTaskPriority">优先级</label><select id="planningTaskPriority">${Object.entries(PRIORITIES).map(([key, value]) => `<option value="${key}"${key === 'medium' ? ' selected' : ''}>${value}</option>`).join('')}</select></div>
      <div><label for="planningTaskStart">开始日期</label><input id="planningTaskStart" type="date" /></div><div><label for="planningTaskDue">截止日期</label><input id="planningTaskDue" type="date" /></div></div>
      <p class="muted">日期可留空；只填截止日期时，时间线会显示一个截止点。</p><p class="planning-error" role="alert" id="planningCreateError"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-planning-cancel>取消</button><button type="submit" class="primary" id="planningCreateSubmit">添加任务</button></div></form>`;
    dialog.querySelectorAll('[data-planning-cancel]').forEach(button => { button.onclick = () => dialog.close(); });
    bindDestination($('#planningTaskWorkspace'), $('#planningTaskProject'));
    $('#planningCreateForm').onsubmit = async event => {
      event.preventDefault(); const submit = $('#planningCreateSubmit'); if (submit.disabled) return;
      let task, initialTask, committed = false;
      try {
        task = planCreate(stateNow(), { title: $('#planningTaskTitle').value, description: $('#planningTaskDescription').value, workspace: $('#planningTaskWorkspace').value, projectId: $('#planningTaskProject').value, status: $('#planningTaskStatus').value, priority: $('#planningTaskPriority').value, startAt: inputDate($('#planningTaskStart').value, '开始日期'), dueAt: inputDate($('#planningTaskDue').value, '截止日期') }, { now: clock(), uid: hooks.uid });
        creating = true; submit.disabled = true; $('#planningCreateError').textContent = ''; initialTask = JSON.stringify(task); stateNow().tasks ||= []; stateNow().tasks.push(task);
        await persist(); committed = true; if (dialog.open) dialog.close(); hooks.renderAll?.(); hooks.toast?.('任务已添加，进度与时间线已更新。');
      } catch (error) {
        if (!committed && task && JSON.stringify(task) === initialTask) { const current = stateNow(); current.tasks = list(current.tasks).filter(item => item !== task); }
        if (committed || !dialog.open) hooks.toast?.(committed ? '任务已保存，界面刷新失败，请重新打开总览。' : error.message || '添加任务失败，请重试。');
        else $('#planningCreateError').textContent = error.message || '添加任务失败，请重试。';
      } finally { creating = false; submit.disabled = false; }
    };
    showDialog(dialog); $('#planningTaskTitle').focus(); return true;
  }
  function moveTasks(ids, scope = {}) {
    if (moving) { hooks.toast?.('移动正在保存，请稍候。'); return false; }
    const current = stateNow(); let check;
    try { const candidate = list(current.tasks).find(task => task.id === ids?.[0]); check = planMove(current, ids, { workspace: workspace(candidate?.workspace), projectId: candidate?.projectId || null }, { scope }); }
    catch (error) { hooks.toast?.(error.message); return false; }
    const dialog = ensureDialog('move'); if (dialog.open) return false;
    dialog.innerHTML = `<form id="planningMoveForm"><div class="dialog-header"><div><p class="eyebrow">调整归属</p><h2 id="${dialog.id}Title">移动 ${check.selectedCount} 个任务</h2></div><button class="icon" type="button" data-planning-cancel aria-label="关闭">×</button></div>
      <label for="planningMoveWorkspace">所属空间</label><select id="planningMoveWorkspace">${spaceOptions(check.destination.workspace)}</select><label for="planningMoveProject">目标项目 · 所有空间</label><select id="planningMoveProject">${projectOptions(current, check.destination.projectId)}</select>
      <p class="muted">任务的状态、日期、检查清单和来源关联都会保留；选择“未归属项目”可直接移入所选空间。</p><p class="planning-error" id="planningMoveError" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-planning-cancel>取消</button><button type="submit" class="primary" id="planningMoveSubmit">移动任务</button></div></form>`;
    dialog.querySelectorAll('[data-planning-cancel]').forEach(button => { button.onclick = () => dialog.close(); }); bindDestination($('#planningMoveWorkspace'), $('#planningMoveProject'));
    $('#planningMoveForm').onsubmit = async event => {
      event.preventDefault(); const submit = $('#planningMoveSubmit'); if (submit.disabled) return;
      const undo = []; let committed = false;
      try {
        const plan = planMove(stateNow(), ids, { workspace: $('#planningMoveWorkspace').value, projectId: $('#planningMoveProject').value }, { now: clock(), scope });
        moving = true; submit.disabled = true; $('#planningMoveError').textContent = '';
        for (const update of plan.updates) { const task = stateNow().tasks.find(item => item.id === update.id); undo.push({ task, before: Object.fromEntries(Object.keys(update.patch).map(key => [key, task[key]])), patch: update.patch }); Object.assign(task, update.patch); }
        if (plan.count) await persist(); committed = true; if (dialog.open) dialog.close(); hooks.renderAll?.(); hooks.toast?.(plan.count ? `已移动 ${plan.count} 个任务，来源关联已保留。` : '任务已经在所选位置。');
      } catch (error) {
        if (!committed) for (const { task, before, patch } of undo) if (stateNow().tasks?.includes(task) && Object.keys(patch).every(key => task[key] === patch[key])) Object.assign(task, before);
        if (committed || !dialog.open) hooks.toast?.(committed ? '任务已移动，界面刷新失败，请重新打开总览。' : error.message || '移动失败，请重试。');
        else $('#planningMoveError').textContent = error.message || '移动失败，请重试。';
      } finally { moving = false; submit.disabled = false; }
    };
    showDialog(dialog); return true;
  }
  function enhanceTaskEditor(task) {
    const project = $('#taskProjectInput'); if (!project) return;
    let extra = $('#planningTaskEditorFields');
    if (!extra) { extra = doc().createElement('div'); extra.id = 'planningTaskEditorFields'; extra.className = 'task-field task-inline planning-editor-fields'; project.closest('.task-field').before(extra); }
    extra.innerHTML = '<div><label for="taskWorkspaceInput">所属空间</label><select id="taskWorkspaceInput"></select></div><div><label for="taskStartInput">开始日期（可选）</label><input id="taskStartInput" type="date" /></div>';
    const current = list(stateNow().projects).find(item => item.id === task.projectId && active(item));
    $('#taskWorkspaceInput').innerHTML = spaceOptions(workspace(current?.workspace || task.workspace)); $('#taskStartInput').value = dateField(task.startAt);
    project.innerHTML = projectOptions(stateNow(), task.projectId); project.value = current?.id || '';
    const label = doc().querySelector('label[for="taskProjectInput"]'); if (label) label.textContent = '归属项目 · 所有空间';
    bindDestination($('#taskWorkspaceInput'), project);
  }
  function readTaskEditor(task) {
    if (!list(stateNow().tasks).some(item => item.id === task?.id && scopeInfo(stateNow()).matches(item))) throw new Error('任务已归档、删除或不可用，请关闭后重试。');
    const patch = destination(stateNow(), { workspace: $('#taskWorkspaceInput')?.value || workspace(task.workspace), projectId: $('#taskProjectInput')?.value || null });
    patch.startAt = inputDate($('#taskStartInput')?.value ?? dateField(task.startAt), '开始日期', task.startAt);
    const dueDate = inputDate($('#taskDueInput')?.value || '', '截止日期'), time = $('#taskTimeInput')?.value || '';
    if (time && !dueDate) throw new Error('设置截止时间前，请先选择截止日期。');
    const dueAt = dueDate && time ? `${dueDate}T${time}` : dueDate; validateDates(patch.startAt, dueAt);
    return patch;
  }

  function openEntity(type, id) {
    const state = stateNow(), available = type === 'project' ? list(state.projects).some(item => item.id === id && active(item)) : list(state[`${type === 'import' ? 'import' : type}s`]).some(item => item.id === id && scopeInfo(state).matches(item));
    if (!available) { hooks.toast?.('内容已归档、删除或不可用。'); hooks.renderAll?.(); return; }
    hooks.openEntity?.(type, id);
  }
  const entityButton = (node, className = 'planning-entity') => `<button type="button" class="${className}" data-planning-open="${esc(node.type)}" data-planning-id="${esc(node.id)}" title="${esc(node.title || node.name)}"><small>${TYPES[node.type]}</small><span>${esc(node.title || node.name)}</span></button>`;
  function render(container, scope = {}) {
    if (typeof container === 'string') container = $(container); if (!container) return null;
    const now = clock(), model = derive(stateNow(), scope, { now }), { counts } = model;
    const title = scope.projectId ? '项目安排' : scope.workspace ? `${scope.workspace}安排` : '任务与知识总览';
    const legend = ['done', 'in_progress', 'todo', 'blocked'].map(status => `<span class="planning-legend-item"><i class="planning-status-${status}"></i>${STATUSES[status]}<b>${counts[status]}</b></span>`).join('');
    const circumference = 2 * Math.PI * 42; let offset = 0;
    const arcs = ['done', 'in_progress', 'todo', 'blocked'].map(status => { const length = counts.total ? counts[status] / counts.total * circumference : 0; const markup = length ? `<circle class="planning-status-${status}" cx="54" cy="54" r="42" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" />` : ''; offset += length; return markup; }).join('');
    const progress = model.projects.slice(0, 8).map(project => `<button type="button" class="planning-project-progress" data-planning-open="project" data-planning-id="${esc(project.id)}"><span><b>${esc(project.name)}</b><small><span data-i18n>${esc(project.workspace)}</span> · <span data-i18n>${project.total ? `${project.done}/${project.total} 个任务完成` : '暂无任务'}</span></small></span><strong>${project.percent === null ? '—' : `${project.percent}%`}</strong><span class="planning-progress-track"><i style="width:${project.percent || 0}%"></i></span></button>`).join('');
    const visibleTimeline = model.timeline.slice(0, 24), extent = model.extent;
    const scale = timelineScale(extent, { width: Math.max(160, (container.clientWidth || 900) * .42) });
    const min = scale?.min || 0, span = scale?.span || 1;
    const dateLabel = value => value ? dateField(value) : '';
    const todayPosition = extent && now >= min && now <= min + span ? (now - min) / span * 100 : null;
    const todayMarker = todayPosition === null ? '' : `<span class="planning-today-marker" style="left:${todayPosition}%" aria-hidden="true"></span>`;
    const tickLines = scale ? scale.ticks.map(tick => `<i class="planning-calendar-gridline" style="left:${tick.position}%" aria-hidden="true"></i>`).join('') : '';
    const axis = scale ? `<div class="planning-axis-period"><span>${esc(scale.caption)}</span><span data-i18n>${scale.hourly ? '当地时间' : '按日期排列'}</span></div><div class="planning-timeline-axis"><span data-i18n>任务</span><div class="planning-axis-scale">${scale.ticks.map((tick, index) => `<span class="planning-axis-tick tick-${index}${index === scale.ticks.length-1 ? ' tick-last' : ''}" style="left:${tick.position}%" title="${esc(tick.full)}">${esc(tick.label)}</span>`).join('')}</div><span class="planning-axis-detail" data-i18n>${todayPosition === null ? '起止日期' : '竖线为当前时间'}</span></div>` : '';
    const timeline = visibleTimeline.map(item => {
      const left = Math.max(0, Math.min(100, ((item.start ?? item.end) - min) / span * 100));
      const width = item.kind === 'range' ? Math.max(0, Math.min(100 - left, (item.end - item.start) / span * 100)) : 0;
      const duration = item.kind === 'range' ? item.datePrecision ? item.durationDays ? `跨度 ${item.durationDays} 天` : '同日' : `持续 ${Number((item.durationMs / 3600000).toFixed(1))} 小时` : '';
      const label = item.kind === 'range' ? `${dateLabel(item.startAt)} → ${dateLabel(item.dueAt)} · ${duration}` : `${item.kind === 'deadline' ? '截止' : '开始'} ${dateLabel(item.dueAt || item.startAt)}`;
      return `<div class="planning-timeline-row">${entityButton(item, 'planning-timeline-title')}<div class="planning-timeline-plot" aria-label="${esc(label)}">${tickLines}${todayMarker}<span class="planning-timeline-mark ${item.kind} planning-status-${esc(item.status)}" style="left:${left}%;width:${width}%"></span></div><span class="planning-timeline-date" data-i18n>${esc(label)}</span><button type="button" class="planning-move link" data-planning-move="${esc(item.id)}" aria-label="移动任务：${esc(item.title)}">移动</button></div>`;
    }).join('');
    const nodeByKey = new Map(model.graph.nodes.map(node => [node.key, node]));
    const groups = model.graph.nodes.filter(node => node.type === 'project').slice(0, 6).map(project => { const children = model.graph.edges.filter(edge => edge.from === project.key).map(edge => nodeByKey.get(edge.to)); return `<div class="planning-relation-group">${entityButton(project, 'planning-relation-project')}<div class="planning-relation-children">${children.slice(0, 8).map(node => entityButton(node)).join('') || '<span class="planning-empty">暂无已归属内容</span>'}${children.length > 8 ? `<span class="muted">另有 ${children.length - 8} 项，打开项目查看</span>` : ''}</div></div>`; }).join('');
    container.classList.add('planning-workbench');
    container.innerHTML = `<div class="planning-heading"><div><h2>${esc(title)}</h2><p class="muted">${counts.projects} 个项目 · ${counts.total} 个任务 · ${counts.notes} 条知识 · ${counts.imports} 份资料</p></div><button type="button" class="secondary" data-planning-create ${model.validScope ? '' : 'disabled'}>＋ 添加任务</button></div>
      ${model.validScope ? '' : '<p class="planning-empty">当前范围已归档、删除或不可用。</p>'}
      <div class="planning-summary-grid"><article class="planning-card"><h3>任务完成度</h3><div class="planning-completion"><div class="planning-donut" role="img" aria-label="${counts.done}/${counts.total} 个任务已完成"><svg viewBox="0 0 108 108" aria-hidden="true"><circle class="planning-ring-base" cx="54" cy="54" r="42" />${arcs}</svg><div><b>${model.percent === null ? '—' : `${model.percent}%`}</b><small>${counts.total ? `${counts.done}/${counts.total} 已完成` : '暂无任务'}</small></div></div><div class="planning-legend">${legend}</div></div><p class="planning-caption">${counts.overdue ? `${counts.overdue} 个未完成任务已逾期` : counts.total ? '暂无逾期任务' : '手动添加第一项任务，或让 Agent 从资料中整理。'}</p></article>
      <article class="planning-card"><h3>项目进度</h3><div class="planning-projects">${progress || '<p class="planning-empty">暂无项目，任务也可以直接保存在空间中。</p>'}</div>${model.projects.length > 8 ? `<p class="planning-caption">显示 ${8}/${model.projects.length} 个项目</p>` : ''}</article></div>
      <article class="planning-card planning-timeline"><div class="planning-card-heading"><h3>任务时间线</h3><span class="muted">横条表示已设起止日期；圆点表示仅设开始或截止</span></div>${axis}${timeline || '<p class="planning-empty">还没有已设置日期的任务。日期可在任务详情中补充。</p>'}<p class="planning-caption">${model.unscheduled} 个任务未排期${model.invalidDates ? ` · ${model.invalidDates} 个任务日期需修正` : ''}${model.timeline.length > 24 ? ` · 显示前 24/${model.timeline.length} 个已排期任务` : ''}${extent ? ' · 所有任务共用同一日期刻度' : ''}</p></article>
      <article class="planning-card planning-relation-map"><div class="planning-card-heading"><h3>项目与内容</h3><span class="muted">连线表示明确的项目归属；点击即可打开</span></div>${groups || '<p class="planning-empty">建立项目并归入任务、知识或资料后，会显示这里的结构。</p>'}${model.projects.length > 6 ? `<p class="planning-caption">显示 ${6}/${model.projects.length} 个项目</p>` : ''}${model.graph.unassigned.length ? `<details class="planning-unassigned"><summary>未归属项目 · ${model.graph.unassigned.length} 项</summary><div>${model.graph.unassigned.slice(0, 12).map(node => entityButton(node)).join('')}${model.graph.unassigned.length > 12 ? `<span class="muted">另有 ${model.graph.unassigned.length - 12} 项，可在全部内容中查看</span>` : ''}</div></details>` : ''}</article>`;
    container.onclick = event => {
      const button = event.target.closest('button'); if (!button || !container.contains(button)) return;
      if (button.hasAttribute('data-planning-create')) createTask(scope);
      else if (button.dataset.planningMove) moveTasks([button.dataset.planningMove], scope);
      else if (button.dataset.planningOpen) openEntity(button.dataset.planningOpen, button.dataset.planningId);
    };
    return model;
  }
  return { init(options = {}) { hooks = options; createDialog = null; moveDialog = null; return this; },
    derive, planCreate, planMove, parseDate, dateField, validateDates, timelineScale, active, createTask, moveTasks, render, enhanceTaskEditor, readTaskEditor };
});
