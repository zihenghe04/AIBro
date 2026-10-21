/* 会话内任务清单（对齐 NewMax §1.4）：把"要做几件事"外化成可见状态。
   Agent 在 payload 里给出清单，后续轮次继续给出（同一条目按文本匹配推进 done），
   于是进度会随执行推进（0/3 → 1/3 → 2/3），而不是最后一次性勾完。

   四条边界：
   · 只接受「可核对的短句」——条目文本有长度上限、最多 12 条，超出的丢弃而不是截断成半句；
   · **不改写历史**：清单是会话级状态，条目文本换成新的就是新的清单，不猜"这条其实就是那条"；
   · **不为了补勾选再跑一轮**：系统不会因为清单没更新而自动追问或继续（对齐"自动收口"）；
   · 清除是用户的权利：面板上始终有「清除任务清单」。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionTasks = api;
})(globalThis, root => {
  'use strict';
  const MAX_ITEMS = 12;
  const TEXT_LIMIT = 200;

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  // 校验 Agent 给出的清单：非法条目丢弃（不截断、不编造）。
  function validate(raw) {
    const source = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
    if (!source) return null;
    const items = [];
    for (const entry of source) {
      if (items.length >= MAX_ITEMS) break;
      const text = clean(typeof entry === 'string' ? entry : entry?.text);
      if (!text || text.length > TEXT_LIMIT) continue;
      items.push({ text, done: !!(typeof entry === 'object' && entry?.done) });
    }
    return { items, updatedAt: null };
  }

  // 同一条目接受新的完成信号，同时保留已经完成的状态。
  // 后续只重述条目（字符串默认为 false）不能把已完成的工作退回待办。
  function merge(previous, next) {
    if (!next) return previous || null;
    const before = new Map((previous?.items || []).map(item => [item.text, item.done]));
    const items = next.items.map(item => ({ text: item.text, done: !!(before.get(item.text) || item.done) }));
    return { items, updatedAt: Date.now() };
  }

  function progress(list) {
    const items = list?.items || [];
    return { done: items.filter(item => item.done).length, total: items.length };
  }

  function describe(list) {
    const { done, total } = progress(list);
    if (!total) return '';
    return T(`任务清单 ${done}/${total} 完成`, `Task list ${done}/${total} done`);
  }

  // 全部完成的清单不再占据输入区上方——它已经完成使命，留在对话里即可。
  function shouldShow(list) {
    const { done, total } = progress(list);
    return total > 0 && done < total;
  }

  // ── 面板（输入区上方的清单条） ──────────────────────────────
  let hooks = {};

  function render() {
    const doc = root.document;
    const strip = doc?.querySelector('#sessionTaskStrip');
    if (!strip) return { ok: false, reason: 'missing-strip' };
    const list = hooks.getConversation?.()?.taskList;
    if (!list || !shouldShow(list)) {
      strip.hidden = true;
      strip.replaceChildren();
      return { ok: true, hidden: true };
    }
    strip.hidden = false;
    strip.replaceChildren();
    const head = doc.createElement('div');
    head.className = 'session-task-head';
    const title = doc.createElement('span');
    title.className = 'session-task-title';
    title.textContent = describe(list);
    const clear = doc.createElement('button');
    clear.type = 'button';
    clear.className = 'secondary session-task-clear';
    clear.dataset.sessionTaskAction = 'clear';
    clear.textContent = T('清除任务清单', 'Clear task list');
    clear.onclick = () => { hooks.clear?.(); render(); };
    // A thin progress meter mirrors the counted title; it is presentation only.
    const { done, total } = progress(list);
    const meter = doc.createElement('span');
    meter.className = 'session-task-meter';
    meter.setAttribute('aria-hidden', 'true');
    const fill = doc.createElement('span');
    fill.style.width = `${total ? Math.round(done / total * 100) : 0}%`;
    meter.append(fill);
    title.append(meter);
    head.append(title, clear);
    const items = doc.createElement('ul');
    items.className = 'session-task-items';
    for (const item of list.items) {
      const row = doc.createElement('li');
      row.className = item.done ? 'session-task-item done' : 'session-task-item';
      // The glyph stays in the text for copy and assistive tech; CSS draws the box.
      const mark = doc.createElement('span');
      mark.className = 'session-task-mark';
      mark.textContent = item.done ? '☑' : '☐';
      const text = doc.createElement('span');
      text.className = 'session-task-text';
      text.textContent = ` ${item.text}`;
      row.append(mark, text);
      items.append(row);
    }
    strip.append(head, items);
    return { ok: true, hidden: false, progress: progress(list) };
  }

  function init(options) {
    hooks = options || {};
    render();
    return { ok: true };
  }

  root.SessionTasks = { init, render, validate, merge, progress, describe, shouldShow, MAX_ITEMS, TEXT_LIMIT,
    _pure: { validate, merge, progress, describe, shouldShow } };
  return root.SessionTasks;
});
