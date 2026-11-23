/* Real pages of the unified Settings shell: General, Quick entry, Voice.
   Native items go through window.workstationDesktop.nativeSettings (stable ids, trusted gesture, effective value in the reply).
   Web-only items (language, theme, palette, alert sound) reuse their existing web-side controls. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SettingsPages = api; if (root.SettingsShell?.pages) Object.assign(root.SettingsShell.pages, api.pages); }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SIZE_LABELS = { mini: ['迷你', 'Mini'], small: ['小', 'Small'], medium: ['中', 'Medium'], large: ['大', 'Large'] };
  const RETENTION_DAYS = [[0, '不限时间', 'No time limit'], [1, '1 天', '1 day'], [7, '7 天', '7 days'], [30, '30 天', '30 days'], [90, '90 天', '90 days']];
  const RETENTION_LIMITS = [10, 25, 50, 100];
  const CODES = {
    KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14,
    KeyR: 15, KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25,
    Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35,
    Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46,
    Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
    F9: 101, F10: 109, F11: 103, F12: 111, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  };
  const MOD = { cmd: 256, shift: 512, option: 2048, control: 4096 };

  /** "mods:keyCode" for a keydown, or null for a bare modifier / unknown key. Native validation stays final. */
  function shortcutCode(event) {
    const code = CODES[event.code];
    if (code == null) return null;
    const mods = (event.metaKey ? MOD.cmd : 0) | (event.shiftKey ? MOD.shift : 0) | (event.altKey ? MOD.option : 0) | (event.ctrlKey ? MOD.control : 0);
    return `${mods}:${code}`;
  }

  function formatBytes(n) {
    if (!(n > 0)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function keysOf(label) {
    const m = /^([⌃⌥⇧⌘]*)(.*)$/u.exec(label || '');
    return [...(m[1] || ''), m[2]].filter(Boolean);
  }

  const bridge = () => root.workstationDesktop?.nativeSettings || null;

  /** One controller per rendered page: keeps the latest snapshot, syncs every control, re-polls async writes. */
  function controller(ui, t) {
    const { el } = ui;
    const host = el('div', { class: 'st-page-body' });
    const syncs = [];
    let target = syncs;
    const reg = fn => target.push(fn);
    let snap = null, timer = 0;

    function apply(next) {
      if (next?.status !== 'ok') return;
      snap = next;
      for (const fn of syncs) fn(next);
      const m = next.meta || {};
      clearTimeout(timer);
      if (m.login?.changing || m.clipboard?.loading || m.clipboard?.busy || Object.values(m).some(g => g && g.changing === true)) timer = setTimeout(poll, 400);
    }
    async function poll() {
      if (!host.isConnected) return;
      try { apply(await bridge().state()); } catch (_) { /* keep the last snapshot */ }
    }
    const reasonText = r => r === 'user_gesture_required' ? t('需要在页面内手动操作', 'Needs a manual action on the page')
      : r === 'not_ready' || r === 'unavailable' ? t('暂时无法修改', 'Not available right now') : t('没有保存', 'Not saved');

    function stamp() {
      const node = el('span', { class: 'st-saved', role: 'status', hidden: true });
      let hide = 0;
      const show = (text, tone, ms) => { node.textContent = text; node.dataset.tone = tone; node.hidden = false; clearTimeout(hide); hide = setTimeout(() => { node.hidden = true; }, ms); };
      return { node, ok: () => show(t('已保存', 'Saved'), 'ok', 1800), bad: text => show(text, 'bad', 4000) };
    }

    /** Writes through the bridge; resolves to the reply snapshot (or null). The caller decides what "saved" means. */
    async function write(id, value, event) {
      const b = bridge();
      if (!b) return { error: t('仅桌面版可用', 'Desktop app only') };
      try {
        const r = await b.set(id, value, event);
        if (r?.status === 'ok') { apply(r); return { snapshot: r }; }
        return { error: reasonText(r?.reason) };
      } catch (_) { return { error: reasonText() }; }
    }

    const val = id => snap?.values?.[id];
    const meta = () => snap?.meta || {};

    function toggleRow({ id, title, description, disabled, onlyWhen, note }) {
      const st = stamp();
      const sw = ui.toggle({
        label: title,
        onChange: async (next, e) => {
          const r = await write(id, next, e);
          if (r.error) { st.bad(r.error); sw.setAttribute('aria-checked', String(val(id) === true)); } else st.ok();
        },
      });
      reg(s => {
        if (typeof s.values[id] === 'boolean') sw.setAttribute('aria-checked', String(s.values[id]));
        const off = (disabled?.(s) === true) || (onlyWhen && !onlyWhen(s));
        if (off) sw.setAttribute('aria-disabled', 'true'); else sw.removeAttribute('aria-disabled');
      });
      const row = ui.row({ title, description, control: [st.node, sw] });
      if (note) reg(s => { const text = note(s); let n = row.querySelector('.st-row-text .st-row-desc[data-note]'); if (!text) { n?.remove(); return; } if (!n) { n = el('div', { class: 'st-row-desc', 'data-note': '' }); row.querySelector('.st-row-text').append(n); } n.textContent = text; });
      return row;
    }

    function selectRow({ id, title, description, options, optionsFor }) {
      const st = stamp();
      const select = el('select', { class: 'st-select', 'aria-label': title });
      let signature = '';
      const fill = list => {
        const sig = JSON.stringify(list);
        if (sig === signature) return;
        signature = sig;
        select.replaceChildren(...list.map(([v, text]) => el('option', { value: v, text })));
      };
      if (options) fill(options);
      select.addEventListener('change', async e => {
        const r = await write(id, select.value, e);
        if (r.error) { st.bad(r.error); if (val(id) != null) select.value = val(id); } else st.ok();
      });
      reg(s => { if (optionsFor) fill(optionsFor(s)); if (s.values[id] != null) select.value = s.values[id]; });
      return ui.row({ title, description, control: [st.node, select] });
    }

    function choiceRow({ id, title, description, options, disabled }) {
      const st = stamp();
      const seg = ui.segmented({
        options, value: options[0][0], label: title,
        onChange: async (v, e) => {
          const r = await write(id, v, e);
          if (r.error) { st.bad(r.error); if (val(id)) seg.setValue(val(id)); } else st.ok();
        },
      });
      reg(s => { if (s.values[id]) seg.setValue(s.values[id]); seg.setDisabled(disabled?.(s) === true); });
      return ui.row({ title, description, control: [st.node, seg] });
    }

    function recorderRow({ id, title, description, labelOf, issueOf, hidden }) {
      const st = stamp();
      const holder = el('div');
      let state = 'idle', errorText = '', cancel = null;
      const draw = () => {
        const btn = ui.shortcut({ keys: keysOf(labelOf(snap)), state, label: title, errorText });
        btn.addEventListener('click', e => { if (state !== 'recording') start(btn, e); });
        holder.replaceChildren(btn);
        return btn;
      };
      function stop(next, text = '') { cancel?.(); cancel = null; state = next; errorText = text; draw(); }
      function start(btn) {
        state = 'recording';
        const b = draw();
        b.focus();
        const onKey = async e => {
          if (e.key === 'Tab') return;
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { stop('idle'); return; }
          const code = shortcutCode(e);
          if (!code) return;
          // The bridge checks the trusted event's target synchronously, so write before the button is replaced.
          const pending = write(id, code, e);
          stop('idle');
          const r = await pending;
          if (r.error) { st.bad(r.error); return; }
          if (val(id) === code) { st.ok(); return; }
          // Native refused it (reserved, taken, or invalid); show why and fall back to the value in effect.
          stop('error', issueOf?.(snap) || t('该组合键不可用', 'Shortcut unavailable'));
          setTimeout(() => { if (state === 'error') stop('idle'); }, 3500);
        };
        const onBlur = () => { if (state === 'recording') stop('idle'); };
        b.addEventListener('keydown', onKey);
        b.addEventListener('blur', onBlur);
        cancel = () => { b.removeEventListener('keydown', onKey); b.removeEventListener('blur', onBlur); };
      }
      reg(s => { if (state === 'idle') draw(); });
      draw();
      const row = ui.row({ title, description, control: [st.node, holder] });
      if (hidden) reg(s => { row.hidden = hidden(s); });
      return row;
    }

    function dynamic(container, signature, build) {
      let last = null, owned = [];
      syncs.push(s => {
        const sig = signature(s);
        if (sig !== last) {
          last = sig;
          owned = [];
          const prev = target;
          target = owned;
          let nodes;
          try { nodes = [].concat(build(s)); } finally { target = prev; }
          const focus = root.document?.activeElement?.dataset?.focusKey;
          container.replaceChildren(...nodes);
          if (focus) container.querySelector(`[data-focus-key="${focus}"]`)?.focus();
        }
        for (const fn of owned) fn(s);
      });
      return container;
    }


    function mount(...nodes) {
      host.append(...nodes);
      if (bridge()) setTimeout(poll, 0);
      else host.prepend(ui.group(null, [ui.row({ title: t('桌面版专属', 'Desktop app only'), description: t('这些设置只在 AI Bro 桌面版中可用。', 'These settings are only available in the AI Bro desktop app.'), control: [] })]));
      return host;
    }
    /** Like mount, but for pages that also hold web-only settings: no "desktop only" banner. */
    function mountQuiet(...nodes) { host.append(...nodes); if (bridge()) setTimeout(poll, 0); return host; }
    return { el, host, mountQuiet, apply, poll, write, val, meta, toggleRow, selectRow, choiceRow, recorderRow, dynamic, stamp, syncs, mount, snapshot: () => snap };
  }

  /* ---------- General ---------- */
  function general(ui, t) {
    const c = controller(ui, t);
    const { el } = c;
    const i18n = root.WorkstationI18n;

    const appearance = [];
    const lang = ui.segmented({
      options: [['zh-CN', '中文'], ['en', 'English']], value: i18n?.getLanguage?.() === 'en' ? 'en' : 'zh-CN', label: t('界面语言', 'Interface language'),
      onChange: v => { i18n?.setLanguage?.(v); queueMicrotask(() => root.SettingsShell?.relabel?.()); },
    });
    appearance.push(ui.row({ title: t('界面语言', 'Interface language'), description: t('只改界面文字，不改你的内容。', 'Changes interface text only, never your content.'), control: lang }));

    const doc = root.document;
    const isLight = () => doc.body.classList.contains('light-mode');
    const theme = ui.segmented({
      options: [['light', t('浅色', 'Light')], ['dark', t('深色', 'Dark')]], value: isLight() ? 'light' : 'dark', label: t('外观', 'Appearance'),
      onChange: v => { if ((v === 'light') !== isLight()) doc.getElementById('themeBtn')?.click(); theme.setValue(isLight() ? 'light' : 'dark'); },
    });
    appearance.push(ui.row({ title: t('外观', 'Appearance'), description: t('浅色或深色。', 'Light or dark.'), control: theme }));

    const paletteSelect = doc.getElementById('paletteSelect');
    if (paletteSelect) {
      const options = [...paletteSelect.options].map(o => [o.value, o.textContent.trim()]);
      const palette = el('select', { class: 'st-select', 'aria-label': t('配色', 'Color palette') }, options.map(([v, text]) => el('option', { value: v, text: root.WorkstationI18n?.translate?.(text) || text })));
      palette.value = paletteSelect.value;
      palette.addEventListener('change', () => { paletteSelect.value = palette.value; paletteSelect.dispatchEvent(new root.Event('change', { bubbles: true })); });
      appearance.push(ui.row({ title: t('配色', 'Color palette'), description: t('与浅色/深色分开设置。', 'Set separately from light and dark.'), control: palette }));
    }

    const startup = [
      c.toggleRow({ id: 'login.enabled', title: t('登录时启动', 'Open at login'), description: t('登录 Mac 后自动打开 AI Bro。', 'Open AI Bro when you log in to this Mac.'), disabled: s => s.meta?.login?.changing === true }),
      c.toggleRow({ id: 'login.background', title: t('登录后在后台运行', 'Start in the background'), description: t('登录启动时不弹出主窗口。', 'Do not show the main window when started at login.'), onlyWhen: s => s.values['login.enabled'] === true }),
    ];
    const loginIssue = el('div', { class: 'st-sub', hidden: true, role: 'status' });
    c.syncs.push(s => { const v = s.meta?.login?.issue; loginIssue.hidden = !v; loginIssue.textContent = v || ''; loginIssue.dataset.tone = 'bad'; });

    const sounds = [];
    const AS = root.AlertSound;
    if (AS?.sync && AS?.update) {
      const kinds = [['enabled', t('提示音', 'Alert sounds'), t('只在你切到其他应用时播放。', 'Only plays while you are in another app.')],
        ['done', t('执行完成', 'Run finished'), ''], ['attention', t('需要你处理', 'Needs you'), ''], ['failed', t('执行未完成', 'Run incomplete'), ''], ['task', t('定时任务完成', 'Scheduled task finished'), '']];
      const switches = new Map();
      for (const [kind, title, description] of kinds) {
        const sw = ui.toggle({ label: title, checked: AS.sync()[kind] !== false, onChange: next => { AS.update({ [kind]: next }); refresh(); } });
        switches.set(kind, sw);
        sounds.push(ui.row({ title, description, control: sw }));
      }
      function refresh() {
        const prefs = AS.sync();
        for (const [kind, sw] of switches) {
          sw.setAttribute('aria-checked', String(prefs[kind] !== false));
          if (kind !== 'enabled') { if (prefs.enabled === false) sw.setAttribute('aria-disabled', 'true'); else sw.removeAttribute('aria-disabled'); }
        }
      }
      refresh();
    }

    const proxyToggle = (id, title, description) => {
      const input = doc.getElementById(id);
      if (!input) return null;
      const sw = ui.toggle({ label: title, checked: !!input.checked, onChange: next => { input.checked = !!next; input.dispatchEvent(new root.Event('change', { bubbles: true })); } });
      input.addEventListener('change', () => sw.setAttribute('aria-checked', String(!!input.checked)));
      return ui.row({ title, description, control: sw });
    };
    const behavior = [
      proxyToggle('reduceMotionToggle', t('减少动画', 'Reduce motion'), t('关闭界面过渡和动效。', 'Turns off interface transitions and motion.')),
      proxyToggle('privateModeToggle', t('无痕模式', 'Private mode'), t('新对话不留记录，重启后永久删除。', 'New chats leave no record and are deleted for good on restart.')),
    ].filter(Boolean);
    const buildBox = doc.getElementById('buildInfo');
    const about = el('div', { class: 'st-sub' }, [
      el('span', { text: buildBox ? buildBox.textContent.trim() : '' }),
      el('span', { text: ' · ' }),
      el('a', { href: 'https://github.com/zihenghe04/AIBro/blob/main/LICENSE', target: '_blank', rel: 'noopener noreferrer', text: 'AGPL-3.0' }),
      el('span', { text: ' · ' }),
      el('a', { href: 'https://github.com/zihenghe04/AIBro', target: '_blank', rel: 'noopener noreferrer', text: 'GitHub' }),
    ]);
    const children = [ui.group(t('外观', 'Appearance'), appearance)];
    if (behavior.length) children.push(ui.group(t('行为', 'Behavior'), behavior));
    children.push(ui.group(t('启动', 'Startup'), startup), loginIssue);
    if (sounds.length) children.push(ui.group(t('提示音', 'Alert sounds'), sounds));
    children.push(ui.group(t('关于', 'About'), [about]));
    return c.mount(...children);
  }

  /* ---------- Quick entry ---------- */
  function quickEntry(ui, t) {
    const c = controller(ui, t);
    const { el } = c;

    const entry = ui.group(t('入口', 'Entry'), [
      c.toggleRow({ id: 'quickEntry.enabled', title: t('启用快捷入口', 'Enable quick entry'), description: t('在屏幕边缘或菜单栏随时唤起 AI Bro。', 'Reach AI Bro from the screen edge or the menu bar.') }),
      c.choiceRow({
        id: 'quickEntry.mode', title: t('显示位置', 'Where it appears'), description: t('灵动岛、屏幕边缘或菜单栏。', 'Island, screen edge, or menu bar.'),
        options: [['island', t('灵动岛', 'Island')], ['edge', t('屏幕边缘', 'Edge')], ['menuBar', t('菜单栏', 'Menu bar')]],
        disabled: s => s.values['quickEntry.enabled'] === false,
      }),
      c.recorderRow({ id: 'quickEntry.shortcut', title: t('唤起快捷键', 'Shortcut'), description: t('全局快捷键，需要至少一个修饰键。', 'A global shortcut; needs at least one modifier key.'), labelOf: s => s?.meta?.quickEntry?.label || '', issueOf: s => s?.meta?.quickEntry?.issue }),
    ]);
    const entryIssue = el('div', { class: 'st-sub', hidden: true, role: 'status' });
    c.syncs.push(s => { const v = s.meta?.quickEntry?.issue; entryIssue.hidden = !v; entryIssue.textContent = v || ''; entryIssue.dataset.tone = 'bad'; });

    const defaultBox = el('div');
    const panelGroup = ui.group(t('面板', 'Panel'), [defaultBox]);
    const defaultRow = c.selectRow({
      id: 'quickPanel.default', title: t('默认打开的页面', 'Opens on'), description: t('快捷面板每次打开时先显示这一页。', 'The page the quick panel shows first.'),
      optionsFor: s => (s.meta?.quickPanel?.sections || []).map(x => [x.id, x.title]),
    });
    defaultBox.replaceWith(defaultRow);

    const sectionBox = el('div', { class: 'st-group' });
    c.dynamic(sectionBox, s => JSON.stringify((s.meta?.quickPanel?.sections || []).filter(x => x.canHide)), s =>
      (s.meta?.quickPanel?.sections || []).filter(x => x.canHide).map(x => c.toggleRow({ id: 'quickPanel.section.' + x.id, title: x.title })));
    const sectionsWrap = el('section', {}, [el('h3', { class: 'st-group-title', text: t('可见功能', 'Visible features') }), sectionBox,
      el('p', { class: 'st-group-note', text: t('隐藏后不会出现在快捷面板中，数据不受影响。', 'Hidden features leave the quick panel; your data is untouched.') })]);

    const homeBox = el('div', { class: 'st-group' });
    const reset = el('button', { type: 'button', class: 'secondary', text: t('恢复默认布局', 'Reset layout') });
    reset.addEventListener('click', async e => { const r = await c.write('quickPanel.reset', 'run', e); if (!r.error) st.ok(); else st.bad(r.error); });
    const st = c.stamp();
    c.syncs.push(s => { if (s.meta?.quickPanel?.automatic) reset.setAttribute('aria-disabled', 'true'); else reset.removeAttribute('aria-disabled'); reset.disabled = !!s.meta?.quickPanel?.automatic; });
    c.dynamic(homeBox, s => JSON.stringify([(s.meta?.quickPanel?.modules || []), Object.keys(s.values).filter(k => k.startsWith('quickPanel.size.')).map(k => s.values[k])]), s => {
      const modules = s.meta?.quickPanel?.modules || [];
      return modules.map((m, i) => {
        const move = (dir, label, glyph) => {
          const disabled = dir === 'up' ? i === 0 : i === modules.length - 1;
          const b = el('button', { type: 'button', class: 'st-iconbtn', 'aria-label': label + ' ' + m.title, 'aria-disabled': disabled ? 'true' : null, 'data-focus-key': dir + m.id, text: glyph });
          b.addEventListener('click', e => { if (!disabled) c.write('quickPanel.move.' + m.id, dir, e); });
          return b;
        };
        const size = el('select', { class: 'st-select', 'aria-label': t('大小', 'Size') + ' ' + m.title });
        for (const k of Object.keys(SIZE_LABELS)) size.append(el('option', { value: k, text: t(...SIZE_LABELS[k]) }));
        size.value = s.values['quickPanel.size.' + m.id] || 'medium';
        size.addEventListener('change', e => c.write('quickPanel.size.' + m.id, size.value, e));
        const on = ui.toggle({ label: m.title, checked: m.visible, disabled: m.visible && m.lastVisible, onChange: (next, e) => c.write('quickPanel.home.' + m.id, next, e) });
        return ui.row({ title: m.title, description: m.visible && m.lastVisible ? t('至少保留一个主页组件', 'At least one home widget stays on') : null, control: [move('up', t('上移', 'Move up'), '↑'), move('down', t('下移', 'Move down'), '↓'), size, on] });
      });
    });
    const homeWrap = el('section', {}, [el('h3', { class: 'st-group-title', text: t('主页组件', 'Home widgets') }), homeBox,
      el('div', { class: 'st-row-control', style: 'margin-top:var(--space-8)' }, [st.node, reset]),
      el('p', { class: 'st-group-note', text: t('灵动岛上仍可就地调整组件。', 'You can still adjust widgets in place on the island.') })]);

    const clip = clipboardGroup(c, ui, t);
    return c.mount(entry, entryIssue, panelGroup, sectionsWrap, homeWrap, clip);
  }

  function clipboardGroup(c, ui, t) {
    const { el } = c;
    const days = el('select', { class: 'st-select', 'aria-label': t('保留时间', 'Keep for') }, RETENTION_DAYS.map(([v, zh, en]) => el('option', { value: v, text: t(zh, en) })));
    const limit = el('select', { class: 'st-select', 'aria-label': t('最多条数', 'Max items') }, RETENTION_LIMITS.map(v => el('option', { value: v, text: t(v + ' 条', v + ' items') })));
    const previewBtn = el('button', { type: 'button', class: 'secondary', text: t('预览清理', 'Preview cleanup') });
    const st = c.stamp();
    const detail = el('div', { class: 'st-sub', hidden: true, role: 'status' });
    const confirm = el('button', { type: 'button', text: t('确认清理', 'Confirm cleanup') });
    const cancel = el('button', { type: 'button', class: 'secondary', text: t('取消', 'Cancel') });
    const actions = el('div', { class: 'st-row-control' }, [confirm, cancel]);
    const choose = () => `${days.value}:${limit.value}`;
    previewBtn.addEventListener('click', async e => { const r = await c.write('clipboard.retention.preview', choose(), e); if (r.error) st.bad(r.error); });
    confirm.addEventListener('click', async e => { const r = await c.write('clipboard.retention.apply', 'run', e); if (r.error) st.bad(r.error); else st.ok(); });
    cancel.addEventListener('click', e => c.write('clipboard.retention.cancel', 'run', e));
    c.syncs.push(s => {
      const m = s.meta?.clipboard || {};
      const [d, l] = String(s.values['clipboard.retention.preview'] || '0:50').split(':');
      if (!days.matches(':focus')) days.value = d;
      if (!limit.matches(':focus')) limit.value = l;
      const busy = m.loading || m.busy;
      previewBtn.disabled = !m.available || !!busy;
      days.disabled = limit.disabled = !m.available;
      confirm.disabled = !!busy;
      const p = m.preview;
      actions.hidden = !p;
      detail.hidden = !(p || m.error || busy || m.available === false);
      detail.dataset.tone = m.error ? 'bad' : 'info';
      if (m.error) detail.textContent = m.error;
      else if (busy) detail.textContent = t('正在处理…', 'Working…');
      else if (p) {
        detail.textContent = p.count === 0 ? t('按这个设置，没有需要清理的内容。', 'Nothing would be removed with this setting.')
          : t(`将清理 ${p.count} 条（约 ${formatBytes(p.bytes)}），已收藏的 ${p.favorites} 条会保留。`, `Will remove ${p.count} items (about ${formatBytes(p.bytes)}). ${p.favorites} favorites are kept.`);
        if (p.count === 0) confirm.disabled = true;
      } else if (m.available === false) detail.textContent = t('剪贴板历史暂不可用。', 'Clipboard history is not available.');
    });
    const group = ui.group(t('剪贴板历史', 'Clipboard history'), [
      ui.row({ title: t('保留规则', 'Retention'), description: t('先预览会清理什么，确认后才会删除。', 'Preview what would be removed; nothing is deleted until you confirm.'), control: [st.node, days, limit, previewBtn] }),
    ]);
    group.querySelector('.st-group').append(detail, el('div', { class: 'st-sub' }, [actions]));
    return group;
  }

  /* ---------- Voice ---------- */
  function voice(ui, t) {
    const c = controller(ui, t);
    const { el } = c;
    const dictate = ui.group(t('听写到光标', 'Dictate at the cursor'), [
      c.toggleRow({ id: 'dictate.enabled', title: t('按住说话听写', 'Hold-to-dictate'), description: t('在任何应用里按住下面的触发键说话，识别后的文字会打到光标处。它不会打开灵动岛的语音面板。', 'Hold the trigger below in any app; the recognized text is typed at the cursor. It does not open the island voice panel.') }),
      c.choiceRow({
        id: 'dictate.trigger', title: t('听写触发键', 'Dictation trigger'), description: t('只用于听写到光标：右侧 Option、右侧 Command，或自定义组合键。', 'Only for dictating at the cursor: right Option, right Command, or a custom combination.'),
        options: [['rightOption', t('右 Option', 'Right Option')], ['rightCommand', t('右 Command', 'Right Command')], ['combo', t('组合键', 'Combo')]],
        disabled: s => s.values['dictate.enabled'] === false,
      }),
      c.recorderRow({ id: 'dictate.combo', title: t('听写组合键', 'Dictation combo'), labelOf: s => s?.meta?.dictate?.comboLabel || '', issueOf: s => s?.meta?.dictate?.issue, hidden: s => s.values['dictate.trigger'] !== 'combo' }),
    ]);
    const access = el('span');
    const accessRow = ui.row({ title: t('辅助功能权限', 'Accessibility access'), description: t('听写需要它来监听触发键并输入文字。这里只显示状态，不会弹出系统授权。', 'Dictation needs it to watch the trigger and type text. This shows status only and never opens a system prompt.'), control: access });
    c.syncs.push(s => { const ok = s.values['dictate.access'] === true; access.replaceChildren(ui.badge(ok ? t('已授权', 'Allowed') : t('未授权', 'Not allowed'), ok ? 'ok' : 'bad')); });
    dictate.querySelector('.st-group').append(accessRow);
    const dictateIssue = el('div', { class: 'st-sub', hidden: true, role: 'status' });
    c.syncs.push(s => { const v = s.meta?.dictate?.issue; dictateIssue.hidden = !v; dictateIssue.textContent = v || ''; dictateIssue.dataset.tone = 'bad'; });

    const speechRows = [
      c.recorderRow({ id: 'speech.shortcut', title: t('语音指令快捷键', 'Voice command shortcut'), description: t('对 AI Bro 说话下达指令：打开灵动岛的语音面板并开始录音，按下的方式见下一行。它不会往其他应用里打字。', 'Talk to AI Bro: opens the island voice panel and starts recording, as set in the next row. It does not type into other apps.'), labelOf: s => s?.meta?.speech?.label || '', issueOf: s => s?.meta?.speech?.issue }),
      c.choiceRow({ id: 'speech.mode', title: t('触发方式', 'How it works'), description: t('按住说话，或按一次开始、再按一次结束。', 'Hold to talk, or press once to start and again to stop.'), options: [['hold', t('按住', 'Hold')], ['toggle', t('点按切换', 'Toggle')]] }),
      c.toggleRow({ id: 'speech.autoSubmit', title: t('说完自动发送', 'Send when done'), description: t('识别结束后直接发送，不再等你确认。', 'Send right after recognition instead of waiting for you.') }),
      silenceRow(c, ui, t),
    ];
    const speechIssue = el('div', { class: 'st-sub', hidden: true, role: 'status' });
    c.syncs.push(s => { const v = s.meta?.speech?.issue; speechIssue.hidden = !v; speechIssue.textContent = v || ''; speechIssue.dataset.tone = 'bad'; });

    // Recognition schemes, cloud connections and realtime recognition: the connections module's own panel, mounted in place.
    // New schemes use its draft forms; stored keys are never rendered back.
    const schemeHost = el('div', { class: 'settings-adopted-host' });
    const schemes = ui.group(t('识别方案', 'Recognition'), []);
    schemes.append(schemeHost);
    if (root.AIBroSettingsAccess?.mountRoles) {
      root.AIBroSettingsAccess.mountRoles(schemeHost, 'transcription');
      ui.onLeave(() => root.AIBroSettingsAccess.parkRoles?.());
    } else schemeHost.append(ui.badge(t('识别方案仅在桌面版可用。', 'Recognition schemes are available in the desktop app.'), 'unknown'));
    return c.mount(dictate, dictateIssue, ui.group(t('语音指令（灵动岛）', 'Voice commands (island)'), speechRows), speechIssue, schemes);
  }

  function silenceRow(c, ui, t) {
    const { el } = c;
    const st = c.stamp();
    const input = el('input', { class: 'st-input', type: 'number', min: '0', max: '10', step: '0.5', inputmode: 'decimal', 'aria-label': t('静音多久后结束（秒）', 'Silence before ending (seconds)') });
    input.addEventListener('change', async e => {
      const n = Number(input.value);
      if (input.value === '' || !Number.isFinite(n)) { if (c.val('speech.silence') != null) input.value = c.val('speech.silence'); return; }
      const r = await c.write('speech.silence', n, e);
      if (r.error) st.bad(r.error); else { st.ok(); input.value = c.val('speech.silence'); }
    });
    c.syncs.push(s => { if (s.values['speech.silence'] != null && !input.matches(':focus')) input.value = s.values['speech.silence']; });
    return ui.row({ title: t('静音自动结束（秒）', 'End after silence (seconds)'), description: t('停顿这么久后自动结束，0 表示不自动结束。', 'Ends automatically after this much silence; 0 turns it off.'), control: [st.node, input] });
  }

  const pages = { general, 'quick-entry': quickEntry, voice };
  return { pages, controller, shortcutCode, formatBytes, keysOf };
});
