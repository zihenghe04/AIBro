/* Pure, scoped content deletion and recovery for the persistent workspace. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContentLifecycle = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLLECTIONS = Object.freeze({ task: 'tasks', note: 'notes', import: 'imports', paper: 'papers' });
  const LABELS = Object.freeze({ task: '任务', note: '知识', import: '资料', paper: '论文' });
  const SPACES = new Set(['日常', '课程', '科研']);
  const list = value => Array.isArray(value) ? value : [];
  const validId = value => typeof value === 'string' && value.length > 0;
  const key = (type, id) => JSON.stringify([type, id]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const countsFor = entries => entries.reduce((counts, item) => { counts[item.type]++; counts.total++; return counts; }, { total: 0, task: 0, note: 0, import: 0, paper: 0 });
  const sourceIds = item => [...new Set([...list(item?.sourceAttachmentIds), item?.sourceAttachmentId].filter(validId))];
  const titleOf = (type, item) => String(item.title || item.name || item.originalName || `未命名${LABELS[type]}`);
  function validate(state, selections, scope) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('工作站数据无效。');
    if (!Array.isArray(selections)) throw new Error('请选择要移入回收站的内容。');
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('内容删除范围无效。');
    if (scope.workspace != null && !SPACES.has(scope.workspace)) throw new Error('内容删除的空间范围无效。');
    if (scope.projectId != null && typeof scope.projectId !== 'string') throw new Error('内容删除的项目范围无效。');
  }
  function owner(state, item) {
    return item?.projectId ? list(state.projects).find(project => project?.id === item.projectId) : null;
  }
  function workspace(state, item) {
    const value = owner(state, item)?.workspace || item.workspace;
    return SPACES.has(value) ? value : '日常';
  }
  function active(state, item) {
    const project = owner(state, item);
    return !!item && !item.archived && !item.deletedAt && !project?.archived && !project?.deletedAt;
  }
  function descriptor(state, type, item) {
    return { type, id: item.id, title: titleOf(type, item), workspace: workspace(state, item), projectId: item.projectId || null };
  }
  function selectedRecords(state, selections, scope) {
    validate(state, selections, scope);
    const seen = new Set(), entries = [], warnings = [];
    for (const selection of selections) {
      if (!selection || !Object.hasOwn(COLLECTIONS, selection.type) || !validId(selection.id)) {
        warnings.push('已跳过无效的内容选择。'); continue;
      }
      const identity = key(selection.type, selection.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const matches = list(state[COLLECTIONS[selection.type]]).filter(item => item?.id === selection.id);
      if (matches.length !== 1) {
        warnings.push(matches.length ? `内容 ID 重复，已保留 ${selection.id}，请先检查数据。` : `内容 ${selection.id} 已不存在，已跳过。`); continue;
      }
      const item = matches[0];
      if (!active(state, item)) { warnings.push(`「${titleOf(selection.type, item)}」或其项目已归档、已删除，已跳过。`); continue; }
      if ((scope.workspace && workspace(state, item) !== scope.workspace) || (scope.projectId && item.projectId !== scope.projectId)) {
        warnings.push(`「${titleOf(selection.type, item)}」已不在当前范围，已跳过。`); continue;
      }
      entries.push({ ...descriptor(state, selection.type, item), item });
    }
    return { entries, warnings };
  }
  function ownersById(state) {
    const owners = new Map();
    for (const [type, collection] of Object.entries({ ...COLLECTIONS, project: 'projects', conversation: 'conversations', run: 'agentRuns', attachment: 'attachments' })) {
      for (const item of list(state[collection])) if (validId(item?.id)) {
        if (!owners.has(item.id)) owners.set(item.id, new Set());
        owners.get(item.id).add(type === 'attachment' ? 'import' : type);
      }
    }
    return owners;
  }
  const endpointType = (link, side) => {
    const value = link[`${side}Type`];
    return value === 'attachment' ? 'import' : value;
  };
  function affectedLinks(state, selected) {
    const owners = ownersById(state), selectedIds = new Set([...selected].map(value => JSON.parse(value)[1]));
    const removed = [], retained = []; let ambiguous = 0;
    function affected(link, side) {
      const id = link[`${side}Id`], type = endpointType(link, side);
      if (!selectedIds.has(id)) return false;
      if (type) return selected.has(key(type, id));
      const possible = [...(owners.get(id) || [])];
      if (possible.length && possible.every(kind => selected.has(key(kind, id)))) return true;
      ambiguous++; return false;
    }
    for (const link of list(state.links)) {
      if (link && (affected(link, 'source') || affected(link, 'target'))) removed.push(link);
      else retained.push(link);
    }
    return { removed, retained, ambiguous };
  }
  function preview(state, selections, scope = {}) {
    const selected = selectedRecords(state, selections, scope);
    const identities = new Set(selected.entries.map(item => key(item.type, item.id)));
    const deletedImports = new Set(selected.entries.filter(item => item.type === 'import').map(item => item.id));
    const retainedIds = new Set(selected.entries.filter(item => item.type !== 'import').flatMap(item => sourceIds(item.item)).filter(id => !deletedImports.has(id)));
    const retainedSources = [...new Map(list(state.imports).filter(item => active(state, item) && retainedIds.has(item.id)).map(item => [item.id, { id: item.id, name: titleOf('import', item) }])).values()];
    const warnings = [...selected.warnings];
    if (selected.entries.some(item => item.type === 'paper')) warnings.push('论文条目、论文分析笔记和源 PDF 单独管理；未选中的分析笔记与源文件会保留。');
    if (retainedSources.length) warnings.push(`将保留 ${retainedSources.length} 份未选中的来源原件。`);
    if (deletedImports.size) {
      const references = Object.entries(COLLECTIONS).filter(([type]) => type !== 'import').flatMap(([type, collection]) => list(state[collection]).filter(item => item && !identities.has(key(type, item.id)) && sourceIds(item).some(id => deletedImports.has(id))));
      if (references.length) warnings.push('所选资料仍被任务、知识或论文引用；派生内容与来源 ID 会保留，恢复原件后关联可继续使用。');
      warnings.push('资料只移入回收站；本次不删除本机原文件或已保存的附件文件。');
    }
    const links = affectedLinks(state, identities);
    if (links.ambiguous) warnings.push('部分旧关系未标注内容类型，且 ID 被其他内容共用；这些关系会保留以避免误删。');
    return { entries: selected.entries.map(({ item, ...entry }) => entry), counts: countsFor(selected.entries), retainedSources, warnings: [...new Set(warnings)] };
  }
  function remove(original, selections, scope = {}, context = {}) {
    const summary = preview(original, selections, scope);
    const state = clone(original);
    if (!summary.entries.length) return { state, entry: null, removed: [], counts: summary.counts, warnings: summary.warnings };
    const selected = new Set(summary.entries.map(item => key(item.type, item.id)));
    const now = context.now ?? Date.now();
    if (!Number.isFinite(now)) throw new Error('删除时间无效。');
    const id = context.uid ? context.uid('trash') : `trash_${now}_${Math.random().toString(36).slice(2, 12)}`;
    if (!validId(id) || list(state.trash).some(item => item?.id === id)) throw new Error('回收站记录 ID 无效或已存在。');
    const data = { tasks: [], notes: [], imports: [], papers: [], attachments: [], links: [], attachmentMemberships: [] };
    for (const [type, collection] of Object.entries(COLLECTIONS)) {
      data[collection] = list(state[collection]).filter(item => item && selected.has(key(type, item.id)));
      state[collection] = list(state[collection]).filter(item => !item || !selected.has(key(type, item.id)));
    }
    const deletedImports = new Set(data.imports.map(item => item.id));
    data.attachments = list(state.attachments).filter(item => deletedImports.has(item?.id));
    state.attachments = list(state.attachments).filter(item => !deletedImports.has(item?.id));
    for (const conversation of list(state.conversations)) if (Array.isArray(conversation?.attachments)) {
      conversation.attachments.forEach((attachmentId, index) => {
        if (deletedImports.has(attachmentId)) data.attachmentMemberships.push({ conversationId: conversation.id, attachmentId, index });
      });
      conversation.attachments = conversation.attachments.filter(attachmentId => !deletedImports.has(attachmentId));
    }
    const links = affectedLinks(original, selected);
    data.links = clone(links.removed); state.links = clone(links.retained);
    if (Array.isArray(state.lastResults)) state.lastResults = state.lastResults.filter(result => !result || !selected.has(key(result.type, result.id)));
    const entry = { id, type: 'content', title: summary.entries.length === 1 ? summary.entries[0].title : `${summary.entries[0].title} 等 ${summary.entries.length} 项内容`, deletedAt: now, counts: summary.counts, data };
    state.trash = [...list(state.trash), entry];
    return { state, entry, removed: summary.entries, counts: summary.counts, warnings: summary.warnings };
  }
  function endpointAvailable(owners, link, side) {
    const id = link[`${side}Id`], type = endpointType(link, side);
    const available = owners.get(id);
    return !!available && (type ? available.has(type) : available.size === 1);
  }
  function restore(original, trashId) {
    if (!validId(trashId)) throw new Error('回收站记录 ID 无效。');
    const state = clone(original), matches = list(state.trash).filter(item => item?.id === trashId && item.type === 'content');
    if (matches.length !== 1) return { state, entry: null, restored: [], counts: countsFor([]), warnings: ['找不到唯一的内容回收站记录。'] };
    const entry = matches[0], data = entry.data || {}, remainder = { tasks: [], notes: [], imports: [], papers: [], attachments: [], links: [], attachmentMemberships: [] };
    const restored = [], conflicts = new Set(), conflictedIds = new Set(), blockedImports = new Set(), warnings = [];
    for (const [type, collection] of Object.entries(COLLECTIONS)) {
      state[collection] = list(state[collection]);
      for (const item of list(data[collection])) {
        if (!validId(item?.id)) { remainder[collection].push(item); warnings.push('回收站包含无效 ID，已保留该记录。'); continue; }
        if (state[collection].some(current => current?.id === item.id)) {
          remainder[collection].push(item); conflicts.add(key(type, item.id)); conflictedIds.add(item.id); if (type === 'import') blockedImports.add(item.id);
          warnings.push(`「${titleOf(type, item)}」的 ID 已被当前内容使用，未覆盖；原记录仍在回收站。`); continue;
        }
        if (item.projectId && !owner(state, item)) {
          item.projectId = null; item.project = null;
          warnings.push('部分内容的原项目已不存在，已恢复到原空间的未归属内容。');
        } else if (owner(state, item)?.archived || owner(state, item)?.deletedAt) {
          warnings.push('部分内容的原项目已归档或停用；已保留原归属，请先恢复该项目后查看。');
        }
        state[collection].push(item); restored.push(descriptor(state, type, item));
      }
    }
    state.attachments = list(state.attachments);
    for (const attachment of list(data.attachments)) {
      if (!validId(attachment?.id) || blockedImports.has(attachment.id) || !state.imports.some(item => item.id === attachment.id)) { remainder.attachments.push(attachment); continue; }
      const duplicate = state.attachments.find(item => item?.id === attachment.id && item.conversationId === attachment.conversationId);
      if (!duplicate) state.attachments.push(attachment);
      else if (JSON.stringify(duplicate) !== JSON.stringify(attachment)) { remainder.attachments.push(attachment); warnings.push('部分附件元数据已变化，保留当前版本；旧版本仍在回收站。'); }
    }
    for (const membership of list(data.attachmentMemberships).slice().sort((a, b) => (a?.index || 0) - (b?.index || 0))) {
      const conversation = list(state.conversations).find(item => item?.id === membership?.conversationId);
      if (!conversation || blockedImports.has(membership.attachmentId) || !state.imports.some(item => item.id === membership.attachmentId)) { remainder.attachmentMemberships.push(membership); continue; }
      conversation.attachments = list(conversation.attachments);
      if (!conversation.attachments.includes(membership.attachmentId)) conversation.attachments.splice(Math.min(Math.max(0, Number.isInteger(membership.index) ? membership.index : conversation.attachments.length), conversation.attachments.length), 0, membership.attachmentId);
    }
    state.links = list(state.links);
    const restoredOwners = ownersById(state);
    const endpointConflicted = (link, side) => endpointType(link, side) ? conflicts.has(key(endpointType(link, side), link[`${side}Id`])) : conflictedIds.has(link[`${side}Id`]);
    for (const link of list(data.links)) {
      if (!link || endpointConflicted(link, 'source') || endpointConflicted(link, 'target') || !endpointAvailable(restoredOwners, link, 'source') || !endpointAvailable(restoredOwners, link, 'target')) { remainder.links.push(link); continue; }
      const duplicate = state.links.find(current => link.id ? current?.id === link.id : JSON.stringify(current) === JSON.stringify(link));
      if (!duplicate) state.links.push(link);
      else if (JSON.stringify(duplicate) !== JSON.stringify(link)) remainder.links.push(link);
    }
    const pending = Object.values(remainder).some(items => items.length);
    if (pending) {
      entry.data = remainder;
      entry.counts = countsFor(Object.entries(COLLECTIONS).flatMap(([type, collection]) => remainder[collection].map(item => ({ type, id: item?.id }))));
      warnings.push('尚有冲突或关联对象未恢复，相关记录继续保留在回收站，可稍后重试。');
    } else state.trash = state.trash.filter(item => item !== entry);
    return { state, entry: pending ? entry : null, restored, counts: countsFor(restored), warnings: [...new Set(warnings)] };
  }
  return Object.freeze({ preview, remove, restore });
}));
