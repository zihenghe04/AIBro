/* Usage statistics recorder: turns finished model requests into counts-only rows for /__usage/record.
   No prompt, answer, URL or key ever reaches it; a failing or slow log never affects a run. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsageRecorder = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_QUEUE = 200, BATCH = 50, FLUSH_MS = 800;
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const OUTCOME = { completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted' };

  // options: { post(entries) → Promise, now(), skip() → bool, route(item, run) → {id, kind}, setTimer/clearTimer }
  function create(options = {}) {
    const now = options.now || (() => Date.now());
    const setTimer = options.setTimer || ((fn, ms) => root.setTimeout(fn, ms)), clearTimer = options.clearTimer || (id => root.clearTimeout(id));
    const queue = [], open = new Map();
    let timer = null, flushing = false, observing = null;

    async function flush() {
      if (timer) { clearTimer(timer); timer = null; }
      if (flushing || !queue.length || !options.post) return;
      flushing = true;
      const entries = queue.splice(0, BATCH);
      try { await options.post(entries); } catch (_) { /* best effort: statistics are never worth blocking a run */ }
      flushing = false;
      if (queue.length) schedule();
    }
    function schedule() { if (!timer) timer = setTimer(() => { timer = null; void flush(); }, FLUSH_MS); }
    function commit(entry) {
      if (options.skip?.()) return false;
      if (!entry || !entry.providerId || !entry.model) return false;
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(entry); schedule(); return true;
    }
    function entryOf(base, finish) {
      const usage = base.usage || {};
      return {
        ts: finish, providerId: base.providerId, providerKind: base.providerKind, model: base.model, role: base.role,
        input: count(usage.input), output: count(usage.output), cacheRead: count(base.cacheRead), latencyMs: Math.max(0, finish - base.startedAt),
        status: base.httpStatus || (base.outcome === 'completed' ? 200 : null), outcome: OUTCOME[base.outcome] || 'failed', runId: base.runId || ''
      };
    }

    // Chat / delegate / compaction requests go through AgentUsage's attempt ledger.
    function observe(agentUsage, { role = 'qa' } = {}) {
      if (!agentUsage?.observe || observing) return () => {};
      observing = agentUsage.observe(event => {
        const item = event.item || {};
        if (!item.id) return;
        if (event.type === 'start') {
          const route = options.route?.(item, event.run) || {};
          open.set(item.id, { startedAt: now(), providerId: route.id || '', providerKind: route.kind || 'api', model: item.model, role, runId: event.run?.id || '', usage: null, cacheRead: null });
        } else if (event.type === 'report') {
          const state = open.get(item.id);
          if (state) { state.usage = event.usage; if (event.meta && count(event.meta.cacheRead) !== null) state.cacheRead = event.meta.cacheRead; }
        } else if (event.type === 'end') {
          const state = open.get(item.id);
          if (!state) return;
          open.delete(item.id);
          commit(entryOf({ ...state, outcome: item.status, httpStatus: count(event.httpStatus) }, now()));
        }
      });
      return () => { observing?.(); observing = null; };
    }

    // One-off requests that bypass the run ledger (translation, source explanation): wrap the transport's callbacks.
    function track({ role, providerId, providerKind = 'api', model, runId = '' }) {
      const state = { startedAt: now(), providerId, providerKind, model, role, runId, usage: null, cacheRead: null }, started = new Set();
      let settled = false;
      return {
        onAttempt(event) {
          if (!event || settled) return;
          if (event.status === 'running') { started.add(event.id); state.startedAt = now(); return; }
          if (!started.has(event.id)) return;
          settled = true;
          commit(entryOf({ ...state, outcome: event.status, httpStatus: count(event.httpStatus) }, now()));
        },
        onUsage(usage, meta) { state.usage = usage; if (meta && count(meta.cacheRead) !== null) state.cacheRead = meta.cacheRead; }
      };
    }

    // Background kernel: the loop reports each model response as an event.
    function kernelTap({ providerId, providerKind = 'api', model, runId = '' }) {
      return data => {
        if (!data || data.purpose === 'compaction' && !data.usage && data.status !== 'completed' && data.status !== 'failed') return;
        const finish = now(), ms = count(data.ms) ?? 0;
        const outcome = data.status === 'completed' ? 'completed' : data.status === 'cancelled' ? 'cancelled' : 'failed';
        commit({ ts: finish, providerId, providerKind, model, role: 'kernel', input: count(data.usage?.input), output: count(data.usage?.output), cacheRead: null, latencyMs: ms, status: outcome === 'completed' ? 200 : null, outcome, runId });
      };
    }

    return { observe, track, kernelTap, flush, pending: () => queue.length };
  }

  // 浏览器里的默认发送方式。
  const httpPost = entries => root.fetch('/__usage/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }), keepalive: true });

  return Object.freeze({ create, httpPost });
}));
