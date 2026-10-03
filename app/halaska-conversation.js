(function (root) {
  'use strict';
  const records = new WeakMap();
  const text = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const settledLabels = { completed: ['已完成', 'Completed'], done: ['已完成', 'Completed'], 'completed-local': ['已完成', 'Completed'],
    failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'], 'awaiting-save': ['等待保存结果', 'Save confirmation needed'], 'awaiting-approval': ['等待审批', 'Approval needed'], rejected: ['已拒绝', 'Declined'] };
  const phaseLabels = { tool: ['正在执行', 'Working'], thinking: ['正在思考', 'Thinking'], writing: ['正在回答', 'Writing'], waiting: ['等待模型', 'Waiting'] };
  const activityLabels = { completed: ['已完成', 'Completed'], done: ['已完成', 'Completed'], 'completed-local': ['已完成', 'Completed'],
    running: ['进行中', 'Running'], pending: ['待执行', 'Pending'], failed: ['失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
    'awaiting-approval': ['等待审批', 'Needs approval'], 'awaiting-save': ['等待保存', 'Needs saving'], rejected: ['已拒绝', 'Declined'], unknown: ['未确认', 'Unconfirmed'] };
  const kindLabels = { tool: ['工具', 'Tool'], step: ['阶段', 'Stage'], summary: ['模型返回', 'Model output'], reasoning: ['模型返回', 'Model output'], response: ['回复', 'Response'], commentary: ['进展', 'Progress'], group: ['工具组', 'Tool group'] };

  function activityProps(item = {}, message = {}) {
    const status = Object.prototype.hasOwnProperty.call(activityLabels, item.status) ? item.status : 'unknown';
    const active = message.live === true && status === 'running';
    const title = item.kind === 'tool' ? String(item.name || text('工具操作', 'Tool operation'))
      : item.kind === 'step' ? String(item.text || text('执行阶段', 'Activity stage'))
      : ['summary', 'reasoning'].includes(item.kind) ? text('模型思考', 'Model reasoning') : text('模型进展', 'Model progress');
    const start = Number(item.at), end = Number(item.updatedAt);
    const elapsed = start > 0 && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? root.AgentProgress?.duration(start, end) || '' : '';
    return { title, status, active, elapsed, ...(item.kind === 'reasoning' ? { detail: root.ConversationProcess?.preview(item.text) || '' } : {}), kindLabel: text(...(kindLabels[item.kind] || ['活动', 'Activity'])),
      statusLabel: status === 'running' && !active ? text('未确认结束', 'End not recorded') : text(...activityLabels[status]) };
  }

  function groupProps(dataset = {}, message = {}, detail = '') {
    const status = Object.prototype.hasOwnProperty.call(activityLabels, dataset.groupStatus) ? dataset.groupStatus : 'unknown';
    const active = message.live === true && status === 'running';
    const count = Number(dataset.groupCount), ms = Number(dataset.groupDuration);
    return { title: String(dataset.groupName || text('工具操作', 'Tool operations')), status, active,
      statusLabel: status === 'running' && !active ? text('未确认结束', 'End not recorded') : text(...activityLabels[status]),
      kindLabel: text(...kindLabels.group), countLabel: Number.isInteger(count) && count > 0 ? text(`${count} 次`, `${count} calls`) : '',
      elapsed: Number.isFinite(ms) && ms > 0 ? root.AgentProgress?.duration(0, ms) || '' : '', detail: String(detail || '') };
  }

  function bindSummaryKeyboard(summary) {
    summary.addEventListener('keydown', event => {
      if (event.target !== summary || event.key !== 'Enter' || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault(); summary.click();
    });
  }

  function stageSummary(host, name, props, previousHost) {
    const prior = previousHost && records.get(previousHost);
    // The live patch will retain the connected old React root. Staging only
    // its next flat props avoids mounting and immediately unmounting a second
    // root for every historical row on each transport delta.
    if (prior?.name === name && !prior.deferred) {
      host.dataset.halaskaConversation = name;
      records.set(host, { name, props, actions: [], deferred: true });
    } else mount(host, name, props);
  }

  function previousSummaries(wrapper) {
    const result = new Map(), progress = wrapper?.querySelector(':scope > .agent-progress');
    if (!progress) return result;
    const remember = (key, summary, name, parent = null) => {
      const host = summary?.querySelector(':scope > [data-halaska-conversation]');
      const record = host && records.get(host);
      if (record?.name === name && !record.deferred) result.set(key, { host, parent });
    };
    remember('feed', progress.querySelector(':scope > summary'), 'AgentLifecycleSummary');
    for (const row of progress.querySelectorAll('.progress-item[data-activity-id]')) {
      remember(`item:${row.dataset.activityId}`, row.querySelector(':scope > .progress-item-content > details > summary'), 'AgentActivitySummary', row.closest('.progress-group[data-progress-group-id]')?.dataset.progressGroupId || null);
    }
    for (const group of progress.querySelectorAll('.progress-group[data-progress-group-id]')) {
      remember(`group:${group.dataset.progressGroupId}`, group.querySelector(':scope > .progress-group-details > summary'), 'AgentActivitySummary');
    }
    return result;
  }

  function enhanceActivitySummary(summary, props, previousHost) {
    if (!summary) return;
    const existing = summary.querySelector(':scope > [data-halaska-conversation]');
    if (existing) {
      const record = records.get(existing);
      if (record?.name === 'AgentActivitySummary') {
        if (!record.deferred) root.HalaskaUI.update(existing, props);
        records.set(existing, { ...record, props });
      }
      return;
    }
    const host = root.document.createElement('span');
    host.className = 'halaska-activity-summary';
    stageSummary(host, 'AgentActivitySummary', props, previousHost);
    summary.replaceChildren(host);
    bindSummaryKeyboard(summary);
  }

  function summaryProps(message, run = {}) {
    const payload = { ...message, runStatus: run.status || message.runStatus, phase: run.phase || message.phase };
    const continuous = root.ConversationProcess?.hasFlow(message);
    const entries = continuous ? root.ConversationProcess.flowEntries(message, run) : root.AgentProgress?.entries(payload) || [];
    const active = [...entries].reverse().find(item => item.status === 'running');
    const status = message.live ? 'running' : run.status || message.runStatus || (message.retryRunId ? 'failed' : 'unknown');
    const phase = root.AgentProgress?.phase(payload, active) || 'waiting';
    const saved = !message.live && ['completed', 'completed-local', 'done'].includes(status) && root.RunCheckpoint?.view(run)?.hasSavedResult === true;
    const label = saved ? text('结果已保存', 'Results saved') : text(...(message.live ? phaseLabels[phase] || phaseLabels.waiting : settledLabels[status] || ['执行记录', 'Activity']));
    // The complete public content stays in the existing expandable timeline.
    // Its current last line is a summary, not a substitute for that content.
    const detail = !message.live ? '' : active?.kind === 'tool' ? active.name || active.call?.request?.title || text('工具操作', 'Tool operation')
      : active?.kind === 'step' ? active.text : active?.text ? active.text.split('\n').filter(Boolean).pop() : '';
    const startedAt = Number(run.startedAt || message.startedAt || message.at);
    const finishedAt = Number(run.finishedAt || message.finishedAt);
    const elapsed = startedAt > 0 && (message.live || finishedAt >= startedAt)
      ? root.AgentProgress?.duration(startedAt, message.live ? Date.now() : finishedAt) || '' : '';
    const tools = Array.isArray(run.toolCalls) ? run.toolCalls.length : 0;
    const count = continuous ? text(`${entries.length} 项过程`, `${entries.length} process entries`) : tools ? (entries.length ? text(`${entries.length} 项进展 · ${tools} 次工具调用`, `${entries.length} entries · ${tools} tool calls`) : text(`${tools} 次工具调用`, `${tools} tool calls`))
      : text(`${entries.length} 项活动`, `${entries.length} activities`);
    const streamReception = root.StreamReception?.project(run.streamReception, { live: message.live, phase }) ? run.streamReception : null;
    const issueCount = root.ToolScheduler?.issueCount?.(run) || 0;
    return { status, phase, label, detail, startedAt, elapsed, count, issueCount, streamReception, keyboardHint: text('展开 / 收起', 'Expand / collapse') };
  }

  function enhanceProcessTabs(wrapper, previous) {
    const selector = ':scope > .agent-progress > .conversation-process-navigation';
    const host = wrapper.querySelector(selector);
    // Mount the owned strip even while hidden for a single view. The first
    // tool can then reveal the same root without moving React's children into
    // a previously unowned placeholder during the live DOM patch.
    if (!host || host.dataset?.liveKey !== 'process-navigation') return;
    const progress = wrapper.querySelector('[data-live-key="process-progress-panel"]');
    const tools = wrapper.querySelector('[data-live-key="process-tools-panel"]');
    if (!progress || !tools) return;
    const props = { messageId: wrapper.dataset.messageId, value: host.dataset.view,
      progressCount: Number(host.dataset.progressCount), toolCount: Number(host.dataset.toolCount),
      issueCount: Number(host.dataset.issueCount), toolFilter: host.dataset.toolFilter,
      progressPanelId: progress.id, toolsPanelId: tools.id };
    progress.setAttribute('aria-labelledby', progress.id + '-tab'); tools.setAttribute('aria-labelledby', tools.id + '-tab');
    stageSummary(host, 'AgentProcessTabs', props, previous?.querySelector(selector));
  }

  function setProcessView(wrapper, value) {
    const host = wrapper?.querySelector('.conversation-process-navigation');
    const record = host && records.get(host);
    if (!record || record.deferred || record.name !== 'AgentProcessTabs') return;
    const props = { ...record.props, value, toolFilter: host.dataset.toolFilter };
    root.HalaskaUI.update(host, props); records.set(host, { ...record, props });
  }

  function mount(element, name, props, actions = []) {
    root.HalaskaUI.mount(element, name, props);
    element.dataset.halaskaConversation = name;
    records.set(element, { name, props, actions });
    bindActions(element, actions);
    return element;
  }

  function bindActions(element, actions) {
    for (const action of actions) {
      const button = [...element.querySelectorAll('[data-lifecycle-action]')].find(node => node.dataset.lifecycleAction === action.key)?.querySelector('button');
      if (!button) continue;
      // The app already owns the delegated action handlers. Transfer their
      // exact datasets to the new real button, with no second React callback.
      for (const [key, value] of Object.entries(action.dataset)) button.dataset[key] = value;
      if (action.className) button.className = action.className;
      button.disabled = action.disabled;
    }
  }

  function captureActions(buttons) {
    return buttons.map((button, index) => ({ key: `action-${index}`, label: button.textContent.trim(),
      title: button.title, disabled: button.disabled, dataset: { ...button.dataset }, className: button.className,
      variant: button.hasAttribute('data-approve-run') || button.hasAttribute('data-run-recovery-settings') || button.hasAttribute('data-run-recovery-context') ? 'accent' : button.hasAttribute('data-reject-run') || button.hasAttribute('data-dismiss-failure') ? 'ghost' : 'secondary' }));
  }

  function replaceActions(container, buttons, props) {
    if (!buttons.length || container.querySelector(':scope > [data-halaska-conversation]')) return;
    const actions = captureActions(buttons), host = root.document.createElement('div');
    container.insertBefore(host, buttons[0]);
    mount(host, 'AgentLifecycleActions', { ...props, actions }, actions);
    buttons.forEach(button => button.remove());
  }

  function enhance(wrapper, message, run = {}, { previous, outcome } = {}) {
    if (!wrapper || !root.HalaskaUI || message?.role === 'user') return false;
    const priorSummaries = previousSummaries(previous);
    const progress = wrapper.querySelector(':scope > .agent-progress');
    enhanceProcessTabs(wrapper, previous);
    const summary = progress?.querySelector(':scope > summary');
    if (summary && !summary.querySelector('[data-halaska-conversation]')) {
      const host = root.document.createElement('span');
      host.className = 'halaska-lifecycle-summary';
      stageSummary(host, 'AgentLifecycleSummary', summaryProps(message, run), priorSummaries.get('feed')?.host);
      summary.replaceChildren(host);
      // macOS WebKit/Chromium do not consistently activate summary with Enter.
      // Use the same click path so the app's capture listener also records the
      // user's pin; never mutate open independently of the existing controller.
      bindSummaryKeyboard(summary);
    }
    // Only summary contents become React-owned. Native details and its body
    // stay with AgentProgress, including persisted pins and text selection.
    const entries = new Map((root.ConversationProcess?.hasFlow(message)
      ? root.ConversationProcess.flowEntries(message, run).map(item => ({ ...item, id: root.ConversationProcess.flowKey(item) }))
      : root.AgentProgress?.entries(message) || []).map(item => [item.id, item]));
    for (const row of progress?.querySelectorAll('.progress-item[data-activity-id]') || []) {
      const item = entries.get(row.dataset.activityId);
      const prior = item && priorSummaries.get(`item:${item.id}`);
      // A row entering/leaving a group changes DOM parent. The host's keyed
      // patch is sibling-local, so that row must be mounted normally instead
      // of inserting an empty deferred host into a newly created subtree.
      const parent = row.closest('.progress-group[data-progress-group-id]')?.dataset.progressGroupId || null;
      if (item) enhanceActivitySummary(row.querySelector(':scope > .progress-item-content > details > summary'), activityProps(item, message), prior?.parent === parent ? prior.host : null);
    }
    for (const group of progress?.querySelectorAll('.progress-group[data-progress-group-id]') || []) {
      const summary = group.querySelector(':scope > .progress-group-details > summary');
      // Preserve the aggregate's truthful breakdown supplied by its owner.
      const previous = summary?.querySelector(':scope > [data-halaska-conversation]');
      const detail = summary?.querySelector('.progress-group-status')?.textContent || records.get(previous)?.props?.detail || '';
      enhanceActivitySummary(summary, groupProps(group.dataset, message, detail), priorSummaries.get(`group:${group.dataset.progressGroupId}`)?.host);
    }
    const pending = wrapper.querySelector(':scope > .pending-actions');
    if (pending && run.status === 'awaiting-approval') {
      replaceActions(pending, [...pending.querySelectorAll(':scope > button[data-approve-run],:scope > button[data-reject-run],:scope > button[data-review-run]')], {
        status: run.status, statusLabel: text('需要确认', 'Needs your review'), title: run.routingReview?.required ? text('确认这些内容的归属', 'Confirm where these belong') : text('确认后执行', 'Review before running'),
        description: run.routingReview?.required ? run.routingReview.message : text(`本轮有 ${run.pendingActions?.length || 0} 项待批准操作。请核对上方方案后选择。`, `${run.pendingActions?.length || 0} actions await approval. Review the proposal above.`),
      });
    }
    if (pending && (run.status === 'awaiting-save' || run.approvalReceipt?.savePending)) {
      replaceActions(pending, [...pending.querySelectorAll(':scope > button[data-retry-approval-save]')], {
        status: 'awaiting-save', statusLabel: text('等待保存', 'Save confirmation needed'), title: text('保存这批执行结果', 'Save these results'),
        description: text('操作已应用到本机工作区。重试只保存现有结果，不会再次执行动作。', 'Changes are already applied locally. Retrying saves these results without executing the actions again.')
      });
    }
    if (message.retryRunId) {
      const retry = wrapper.querySelector(':scope > .message-actions');
      if (retry && !retry.querySelector(':scope > [data-halaska-conversation]') && outcome?.showNotice && outcome.status === 'failed'
        && typeof run.id === 'string' && run.id === message.retryRunId && ['settings', 'context'].includes(outcome.recoveryAction) && outcome.recoveryActionLabel) {
        // Route through the existing DOM delegation exactly once, just like
        // retry/adjust. The Kit button receives this dataset via bindActions.
        const recovery = root.document.createElement('button');
        recovery.type = 'button'; recovery.textContent = outcome.recoveryActionLabel;
        recovery.setAttribute(`data-run-recovery-${outcome.recoveryAction}`, run.id);
        retry.prepend(recovery);
      }
      if (retry) replaceActions(retry, [...retry.querySelectorAll(':scope > button')], {
        status: outcome?.status || run.status || message.runStatus || 'failed', statusLabel: outcome?.statusLabel || (run.status === 'cancelled' ? text('已停止', 'Stopped') : text('未完成', 'Incomplete')),
        title: outcome?.noticeTitle || text('这次执行未完成', 'This run did not finish'), description: outcome?.showNotice ? outcome.noticeDescription : run.error || '',
        hint: outcome?.hint || text('重试会按原始请求发起新一轮执行。', 'Retry starts a new run from the original request.'),
        diagnosticDetails: outcome?.status === 'failed' ? outcome.diagnosticDetails : [],
        diagnosticLabel: text('诊断详情', 'Diagnostic details'),
        diagnosticOpen: message.failureDiagnosticOpen === true,
      });
    }
    const stop = wrapper.querySelector(':scope > button[data-stop-run]');
    if (stop) {
      const host = root.document.createElement('div'), actions = captureActions([stop]);
      host.className = 'halaska-lifecycle-stop'; stop.replaceWith(host);
      mount(host, 'AgentLifecycleActions', { status: 'running', compact: true, actions }, actions);
    }
    const receipt = wrapper.querySelector('.message-result-heading');
    if (receipt && !receipt.dataset.halaskaConversation) {
      const description = receipt.querySelector('small')?.textContent || '';
      const title = [...receipt.childNodes].filter(node => node.nodeName !== 'SMALL').map(node => node.textContent).join('');
      receipt.replaceChildren();
      mount(receipt, 'AgentReceipt', { title, description, label: text('操作结果', 'Results') });
    }
    return true;
  }

  // AgentProgress owns the timeline DOM. This narrow boundary prevents its
  // streaming diff from mutating React children or remounting Orb animations.
  function patchIsland(previous, next) {
    const record = records.get(next), old = records.get(previous);
    if (!record || !old || record.name !== old.name) return false;
    const oldKeys = Object.keys(old.props), nextKeys = Object.keys(record.props);
    const sameProps = oldKeys.length === nextKeys.length && nextKeys.every(key => Object.prototype.hasOwnProperty.call(old.props, key) && Object.is(old.props[key], record.props[key]));
    if (!sameProps) root.HalaskaUI.update(previous, record.props);
    if (record.name === 'AgentProcessTabs') { Object.assign(previous.dataset, next.dataset); previous.hidden = next.hidden; }
    records.set(previous, { ...record, deferred: false }); bindActions(previous, record.actions);
    if (!record.deferred) root.HalaskaUI.unmount(next);
    records.delete(next);
    return true;
  }

  function discard(element) {
    const islands = [...element.querySelectorAll('[data-halaska-conversation]')];
    if (element.dataset?.halaskaConversation) islands.unshift(element);
    for (const island of islands) {
      const record = records.get(island);
      if (!record) continue;
      if (!record.deferred) root.HalaskaUI.unmount(island);
      records.delete(island);
    }
  }

  root.HalaskaConversation = { enhance, summaryProps, activityProps, groupProps, patchIsland, discard, setProcessView };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HalaskaConversation;
})(typeof globalThis !== 'undefined' ? globalThis : this);
