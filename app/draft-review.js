(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./note-editor.js') : root.NoteEditor);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DraftReview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Editor) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const active = value => value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['archived', 'deleted'].includes(value.status);
  const hasDraft = note => active(note) && typeof note.aiDraft?.content === 'string';
  const scope = conversation => JSON.stringify([conversation.id, conversation.projectId || null, conversation.workspace || 'auto']);
  const resultIds = results => [...new Set(list(results).filter(result => result?.type === 'note' && result.id).map(result => result.id))];
  function groups(state, conversation) {
    const messages = list(conversation?.messages).filter(active);
    const rows = messages.map((message, order) => ({ ids: resultIds(message.results), at: Number(message.at || message.createdAt) || 0, order }));
    for (const run of list(state.agentRuns)) {
      if (!active(run) || run.conversationId !== conversation?.id) continue;
      // Message results are the user-visible review boundary; avoid duplicating
      // their underlying run with a different timestamp.
      if (messages.some(message => message.runId === run.id && resultIds(message.results).length)) continue;
      rows.push({ ids: resultIds(run.results), at: Number(run.finishedAt || run.completedAt || run.startedAt) || 0, order: rows.length });
    }
    return rows.filter(row => row.ids.length).sort((a, b) => b.at - a.at || b.order - a.order);
  }
  function inScope(state, note, conversation) {
    if (!active(note)) return false;
    if (note.projectId && !list(state.projects).some(project => project.id === note.projectId && active(project))) return false;
    if (!conversation) return true; // A direct note-reader button already identifies its note.
    if (!active(conversation)) return false;
    if (conversation.projectId && note.projectId !== conversation.projectId) return false;
    if (!conversation.projectId && conversation.workspace && conversation.workspace !== 'auto' && note.workspace !== conversation.workspace) return false;
    if (!conversation.projectId && !groups(state, conversation).some(row => row.ids.includes(note.id))) return false;
    return true;
  }
  function begin(state, noteId, conversation) {
    const note = list(state.notes).find(item => item.id === noteId);
    if (!hasDraft(note)) throw new Error('这份待处理草稿已不可用，请刷新笔记。');
    if (!inScope(state, note, conversation)) throw new Error('这份草稿不属于当前对话的项目或结果，未作修改。');
    return {
      noteId, expectedDraft: JSON.stringify(note.aiDraft), expectedNote: JSON.stringify(note),
      editorSession: Editor.begin(state, noteId),
      ...(conversation ? { conversationId: conversation.id, expectedScope: scope(conversation) } : {})
    };
  }
  function prepare(state, review, action, now = Date.now()) {
    if (!['adopt', 'discard'].includes(action)) throw new Error('未知的草稿处理操作。');
    if (!review || typeof review.expectedDraft !== 'string' || typeof review.expectedNote !== 'string') throw new Error('缺少草稿版本，请重新打开待处理草稿。');
    const note = list(state.notes).find(item => item.id === review.noteId);
    if (!hasDraft(note) || JSON.stringify(note.aiDraft) !== review.expectedDraft || JSON.stringify(note) !== review.expectedNote) throw new Error('笔记或草稿已被其他操作修改，请查看最新版本；未覆盖任何内容。');
    const conversation = review.conversationId ? list(state.conversations).find(item => item.id === review.conversationId) : null;
    if (review.conversationId && (!conversation || scope(conversation) !== review.expectedScope) || !inScope(state, note, conversation)) throw new Error('对话或项目归属已变化，请重新查看草稿。');
    const session = clone(review.editorSession);
    if (session.id !== review.noteId) throw new Error('草稿与笔记版本不匹配。');
    if (action === 'adopt') {
      session.title = note.aiDraft.title || note.title;
      session.content = note.aiDraft.content;
      session.appliedAiDraft = review.expectedDraft;
    }
    const change = Editor.prepare(state, session, now);
    const before = clone(note);
    const after = clone(action === 'adopt' ? change.after : note);
    if (action === 'adopt') {
      after.sourceAttachmentIds = [...new Set([...list(note.sourceAttachmentIds), ...list(note.aiDraft.sourceAttachmentIds)].filter(id => typeof id === 'string' && id))];
      // Retain the old body's provenance alongside its existing revision.
      if (after.revisionHistory?.length) after.revisionHistory.at(-1).sourceAttachmentIds = clone(list(note.sourceAttachmentIds));
    }
    after.aiDraftHistory = [...clone(list(note.aiDraftHistory)), { action, reviewedAt: now, draft: clone(note.aiDraft) }];
    after.updatedAt = now;
    delete after.aiDraft;
    return { changed: true, action, note, before, after };
  }
  function command(text) {
    const value = String(text || '').trim().replace(/[。.!！]+$/, '').trim().toLowerCase();
    if (/^(?:采纳|采纳草稿|采纳这份草稿|接受草稿|accept(?: (?:the )?draft)?|adopt(?: (?:the )?draft)?)$/.test(value)) return 'adopt';
    if (/^(?:放弃|放弃草稿|放弃这份草稿|不采纳|丢弃草稿|discard(?: (?:the )?draft)?|reject(?: (?:the )?draft)?)$/.test(value)) return 'discard';
    return null;
  }
  function resolve(state, conversation, text) {
    const action = command(text);
    if (!action) return { status: 'unhandled', action: null, candidateIds: [] };
    if (!active(conversation)) return { status: 'missing', action, candidateIds: [] };
    for (const row of groups(state, conversation)) {
      const candidates = row.ids.filter(id => {
        const note = list(state.notes).find(item => item.id === id);
        return hasDraft(note) && inScope(state, note, conversation);
      });
      if (!candidates.length) continue;
      if (candidates.length > 1) return { status: 'ambiguous', action, candidateIds: candidates };
      return { status: 'resolved', action, candidateIds: candidates, review: begin(state, candidates[0], conversation) };
    }
    return { status: 'missing', action, candidateIds: [] };
  }
  return { begin, prepare, resolve, command };
}));
