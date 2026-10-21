/* 快捷键说明面板（对齐 NewMax §16）：把散落在代码里的快捷键集中呈现，
   降低"功能有、但没人知道怎么用"的发现成本。

   两条纪律：
   · 清单只列**真实存在**的快捷键（每一条都对应代码里的处理，见 tests/shortcuts.test.js 的核验）；
   · 不编造"应该有的"快捷键——宁缺勿假。新增快捷键时同步这一份清单。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Shortcuts = api;
})(globalThis, root => {
  'use strict';

  // 分组清单：keys 用数组是为了在界面上把每个键做成独立的 kbd 片段。
  const GROUPS = [
    {
      id: 'global', zh: '全局', en: 'Global', items: [
        { keys: ['⌘', 'K'], zh: '搜索对话、项目、笔记与资料', en: 'Search conversations, projects, notes and sources', verify: { file: 'app/app.js', token: "event.key.toLowerCase() === 'k'" } },
        { keys: ['⌘', 'N'], zh: '新建对话', en: 'New conversation', verify: { file: 'app/app.js', token: "event.key.toLowerCase() === 'n'" } },
        { keys: ['⌘', 'F'], zh: '在当前 PDF 或对话中查找', en: 'Find in the current PDF or conversation', verify: { file: 'app/app.js', token: "event.key.toLowerCase() === 'f'" } },
        { keys: ['⌘', '/'], zh: '打开这份快捷键说明', en: 'Open this shortcut reference', verify: { file: 'app/shortcuts.js', token: 'shortcutsDialog' } }
      ]
    },
    {
      id: 'composer', zh: '输入框', en: 'Composer', items: [
        { keys: ['Enter'], zh: '发送消息', en: 'Send message', verify: { file: 'app/app.js', token: "event.key === 'Enter' && !event.shiftKey" } },
        { keys: ['Shift', 'Enter'], zh: '换行，不发送', en: 'New line without sending' },
        { keys: ['⌘', 'Enter'], zh: '执行中：把输入注入下一个工具边界（不打断正在执行的工具）', en: 'While running: inject at the next tool boundary', verify: { file: 'app/app.js', token: 'injectComposer' } },
        { keys: ['Shift', 'Tab'], zh: '把「计划 / 目标」类表述转成对应模式', en: 'Turn “plan / goal” wording into that mode', verify: { file: 'app/app.js', token: 'ModeHint?.convert' } },
        { keys: ['@'], zh: '引用文件、笔记与本机文件', en: 'Reference files, notes and local files', verify: { file: 'app/file-context-ui.js', token: 'F.mention' } },
        { keys: ['/'], zh: '打开技能与命令菜单', en: 'Open the skills and commands menu' },
        { keys: ['Esc'], zh: '生成中：停止当前回复（浮层打开时先关闭浮层）', en: 'While running: stop the current reply (open overlays close first)', verify: { file: 'app/app.js', token: 'function escapeStopsRun' } },
        { keys: ['⌘', 'Enter'], zh: '编辑消息时：保存并重发；Esc 取消编辑', en: 'Editing a message: save and resend; Esc cancels', verify: { file: 'app/app.js', token: "event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!save.disabled) form.requestSubmit()" } }
      ]
    },
    {
      id: 'reader', zh: '阅读与编辑', en: 'Reading & editing', items: [
        { keys: ['⌘', 'S'], zh: '在笔记编辑器内保存', en: 'Save inside the note editor', verify: { file: 'app/note-editor.js', token: "event.key.toLowerCase() === 's'" } }
      ]
    },
    {
      id: 'overlays', zh: '浮层与查找', en: 'Overlays & find', items: [
        { keys: ['Esc'], zh: '关闭当前浮层 / 查找栏 / 预览', en: 'Close the current overlay, find bar or preview' },
        { keys: ['↑', '↓'], zh: '在菜单与候选列表里移动', en: 'Move through menus and suggestion lists', verify: { file: 'app/skills-ui.js', token: "event.key === 'ArrowDown'" } }
      ]
    }
  ];

  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  const $ = selector => root.document?.querySelector(selector);

  // ── 纯函数（由单测直接覆盖） ────────────────────────────────
  // 面板展示的条目 = 有两组以上按键或说明文本的条目（防呆，不隐藏任何真实条目）。
  function entries() {
    return GROUPS.flatMap(group => group.items.map(item => ({ group: group.id, groupLabel: T(group.zh, group.en), ...item })));
  }

  // 渲染成一段结构化的文本（供复制/屏幕阅读器/测试使用）。
  function asText() {
    return GROUPS.map(group => {
      const lines = group.items.map(item => `${item.keys.join(' + ')} — ${T(item.zh, item.en)}`);
      return `${T(group.zh, group.en)}\n${lines.join('\n')}`;
    }).join('\n\n');
  }

  // 核验用：清单里带 verify 的条目，必须在对应文件里找到那段代码。
  function verifiable() {
    return entries().filter(item => item.verify).map(item => ({ keys: item.keys.join('+'), ...item.verify }));
  }

  // ── 面板 ─────────────────────────────────────────────────
  let dialog = null;

  function build() {
    const doc = root.document;
    if (!doc) return null;
    if (dialog && dialog.isConnected) return dialog;
    dialog = doc.createElement('dialog');
    dialog.className = 'shortcuts-dialog';
    dialog.id = 'shortcutsDialog';
    const form = doc.createElement('form');
    form.method = 'dialog';
    const head = doc.createElement('div');
    head.className = 'dialog-header';
    const headText = doc.createElement('div');
    const eyebrow = doc.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = T('快捷操作', 'Shortcuts');
    const title = doc.createElement('h2');
    title.textContent = T('键盘快捷键', 'Keyboard shortcuts');
    headText.append(eyebrow, title);
    const close = doc.createElement('button');
    close.className = 'icon';
    close.value = 'cancel';
    close.type = 'submit';
    close.setAttribute('aria-label', T('关闭', 'Close'));
    close.textContent = '×';
    head.append(headText, close);
    const body = doc.createElement('div');
    body.className = 'shortcuts-body';
    for (const group of GROUPS) {
      const section = doc.createElement('section');
      section.className = 'shortcuts-group';
      const heading = doc.createElement('h3');
      heading.textContent = T(group.zh, group.en);
      section.append(heading);
      for (const item of group.items) {
        const row = doc.createElement('div');
        row.className = 'shortcut-row';
        const keys = doc.createElement('span');
        keys.className = 'shortcut-keys';
        item.keys.forEach((key, index) => {
          if (index) keys.append(doc.createTextNode(' + '));
          const kbd = doc.createElement('kbd');
          kbd.textContent = key;
          keys.append(kbd);
        });
        const label = doc.createElement('span');
        label.className = 'shortcut-label';
        label.textContent = T(item.zh, item.en);
        row.append(keys, label);
        section.append(row);
      }
      body.append(section);
    }
    form.append(head, body);
    dialog.append(form);
    doc.body.append(dialog);
    return dialog;
  }

  function open() {
    const node = build();
    if (!node) return false;
    if (!node.open) node.showModal();
    return true;
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  function init(options) {
    const doc = root.document;
    if (!doc) return { ok: false, reason: 'no-document' };
    // ⌘/ 打开；再按一次关闭（与查找栏用 Esc 关闭一致，这里多给一个同键开关）。
    root.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== '/') return;
      event.preventDefault();
      dialog?.open ? close() : open();
    });
    // 设置页的入口按钮（若存在）。
    const trigger = doc.querySelector('[data-open-shortcuts]');
    if (trigger) trigger.addEventListener('click', () => open());
    return { ok: true, groups: GROUPS.length, items: entries().length };
  }

  root.Shortcuts = { init, open, close, entries, asText, verifiable, _pure: { entries, asText, verifiable, GROUPS } };
  return root.Shortcuts;
});
