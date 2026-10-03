(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReadingPane = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const keyFor = (kind, id) => JSON.stringify([kind, id]);
  const pageFor = page => Number.isSafeInteger(page) && page > 0 ? page : 1;
  const kinds = new Set(['note', 'import', 'local-file', 'review', 'local-review']);
  const cleanOrigin = value => (globalThis.DocumentOrigin || (typeof require === 'function' ? require('./document-origin.js') : null))?.clean(value) || undefined;
  const cleanBookmark = value => {
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    if (['read', 'preview', 'rich', 'edit', 'source', 'visual'].includes(value.mode)) result.mode = value.mode;
    for (const name of ['scrollTop', 'editorScrollTop', 'scrollLeft', 'editorScrollLeft']) if (Number.isFinite(value[name]) && value[name] >= 0) result[name] = value[name];
    if (typeof value.outlineOpen === 'boolean') result.outlineOpen = value.outlineOpen;
    // Review bookmarks contain presentation metadata only, never file bodies.
    if (value.review && typeof value.review.selectedId === 'string') {
      const r=value.review;
      result.review={selectedId:r.selectedId,documents:(Array.isArray(r.documents)?r.documents:[]).filter(view=>view&&typeof view.id==='string').map(view=>{
        const v={id:view.id,mode:['diff','source','preview'].includes(view.mode)?view.mode:'diff',split:view.split===true,wrap:view.wrap!==false,full:view.full===true,positions:{}};
        if(typeof view.snapshot==='string')v.snapshot=view.snapshot;
        for(const mode of ['diff','source','preview']){const p=view.positions?.[mode];if(!p||typeof p!=='object')continue;const pos={};for(const name of ['top','left'])if(Number.isFinite(p[name])&&p[name]>=0)pos[name]=p[name];if(Number.isFinite(p.offset))pos.offset=p.offset;if(typeof p.key==='string'&&/^\d*:\d*$/.test(p.key))pos.key=p.key;v.positions[mode]=pos;}
        v.limits=(Array.isArray(view.limits)?view.limits:[]).filter(pair=>Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1])&&pair[1]>=0).map(pair=>[pair[0],pair[1]]);
        v.expandedGaps=(Array.isArray(view.expandedGaps)?view.expandedGaps:[]).filter(key=>typeof key==='string'&&/^gap:\d*:\d*$/.test(key));
        if(Number.isSafeInteger(view.hunkLimit)&&view.hunkLimit>=0)v.hunkLimit=view.hunkLimit;
        return v;
      })};
    }
    const selection = value.selection || value.sourceSelection;
    if (selection && Number.isSafeInteger(selection.start) && Number.isSafeInteger(selection.end) && selection.start >= 0 && selection.end >= selection.start)
      result.selection = { start: selection.start, end: selection.end, direction: selection.direction === 'backward' ? 'backward' : 'forward' };
    return Object.keys(result).length ? result : undefined;
  };

  function createController(hooks, env = {}) {
    const document = env.document || globalThis.document;
    const sourceAnalysis = env.AttachmentAnalysis || globalThis.AttachmentAnalysis || (typeof require === 'function' ? require('./attachment-analysis.js') : null);
    const surface = document.getElementById('previewDialog');
    if (!surface) throw new Error('Reading pane requires the existing preview renderer');
    let tabs = [], activeKey = null, visible = false, parked = false, expanded = false, opener = null, navigationVersion = 0, metadataTimer = null, renderedActiveKey = null, tablistWidth = 0, renderedVisible = false;
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
    const backHost = node('span', 'reading-origin-action');
    const back = button('←', '返回工作区，保留阅读标签', () => returnToOrigin()); back.id = 'readingBack';
    backHost.append(back);
    let backIsland = null, returning = false;
    const heading = node('span', 'reading-heading', '阅读区');
    const caption = node('span', 'reading-caption', '资料与笔记');
    const chatHost = node('span', 'reading-chat-action'); chatHost.hidden = true;
    const chat = button('引用到对话', '引用到对话', event => referenceInChat(event)); chat.id = 'readingChat';
    chatHost.append(chat);
    let chatIsland = null, referencing = false;
    const maximize = button('↗', '放大阅读区', () => {
      expanded = !expanded; updateShell();
    }); maximize.id = 'readingExpand';
    const collapse = button('−', '收起阅读区，保留标签', () => hide()); collapse.id = 'readingCollapse';
    toolbar.append(backHost, heading, caption, chatHost, maximize, collapse);
    const tablist = node('div', 'reading-tabs'); tablist.id = 'readingTabs';
    tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '打开的资料');
    tablist.setAttribute('aria-orientation', 'horizontal');
    tablist.title = '打开的文档 · 可横向滚动；方向键切换，Home / End 跳至首尾，Delete 关闭当前标签';
    surface.setAttribute('role', 'region'); surface.setAttribute('aria-labelledby', 'previewTitle');
    pane.append(toolbar, tablist, surface);
    // WKWebView can lose the persistent reader's accessibility subtree when a
    // preceding main region disappears after native navigation/model panels.
    // Establish the native reader before main once, while still hidden; the
    // native grid supplies visual order. Never reparent an open document.
    // The bridge exists before the native body class is injected.
    const nativeShell = env.nativeShell ?? !!globalThis.webkit?.messageHandlers?.workspace;
    const main = nativeShell && document.querySelector('.main');
    if (main) document.body.insertBefore(pane, main); else document.body.append(pane);
    const documentDetails=surface.querySelector('.reader-document-details');if(documentDetails)documentDetails.open=false;
    const toggle = button('阅读区', '重新打开阅读区', () => visible && !parked ? hide() : reopen());
    toggle.id = 'readingToggle'; toggle.className = 'reading-toggle'; toggle.hidden = true;
    toggle.setAttribute('aria-controls', pane.id);
    (document.querySelector('.top-actions') || document.body).append(toggle);

    function captureActive() {
      const tab = tabs.find(entry => entry.key === activeKey);
      if (!tab || !visible) return;
      const bookmark = cleanBookmark(hooks.captureView?.(tab.kind, tab.id));
      if (bookmark) tab.bookmark = bookmark;
      if (hooks.isDirty) tab.draftPending = !!hooks.isDirty(tab.kind, tab.id);
    }
    function sessionMetadata() {
      // Titles and body text never enter UI preferences. Resolve names and
      // permissions from current workspace records on every restoration.
      const saved = tabs.filter(tab => hooks.getItem(tab.kind, tab.id) && hooks.canPersist?.(tab.kind, tab.id) !== false)
        .map(tab => ({ kind: tab.kind, id: tab.id, page: tab.page, ...(tab.origin ? { origin: cleanOrigin(tab.origin) } : {}), ...(tab.bookmark ? { bookmark: cleanBookmark(tab.bookmark) } : {}), ...(tab.draftPending || hooks.isDirty?.(tab.kind, tab.id) ? { draftPending: true } : {}) }));
      return { version: 1, tabs: saved, activeKey: saved.some(tab => keyFor(tab.kind, tab.id) === activeKey) ? activeKey : null, expanded, visible: visible && !parked };
    }
    function persist({ capture = false } = {}) {
      if (capture) captureActive();
      hooks.saveSession?.(sessionMetadata());
    }
    function schedulePersist() {
      if (!hooks.saveSession) return;
      if (metadataTimer) (env.clearTimeout || globalThis.clearTimeout)(metadataTimer);
      metadataTimer = (env.setTimeout || globalThis.setTimeout)(() => { metadataTimer = null; captureActive(); renderTabs(); persist(); }, 250);
    }
    function restoreSession(value, { activate = false } = {}) {
      if (!value || value.version !== 1 || !Array.isArray(value.tabs) || tabs.length) return false;
      const seen = new Set();
      for (const saved of value.tabs) {
        if (!saved || !kinds.has(saved.kind) || typeof saved.id !== 'string' || !saved.id) continue;
        const key = keyFor(saved.kind, saved.id), item = hooks.getItem(saved.kind, saved.id);
        if (seen.has(key) || !item || hooks.canPersist?.(saved.kind, saved.id) === false) continue;
        seen.add(key);
        tabs.push({ key, kind: saved.kind, id: saved.id, title: String(item.title || item.name || item.path || '未命名资料'), page: pageFor(saved.page), origin: cleanOrigin(saved.origin), bookmark: cleanBookmark(saved.bookmark), draftPending: saved.draftPending === true });
      }
      activeKey = tabs.some(tab => tab.key === value.activeKey) ? value.activeKey : tabs[0]?.key || null;
      expanded = value.expanded === true; renderTabs();
      if (activate && value.visible === true && activeKey) return selectTab(activeKey);
      return true;
    }

    function notifyVisibility(shown) {
      const EventType = env.CustomEvent || document.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (EventType) surface.dispatchEvent?.(new EventType('aibro:reader-visibility', { detail: { visible: shown } }));
    }
    function updateShell() {
      const shown = visible && !parked, changedVisibility = shown !== renderedVisible;
      // Give the owned document its last readable geometry before WebKit can
      // reset scrollTop on display:none. Showing is notified after width fits.
      if (changedVisibility && !shown) notifyVisibility(false);
      pane.hidden = !shown; surface.hidden = !shown;
      document.body.classList.toggle('reading-open', shown);
      document.body.classList.toggle('reading-expanded', shown && expanded);
      const active = tabs.find(tab => tab.key === activeKey), item = active && hooks.getItem(active.kind, active.id);
      updateOrigin(active);
      const pdf = active?.kind === 'import' && !sourceAnalysis?.isBookmarkOnly?.(item) && (/^application\/pdf(?:;|$)/i.test(item?.mimeType || '') || /\.pdf$/i.test(item?.originalName || item?.name || ''));
      document.body.classList.toggle('reading-pdf', !!(shown && pdf));
      // Keep one tablist and one document surface. Only the lightweight strip
      // joins the PDF toolbar; notes and media retain their original layout.
      const tabsParent = visible && pdf ? toolbar : pane;
      if (tablist.parentElement !== tabsParent) {
        const focused = tablist.contains(document.activeElement) ? document.activeElement : null;
        tabsParent.insertBefore(tablist, tabsParent === toolbar ? heading : surface);
        if (shown) focused?.focus?.({ preventScroll: true });
      }
      toggle.hidden = tabs.length === 0;
      toggle.textContent = `阅读区 · ${tabs.length}`;
      toggle.setAttribute('aria-expanded', String(shown));
      toggle.title = shown ? '收起阅读区，保留标签' : '重新打开阅读区';
      maximize.textContent = expanded ? '↙' : '↗';
      maximize.setAttribute('aria-label', expanded ? '恢复并排阅读' : '放大阅读区');
      maximize.setAttribute('aria-pressed', String(expanded));
      maximize.title = expanded ? '恢复并排阅读' : '放大阅读区';
      // A hidden native WebView may suspend animation frames. Structural
      // visibility must establish its width now, not wait for that frame.
      (env.WorkspaceLayout || globalThis.WorkspaceLayout)?.refresh();
      renderedVisible = shown;
      if (changedVisibility && shown) notifyVisibility(true);
      if (shown && tablist.clientWidth !== tablistWidth) revealTab(activeKey);
    }
    function updateOrigin(tab) {
      updateChatAction(tab);
      const location = tab?.origin && hooks.resolveOrigin?.(tab.origin);
      const label = location?.label || '返回工作区';
      const detail = location?.caption || (location ? '入口已删除、归档或不可用' : '保留阅读标签');
      backHost.classList.toggle('has-origin', !!location);
      caption.textContent = location?.caption || (location ? '原入口不可用' : '资料与笔记');
      caption.title = caption.textContent;
      const props = { id: 'readingBack', variant: 'ghost', size: 'sm', children: location ? `← ${label}` : '←',
        title: `${label} · ${detail}`, 'aria-label': `${label}：${detail}`, disabled: location?.available === false,
        loading: returning, onClick: () => returnToOrigin() };
      const kit = env.HalaskaUI || globalThis.HalaskaUI;
      if (kit?.mount) {
        if (backIsland) backIsland.update(props);
        else { backHost.replaceChildren(); backIsland = kit.mount(backHost, 'Button', props); }
      } else {
        back.textContent = props.children; back.title = props.title; back.setAttribute('aria-label', props['aria-label']);
        back.disabled = props.disabled || returning;
      }
    }
    function chatAction(tab) {
      return tab && hooks.onChat && hooks.getItem(tab.kind, tab.id) ? hooks.chatAction?.(tab) : null;
    }
    function updateChatAction(tab) {
      const action = chatAction(tab);
      chatHost.hidden = !action;
      if (!action) return;
      const label = action.label || '引用到对话';
      const props = { id: 'readingChat', variant: 'ghost', size: 'sm', children: label,
        title: action.title || label, 'aria-label': label, disabled: !!action.disabled,
        loading: referencing, onClick: event => referenceInChat(event),
        style: { height: 28, minHeight: 28, padding: '4px 7px', fontSize: 11, whiteSpace: 'nowrap' } };
      const kit = env.HalaskaUI || globalThis.HalaskaUI;
      if (kit?.mount) {
        if (chatIsland) chatIsland.update(props);
        else { chatHost.replaceChildren(); chatIsland = kit.mount(chatHost, 'Button', props); }
      } else {
        chat.textContent = label; chat.title = props.title; chat.setAttribute('aria-label', label);
        chat.disabled = props.disabled || referencing;
      }
    }
    async function referenceInChat(event) {
      const tab = tabs.find(entry => entry.key === activeKey), action = chatAction(tab);
      if (!visible || parked || !action || action.disabled || referencing) return false;
      // Capture before a menu takes focus. The hook owns routing and reference
      // persistence; this toolbar never closes or remounts the active editor.
      const version = navigationVersion, key = activeKey;
      const anchor = event?.currentTarget || chatHost.querySelector('button');
      captureActive(); persist();
      const snapshot = { ...tab, origin: cleanOrigin(tab.origin), bookmark: cleanBookmark(tab.bookmark) };
      referencing = true;
      try {
        // A menu must first accept an enabled anchor. Keep the in-flight guard
        // synchronous, then paint busy only when the host returns async work.
        const result = hooks.onChat(snapshot, { anchor, event,
          isCurrent: () => version === navigationVersion && activeKey === key && visible && !parked && !!hooks.getItem(tab.kind, tab.id) });
        if (result?.then) updateChatAction(tab);
        return await result;
      } catch (error) { hooks.onError?.(error); return false; }
      finally { referencing = false; updateChatAction(tabs.find(entry => entry.key === activeKey)); }
    }
    async function returnToOrigin() {
      const tab = tabs.find(entry => entry.key === activeKey);
      if (!tab?.origin || !hooks.onReturn) return hide();
      if (returning || hooks.resolveOrigin?.(tab.origin)?.available === false) return false;
      const version = ++navigationVersion, key = activeKey;
      captureActive(); returning = true; updateOrigin(tab);
      try {
        return await hooks.onReturn(cleanOrigin(tab.origin), { isCurrent: () => navigationVersion === version && activeKey === key });
      } catch (error) { hooks.onError?.(error); return false; }
      finally { returning = false; updateOrigin(tabs.find(entry => entry.key === activeKey)); }
    }
    function revealTab(key) {
      const control = Array.from(tablist.querySelectorAll('[role="tab"]')).find(tab => tab.dataset.readingKey === key);
      const row = control?.parentElement;
      tablistWidth = tablist.clientWidth || 0;
      if (!row || !tablistWidth || !visible || parked) return;
      // Scroll only the strip, never the document, editor selection or PDF.
      const left = row.offsetLeft, right = left + row.offsetWidth;
      if (left < tablist.scrollLeft) tablist.scrollLeft = left;
      else if (right > tablist.scrollLeft + tablistWidth) tablist.scrollLeft = right - tablistWidth;
    }
    function focusTab(key, closeControl = false, reveal = true) {
      const control = Array.from(tablist.querySelectorAll(closeControl ? '.reading-tab-close' : '[role="tab"]'))
        .find(tab => (closeControl ? tab.dataset.readingCloseKey : tab.dataset.readingKey) === key);
      if (control && visible && !parked) { control.focus({ preventScroll: true }); if (reveal) revealTab(key); }
    }
    function renderTabs() {
      const focusedClose = document.activeElement?.dataset?.readingCloseKey;
      const focusedKey = document.activeElement?.dataset?.readingKey || focusedClose;
      const scrollLeft = tablist.scrollLeft || 0, changedActive = renderedActiveKey !== activeKey, previousWidth = tablistWidth;
      tablist.replaceChildren();
      tabs.forEach((tab, index) => {
        const row = node('div', 'reading-tab'); row.classList.toggle('active', tab.key === activeKey);
        const item = hooks.getItem(tab.kind, tab.id);
        const location = tab.origin && hooks.resolveOrigin?.(tab.origin);
        const context = [item?.path, item?.folderPath || item?.folder, location?.caption].filter((value, index, all) => value && value !== tab.title && all.indexOf(value) === index);
        const fullTitle = [tab.title, ...context].join(' · ');
        const select = button('', fullTitle, () => { select.focus({ preventScroll: true }); return selectTab(tab.key, { focus: true }); });
        select.className = 'reading-tab-select'; select.dataset.readingKey = tab.key;if(tab.kind==='import')select.dataset.openImportContext=tab.id;
        select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.key === activeKey));
        select.setAttribute('aria-controls', surface.id); select.tabIndex = tab.key === activeKey ? 0 : -1;
        const badge = node('span', 'reading-tab-kind', ['review','local-review'].includes(tab.kind) ? '审阅' : tab.kind === 'note' ? '笔记' : '资料');
        const label = node('span', 'reading-tab-title', tab.title);
        const dirty = tab.draftPending || hooks.isDirty?.(tab.kind, tab.id);
        select.append(badge, label);
        if (dirty) {
          const marker = node('span', 'reading-tab-dirty', '•'); marker.setAttribute('aria-hidden', 'true'); select.append(marker);
          select.setAttribute('aria-label', `${fullTitle}，有未保存修改`); select.title = `${fullTitle} · 有未保存修改`;
        }
        select.onkeydown = event => {
          if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = tabs.length - 1;
          if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].key, { focus: true }); }
          if (event.key === 'Delete') { event.preventDefault(); close(tab.key); }
        };
        const closeButton = button('×', `关闭标签：${tab.title}`, () => close(tab.key)); closeButton.className = 'reading-tab-close'; closeButton.dataset.readingCloseKey = tab.key; closeButton.tabIndex = tab.key === activeKey ? 0 : -1;
        row.append(select, closeButton); tablist.append(row);
      });
      updateShell();
      tablist.scrollLeft = scrollLeft;
      renderedActiveKey = activeKey;
      if (changedActive || previousWidth !== tablistWidth) revealTab(activeKey);
      if (focusedKey && visible && !parked) {
        const stillOpen = tabs.some(tab => tab.key === focusedKey);
        // Metadata refresh keeps the exact close/tab control. A closed control
        // yields to the active tab instead of leaving focus on detached DOM.
        focusTab(stillOpen ? focusedKey : activeKey, !!focusedClose && stillOpen, !stillOpen);
      }
    }
    function afterLeave(action, reason = 'close') {
      const version = ++navigationVersion;
      captureActive();
      const guard = reason === 'switch' ? hooks.beforeSwitch || hooks.beforeLeave : hooks.beforeLeave;
      if (!guard) return action();
      const allowed = guard({ reason, isCurrent: () => version === navigationVersion });
      const commit = okay => { if (!okay || version !== navigationVersion) return false; captureActive(); return action(); };
      if (allowed && typeof allowed.then === 'function') return allowed.then(commit);
      return commit(allowed !== false);
    }
    function beforeNavigate(kind, id) {
      if (!activeKey || !visible || activeKey === keyFor(kind, id)) { navigationVersion++; return true; }
      return afterLeave(() => { persist(); return true; }, 'switch');
    }
    function hide(options = {}) {
      if (!visible) return true;
      return afterLeave(() => hideNow(options));
    }
    function hideNow({ restoreFocus = true, suspended = false } = {}) {
      if (!visible) return true;
      if (!suspended && hooks.onSuspend?.() === false) return false;
      visible = false; parked = false; expanded = false;
      updateShell(); persist();
      if (restoreFocus && opener?.isConnected !== false) opener?.focus?.({ preventScroll: true });
      return true;
    }
    function present(kind, id, page, options = {}) {
      const item = hooks.getItem(kind, id);
      if (!item) { reconcile(); return false; }
      const key = keyFor(kind, id);
      let tab = tabs.find(entry => entry.key === key);
      if (!tab) { tab = { key, kind, id }; tabs.push(tab); }
      if (Object.hasOwn(options, 'origin')) tab.origin = cleanOrigin(options.origin);
      // An ordinary file-tree click resumes its retained tab. A citation or
      // explicit page request still wins, including an explicit first page.
      tab.title = String(item.title || item.name || item.path || '未命名资料');
      tab.page = pageFor(page === undefined ? tab.page : page);
      activeKey = key;
      if (!visible) opener = document.activeElement;
      visible = true; parked = false; renderTabs(); persist();
      return true;
    }
    function referenceOrigin(kind, id, source) {
      const from = tabs.find(tab => tab.key === activeKey);
      if (!visible || parked || !from || from.kind !== source?.kind || from.id !== source?.id) return undefined;
      const targetKey = keyFor(kind, id), seen = new Set();
      let cursor = from;
      // Existing tabs are reading positions, not proof of a cycle. Follow
      // typed predecessor identities before accepting this explicit entry.
      while (cursor) {
        if (cursor.key === targetKey || seen.has(cursor.key)) return undefined;
        seen.add(cursor.key);
        const origin = cleanOrigin(cursor.origin);
        cursor = origin?.view === 'document' ? tabs.find(tab => tab.key === keyFor(origin.kind, origin.id)) : null;
      }
      return { view: 'document', kind: from.kind, id: from.id };
    }
    function selectTab(key, { focus = false } = {}) {
      const focusKey = document.activeElement?.dataset?.readingKey || document.activeElement?.dataset?.readingCloseKey;
      const tab = tabs.find(entry => entry.key === key);
      if (!tab) return;
      if (!hooks.getItem(tab.kind, tab.id)) { reconcile(); return; }
      // A dirty inline document owns its surface until navigation is approved.
      // Recheck the target after an asynchronous Save/Discard decision.
      const select = () => {
        if (!tabs.some(item => item.key === key) || !hooks.getItem(tab.kind, tab.id)) { reconcile(); return false; }
        const version = navigationVersion;
        const result = hooks.onSelect(tab.kind, tab.id, tab.page, { navigationApproved: true, retainOrigin: true, bookmark: cleanBookmark(tab.bookmark), isCurrent: () => version === navigationVersion });
        const complete = value => {
          const currentFocusKey = document.activeElement?.dataset?.readingKey || document.activeElement?.dataset?.readingCloseKey;
          if (focus && focusKey && (currentFocusKey === focusKey || currentFocusKey === key) && tablist.contains(document.activeElement)
            && value !== false && version === navigationVersion && activeKey === key) focusTab(key);
          return value;
        };
        return result && typeof result.then === 'function' ? result.then(complete) : complete(result);
      };
      if (key === activeKey) { navigationVersion++; return select(); }
      return afterLeave(select, 'switch');
    }
    function reopen() {
      reconcile();
      if (resume()) return true;
      if (activeKey) selectTab(activeKey);
    }
    function resume() {
      if (!visible || !parked) return false;
      if (!tabs.some(tab => tab.key === activeKey && hooks.getItem(tab.kind, tab.id))) { reconcile(); return false; }
      parked = false; updateShell(); persist(); return true;
    }
    function close(key = activeKey) {
      if (key === activeKey) return afterLeave(() => closeNow(key));
      const tab = tabs.find(entry => entry.key === key);
      // Inactive editors are released, so a dirty close first restores that
      // document and presents its own Save / Discard / Continue decision.
      if (tab && (tab.draftPending || hooks.isDirty?.(tab.kind, tab.id))) {
        return Promise.resolve(selectTab(key)).then(ok => ok === false || activeKey !== key ? false : afterLeave(() => closeNow(key)));
      }
      return closeNow(key);
    }
    function closeNow(key) {
      const index = tabs.findIndex(tab => tab.key === key);
      if (index < 0) return;
      const wasActive = activeKey === key;
      if (wasActive && hooks.onSuspend?.() === false) return false;
      tabs.splice(index, 1);
      let selected;
      if (wasActive) {
        activeKey = tabs[Math.min(index, tabs.length - 1)]?.key || null;
        if (!activeKey && visible) hideNow({ suspended: true });
        else { if (visible && !parked) selected = selectTab(activeKey); else if (parked) { visible = false; parked = false; } }
      }
      const replacementKey = activeKey, version = navigationVersion;
      renderTabs(); persist();
      const complete = value => {
        // The dirty-document confirmation may return focus to body/html after
        // disappearing. Wait for the replacement's real mount, then recover
        // only that lost focus; Continue editing never reaches closeNow.
        const focused = document.activeElement;
        const lostFocus = !focused || focused === document.body || focused === document.documentElement || focused.isConnected === false
          || focused.dataset?.readingKey === key || focused.dataset?.readingCloseKey === key;
        if (wasActive && replacementKey && value !== false && version === navigationVersion && activeKey === replacementKey && lostFocus) focusTab(replacementKey);
        return value;
      };
      return selected && typeof selected.then === 'function' ? selected.then(complete) : complete(selected);
    }
    function reconcile() {
      const previous = tabs; const activeIndex = tabs.findIndex(tab => tab.key === activeKey);
      let changed = false;
      tabs = tabs.filter(tab => {
        const item = hooks.getItem(tab.kind, tab.id);
        if (!item) { changed = true; return false; }
        const title = String(item.title || item.name || item.path || '未命名资料');
        if (title !== tab.title) { tab.title = title; changed = true; }
        return true;
      });
      if (activeKey && !tabs.some(tab => tab.key === activeKey)) {
        navigationVersion++;
        activeKey = tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)]?.key || null;
        if (!activeKey && visible) hideNow();
        else { hooks.onSuspend?.(); if (visible && !parked) selectTab(activeKey); else if (parked) { visible = false; parked = false; } }
      }
      if (changed || previous.length !== tabs.length) { renderTabs(); persist(); }
      else updateOrigin(tabs.find(entry => entry.key === activeKey));
    }
    function setPage(kind, id, page) {
      const tab = tabs.find(entry => entry.key === keyFor(kind, id));
      if (tab) { tab.page = pageFor(page); persist(); }
    }
    function revealWorkspace({ force = false } = {}) {
      // Even a route that keeps split reading cancels an earlier pending
      // close/tab decision. Its delayed completion must not replace this route.
      navigationVersion++;
      const compact = env.matchMedia ? env.matchMedia('(max-width: 1000px)').matches : globalThis.matchMedia?.('(max-width: 1000px)').matches;
      // A route change does not end the document editing session. Keep its DOM,
      // page, requests and unsaved draft, but let the requested destination own
      // the visible area. Explicit close/switch still uses the leave guard.
      if (visible && !parked && (force || expanded || compact || document.body.classList.contains('workspace-reader-focus'))) {
        if (pane.contains(document.activeElement)) document.activeElement?.blur?.();
        parked = true; updateShell(); persist({ capture: true });
      }
    }
    surface.addEventListener('click', event => {
      if (event.target.closest?.('[data-reader-close]')) { event.preventDefault(); hide(); }
    });
    pane.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('dialog:modal')) { event.preventDefault(); hide(); }
    });
    for (const name of ['scroll', 'keyup', 'pointerup', 'input']) pane.addEventListener(name, schedulePersist, true);
    const ResizeObserver = env.ResizeObserver || globalThis.ResizeObserver;
    if (ResizeObserver) new ResizeObserver(() => {
      if (visible && !parked && tablist.clientWidth !== tablistWidth) revealTab(activeKey);
    }).observe(tablist);
    if (hooks.loadSession) restoreSession(hooks.loadSession());
    return { present, close, hide, reopen, resume, reconcile, setPage, revealWorkspace, beforeNavigate, restoreSession, sessionMetadata, returnToOrigin, referenceOrigin,
      remember: () => persist({ capture: true }),
      bookmark: (kind, id) => cleanBookmark(tabs.find(tab => tab.key === keyFor(kind, id))?.bookmark),
      refreshTabs: () => { captureActive(); renderTabs(); persist(); },
      setExpanded: value => { if (!visible) return false; expanded = !!value; updateShell(); persist(); return true; },
      isActive: (kind, id) => visible && activeKey === keyFor(kind, id),
      snapshot: () => ({ visible: visible && !parked, retained: visible && parked, expanded, activeKey, tabs: tabs.map(tab => ({ ...tab })) }) };
  }
  let controller;
  return { createController, cleanBookmark, init(hooks, env) { controller = createController(hooks, env); return controller; },
    beforeNavigate: (...args) => controller?.beforeNavigate(...args) ?? true,
    returnToOrigin: (...args) => controller?.returnToOrigin(...args),
    referenceOrigin: (...args) => controller?.referenceOrigin(...args),
    restoreSession: (...args) => controller?.restoreSession(...args),
    sessionMetadata: (...args) => controller?.sessionMetadata(...args),
    bookmark: (...args) => controller?.bookmark(...args),
    remember: (...args) => controller?.remember(...args),
    refreshTabs: (...args) => controller?.refreshTabs(...args),
    present: (...args) => controller?.present(...args),
    reopen: (...args) => controller?.reopen(...args),
    setExpanded: (...args) => controller?.setExpanded(...args),
    snapshot: () => controller?.snapshot(),
    hide: (...args) => controller?.hide(...args),
    close: (...args) => controller?.close(...args),
    reconcile: (...args) => controller?.reconcile(...args),
    setPage: (...args) => controller?.setPage(...args),
    revealWorkspace: (...args) => controller?.revealWorkspace(...args),
    resume: (...args) => controller?.resume(...args),
    isActive: (...args) => controller?.isActive(...args) };
});
