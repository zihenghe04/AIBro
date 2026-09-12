(function (root) {
  'use strict';
  const statuses = new Set(['running', 'completed', 'done', 'failed', 'cancelled', 'pending']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Only public summaries and actual tool lifecycle events enter this feed.
  function update(message, event, now = Date.now()) {
    if (!event || !['summary', 'commentary', 'tool'].includes(event.kind) || typeof event.id !== 'string' || !event.id) return;
    message.activities ||= [];
    const id = event.id.slice(0,180);
    const previous = message.activities.find(item => item.id === id);
    const value = {id, kind:event.kind, name:String(event.name || '').slice(0,80),
      text:String(event.text || '').slice(-4000), status:statuses.has(event.status) ? event.status : 'running', at:previous?.at || now, updatedAt:now};
    if (previous) Object.assign(previous,value); else message.activities.push(value);
    if (message.activities.length > 100) message.activities.splice(0,message.activities.length-100);
  }
  function finish(message, status) {
    for (const item of message.activities || []) if (item.status === 'running') item.status = status;
  }
  function entries(message) {
    const steps = (message.steps || []).map((step,index) => ({...step,id:step.id || `step-${index}`,kind:'step',at:step.at || message.at || 0}));
    return [...steps,...(message.activities || [])].sort((a,b) => a.at-b.at);
  }
  function duration(start, end = Date.now()) {
    const seconds = Math.max(0, Math.floor((end-start)/1000));
    return seconds >= 3600 ? `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分` : seconds >= 60 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${seconds} 秒`;
  }
  function markup(message) {
    const items = entries(message); if (!items.length) return '';
    const active = [...items].reverse().find(item => item.status === 'running');
    const newest = items[items.length-1];
    const title = item => item.kind === 'step' ? item.text : item.kind === 'tool' ? (item.name || '工具操作') : item.kind === 'summary' ? '思考摘要' : '模型进展';
    const activeText = active && (active.kind === 'summary' || active.kind === 'commentary') ? active.text.split('\n').filter(Boolean).pop() : active ? title(active) : '';
    const status = message.live ? 'running' : message.runStatus || (message.retryRunId ? 'failed' : 'unknown');
    const labels = {completed:'已完成',done:'已完成','completed-local':'已完成',failed:'执行失败',cancelled:'已停止','awaiting-approval':'等待审批',rejected:'已拒绝'};
    const heading = message.live ? activeText || title(newest) : labels[status] || '执行记录';
    const mark = state => state === 'running' ? '<span class="progress-spinner" aria-hidden="true"></span>' : state === 'failed' ? '!' : state === 'cancelled' ? '−' : ['pending','unknown','awaiting-approval','rejected'].includes(state) ? '○' : '✓';
    const rows = items.map(item => {
      const body = item.kind !== 'step' && item.text ? `<div class="progress-item-body">${esc(item.text)}</div>` : '';
      const state = item.status || 'done';
      const label = state === 'pending' ? '待执行' : state === 'running' ? '进行中' : state === 'failed' ? '失败' : state === 'cancelled' ? '已停止' : '完成';
      return `<li class="progress-item is-${esc(state)}" data-activity-id="${esc(item.id)}"><span class="progress-mark" aria-label="${label}">${mark(state)}</span><div class="progress-item-content">${body ? `<details data-progress-key="${esc(item.id)}" ${message.live && state === 'running' ? 'open' : ''}><summary>${esc(title(item))}</summary>${body}</details>` : `<span>${esc(title(item))}</span>`}</div></li>`;
    }).join('');
    const start = Number(message.startedAt || message.at), end = Number(message.finishedAt);
    const elapsed = start > 0 && (message.live || end >= start) ? `<span class="progress-elapsed" ${message.live ? `data-progress-start="${start}"` : ''}>${duration(start,message.live ? Date.now() : end)}</span>` : '';
    return `<details class="agent-progress" data-progress-key="feed" ${message.live ? 'open' : ''}><summary><span class="progress-heading-mark">${mark(status)}</span><span class="progress-heading-text">${esc(heading)}</span><span class="progress-count">${items.length} 项活动</span>${elapsed}<span class="progress-chevron" aria-hidden="true">›</span></summary><ol class="progress-timeline">${rows}</ol></details>`;
  }
  root.AgentProgress = {update,finish,entries,markup,duration};
  if (root.document) root.setInterval(() => {
    root.document.querySelectorAll('[data-progress-start]').forEach(node => { node.textContent = duration(Number(node.dataset.progressStart)); });
  },1000);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AgentProgress;
})(typeof globalThis !== 'undefined' ? globalThis : this);
