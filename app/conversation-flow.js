/* Host-observed conversation order. Tool payloads remain in the tool ledger. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationFlow = api;
})(globalThis, () => {
  'use strict';
  const kinds = new Set(['response', 'reasoning', 'commentary', 'tool']);
  const pending = new Set(['pending', 'queued', 'running', 'awaiting-approval', 'awaiting-save']);
  const statuses = new Set([...pending, 'completed', 'failed', 'cancelled', 'interrupted', 'timed_out', 'rejected', 'unknown']);
  const aliases = { succeeded: 'completed', done: 'completed', 'completed-local': 'completed', canceled: 'cancelled', error: 'failed' };
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f-\u009f]/.test(value) ? value : null;
  const optionalId = value => value == null ? undefined : identifier(value);
  const statusOf = (value, fallback = 'running') => value == null ? fallback : typeof value !== 'string' ? null : statuses.has(value) ? value : Object.hasOwn(aliases, value) ? aliases[value] : null;
  const validItem = item => item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 1600
    && Number.isSafeInteger(item.seq) && item.seq > 0 && kinds.has(item.kind) && statuses.has(item.status)
    && (item.parentId === undefined || identifier(item.parentId)) && (item.attemptId === undefined || identifier(item.attemptId))
    && (item.kind === 'tool' ? identifier(item.callId) : typeof item.text === 'string');
  const flowOf = message => message?.conversationFlow?.version === 1 && Array.isArray(message.conversationFlow.items) ? message.conversationFlow : null;
  const recorders = new WeakMap();

  function create(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('A conversation message is required');
    const cached = recorders.get(message);
    if (cached && cached.flow === message.conversationFlow) return cached.api;
    // Never replace an unknown persisted format or derive events from legacy text.
    if (message.conversationFlow != null && !flowOf(message)) throw new TypeError('Unsupported conversation flow');
    const flow = flowOf(message) || (message.conversationFlow = { version: 1, nextSeq: 1, items: [] });
    const byId = new Map(flow.items.filter(validItem).map(item => [item.id, item]));
    const lastSeq = flow.items.reduce((last, item) => Number.isSafeInteger(item?.seq) && item.seq > last ? item.seq : last, 0);
    if (!Number.isSafeInteger(flow.nextSeq) || flow.nextSeq <= lastSeq || flow.nextSeq < 1) flow.nextSeq = lastSeq + 1;
    // The bounded composite key is durable: rehydration can update the same item
    // without storing a second copy of its source text or a transient lookup ID.
    const identity = (kind, parentId, attemptId, sourceId) => JSON.stringify([kind, parentId || null, attemptId || null, sourceId]);
    const upsert = ({ kind, sourceId, attemptId, parentId, text, status, callId }) => {
      const id = identity(kind, parentId, kind === 'tool' ? undefined : attemptId, sourceId);
      let item = byId.get(id);
      if (item) {
        // Terminal records cannot be reopened by a late delta or later success.
        const nextStatus = pending.has(item.status) ? status : item.status;
        if (item.text === text && item.status === nextStatus && (!attemptId || item.attemptId === attemptId)) return item;
        if (kind !== 'tool') item.text = text;
        if (attemptId && !item.attemptId) item.attemptId = attemptId;
        item.status = nextStatus;
        item.updatedAt = Date.now();
        return item;
      }
      if (!Number.isSafeInteger(flow.nextSeq) || flow.nextSeq >= Number.MAX_SAFE_INTEGER) return null;
      const at = Date.now();
      item = { id, seq: flow.nextSeq++, kind, ...(attemptId ? { attemptId } : {}), ...(parentId ? { parentId } : {}),
        ...(kind === 'tool' ? { callId } : { text }), status, at, updatedAt: at };
      flow.items.push(item); byId.set(id, item);
      return item;
    };
    const response = (attempt, text, options = {}) => {
      const attemptId = identifier(attempt), parentId = optionalId(options.parentId), status = statusOf(options.status);
      // Empty SAFE projections are normal while a JSON envelope is incomplete.
      // They neither create placeholder prose nor erase already received prose.
      if (!attemptId || parentId === null || !status || typeof text !== 'string' || !text) return null;
      return upsert({ kind: 'response', sourceId: attemptId, attemptId, parentId, text, status });
    };
    const activity = (value, options = {}) => {
      if (!value || value.source === 'transport' || !['summary', 'commentary'].includes(value.kind)) return null;
      const sourceId = identifier(value.id), attemptId = optionalId(value.attemptId), parentId = optionalId(options.parentId ?? value.parentId), status = statusOf(value.status);
      if (!sourceId || attemptId === null || parentId === null || !status || typeof value.text !== 'string' || !value.text) return null;
      return upsert({ kind: value.kind === 'summary' ? 'reasoning' : 'commentary', sourceId, attemptId, parentId, text: value.text, status });
    };
    const tool = call => {
      if (!call) return null;
      const callId = identifier(call.id), attemptId = optionalId(call.attemptId), parentId = optionalId(call.parentId), status = statusOf(call.status, 'unknown');
      if (!callId || attemptId === null || parentId === null || !status) return null;
      return upsert({ kind: 'tool', sourceId: callId, callId, attemptId, parentId, status });
    };
    const settleAttempt = (attempt, status, options = {}) => {
      const attemptId = identifier(attempt), parentId = optionalId(options.parentId), settled = statusOf(status, null);
      if (!attemptId || parentId === null || !settled || pending.has(settled)) return false;
      let changed = false;
      for (const item of flow.items) if (validItem(item) && item.kind !== 'tool' && item.attemptId === attemptId
        && (item.parentId || undefined) === parentId && pending.has(item.status)) {
        item.status = settled; item.updatedAt = Date.now(); changed = true;
      }
      return changed;
    };
    const finish = status => {
      const settled = statusOf(status, null);
      if (!settled || pending.has(settled)) return false;
      let changed = false;
      for (const item of flow.items) if (validItem(item) && pending.has(item.status)) {
        // A successful model turn does not prove an unfinished tool succeeded.
        item.status = item.kind === 'tool' && settled === 'completed' ? 'interrupted' : settled;
        item.updatedAt = Date.now(); changed = true;
      }
      return changed;
    };
    const api = { response, activity, tool, settleAttempt, finish };
    recorders.set(message, { flow, api });
    return api;
  }

  function entries(message, run = {}) {
    const flow = flowOf(message);
    if (!flow) return [];
    const ordered = flow.items.filter(validItem).slice().sort((a, b) => a.seq - b.seq);
    const lastMain = ordered.filter(item => !item.parentId).at(-1);
    const calls = new Map((Array.isArray(run?.toolCalls) ? run.toolCalls : []).filter(call => identifier(call?.id)).map(call => [call.id, call]));
    return ordered.filter(item => !(item === lastMain && item.kind === 'response' && item.text === message.text))
      .map(item => item.kind === 'tool' ? { ...item, ...(calls.has(item.callId) ? { call: calls.get(item.callId) } : {}) } : item);
  }
  return { create, entries };
});
