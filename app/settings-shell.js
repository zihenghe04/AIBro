/* Settings shell: category nav, st-* builders and deep-link routing. This is the only settings page. */
(function (root) {
  'use strict';
  const CATEGORIES = [
    ['general', 'settings', '通用', 'General', '外观、语言与启动方式。', 'Appearance, language and launch behaviour.'],
    ['quick-entry', 'spark', '灵动岛与快捷入口', 'Island & quick entry', '灵动岛、快捷工作台与全局入口。', 'Island, quick panel and global entry points.'],
    ['voice', 'chat', '语音与听写', 'Voice & dictation', '听写触发键、转写与语音指令。', 'Dictation trigger, transcription and voice commands.'],
    ['models', 'dashboard', '模型与连接', 'Models & connections', '模型、账号连接与默认角色。', 'Models, account connections and default roles.'],
    ['notifications', 'bell', '通知与提醒', 'Notifications', '提醒、声音与通知方式。', 'Reminders, sounds and delivery.'],
    ['sync', 'history', '同步与知识库', 'Sync & knowledge', '云同步、知识库与向量检索。', 'Cloud sync, knowledge base and embeddings.'],
    ['privacy', 'shield', '权限与安全', 'Privacy & security', '系统权限、自动化与数据位置。', 'System permissions, automation and data location.'],
    ['plugins', 'plug', '插件', 'Plugins', '已安装插件与导入。', 'Installed plugins and import.'],
  ];
  const IDS = CATEGORIES.map(c => c[0]);
  // Older section ids (deep links, saved state) mapped to the new categories.
  const LEGACY = { appearance: 'general', models: 'models', sync: 'sync', knowledge: 'sync', plugins: 'plugins' };
  const KEY = 'workstation-settings-category-v1';
  let shell = null, selected = 'general';
  let leavers = [];
  // Pages that borrow classic nodes register how to give them back; runs before the next page renders or the shell closes.
  function runLeave() { const list = leavers; leavers = []; for (const fn of list) { try { fn(); } catch (_) {} } }

  const en = () => /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, enText) => en() ? enText : zh;
  const resolve = id => IDS.includes(id) ? id : (LEGACY[id] || null);
  function el(tag, attrs = {}, children = []) {
    const node = root.document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v; else if (k === 'html') node.innerHTML = v; else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  /* ---- st-* builders ---- */
  const ui = {
    onLeave(fn) { if (typeof fn === 'function') leavers.push(fn); },
    el,
    group(title, rows, note) {
      const wrap = el('section');
      if (title) wrap.append(el('h3', { class: 'st-group-title', text: title }));
      wrap.append(el('div', { class: 'st-group' }, rows));
      if (note) wrap.append(el('p', { class: 'st-group-note', text: note }));
      return wrap;
    },
    row({ title, description, control, id }) {
      const text = el('div', { class: 'st-row-text' }, [el('div', { class: 'st-row-title', text: title, id: id && id + '-t' })]);
      if (description) text.append(el('div', { class: 'st-row-desc', text: description }));
      return el('div', { class: 'st-row' }, [text, el('div', { class: 'st-row-control' }, control)]);
    },
    toggle({ checked = false, label, disabled = false, onChange }) {
      const b = el('button', { type: 'button', class: 'st-switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label, 'aria-disabled': disabled ? 'true' : null });
      b.addEventListener('click', e => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        const next = b.getAttribute('aria-checked') !== 'true';
        b.setAttribute('aria-checked', String(next));
        onChange?.(next, e);
      });
      return b;
    },
    segmented({ options, value, label, onChange }) {
      const wrap = el('div', { class: 'st-seg', role: 'radiogroup', 'aria-label': label });
      const buttons = options.map(([v, text]) => {
        const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), tabindex: v === value ? '0' : '-1', text });
        b.addEventListener('click', e => { if (wrap.dataset.disabled === 'true') return; select(v, e); });
        return [v, b];
      });
      function paint(v) { for (const [bv, b] of buttons) { b.setAttribute('aria-checked', String(bv === v)); b.tabIndex = bv === v ? 0 : -1; } }
      function select(v, e) { paint(v); onChange?.(v, e); }
      wrap.setValue = paint;
      wrap.setDisabled = on => { if (on) wrap.dataset.disabled = 'true'; else delete wrap.dataset.disabled; };
      wrap.addEventListener('keydown', e => {
        const i = buttons.findIndex(([v]) => v === buttons.find(([, b]) => b.tabIndex === 0)?.[0]);
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = buttons[(i + d + buttons.length) % buttons.length];
        if (wrap.dataset.disabled === 'true') return;
        select(next[0], e); next[1].focus();
      });
      wrap.append(...buttons.map(([, b]) => b));
      return wrap;
    },
    badge(text, tone = 'unknown') { return el('span', { class: 'st-badge', 'data-tone': tone, text }); },
    shortcut({ keys = [], state = 'idle', label, errorText }) {
      const b = el('button', { type: 'button', class: 'st-shortcut', 'data-state': state, 'aria-label': label });
      if (state === 'recording') b.textContent = t('按下新的组合键，Esc 取消', 'Press the new shortcut, Esc to cancel');
      else if (state === 'error') b.textContent = errorText || t('该组合键不可用', 'Shortcut unavailable');
      else b.append(...keys.map(k => el('kbd', { text: k })));
      return b;
    },
  };

  /* ---- shell ---- */
  function categoryName(id) { const c = CATEGORIES.find(x => x[0] === id); return t(c[2], c[3]); }

  function renderPage(id) {
    const c = CATEGORIES.find(x => x[0] === id);
    const page = el('div', { class: 'st-page', id: 'st-panel', role: 'tabpanel', 'aria-labelledby': 'st-tab-' + id }, [
      el('header', { class: 'st-page-head' }, [el('h2', { text: t(c[2], c[3]) }), el('p', { text: t(c[4], c[5]) })]),
    ]);
    const body = root.SettingsShell?.pages?.[id]?.(ui, t) || null;
    if (body) page.append(...[].concat(body));
    return page;
  }

  function build() {
    const page = root.document.getElementById('settings');
    if (!page) return null;
    const nav = el('div', { class: 'st-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('设置分类', 'Settings categories') });
    for (const c of CATEGORIES) {
      const b = el('button', { type: 'button', class: 'st-nav-item', role: 'tab', id: 'st-tab-' + c[0], 'data-cat': c[0], 'aria-selected': 'false', tabindex: '-1' });
      b.innerHTML = (root.WorkstationIcons?.icon?.(c[1]) || '') + '<span></span>';
      b.lastChild.textContent = t(c[2], c[3]);
      b.addEventListener('click', () => select(c[0], { user: true }));
      nav.append(b);
    }
    const edge = () => nav.classList.toggle('st-at-end', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 2);
    nav.addEventListener('scroll', edge, { passive: true });
    if (root.ResizeObserver) new root.ResizeObserver(edge).observe(nav); else edge();
    nav.addEventListener('keydown', e => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = IDS[(IDS.indexOf(selected) + d + IDS.length) % IDS.length];
      select(next, { user: true, focus: true });
    });
    const content = el('div', { class: 'st-content', id: 'st-content' });
    const node = el('div', { class: 'st-shell', id: 'settingsShell' }, [nav, content]);
    page.append(node);
    return { node, nav, content, page };
  }

  function init() {
    if (shell) return true;
    shell = build();
    if (shell) { try { const saved = resolve(root.localStorage.getItem(KEY)); if (saved) selected = saved; } catch (_) {} }
    return !!shell;
  }

  // In the narrow horizontal bar, bring the selected tab fully into view (no page scroll).
  function scrollTabIntoView(b) {
    const nav = shell?.nav;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const box = b.getBoundingClientRect(), view = nav.getBoundingClientRect();
    if (box.left < view.left) nav.scrollLeft -= view.left - box.left + 16;
    else if (box.right > view.right) nav.scrollLeft += box.right - view.right + 16;
  }

  function select(id, opts = {}) {
    id = resolve(id);
    if (!id || !init()) return false;
    runLeave();
    selected = id;
    for (const b of shell.nav.querySelectorAll('.st-nav-item[role="tab"]')) {
      const on = b.dataset.cat === id;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (on && opts.focus) b.focus({ preventScroll: true });
      if (on) scrollTabIntoView(b);
    }
    const rootNode = el('div', { id: 'nativeSettingsRoot', style: 'display:contents' }, renderPage(id));
    shell.content.replaceChildren(rootNode);
    try { root.localStorage.setItem(KEY, id); } catch (_) {}
    return true;
  }

  // Entry for every route (sidebar, gear, menu, island, deep links). Unknown ids are refused.
  function open(category) {
    const id = resolve(category);
    return id ? select(id) : false;
  }
  const show = id => select(id || selected);

  // Language changes rebuild the labels that were generated once.
  function relabel() {
    if (!shell) return;
    for (const b of shell.nav.querySelectorAll('.st-nav-item[role="tab"]')) b.lastChild.textContent = categoryName(b.dataset.cat);
    shell.nav.setAttribute('aria-label', t('设置分类', 'Settings categories'));
    select(selected);
    // Adopted classic cards were rendered in the previous language; let the app translator revisit them.
    try { root.WorkstationI18n?.translate?.(shell.node); } catch (_) { /* labels stay as rendered */ }
  }

  if (root.document) {
    // The shell labels are built once, so they must be rebuilt whenever the UI language changes.
    root.document.addEventListener('workstation-language-change', () => relabel());
  }

  root.SettingsShell = {
    open, show, init, selected: () => selected, resolve,
    categories: () => IDS.slice(), ui, pages: {},
    relabel, _categoryName: categoryName,
  };
})(typeof window !== 'undefined' ? window : globalThis);
