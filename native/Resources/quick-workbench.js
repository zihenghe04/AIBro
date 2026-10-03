/* The floating workbench projects the existing workspace and delegates every
 * write to its task rules and durable saver. It owns no second task/run store. */
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const active = value => !!value && !value.deleted && !value.deletedAt && !value.archived && !value.archivedAt && !['deleted', 'archived'].includes(value.status);
  const identifier = /^quick_task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const lifecycleIdentifier = /^quick_task_delete_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const batchIdentifier = /^quick_task_batch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let pendingWorkflowNames = null;
  const requests = new Map(), taskLocks = new Map(), pendingStatuses = new Map(), versionCache = new WeakMap(), protocolCache = new WeakMap();
  const core = () => window.WorkstationCore || (typeof Core !== 'undefined' ? Core : null);
  const t = (zh, en) => window.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(document.documentElement?.lang || '') ? en : zh;
  const fail = (reason, deferred = false) => ({ status: deferred ? 'deferred' : 'error', reason });
  function readiness() {
    if (typeof storageHydrated === 'undefined' || !storageHydrated) return fail('hydrating', true);
    if (typeof state === 'undefined' || !Array.isArray(state.tasks) || !Array.isArray(state.agentRuns) || !object(state.ui) || !window.CitationEvidence?.createAccessContext) return fail('unavailable', true);
    if (window.PrivateMode?.isOn?.()) return fail('private', true);
    if (typeof serverConflict !== 'undefined' && serverConflict) return fail('conflict', true);
    if (typeof purgeTrash !== 'undefined' && purgeTrash.syncPaused) return fail('busy', true);
    return null;
  }
  function taskAccess(id, owner = state, context = window.CitationEvidence.createAccessContext(owner)) {
    const matches = list(owner.tasks).filter(task => task?.id === id);
    if (matches.length > 1) return { failure: fail('collision') };
    const task = matches[0];
    if (!active(task)) return { failure: fail('removed') };
    const visibility = context.access({ type: 'task', id });
    if (visibility.kind === 'private') return { failure: fail('private') };
    if (!visibility.available || context.isAmbiguous({ type: 'task', id })) return { failure: fail('removed') };
    return { task };
  }
  function runIndex() {
    const index = values => { const result = new Map(); for (const value of list(values)) { if (!value?.id) continue; const found = result.get(value.id) || []; found.push(value); result.set(value.id, found); } return result; };
    const retiredRuns = new Set(), retiredConversations = new Set();
    for (const entry of list(state.trash)) {
      for (const value of [...list(entry?.data?.runs), ...list(entry?.data?.agentRuns)]) if (value?.id) retiredRuns.add(value.id);
      for (const value of list(entry?.data?.conversations)) if (value?.id) retiredConversations.add(value.id);
    }
    const messages = new Map();
    for (const conversation of list(state.conversations)) {
      const byRun = new Map();
      for (const message of list(conversation?.messages)) {
        const id = message?.runId || message?.pendingRunId || message?.retryRunId;
        if (id && message.role !== 'user' && !byRun.has(id)) byRun.set(id, message);
      }
      messages.set(conversation.id, byRun);
    }
    return { runs: index(state.agentRuns), conversations: index(state.conversations), projects: index(state.projects), messages, retiredRuns, retiredConversations };
  }
  function runAccess(id, context = window.CitationEvidence.createAccessContext(state), index = runIndex()) {
    const matches = index.runs.get(id) || [];
    if (matches.length !== 1 || !active(matches[0])) return null;
    const run = matches[0], conversations = index.conversations.get(run.conversationId) || [];
    if (conversations.length !== 1 || !active(conversations[0])) return null;
    // The evidence access graph resolves run/conversation/project ancestry,
    // including retired private owners; this is a privacy query, not a file read.
    if (context.access({ runId: id }).kind === 'private') return null;
    if (index.retiredRuns.has(id) || index.retiredConversations.has(run.conversationId)) return null;
    for (const projectID of [run.projectId, conversations[0].projectId].filter(Boolean)) {
      const owners = index.projects.get(projectID) || [];
      if (owners.length !== 1 || !active(owners[0])) return null;
    }
    return { run, conversation: conversations[0] };
  }
  const canCancel = run => typeof activeRunId !== 'undefined' && run.id === activeRunId && typeof sendMessage !== 'undefined' && !!sendMessage.busy && run.status === 'running' && typeof stopCurrentRun === 'function' && !(typeof activeRunController !== 'undefined' && activeRunController?.signal?.aborted);
  function version(task) {
    // The 500 ms projection does not repeatedly hash long descriptions. Scalar
    // strings compare by identity/value; mutable nested task fields compare by
    // exact serialization, so in-place checklist changes still invalidate.
    const keys = Object.keys(task), prior = versionCache.get(task), fields = keys.map(key => {
      const value = task[key]; return [key, typeof value, value && typeof value === 'object' ? JSON.stringify(value) : value];
    });
    if (prior && prior.fields.length === fields.length && fields.every((entry, index) => entry[0] === prior.fields[index][0] && entry[1] === prior.fields[index][1] && Object.is(entry[2], prior.fields[index][2]))) return prior.value;
    const value = core()?.contentStamp?.(JSON.stringify(task)) || JSON.stringify([task.id, task.status, task.completedAt, task.updatedAt]);
    versionCache.set(task, { fields, value }); return value;
  }
  function dueLabel(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value); return Number.isFinite(+date) ? date.toLocaleString() : '';
  }
  function deadlineOrder(value) {
    const parsed = window.PlanningWorkbench?.parseDate(value); if (!parsed) return Infinity;
    if (!parsed.dateOnly) return parsed.timestamp;
    // AI Bro also supports all-day deadlines: that day remains actionable
    // until the next local midnight, including daylight-saving transitions.
    const day = new Date(parsed.timestamp); day.setDate(day.getDate() + 1); return +day;
  }
  function runStatus(run, index) {
    const receipt = run.executionReceipt;
    if (run.approvalReceipt?.savePending) return 'awaiting-save';
    if (!run.approvalReceipt && receipt?.version === 1 && ['prepared', 'applied'].includes(receipt.phase) && run.status !== 'rejected') {
      if (receipt.phase === 'applied') return 'awaiting-save';
      return ['running', 'awaiting-approval'].includes(run.status) ? run.status : 'interrupted';
    }
    const message = index.messages.get(run.conversationId)?.get(run.id);
    if (message && !message.live && ['completed', 'completed-local', 'completed-local-fallback'].includes(run.status)) {
      const inspect = window.AgentTransport?.inspectProtocolOutput, previous = protocolCache.get(message);
      let protocol = previous?.result;
      if (!previous || previous.text !== message.text || previous.inspect !== inspect) {
        protocol = inspect?.(message.text || '', { final: true });
        protocolCache.set(message, { text: message.text, inspect, result: protocol });
      }
      if (core()?.responseIssue?.(message, run, protocol)) return 'failed';
    }
    if (['completed', 'completed-local', 'completed-local-fallback'].includes(run.status)
      && window.AgendaProposals?.hasPending?.(run)) return 'awaiting-approval';
    return run.status || 'unknown';
  }
  function voiceRunProjection(run, conversation, status, notificationReady) {
    const marker = conversation.quickVoiceRequest;
    if (marker?.version !== 1 || marker.phase !== 'accepted' || typeof marker.requestId !== 'string'
      || !/^[a-zA-Z0-9_-]{8,160}$/.test(marker.requestId) || marker.runId !== run.id || marker.userMessageId !== run.userMessageId) return {};
    const visible = message => active(message) && !message.private && !message.ephemeral && !message.incognito
      && !message.hidden && !message.internal && !['analysis', 'reasoning', 'tool'].includes(message.channel);
    const users = list(conversation.messages).filter(message => message?.id === run.userMessageId);
    const user = users.length === 1 ? users[0] : null;
    if (!user || user.role !== 'user' || !visible(user) || user.quickVoiceRequestId !== marker.requestId) return {};
    // This is a small UI excerpt, not a second transcript or a truncation of
    // the saved source. Never attach ordinary chat, tool or reasoning bodies.
    const excerpt = (value, limit) => {
      if (typeof value !== 'string') return '';
      const text = value.trimStart(), clipped = text.length > limit;
      let head = text.slice(0, clipped ? limit - 1 : limit);
      if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
      return head.trimEnd() + (clipped ? '…' : '');
    };
    const result = { conversationId: conversation.id, userMessageId: user.id, voiceRequestId: marker.requestId,
      voiceTranscript: excerpt(user.text, 1000) };
    const receipt = run.executionReceipt;
    const agendaReview = status === 'awaiting-approval' && window.AgendaProposals?.hasPending?.(run)
      && ['completed', 'completed-local', 'completed-local-fallback'].includes(run.status);
    if (!agendaReview && !['completed', 'completed-local', 'completed-local-fallback'].includes(status)) return result;
    const unconfirmed = () => ({ ...result, status: 'interrupted', statusLabel: t('完成状态待确认', 'Completion unconfirmed'), notificationReady: false, isActive: false });
    if ((!notificationReady && !agendaReview) || receipt?.version !== 1 || receipt.phase !== 'committed' || run.approvalReceipt?.savePending || run.approvalSaveError) return unconfirmed();
    const messages = list(conversation.messages).filter(message => message?.id === receipt.messageId);
    const answer = messages.length === 1 ? messages[0] : null;
    if (!answer || !['agent', 'assistant'].includes(answer.role) || !visible(answer) || answer.live || answer.runId !== run.id) return unconfirmed();
    const inspect = window.AgentTransport?.inspectProtocolOutput, previous = protocolCache.get(answer);
    let protocol = previous?.result;
    if (!previous || previous.text !== answer.text || previous.inspect !== inspect) {
      protocol = inspect?.(answer.text || '', { final: true });
      protocolCache.set(answer, { text: answer.text, inspect, result: protocol });
    }
    if (core()?.responseIssue?.(answer, run, protocol)) return { ...result, status: 'failed', statusLabel: t('未完成', 'Failed'), notificationReady: false, isActive: false };
    // Final answer excerpt only. It is not evidence that a proposed task or
    // calendar event was saved; those need their own durable result identity.
    const text = (!agendaReview && window.AgendaProposals?.settledSummary?.(run)) || (window.RunOutcomePresentation?.settledApprovalText?.(answer, run,
      { language: window.WorkstationI18n?.getLanguage?.() || 'zh' }) ?? answer.text);
    const summary = excerpt(text, 600);
    if (summary) result.resultSummary = summary;
    return result;
  }
  function snapshot() {
    const blocked = readiness();
    if (blocked) return { version: 1, ...blocked, tasks: [], runs: [], projects: [], taskCount: 0, runCount: 0 };
    const context = window.CitationEvidence.createAccessContext(state);
    const projects = new Map(list(state.projects).map(project => [project.id, project])), index = runIndex();
    const tasks = list(state.tasks).filter(task => task && context.access({ type: 'task', id: task.id }).record === task && !context.isAmbiguous({ type: 'task', id: task.id })).map(task => {
      const pending = pendingStatuses.get(task.id), effectiveStatus = pending?.task === task ? pending.before.status.value : task.status;
      return { id: task.id, title: String(task.title || t('未命名任务', 'Untitled task')), projectTitle: String(projects.get(task.projectId)?.name || ''),
        workspace: task.workspace || '日常', projectId: task.projectId || null, dueAt: task.dueAt ?? null, createdAt: Number.isFinite(task.createdAt) ? task.createdAt : null,
        workflowCategory: window.TaskWorkflow?.category(task) ?? null,
        dueLabel: dueLabel(task.dueAt), isCompleted: effectiveStatus === 'done', version: version(task), isSaving: taskLocks.has(task.id) };
    }).sort((a, b) => Number(a.isCompleted) - Number(b.isCompleted) || deadlineOrder(a.dueAt) - deadlineOrder(b.dueAt) || (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || a.id.localeCompare(b.id));
    const runs = list(state.agentRuns).flatMap(run => {
      const found = run?.id && runAccess(run.id, context, index); if (!found) return [];
      const status = runStatus(run, index);
      const labels = { running: ['执行中', 'Running'], 'awaiting-approval': ['等待审批', 'Awaiting approval'], 'awaiting-save': ['等待保存', 'Awaiting save'], 'awaiting-input': ['等待补充', 'Awaiting input'], completed: ['已完成', 'Completed'], 'completed-local': ['已完成', 'Completed'], 'completed-local-fallback': ['已完成', 'Completed'], failed: ['未完成', 'Failed'], cancelled: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'], rejected: ['已拒绝', 'Rejected'] };
      const words = labels[status] || ['状态未记录', 'Status unavailable'];
      const message = index.messages.get(run.conversationId)?.get(run.id);
      const finishedAt = [run.finishedAt, run.completedAt].find(value => Number.isFinite(value) && value > 0) ?? null;
      // A raw completed flag can precede the final message or its save receipt.
      // Expose the normalized machine state, never infer success from a label.
      const terminal = ['completed', 'completed-local', 'completed-local-fallback', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(status);
      const notificationReady = terminal && finishedAt !== null && !!message && !message.live;
      const calls = list(run.toolCalls), finished = calls.filter(call => ['completed', 'failed', 'cancelled', 'interrupted'].includes(call?.status)).length;
      return [{ id: run.id, status, finishedAt, notificationReady, title: String(found.conversation.title || t('Agent 执行', 'Agent run')), statusLabel: t(...words),
        detail: calls.length ? t(`${finished} / ${calls.length} 项操作已结束`, `${finished} / ${calls.length} operations finished`) : '',
        isActive: ['running', 'awaiting-approval', 'awaiting-save', 'awaiting-input'].includes(status), canCancel: canCancel(run), startedAt: Number(run.startedAt || run.requestedAt) || 0,
        ...voiceRunProjection(run, found.conversation, status, notificationReady) }];
    }).sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.startedAt - a.startedAt);
    const choices = list(state.projects).filter(project => {
      const ref = { type: 'local', projectId: project?.id, candidateId: project?.localFolder?.id };
      return active(project) && ['日常', '课程', '科研'].includes(project.workspace) && context.access(ref).available && !context.isAmbiguous(ref);
    }).map(project => ({ id: project.id, title: String(project.name || t('未命名项目', 'Untitled project')), workspace: project.workspace }));
    return { version: 1, status: 'ready', tasks, runs, projects: choices, workflowNames: pendingWorkflowNames?.owner === state ? pendingWorkflowNames.names : window.TaskWorkflow?.names(state), workflowVersion: pendingWorkflowNames?.owner === state ? pendingWorkflowNames.version : window.TaskWorkflow?.version(state), taskCount: tasks.filter(task => !task.isCompleted).length, runCount: runs.filter(run => run.isActive).length };
  }
  async function fingerprint(payload) {
    if (!window.crypto?.subtle?.digest) throw Error('unavailable');
    const values = own(payload, 'workflowCategory')
      ? ['v4-workflow', payload.title, payload.workspace, payload.projectId, payload.dueAt, payload.workflowCategory, payload.priority ?? null, payload.sourceTaskInbox ?? null]
      : own(payload, 'sourceTaskInbox')
      ? ['v3-inbox', payload.title, payload.workspace, payload.projectId, payload.dueAt, payload.priority, payload.sourceTaskInbox.id, payload.sourceTaskInbox.category]
      : own(payload, 'workspace') ? ['v2', payload.title, payload.workspace, payload.projectId, payload.dueAt] : [payload.title];
    const bytes = new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values))));
    return 'sha256:' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function creationReceipt(id, hash) {
    const ledger = own(state.ui, 'nativeQuickTaskReceipts') ? state.ui.nativeQuickTaskReceipts : {};
    if (!object(ledger)) return { failure: fail('unavailable') };
    if (own(ledger, id) && ledger[id] !== hash) return { failure: fail('collision') };
    const matches = list(state.tasks).filter(task => task?.id === id);
    const retired = list(state.trash).flatMap(entry => list(entry?.data?.tasks)).filter(task => task?.id === id);
    if (matches.length + retired.length > 1) return { failure: fail('collision') };
    if (!matches.length) return retired.length || own(ledger, id) ? { failure: fail('removed') } : { missing: true };
    const task = matches[0];
    if (task.sourceQuickTaskId !== id) return { failure: fail('collision') };
    if (task.quickTaskFingerprint !== hash) return { failure: fail('changed') };
    return taskAccess(id);
  }
  function committedTasks(owner, task, previousProjectId = task.projectId) {
    // Internal UI invalidation only. A projection is never a storage receipt;
    // publish only after the command's durable ACK and ownership checks.
    if (state !== owner) return;
    try {
      document.dispatchEvent(new CustomEvent('records-committed', { detail: {
        source: 'native-quick-workbench', owner, collection: 'tasks', ids: [task.id],
        projectIds: [...new Set([previousProjectId, task.projectId].filter(Boolean))]
      } }));
    } catch (_) { /* A display failure cannot revoke an acknowledged write. */ }
  }
  async function createTask(payload) {
    if (!window.PlanningWorkbench?.planCreate || typeof saveDocumentDurably !== 'function') return fail('unavailable');
    let hash; try { hash = await fingerprint(payload); } catch (_) { return fail('unavailable'); }
    const blocked = readiness(); if (blocked) return blocked;
    const owner = state;
    const prior = creationReceipt(payload.id, hash); if (prior.failure) return prior.failure;
    if (prior.missing) {
      let task;
      try { validateTarget(payload); task = window.PlanningWorkbench.planCreate(state, { title: payload.title, workspace: payload.workspace || '日常', projectId: payload.projectId || null, dueAt: payload.dueAt ?? null, priority: payload.priority || 'medium', status: 'todo' }, { uid: () => payload.id }); }
      catch (_) { return fail('invalid'); }
      if (own(payload, 'workflowCategory')) task.workflowCategory = payload.workflowCategory;
      task.sourceQuickTaskId = payload.id; task.quickTaskFingerprint = hash;
      if (payload.sourceTaskInbox) task.sourceTaskInbox = { ...payload.sourceTaskInbox };
      state.tasks.push(task);
    }
    (state.ui.nativeQuickTaskReceipts ||= {})[payload.id] = hash;
    try { if (await saveDocumentDurably() !== true) return fail('storage_failed'); } catch (_) { return fail('storage_failed'); }
    const settled = readiness(); if (settled) return settled;
    const current = creationReceipt(payload.id, hash);
    if (current.failure) return current.failure;
    if (current.missing || state.ui.nativeQuickTaskReceipts?.[payload.id] !== hash) return fail('changed');
    committedTasks(owner, current.task);
    return { status: 'saved', id: payload.id, ...(payload.sourceTaskInbox ? { alreadyExists: !prior.missing } : {}) };
  }
  const field = (item, key) => ({ present: own(item, key), value: item[key] });
  const equalField = (item, key, value) => own(item, key) === value.present && item[key] === value.value;
  function validateTarget(input) {
    const workspace = input.workspace || '日常';
    if (!['日常', '课程', '科研'].includes(workspace)) throw Error('invalid');
    if (input.projectId) {
      const matches = list(state.projects).filter(project => project?.id === input.projectId);
      const project = matches[0], context = window.CitationEvidence.createAccessContext(state);
      const ref = { type: 'local', projectId: input.projectId, candidateId: project?.localFolder?.id };
      if (matches.length !== 1 || !active(project) || project.workspace !== workspace || !context.access(ref).available || context.isAmbiguous(ref)) throw Error('invalid');
    }
    const due = input.dueAt;
    if (due !== null && due !== undefined && (typeof due !== 'string' && typeof due !== 'number' || !window.PlanningWorkbench.parseDate(due))) throw Error('invalid');
    if (typeof due === 'string' && due.length !== 10 && !/(?:Z|[+-]\d{2}:\d{2})$/.test(due)) throw Error('invalid');
  }
  async function updateTask(payload) {
    if (!core()?.applyPlan || !window.PlanningWorkbench?.planMove || typeof saveDocumentDurably !== 'function') return fail('unavailable');
    const owner = state, found = taskAccess(payload.id); if (found.failure) return found.failure;
    const task = found.task; if (version(task) !== payload.expectedVersion) return fail('changed');
    const patch = payload.patch, target = { workspace: patch.workspace ?? task.workspace, projectId: own(patch, 'projectId') ? patch.projectId : task.projectId, dueAt: own(patch, 'dueAt') ? patch.dueAt : task.dueAt };
    let candidate;
    try {
      validateTarget(target);
      const edit = Object.fromEntries(['title', 'dueAt'].filter(key => own(patch, key)).map(key => [key, patch[key]]));
      const scope = { workspace: task.workspace, projectId: task.projectId || null, allowedTaskIds: [task.id] };
      const result = core().applyPlan(owner, [{ type: 'update_task', taskId: task.id, patch: edit }], scope);
      candidate = result.state.tasks.find(value => value.id === task.id);
      const move = window.PlanningWorkbench.planMove(result.state, [task.id], target, { scope });
      if (move.updates[0]) Object.assign(candidate, move.updates[0].patch);
      if (!candidate) throw Error('invalid');
      if (own(patch, 'workflowCategory')) candidate.workflowCategory = patch.workflowCategory;
    } catch (_) { return fail('invalid'); }
    const keys = ['title', 'dueAt', 'workspace', 'projectId', 'project', 'updatedAt', 'workflowCategory'];
    const before = Object.fromEntries(keys.map(key => [key, field(task, key)]));
    const after = Object.fromEntries(keys.map(key => [key, field(candidate, key)]));
    for (const key of keys) { if (after[key].present) task[key] = after[key].value; else delete task[key]; }
    try { if (await saveDocumentDurably() !== true) throw Error('storage_failed'); }
    catch (_) {
      if (state === owner && list(owner.tasks).includes(task)) {
        const intact = keys.every(key => equalField(task, key, after[key]));
        const route = ['workspace', 'projectId', 'project'], routeIntact = route.every(key => equalField(task, key, after[key]));
        for (const key of keys) {
          if ((route.includes(key) ? routeIntact : key === 'updatedAt' ? intact : equalField(task, key, after[key]))) {
            if (before[key].present) task[key] = before[key].value; else delete task[key];
          }
        }
      }
      return fail('storage_failed');
    }
    if (state !== owner) return fail('changed');
    const settled = readiness(); if (settled) return settled;
    const current = taskAccess(payload.id); if (current.failure) return current.failure;
    if (current.task !== task || !keys.filter(key => key !== 'updatedAt').every(key => equalField(current.task, key, after[key]))) return fail('changed');
    try { validateTarget(current.task); } catch (_) { return fail('changed'); }
    committedTasks(owner, current.task, before.projectId.value);
    return { status: 'saved', id: payload.id };
  }
  async function setCompleted(payload) {
    if (!core()?.applyPlan || !window.TaskDeliverable?.validate || typeof saveDocumentDurably !== 'function') return fail('unavailable');
    const owner = state, found = taskAccess(payload.id); if (found.failure) return found.failure;
    const task = found.task, previousProjectId = task.projectId, target = payload.completed ? 'done' : 'todo';
    if (version(task) !== payload.expectedVersion) return fail('changed');
    const before = Object.fromEntries(['status', 'completedAt', 'updatedAt'].map(key => [key, field(task, key)]));
    if (task.status !== target) {
      const context = window.CitationEvidence.createAccessContext(state);
      if (target === 'done') {
        const readable = (type, values) => list(values).filter(item => context.access({ type, id: item?.id }).available && !context.isAmbiguous({ type, id: item?.id }));
        const verdict = window.TaskDeliverable.validate(task, { notes: readable('note', state.notes), tasks: readable('task', state.tasks), projectId: task.projectId || null });
        if (!verdict.ok) return fail('unmet_deliverable');
      }
      let candidate;
      try { candidate = core().applyPlan(state, [{ type: 'update_task', taskId: payload.id, patch: { status: target } }], { workspace: task.workspace, projectId: task.projectId || null, allowedTaskIds: [payload.id] }).state.tasks.find(value => value.id === payload.id); }
      catch (_) { return fail('invalid'); }
      if (!candidate || candidate.status !== target) return fail('invalid');
      for (const key of ['status', 'completedAt', 'updatedAt']) { if (own(candidate, key)) task[key] = candidate[key]; else delete task[key]; }
    }
    const after = Object.fromEntries(['status', 'completedAt', 'updatedAt'].map(key => [key, field(task, key)]));
    pendingStatuses.set(task.id, { task, before });
    try {
      if (await saveDocumentDurably() !== true) throw Error('storage_failed');
    } catch (_) {
      // Only the status transition belongs to this command. Preserve a newer
      // title/date edit or a replacement task supplied by synchronization.
      if (state === owner && list(owner.tasks).includes(task) && ['status', 'completedAt'].every(key => equalField(task, key, after[key]))) {
        for (const key of ['status', 'completedAt']) { if (before[key].present) task[key] = before[key].value; else delete task[key]; }
        if (equalField(task, 'updatedAt', after.updatedAt)) { if (before.updatedAt.present) task.updatedAt = before.updatedAt.value; else delete task.updatedAt; }
      }
      return fail('storage_failed');
    } finally { pendingStatuses.delete(task.id); }
    const settled = readiness(); if (settled) return settled;
    const current = taskAccess(payload.id); if (current.failure) return current.failure;
    if (!['status', 'completedAt'].every(key => equalField(current.task, key, after[key]))) return fail('changed');
    committedTasks(owner, current.task, previousProjectId);
    return { status: 'saved', id: payload.id };
  }
  function lifecycleReady() {
    if (!window.ContentLifecycle?.remove || !window.ContentLifecycle?.restore || !core()?.contentStamp || typeof saveDocumentDurably !== 'function') return fail('unavailable');
    if (!Array.isArray(state.trash) || !Array.isArray(state.links)) return fail('unavailable');
    // A task form may hold unsaved fields not represented by its record version.
    if (document.querySelector?.('dialog[open]') || (typeof taskEditorHasDrafts === 'function' && taskEditorHasDrafts()) ||
        (typeof contentDeletePending !== 'undefined' && contentDeletePending) || window.ProjectBoard?.isBusy?.() || window.ProjectSchedule?.isBusy?.() || window.ProjectSchedule?.isDirty?.()) return fail('editor_busy',true);
    if (own(state.ui,'nativeQuickTaskLifecycleReceipts') && !object(state.ui.nativeQuickTaskLifecycleReceipts)) return fail('unavailable');
    return null;
  }
  function trashTask(trashId,id,owner=state) {
    const entries=list(owner.trash).filter(entry=>entry?.id===trashId),entry=entries[0];
    if(entries.length!==1||entry?.type!=='content'||list(entry.data?.tasks).length!==1||entry.data.tasks[0]?.id!==id) return null;
    if(['notes','papers','imports','attachments'].some(key=>list(entry.data?.[key]).length)) return null;
    return {entry,task:entry.data.tasks[0]};
  }
  function lifecyclePrivate(id) { return window.CitationEvidence.createAccessContext(state).access({type:'task',id}).kind==='private'; }
  function projectLifecycleState(owner,next) {
    // ContentLifecycle is the sole deletion/recovery planner. Apply only its
    // task/link/trash/result delta, retaining all unrelated record identities.
    for(const key of ['tasks','links','trash','lastResults']) {
      if(!Array.isArray(next[key]))continue;
      const current=new Map(list(owner[key]).map(value=>[JSON.stringify(value),value]));
      owner[key]=next[key].map(value=>current.get(JSON.stringify(value))||value);
    }
  }
  function committedLifecycle(owner,items,operation) {
    if(state!==owner)return;
    try {document.dispatchEvent(new CustomEvent('records-committed',{detail:{source:'native-quick-workbench',owner,collection:'tasks',operation,
      ids:items.map(item=>item.id),projectIds:[...new Set(items.map(item=>item.projectId).filter(Boolean))],workspaces:[...new Set(items.map(item=>item.workspace).filter(Boolean))]}}));}catch(_){}
  }
  async function taskLifecycle(payload) {
    const blocked=lifecycleReady();if(blocked)return blocked;
    if (own(state.ui.nativeQuickTaskBatchLifecycleReceipts || {}, payload.trashId)) return fail('collision');
    const owner=state,ledger=state.ui.nativeQuickTaskLifecycleReceipts||{},prior=ledger[payload.trashId];
    if(prior&&(!object(prior)||prior.id!==payload.id||prior.trashId!==payload.trashId))return fail('collision');
    if(lifecyclePrivate(payload.id))return fail('private');
    let items;
    if(payload.action==='delete-task') {
      if(prior) {
        if(prior.expectedVersion!==payload.expectedVersion)return fail('collision');
        const saved=trashTask(payload.trashId,payload.id);
        if(prior.phase!=='deleted'||!saved||list(state.tasks).some(item=>item.id===payload.id)||version(saved.task)!==prior.expectedVersion)return fail('changed');
        items=[saved.task];
      } else {
        const found=taskAccess(payload.id);if(found.failure)return found.failure;
        if(version(found.task)!==payload.expectedVersion)return fail('changed');
        if(list(state.trash).some(entry=>entry?.id===payload.trashId))return fail('collision');
        const result=window.ContentLifecycle.remove(state,[{type:'task',id:payload.id}],{}, {uid:()=>payload.trashId});
        if(!result.entry||result.removed.length!==1||result.removed[0].id!==payload.id)return fail('changed');
        items=[found.task];projectLifecycleState(owner,result.state);
        (state.ui.nativeQuickTaskLifecycleReceipts||={})[payload.trashId]={id:payload.id,trashId:payload.trashId,expectedVersion:payload.expectedVersion,phase:'deleted'};
      }
    } else {
      if(!prior)return fail('removed');
      if(prior.phase==='restored') {
        const found=taskAccess(payload.id);if(found.failure)return found.failure;
        if(version(found.task)!==prior.restoredVersion)return fail('changed');items=[found.task];
      } else {
        const saved=trashTask(payload.trashId,payload.id);
        if(prior.phase!=='deleted'||!saved||version(saved.task)!==prior.expectedVersion)return fail('changed');
        if(list(state.tasks).some(item=>item.id===payload.id))return fail('collision');
        const result=window.ContentLifecycle.restore(state,payload.trashId),restored=result.state.tasks.find(item=>item.id===payload.id);
        const access=window.CitationEvidence.createAccessContext(result.state);
        if(result.restored.length!==1||result.restored[0].id!==payload.id||!restored||!access.access({type:'task',id:payload.id}).available||access.isAmbiguous({type:'task',id:payload.id}))return fail('changed');
        items=[restored];projectLifecycleState(owner,result.state);
        state.ui.nativeQuickTaskLifecycleReceipts[payload.trashId]={...prior,phase:'restored',restoredVersion:version(restored)};
      }
    }
    // A failed/lost ACK leaves the canonical recoverable record and immutable
    // receipt in place. Retry verifies this same transition; never delete twice.
    try {if(await saveDocumentDurably()!==true)return fail('storage_failed');}catch(_){return fail('storage_failed');}
    if(state!==owner)return fail('changed');
    const settled=readiness();if(settled)return settled;
    if(lifecyclePrivate(payload.id))return fail('private');
    const receipt=state.ui.nativeQuickTaskLifecycleReceipts?.[payload.trashId];
    if(!receipt||receipt.id!==payload.id||receipt.trashId!==payload.trashId)return fail('changed');
    if(payload.action==='delete-task') {
      const saved=trashTask(payload.trashId,payload.id);
      if(receipt.phase!=='deleted'||receipt.expectedVersion!==payload.expectedVersion||!saved||version(saved.task)!==payload.expectedVersion||list(state.tasks).some(item=>item.id===payload.id))return fail('changed');
    } else {
      const found=taskAccess(payload.id);if(found.failure)return found.failure;
      if(receipt.phase!=='restored'||version(found.task)!==receipt.restoredVersion)return fail('changed');
    }
    committedLifecycle(owner,items,payload.action==='delete-task'?'delete':'restore');
    return {status:payload.action==='delete-task'?'deleted':'restored',id:payload.id,trashId:payload.trashId};
  }
  function batchTrashTasks(trashId, ids, owner = state) {
    const entries = list(owner.trash).filter(entry => entry?.id === trashId), entry = entries[0], tasks = list(entry?.data?.tasks);
    if (entries.length !== 1 || entry?.type !== 'content' || tasks.length !== ids.length || new Set(tasks.map(task => task?.id)).size !== ids.length ||
        ['notes', 'papers', 'imports', 'attachments', 'attachmentMemberships'].some(key => list(entry.data?.[key]).length)) return null;
    const byID = new Map(tasks.map(task => [task?.id, task]));
    return ids.every(id => byID.has(id)) ? ids.map(id => byID.get(id)) : null;
  }
  async function taskBatchLifecycle(payload) {
    const blocked = lifecycleReady(); if (blocked) return blocked;
    if (own(state.ui, 'nativeQuickTaskBatchLifecycleReceipts') && !object(state.ui.nativeQuickTaskBatchLifecycleReceipts)) return fail('unavailable');
    const deleting = payload.action === 'delete-tasks', ids = deleting ? payload.items.map(item => item.id) : payload.ids;
    const owner = state, ledger = state.ui.nativeQuickTaskBatchLifecycleReceipts || {}, prior = ledger[payload.trashId];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (own(state.ui.nativeQuickTaskLifecycleReceipts || {}, payload.trashId) || Object.values(ledger).some(receipt => receipt?.id === payload.id && receipt.trashId !== payload.trashId)) return fail('collision');
    if (prior && (!object(prior) || prior.id !== payload.id || prior.trashId !== payload.trashId || !same(prior.ids, ids))) return fail('collision');
    const privateMember = () => {
      const access = window.CitationEvidence.createAccessContext(state);
      return ids.some(id => access.access({ type: 'task', id }).kind === 'private');
    };
    if (privateMember()) return fail('private');
    let items;
    if (deleting) {
      if (prior) {
        if (!same(prior.items, payload.items)) return fail('collision');
        items = batchTrashTasks(payload.trashId, ids);
        if (prior.phase !== 'deleted' || !items || ids.some(id => list(state.tasks).some(task => task?.id === id)) ||
            items.some((task, index) => version(task) !== payload.items[index].expectedVersion)) return fail('changed');
      } else {
        const context = window.CitationEvidence.createAccessContext(state), found = ids.map(id => taskAccess(id, state, context));
        const failure = found.find(item => item.failure)?.failure; if (failure) return failure;
        items = found.map(item => item.task);
        if (items.some((task, index) => version(task) !== payload.items[index].expectedVersion)) return fail('changed');
        if (list(state.trash).some(entry => entry?.id === payload.trashId)) return fail('collision');
        const result = window.ContentLifecycle.remove(state, ids.map(id => ({ type: 'task', id })), {}, { uid: () => payload.trashId });
        if (result.removed.length !== ids.length || !batchTrashTasks(payload.trashId, ids, result.state)) return fail('changed');
        projectLifecycleState(owner, result.state);
        (state.ui.nativeQuickTaskBatchLifecycleReceipts ||= {})[payload.trashId] = { id: payload.id, trashId: payload.trashId, ids, items: payload.items, phase: 'deleted' };
      }
    } else {
      if (!prior) return fail('removed');
      if (prior.phase === 'restored') {
        const context = window.CitationEvidence.createAccessContext(state), found = ids.map(id => taskAccess(id, state, context));
        const failure = found.find(item => item.failure)?.failure; if (failure) return failure;
        items = found.map(item => item.task);
        if (!same(items.map(version), prior.restoredVersions)) return fail('changed');
      } else {
        const saved = batchTrashTasks(payload.trashId, ids);
        if (prior.phase !== 'deleted' || !saved || !Array.isArray(prior.items) || prior.items.length !== ids.length ||
            saved.some((task, index) => prior.items[index]?.id !== ids[index] || version(task) !== prior.items[index].expectedVersion)) return fail('changed');
        if (ids.some(id => list(state.tasks).some(task => task?.id === id))) return fail('collision');
        // The general Trash planner allows partial recovery. A quick batch
        // must restore every requested task before any of its delta is applied.
        const result = window.ContentLifecycle.restore(state, payload.trashId), access = window.CitationEvidence.createAccessContext(result.state);
        const found = ids.map(id => taskAccess(id, result.state, access));
        if (result.restored.length !== ids.length || result.restored.some(item => item.type !== 'task' || !ids.includes(item.id)) || found.some(item => item.failure)) return fail('changed');
        items = found.map(item => item.task); projectLifecycleState(owner, result.state);
        state.ui.nativeQuickTaskBatchLifecycleReceipts[payload.trashId] = { ...prior, phase: 'restored', restoredVersions: items.map(version) };
      }
    }
    const receiptStamp = JSON.stringify(state.ui.nativeQuickTaskBatchLifecycleReceipts[payload.trashId]);
    try { if (await saveDocumentDurably() !== true) return fail('storage_failed'); } catch (_) { return fail('storage_failed'); }
    if (state !== owner) return fail('changed');
    const settled = readiness(); if (settled) return settled;
    if (privateMember()) return fail('private');
    const receipt = state.ui.nativeQuickTaskBatchLifecycleReceipts?.[payload.trashId];
    if (JSON.stringify(receipt) !== receiptStamp) return fail('changed');
    if (deleting) {
      const saved = batchTrashTasks(payload.trashId, ids);
      if (!saved || ids.some(id => list(state.tasks).some(task => task?.id === id)) || saved.some((task, index) => version(task) !== payload.items[index].expectedVersion)) return fail('changed');
    } else {
      const context = window.CitationEvidence.createAccessContext(state), found = ids.map(id => taskAccess(id, state, context));
      const failure = found.find(item => item.failure)?.failure; if (failure) return failure;
      if (!same(found.map(item => version(item.task)), receipt.restoredVersions)) return fail('changed');
    }
    committedLifecycle(owner, items, deleting ? 'delete' : 'restore');
    return { status: deleting ? 'deleted' : 'restored', id: payload.id, trashId: payload.trashId, ids };
  }
  async function renameWorkflow(payload) {
    const api = window.TaskWorkflow;
    if (!api || typeof saveDocumentDurably !== 'function') return fail('unavailable');
    const owner = state, ui = owner.ui, before = field(ui, 'taskWorkflowNames');
    let next;
    try { next = api.rename(owner, payload.category, payload.name, payload.expectedVersion); }
    catch (error) { return fail(['changed', 'duplicate_name'].includes(error.message) ? error.message : 'invalid'); }
    const pending = { owner, names: api.names(owner), version: api.version(owner) };
    pendingWorkflowNames = pending;
    ui.taskWorkflowNames = next;
    const expected = api.version(owner);
    try { if (await saveDocumentDurably() !== true) throw Error('storage_failed'); }
    catch (_) {
      // Do not roll back a newer preference or a replacement document.
      if (state === owner && owner.ui === ui && ui.taskWorkflowNames === next && api.version(owner) === expected) {
        if (before.present) ui.taskWorkflowNames = before.value; else delete ui.taskWorkflowNames;
      }
      return fail('storage_failed');
    } finally { if (pendingWorkflowNames === pending) pendingWorkflowNames = null; }
    if (state !== owner || owner.ui !== ui) return fail('changed');
    const blocked = readiness(); if (blocked) return blocked;
    if (api.version(owner) !== expected) return fail('changed');
    return { status: 'saved', id: payload.id, workflowNames: api.names(owner), workflowVersion: expected };
  }
  async function execute(payload) {
    const blocked = readiness(); if (blocked) return blocked;
    if (['delete-tasks', 'restore-tasks'].includes(payload.action)) return taskBatchLifecycle(payload);
    if (['delete-task','restore-task'].includes(payload.action)) return taskLifecycle(payload);
    if (payload.action === 'rename-task-workflow') return renameWorkflow(payload);
    if (payload.action === 'create-task') return createTask(payload);
    if (payload.action === 'set-task-completed') return setCompleted(payload);
    if (payload.action === 'update-task') return updateTask(payload);
    const current = runAccess(payload.id);
    if (!current || !canCancel(current.run)) return fail('changed');
    stopCurrentRun(); return { status: 'cancel_requested', id: payload.id };
  }
  window.NativeQuickWorkbench = {
    snapshot,
    command(value) {
      if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.length > 200) return Promise.resolve(fail('invalid'));
      const fields = { 'rename-task-workflow': ['action', 'id', 'category', 'name', 'expectedVersion'], 'delete-tasks': ['action', 'id', 'trashId', 'items'], 'restore-tasks': ['action', 'id', 'trashId', 'ids'], 'delete-task': ['action','id','trashId','expectedVersion'], 'restore-task':['action','id','trashId'], 'create-task': ['action', 'id', 'title', 'workspace', 'projectId', 'dueAt', 'priority', 'sourceTaskInbox', 'workflowCategory'], 'update-task': ['action', 'id', 'patch', 'expectedVersion'], 'set-task-completed': ['action', 'id', 'completed', 'expectedVersion'], 'cancel-run': ['action', 'id'] };
      if (!own(fields, value.action) || Object.keys(value).some(key => !fields[value.action].includes(key))) return Promise.resolve(fail('invalid'));
      if (value.action === 'create-task' && (!identifier.test(value.id) || typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 500)) return Promise.resolve(fail('invalid'));
      if (['delete-task','restore-task'].includes(value.action) && (typeof value.trashId !== 'string' || !lifecycleIdentifier.test(value.trashId) || (value.action === 'delete-task' && (typeof value.expectedVersion !== 'string' || !value.expectedVersion)))) return Promise.resolve(fail('invalid'));
      const batch = ['delete-tasks', 'restore-tasks'].includes(value.action);
      if (batch) {
        const validID = id => typeof id === 'string' && !!id && id.length <= 200;
        if (!batchIdentifier.test(value.id) || typeof value.trashId !== 'string' || !lifecycleIdentifier.test(value.trashId)) return Promise.resolve(fail('invalid'));
        if (value.action === 'delete-tasks' && (!Array.isArray(value.items) || !value.items.length || value.items.some(item => !object(item) || Object.keys(item).length !== 2 || !validID(item.id) || typeof item.expectedVersion !== 'string' || !item.expectedVersion || Object.keys(item).some(key => !['id', 'expectedVersion'].includes(key))))) return Promise.resolve(fail('invalid'));
        const ids = value.action === 'delete-tasks' ? value.items.map(item => item.id) : value.ids;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => !validID(id)) || new Set(ids).size !== ids.length) return Promise.resolve(fail('invalid'));
      }
      if (value.action === 'rename-task-workflow' && (value.id !== 'quick_task_workflow_names' || !window.TaskWorkflow || !window.TaskWorkflow.keys.includes(value.category) || !window.TaskWorkflow.validName(value.name) || typeof value.expectedVersion !== 'string')) return Promise.resolve(fail('invalid'));
      const validFields = input => (!own(input, 'title') || typeof input.title === 'string' && !!input.title.trim() && input.title.trim().length <= 500)
        && (!own(input, 'workflowCategory') || !!window.TaskWorkflow?.validCategory(input.workflowCategory))
        && (!own(input, 'workspace') || ['日常', '课程', '科研'].includes(input.workspace))
        && (!own(input, 'projectId') || input.projectId === null || typeof input.projectId === 'string' && !!input.projectId && input.projectId.length <= 200)
        && (!own(input, 'dueAt') || input.dueAt === null || typeof input.dueAt === 'string' || typeof input.dueAt === 'number' && Number.isFinite(input.dueAt));
      if (value.action === 'create-task' && (!validFields(value) || ['workspace', 'projectId', 'dueAt'].some(key => own(value, key)) && !['workspace', 'projectId', 'dueAt'].every(key => own(value, key)))) return Promise.resolve(fail('invalid'));
      if (value.action === 'create-task' && (own(value, 'priority') || own(value, 'sourceTaskInbox'))) {
        const source = value.sourceTaskInbox;
        if (!object(source) || Object.keys(source).length !== 3 || Object.keys(source).some(key => !['version', 'id', 'category'].includes(key)) || source.version !== 1 || typeof source.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(source.id) || !['P0', 'P1', 'P2', 'P3'].includes(source.category) || value.priority !== ({ P0: 'high', P1: 'high', P2: 'medium', P3: 'low' })[source.category] || !['workspace', 'projectId', 'dueAt'].every(key => own(value, key))) return Promise.resolve(fail('invalid'));
      }
      if (value.action === 'update-task' && (!object(value.patch) || !Object.keys(value.patch).length || Object.keys(value.patch).some(key => !['title', 'workspace', 'projectId', 'dueAt', 'workflowCategory'].includes(key)) || !validFields(value.patch) || typeof value.expectedVersion !== 'string' || !value.expectedVersion)) return Promise.resolve(fail('invalid'));
      if (value.action === 'set-task-completed' && (typeof value.completed !== 'boolean' || typeof value.expectedVersion !== 'string' || !value.expectedVersion)) return Promise.resolve(fail('invalid'));
      const payload = Object.fromEntries(fields[value.action].filter(key => own(value, key)).map(key => [key, ['patch', 'sourceTaskInbox'].includes(key) ? { ...value[key] } : key === 'items' ? value.items.map(item => ({ ...item })) : key === 'ids' ? [...value.ids] : value[key]])), signature = JSON.stringify(payload), current = requests.get(payload.id);
      if (current) return current.signature === signature ? current.promise : Promise.resolve(fail('busy', true));
      const ids = batch ? (payload.items?.map(item => item.id) || payload.ids) : payload.action === 'cancel-run' ? [] : [payload.id];
      if (ids.some(id => taskLocks.has(id))) return Promise.resolve(fail('busy', true));
      const promise = Promise.resolve().then(() => execute(payload)).finally(() => {
        if (requests.get(payload.id)?.promise === promise) requests.delete(payload.id);
        for (const id of ids) if (taskLocks.get(id) === promise) taskLocks.delete(id);
      });
      for (const id of ids) taskLocks.set(id, promise);
      requests.set(payload.id, { signature, promise }); return promise;
    }
  };
})();
