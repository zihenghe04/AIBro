(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReadingPane = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const keyFor = (kind, id) => JSON.stringify([kind, id]);
  const pageFor = page => Number.isSafeInteger(page) && page > 0 ? page : 1;

  function createController(hooks, env = {}) {
    const document = env.document || globalThis.document;
    const dialog = document.getElementById('previewDialog');
    if (!dialog) throw new Error('Reading pane requires the existing preview renderer');
    let tabs = [], activeKey = null, visible = false, expanded = false, opener = null, navigationVersion = 0;
    const node = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className || '';
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const button = (text, label, action) => {
      const element = node('button', 'reading-control', text); element.type = 'button';
      element.title = label; element.setAttribute('aria-label', label); element.onclick = action;
      return element;
    };
    const pane = node('aside', 'reading-pane'); pane.id = 'readingPane'; pane.hidden = true;
    pane.setAttribute('aria-label', '资料阅读区');
    const toolbar = node('div', 'reading-toolbar');
    const back = button('←', '返回工作区，保留阅读标签', () => hide()); back.id = 'readingBack';
    const heading = node('span', 'reading-heading', '阅读区');
    const caption = node('span', 'reading-caption', '资料与笔记');
    const maximize = button('↗', '放大阅读区', () => {
      expanded = !expanded; updateShell();
    }); maximize.id = 'readingExpand';
    const collapse = button('−', '收起阅读区，保留标签', () => hide()); collapse.id = 'readingCollapse';
    toolbar.append(back, heading, caption, maximize, collapse);
    const tablist = node('div', 'reading-tabs'); tablist.id = 'readingTabs';
    tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '打开的资料');
    dialog.setAttribute('role', 'region'); dialog.setAttribute('aria-modal', 'false'); dialog.setAttribute('aria-labelledby', 'previewTitle');
    pane.append(toolbar, tablist, dialog); document.body.append(pane);
    const toggle = button('阅读区', '重新打开阅读区', () => visible ? hide() : reopen());
    toggle.id = 'readingToggle'; toggle.className = 'reading-toggle'; toggle.hidden = true;
    toggle.setAttribute('aria-controls', pane.id);
    (document.querySelector('.top-actions') || document.body).append(toggle);

    function updateShell() {
      pane.hidden = !visible;
      document.body.classList.toggle('reading-open', visible);
      document.body.classList.toggle('reading-expanded', visible && expanded);
      toggle.hidden = tabs.length === 0;
      toggle.textContent = `阅读区 · ${tabs.length}`;
      toggle.setAttribute('aria-expanded', String(visible));
      toggle.title = visible ? '收起阅读区，保留标签' : '重新打开阅读区';
      maximize.textContent = expanded ? '↙' : '↗';
      maximize.setAttribute('aria-label', expanded ? '恢复并排阅读' : '放大阅读区');
      maximize.setAttribute('aria-pressed', String(expanded));
      maximize.title = expanded ? '恢复并排阅读' : '放大阅读区';
      // A hidden native WebView may suspend animation frames. Structural
      // visibility must establish its width now, not wait for that frame.
      (env.WorkspaceLayout || globalThis.WorkspaceLayout)?.refresh();
    }
    function renderTabs() {
      const focusedKey = document.activeElement?.dataset?.readingKey || document.activeElement?.dataset?.readingCloseKey;
      tablist.replaceChildren();
      tabs.forEach((tab, index) => {
        const row = node('div', 'reading-tab'); row.classList.toggle('active', tab.key === activeKey);
        const select = button('', tab.title, () => selectTab(tab.key));
        select.className = 'reading-tab-select'; select.dataset.readingKey = tab.key;if(tab.kind==='import')select.dataset.openImportContext=tab.id;
        select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.key === activeKey));
        select.setAttribute('aria-controls', dialog.id); select.tabIndex = tab.key === activeKey ? 0 : -1;
        const badge = node('span', 'reading-tab-kind', ['review','local-review'].includes(tab.kind) ? '审阅' : tab.kind === 'note' ? '笔记' : '资料');
        const label = node('span', 'reading-tab-title', tab.title);
        select.append(badge, label);
        select.onkeydown = event => {
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = tabs.length - 1;
          if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].key); tablist.querySelector('[aria-selected="true"]')?.focus(); }
          if (event.key === 'Delete') { event.preventDefault(); close(tab.key); }
        };
        const closeButton = button('×', `关闭标签：${tab.title}`, () => close(tab.key)); closeButton.className = 'reading-tab-close'; closeButton.dataset.readingCloseKey = tab.key;
        row.append(select, closeButton); tablist.append(row);
      });
      updateShell();
      const activeControl = Array.from(tablist.querySelectorAll('[role="tab"]')).find(tab => tab.dataset.readingKey === activeKey);
      const activeRow = activeControl?.parentElement;
      // Scroll only the tab strip, never the document/body or current PDF.
      if (activeRow && tablist.clientWidth > 0) {
        const left = activeRow.offsetLeft, right = left + activeRow.offsetWidth;
        if (left < tablist.scrollLeft) tablist.scrollLeft = left;
        else if (right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right - tablist.clientWidth;
      }
      if (focusedKey && visible) {
        const controls = Array.from(tablist.querySelectorAll('[role="tab"]'));
        (controls.find(tab => tab.dataset.readingKey === focusedKey) || controls.find(tab => tab.dataset.readingKey === activeKey))?.focus({ preventScroll: true });
      }
    }
    function afterLeave(action) {
      const version = ++navigationVersion;
      if (!hooks.beforeLeave) return action();
      const allowed = hooks.beforeLeave();
      if (allowed && typeof allowed.then === 'function') return allowed.then(ok => ok && version === navigationVersion ? action() : false);
      return allowed !== false && version === navigationVersion ? action() : false;
    }
    function hide(options = {}) {
      if (!visible) return;
      return afterLeave(() => hideNow(options));
    }
    function hideNow({ restoreFocus = true } = {}) {
      if (!visible) return;
      visible = false; expanded = false;
      hooks.onSuspend?.();
      if (dialog.open) dialog.close();
      updateShell();
      if (restoreFocus && opener?.isConnected !== false) opener?.focus?.({ preventScroll: true });
    }
    function present(kind, id, page = 1) {
      const item = hooks.getItem(kind, id);
      if (!item) { reconcile(); return false; }
      const key = keyFor(kind, id);
      let tab = tabs.find(entry => entry.key === key);
      if (!tab) { tab = { key, kind, id }; tabs.push(tab); }
      tab.title = String(item.title || item.name || '未命名资料'); tab.page = pageFor(page);
      activeKey = key;
      if (!visible) opener = document.activeElement;
      visible = true; renderTabs();
      // show(), never showModal(): the conversation remains interactive.
      if (!dialog.open) dialog.show();
      return true;
    }
    function selectTab(key) {
      const tab = tabs.find(entry => entry.key === key);
      if (!tab) return;
      if (!hooks.getItem(tab.kind, tab.id)) { reconcile(); return; }
      // A dirty inline document owns its surface until navigation is approved.
      // Recheck the target after an asynchronous Save/Discard decision.
      const select = () => {
        if (!tabs.some(item => item.key === key) || !hooks.getItem(tab.kind, tab.id)) { reconcile(); return false; }
        return hooks.onSelect(tab.kind, tab.id, tab.page);
      };
      return key === activeKey ? select() : afterLeave(select);
    }
    function reopen() {
      reconcile();
      if (activeKey) selectTab(activeKey);
    }
    function close(key = activeKey) {
      if (key === activeKey) return afterLeave(() => closeNow(key));
      return closeNow(key);
    }
    function closeNow(key) {
      const index = tabs.findIndex(tab => tab.key === key);
      if (index < 0) return;
      const wasActive = activeKey === key;
      tabs.splice(index, 1);
      if (wasActive) {
        hooks.onSuspend?.();
        activeKey = tabs[Math.min(index, tabs.length - 1)]?.key || null;
        if (!activeKey) hideNow();
        else if (visible) selectTab(activeKey);
      }
      renderTabs();
    }
    function reconcile() {
      const previous = tabs; const activeIndex = tabs.findIndex(tab => tab.key === activeKey);
      let changed = false;
      tabs = tabs.filter(tab => {
        const item = hooks.getItem(tab.kind, tab.id);
        if (!item) { changed = true; return false; }
        const title = String(item.title || item.name || '未命名资料');
        if (title !== tab.title) { tab.title = title; changed = true; }
        return true;
      });
      if (activeKey && !tabs.some(tab => tab.key === activeKey)) {
        navigationVersion++;
        hooks.onSuspend?.();
        activeKey = tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)]?.key || null;
        if (!activeKey) hideNow();
        else if (visible) selectTab(activeKey);
      }
      if (changed || previous.length !== tabs.length) renderTabs();
    }
    function setPage(kind, id, page) {
      const tab = tabs.find(entry => entry.key === keyFor(kind, id));
      if (tab) tab.page = pageFor(page);
    }
    function revealWorkspace() {
      const compact = env.matchMedia ? env.matchMedia('(max-width: 1000px)').matches : globalThis.matchMedia?.('(max-width: 1000px)').matches;
      if (expanded || compact) hide({ restoreFocus: false });
    }
    // Native method=dialog buttons and external close calls share cleanup.
    dialog.addEventListener('close', () => {
      if (!dialog.open && visible) {
        const result = hide();
        if (result && typeof result.then === 'function') {
          // A native close has already hidden the region; keep the inline
          // unsaved-change decision visible until the user resolves it.
          if (visible && !dialog.open) dialog.show();
        }
      }
    });
    pane.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); hide(); }
    });
    return { present, close, hide, reopen, reconcile, setPage, revealWorkspace,
      isActive: (kind, id) => visible && activeKey === keyFor(kind, id),
      snapshot: () => ({ visible, expanded, activeKey, tabs: tabs.map(tab => ({ ...tab })) }) };
  }
  let controller;
  return { createController, init(hooks, env) { controller = createController(hooks, env); return controller; },
    present: (...args) => controller?.present(...args),
    hide: (...args) => controller?.hide(...args),
    close: (...args) => controller?.close(...args),
    reconcile: (...args) => controller?.reconcile(...args),
    setPage: (...args) => controller?.setPage(...args),
    revealWorkspace: (...args) => controller?.revealWorkspace(...args),
    isActive: (...args) => controller?.isActive(...args) };
});
