(function (root) {
  'use strict';
  // 对话级排队提交：当前轮执行期间用户仍可继续输入，消息按序排队，当前轮完成后再发送。
  // 只保存排队意图（文本 + 附件引用）；真正的发送仍走既有 sendMessage 路径，不新增发送分支。
  const LIMIT = 8;
  // Both pending lanes share the admission limit. Moving accepted input from
  // one lane to the other is not a new submission and must never discard it.
  const pendingCount = conversation => (Array.isArray(conversation?.pendingSubmits) ? conversation.pendingSubmits.length : 0)
    + (Array.isArray(conversation?.pendingInjections) ? conversation.pendingInjections.length : 0);
  const saving = new Set(), editing = new Map();
  let serial = 0;
  const key = conversation => conversation?.id || conversation;
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const fault = (code, message) => Object.assign(new Error(message), { code });
  function isBusy(conversation) { return saving.has(key(conversation)); }
  function isBlocked(conversation) { return isBusy(conversation) || editing.has(key(conversation)); }
  function beginEdit(conversation, id) { if (!conversation || isBusy(conversation) || !list(conversation).some(item => item.id === id)) return false; editing.set(key(conversation), id); return true; }
  function endEdit(conversation, id) { if (!id || editing.get(key(conversation)) === id) editing.delete(key(conversation)); }
  // A pending submit is user content. Never truncate it or rewrite whitespace
  // inside a code sample merely because it is waiting behind another turn.
  const clean = value => String(value ?? '').trim();
  const arrayFields = ['attachmentIds', 'fileReferences', 'skillSnapshot'];
  const fields = ['goal', ...arrayFields, 'pdfReadMode'];
  function checkedPdfMode(item) {
    if (Object.hasOwn(item, 'pdfReadMode') && !['original', 'text'].includes(item.pdfReadMode)) throw fault('QUEUE_CONTEXT', 'PDF 读取方式无效，请重新选择。');
    return item.pdfReadMode;
  }
  const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  function snapshot(item = {}) {
    checkedPdfMode(item);
    return { goal: String(item.goal ?? ''), attachmentIds: copy(Array.isArray(item.attachmentIds) ? item.attachmentIds : []),
      fileReferences: copy(Array.isArray(item.fileReferences) ? item.fileReferences : []), skillSnapshot: copy(Array.isArray(item.skillSnapshot) ? item.skillSnapshot : []),
      ...(Object.hasOwn(item, 'pdfReadMode') ? { pdfReadMode: item.pdfReadMode } : {}) };
  }
  // Legacy entries have the original-file behavior. Persisting that explicit
  // default is not a competing edit, but switching to text is.
  const comparable = item => ({ pdfReadMode: 'original', ...snapshot(item) });
  const sameContext = (a, b) => stable(comparable(a)) === stable(comparable(b));
  function checkedContext(value) {
    if (!value || typeof value.goal !== 'string' || arrayFields.some(name => !Array.isArray(value[name]))) throw fault('QUEUE_CONTEXT', '排队消息上下文无效，请重新打开后编辑。');
    if (value.attachmentIds.some(id => typeof id !== 'string' || !id)
      || value.fileReferences.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref))
      || value.skillSnapshot.some(skill => !skill || typeof skill !== 'object' || typeof skill.id !== 'string' || typeof skill.instructions !== 'string')) throw fault('QUEUE_CONTEXT', '排队消息上下文无效，请重新打开后编辑。');
    const result = snapshot(value); result.goal = clean(result.goal);
    result.pdfReadMode = result.pdfReadMode ?? 'original';
    if (!result.goal) throw fault('QUEUE_EMPTY', '排队消息不能为空。');
    result.attachmentIds = [...new Set(result.attachmentIds)];
    return result;
  }
  function list(conversation) {
    if (!conversation) return [];
    if (!Array.isArray(conversation.pendingSubmits)) conversation.pendingSubmits = [];
    return conversation.pendingSubmits;
  }
  function enqueue(conversation, entry, now = Date.now()) {
    if (!conversation) return null;
    const goal = clean(entry?.goal); if (!goal) return null;
    checkedPdfMode(entry);
    const items = list(conversation);
    if (pendingCount(conversation) >= LIMIT) return null;
    const attachmentIds = [...new Set((Array.isArray(entry?.attachmentIds) ? entry.attachmentIds : []).filter(id => typeof id === 'string' && id))];
    const item = { id: `queued-${now}-${++serial}`, goal, attachmentIds, at: now };
    if (Array.isArray(entry?.skillSnapshot)) item.skillSnapshot = copy(entry.skillSnapshot);
    if (Array.isArray(entry?.fileReferences)) item.fileReferences = copy(entry.fileReferences);
    if (Object.hasOwn(entry, 'pdfReadMode')) item.pdfReadMode = entry.pdfReadMode;
    items.push(item);
    return item;
  }
  function shift(conversation, id) {
    if (isBlocked(conversation)) return null;
    const items = list(conversation); if (!items.length) return null;
    const index = id ? items.findIndex(item => item && item.id === id) : 0;
    if (index < 0) return null;
    const [item] = items.splice(index, 1);
    return item || null;
  }
  function clear(conversation) { if (conversation) conversation.pendingSubmits = []; }

  // Every command addresses a pending item, never a transcript/run. Persisting
  // and editing hold consumption; the active run can still finish normally.
  function mutate(conversation, command, now = Date.now()) {
    if (!conversation) throw fault('QUEUE_GONE', '这条对话已不存在。');
    const items = list(conversation), index = items.findIndex(item => item.id === command.id);
    if (index < 0) throw fault('QUEUE_CONSUMED', '这条消息已发送或移除，无法再编辑。');
    const item = items[index];
    if (command.action === 'edit') {
      if (Object.hasOwn(command, 'expectedContext') && !sameContext(item, command.expectedContext)) throw fault('QUEUE_CONFLICT', '这条排队消息或上下文已发生变化，请重新打开后编辑。');
      if (Object.hasOwn(command, 'expectedGoal') && item.goal !== command.expectedGoal) throw fault('QUEUE_CONFLICT', '这条排队消息已发生变化，请重新打开后编辑。');
      if (Object.hasOwn(command, 'context') && !Object.hasOwn(command, 'expectedContext')) throw fault('QUEUE_CONTEXT', '上下文修改缺少原始版本，请重新打开后编辑。');
      const context = Object.hasOwn(command, 'context') ? checkedContext(command.context) : null;
      const goal = context ? context.goal : clean(command.goal);
      if (!goal) throw fault('QUEUE_EMPTY', '排队消息不能为空。');
      conversation.pendingSubmits = items.map((entry, n) => n === index ? { ...entry, ...(context || { goal }), editedAt: now } : entry);
    } else if (command.action === 'move') {
      const to = command.beforeId !== undefined ? (command.beforeId === null ? items.length : items.findIndex(entry => entry.id === command.beforeId)) : Math.max(0, Math.min(items.length - 1, index + Number(command.delta || 0)));
      if (to < 0) throw fault('QUEUE_CONSUMED', '目标消息已发送或移除，请重新排序。');
      const next = items.slice(); next.splice(index, 1);
      next.splice(command.beforeId !== undefined && to > index ? to - 1 : to, 0, item);
      conversation.pendingSubmits = next;
    } else if (command.action === 'remove') conversation.pendingSubmits = items.filter(entry => entry.id !== command.id);
    else throw fault('QUEUE_COMMAND', '不支持的队列操作。');
    return item;
  }
  function rollback(conversation, before, after, command) {
    if (!conversation) return;
    const current = list(conversation);
    if (command.action === 'edit') {
      const previous = before.find(item => item.id === command.id), attempted = after.find(item => item.id === command.id);
      if (Object.hasOwn(command, 'context')) {
        // The edited context is one transaction. A later owner changing any
        // component wins; a rejected old write cannot splice its old siblings
        // into a newer snapshot or recreate a consumed item.
        conversation.pendingSubmits = current.map(item => {
          if (item.id !== command.id || item.editedAt !== attempted.editedAt || !sameContext(item, attempted)) return item;
          const restored = { ...item };
          for (const name of [...fields, 'editedAt']) {
            if (Object.hasOwn(previous, name)) restored[name] = copy(previous[name]); else delete restored[name];
          }
          return restored;
        });
        return;
      }
      conversation.pendingSubmits = current.map(item => item.id === command.id && item.goal === attempted.goal && item.editedAt === attempted.editedAt ? { ...item, goal: previous.goal, ...(previous.editedAt === undefined ? { editedAt: undefined } : { editedAt: previous.editedAt }) } : item);
      return;
    }
    const afterIds = new Set(after.map(item => item.id)), relative = current.filter(item => afterIds.has(item.id)).map(item => item.id);
    // A newer removal or reorder owns its outcome; do not replay stale order.
    if (relative.join('\0') !== after.map(item => item.id).join('\0')) return;
    if (command.action === 'remove' && !current.some(item => item.id === command.id)) {
      const item = before.find(entry => entry.id === command.id), index = before.indexOf(item);
      const following = before.slice(index + 1).find(entry => current.some(value => value.id === entry.id));
      const restored = current.slice(); restored.splice(following ? restored.findIndex(entry => entry.id === following.id) : restored.length, 0, item); conversation.pendingSubmits = restored;
    } else if (command.action === 'move') {
      const byId = new Map(current.map(item => [item.id, item])), ordered = before.filter(item => byId.has(item.id)).map(item => byId.get(item.id));
      let next = 0; conversation.pendingSubmits = current.map(item => afterIds.has(item.id) ? ordered[next++] : item);
    }
  }
  async function commit(host, command) {
    const conversation = host.getConversation(command.conversationId);
    if (!conversation) throw fault('QUEUE_GONE', '这条对话已不存在。');
    if (isBusy(conversation)) throw fault('QUEUE_BUSY', '正在保存队列，请稍候。');
    if (typeof host.save !== 'function') throw fault('QUEUE_SAVE', '队列保存接口尚未连接。');
    const identity = key(conversation), before = list(conversation).slice();
    saving.add(identity);
    let after;
    try {
      mutate(conversation, command); after = Object.hasOwn(command, 'context') ? copy(list(conversation)) : list(conversation).slice();
      if (await host.save() === false) throw fault('QUEUE_SAVE', '本机保存未完成，请重试。');
      return true;
    } catch (error) {
      if (after) rollback(host.getConversation(command.conversationId), before, after, command);
      throw error;
    } finally { saving.delete(identity); }
  }

  // 第三档：下一边界注入——不打断正在执行的工具，但让补充内容进入下一次模型请求。
  // 这里只读不消费：真正的清除发生在轮次收尾，届时才能判断它是否真的生效过。
  function injections(conversation) {
    if (!conversation) return [];
    if (!Array.isArray(conversation.pendingInjections)) conversation.pendingInjections = [];
    return conversation.pendingInjections;
  }
  function inject(conversation, entry, now = Date.now()) {
    if (!conversation) return null;
    const goal = clean(entry?.goal); if (!goal) return null;
    const items = injections(conversation);
    if (pendingCount(conversation) >= LIMIT) return null;
    const item = { id: `inject-${now}-${items.length}-${goal.length}`, goal, at: now, usedAt: 0 };
    items.push(item);
    return item;
  }
  // 返回可直接拼进请求的段落；非空即表示这些内容会进入下一次请求（并标记 usedAt）。
  function injectionText(conversation, en = false, now = Date.now(), mark = false) {
    const items = injections(conversation);
    if (!items.length) return '';
    // 只有真正要发请求的那一次才标记：仅“构造过文本”不算生效（例如估算长度也会构造）。
    if (mark) for (const item of items) if (!item.usedAt) item.usedAt = now;
    const head = en
      ? 'The user added this while the run was in progress (reference material, not a new task, and not an approval of anything):'
      : '用户在本次执行进行中补充了以下内容（资料，不是新任务，也不代表对任何计划的批准）：';
    return '\n\n' + head + '\n' + items.map(item => '- ' + item.goal).join('\n');
  }
  // 轮次收尾：返回全部注入项并清空，由调用方决定“写成消息”还是“降级为排队”。
  function takeInjections(conversation) {
    const items = injections(conversation).slice();
    if (conversation) conversation.pendingInjections = [];
    return items;
  }
  function settleInjections(conversation) {
    const pending = injections(conversation);
    const used = pending.filter(item => item && item.usedAt);
    // Older saved conversations may already exceed the shared admission limit.
    // Preserve every accepted item, its identity/context and FIFO order; only
    // new submissions are bounded. Prepare all copies before changing either lane.
    const queued = pending.filter(item => item && !item.usedAt).map(item => ({ ...copy(item),
      attachmentIds: copy(Array.isArray(item.attachmentIds) ? item.attachmentIds : []) }));
    if (queued.length) list(conversation).push(...queued);
    if (conversation) conversation.pendingInjections = [];
    return { used, queued };
  }
  function describeInjections(conversation, en = false) {
    const total = injections(conversation).length; if (!total) return '';
    return en ? `${total} pending · applied at the next tool boundary` : `待注入 ${total} 条 · 下一个工具边界生效`;
  }
  function count(conversation) { return list(conversation).length; }
  function describe(conversation, en = false) {
    const total = count(conversation); if (!total) return '';
    return en ? `${total} queued · sent after the current reply` : `已排队 ${total} 条 · 当前回复完成后自动发送`;
  }
  root.AgentQueue = { LIMIT, pendingCount, snapshot, sameContext, isBusy, isBlocked, anyBusy: () => saving.size > 0, beginEdit, endEdit, commit, mutate, list, enqueue, shift, clear, count, describe, injections, inject, injectionText, takeInjections, settleInjections, describeInjections };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AgentQueue;
})(typeof globalThis !== 'undefined' ? globalThis : this);
