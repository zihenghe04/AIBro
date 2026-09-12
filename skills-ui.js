(function (root) {
  'use strict';
  const Core = root.WorkstationSkillsCore;
  let hooks = null;
  let dialog, listBox, editor, status, sidebarButton, composerButton, picker, input;
  let editingId = null;
  let choices = [];
  let activeChoice = 0;
  let dismissedSlash = null;
  let initialized = false;
  const state = () => hooks.getState();
  const conversation = () => hooks.getConversation?.() || (state().conversations || []).find(item => item.id === state().currentConversationId);
  const element = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; };
  const button = (label, className, action) => { const node = element('button', className, label); node.type = 'button'; if (action) node.addEventListener('click', action); return node; };
  const report = message => { if (status) status.textContent = message; hooks.toast?.(message); };

  function commit(next) {
    const current = state();
    if (Array.isArray(next.skills)) current.skills = next.skills;
    // Keep conversation identities intact for active agent runs.
    (next.conversations || []).forEach(updated => {
      const original = (current.conversations || []).find(item => item.id === updated.id);
      if (original && Object.prototype.hasOwnProperty.call(updated, 'skillId')) original.skillId = updated.skillId;
    });
    const saved = hooks.save();
    if (saved?.catch) saved.catch(error => report(error?.message || '技能保存失败，请重试'));
    refresh();
  }
  function applySkill(id) {
    try {
      let current = conversation();
      if (!current && hooks.newConversation) { hooks.newConversation(); current = conversation(); }
      commit(Core.select(state(), current?.id, id));
      if (Core.slashQuery(input.value) !== null) { input.value = ''; if (current) current.draft = ''; input.dispatchEvent(new Event('input', { bubbles: true })); hooks.save(); }
      closePicker(); dialog.close(); input.focus();
      hooks.toast?.(id ? `已选择 ${Core.get(state(), id).name}` : '已清除当前技能');
    } catch (error) { report(error.message); }
  }
  function renderList() {
    editingId = null; editor.hidden = true; listBox.hidden = false;
    dialog.querySelector('.skills-toolbar').hidden = false;
    listBox.replaceChildren(); status.textContent = '';
    const selectedId = conversation()?.skillId;
    Core.list(state()).forEach(skill => {
      const row = element('div', 'skills-row');
      const copy = element('div', 'skills-copy');
      const name = element('div', `skills-name${skill.builtin ? ' skills-builtin' : ''}`);
      const title = element('span', '', skill.name); title.setAttribute(skill.builtin ? 'data-i18n' : 'data-user-content', ''); name.append(title);
      name.append(element('code', 'skills-command', `/${skill.command}`));
      if (skill.builtin) { const badge = element('span', 'skills-badge', '内置'); badge.setAttribute('data-i18n', ''); name.append(badge); }
      const description = element('p', '', skill.description || '自定义工作流'); description.setAttribute(skill.builtin || !skill.description ? 'data-i18n' : 'data-user-content', '');
      copy.append(name, description);
      const actions = element('div', 'skills-actions');
      actions.append(button(skill.builtin ? '查看' : '编辑', 'skills-button', () => showEditor(skill)));
      const use = button(selectedId === skill.id ? '已选择' : '选择', `skills-button${selectedId === skill.id ? ' skills-primary' : ''}`, () => applySkill(skill.id));
      use.setAttribute('aria-label', `选择${skill.name}`); actions.append(use); row.append(copy, actions); listBox.append(row);
    });
    dialog.querySelector('#skillsClear').disabled = !selectedId;
    const toggle = dialog.querySelector('#skillsEnabled');
    if (toggle) toggle.checked = state().settings?.skillsEnabled !== false;
  }
  function field(label, key, value, maxLength, multiline, readonly) {
    const wrap = element('label', 'skills-field'); wrap.append(element('span', '', label));
    const control = element(multiline ? 'textarea' : 'input', 'skills-input');
    control.name = key; control.id = `skillsField-${key}`; control.value = value || ''; control.maxLength = maxLength; control.readOnly = !!readonly;
    if (!multiline) { control.type = 'text'; control.autocomplete = 'off'; }
    if (key === 'command') { control.placeholder = '例如 weekly-review'; control.spellcheck = false; }
    if (key === 'instructions') control.placeholder = '描述适用场景、具体步骤和期望结果……';
    wrap.append(control); return wrap;
  }
  function copyAsCustom(skill) {
    // Allocate from the current catalog when the user opens a copy. Core.upsert
    // validates again on Save in case another operation claimed the command.
    const commands = new Set(Core.list(state()).map(item => item.command));
    let index = 1, command;
    do {
      const suffix = index === 1 ? '-custom' : `-custom-${index}`;
      command = `${skill.command.slice(0, 40 - suffix.length)}${suffix}`;
      index++;
    } while (commands.has(command));
    const nameSuffix = index === 2 ? ' · 自定义' : ` · 自定义 ${index - 1}`;
    const draft = { name: `${skill.name.slice(0, 60 - nameSuffix.length)}${nameSuffix}`, command, description: skill.description, instructions: skill.instructions, builtin: false };
    showEditor(draft);
    status.textContent = `已复制「${skill.name}」的说明，可按研究方向修改。点击“保存技能”后才会创建；当前对话的技能不会改变。`;
  }
  function showEditor(skill = null) {
    editingId = skill?.id || null; status.textContent = '';
    listBox.hidden = true; dialog.querySelector('.skills-toolbar').hidden = true; editor.hidden = false; editor.replaceChildren();
    editor.append(field('名称', 'name', skill?.name, 60, false, skill?.builtin), field('快捷命令 /', 'command', skill?.command, 40, false, skill?.builtin), field('简介', 'description', skill?.description, 240, false, skill?.builtin), field('工作流说明', 'instructions', skill?.instructions, 12000, true, skill?.builtin));
    const actions = element('div', 'skills-editor-actions');
    if (skill?.builtin) actions.append(button('复制为自定义', 'skills-button skills-primary', () => copyAsCustom(skill)));
    if (skill?.id && !skill.builtin) actions.append(button('删除技能', 'skills-button skills-danger', () => {
      if (!root.confirm(`删除「${skill.name}」？使用它的对话将清除技能选择。`)) return;
      try { commit(Core.remove(state(), skill.id)); renderList(); hooks.toast?.('技能已删除'); } catch (error) { report(error.message); }
    }));
    actions.append(button('返回', 'skills-button', renderList));
    if (!skill?.builtin) actions.append(button('保存技能', 'skills-button skills-primary', () => {
      const draft = { id: editingId };
      ['name', 'command', 'description', 'instructions'].forEach(key => { draft[key] = editor.querySelector(`[name=${key}]`).value; });
      try { commit(Core.upsert(state(), draft)); renderList(); hooks.toast?.('技能已保存'); } catch (error) { report(error.message); }
    }));
    editor.append(actions); editor.querySelector('input')?.focus();
  }
  function open() { closePicker(); renderList(); if (!dialog.open) dialog.showModal(); }
  function closePicker() {
    if (!picker) return;
    picker.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function syncChoice() {
    picker.querySelectorAll('[role=option]').forEach((node, index) => node.setAttribute('aria-selected', String(index === activeChoice)));
    const active = picker.querySelector(`[aria-selected=true]`);
    if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function showPicker() {
    const query = Core.slashQuery(input.value);
    if (query === null || dismissedSlash === input.value || dialog.open) { closePicker(); return; }
    choices = Core.list(state(), query); activeChoice = 0; picker.replaceChildren(); picker.hidden = false; input.setAttribute('aria-expanded', 'true');
    choices.forEach((skill, index) => {
      const item = button('', 'skill-option', () => applySkill(skill.id));
      item.id = `skill-option-${skill.id}`; item.setAttribute('role', 'option'); item.tabIndex = -1;
      const copy = element('span', 'skill-option-copy', skill.name); copy.append(element('small', '', skill.description));
      item.append(copy, element('code', 'skill-option-command', `/${skill.command}`));
      item.addEventListener('mouseenter', () => { activeChoice = index; syncChoice(); });
      item.addEventListener('mousedown', event => event.preventDefault()); picker.append(item);
    });
    if (!choices.length) picker.append(element('div', 'skills-empty', '没有匹配的技能，可在侧栏 Skills 中创建。'));
    syncChoice();
  }
  function refresh() {
    if (!initialized) return;
    const skill = Core.selected(state(), conversation());
    composerButton.replaceChildren(element('span', '', skill ? skill.name : 'Skills')); composerButton.insertAdjacentHTML('afterbegin', root.WorkstationIcons.icon('spark'));
    composerButton.dataset.active = String(!!skill);
    composerButton.title = skill ? `当前技能：${skill.name}。点击更换或清除` : '选择工作流技能，也可输入 /';
    if (!picker.hidden) showPicker();
  }
  function init(options) {
    if (!Core) throw new Error('请先加载 skills-core.js');
    if (typeof options?.getState !== 'function' || typeof options?.save !== 'function') throw new Error('Skills 需要 getState 和 save 接口');
    hooks = options;
    if (initialized) { refresh(); return api; }
    input = document.querySelector(options.inputSelector || '#agentInput');
    const sidebar = document.querySelector(options.sidebarSelector || '#sidebar .sidebar-tools');
    const footer = document.querySelector(options.composerSelector || '#composer .composer-footer');
    if (!input || !sidebar || !footer) throw new Error('找不到 Skills 的侧栏或输入框挂载点');
    
    sidebarButton = button('', 'tool-link', open); sidebarButton.id = 'skillsButton';
    const mark = element('span', 'icon-slot'); mark.innerHTML = root.WorkstationIcons.icon('spark'); sidebarButton.append(mark, element('span', '', 'Skills')); sidebarButton.setAttribute('aria-haspopup', 'dialog'); sidebar.append(sidebarButton);
    composerButton = button('Skills', 'composer-skill', open); composerButton.id = 'composerSkill'; composerButton.setAttribute('aria-haspopup', 'dialog'); footer.insertBefore(composerButton, footer.querySelector('.composer-model'));
    dialog = element('dialog'); dialog.id = 'skillsDialog'; dialog.setAttribute('aria-labelledby', 'skillsTitle');
    const header = element('div', 'skills-header'); const heading = element('div'); const title = element('h2', '', 'Skills'); title.id = 'skillsTitle'; heading.append(title, element('p', '', '让常用工作流随手可用。在输入框键入 / 快速选择。'));
    const close = button('×', 'skills-close', () => dialog.close()); close.setAttribute('aria-label', '关闭技能管理'); header.append(heading, close);
    const toolbar = element('div', 'skills-toolbar'); const clear = button('清除当前技能', 'skills-button', () => applySkill(null)); clear.id = 'skillsClear';
    const toggleLabel = element('label', 'skills-toggle'); const toggle = element('input'); toggle.type = 'checkbox'; toggle.id = 'skillsEnabled'; toggle.checked = state().settings?.skillsEnabled !== false; toggle.addEventListener('change', () => { const current = state(); current.settings ||= {}; current.settings.skillsEnabled = toggle.checked; hooks.save(); refresh(); }); const toggleText = element('span', '', '允许注入技能说明'); toggleText.setAttribute('data-i18n', ''); toggleLabel.append(toggle, toggleText);
    const toolbarActions = element('div'); toolbarActions.style.cssText = 'display:flex;gap:8px;align-items:center'; toolbarActions.append(clear, button('＋ 新建技能', 'skills-button skills-primary', () => showEditor())); toolbar.append(toggleLabel, toolbarActions);
    listBox = element('div', 'skills-list'); editor = element('div', 'skills-editor'); editor.hidden = true;
    status = element('div', 'skills-status'); status.setAttribute('role', 'status');
    dialog.append(header, toolbar, listBox, editor, status); document.body.append(dialog);
    picker = element('div'); picker.id = 'skillPicker'; picker.hidden = true; picker.setAttribute('role', 'listbox'); picker.setAttribute('aria-label', '选择工作流技能'); input.closest('#composer').append(picker);
    input.setAttribute('aria-controls', 'skillPicker'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', () => { dismissedSlash = null; showPicker(); });
    input.addEventListener('focus', showPicker);
    root.addEventListener('keydown', event => {
      if (event.target !== input || event.isComposing || event.keyCode === 229) return;
      const isSlash = Core.slashQuery(input.value) !== null;
      if (picker.hidden && event.key === 'Enter' && isSlash && !event.shiftKey) showPicker();
      if (picker.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismissedSlash = input.value; closePicker(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); if (choices.length) activeChoice = (activeChoice + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; syncChoice(); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); if (choices[activeChoice]) applySkill(choices[activeChoice].id); }
    }, true);
    document.addEventListener('click', event => {
      if (!picker.contains(event.target) && event.target !== input) closePicker();
      // Existing navigation stays in charge of state. Read its new selection
      // once its click handler has completed, without rewriting that handler.
      queueMicrotask(refresh);
    });
    initialized = true; refresh(); return api;
  }
  const api = { init, refresh, open: () => { if (initialized) open(); }, instructionForCurrent: () => initialized ? Core.instructions(state(), conversation()) : '', instructions: (value, current) => Core.instructions(value, current) };
  root.WorkstationSkills = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
