/* Project deletion shares one ownership/reference contract between Agent and UI. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectLifecycle = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const active = value => value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['deleted', 'archived'].includes(value.status);
  const sources = value => [...new Set([...list(value?.sourceAttachmentIds), value?.sourceAttachmentId].filter(id => typeof id === 'string' && id))];
  const agendaMirror = value => {
    if (value?.kind === '日程') return true;
    try { return JSON.parse(value?.content || '{}')?.format === 'aibro.agenda.v1'; } catch (_) { return false; }
  };
  function membership(project, projects) {
    const unique = typeof project.name === 'string' && !!project.name.trim() && ['日常', '课程', '科研'].includes(project.workspace) &&
      list(projects).filter(item => item?.name === project.name && item?.workspace === project.workspace).length === 1;
    return {
      belongs: entry => !!entry && (entry.projectId ? entry.projectId === project.id : unique && entry.project === project.name && entry.workspace === project.workspace),
      unassigned: entry => !!entry && !entry.projectId && !entry.project
    };
  }
  function sharedImportSnapshot(item) {
    const value = {};
    for (const field of ['projectId', 'project', 'workspace', 'folderPath', 'name', 'originalName', 'updatedAt', 'archived', 'deletedAt']) {
      if (item?.[field] !== undefined) value[field] = item[field];
    }
    return value;
  }
  function routingSnapshot(item) {
    const value = {};
    for (const field of ['projectId', 'project', 'workspace']) if (item?.[field] !== undefined) value[field] = item[field];
    return value;
  }
  function targets(state, rawIds) {
    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    if (!ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('项目删除必须提供有效的项目 ID，单次最多 80 个项目。');
    if (new Set(ids).size !== ids.length) throw new Error('同一计划不能重复删除同一个项目。');
    return ids.map(id => {
      const matches = list(state?.projects).filter(item => item?.id === id);
      if (matches.length !== 1) throw new Error(`找不到唯一的项目：${id}。请重新读取项目列表。`);
      if (!active(matches[0])) throw new Error(`项目「${matches[0].name || id}」已归档、删除或不可用，请先恢复。`);
      return matches[0];
    });
  }
  function selection(state, rawIds, context = {}) {
    const projects = targets(state, rawIds), projectIds = new Set(projects.map(item => item.id));
    const predicates = projects.map(project => membership(project, state.projects));
    const belongs = entry => predicates.some(predicate => predicate.belongs(entry));
    const unassigned = entry => entry && !entry.projectId && !entry.project;
    const ownedConversations = list(state.conversations).filter(belongs), conversationIds = new Set(ownedConversations.map(item => item.id));
    const ownedRuns = list(state.agentRuns).filter(run => belongs(run) || conversationIds.has(run.conversationId));
    const runIds = new Set(ownedRuns.map(item => item.id));
    const conversations = ownedConversations.filter(item => item.id !== context.conversationId);
    // All history of the receipt conversation remains inspectable, not only
    // its current run. Its attachments are not external sharing references.
    const runs = ownedRuns.filter(item => item.id !== context.runId && item.conversationId !== context.conversationId);
    const tasks = list(state.tasks).filter(item => belongs(item) || unassigned(item) && (runIds.has(item.agentRunId) || conversationIds.has(item.sourceConversationId)));
    const candidateNotes = list(state.notes).filter(item => belongs(item) || unassigned(item) && runIds.has(item.agentRunId));
    const notes = candidateNotes.filter(item => !agendaMirror(item));
    const agendaMirrors = candidateNotes.filter(agendaMirror);
    const papers = list(state.papers).filter(belongs);
    const taskIds = new Set(tasks.map(item => item.id)), noteIds = new Set(notes.map(item => item.id)), paperIds = new Set(papers.map(item => item.id));
    const conversationImportIds = new Set(ownedConversations.flatMap(item => list(item.attachments)));
    const retainedConversations = list(state.conversations).filter(item => !conversationIds.has(item.id));
    const retainedEntities = [
      ...list(state.projects).filter(item => !projectIds.has(item.id)), ...retainedConversations,
      ...list(state.tasks).filter(item => !taskIds.has(item.id)), ...list(state.notes).filter(item => !noteIds.has(item.id)),
      ...list(state.papers).filter(item => !paperIds.has(item.id))
    ];
    const retainedSources = new Set(retainedConversations.flatMap(item => list(item.attachments)));
    retainedEntities.forEach(item => sources(item).forEach(id => retainedSources.add(id)));
    const retainedEntityIds = new Set(retainedEntities.map(item => item.id)), existingImportIds = new Set(list(state.imports).map(item => item.id));
    list(state.links).forEach(link => {
      if (retainedEntityIds.has(link.sourceId) && existingImportIds.has(link.targetId)) retainedSources.add(link.targetId);
      if (retainedEntityIds.has(link.targetId) && existingImportIds.has(link.sourceId)) retainedSources.add(link.sourceId);
    });
    const candidateImports = list(state.imports).filter(item => belongs(item) || unassigned(item) && conversationImportIds.has(item.id));
    const imports = candidateImports.filter(item => !retainedSources.has(item.id));
    const sharedImports = candidateImports.filter(item => belongs(item) && retainedSources.has(item.id));
    const importIds = new Set(imports.map(item => item.id));
    const attachments = list(state.attachments).filter(item => importIds.has(item.id) || conversationIds.has(item.conversationId) && item.conversationId !== context.conversationId && !existingImportIds.has(item.id));
    const deletedIds = new Set([...projectIds, ...conversations.map(item => item.id), ...runs.map(item => item.id), ...taskIds, ...noteIds, ...paperIds, ...importIds]);
    const selectedTypes = new Set();
    for (const [type, rows] of Object.entries({ project: projects, conversation: conversations, task: tasks, note: notes, paper: papers, import: imports, run: runs })) rows.forEach(item => selectedTypes.add(JSON.stringify([type, item.id])));
    const owners = new Map();
    for (const [type, rows] of Object.entries({ project: list(state.projects), conversation: list(state.conversations), task: list(state.tasks), note: list(state.notes), paper: list(state.papers), import: list(state.imports), run: list(state.agentRuns) })) for (const item of rows) {
      if (!owners.has(item.id)) owners.set(item.id, new Set()); owners.get(item.id).add(type);
    }
    const affectedEndpoint = (link, side) => {
      const id = link[`${side}Id`], type = link[`${side}Type`] === 'attachment' ? 'import' : link[`${side}Type`];
      if (!deletedIds.has(id)) return false;
      return type ? selectedTypes.has(JSON.stringify([type, id])) : [...(owners.get(id) || [])].every(owner => selectedTypes.has(JSON.stringify([owner, id])));
    };
    const links = list(state.links).filter(link => affectedEndpoint(link, 'source') || affectedEndpoint(link, 'target'));
    const records = { projects, conversations, tasks, notes, papers, imports, attachments, runs, links };
    // A duplicate entity ID in a cascade is not a unique target. Attachment
    // IDs can repeat across conversations, but each membership must be unique.
    for (const [collection, rows] of Object.entries(records)) {
      const seen = new Set();
      for (const row of rows) {
        const identity = collection === 'attachments' ? JSON.stringify([row.id, row.conversationId || null]) : row.id;
        if (typeof row.id !== 'string' || !row.id || seen.has(identity)) throw new Error('项目包含重复或无效的记录 ID，请先检查数据再删除。');
        seen.add(identity);
      }
    }
    return { projects, projectIds, belongs, ownedConversations, ownedRuns, candidateImports, retainedEntities, records, sharedImports, agendaMirrors, importIds, deletedIds, selectedTypes };
  }
  function summary(selected, context = {}) {
    const counts = Object.fromEntries(Object.entries(selected.records).map(([key, rows]) => [key === 'runs' ? 'agentRuns' : key, rows.length]));
    return {
      projectIds: [...selected.projectIds], projects: selected.projects.map(item => ({ id: item.id, name: item.name, workspace: item.workspace })), counts,
      sharedImportsRetained: selected.sharedImports.length, agendaMirrorsRetained: selected.agendaMirrors.length,
      preservedConversationId: selected.ownedConversations.some(item => item.id === context.conversationId) ? context.conversationId : null,
      preservedRunId: selected.ownedRuns.some(item => item.id === context.runId) ? context.runId : null,
      warnings: ['项目及其所属内容移入回收站，可恢复；本机原文件不会被删除。',
        ...(selected.sharedImports.length ? ['其他内容仍引用的原件保留到待归类。'] : []),
        ...(selected.agendaMirrors.length ? ['独立日程保留；删除项目不会修改或删除真实日程。'] : [])]
    };
  }
  function preview(state, projectIds, context = {}) { return summary(selection(state, projectIds, context), context); }
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  };
  const sorted = rows => rows.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  function stamp(value) {
    const text = JSON.stringify(canonical(value)); let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); a = Math.imul(a ^ code, 0x01000193) >>> 0; b = Math.imul(b ^ code, 0x85ebca6b) >>> 0; }
    return `project-v1-${text.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;
  }
  function snapshot(state, projectId) {
    const selected = selection(state, projectId), candidateIds = new Set(selected.candidateImports.map(item => item.id));
    const data = {};
    for (const [key, rows] of Object.entries(selected.records)) {
      if (key === 'conversations') data[key] = sorted(rows.map(item => ({ id: item.id, ...routingSnapshot(item), attachments: list(item.attachments) })));
      else if (key === 'runs') data[key] = sorted(rows.map(item => ({ id: item.id, ...routingSnapshot(item), conversationId: item.conversationId })));
      else data[key] = sorted(rows);
    }
    data.sharedImports = sorted(selected.sharedImports);
    data.agendaMirrors = sorted(selected.agendaMirrors);
    data.externalReferences = sorted(selected.retainedEntities.filter(item => sources(item).some(id => candidateIds.has(id)) || list(item.attachments).some(id => candidateIds.has(id))).map(item => ({ id: item.id, ...routingSnapshot(item), sourceAttachmentIds: sources(item), attachments: list(item.attachments) })));
    data.sourceLinks = sorted(list(state.links).filter(link => candidateIds.has(link.sourceId) || candidateIds.has(link.targetId)));
    return stamp(data);
  }
  function remove(original, projectIds, context = {}) {
    const state = clone(original), selected = selection(state, projectIds, context), result = summary(selected, context);
    const now = context.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error('删除时间无效。');
    let serial = 0;
    const uid = prefix => context.uid ? context.uid(prefix) : `${prefix}_${now}_${++serial}_${Math.random().toString(36).slice(2, 10)}`;
    const trashId = uid('trash');
    if (typeof trashId !== 'string' || !trashId || list(state.trash).some(item => item?.id === trashId)) throw new Error('回收站记录 ID 无效或已存在。');
    const sharedImportMoves = selected.sharedImports.map(item => {
      const before = sharedImportSnapshot(item), ownerProjectId = item.projectId || selected.projects.find(project => membership(project, state.projects).belongs(item))?.id;
      item.projectId = null; item.project = null; item.updatedAt = now;
      return { id: item.id, ownerProjectId, before, after: sharedImportSnapshot(item), projectLinkIds: list(state.links).filter(link => link.sourceId === ownerProjectId && link.targetId === item.id || link.targetId === ownerProjectId && link.sourceId === item.id).map(link => link.id) };
    });
    const sharedRecordMoves = [];
    for (const [collection, rows] of [['notes', selected.agendaMirrors], ['conversations', selected.ownedConversations.filter(item => item.id === context.conversationId)], ['agentRuns', selected.ownedRuns.filter(item => item.id === context.runId || item.conversationId === context.conversationId)]]) {
      for (const item of rows) {
        const before = routingSnapshot(item), ownerProjectId = item.projectId || selected.projects.find(project => membership(project, state.projects).belongs(item))?.id;
        // Unassigned records need no restoration record; native calendar
        // projections and the receipt conversation keep their full live data.
        if (!selected.projectIds.has(ownerProjectId)) continue;
        item.projectId = null; item.project = null;
        sharedRecordMoves.push({ collection, id: item.id, ownerProjectId, before, after: routingSnapshot(item), projectLinkIds: list(state.links).filter(link => link.sourceId === ownerProjectId && link.targetId === item.id || link.targetId === ownerProjectId && link.sourceId === item.id).map(link => link.id) });
      }
    }
    const data = { ...selected.records, sharedImportMoves, sharedRecordMoves };
    const entry = { id: trashId, type: 'project', title: selected.projects.length === 1 ? selected.projects[0].name || '未命名项目' : `${selected.projects[0].name || '未命名项目'} 等 ${selected.projects.length} 个项目`, deletedAt: now, counts: result.counts, data };
    state.trash = [...list(state.trash), entry];
    for (const [key, rows] of Object.entries(selected.records)) {
      const target = key === 'runs' ? 'agentRuns' : key;
      const removed = new Set(rows);
      state[target] = list(state[target]).filter(item => !removed.has(item));
    }
    for (const conversation of list(state.conversations)) if (Array.isArray(conversation.attachments)) conversation.attachments = conversation.attachments.filter(id => !selected.importIds.has(id));
    if (!state.conversations.some(item => item.id === state.currentConversationId)) {
      if (!state.conversations.length) state.conversations.push({ id: uid('conv'), title: '新对话', messages: [], attachments: [], workspace: 'auto', projectId: null, createdAt: now, updatedAt: now });
      state.currentConversationId = state.conversations[state.conversations.length - 1].id;
    }
    if (selected.projectIds.has(state.currentProjectId)) state.currentProjectId = null;
    if (Array.isArray(state.lastResults)) state.lastResults = state.lastResults.filter(item => !selected.selectedTypes.has(JSON.stringify([item?.type === 'attachment' ? 'import' : item?.type, item?.id])));
    return { state, entry, summary: result };
  }
  // Called after restored projects have been inserted. Only routing metadata
  // is restored: ongoing replies, edited messages and native event text never
  // get overwritten by a pre-deletion copy.
  function restoreRoutingMoves(state, entry) {
    const skippedProjectLinks = new Set(), missingRecordIds = new Set();
    for (const move of list(entry?.data?.sharedRecordMoves)) {
      if (!['notes', 'conversations', 'agentRuns'].includes(move?.collection) || !state.projects.some(project => project.id === move.ownerProjectId)) continue;
      const records = list(state[move.collection]).filter(item => item.id === move.id);
      if (records.length !== 1 || JSON.stringify(routingSnapshot(records[0])) !== JSON.stringify(move.after)) {
        list(move.projectLinkIds).forEach(id => skippedProjectLinks.add(id));
        if (!records.length) missingRecordIds.add(move.id);
        continue;
      }
      const item = records[0];
      for (const field of Object.keys(routingSnapshot(item))) if (!Object.hasOwn(move.before, field)) delete item[field];
      Object.assign(item, move.before);
    }
    return { skippedProjectLinks: [...skippedProjectLinks], missingRecordIds: [...missingRecordIds] };
  }
  return Object.freeze({ membership, sharedImportSnapshot, routingSnapshot, preview, snapshot, remove, restoreRoutingMoves });
}));
