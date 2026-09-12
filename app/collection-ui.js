/* Reusable CMS collection backed by the current persistent workspace. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollectionUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  let hooks = {};
  const stateByContainer = new WeakMap();
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ws = value => value === '课程' || value === '科研' ? value : '日常';
  const typeLabels = { task: '任务', note: '知识', import: '资料', paper: '论文' };
  const statusLabels = { todo: '待开始', in_progress: '进行中', done: '已完成', blocked: '受阻' };
  const getState = () => hooks.getState?.() || {};
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const itemKey = item => `${item._type}:${item.id}`;
  const timestamp = value => {
    if (value === null || value === undefined || value === '') return 0;
    const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    return Number.isFinite(number) && Number.isFinite(new Date(number).getTime()) ? number : 0;
  };
  const svg = kind => {
    const paths = { task: '<path d="M5 6h14M5 12h14M5 18h9"/>', note: '<path d="M6 3h9l3 3v15H6zM9 11h6M9 15h6"/>', paper: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/>', import: '<path d="M6 3h9l3 3v15H6zM15 3v4h3"/>' };
    return `<svg class="collection-icon ${kind}" viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.import}</svg>`;
  };
  function stateFor(container) {
    if (!stateByContainer.has(container)) stateByContainer.set(container, { query: '', type: 'all', sort: 'updated', dir: 'desc', view: 'list', selected: new Set(), options: {}, scope: '', composing: false, busy: false, filterKey: '', collapsed: new Set() });
    return stateByContainer.get(container);
  }
  function visible(record, options = {}, projects = new Map(list(getState().projects).map(project => [project.id, project]))) {
    if (!record || !record.id || record.archived || record.deletedAt) return false;
    if (options.projectId && record.projectId !== options.projectId) return false;
    const project = record.projectId && projects.get(record.projectId);
    if (project?.archived || project?.deletedAt) return false;
    return !options.workspace || ws(project?.workspace || record.workspace) === ws(options.workspace);
  }
  function records(options = {}) {
    const state = getState(); const projects = new Map(list(state.projects).map(project => [project.id, project]));
    const output = [];
    for (const [collection, type] of [['tasks', 'task'], ['notes', 'note'], ['imports', 'import'], ['papers', 'paper']]) {
      for (const item of list(state[collection])) {
        if (!visible(item, options, projects)) continue;
        const project = projects.get(item.projectId);
        const analysis = type === 'import' ? hooks.getAnalysis?.(item) || { status: 'pending', label: '待 AI 分析', detail: '原件已保存，尚未生成分析成果。' } : null;
        const meta = type === 'task' ? (statusLabels[item.status] || '待开始') : type === 'paper' ? (item.reviewed ? '已审阅' : '待审阅') : type === 'note' ? (item.kind || '知识') : (analysis.label || (analysis.status === 'analyzed' ? '已分析' : '待 AI 分析'));
        output.push({ ...item, _type: type, _title: item.title || item.name || item.originalName || `未命名${typeLabels[type]}`, _updated: timestamp(item.updatedAt) || timestamp(item.createdAt), _meta: meta, _analysis: analysis, _projectName: project?.name || item.project || (item.workspace === '科研' ? '独立科研资料' : '未归属项目') });
      }
    }
    return output;
  }
  function filteredItems(items, ui) {
    const query = String(ui.query || '').trim().toLocaleLowerCase();
    return items.filter(item => (ui.type === 'all' || item._type === ui.type || (ui.type === 'pending-analysis' && item._type === 'import' && item._analysis?.status === 'pending')) && (!query || `${item._title} ${item._meta} ${item._projectName} ${item.folderPath || ''} ${list(item.tags).join(' ')}`.toLocaleLowerCase().includes(query))).sort((a, b) => {
      const comparison = ui.sort === 'name' ? collator.compare(a._title, b._title) : ui.sort === 'type' ? collator.compare(typeLabels[a._type], typeLabels[b._type]) : a._updated - b._updated;
      return comparison * (ui.dir === 'asc' ? 1 : -1) || collator.compare(a._title, b._title) || itemKey(a).localeCompare(itemKey(b));
    });
  }
  function displayItems(items, ui) {
    if (ui.view !== 'tree' || ui.type === 'paper') return items;
    const notes = new Set(items.filter(item => item._type === 'note').map(item => item.id));
    return items.filter(item => item._type !== 'paper' || !notes.has(item.noteId));
  }
  function treeGroups(items, options = {}) {
    const root = { children: new Map(), items: [], count: 0 };
    for (const item of items) {
      const folders = String(item.folderPath || '').split(/[\\/]/).map(part => part.trim()).filter(part => part && part !== '.' && part !== '..').slice(0, 12);
      const owner = options.projectId ? [] : [item._projectName];
      const parts = [...owner, ...(folders.length ? folders : [item._type === 'task' ? '任务' : item._type === 'import' ? '原始资料' : '笔记'])];
      let node = root; node.count++;
      for (const part of parts) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), items: [], count: 0 });
        node = node.children.get(part); node.count++;
      }
      node.items.push(item);
    }
    return root;
  }
  async function mergeSelected(container) {
    const ui = stateFor(container); if (ui.busy || typeof hooks.mergeNotes !== 'function') return false;
    const chosen = selectedRecords(ui); if (chosen.length < 2 || chosen.some(item => item._type !== 'note')) return false;
    const filterKey = ui.filterKey; ui.busy = true; rerender(container);
    try {
      const merged = await hooks.mergeNotes(chosen.map(item => item.id));
      if (merged && ui.filterKey === filterKey) ui.selected.clear();
      return !!merged;
    } catch (error) { hooks.toast?.(error.message || '合并未完成'); return false; }
    finally { ui.busy = false; rerender(container); }
  }
  function setSelectedCompletion(selected, options, done, now = Date.now()) {
    const allowed = new Set(records(options).filter(item => item._type === 'task').map(itemKey));
    let count = 0;
    for (const task of list(getState().tasks)) {
      const key = itemKey({ ...task, _type: 'task' });
      if (!selected.has(key) || !allowed.has(key) || (task.status === 'done') === done) continue;
      task.status = done ? 'done' : 'todo'; task.updatedAt = now;
      if (done) task.completedAt = now; else delete task.completedAt;
      count += 1;
    }
    return count;
  }
  function completeSelected(selected, options, now = Date.now()) { return setSelectedCompletion(selected, options, true, now); }
  function selectedRecords(ui, keys = ui.selected) { return displayItems(filteredItems(records(ui.options), ui), ui).filter(item => keys.has(itemKey(item))); }
  async function deleteRecords(container, singleKey) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui, singleKey ? new Set([singleKey]) : ui.selected);
    if (!chosen.length) { hooks.toast?.('所选内容已变化，请重新选择。'); rerender(container); return false; }
    if (typeof hooks.deleteItems !== 'function') { hooks.toast?.('删除操作暂不可用，请重新打开应用。'); return false; }
    const options = { workspace: ui.options.workspace, projectId: ui.options.projectId }, filterKey = ui.filterKey;
    const selections = chosen.map(item => ({ type: item._type, id: item.id }));
    ui.busy = true; rerender(container);
    try {
      const deleted = (await hooks.deleteItems(selections, options)) === true;
      if (deleted && ui.filterKey === filterKey) ui.selected.clear();
      return deleted;
    } catch (error) { hooks.toast?.(`未能移入回收站：${error?.message || '请重试'}`); return false; }
    finally {
      ui.busy = false; rerender(container);
      if (ui.filterKey === filterKey && (!container.getClientRects || container.getClientRects().length)) {
        const row = singleKey ? [...(container.querySelectorAll?.('[data-cui-key]') || [])].find(node => node.dataset.cuiKey === singleKey) : null;
        const target = row?.querySelector('[data-cui-delete]') || container.querySelector('[data-cui-delete-selected]') || container.querySelector('[data-cui-search]');
        target?.focus?.({ preventScroll: true });
      }
    }
  }
  async function changeCompletion(container, done) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui).filter(item => item._type === 'task' && (item.status === 'done') !== done);
    if (!chosen.length) return false;
    const keys = new Set(chosen.map(itemKey)), filterKey = ui.filterKey;
    const changes = list(getState().tasks).filter(task => keys.has(itemKey({ ...task, _type: 'task' }))).map(task => ({ task, previous: { status: task.status, updatedAt: task.updatedAt, completedAt: task.completedAt } }));
    const count = setSelectedCompletion(keys, ui.options, done);
    changes.forEach(change => { change.after = { status: change.task.status, updatedAt: change.task.updatedAt, completedAt: change.task.completedAt }; });
    ui.busy = true; rerender(container);
    try {
      if ((await hooks.save?.()) === false) throw new Error('保存没有成功');
      if (ui.filterKey === filterKey) ui.selected.clear();
      hooks.renderAll?.(); hooks.toast?.(done ? `已完成 ${count} 个任务` : `已将 ${count} 个任务标为未完成`); return true;
    } catch (error) {
      for (const change of changes) {
        const latest = list(getState().tasks).find(task => task.id === change.task.id);
        if (!latest || !Object.keys(change.after).every(key => latest[key] === change.after[key])) continue;
        for (const [key, value] of Object.entries(change.previous)) { if (value === undefined) delete latest[key]; else latest[key] = value; }
      }
      hooks.toast?.(`任务状态未保存：${error?.message || '请重试'}`); return false;
    } finally { ui.busy = false; rerender(container); }
  }
  async function analyzeSelected(container) {
    const ui = stateFor(container); if (ui.busy) return false;
    const chosen = selectedRecords(ui).filter(item => item._type === 'import');
    if (!chosen.length) { hooks.toast?.('所选资料已变化，请重新选择。'); rerender(container); return false; }
    if (typeof hooks.analyzeImports !== 'function') { hooks.toast?.('分析入口暂不可用，请重新打开应用。'); return false; }
    const filterKey = ui.filterKey, keys = chosen.map(itemKey);
    const ids = chosen.map(item => item.id), options = { workspace: ui.options.workspace, projectId: ui.options.projectId };
    ui.busy = true; rerender(container);
    try {
      // The host only stages this exact set of originals in a conversation.
      // Selecting this action never calls the model or claims analysis exists.
      const prepared = (await hooks.analyzeImports(ids, options)) === true;
      if (prepared && ui.filterKey === filterKey) keys.forEach(key => ui.selected.delete(key));
      return prepared;
    } catch (error) { hooks.toast?.(`未能准备分析对话：${error?.message || '请重试'}`); return false; }
    finally { ui.busy = false; rerender(container); }
  }
  function openRecord(record) {
    const opener = { task: hooks.openTask, note: hooks.openNote, import: hooks.openImport, paper: hooks.openPaper }[record._type];
    opener?.(record.id);
  }
  function rerender(container, preserveSearch = false) {
    const input = preserveSearch ? container.querySelector('[data-cui-search]') : null;
    const start = input?.selectionStart; const end = input?.selectionEnd;
    render(container, stateFor(container).options);
    if (input) {
      const replacement = container.querySelector('[data-cui-search]');
      replacement?.focus({ preventScroll: true });
      if (Number.isInteger(start)) replacement?.setSelectionRange(start, end);
    }
  }
  function bind(container) {
    if (container.dataset.cuiBound) return;
    container.dataset.cuiBound = '1';
    container.addEventListener('toggle', event => {
      const folder = event.target;
      if (!folder.matches?.('[data-cui-folder]') || !container.contains?.(folder)) return;
      const ui = stateFor(container); if (ui.query.trim()) return;
      folder.open ? ui.collapsed.delete(folder.dataset.cuiFolder) : ui.collapsed.add(folder.dataset.cuiFolder);
    }, true);
    container.addEventListener('compositionstart', event => { if (event.target.matches('[data-cui-search]')) stateFor(container).composing = true; });
    container.addEventListener('compositionend', event => {
      if (!event.target.matches('[data-cui-search]')) return;
      const ui = stateFor(container); ui.composing = false; ui.query = event.target.value; rerender(container, true);
    });
    container.addEventListener('input', event => {
      if (!event.target.matches('[data-cui-search]')) return;
      const ui = stateFor(container); if (ui.busy) return; ui.query = event.target.value;
      if (!ui.composing && !event.isComposing) rerender(container, true);
    });
    container.addEventListener('change', event => {
      const ui = stateFor(container);
      if (ui.busy) return;
      if (event.target.matches('[data-cui-type]')) ui.type = event.target.value;
      else if (event.target.matches('[data-cui-check]')) {
        const row = event.target.closest('[data-cui-key]'); if (!row) return;
        event.target.checked ? ui.selected.add(row.dataset.cuiKey) : ui.selected.delete(row.dataset.cuiKey);
      } else if (event.target.matches('[data-cui-all]')) {
        displayItems(filteredItems(records(ui.options), ui), ui).forEach(item => event.target.checked ? ui.selected.add(itemKey(item)) : ui.selected.delete(itemKey(item)));
      } else return;
      rerender(container);
    });
    container.addEventListener('click', async event => {
      const ui = stateFor(container); const button = event.target.closest('[data-cui-open]');
      if (event.target.closest('[data-cui-delete]')) {
        const row = event.target.closest('[data-cui-key]');
        if (row) return deleteRecords(container, row.dataset.cuiKey); return;
      }
      if (event.target.closest('[data-cui-delete-selected]')) return deleteRecords(container);
      if (ui.busy) return;
      if (button && !event.target.closest('[data-cui-check]')) {
        const row = button.closest('[data-cui-key]'); const item = records(ui.options).find(record => itemKey(record) === row?.dataset.cuiKey);
        if (item) openRecord(item); return;
      }
      const projectButton = event.target.closest('[data-cui-project]');
      if (projectButton) { hooks.openProject?.(projectButton.dataset.cuiProject); return; }
      if (event.target.closest('[data-cui-sort]')) {
        const sequence = [['updated', 'desc'], ['updated', 'asc'], ['name', 'asc'], ['name', 'desc'], ['type', 'asc']];
        const index = sequence.findIndex(([key, direction]) => key === ui.sort && direction === ui.dir);
        [ui.sort, ui.dir] = sequence[(index + 1) % sequence.length];
      } else if (event.target.closest('[data-cui-view]')) ui.view = event.target.closest('[data-cui-view]').dataset.cuiView;
      else if (event.target.closest('[data-cui-clear]')) ui.selected.clear();
      else if (event.target.closest('[data-cui-complete]')) return changeCompletion(container, true);
      else if (event.target.closest('[data-cui-reopen]')) return changeCompletion(container, false);
      else if (event.target.closest('[data-cui-merge]')) return mergeSelected(container);
      else if (event.target.closest('[data-cui-analyze-selected]')) return analyzeSelected(container);
      else return;
      rerender(container);
    });
  }
  function render(container, options = {}) {
    if (!container) return;
    const ui = stateFor(container); const scope = `${options.workspace || ''}:${options.projectId || ''}`;
    if (ui.scope !== scope) { ui.query = ''; ui.type = 'all'; ui.selected.clear(); ui.composing = false; ui.collapsed.clear(); ui.view = options.defaultView || 'list'; }
    ui.scope = scope; ui.options = { ...options };
    ui.filterKey = `${scope}\u0000${ui.type}\u0000${ui.query.trim()}`;
    if (ui.composing) return; // Preserve the IME composition node during background saves.
    const allItems = records(ui.options); const items = displayItems(filteredItems(allItems, ui), ui);
    const keys = new Set(items.map(itemKey)); ui.selected = new Set([...ui.selected].filter(key => keys.has(key)));
    const selected = ui.selected; const allChecked = items.length > 0 && items.every(item => selected.has(itemKey(item)));
    const disabled = ui.busy ? 'disabled' : '';
    const doneCount = items.filter(item => item._type === 'task' && item.status === 'done' && selected.has(itemKey(item))).length;
    const pendingCount = items.filter(item => item._type === 'task' && item.status !== 'done' && selected.has(itemKey(item))).length;
    const noteCount = items.filter(item => item._type === 'note' && selected.has(itemKey(item))).length;
    const importCount = items.filter(item => item._type === 'import' && selected.has(itemKey(item))).length;
    const toolbar = `<div class="collection-toolbar"><label class="collection-search"><span aria-hidden="true">⌕</span><input data-cui-search ${disabled} value="${esc(ui.query)}" aria-label="搜索工作区内容" placeholder="搜索名称、标签和状态"/></label><select data-cui-type ${disabled} aria-label="类型筛选">${[['all', '全部类型'], ...Object.entries(typeLabels), ['pending-analysis', '待 AI 分析']].map(([type, label]) => `<option value="${type}" ${ui.type === type ? 'selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="collection-sort" data-cui-sort ${disabled} aria-label="切换排序">${ui.sort === 'updated' ? '更新时间' : ui.sort === 'name' ? '名称' : '类型'} ${ui.dir === 'asc' ? '↑' : '↓'}</button><button type="button" class="collection-view-btn ${ui.view === 'tree' ? 'active' : ''}" data-cui-view="tree" ${disabled} aria-label="文件树视图" aria-pressed="${ui.view === 'tree'}">⌘</button><button type="button" class="collection-view-btn ${ui.view === 'list' ? 'active' : ''}" data-cui-view="list" ${disabled} aria-label="列表视图" aria-pressed="${ui.view === 'list'}">☷</button><button type="button" class="collection-view-btn ${ui.view === 'cards' ? 'active' : ''}" data-cui-view="cards" ${disabled} aria-label="卡片视图" aria-pressed="${ui.view === 'cards'}">▦</button><span class="collection-count" role="status">${items.length} 项</span></div>`;
    const checkbox = item => `<label class="collection-check"><input type="checkbox" data-cui-check ${disabled} ${selected.has(itemKey(item)) ? 'checked' : ''} aria-label="选择 ${esc(item._title)}"/><span></span></label>`;
    const project = item => item.projectId ? `<button type="button" class="collection-project" data-cui-project="${esc(item.projectId)}">${esc(item._projectName)}</button>` : `<span class="collection-project">${esc(item._projectName)}</span>`;
    const deleteButton = item => `<button type="button" class="collection-delete" data-cui-delete ${ui.busy || typeof hooks.deleteItems !== 'function' ? 'disabled' : ''} title="移入回收站：${esc(item._title)}" aria-label="移入回收站：${esc(item._title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>`;
    const statusClass = item => item._analysis?.status === 'pending' ? 'analysis-pending' : item._analysis?.status === 'analyzed' || item.status === 'done' || item.reviewed ? 'done' : '';
    const row = item => `<div class="collection-row ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}</b><small>${esc(item.folderPath || typeLabels[item._type])}</small></span></button>${project(item)}<span class="collection-status ${statusClass(item)}" title="${esc(item._analysis?.detail || '')}">${esc(item._meta)}</span><time ${item._updated ? `datetime="${new Date(item._updated).toISOString()}"` : ''}>${item._updated ? new Date(item._updated).toLocaleDateString('zh-CN') : '—'}</time>${deleteButton(item)}</div>`;
    const card = item => `<article class="collection-card ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}</b><small class="collection-status ${statusClass(item)}" title="${esc(item._analysis?.detail || '')}">${esc(item._meta)}</small></span></button>${project(item)}${deleteButton(item)}</article>`;
    const empty = `<div class="collection-empty"><div class="collection-empty-icon">${svg('import')}</div><b>${ui.query.trim() || ui.type !== 'all' ? '没有匹配内容' : '暂无内容'}</b><p>${ui.query.trim() || ui.type !== 'all' ? '调整搜索或筛选条件后再试。' : '添加文件或用 AI 整理后，资料与成果会显示在这里。'}</p></div>`;
    const treeLeaf = item => `<div class="collection-tree-leaf ${selected.has(itemKey(item)) ? 'selected' : ''}" data-cui-key="${esc(itemKey(item))}" data-cui-id="${esc(item.id)}" data-cui-kind="${item._type}">${checkbox(item)}<button type="button" class="collection-main" data-cui-open>${svg(item._type)}<span class="collection-title"><b>${esc(item._title)}${item._type === 'note' && !/\.md$/i.test(item._title) ? '.md' : ''}</b></span></button><small class="collection-status ${statusClass(item)}">${esc(item._type === 'note' ? (item.userEdited ? '已修订' : 'Markdown') : item._meta)}</small>${deleteButton(item)}</div>`;
    function treeHTML(node, path = []) {
      return [...node.children.entries()].sort(([a], [b]) => collator.compare(a,b)).map(([name, child]) => {
        const key = JSON.stringify([...path, name]);
        return `<details class="collection-folder" data-cui-folder="${esc(key)}" ${ui.query.trim() || !ui.collapsed.has(key) ? 'open' : ''}><summary><span class="collection-folder-icon" aria-hidden="true">▱</span><b>${esc(name)}</b><small>${child.count}</small></summary><div class="collection-branch">${treeHTML(child, [...path, name])}</div></details>`;
      }).join('') + node.items.map(treeLeaf).join('');
    }
    const body = items.length ? ui.view === 'tree' ? `<div class="collection-tree"><label class="collection-tree-select"><input type="checkbox" data-cui-all ${disabled} ${allChecked ? 'checked' : ''} aria-label="选择全部可见项"/>选择全部文件 · ${items.length} 项</label>${treeHTML(treeGroups(items, options))}</div>` : ui.view === 'cards' ? `<div class="collection-cards">${items.map(card).join('')}</div>` : `<div class="collection-table"><div class="collection-head"><label><input type="checkbox" data-cui-all ${disabled} ${allChecked ? 'checked' : ''} aria-label="选择全部可见项"/></label><span>名称</span><span>归属项目</span><span>状态</span><span>更新时间</span><span class="collection-actions-label">操作</span></div>${items.map(row).join('')}</div>` : empty;
    const batch = selected.size ? `<div class="collection-batch"><span>已选择 ${selected.size} 项</span>${noteCount > 1 && noteCount === selected.size ? `<button type="button" data-cui-merge ${ui.busy || !hooks.mergeNotes ? 'disabled' : ''}>合并为一篇笔记</button>` : ''}${pendingCount ? `<button type="button" data-cui-complete ${disabled}>标为完成 · ${pendingCount}</button>` : ''}${doneCount ? `<button type="button" data-cui-reopen ${disabled}>标为未完成 · ${doneCount}</button>` : ''}${importCount ? `<button type="button" class="collection-batch-analyze" data-cui-analyze-selected ${ui.busy || typeof hooks.analyzeImports !== 'function' ? 'disabled' : ''}>交给 AI 分析 · ${importCount} 份</button>` : ''}<button type="button" class="collection-batch-delete" data-cui-delete-selected ${ui.busy || typeof hooks.deleteItems !== 'function' ? 'disabled' : ''}>移入回收站</button><button type="button" data-cui-clear ${disabled}>清除选择</button>${importCount ? '<small class="collection-analysis-hint">准备对话与附件，发送指令后才开始分析。</small>' : ''}${ui.busy ? '<small role="status">正在处理，请稍候…</small>' : ''}</div>` : '';
    container.innerHTML = toolbar + batch + body;
    const selectAll = container.querySelector('[data-cui-all]'); if (selectAll) selectAll.indeterminate = selected.size > 0 && !allChecked;
    bind(container);
  }
  function init(input = {}) { hooks = { ...hooks, ...input }; return { render }; }
  return { init, render, _private: { records, visible, filteredItems, completeSelected, setSelectedCompletion, deleteRecords, analyzeSelected, mergeSelected, displayItems, treeGroups, itemKey, timestamp } };
}));
