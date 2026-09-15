(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationRunHistory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const statuses = { running: '执行中', 'awaiting-approval': '等待审批', completed: '已完成', 'completed-local': '已完成 · 本地', 'completed-local-fallback': '已完成 · 本地', failed: '执行失败', cancelled: '已停止', rejected: '已拒绝', interrupted: '已中断' };
  const statusLabel = value => Object.hasOwn(statuses, value) ? statuses[value] : (value ? `状态：${text(value)}` : '未记录状态');
  const stamp = value => { const number = typeof value === 'number' || /^\d+$/.test(text(value)) ? Number(value) : Date.parse(value); return Number.isFinite(number) && Number.isFinite(new Date(number).getTime()) ? number : 0; };
  const date = value => { const number = stamp(value); return number ? new Date(number).toLocaleString('zh-CN') : '未记录'; };
  function trashIds(state) {
    const runs = new Set(), conversations = new Set();
    array(state.trash).forEach(entry => {
      [...array(entry?.data?.runs), ...array(entry?.data?.agentRuns)].forEach(run => { if (run?.id) runs.add(run.id); });
      array(entry?.data?.conversations).forEach(conversation => { if (conversation?.id) conversations.add(conversation.id); });
    });
    return { runs, conversations };
  }
  function queryRuns(state, options = {}) {
    const trash = trashIds(state);
    const conversations = new Map(array(state.conversations).filter(Boolean).map(item => [item.id, item]));
    const query = text(options.query).trim().toLocaleLowerCase();
    return array(state.agentRuns).filter(run => {
      const conversation = conversations.get(run?.conversationId);
      if (!run?.id || run.deletedAt || trash.runs.has(run.id) || trash.conversations.has(run.conversationId) || conversation?.deletedAt) return false;
      if (query && !text(run.goal).toLocaleLowerCase().includes(query)) return false;
      if (options.status && options.status !== 'all') {
        if (options.status === 'completed') return ['completed', 'completed-local', 'completed-local-fallback'].includes(run.status);
        if (run.status !== options.status) return false;
      }
      return true;
    }).slice().sort((a, b) => stamp(b.startedAt) - stamp(a.startedAt) || text(a.id).localeCompare(text(b.id)));
  }
  function conversationFor(state, run) {
    const conversation = array(state.conversations).find(item => item?.id === run?.conversationId);
    const trash = trashIds(state);
    if (!conversation || conversation.deletedAt || trash.conversations.has(conversation.id)) return { active: false, label: '原对话已不可用', conversation: null };
    if (conversation.archived) return { active: false, label: '原对话已归档 · 仅查看历史', conversation };
    const project = array(state.projects).find(item => item?.id === conversation.projectId);
    if (conversation.projectId && (!project || project.archived || project.deletedAt)) return { active: false, label: '原对话所属项目已归档或不可用 · 仅查看历史', conversation };
    return { active: true, label: text(conversation.title) || '未命名对话', conversation };
  }
  const terminalStatuses = new Set(['completed', 'completed-local', 'completed-local-fallback', 'failed', 'cancelled', 'rejected', 'interrupted']);
  const canDeleteRun = run => !!run?.id && !run.deletedAt && terminalStatuses.has(run.status);
  function deletionPlan(state, ids, expected) {
    const selected = [...new Set(array(ids))];
    if (!selected.length || selected.some(id => typeof id !== 'string' || !id)) throw new Error('请先选择要删除的执行日志。');
    const visible = new Set(queryRuns(state).map(run => run.id));
    return selected.map(id => {
      const matches = array(state.agentRuns).filter(run => run?.id === id);
      if (matches.length !== 1 || !visible.has(id)) throw new Error('记录已变化或不再可用，请刷新后重新选择。');
      const run = matches[0];
      if (!canDeleteRun(run)) throw new Error('执行中、待审批或尚未确认结束的记录不能删除。');
      if (expected && expected.get(id) !== JSON.stringify(run)) throw new Error('待删除记录已有更新，请重新查看并确认。');
      return run;
    });
  }
  function createController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.openConversation !== 'function') throw new Error('执行历史需要 getState 和 openConversation 接口。');
    const doc = environment.document;
    let dialog, search, filter, list, detail, count, openButton, previousFocus, bulk, allCheckbox, selectionCount, deleteSelected, clearSelected;
    let confirmDialog, confirmList, confirmHeading, confirmStatus, confirmButton, cancelDelete, confirmFocus;
    let selectedId = null, shown = 80, composing = false, saving = false, pendingDelete = null;
    const checked = new Set();
    const writable = typeof hooks.save === 'function';
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (value, className, action) => { const node = element('button', className, value); node.type = 'button'; node.addEventListener('click', action); return node; };
    const close = () => { if (saving) return; if (confirmDialog?.open) confirmDialog.close(); if (dialog?.open) dialog.close(); };
    const currentRun = () => queryRuns(hooks.getState()).find(run => run.id === selectedId);
    function renderDetail() {
      detail.replaceChildren(); const state = hooks.getState(), run = currentRun();
      dialog.dataset.detail = run ? 'true' : 'false';
      if (!run) { detail.append(element('p', 'run-history-empty', selectedId ? '该记录已移入回收站或不再可用。' : '选择一条记录，查看本次执行的目标、步骤与结果。')); selectedId = null; return; }
      const heading = element('div', 'run-history-detail-heading');
      heading.append(button('← 返回列表', 'run-history-back', () => { selectedId = null; renderDetail(); list.focus(); }), element('h3', '', text(run.goal) || '未记录执行目标'));
      detail.append(heading);
      const grid = element('dl', 'run-history-meta');
      const field = (label, value) => { const pair = element('div'); pair.append(element('dt', '', label), element('dd', '', text(value) || '未记录')); grid.append(pair); };
      const model = run.modelConfig || {};
      field('状态', statusLabel(run.status)); field('模型', model.model || run.model);
      field('连接', model.provider === 'openai-auth' ? 'OpenAI 账号' : model.provider === 'api' ? '自定义 API' : model.provider || '未记录');
      field('推理强度', model.effort || run.effort || '模型默认'); field('开始时间', date(run.startedAt)); field('结束时间', date(run.finishedAt || run.completedAt));
      const projects = [...new Set([...array(run.projectIds), ...(run.projectId ? [run.projectId] : [])])].map(id => array(state.projects).find(item => item?.id === id)?.name || `项目 ${text(id)}（已不可用）`);
      field('空间 / 项目', [run.workspace || run.contextWorkspace, ...projects].filter(Boolean).join(' / ') || '未记录');
      const original = conversationFor(state, run); field('原对话', original.active ? original.label : `${original.conversation?.title || ''}${original.conversation?.title ? ' · ' : ''}${original.label}`);
      detail.append(grid);
      const section = (title, values, empty, className = '') => {
        const region = element('section', `run-history-section ${className}`); region.append(element('h4', '', title));
        if (!values.length) region.append(element('p', 'run-history-muted', empty));
        else { const rows = element('ol'); values.forEach(value => rows.append(element('li', '', value))); region.append(rows); }
        detail.append(region);
      };
      section('执行步骤', array(run.steps).filter(Boolean).map(step => typeof step === 'string' ? step : `${({ done: '已完成', running: '进行中', error: '失败', failed: '失败', pending: '等待' }[step.status] || text(step.status) || '已记录')} · ${text(step.text || step.label || step.title)}`), '这次执行没有记录步骤。');
      const toolCard=root.ToolScheduler?.card(run);if(toolCard)detail.append(toolCard);
      if (run.error) section('错误信息', [text(run.error)], '', 'run-history-error');
      const types = { project: '项目', task: '任务', note: '知识', import: '资料', paper: '论文' };
      section(`执行结果 · ${array(run.results).filter(Boolean).length} 项`, array(run.results).filter(Boolean).map(result => typeof result === 'string' ? result : `${types[result.type] || '结果'} · ${text(result.text || result.title || result.name || result.id) || '已记录'}`), run.status === 'awaiting-approval' ? '尚未执行。请回到原对话查看待审批计划。' : '没有写入结果记录。');
      const actions = element('div', 'run-history-detail-actions');
      openButton = button(original.active ? '打开原对话' : '原对话不可直接打开', 'run-history-button run-history-primary', openOriginal); openButton.disabled = !original.active;
      if (!original.active) actions.append(element('p', 'run-history-muted', original.label));
      const remove = button('删除这条日志', 'run-history-button run-history-danger', () => requestDelete([run.id]));
      remove.id = 'runHistoryDeleteOne'; remove.disabled = !writable || !canDeleteRun(run) || saving;
      remove.title = canDeleteRun(run) ? '仅删除本机执行日志，保留对话与成果' : '执行中、待审批或尚未确认结束的记录不能删除';
      actions.append(remove, openButton); detail.append(actions);
    }
    function renderList() {
      const state = hooks.getState(); const runs = queryRuns(state, { query: search.value, status: filter.value });
      const total = queryRuns(state).length;
      count.textContent = search.value.trim() || filter.value !== 'all' ? `${runs.length} / ${total} 条记录` : `${total} 条记录 · 包含已归档对话`;
      const selectable = runs.filter(canDeleteRun), available = new Set(selectable.map(run => run.id));
      for (const id of checked) if (!available.has(id)) checked.delete(id);
      allCheckbox.disabled = !writable || !selectable.length || saving;
      allCheckbox.checked = !!selectable.length && selectable.every(run => checked.has(run.id));
      allCheckbox.indeterminate = checked.size > 0 && !allCheckbox.checked;
      selectionCount.textContent = checked.size ? `已选 ${checked.size} 条` : '仅已结束的本机日志可删除';
      deleteSelected.textContent = checked.size ? `删除所选 (${checked.size})` : '删除所选';
      deleteSelected.disabled = !writable || !checked.size || saving; clearSelected.disabled = !checked.size || saving;
      list.replaceChildren();
      if (!runs.length) list.append(element('p', 'run-history-empty', total ? '没有匹配记录。试试其他关键词或状态。' : '还没有执行记录。发起一次工作流后，会在这里留下历史。'));
      runs.slice(0, shown).forEach(run => {
        const original = conversationFor(state, run);
        const row = button('', 'run-history-row', () => { selectedId = run.id; renderList(); renderDetail(); detail.focus(); });
        row.setAttribute('aria-pressed', String(selectedId === run.id)); row.dataset.runId = text(run.id);
        row.append(element('strong', '', text(run.goal) || '未记录执行目标'), element('span', '', `${statusLabel(run.status)} · ${date(run.startedAt)}`));
        row.append(element('small', '', original.label));
        const item = element('div', 'run-history-item'); item.dataset.selected = String(checked.has(run.id));
        const label = element('label', 'run-history-select'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.selectRun = run.id;
        checkbox.setAttribute('aria-label', `选择执行日志：${text(run.goal) || '未记录执行目标'}`); checkbox.checked = checked.has(run.id); checkbox.disabled = !writable || !canDeleteRun(run) || saving;
        label.title = canDeleteRun(run) ? '选择这条执行日志' : '执行中、待审批或尚未确认结束的记录不能删除';
        checkbox.addEventListener('change', () => { if (saving) return; if (checkbox.checked) checked.add(run.id); else checked.delete(run.id); renderList(); });
        label.append(checkbox); item.append(label, row); list.append(item);
      });
      if (runs.length > shown) list.append(button(`再显示 ${Math.min(80, runs.length - shown)} 条`, 'run-history-button run-history-more', () => { shown += 80; renderList(); }));
    }
    function refresh() { shown = 80; renderList(); renderDetail(); }
    function requestDelete(ids) {
      if (!writable || saving) return false;
      let runs;
      try { runs = deletionPlan(hooks.getState(), ids); }
      catch (error) { hooks.toast?.(error.message); refresh(); return false; }
      pendingDelete = new Map(runs.map(run => [run.id, JSON.stringify(run)]));
      confirmHeading.textContent = `永久删除 ${runs.length} 条执行日志？`;
      confirmList.replaceChildren();
      runs.slice(0, 6).forEach(run => confirmList.append(element('li', '', text(run.goal) || '未记录执行目标')));
      if (runs.length > 6) confirmList.append(element('li', 'run-history-muted', `以及另外 ${runs.length - 6} 条已选日志`));
      confirmStatus.textContent = ''; confirmButton.textContent = `永久删除 ${runs.length} 条日志`;
      confirmFocus = doc.activeElement; if (!confirmDialog.open) confirmDialog.showModal(); cancelDelete.focus(); return true;
    }
    function busy(value) {
      saving = value; confirmButton.disabled = value; cancelDelete.disabled = value;
      confirmDialog.setAttribute('aria-busy', String(value));
      if (value) confirmButton.textContent = '正在删除…';
    }
    async function confirmDeletion(event) {
      event?.preventDefault(); if (saving || !pendingDelete) return false;
      const state = hooks.getState(); let targets;
      try { targets = deletionPlan(state, [...pendingDelete.keys()], pendingDelete); }
      catch (error) { confirmStatus.textContent = error.message; confirmButton.disabled = true; refresh(); return false; }
      const targetIds = new Set(targets.map(run => run.id));
      const before = array(state.agentRuns), removed = before.map((run, index) => ({ run, index })).filter(item => targetIds.has(item.run?.id));
      const after = before.filter(run => !targetIds.has(run?.id)); state.agentRuns = after; busy(true);
      try {
        const result = await hooks.save();
        if (result === false) throw new Error('本机保存未成功。');
      } catch (error) {
        // A new run may be appended while saving. Preserve it, and never undo a
        // separate transaction (such as deleting a conversation) replacing the array.
        const current = hooks.getState(); let restored = false;
        if (current === state && current.agentRuns === after) {
          removed.forEach(({ run, index }) => { if (!after.some(item => item?.id === run.id)) after.splice(Math.min(index, after.length), 0, run); });
          restored = true;
        }
        busy(false); confirmButton.textContent = `重试删除 ${targets.length} 条日志`;
        confirmStatus.textContent = restored ? `删除未保存，日志已保留。${error.message || '请稍后重试。'}` : '删除未保存，期间工作区已有其他变更。请关闭确认框并刷新检查；未覆盖其他操作。';
        if (!restored) confirmButton.disabled = true;
        refresh(); return false;
      }
      targets.forEach(run => checked.delete(run.id)); if (targetIds.has(selectedId)) selectedId = null;
      busy(false); pendingDelete = null; confirmDialog.close(); refresh();
      hooks.renderAll?.(); hooks.toast?.(`已删除 ${targets.length} 条本机执行日志，对话与成果均保留。`); return true;
    }
    function mountConfirmation() {
      confirmDialog = element('dialog', 'run-history-confirm'); confirmDialog.id = 'runHistoryDeleteDialog'; confirmDialog.setAttribute('aria-labelledby', 'runHistoryDeleteTitle'); confirmDialog.setAttribute('aria-describedby', 'runHistoryDeleteDescription');
      const form = element('form'); form.addEventListener('submit', confirmDeletion);
      const mark = element('div', 'run-history-delete-mark', '×'); mark.setAttribute('aria-hidden', 'true');
      confirmHeading = element('h2'); confirmHeading.id = 'runHistoryDeleteTitle';
      const description = element('p', '', '仅清除这台设备上的执行日志，无法恢复。对应聊天消息、任务、笔记、项目与资料全部保留，不会删除云端内容。'); description.id = 'runHistoryDeleteDescription';
      confirmList = element('ul', 'run-history-delete-list');
      const hint = element('p', 'run-history-delete-hint', '执行中、等待审批的记录不可删除。删除日志后，仍可在原对话与各空间查看成果。');
      confirmStatus = element('p', 'run-history-delete-status'); confirmStatus.id = 'runHistoryDeleteStatus'; confirmStatus.setAttribute('role', 'status'); confirmStatus.setAttribute('aria-live', 'polite');
      const footer = element('div', 'run-history-delete-footer'); cancelDelete = button('保留日志', 'run-history-button', () => { if (!saving) confirmDialog.close(); }); cancelDelete.id = 'runHistoryDeleteCancel';
      confirmButton = element('button', 'run-history-button run-history-destructive', '永久删除日志'); confirmButton.id = 'runHistoryDeleteConfirm'; confirmButton.type = 'submit'; footer.append(cancelDelete, confirmButton);
      form.append(mark, confirmHeading, description, confirmList, hint, confirmStatus, footer); confirmDialog.append(form); doc.body.append(confirmDialog);
      confirmDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      confirmDialog.addEventListener('close', () => { pendingDelete = null; if (dialog.open) (confirmFocus?.isConnected ? confirmFocus : search).focus?.({ preventScroll: true }); });
    }
    function openOriginal() {
      const state = hooks.getState(), run = currentRun(), original = run && conversationFor(state, run);
      if (!original?.active) { hooks.toast?.(original?.label || '该记录或原对话已不可用。'); renderList(); renderDetail(); return false; }
      const id = original.conversation.id; close(); hooks.openConversation(id); return true;
    }
    function mount() {
      if (dialog) return;
      dialog = element('dialog', 'run-history'); dialog.id = 'runHistoryDialog'; dialog.setAttribute('aria-labelledby', 'runHistoryTitle'); dialog.dataset.detail = 'false';
      const header = element('header', 'run-history-header'), copy = element('div'), title = element('h2', '', '执行历史'); title.id = 'runHistoryTitle';
      copy.append(title, element('p', '', '追溯每次工作的目标、过程与结果。历史记录不会触发新的执行。'));
      const headerActions = element('div', 'run-history-header-actions'); const reload = button('刷新', 'run-history-button', refresh), dismiss = button('×', 'run-history-close', close); dismiss.setAttribute('aria-label', '关闭执行历史'); headerActions.append(reload, dismiss); header.append(copy, headerActions);
      const controls = element('div', 'run-history-controls'); search = element('input'); search.id = 'runHistorySearch'; search.type = 'search'; search.placeholder = '搜索执行目标…'; search.setAttribute('aria-label', '搜索执行目标'); search.autocomplete = 'off';
      filter = element('select'); filter.id = 'runHistoryStatus'; filter.setAttribute('aria-label', '按执行状态筛选');
      [['all', '全部状态'], ['running', '执行中'], ['awaiting-approval', '等待审批'], ['completed', '已完成（含本地）'], ['failed', '执行失败'], ['cancelled', '已停止'], ['rejected', '已拒绝'], ['interrupted', '已中断']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; filter.append(option); });
      controls.append(search, filter); count = element('p', 'run-history-count'); count.setAttribute('aria-live', 'polite');
      const body = element('div', 'run-history-body'); list = element('div', 'run-history-list'); list.setAttribute('aria-label', '执行记录列表'); list.tabIndex = -1; detail = element('article', 'run-history-detail'); detail.setAttribute('aria-label', '执行记录详情'); detail.tabIndex = -1; body.append(list, detail);
      bulk = element('div', 'run-history-bulk');
      const allLabel = element('label', 'run-history-select-all'); allCheckbox = element('input'); allCheckbox.type = 'checkbox'; allCheckbox.id = 'runHistorySelectAll'; allLabel.append(allCheckbox, element('span', '', '全选筛选结果')); allLabel.title = '选择当前筛选中的所有已结束记录，包括尚未展开的记录';
      allCheckbox.addEventListener('change', () => {
        if (!writable || saving) return;
        const runs = queryRuns(hooks.getState(), { query: search.value, status: filter.value }).filter(canDeleteRun);
        if (allCheckbox.checked) runs.forEach(run => checked.add(run.id)); else checked.clear(); renderList();
      });
      selectionCount = element('span', 'run-history-selection-count'); selectionCount.setAttribute('aria-live', 'polite');
      clearSelected = button('取消选择', 'run-history-button run-history-clear', () => { if (!saving) { checked.clear(); renderList(); } }); clearSelected.id = 'runHistoryClearSelection';
      deleteSelected = button('删除所选', 'run-history-button run-history-danger', () => requestDelete([...checked])); deleteSelected.id = 'runHistoryDeleteSelected';
      bulk.append(allLabel, selectionCount, clearSelected, deleteSelected);
      dialog.append(header, controls, count, bulk, body); doc.body.append(dialog); mountConfirmation();
      search.addEventListener('compositionstart', () => { composing = true; });
      search.addEventListener('compositionend', () => { composing = false; shown = 80; renderList(); });
      search.addEventListener('input', event => { if (!composing && !event.isComposing) { shown = 80; renderList(); } });
      filter.addEventListener('change', () => { shown = 80; renderList(); });
      dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
      dialog.addEventListener('close', () => previousFocus?.focus?.({ preventScroll: true }));
    }
    function open() {
      if (saving) return false; mount(); if (!dialog.open) previousFocus = doc.activeElement;
      selectedId = null; checked.clear(); search.value = ''; filter.value = 'all'; refresh();
      if (!dialog.open) dialog.showModal(); search.focus();
    }
    return { open, close, refresh, openOriginal };
  }
  let controller;
  return { queryRuns, conversationFor, statusLabel, canDeleteRun, deletionPlan, createController,
    init(hooks) { controller ||= createController(hooks); return this; },
    open() { if (!controller) throw new Error('请先初始化执行历史。'); controller.open(); },
    close() { controller?.close(); }
  };
}));
