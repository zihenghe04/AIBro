const active = project => project && !project.deleted && !project.deletedAt && !project.archived && !project.archivedAt && project.status !== 'archived';
const name = project => typeof project?.name === 'string' ? project.name : typeof project?.title === 'string' ? project.title : '';
const legacyName = record => typeof record?.project === 'string' ? record.project.trim() : '';
const noProject = value => value == null || value === '';

// Match the Mac's stable-ID-first rule. An unresolved stable ID must never be
// guessed from its old display name. Legacy name lookup is workspace-scoped.
export function recordProjectSelection(record, projects = []) {
  if (!noProject(record?.projectId)) return record.projectId;
  const alias = legacyName(record);
  if (!alias) return '';
  const matches = projects.filter(project => name(project).trim() === alias && project.workspace === record.workspace);
  return matches.length === 1 ? matches[0].id : 'legacy:' + encodeURIComponent(alias);
}

export function recordProjectOptions(record, projects = []) {
  const selected = recordProjectSelection(record, projects);
  const rows = [{ value: '', label: '不关联项目' }, ...projects.filter(active).map(project => ({ value: project.id, label: name(project) || project.id }))];
  if (selected && !rows.some(row => row.value === selected))
    rows.push({ value: selected, label: `保留原项目：${legacyName(record) || selected}`, retained: true });
  return rows;
}

// Return only the relationship fields to merge. Unchanged selection preserves
// absent fields, legacy names and unresolved IDs exactly, without migration.
export function editedProject(old, selectedProjectId, projects = []) {
  const selected = noProject(selectedProjectId) ? '' : selectedProjectId;
  if (typeof selected !== 'string') throw Error('项目选择无效，原归属未改变');
  if (old && selected === recordProjectSelection(old, projects)) return {};
  if (!selected) return { projectId: null, project: null,
    workspace: old && Object.hasOwn(old, 'workspace') ? old.workspace : '日常' };
  const matches = projects.filter(project => project.id === selected && active(project));
  if (matches.length !== 1) throw Error('所选项目已不存在或不可用，原归属未改变');
  const project = matches[0];
  return { projectId: project.id, project: name(project), workspace: project.workspace || old?.workspace || '日常' };
}
