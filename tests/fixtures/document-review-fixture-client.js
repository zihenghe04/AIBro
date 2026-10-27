/* Isolated renderer/native QA fixture. Load only into a temporary data directory. */
;(async function documentReviewFixture() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (!storageHydrated) await wait(25);
  if (!state.projects.some(project => project.id === 'review-project')) {
    const now = Date.now(), copy = value => JSON.parse(JSON.stringify(value));
    const projectId = 'review-project', conversationId = 'review-conversation', runId = 'review-run';
    const notes = [
      { id: 'review-first', title: '01 · 研究问题', content: '# 研究问题\n\nFIRST ORIGINAL · 原来的研究问题。', draft: '# 研究问题\n\nFIRST PROPOSAL · 建议改写研究问题。' },
      { id: 'review-second', title: '02 · 阅读结论', content: '# 阅读结论\n\nSECOND ORIGINAL · 尚未采纳的原始结论。', draft: '# 阅读结论\n\nSECOND PROPOSAL · 经过核对的新结论。\n\n## 证据\n\n保留来源和审阅记录。' },
    ].map(({ draft, ...note }) => ({ ...note, projectId, workspace: '科研', folderPath: '审阅示例', createdAt: now - 10000, updatedAt: now,
      aiDraft: { title: note.title, content: draft, createdAt: now,
        provenance: { version: 1, output: { type: 'note', id: note.id, variant: 'draft' }, operation: 'drafted',
          origin: { recorded: true, conversationId, runId, at: now } } } }));
    const results = notes.map(note => ({ type: 'note', id: note.id, operation: 'drafted' }));
    const changes = notes.map(note => { const before = copy(note); delete before.aiDraft; return {
      type: 'note', id: note.id, title: note.title, folderPath: note.folderPath, operation: 'drafted',
      before, after: copy(note), added: note.id === 'review-second' ? 5 : 1, removed: 1,
    }; });
    state.projects = [{ id: projectId, name: '文档审阅 · 隔离验收', workspace: '科研', createdAt: now }];
    state.notes = notes; state.tasks = []; state.imports = []; state.papers = []; state.trash = [];
    state.conversations = [{ id: conversationId, projectId, workspace: '科研', title: '核对两份草稿并保留来源', draft: '',
      attachments: [], draftAttachmentIds: [], createdAt: now - 5000, updatedAt: now,
      messages: [{ id: 'review-user', role: 'user', text: '请提出两份修订草稿，等我审阅后再保存。', at: now - 5000 },
        { id: 'review-answer', role: 'assistant', text: '两份草稿已准备好，请核对差异后采纳或放弃。', runId,
          runStatus: 'completed', results: copy(results), at: now, startedAt: now - 4000, finishedAt: now }] }];
    state.agentRuns = [{ id: runId, projectId, conversationId, status: 'completed', startedAt: now - 4000, finishedAt: now,
      results: copy(results), fileChanges: changes, steps: [], commands: [] }];
    state.currentProjectId = projectId; state.currentConversationId = conversationId;
    state.ui.workspaceNavigation = { projects: {} }; state.ui.projectTab = 'conversations';
    state.ui.onboarding = { version: 1, status: 'skipped' }; state.ui.workspaceTour = { version: 1, status: 'skipped' };
    state.ui.theme = 'light'; state.ui.inspectorOpen = true; state.ui.inspector = 'files';
    normalizeStateShape(state); await saveDocumentDurably();
  }
  WorkstationOnboarding.close(); window.WorkspaceTour?.close?.();
  applyUiPreferences(); showView('agent', '持续对话'); renderAll();
  window.__documentReviewFixtureReady = true;
})();
