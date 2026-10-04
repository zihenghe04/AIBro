/* Settings sections retain their controllers and form nodes for the whole session. */
(function (root) {
  'use strict';
  const KEY = 'workstation-settings-section-v1';
  const SECTIONS = ['models', 'sync', 'knowledge', 'appearance'];
  let record = null;
  let hooks = {};
  const language = () => /^en(?:-|$)/i.test(root.document.documentElement.lang);
  function quickEntryCard(panel) {
    const api = root.workstationDesktop?.quickEntry;
    if (!api) return null;
    const doc = root.document, card = doc.createElement('article');
    card.id = 'quickEntrySettingsCard'; card.className = 'card';
    card.innerHTML = '<h2></h2><p class="muted"></p><div class="permission-row"><div><b></b><small></small></div><label class="sound-toggle"><input id="quickEntryEnabled" type="checkbox"/></label></div><div class="permission-row"><label for="quickEntryMode"></label><select id="quickEntryMode"><option value="island"></option><option value="edge"></option><option value="menuBar"></option></select></div><div class="setting-actions"></div><p class="setting-help" role="status" aria-live="polite"></p>';
    panel.prepend(card);
    const enabled = card.querySelector('input'), mode = card.querySelector('select');
    const status = card.querySelector('[role="status"]'), detailHost = card.querySelector('.setting-actions');
    let confirmed = null, busy = false, revision = 0, failure = false, refreshPending = false;
    const t = (zh, en) => language() ? en : zh;
    const detail = root.HalaskaUI.mount(detailHost, 'Button', {
      id: 'quickEntryDetails', variant: 'secondary', size: 'sm',
      onClick: event => perform('open', undefined, event),
    });
    function render() {
      card.querySelector('h2').textContent = t('灵动岛与快捷入口', 'Island & quick entry');
      card.querySelector('.muted').textContent = t('随 AI Bro 启动；登录时自动启动可在详细设置中配置。', 'Runs with AI Bro. Configure launch at login in detailed settings.');
      card.querySelector('b').textContent = t('启用快捷入口', 'Enable quick entry');
      card.querySelector('small').textContent = t('关闭后仍可从主窗口打开快捷工作台。', 'You can still open the quick panel from the main window when disabled.');
      enabled.setAttribute('aria-label', t('启用灵动岛与快捷入口', 'Enable island and quick entry'));
      card.querySelector('label[for="quickEntryMode"]').textContent = t('显示位置', 'Placement');
      for (const [value, zh, en] of [['island', '顶部灵动岛', 'Top island'], ['edge', '屏幕侧边', 'Screen edge'], ['menuBar', '菜单栏', 'Menu bar']]) {
        mode.querySelector(`option[value="${value}"]`).textContent = t(zh, en);
      }
      enabled.checked = confirmed?.isEnabled === true;
      enabled.disabled = busy || !confirmed;
      mode.value = confirmed?.preferredEnabledMode || '';
      mode.disabled = busy || !confirmed?.isEnabled;
      card.setAttribute('aria-busy', String(busy));
      detail.update({ children: t('详细设置…', 'Detailed settings…'), disabled: busy });
      status.textContent = failure ? t('未能读取或更新快捷入口，请重新打开此设置重试。', 'Could not read or update quick entry. Reopen these settings to try again.')
        : busy ? t('正在更新…', 'Updating…') : !confirmed ? t('正在读取本机状态…', 'Reading local status…') : '';
      status.hidden = !status.textContent;
    }
    const valid = value => value?.status === 'ok' && ['off', 'island', 'edge', 'menuBar'].includes(value.mode)
      && typeof value.isEnabled === 'boolean' && value.isEnabled === (value.mode !== 'off')
      && ['island', 'edge', 'menuBar'].includes(value.preferredEnabledMode)
      && (!value.isEnabled || value.preferredEnabledMode === value.mode);
    async function perform(action, value, event) {
      if (busy) return;
      const token = ++revision;
      busy = action !== 'state'; failure = false;
      try {
        // Invoke within the originating event; never defer or fabricate a gesture.
        const pending = action === 'enabled' ? api.setEnabled(value, event) : action === 'mode' ? api.setMode(value, event)
          : action === 'open' ? api.openSettings(event) : api.state();
        render();
        const result = await pending;
        if (token !== revision) return;
        if (!valid(result)) throw new Error('quick_entry_unavailable');
        confirmed = result;
      } catch (_) { if (token === revision) failure = true; }
      finally {
        if (token === revision) {
          busy = false; render();
          if (refreshPending) { refreshPending = false; perform('state'); }
        }
      }
    }
    enabled.addEventListener('change', event => perform('enabled', enabled.checked, event));
    mode.addEventListener('change', event => perform('mode', mode.value, event));
    const refresh = () => {
      if (record?.selected !== 'appearance') return;
      if (busy) { refreshPending = true; return; }
      return perform('state');
    };
    root.addEventListener('focus', refresh);
    root.addEventListener('aibro-quick-entry-change', refresh);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refresh(); });
    doc.addEventListener('workstation-language-change', render);
    render(); perform('state');
    return { refresh };
  }
  function groupCards() {
    if (!record) return;
    const { page, panels } = record;
    const move = (node, section) => { if (node && node.parentElement !== panels[section]) panels[section].append(node); };
    move(page.querySelector('.settings-connection-card'), 'models');
    move(page.querySelector('[data-permission]')?.closest('article'), 'models');
    move(page.querySelector('#usageCostCard'), 'models');
    move(page.querySelector('#cloudSyncCard'), 'sync');
    move(page.querySelector('#embeddingSettings'), 'knowledge');
    for (const selector of ['.language-settings-card', '#soundAlertCard', '#appearanceCard']) move(page.querySelector(selector), 'appearance');
    for (const node of page.querySelectorAll(':scope > .build-info')) move(node, 'appearance');
  }
  function init(options) {
    if (options) hooks = options;
    if (record) { groupCards(); return true; }
    const doc = root.document, page = doc?.getElementById('settings');
    if (!page || !root.HalaskaUI?.mount) return false;
    let selected = 'models';
    try { const saved = root.localStorage.getItem(KEY); if (SECTIONS.includes(saved)) selected = saved; } catch (_) {}
    const savedSection = hooks.getState?.()?.ui?.settingsSection;
    if (SECTIONS.includes(savedSection)) selected = savedSection;
    const nav = doc.createElement('div'); nav.id = 'settingsNavigation';
    page.querySelector('.page-heading').after(nav);
    let island;
    try { island = root.HalaskaUI.mount(nav, 'SettingsNavigation', { selected, onSelect: section => reveal(section) }); }
    catch (_) { root.HalaskaUI.unmount?.(nav); nav.remove(); return false; }
    const host = doc.createElement('div'); host.className = 'settings-panels'; nav.after(host);
    const panels = Object.fromEntries(SECTIONS.map(section => {
      const panel = doc.createElement('section'); panel.id = `settings-panel-${section}`;
      panel.className = 'settings-section'; panel.dataset.settingsSection = section;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `settings-tab-${section}`);
      panel.hidden = section !== selected; panel.inert = section !== selected;
      host.append(panel); return [section, panel];
    }));
    host.prepend(panels[selected]);
    const saveBar = doc.createElement('div'); saveBar.className = 'settings-save-bar';
    const help = doc.createElement('p'); help.id = 'settingsSaveScope';
    const save = doc.getElementById('saveSettings');
    if (save) { save.setAttribute('aria-describedby', help.id); saveBar.append(help, save); panels.models.append(saveBar); }
    record = { page, nav, island, panels, selected, help, touched: false };
    page.classList.add('settings-sectioned');
    groupCards();
    record.quickEntry = quickEntryCard(panels.appearance);
    function updateLanguage() {
      help.textContent = language()
        ? 'Save API settings, permissions and usage prices here. Connection type, account model and workspace models apply immediately.'
        : '在此保存 API 配置、权限与用量单价。连接方式、账号模型和工作区模型修改后立即生效。';
    }
    updateLanguage(); doc.addEventListener('workstation-language-change', updateLanguage);
    // Existing modules may initialize later. Observe only their append targets,
    // never form values or React children, and never rerender a business form.
    if (root.MutationObserver) {
      const observer = new root.MutationObserver(groupCards);
      observer.observe(page, { childList: true });
      const staging = page.querySelector(':scope > .settings-grid');
      if (staging) observer.observe(staging, { childList: true });
      record.observer = observer;
    }
    return true;
  }
  function reveal(section, options = {}) {
    if (!SECTIONS.includes(section) || !init()) return false;
    const { panels, nav, island } = record, active = root.document.activeElement;
    const focusWasHidden = SECTIONS.some(id => id !== section && panels[id].contains(active));
    record.selected = section;
    // Hidden sections cannot receive focus. Keep the active retained panel before
    // its hidden siblings: WKWebView can otherwise omit later panels from its AX
    // tree after visiting the first one. Do not recreate controllers or fields.
    for (const id of SECTIONS) {
      panels[id].hidden = id !== section;
      panels[id].inert = id !== section;
    }
    const panel = panels[section];
    if (panel.parentElement.firstElementChild !== panel) panel.parentElement.prepend(panel);
    island.update({ selected: section });
    if (section === 'appearance') record.quickEntry?.refresh();
    try { root.localStorage.setItem(KEY, section); } catch (_) {}
    if (!options.restore) {
      record.touched = true;
      const state = hooks.getState?.();
      if (state?.ui && state.ui.settingsSection !== section) {
        state.ui.settingsSection = section;
        hooks.save?.();
      }
    }
    // Scroll only the selected tab, not the document or the surrounding reader.
    const tab = nav.querySelector(`#settings-tab-${section}`);
    const scroller = nav.querySelector('.settings-tabs-scroll');
    if (scroller && tab) {
      const box = tab.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
      if (box.left < viewport.left) scroller.scrollLeft -= viewport.left - box.left;
      else if (box.right > viewport.right) scroller.scrollLeft += box.right - viewport.right;
    }
    const focus = typeof options.focus === 'string' ? root.document.getElementById(options.focus.replace(/^#/, '')) : null;
    if (focus && panels[section].contains(focus) && !focus.closest('[hidden]')) focus.focus({ preventScroll: true });
    else if (focusWasHidden) tab?.focus({ preventScroll: true });
    return true;
  }
  function restore() {
    if (!record || record.touched) return false;
    const section = hooks.getState?.()?.ui?.settingsSection;
    return SECTIONS.includes(section) ? reveal(section, { restore: true }) : false;
  }
  root.SettingsWorkspace = Object.freeze({ init, reveal, restore, selected: () => record?.selected || 'models' });
})(typeof window !== 'undefined' ? window : globalThis);
