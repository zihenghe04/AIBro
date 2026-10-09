// Mac writes in_progress. Older mobile records wrote doing. Read both without
// rewriting stored records; only an explicit state edit uses canonical values.
const statuses = Object.freeze({ todo: '待开始', in_progress: '进行中', done: '已完成', blocked: '受阻' });
const priorities = Object.freeze({ low: '低', medium: '普通', high: '高' });
export const taskStatuses = Object.freeze([...Object.keys(statuses), 'doing']);
export function canonicalTaskStatus(value) {
  return value === 'doing' ? 'in_progress' : typeof value === 'string' && Object.hasOwn(statuses, value) ? value : null;
}
function selection(value, dictionary, fallback, canonical = value => Object.hasOwn(dictionary, value) ? value : null) {
  if (value == null || value === '') return fallback;
  const known = canonical(value);
  if (known) return known;
  if (typeof value === 'string' && value.trim()) return value;
  throw Error('任务状态或优先级格式无法编辑，原内容未改变');
}
export const taskStatusSelection = value => selection(value, statuses, 'todo', canonicalTaskStatus);
export const taskPrioritySelection = value => selection(value, priorities, 'medium');
export function taskStatusLabel(value) {
  const selected = taskStatusSelection(value);
  return statuses[selected] || `其他状态：${selected}`;
}
export function taskPriorityLabel(value) {
  const selected = taskPrioritySelection(value);
  return priorities[selected] || `其他优先级：${selected}`;
}
function options(dictionary, value, select, label) {
  const selected = select(value), rows = Object.entries(dictionary).map(([value, label]) => ({ value, label }));
  if (!Object.hasOwn(dictionary, selected)) rows.push({ value: selected, label: label(value), retained: true });
  return rows;
}
export const taskStatusOptions = value => options(statuses, value, taskStatusSelection, taskStatusLabel);
export const taskPriorityOptions = value => options(priorities, value, taskPrioritySelection, taskPriorityLabel);
export const taskStatusMatches = (stored, filter) => canonicalTaskStatus(filter) !== null &&
  (canonicalTaskStatus(stored) || (stored == null || stored === '' ? 'todo' : null)) === canonicalTaskStatus(filter);

// `changes` contains only fields the user/model explicitly changed. For a form,
// compare its values with *Selection(before.field) before constructing changes.
// Description-only edits must not synthesize completion history or defaults.
export function taskStatePatch(before, changes, { now = Date.now() } = {}) {
  const patch = {};
  if (!before || Object.hasOwn(changes, 'status')) {
    const input = Object.hasOwn(changes, 'status') ? changes.status : 'todo';
    const status = canonicalTaskStatus(input);
    if (!status) {
      if (!before || typeof input !== 'string' || !input.trim() || input !== before.status)
        throw Error('任务状态无效；请选择待开始、进行中、已完成或受阻');
    } else {
      patch.status = status;
      const previous = canonicalTaskStatus(before?.status);
      if (!before || status !== previous) patch.completedAt = status === 'done' ? now : null;
    }
  }
  if (!before || Object.hasOwn(changes, 'priority')) {
    const value = Object.hasOwn(changes, 'priority') ? changes.priority : 'medium';
    if (typeof value === 'string' && Object.hasOwn(priorities, value)) patch.priority = value;
    else if (!before || typeof value !== 'string' || !value.trim() || value !== before.priority)
      throw Error('任务优先级无效；请选择低、普通或高');
  }
  return patch;
}
