(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationActivityCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WORKSPACES = Object.freeze(['日常', '课程', '科研']);
  const cleanWorkspace = value => WORKSPACES.includes(value) ? value : '日常';
  function localDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'number' || /^\d+$/.test(String(value || ''))) return new Date(Number(value));
    const source = String(value || '');
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
    if (!dateOnly) return new Date(source);
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
  }
  function dateKey(value) {
    const date = localDate(value);
    if (!Number.isFinite(date.getTime())) return null;
    const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, '0'); const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  function dateLabel(key) {
    const date = localDate(key); return Number.isFinite(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日` : key;
  }
  function projectIndex(state) {
    const map = new Map();
    (Array.isArray(state?.projects) ? state.projects : []).forEach(project => { if (project?.id) map.set(project.id, project); });
    return map;
  }
  function activeEntity(item, projects) {
    if (!item || item.archived || item.deletedAt) return false;
    if (!item.projectId) return true;
    // A referenced project that no longer exists is not an unassigned item.
    // Keep orphaned records out of current totals without deleting history or
    // hiding durable project knowledge when its source conversation is archived.
    const project = projects.get(item.projectId);
    return !!project && !project.archived && !project.deletedAt;
  }
  function aggregate(state = {}, options = {}) {
    const days = Number(options.days) === 30 ? 30 : 7;
    const today = localDate(options.now ?? Date.now());
    if (!Number.isFinite(today.getTime())) throw new Error('分析日期无效');
    today.setHours(0, 0, 0, 0);
    const keys = Array.from({ length: days }, (_, index) => { const date = new Date(today); date.setDate(today.getDate() - days + index + 1); return dateKey(date); });
    const projects = projectIndex(state);
    const selectedProject = options.projectId || null;
    const selectedWorkspace = options.workspace && WORKSPACES.includes(options.workspace) ? options.workspace : null;
    const series = keys.map(key => ({ key, label: dateLabel(key), tasks: 0, materials: 0, entries: [] }));
    const byDay = new Map(series.map(item => [item.key, item]));
    const workspaces = Object.fromEntries(WORKSPACES.map(workspace => [workspace, { workspace, tasks: 0, materials: 0, total: 0, daysActive: 0 }]));
    const activeDays = new Map(WORKSPACES.map(workspace => [workspace, new Set()]));
    const add = (collection, metric, dateField) => {
      (Array.isArray(state?.[collection]) ? state[collection] : []).forEach(item => {
        if (!activeEntity(item, projects) || (selectedProject && item.projectId !== selectedProject)) return;
        // A reopened task may still have a legacy completion timestamp. It
        // must no longer be counted as completed; records without a status
        // are accepted for older exported workspaces.
        if (collection === 'tasks' && item.status && item.status !== 'done') return;
        const key = dateKey(item[dateField]); const day = byDay.get(key); if (!day) return;
        const project = item.projectId ? projects.get(item.projectId) : null;
        const workspace = cleanWorkspace(project?.workspace || item.workspace);
        if (selectedWorkspace && workspace !== selectedWorkspace) return;
        day[metric] += 1; workspaces[workspace][metric] += 1; workspaces[workspace].total += 1;
        if (item.id) day.entries.push({ id: item.id, type: collection === 'tasks' ? 'task' : collection === 'notes' ? 'note' : 'import', metric, title: item.title || item.name || item.originalName || '', workspace, projectId: item.projectId || null, projectName: project?.name || '', timestamp: item[dateField] });
        activeDays.get(workspace).add(key);
      });
    };
    add('tasks', 'tasks', 'completedAt'); add('notes', 'materials', 'createdAt'); add('imports', 'materials', 'createdAt');
    WORKSPACES.forEach(workspace => { workspaces[workspace].daysActive = activeDays.get(workspace).size; });
    return { days, workspace: selectedWorkspace, projectId: selectedProject, keys, series, workspaces, totals: { tasks: series.reduce((sum, item) => sum + item.tasks, 0), materials: series.reduce((sum, item) => sum + item.materials, 0) } };
  }
  return { WORKSPACES, dateKey, aggregate };
});
