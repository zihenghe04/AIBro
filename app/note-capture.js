/* 对话产出 → 可编辑文档：把一条回复存成笔记的纯逻辑（标题取材 + 查找 + 计划）。
   三条边界：
   1) 只读取原消息，不改写消息、不改写任何既有笔记；
   2) 只从原文取材生成标题（去 Markdown 标记后截断），不总结、不改写、不调用模型；
   3) 同一对话中的同一条消息只存一次，重复点击打开已有文档；复制到新对话的消息独立保存。 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./artifact-provenance.js') : root.ArtifactProvenance);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provenance) {
  'use strict';

  const MAX_TITLE = 60;
  const WORKSPACES = ['日常', '课程', '科研'];

  // 标题：取第一条有内容的行，剥掉 Markdown 标记后截断。不做语义总结——
  // 标题就是原文的剪影，用户一眼能认出它来自哪条回复。
  function titleFromMessage(value) {
    const lines = String(value == null ? '' : value).split('\n');
    for (const raw of lines) {
      const line = String(raw)
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!line) continue;
      const chars = Array.from(line);
      return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE).join('')}…` : line;
    }
    return '';
  }

  function findMessage(state, messageId, conversationId) {
    const conversations = (state && state.conversations) || [];
    // A fork retains prefix message IDs. An explicit owner must never fall
    // back to the first matching message in a different conversation.
    const owners = conversationId === undefined ? conversations : conversations.filter(item => item?.id === conversationId);
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId || owners.length !== 1)) return null;
    const matches = [];
    for (const conversation of owners) {
      if (!conversation || conversation.deletedAt || conversation.archived) continue;
      for (const message of conversation.messages || []) {
        if (message && message.id === messageId && !message.deletedAt) matches.push({ conversation, message });
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function existingNote(state, messageId, conversationId) {
    const candidates = ((state && state.notes) || []).filter(note => note
      && note.sourceMessageId === messageId
      && !note.deletedAt
      && !note.archived);
    if (conversationId === undefined) return candidates.length === 1 ? candidates[0] : null;
    if (typeof conversationId !== 'string' || !conversationId) return null;
    const owned = candidates.find(note => note.sourceConversationId === conversationId);
    if (owned) return owned;
    // Older notes did not persist the owner. Reuse only when the message's
    // owner is provable; never relabel or overwrite a user's legacy note.
    const source = findMessage(state, messageId);
    const legacy = candidates.filter(note => !note.sourceConversationId);
    const retainedOwners = [...(state?.conversations || []), ...(state?.trash || []).flatMap(bundle => bundle?.data?.conversations || [])]
      .filter(owner => (owner?.messages || []).some(message => message?.id === messageId));
    // Archiving/trashing the original does not transfer its legacy output to
    // a copied prefix. A known branch is still ambiguous after hard deletion.
    return source?.conversation.id === conversationId && !source.conversation.branchedFrom
      && retainedOwners.length === 1 && legacy.length === 1 ? legacy[0] : null;
  }

  function citationRun(state, found, evidence) {
    const { message, conversation } = found;
    const runId = message.runId || message.pendingRunId || message.retryRunId;
    const runs = (state.agentRuns || []).filter(item => item?.id === runId);
    const direct = runs.length === 1 && runs[0].conversationId === conversation.id ? runs[0] : null;
    // A copied message can carry an explicit citation receipt, not a new
    // execution. The evidence module revalidates that receipt and its owner.
    return evidence?.runForCitations ? evidence.runForCitations(message, direct, state) : direct;
  }

  // Only explicit prose citations become navigable source relationships.
  // A delivered attachment or search hit alone is not support for this answer.
  // Keep the same code-span/fence boundary as CitationEvidence.exportText.
  function citedSources(state, messageId, evidence, conversationId) {
    const found = findMessage(state, messageId, conversationId);
    if (!found || found.message.role === 'user' || !evidence?.sourcesFor || !evidence?.markers || !evidence?.access) return [];
    const { message } = found;
    const run = citationRun(state, found, evidence);
    if (!run) return [];
    const sources = evidence.sourcesFor(message, run, state), used = new Map();
    let prose = '', fence = null;
    const flush = () => {
      for (const { source } of evidence.markers(prose, sources)) {
        if (!source?.provided || sources.filter(item => item.sourceId === source.sourceId).length !== 1 || !['import', 'note'].includes(source.type) || !source.id || !evidence.access(state, source).available) continue;
        used.set(source.sourceId, source);
      }
      prose = '';
    };
    for (const line of String(message.text || '').split(/(?<=\n)/)) {
      const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) { if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null; continue; }
      if (match) { flush(); fence = match[1]; continue; }
      let start = 0, code; const pattern = /(`+)([^\n]*?)\1/g;
      while ((code = pattern.exec(line))) { prose += line.slice(start, code.index); flush(); start = code.index + code[0].length; }
      prose += line.slice(start);
    }
    flush();
    return [...used.values()];
  }

  // A failed creation may remove only its own untouched object. Conservatively
  // retain it if any other workspace record now holds its exact ID, including
  // links, result cards, source lists, wiki maps or records unknown to this module.
  function canRollbackCreation(state, note, snapshot) {
    if (!(state.notes || []).includes(note) || JSON.stringify(note) !== snapshot) return false;
    const seen = new Set();
    function references(value) {
      if (value === note) return false;
      if (value === note.id) return true;
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      return Object.entries(value).some(([key, item]) => key === note.id || references(item));
    }
    return !references(state);
  }

  // plan 只回答"该做什么"，不产生副作用：create / exists / empty / missing。
  // id 由调用方注入（保持本模块不依赖运行时的 uid）。
  function plan(state, messageId, options = {}) {
    const now = Number(options.now) || Date.now();
    const found = findMessage(state, messageId, options.conversationId);
    if (!found) return { kind: 'missing' };
    const text = String(found.message.text || '');
    if (!text.trim()) return { kind: 'empty' };
    const existing = existingNote(state, messageId, found.conversation.id);
    if (existing) return { kind: 'exists', note: existing };
    const conversation = found.conversation || {};
    const sources = citedSources(state, messageId, options.citationEvidence, conversation.id);
    const note = {
      id: String(options.id || ''),
      kind: '对话产出',
      title: titleFromMessage(text) || `来自对话：${conversation.title || '新对话'}`,
      content: text,
      workspace: WORKSPACES.includes(conversation.workspace) ? conversation.workspace : '日常',
      projectId: conversation.projectId || null,
      sourceConversationId: conversation.id || null,
      sourceMessageId: messageId,
      sourceAttachmentIds: [...new Set(sources.filter(source => source.type === 'import').map(source => source.id))],
      createdAt: now,
      updatedAt: now,
    };
    const noteSources = [...new Set(sources.filter(source => source.type === 'note').map(source => source.id))];
    if (noteSources.length) note.sourceNoteIds = noteSources;
    if (found.message.role !== 'user' && options.citationEvidence?.documentText) {
      const run = citationRun(state, found, options.citationEvidence);
      note.content = options.citationEvidence.documentText(found.message, run, state);
      note.title = titleFromMessage(note.content) || note.title;
      if (run && provenance?.capture) note.provenance = provenance.capture(state, run, { type: 'note', id: note.id, record: note, operation: 'captured', at: now });
    }
    return { kind: 'create', note };
  }

  return { MAX_TITLE, titleFromMessage, findMessage, existingNote, citedSources, canRollbackCreation, plan };
});
