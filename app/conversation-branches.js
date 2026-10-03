(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationBranches = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 会话内分支（消息级会话树）：在同一条对话里保留多个平行走向，并可随时切回。
  //
  // 结构上刻意保持 conversation.messages 是**当前活动路径**的线性数组——渲染、上下文组装、
  // 压缩、审阅全部照旧；被换下去或分出去的路径存放在 conversation.branches 里。
  // 新存档保留分叉前的完整历史。旧版尾段仅在原始前缀可验证时恢复，不猜测来源。
  const MAIN = 'main';
  const FULL = 'full-v1';

  function branchList(conversation) {
    const list = conversation && Array.isArray(conversation.branches) ? conversation.branches : [];
    return list.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages));
  }

  // 当前所在路径。注意：被激活的分支不在 branches 里是**正常**的（它的消息就是 conversation.messages），
  // 所以不能用"是否在存档里"来校验——那样会把正在使用的分支误判成失效并跳回主线。
  // 活跃路径的元数据单独存在 activeBranch 上，切换时随路径一起搬运，避免激活一次就丢掉来源信息。
  function currentId(conversation) {
    const meta = conversation && conversation.activeBranch;
    if (meta && typeof meta.id === 'string' && meta.id.trim()) return meta.id;
    const id = conversation && conversation.activeBranchId;
    return typeof id === 'string' && id.trim() ? id : MAIN;
  }

  function activeMeta(conversation) {
    const meta = conversation && conversation.activeBranch;
    if (meta && typeof meta.id === 'string' && meta.id.trim()) {
      return { id: meta.id, fromMessageId: meta.fromMessageId ?? null, createdAt: meta.createdAt || (conversation.createdAt || 0),
        ...(meta.historyFormat !== undefined ? { historyFormat: meta.historyFormat } : {}) };
    }
    return { id: currentId(conversation), fromMessageId: null, createdAt: (conversation && conversation.createdAt) || 0 };
  }

  // Old branches stored only the messages after their fork point. Rebuild a
  // complete path only when an ancestor in this same conversation proves its
  // exact prefix. Different possible prefixes, missing anchors, duplicate IDs,
  // cycles, or unknown history formats fail without mutating any saved data.
  function historyResolver(conversation) {
    const active = { ...activeMeta(conversation), messages: conversation?.messages || [] };
    const nodes = [active, ...branchList(conversation).filter(item => item.id !== active.id)];
    const cache = new Map();
    const validMessages = messages => Array.isArray(messages) && messages.every(item => item && typeof item.id === 'string' && item.id)
      && new Set(messages.map(item => item.id)).size === messages.length;
    const exact = (left, right) => {
      if (left.length !== right.length) return false;
      try { return left.every((message, index) => message.id === right[index].id && JSON.stringify(message) === JSON.stringify(right[index])); }
      catch { return false; }
    };
    function resolve(node, visiting = new Set()) {
      if (cache.has(node)) return cache.get(node);
      if (!validMessages(node.messages)) return { error: 'history-invalid' };
      if (node.historyFormat !== undefined && node.historyFormat !== FULL) return { error: 'history-unsupported' };
      if (node.historyFormat === FULL || (node.id === MAIN && node.fromMessageId == null)) {
        const result = { messages: node.messages.slice() }; cache.set(node, result); return result;
      }
      if (visiting.has(node) || typeof node.fromMessageId !== 'string' || !node.fromMessageId) return { error: 'history-missing' };
      const next = new Set(visiting); next.add(node);
      let prefix = null;
      for (const candidate of nodes) {
        if (candidate === node || !Array.isArray(candidate.messages) || !candidate.messages.some(item => item?.id === node.fromMessageId)) continue;
        if (next.has(candidate)) return { error: 'history-missing' };
        const parent = resolve(candidate, next);
        if (parent.error) return parent;
        const index = parent.messages.findIndex(item => item.id === node.fromMessageId);
        const value = parent.messages.slice(0, index + 1);
        if (prefix && !exact(prefix, value)) return { error: 'history-ambiguous' };
        prefix = value;
      }
      if (!prefix) return { error: 'history-missing' };
      const ownAnchor = node.messages.findIndex(item => item.id === node.fromMessageId);
      // A previously parked full path must agree with its proven ancestor;
      // never concatenate a guessed prefix over conflicting saved messages.
      if (ownAnchor >= 0 && !exact(node.messages.slice(0, ownAnchor + 1), prefix)) return { error: 'history-ambiguous' };
      const messages = ownAnchor >= 0 ? node.messages.slice() : prefix.concat(node.messages);
      if (!validMessages(messages)) return { error: 'history-invalid' };
      return { messages };
    }
    return {
      active: () => resolve(active),
      branch(id) {
        const matches = nodes.filter(node => node !== active && node.id === id);
        return matches.length === 1 ? resolve(matches[0]) : { error: matches.length ? 'history-ambiguous' : 'not-found' };
      }
    };
  }

  // 归档使用独立的可持久化快照，避免当前路径的重试附件/删除标记修改旧分支。
  function copyHistory(messages) { return JSON.parse(JSON.stringify(messages)); }

  // 从某条消息处另起分支：完整旧路径存为分支，当前路径在此截断。
  // 返回新值供调用方写回（本函数不改动入参）。
  function fork(conversation, messageId, id, now) {
    const resolved = historyResolver(conversation).active();
    if (resolved.error) return resolved;
    const messages = resolved.messages;
    if (messages.some(item => item.live)) return { error: 'running' };
    if (!id || id === currentId(conversation) || branchList(conversation).some(branch => branch.id === id)) return { error: 'duplicate-branch' };
    const index = messages.findIndex(item => item && item.id === messageId && !item.deletedAt);
    if (index < 0) return { error: 'not-found' };
    const tail = messages.slice(index + 1);
    if (!tail.length) return { error: 'empty' };
    let saved;
    try { saved = copyHistory(messages); } catch { return { error: 'history-invalid' }; }
    const branch = { id, fromMessageId: messageId, messages: saved, historyFormat: FULL, createdAt: now, at: now };
    return { keep: messages.slice(0, index + 1), branch, afterCount: tail.length,
      activeBranch: { ...activeMeta(conversation), historyFormat: FULL } };
  }

  // 切换路径：当前路径（连同它的来源元数据）存回 branches，目标分支的元数据被搬到 activeBranch。
  // 元数据必须跟着路径走一圈——否则"激活过一次"就会让分支丢掉它是从哪条消息分出来的。
  function switchTo(conversation, targetId, now) {
    const list = branchList(conversation);
    const active = activeMeta(conversation);
    if (!targetId || targetId === active.id) return { error: 'same' };
    const target = list.find(item => item.id === targetId);
    if (!target) return { error: 'not-found' };
    const resolver = historyResolver(conversation), sourceHistory = resolver.active(), targetHistory = resolver.branch(targetId);
    if (sourceHistory.error) return sourceHistory;
    if (targetHistory.error) return targetHistory;
    if (sourceHistory.messages.some(item => item.live) || targetHistory.messages.some(item => item.live)) return { error: 'running' };
    let source, destination;
    try { source = copyHistory(sourceHistory.messages); destination = copyHistory(targetHistory.messages); }
    catch { return { error: 'history-invalid' }; }
    const parked = { id: active.id, fromMessageId: active.fromMessageId, createdAt: active.createdAt,
      messages: source, historyFormat: FULL, at: now };
    return {
      activeBranchId: target.id,
      activeBranch: { id: target.id, fromMessageId: target.fromMessageId ?? null, createdAt: target.createdAt || now, historyFormat: FULL },
      messages: destination,
      branches: [...list.filter(item => item.id !== target.id), parked]
    };
  }

  function count(conversation) {
    const parked = branchList(conversation).filter(item => item.id !== currentId(conversation));
    return parked.length;
  }

  function snapshot(message) {
    const text = String((message && message.text) || '').replace(/\s+/g, ' ').trim();
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }

  // 分支标题：优先用分叉后首条用户消息（避免每条路径都显示相同的公共开头），
  // 没有就用首条消息；都没有就如实说"空分支"，不编造内容。
  function label(branch) {
    const messages = Array.isArray(branch && branch.messages) ? branch.messages : [];
    const anchor = branch?.fromMessageId && messages.findIndex(item => item?.id === branch.fromMessageId);
    const own = typeof anchor === 'number' && anchor >= 0 ? messages.slice(anchor + 1) : messages;
    const first = own.find(item => item && item.role === 'user') || own[0];
    const text = snapshot(first);
    return text || '空分支';
  }

  // 面向用户的描述：绝不把不同分支说成同一份内容。
  function describe(branch) {
    const messages = Array.isArray(branch && branch.messages) ? branch.messages : [];
    return `${label(branch)} · ${messages.length} 条`;
  }

  return Object.freeze({ MAIN, branchList, currentId, activeMeta, fork, switchTo, count, label, describe, snapshot });
}));
