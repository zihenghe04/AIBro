/* One truthful view of the next request and the latest frozen request.
 * Reading this panel never reads local files or calls a model or search service. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContextWorkbench = api;
})(globalThis, function (root) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '') ? en : zh;
  const privateItem = value => !!(value?.private || value?.ephemeral || value?.incognito);
  const active = value => !!value && !value.wikiFileError && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['deleted', 'archived'].includes(value.status);
  const collections = { note: 'notes', import: 'imports', paper: 'papers', task: 'tasks' };
  const F = () => root.FileContext || (typeof require === 'function' ? require('./file-context.js') : null);
  const E = () => root.CitationEvidence || (typeof require === 'function' ? require('./citation-evidence.js') : null);
  const unique = (values, id) => { const found = list(values).filter(value => value.id === id); return found.length === 1 ? found[0] : null; };
  const refKey = ref => F()?.key(ref) || JSON.stringify([ref.type, ref.id]);
  function access(state, source) {
    if (E()?.access) return E().access(state, source);
    const record = source.type === 'local' ? unique(state.projects, source.projectId) : unique(state[collections[source.type]], source.id);
    const project = source.type === 'local' ? record : record?.projectId ? unique(state.projects, record.projectId) : null;
    const run = record?.agentRunId ? unique(state.agentRuns, record.agentRunId) : null;
    const conversationId = record?.sourceConversationId || run?.conversationId;
    const conversation = conversationId ? unique(state.conversations, conversationId) : null;
    if ([record, project, run, conversation].some(privateItem)) return { kind: 'private', available: false, record: null };
    if (source.type === 'web') return { kind: 'external', available: !!E()?.safeURL(source.url), record: null };
    if (!active(record) || record?.projectId && !active(project) || source.type === 'local' && project?.localFolder?.id !== source.candidateId) return { kind: 'missing', available: false, record: null };
    return { kind: 'available', available: true, record };
  }
  const reference = ref => ({ type: ref.type, id: ref.id || null, projectId: ref.projectId || null, candidateId: ref.candidateId || null, path: text(ref.path), title: text(ref.title), version: text(ref.version), selectedAt: ref.selectedAt });
  function sourceTitle(source, visibility, fallback) {
    if (visibility.kind === 'private') return t('私密来源', 'Private source');
    return text(source.title || source.name || source.originalName) || fallback || t('未命名来源', 'Untitled source');
  }
  function versionInput(state, ref) {
    const visibility = access(state, ref);
    if (!visibility.available || !['note', 'import'].includes(ref.type)) return null;
    const record = visibility.record;
    return ref.type === 'note' ? String(record.content || '') : JSON.stringify([record.id, record.createdAt, record.size, record.originalName]);
  }
  async function inspectVersions(state, conversation) {
    const entries = await Promise.all((F()?.references(conversation) || []).map(async ref => {
      const visibility = access(state, ref), key = refKey(ref);
      if (!visibility.available) return [key, { kind: visibility.kind }];
      if (ref.type === 'local') return [key, { kind: 'local' }];
      if (!['note', 'import'].includes(ref.type)) return [key, { kind: 'missing' }];
      try { const current = await F().libraryRef(state, ref.type, ref.id); return [key, { kind: !ref.version ? 'unversioned' : current.version === ref.version ? 'current' : 'changed', version: current.version }]; }
      catch (_) { return [key, { kind: 'missing' }]; }
    }));
    return new Map(entries);
  }
  function selectedMaterials(state, conversation, versionChecks = new Map()) {
    const rows = new Map();
    for (const raw of F()?.references(conversation) || []) {
      const ref = reference(raw), visibility = access(state, ref), key = refKey(ref);
      const row = { key, type: ref.type, id: ref.id, ref: visibility.kind === 'private' ? { type: ref.type, id: ref.id, projectId: ref.projectId, candidateId: ref.candidateId, path: ref.path } : ref, title: sourceTitle(ref, visibility), available: visibility.available, private: visibility.kind === 'private', fromReference: true, fromAttachment: false,
        state: visibility.available ? (ref.type === 'local' ? 'local' : versionChecks.get(key)?.kind || 'checking') : visibility.kind };
      // Private paths and source titles must not remain in hidden UI props.
      if (row.private) { row.ref = { type: ref.type, id: ref.id, projectId: ref.projectId, candidateId: ref.candidateId, path: ref.path }; }
      rows.set(key, row);
    }
    for (const id of new Set(list(conversation?.draftAttachmentIds))) {
      const key = refKey({ type: 'import', id }), existing = rows.get(key);
      if (existing) { existing.fromAttachment = true; continue; }
      const source = { type: 'import', id }, visibility = access(state, source);
      rows.set(key, { key, type: 'import', id, ref: source, title: sourceTitle(visibility.record || {}, visibility, t('不可用附件', 'Unavailable attachment')), available: visibility.available, private: visibility.kind === 'private', fromReference: false, fromAttachment: true, state: visibility.available ? 'attachment' : visibility.kind });
    }
    return [...rows.values()];
  }
  const model = value => ({ provider: text(value?.provider), model: text(value?.model), effort: text(value?.effort) });
  const skills = values => list(values).map((value, index) => ({ key: text(value.id) || String(index), name: text(value.name || value.title || value.id), version: text(value.version) }));
  function latestRun(state, conversation) {
    return list(state.agentRuns).filter(run => run.conversationId === conversation?.id && !run.deletedAt).reduce((latest, run) => !latest || Number(run.startedAt || run.requestedAt || 0) >= Number(latest.startedAt || latest.requestedAt || 0) ? run : latest, null);
  }
  function recentRequest(state, conversation) {
    const run = latestRun(state, conversation); if (!run) return null;
    if (privateItem(run) || privateItem(run.projectId && unique(state.projects, run.projectId))) return { private: true };
    const sent = list(conversation.messages).find(message => message.id === run.userMessageId && !message.deletedAt);
    const message = list(conversation.messages).find(message => message.runId === run.id && !message.deletedAt) || { runId: run.id };
    const cache = new Map();
    const sources = (E()?.sourcesFor(message, run, state) || []).map(source => {
      const visibility = access(state, source);
      if (visibility.kind === 'private') return { sourceId: source.sourceId, runId: run.id, type: source.type, provided: !!source.provided, title: t('私密来源', 'Private source'), private: true, status: { kind: 'private', canOpen: false, notice: t('该来源已设为私密，标题与摘录已隐藏。', 'This source is private. Its title and excerpt are hidden.') } };
      const status = E().status(source, state, cache);
      if (!visibility.available) { status.canOpen = false; status.kind = 'missing'; }
      return { ...source, status, location: E().location(source) };
    });
    const files = list(run.fileReferences).map(raw => {
      const ref = reference(raw), visibility = access(state, ref);
      return { key: refKey(ref), type: ref.type, title: sourceTitle(ref, visibility), private: visibility.kind === 'private', available: visibility.available, version: visibility.kind === 'private' ? '' : ref.version, fromReference: true, fromAttachment: false };
    });
    for (const id of new Set(list(run.attachmentIds))) {
      const existing = files.find(file => file.type === 'import' && file.key === refKey({ type: 'import', id }));
      if (existing) { existing.fromAttachment = true; continue; }
      const visibility = access(state, { type: 'import', id });
      const frozen = list(sent?.attachments).find(attachment => attachment.id === id);
      files.push({ key: refKey({ type: 'import', id }), type: 'import', title: sourceTitle(frozen || {}, visibility, t('附件（未保存名称快照）', 'Attachment (name not recorded)')), private: visibility.kind === 'private', available: visibility.available, fromReference: false, fromAttachment: true });
    }
    const reads = list(run.knowledgeReads).map((read, index) => {
      const source = { type: read.recordType || 'import', id: read.id }, visibility = access(state, source);
      return { key: `${index}:${text(read.id)}`, title: sourceTitle(read, visibility, text(read.id) || t('读取操作', 'Read operation')), type: text(read.type), page: visibility.kind === 'private' ? null : read.page, offset: visibility.kind === 'private' ? null : read.offset, error: visibility.kind === 'private' ? '' : text(read.error), private: visibility.kind === 'private' };
    });
    const history = run.contextMetrics?.history || run.historyCoverage;
    const count = value => Number.isFinite(value) && value >= 0 ? value : null;
    const issue = root.WorkstationCore?.responseIssue?.(message, run, root.AgentTransport?.inspectProtocolOutput?.(message.text || '', { final: true }));
    return { id: run.id, status: issue ? 'failed' : text(run.status), startedAt: run.startedAt || run.requestedAt || null, model: model(run.modelConfig), permission: text(run.permissionMode), skills: skills(run.skillSnapshot), files, sources, reads,
      evidenceLimitReached: !!run.evidenceLimitReached, history: history ? { included: count(history.includedMessages), total: count(history.totalMessages), omitted: count(history.omittedMessages) } : null,
      metrics: { estimatedTokens: count(run.contextMetrics?.estimatedTokens), characters: count(run.contextMetrics?.characters), loadedCapabilities: list(run.contextMetrics?.loadedCapabilities).filter(value => typeof value === 'string'), toolCount: list(run.toolCalls).length } };
  }
  function snapshot(state = {}, conversation, options = {}) {
    const project = conversation?.projectId ? unique(state.projects, conversation.projectId) : null;
    const hidden = !!options.privateMode || privateItem(conversation) || privateItem(project);
    const ownerKey = `${conversation?.id || ''}:${hidden ? 'private' : 'normal'}`;
    if (!conversation || hidden) return { ownerKey, conversationId: conversation?.id || null, private: hidden, empty: !conversation, materials: [], recent: null };
    return { ownerKey, conversationId: conversation.id, private: false, empty: false, model: model(options.model), permission: text(options.permission), skills: skills(options.skills), project: project && active(project) ? text(project.name) : conversation.projectId ? t('项目不可用', 'Project unavailable') : t('未指定项目', 'No project'), workspace: text(conversation.workspace) || t('自动判断', 'Automatic'), materials: selectedMaterials(state, conversation, options.versionChecks),
      history: { messages: list(conversation.messages).filter(value => !value.deletedAt).length, summaryItems: list(conversation.contextSummary?.items).length, summaryAt: conversation.contextSummary?.createdAt || conversation.contextSummary?.updatedAt || null }, recent: recentRequest(state, conversation) };
  }
  function createController(hooks) {
    let ownerKey = '', generation = 0, versionGeneration = 0, error = '', busy = '', view = null, suspended = false, destroyed = false;
    const versions = new Map(), pending = new Map();
    const visible = () => !destroyed && hooks.isVisible?.() !== false;
    const options = () => ({ model: hooks.getModel?.(), skills: hooks.getSkills?.(), permission: hooks.getPermission?.(), privateMode: hooks.isPrivate?.() ?? !!root.PrivateMode?.isOn?.(), versionChecks: new Map([...versions].map(([key, value]) => [key, value.result])) });
    function suspend() {
      if (suspended || destroyed) return;
      suspended = true; versionGeneration++; pending.clear(); versions.clear(); view = null;
      // A hidden panel must not retain source bodies or continue version work.
      // Keep an in-flight durable mutation separate so reopening cannot submit it twice.
      hooks.onHidden?.();
    }
    function publish() { if (!visible()) { suspend(); return; } hooks.onChange?.({ ...view, busy, error }); }
    function refresh() {
      if (!visible()) { suspend(); return null; }
      suspended = false;
      const state = hooks.getState?.() || {}, conversation = hooks.getConversation?.();
      for (const ref of F()?.references(conversation) || []) { const previous = versions.get(refKey(ref)); if (previous && (previous.version !== ref.version || previous.input !== versionInput(state, ref))) versions.delete(refKey(ref)); }
      let next = snapshot(state, conversation, options());
      if (ownerKey !== next.ownerKey) { ownerKey = next.ownerKey; generation++; versionGeneration++; versions.clear(); pending.clear(); error = ''; busy = ''; next = snapshot(state, conversation, options()); }
      if (next.materials.some(row => row.private) || next.recent?.sources?.some(row => row.private)) error = '';
      view = next; publish();
      if (next.private || next.empty) return next;
      const liveKeys = new Set();
      for (const ref of F()?.references(conversation) || []) {
        const key = refKey(ref), input = versionInput(state, ref); liveKeys.add(key);
        if (input === null) { versions.delete(key); pending.delete(key); continue; }
        const signature = { input, version: ref.version };
        const equal = entry => entry?.input === input && entry?.version === ref.version;
        if (equal(versions.get(key)) || equal(pending.get(key))) continue;
        versions.delete(key); pending.set(key, signature); const ticket = versionGeneration;
        Promise.resolve().then(() => {
          if (ticket !== versionGeneration || pending.get(key) !== signature) return;
          if (!visible()) { suspend(); return; }
          return F().libraryRef(state, ref.type, ref.id);
        }).then(current => {
          if (ticket !== versionGeneration || pending.get(key) !== signature) return;
          if (!visible()) { suspend(); return; }
          // Content or permissions may change while SHA-256 is in flight.
          const currentState = hooks.getState?.() || {};
          if (versionInput(currentState, ref) !== input) { pending.delete(key); refresh(); return; }
          versions.set(key, { ...signature, result: { kind: !ref.version ? 'unversioned' : current.version === ref.version ? 'current' : 'changed', version: current.version } }); pending.delete(key); refresh();
        }, () => { if (ticket === versionGeneration && pending.get(key) === signature) { if (!visible()) { suspend(); return; } versions.set(key, { ...signature, result: { kind: 'missing' } }); pending.delete(key); refresh(); } });
      }
      for (const key of versions.keys()) if (!liveKeys.has(key)) versions.delete(key);
      return next;
    }
    async function mutate(command) {
      if (!visible() || busy || !view || view.private || view.empty || command.conversationId !== view.conversationId || hooks.getConversation?.()?.id !== view.conversationId || options().privateMode) return false;
      const row = view.materials.find(value => command.action === 'remove-attachment' ? value.type === 'import' && value.id === command.id : value.fromReference && refKey(value.ref) === refKey(command.ref));
      if (!row || !['remove-reference', 'refresh-reference', 'remove-attachment'].includes(command.action) || command.action === 'refresh-reference' && !row.available) return false;
      const ticket = generation; busy = row.key; error = ''; publish();
      try { if (typeof hooks.mutate !== 'function') throw Error(t('上下文保存尚未连接。', 'Context saving is unavailable.')); const result = await hooks.mutate(command); if (result === false) throw Error(t('未能保存上下文修改，请重试。', 'The context change was not saved. Try again.')); if (ticket === generation) { busy = ''; refresh(); } return true; }
      catch (failure) { if (ticket === generation) { busy = ''; error = failure?.message || String(failure); refresh(); } return false; }
    }
    function preview(row) {
      const state = hooks.getState?.() || {}, conversation = hooks.getConversation?.();
      if (!visible() || conversation?.id !== view?.conversationId || options().privateMode || !access(state, row.ref).available) { refresh(); return false; }
      return hooks.onPreview?.(row.ref);
    }
    function evidence(source, target) {
      const state = hooks.getState?.() || {}, conversation = hooks.getConversation?.();
      if (!visible() || conversation?.id !== view?.conversationId || options().privateMode || access(state, source).kind === 'private' || view?.recent?.id !== source.runId) { refresh(); return false; }
      return hooks.onEvidence?.(source, source.runId, target, view.recent.sources.filter(value => !value.private));
    }
    return { refresh, mutate, preview, evidence, getView: () => ({ ...view, busy, error }), isBusy: () => !!busy, destroy: () => { destroyed = true; generation++; versionGeneration++; pending.clear(); versions.clear(); view = null; } };
  }
  let controller, island, entryIsland, uiHooks, refreshEntry;
  function init(hooks = {}) {
    const host = root.document?.getElementById('contextWorkbench'); if (!host) return false;
    controller?.destroy(); island?.unmount(); entryIsland?.unmount(); island = null; entryIsland = null; uiHooks = hooks;
    let entry = root.document.getElementById('composerContextWorkbench');
    if (!entry) { entry = root.document.createElement('span'); entry.id = 'composerContextWorkbench'; root.document.querySelector('.composer-footer')?.append(entry); }
    let entryKey;
    const visible = () => {
      if (hooks.isVisible) return !!hooks.isVisible();
      // Standalone Kit surfaces have no inspector shell. The app's shell owns
      // the visibility contract; checking it does not measure layout or read sources.
      if (!root.document.getElementById('conversationInspector')) return true;
      const ui = hooks.getState?.()?.ui || {}, route = root.document.body?.dataset?.view;
      return !!ui.inspectorOpen && (ui.inspector || 'context') === 'context' && (!route || route === 'agent');
    };
    refreshEntry = () => {
      if (!root.HalaskaUI?.componentNames?.includes('ContextWorkbenchSurface')) return;
      const ui = hooks.getState?.()?.ui || {};
      const entryProps = { variant: 'ghost', size: 'sm', children: t('上下文', 'Context'), 'aria-label': t('查看对话上下文', 'Inspect conversation context'), 'aria-controls': 'conversationInspector', 'aria-expanded': !!(ui.inspectorOpen && (ui.inspector || 'context') === 'context'), onClick: open };
      const key = JSON.stringify([entryProps.children, entryProps['aria-label'], entryProps['aria-expanded']]);
      if (entryIsland && entryKey === key) return;
      if (entryIsland) entryIsland.update(entryProps); else entryIsland = root.HalaskaUI.mount(entry, 'Button', entryProps);
      entryKey = key;
    };
    controller = createController({ ...hooks, isVisible: visible, onHidden: () => {
      refreshEntry(); island?.unmount(); island = null;
    }, onChange: data => {
      refreshEntry();
      if (!root.HalaskaUI?.componentNames?.includes('ContextWorkbenchSurface')) return;
      const props = { data, onMutate: command => controller.mutate(command), onPreview: row => controller.preview(row), onEvidence: (source, target) => controller.evidence(source, target), onModel: hooks.onModel, onScope: hooks.onScope, onSkills: hooks.onSkills, onAddReference: hooks.onAddReference, onAddAttachment: hooks.onAddAttachment, onCompact: hooks.onCompact };
      if (island) island.update(props); else island = root.HalaskaUI.mount(host, 'ContextWorkbenchSurface', props);
    } });
    refresh(); return true;
  }
  function refresh() { refreshEntry?.(); return controller?.refresh(); }
  function open() { uiHooks?.onOpen?.(); return refresh(); }
  return { init, refresh, open, snapshot, recentRequest, selectedMaterials, inspectVersions, createController, access };
});
