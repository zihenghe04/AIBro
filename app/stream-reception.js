(function (root) {
  'use strict';
  // This is transient transport evidence, never a run outcome or retry policy.
  const session = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const kinds = new Set(['output', 'summary', 'commentary', 'tool', 'source']);
  const outcomes = new Set(['completed', 'failed', 'cancelled']);
  let order = 0;
  function valid(value) {
    return value?.session === session && typeof value.requestId === 'string'
      && Number.isSafeInteger(value.order) && value.order > 0 && value.requestId === `${session}:${value.order}`
      && Number.isSafeInteger(value.revision) && value.revision > 0
      && Number.isFinite(value.startedAt) && Number.isFinite(value.updatedAt) && value.updatedAt >= value.startedAt;
  }
  function createEmitter(onChange, { now = () => Date.now() } = {}) {
    let current = null;
    function publish(next) {
      current = Object.freeze(next);
      // Presentation must never reject, retry or otherwise change a request.
      try { onChange?.(current); } catch (_) {}
    }
    return {
      start() {
        const at = now(), ordinal = ++order;
        publish({ session, requestId: `${session}:${ordinal}`, order: ordinal, revision: 1,
          startedAt: at, updatedAt: at, lastContentAt: null, lastKind: null, active: true, outcome: null });
      },
      content(kind) {
        if (!current?.active || !kinds.has(kind)) return;
        const at = Math.max(current.updatedAt, now());
        publish({ ...current, revision: current.revision + 1, updatedAt: at, lastContentAt: at, lastKind: kind });
      },
      finish(outcome) {
        if (!current?.active || !outcomes.has(outcome)) return;
        publish({ ...current, revision: current.revision + 1, updatedAt: Math.max(current.updatedAt, now()), active: false, outcome });
      },
    };
  }
  // Ignore delayed callbacks from an earlier request, duplicate revisions, and
  // receipts serialized by an earlier page/process. Callers also check run ownership.
  function reduce(current, incoming) {
    if (!valid(incoming)) return current;
    if (!valid(current)) return incoming.revision === 1 ? incoming : current;
    if (incoming.order < current.order || incoming.order === current.order && incoming.revision <= current.revision) return current;
    if (incoming.order > current.order && incoming.revision !== 1) return current;
    if (incoming.order === current.order && !current.active) return current;
    return incoming;
  }
  function project(value, { live = false, phase, now = Date.now(), threshold = 15000 } = {}) {
    if (!live || !valid(value) || !value.active || !['waiting', 'thinking', 'writing'].includes(phase)) return null;
    const anchor = value.lastContentAt ?? value.startedAt;
    if (!Number.isFinite(anchor) || !Number.isFinite(now)) return null;
    const elapsed = Math.max(0, now - anchor);
    return { requestId: value.requestId, quiet: elapsed >= threshold,
      first: value.lastContentAt === null, seconds: Math.floor(elapsed / 1000) };
  }
  root.StreamReception = { createEmitter, reduce, project };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.StreamReception;
})(typeof globalThis !== 'undefined' ? globalThis : this);
