(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ToolLoopGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 工具空转预警：同一个工具、同一组关键参数被反复调用时，往往不是"再做一次就有结果"，
  // 而是模型在原地打转——每一轮都要重新发一次完整上下文，代价由用户支付。
  // 这里只做**机械判定**（参数逐字相同、计数达阈值），不做任何语义猜测：
  // 参数不同（例如分页 offset 变化）不会被计入，因此正常的分批读取不会误伤。
  const LIMIT = 4;

  // 与 ToolScheduler.safeRequest 同一组关键字段：判定的是"是不是同一个调用"。
  const KEY_FIELDS = ['type', 'id', 'recordType', 'query', 'offset', 'page', 'refKey', 'variant', 'chunkId', 'version', 'radius', 'argv', 'cwd', 'timeout', 'task', 'title', 'url', 'name', 'messageId', 'maxTokens', 'runId','tabId','sessionId','snapshotId','ref','text','x','y'];

  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

  function signature(request) {
    if (!request || typeof request.type !== 'string') return '';
    const normalized = { ...request };
    if (['read', 'read_file', 'list', 'search', 'task_list', 'wiki_list', 'memory_read', 'history_read', 'history_search', 'library_overview', 'evidence_log'].includes(normalized.type)) normalized.offset ??= 0;
    if (['read', 'read_page'].includes(normalized.type)) normalized.recordType ||= 'note';
    if (normalized.type === 'read') normalized.variant ||= 'current';
    if (normalized.type === 'read_page') normalized.page ??= 1;
    if (normalized.type === 'neighbors') normalized.radius ??= 1;
    const parts = {};
    for (const key of KEY_FIELDS) {
      if (normalized[key] !== undefined) parts[key] = canonical(normalized[key]);
    }
    return JSON.stringify(parts);
  }

  // A page observation whose content differs from the previous identical one
  // (page finished loading, user logged in or acted during a handoff) is progress.
  const OBSERVATIONS = ['browser_snapshot', 'browser_screenshot'];
  function pageFingerprint(result) {
    if (!result || typeof result !== 'object') return '';
    const text = typeof result.text === 'string' ? result.text : '';
    return JSON.stringify([result.url || '', result.title || '', Array.isArray(result.elements) ? result.elements.length : 0, text.length, text.slice(0, 200), text.slice(-200)]);
  }

  function tally(toolCalls) {
    const counts = new Map();
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      if (!call || !call.request) continue;
      // A fresh page observation after a real browser action is progress.
      // Repeated observations with no intervening action still trip the guard.
      if(call.status==='completed'&&/^browser_(open|click|type|scroll|handoff)$/.test(call.request.type))for(const [key,value] of counts)if(['browser_snapshot','browser_screenshot'].includes(value.type))counts.delete(key);
      // 只统计真正走到执行的调用：排队中/被取消的不算"反复尝试"。
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(call.status)) continue;
      if (['cancelled', 'interrupted'].includes(call.status) && !call.startedAt) continue;
      const key = signature(call.request);
      if (!key) continue;
      const current = counts.get(key) || { key, type: call.request.type, count: 0, ids: [] };
      if (call.status === 'completed' && OBSERVATIONS.includes(call.request.type)) {
        const fingerprint = pageFingerprint(call.result);
        if (fingerprint && current.fingerprint && fingerprint !== current.fingerprint) { current.count = 0; current.ids = []; }
        if (fingerprint) current.fingerprint = fingerprint;
      }
      current.count += 1;
      if (current.ids.length < 3) current.ids.push(call.id);
      counts.set(key, current);
    }
    return counts;
  }

  // 返回超过阈值的调用（通常只有一个；按次数从多到少排列，便于如实说明）。
  function inspect(toolCalls, limit = LIMIT, requests) {
    const threshold = Number.isFinite(limit) && limit > 0 ? limit : LIMIT;
    const requested = Array.isArray(requests) ? new Set(requests.map(signature)) : null;
    const repeated = [...tally(toolCalls).values()].filter(item => item.count >= threshold && (!requested || requested.has(item.key))).sort((a, b) => b.count - a.count);
    return { limit: threshold, repeated };
  }

  function describe(item, limit = LIMIT) {
    if (!item) return '';
    return `检测到重复调用：${item.type} 已用相同参数调用 ${item.count} 次（上限 ${limit}）。已停止本轮以免继续空转——每一步都会重新发送完整上下文，继续下去只会消耗额度。请调整指令或参数后重发；若确实需要多次读取同一对象，请在指令中说明原因。`;
  }

  // 停止之前先提醒（参考 DeepSeek Harness 的重复调用提醒、ZCode 的软警告）：
  // 本次调用之前已用相同参数执行过 prior 次，且再执行即接近上限时，返回一段
  // 附在本次结果上的说明，让模型有机会自行换方向。只是提醒，不阻止本次调用。
  function reminder(request, prior, limit = LIMIT) {
    const threshold = Number.isFinite(limit) && limit > 0 ? limit : LIMIT;
    if (!request || !Number.isSafeInteger(prior) || prior < threshold - 2) return '';
    // inspect() stops a call once `threshold` identical calls have already run,
    // so after `done` calls, `threshold - done` more are allowed.
    const done = prior + 1, left = threshold - done;
    return `提醒：${request.type} 已用相同参数执行 ${done} 次。${left > 0 ? `最多还能相同调用 ${left} 次，再多将停止本轮。` : '再次相同调用将停止本轮。'}结果没有变化时，请换用其他参数或工具，或基于已有结果提交最终答复。`;
  }

  return Object.freeze({ LIMIT, KEY_FIELDS, signature, tally, inspect, describe, reminder });
}));
