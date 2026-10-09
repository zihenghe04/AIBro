/* Read-only process history received from another device. No execution hooks. */
(function (root) {
  'use strict';
  const STYLE_ID = 'mobile-conversation-handoff-style';
  const OWNED = 'data-mobile-conversation-handoff';
  const BATCH = 100;
  const CSS = `
.mobile-conversation-handoff{min-width:0;max-width:100%;margin-top:10px;color:var(--muted);font-size:11px;line-height:1.65}
.mobile-conversation-handoff p{margin:6px 0;overflow-wrap:anywhere}
.mobile-conversation-handoff .message-steps,.mobile-conversation-handoff .message-reasoning{max-width:100%;min-width:0}
.mobile-conversation-handoff summary{overflow-wrap:anywhere;cursor:pointer}
.mobile-conversation-handoff summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mobile-conversation-handoff .mobile-handoff-events{max-height:440px;overflow:auto;padding:0 12px;white-space:normal}
.mobile-conversation-handoff .mobile-handoff-event{border-top:1px solid var(--line);min-width:0}
.mobile-conversation-handoff .mobile-handoff-event>summary{padding:8px 0}
.mobile-conversation-handoff pre{box-sizing:border-box;max-width:100%;max-height:240px;overflow:auto;margin:6px 0 12px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);font:inherit;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.mobile-conversation-handoff .mobile-handoff-error{color:var(--danger,var(--text))}
`;
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function printable(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2) ?? String(value); }
    catch { return '[记录无法序列化]'; }
  }
  function element(doc, tag, text, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function details(doc, title, className) {
    const node = element(doc, 'details', undefined, className);
    node.append(element(doc, 'summary', title));
    return node;
  }
  function pre(doc, value, label) {
    const node = element(doc, 'pre', printable(value));
    node.tabIndex = 0;
    node.setAttribute('aria-label', label);
    return node;
  }
  function addEvent(doc, parent, event) {
    const kind = event.error ? '错误记录' : event.type === 'tool-start' ? '请求记录' : event.type === 'tool-result' ? '结果记录' : '事件记录';
    const row = details(doc, `${typeof event.title === 'string' ? event.title : '未命名工具'} · ${kind}`, 'mobile-handoff-event');
    for (const [key, label] of [['input', '输入'], ['output', '输出'], ['error', '错误']]) {
      if (!has(event, key)) continue;
      row.append(element(doc, 'p', label), pre(doc, event[key], `工具${label}记录`));
    }
    parent.append(row);
  }
  function addEventBatch(doc, parent, events, start = 0) {
    const end = Math.min(events.length, start + BATCH);
    for (let index = start; index < end; index++) addEvent(doc, parent, events[index]);
    if (end === events.length) return;
    const more = details(doc, `更多记录（${events.length - end} 条）`, 'mobile-handoff-more');
    let loaded = false;
    more.addEventListener('toggle', () => {
      if (!more.open || loaded) return;
      loaded = true;
      addEventBatch(doc, more, events, end);
    });
    parent.append(more);
  }
  function mount(message, wrapper) {
    if (!wrapper?.ownerDocument) return null;
    // Only replace our subtree; leave the renderer's body, selection and
    // markdown lifecycle untouched. No callbacks accept/execute any plan.
    for (const child of [...wrapper.children]) if (child.hasAttribute(OWNED)) child.remove();
    if (!message || message.deletedAt || message.role === 'user') return null;
    const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
    const events = Array.isArray(message.toolEvents) ? message.toolEvents.filter(event => event && typeof event === 'object' && !Array.isArray(event)) : [];
    const plan = message.pendingPlan && typeof message.pendingPlan === 'object' && !Array.isArray(message.pendingPlan) ? message.pendingPlan : null;
    const status = typeof message.status === 'string' ? message.status : '';
    const error = typeof message.error === 'string' ? message.error : '';
    if (!reasoning && !events.length && !plan && !status && !error) return null;
    const doc = wrapper.ownerDocument;
    if (!doc.getElementById(STYLE_ID)) {
      const style = element(doc, 'style', CSS); style.id = STYLE_ID;
      (doc.head || doc.documentElement).append(style);
    }
    const section = element(doc, 'section', undefined, 'mobile-conversation-handoff');
    section.setAttribute(OWNED, '');
    section.setAttribute('aria-label', '同步过程记录');
    const labels = { completed: '答复已完成', cancelled: '输出已取消', stopped: '输出已停止', failed: '答复失败', error: '答复失败' };
    section.append(element(doc, 'p', status === 'running'
      ? '其他设备记录：生成中。本机未在运行此任务。'
      : `其他设备的过程记录${status ? ` · ${labels[status] || status}` : ''}`));
    if (plan?.status === 'pending') section.append(element(doc, 'p', '待在手机确认。此处仅展示同步记录。'));
    else if (plan?.status === 'invalidated') section.append(element(doc, 'p', plan.invalidatedReason === 'metadata-redacted'
      ? '方案记录不完整，方案已失效。请回手机重新提出修改。'
      : '对话内容已变化，方案已失效。请回手机重新提出修改。'));
    else if (plan?.status === 'applied') section.append(element(doc, 'p', '手机方案记录：已应用。'));
    else if (plan?.status === 'rejected') section.append(element(doc, 'p', '手机方案记录：已拒绝。'));
    if (reasoning) {
      const reasoningNode = details(doc, '思考记录', 'message-reasoning');
      reasoningNode.append(pre(doc, reasoning, '思考记录正文'));
      section.append(reasoningNode);
    }
    if (events.length) {
      const toolNode = details(doc, `工具记录（${events.length} 条）`, 'message-steps');
      const list = element(doc, 'div', undefined, 'mobile-handoff-events');
      addEventBatch(doc, list, events);
      toolNode.append(list); section.append(toolNode);
    }
    if (error) {
      const errorNode = details(doc, '错误记录', 'message-steps mobile-handoff-error');
      errorNode.append(pre(doc, error, '错误记录正文')); section.append(errorNode);
    }
    wrapper.append(section);
    return section;
  }
  root.MobileConversationHandoff = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
