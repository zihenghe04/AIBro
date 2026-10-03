(function (root) {
  'use strict';
  const labels = {
    completed: ['已完成', 'Completed'], done: ['已完成', 'Completed'], 'completed-local': ['已完成', 'Completed'],
    failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'],
    'awaiting-approval': ['等待审批', 'Approval needed'], 'awaiting-save': ['等待保存结果', 'Save confirmation needed'],
    rejected: ['已拒绝', 'Declined'],
  };
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const count = (message = {}, run = {}) => ({ progress: (message.steps?.length || 0) + (message.activities?.length || 0), tools: run.toolCalls?.length || 0 });
  const explicitToolInspection = (run = {}) => !!run.toolCalls?.length && (
    run.toolLedgerPins?.ledger === true || run.toolCalls.some(call =>
      run.toolLedgerPins?.[call.id] === true || run.toolLedgerPins?.['raw:' + call.id] === true || root.ToolScheduler?.inspectingCall?.(run, call))
  );

  // Read durable choices without writing defaults while rendering. A missing
  // source tab falls back to the available recorded content.
  function chooseView(message = {}, run = {}) {
    const counts = count(message, run);
    if (['progress', 'tools'].includes(message.processView) && counts[message.processView]) return message.processView;
    if (counts.tools && explicitToolInspection(run)) return 'tools';
    // A tool-backed run with only stage markers opens onto inspectable input/output.
    // Explicit choices and recorded reasoning/commentary retain their existing precedence.
    const hasDetail = message.activities?.some(item => typeof item.text === 'string' && item.text.trim())
      || message.steps?.some(item => typeof item.detail === 'string' && item.detail.trim());
    if (counts.tools && !hasDetail) return 'tools';
    return counts.progress ? 'progress' : counts.tools ? 'tools' : null;
  }
  const direct = (node, selector) => node?.querySelector(':scope > ' + selector) || null;
  const hasFlow = message => message?.conversationFlow?.version === 1 && typeof root.ConversationFlow?.entries === 'function';
  const flowEntries = (message, run) => hasFlow(message) ? root.ConversationFlow.entries(message, run) : [];
  const flowKey = item => 'flow:' + item.id;
  const preview = value => String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() || '';
  const element = (tag, className, text) => {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function disclosure(node, message, key, auto = false) {
    node.dataset.progressKey = key;
    const pins = message.progressPins || {};
    const explicit = Object.prototype.hasOwnProperty.call(pins, key);
    node.open = explicit ? pins[key] === true : auto;
    if (explicit) node.dataset.progressUserOpen = String(pins[key] === true);
  }

  // The recorder owns sequence, public response text and final-answer exclusion.
  // This projection only references its entries and the scheduler's real ledger.
  // Every item has the same parent from its first paint; an arriving tool never
  // reparents a selected reasoning block or replaces its owned summary root.
  function composeFlow(wrapper, message, run, options) {
    const items = flowEntries(message, run);
    const previousBodies = new Map([...(options.previous?.querySelectorAll('.conversation-flow-item') || [])]
      .map(row => [row.dataset.flowId, row.querySelector('.conversation-flow-text')]));
    if (!items.length && !message.steps?.length) {
      direct(wrapper, '.agent-progress')?.remove();
      return null;
    }
    let feed = direct(wrapper, '.agent-progress');
    if (!feed) {
      feed = element('details', 'agent-progress');
      feed.append(element('summary', '', t('执行过程', 'Process')));
      wrapper.insertBefore(feed, direct(wrapper, '.message-body'));
    }
    feed.dataset.conversationFlow = '1';
    feed.dataset.progressPhase = message.live ? 'waiting' : 'settled';
    const active = [...items].reverse().find(item => item.status === 'running');
    if (message.live && active) feed.dataset.progressPhase = active.kind === 'reasoning' ? 'thinking' : active.kind === 'tool' ? 'tool' : 'writing';
    const readingPinned = items.some(item => message.progressPins?.[flowKey(item)] === true);
    disclosure(feed, message, 'feed', !!message.live || readingPinned || explicitToolInspection(run));
    // compose normally receives a detached render. Repeated composition still
    // must not leave either the old tab projection or duplicate flow content.
    for (const child of [...feed.children]) if (child.nodeName !== 'SUMMARY') child.remove();
    const list = element('ol', 'conversation-flow'); list.dataset.liveKey = 'conversation-flow';
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      const row = element('li', 'conversation-flow-item conversation-flow-' + item.kind);
      row.dataset.liveKey = flowKey(item); row.dataset.flowId = item.id;
      row.dataset.flowKind = item.kind;
      if (item.parentId) {
        const owners = (run.delegations || []).filter(child => child.id === item.parentId);
        const title = owners.length === 1 && typeof owners[0].title === 'string' ? owners[0].title.trim() : '';
        row.dataset.flowParent = item.parentId;
        const owner = element('span', 'conversation-flow-owner', t('研究子任务', 'Research subtask') + (title ? ' · ' + title : ''));
        owner.dataset.liveKey = 'flow-owner'; row.append(owner);
      }
      if (item.kind === 'tool') {
        const call = item.call || run.toolCalls?.find(value => value.id === item.callId);
        if (!call) {
          row.append(element('span', 'conversation-flow-missing-tool', t('此工具调用的详细记录不可用。', 'Details for this recorded tool call are unavailable.')));
          list.append(row); continue;
        }
        const ledger = root.ToolScheduler?.card(run, { embedded: true, callIds: [call.id] });
        if (!ledger) continue;
        ledger.dataset.liveKey = 'flow-tool-ledger:' + call.id;
        // Explicit closes outrank the reconciler's temporary reading protection,
        // just as they do for reasoning and the outer process disclosure.
        for (const detail of ledger.querySelectorAll('[data-tool-id],[data-tool-ledger-key]')) {
          const key = detail.dataset.toolLedgerKey || detail.dataset.toolId;
          if (Object.prototype.hasOwnProperty.call(run.toolLedgerPins || {}, key)) detail.dataset.progressUserOpen = String(run.toolLedgerPins[key] === true);
        }
        row.append(ledger);
      } else if (['reasoning', 'response', 'commentary'].includes(item.kind) && typeof item.text === 'string' && item.text.trim()) {
        const body = element('div', 'conversation-flow-text');
        body.dataset.liveKey = 'flow-text';
        // The host supplies the same safe Markdown renderer as the final
        // answer. Never interpret source HTML without that explicit adapter.
        // Recorder entries retain identity, allowing the bounded parser pool
        // to reuse unchanged text and stable blocks while the message streams.
        if (typeof options.renderText === 'function') {
          body.classList.add('conversation-flow-rich');
          const live = !!message.live && !['completed', 'failed', 'cancelled', 'interrupted', 'timed_out', 'rejected'].includes(item.status);
          if (root.StreamMarkdown?.renderBody) root.StreamMarkdown.renderBody(item, body, item.text, options.renderText,
            { live, retainSettled: true, previous: previousBodies.get(item.id) });
          else body.innerHTML = root.StreamMarkdown?.render
            ? root.StreamMarkdown.render(item, item.text, options.renderText, live)
            : options.renderText(item.text);
        } else body.textContent = item.text;
        if (item.kind === 'reasoning') {
          row.className += ' progress-item'; row.dataset.activityId = flowKey(item); row.dataset.activityState = item.status || 'unknown';
          const content = element('div', 'progress-item-content');
          const details = element('details', 'conversation-flow-reasoning-details');
          disclosure(details, message, flowKey(item));
          const summary = element('summary');
          summary.append(element('span', 'conversation-flow-reasoning-title', t('模型思考', 'Model reasoning')),
            element('span', 'conversation-flow-reasoning-preview', preview(item.text)));
          details.append(summary, body); content.append(details); row.append(content);
        } else row.append(body);
      } else continue;
      list.append(row);
    }
    feed.append(list);
    if (message.steps?.length) {
      const diagnostics = element('details', 'conversation-flow-diagnostics');
      diagnostics.dataset.liveKey = 'flow-diagnostics'; disclosure(diagnostics, message, 'flow-diagnostics');
      diagnostics.append(element('summary', '', t('阶段记录', 'Stage records')));
      const stages = element('ol', 'conversation-flow-stages');
      message.steps.forEach((step, index) => {
        const stage = element('li'); stage.dataset.liveKey = 'diagnostic:' + (step.id || index);
        stage.append(element('span', '', String(step.text || '')));
        if (typeof step.detail === 'string' && step.detail.trim()) stage.append(element('div', 'conversation-flow-text', step.detail));
        stages.append(stage);
      });
      diagnostics.append(stages); feed.append(diagnostics);
    }
    return feed;
  }

  // Filtering is presentation only: keep original row identity, disclosure
  // pins and every recorded result. An in-progress reader keeps its row until
  // the next render instead of losing a focused control/selection to an update.
  function filterTools(wrapper, { readingNodes = [] } = {}) {
    const feed = direct(wrapper, '.agent-progress'), navigation = direct(feed, '.conversation-process-navigation');
    const panel = direct(feed, '[data-live-key="process-tools-panel"]');
    if (!navigation || !panel) return;
    const filter = navigation.dataset.toolFilter === 'issues' ? 'issues' : 'all';
    const selection = root.getSelection?.();
    const selected = selection && !selection.isCollapsed && String(selection).length > 0;
    for (const row of panel.querySelectorAll('.tool-ledger-row')) {
      const reading = row.contains?.(root.document.activeElement) || readingNodes.some(node => node && row.contains?.(node)) || selected && (row.contains?.(selection.anchorNode) || row.contains?.(selection.focusNode));
      row.hidden = filter === 'issues' && row.dataset.toolIssue !== 'true' && !reading;
    }
    const empty = direct(panel, '.conversation-tools-empty');
    if (empty) empty.hidden = filter !== 'issues' || Number(navigation.dataset.issueCount) > 0;
  }

  function select(wrapper, view, filter) {
    const feed = direct(wrapper, '.agent-progress');
    const navigation = direct(feed, '.conversation-process-navigation');
    if (!navigation) return null;
    const counts = { progress: Number(navigation.dataset.progressCount) || 0, tools: Number(navigation.dataset.toolCount) || 0 };
    const selected = ['progress', 'tools'].includes(view) && counts[view] ? view : counts.progress ? 'progress' : counts.tools ? 'tools' : null;
    for (const name of ['progress', 'tools']) {
      const panel = direct(feed, `[data-live-key="process-${name}-panel"]`);
      if (panel) panel.hidden = name !== selected;
    }
    navigation.dataset.view = selected || '';
    if (['all', 'issues'].includes(filter)) navigation.dataset.toolFilter = filter;
    filterTools(wrapper);
    return selected;
  }

  function compose(wrapper, message = {}, run = {}, options = {}) {
    if (!wrapper || !root.document || message.role === 'user') return null;
    if (hasFlow(message)) return composeFlow(wrapper, message, run, options);
    const counts = count(message, run);
    if (!counts.progress && !counts.tools) return null;
    let feed = direct(wrapper, '.agent-progress');
    if (!feed) {
      // Historical tool-only runs have no AgentProgress markup. Give them the
      // same truthful disclosure without inventing activity or completion.
      feed = root.document.createElement('details');
      feed.className = 'agent-progress'; feed.dataset.progressKey = 'feed';
      feed.dataset.progressPhase = message.live ? 'tool' : 'settled';
      const summary = root.document.createElement('summary');
      const title = root.document.createElement('span'); title.className = 'progress-heading-text';
      const status = run.status || message.runStatus || (message.retryRunId ? 'failed' : 'unknown');
      title.textContent = message.live ? t('正在执行', 'Working') : t(...(labels[status] || ['执行记录', 'Activity']));
      const total = root.document.createElement('span'); total.className = 'progress-count';
      total.textContent = t(`${counts.tools} 次工具调用`, `${counts.tools} tool calls`);
      summary.append(title, total); feed.append(summary);
      wrapper.insertBefore(feed, direct(wrapper, '.message-body'));
      feed.open = !!message.live;
    }
    // An explicit outer close always wins, including when an old tool or raw
    // record was pinned. Otherwise preserve the timeline's own opening rule.
    if (Object.prototype.hasOwnProperty.call(message.progressPins || {}, 'feed')) feed.open = message.progressPins.feed === true;
    else if (explicitToolInspection(run)) feed.open = true;

    const key = encodeURIComponent(String(message.id || wrapper.dataset.messageId || run.id || 'message'));
    let navigation = direct(feed, '.conversation-process-navigation');
    if (!navigation) {
      navigation = root.document.createElement('div'); navigation.className = 'conversation-process-navigation';
      navigation.dataset.liveKey = 'process-navigation'; feed.append(navigation);
    }
    const issues = root.ToolScheduler?.issueCount?.(run) || 0;
    Object.assign(navigation.dataset, { messageId: String(message.id || wrapper.dataset.messageId || ''), explicitView: ['progress','tools'].includes(message.processView) ? message.processView : '', progressCount: String(counts.progress), toolCount: String(counts.tools), issueCount: String(issues), toolFilter: message.processToolFilter === 'issues' ? 'issues' : 'all' });
    navigation.hidden = !(counts.progress && counts.tools) && !issues && message.processToolFilter !== 'issues';
    // Both stable keyed containers exist from the first recorded activity, so
    // the first tool delta does not reparent the timeline or its focused row.
    for (const name of ['progress', 'tools']) {
      let panel = direct(feed, `[data-live-key="process-${name}-panel"]`);
      if (!panel) {
        panel = root.document.createElement('div'); panel.dataset.liveKey = `process-${name}-panel`; feed.append(panel);
      }
      panel.className = `conversation-process-panel conversation-process-${name}`;
      panel.id = `conversation-process-${key}-${name}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-label', name === 'progress' ? t('进展', 'Progress') : t('工具', 'Tools'));
      if (name === 'progress') {
        const timeline = direct(feed, '.progress-timeline');
        if (timeline) panel.append(timeline);
        let notice = direct(panel, '.conversation-reasoning-note');
        const reasoning = message.activities?.some(item => item.kind === 'summary' && typeof item.text === 'string' && item.text.trim());
        if (!message.live && !reasoning && counts.tools) {
          if (!notice) { notice = root.document.createElement('p'); notice.className = 'conversation-reasoning-note'; notice.dataset.liveKey = 'reasoning-note'; panel.append(notice); }
          notice.textContent = t('本轮没有已记录的思考内容。工具的输入、返回结果和错误保留在“工具”中。', 'No reasoning content was recorded for this turn. Tool inputs, results and errors are available under Tools.');
        } else notice?.remove();
      } else {
        const ledger = root.ToolScheduler?.card(run, { embedded: true });
        panel.replaceChildren(...(ledger ? [ledger] : []));
        const empty = root.document.createElement('p'); empty.className = 'conversation-tools-empty';
        empty.dataset.liveKey = 'tools-empty'; empty.hidden = true;
        empty.textContent = t('当前没有失败、超时或中断的工具调用。可切换到“全部工具”查看记录。', 'No failed, timed-out, or interrupted tool calls. Choose All tools to view the history.');
        panel.append(empty);
      }
    }
    select(wrapper, chooseView(message, run));
    return feed;
  }
  root.ConversationProcess = { compose, chooseView, select, filterTools, hasFlow, flowEntries, flowKey, preview };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ConversationProcess;
})(typeof globalThis !== 'undefined' ? globalThis : this);
