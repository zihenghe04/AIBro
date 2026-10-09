import { loadMobileHalaska } from './halaska-loader.js';
import './conversation-activity.css';

const labels = { knowledge_search: '检索资料', knowledge_read: '读取资料', workspace_list: '浏览工作区', request_clarification: '补充信息', propose_changes: '准备修改' };
const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const registered = new WeakSet();
const layoutScrolls = new WeakSet();
export const isActivityLayoutScroll = element => layoutScrolls.has(element);
function register(kit) {
  if (registered.has(kit)) return;
  const h = kit.React.createElement;
  kit.register('MobileConversationActivity', ({ text, status }) => h('div', { className: 'activity-status', 'data-activity-status': status, role: 'status' },
    status === 'running' ? h('span', { className: 'activity-spinner', 'aria-hidden': true }, kit.node({ component: 'Spinner', props: { size: 13, color: 'var(--muted)' } })) : null,
    kit.node({ component: 'Text', props: { as: 'span', children: text, size: 'sm', style: { fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', fontFamily: 'inherit' } } })));
  registered.add(kit);
}

function selected(element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    try { if (selection.getRangeAt(i).intersectsNode(element)) return true; } catch { /* detached range */ }
  }
  return false;
}

// A reader's selection owns the displayed subtree until it is released. The
// latest actual stream value is retained, never simulated one character at a time.
export function stableContent(element, write, onLayout = () => {}, canWrite = () => true) {
  let value, pending, disposed = false;
  function flush() {
    if (disposed || pending === undefined || !canWrite() || selected(element)) return false;
    const next = pending; pending = undefined;
    if (next === value) return false;
    const top = element.scrollTop, left = element.scrollLeft;
    layoutScrolls.add(element);
    write(element, next); value = next;
    element.scrollTop = top; element.scrollLeft = left;
    requestAnimationFrame(() => requestAnimationFrame(() => layoutScrolls.delete(element)));
    onLayout(); return true;
  }
  const release = () => { if (!element.isConnected) return; flush(); };
  element.ownerDocument.addEventListener('selectionchange', release);
  return { update(next) { pending = String(next ?? ''); return flush(); }, flush,
    dispose() { disposed = true; element.ownerDocument.removeEventListener('selectionchange', release); },
  };
}

export function activityCalls(events = []) {
  const calls = [];
  for (const event of events) {
    if (event.type === 'tool-start') calls.push({ ...event, key: 'call-' + calls.length, done: false });
    else if (event.type === 'tool-result') {
      const pending = [...calls].reverse().find(call => call.title === event.title && !call.done);
      if (pending) Object.assign(pending, event, { done: true });
      else calls.push({ ...event, key: 'call-' + calls.length, done: true });
    }
  }
  return calls;
}

export function mountConversationActivity(element, { markdown, onRead = () => {}, onLayout = () => {} }) {
  const doc = element.ownerDocument, summary = doc.createElement('div'), trace = doc.createElement('div');
  summary.className = 'activity-summary'; trace.className = 'activity-traces';
  element.append(summary, trace);
  const rows = new Map(); let disposed = false, island, latest, signature, reasoning;
  const plain = (node, value) => { node.textContent = value; };
  const create = (key, title, className) => {
    const details = doc.createElement('details'), heading = doc.createElement('summary'), name = doc.createElement('span'), state = doc.createElement('small');
    details.className = className; details.dataset.trace = key;
    name.textContent = title; heading.append(name, state); details.append(heading); trace.append(details);
    const row = { details, name, state, values: [], fields: new Map() };
    details.addEventListener('toggle', () => {
      if (details.open) { onRead(); for (const value of row.values) value.flush(); }
      onLayout();
    });
    return row;
  };
  const field = (row, key, heading, value, className = '') => {
    let part = row.fields.get(key);
    if (value === undefined) {
      if (part) { part.dispose(); part.element.remove(); part.heading?.remove(); row.fields.delete(key); row.values = row.values.filter(item => item !== part); }
      return;
    }
    if (!part) {
      let label;
      if (heading) { label = doc.createElement('h4'); label.textContent = heading; row.details.append(label); }
      const node = doc.createElement(className === 'markdown' ? 'div' : 'pre'); node.className = className;
      row.details.append(node);
      part = stableContent(node, className === 'markdown' ? (node, text) => { node.innerHTML = markdown(text); } : plain, onLayout, () => row.details.open);
      part.element = node; part.heading = label;
      row.fields.set(key, part); row.values.push(part);
    }
    part.update(value);
  };
  function update(model) {
    if (disposed) return;
    latest = model;
    const calls = activityCalls(model.events), status = model.status || 'completed';
    element.hidden = !model.reasoning && !calls.length && status === 'completed';
    const text = status === 'running' ? (model.phase || '正在回复') : status === 'cancelled' ? '已停止 · 已生成内容保留'
      : status === 'failed' ? '回复未完成' : status === 'interrupted' ? '此前回复未完成' : `过程记录${calls.length ? ' · ' + calls.length + ' 项工具' : ''}`;
    const nextSignature = status + ':' + text;
    if (signature !== nextSignature) {
      signature = nextSignature;
      if (island) island.update({ text, status });
      else { summary.textContent = text; summary.dataset.activityStatus = status; }
    }
    if (model.reasoning) {
      if (!reasoning) { reasoning = create('reasoning', '模型思考', 'reasoning'); trace.prepend(reasoning.details); }
      field(reasoning, 'reasoning', '', model.reasoning, 'markdown');
    }
    const liveKeys = new Set(calls.map(call => call.key));
    for (const [key, row] of rows) if (!liveKeys.has(key)) {
      for (const value of row.values) value.dispose(); row.details.remove(); rows.delete(key);
    }
    if (!model.reasoning && reasoning) {
      for (const value of reasoning.values) value.dispose(); reasoning.details.remove(); reasoning = null;
    }
    for (const call of calls) {
      let row = rows.get(call.key);
      if (!row) { row = create(call.key, labels[call.title] || call.title, 'tool-trace'); rows.set(call.key, row); }
      const title = labels[call.title] || call.title;
      if (row.name.textContent !== title) row.name.textContent = title;
      const state = call.error ? 'failed' : call.done ? 'completed' : status === 'running' ? 'running' : 'incomplete';
      row.details.dataset.toolStatus = state;
      const label = { failed: '未完成', completed: '完成', running: '执行中', incomplete: '未完成' }[state];
      if (row.state.textContent !== label) row.state.textContent = label;
      if (row.input !== call.input) { row.input = call.input; field(row, 'input', '输入', call.input === undefined ? undefined : json(call.input)); }
      if (row.error !== call.error) { row.error = call.error; field(row, 'error', '错误', call.error === undefined ? undefined : String(call.error), 'operation-error'); }
      if (row.output !== call.output) { row.output = call.output; field(row, 'output', '结果', call.output === undefined ? undefined : json(call.output)); }
    }
  }
  loadMobileHalaska().then(kit => {
    if (disposed || !element.isConnected) return;
    register(kit); summary.replaceChildren(); delete summary.dataset.activityStatus;
    const previous = signature; signature = null;
    island = kit.mount(summary, 'MobileConversationActivity', { text: '', status: latest?.status || 'completed' });
    if (latest) update(latest); else signature = previous;
  }).catch(() => { /* The same real status remains readable if Kit fails to load. */ });
  return { update, dispose() {
    disposed = true; island?.unmount();
    for (const row of [reasoning, ...rows.values()]) for (const value of row?.values || []) value.dispose();
  } };
}
