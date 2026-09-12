(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteEditor = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_REVISIONS = 20;
  const text = value => String(value ?? '');
  function markdownBody(value) {
    const source = text(value);
    const frontmatter = source.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
    // Hide only an actual leading metadata block. Source editing and export
    // keep every byte; ordinary Markdown separators are not YAML metadata.
    return frontmatter && /^\s*[\w\u3400-\u9fff][\w\u3400-\u9fff .-]*\s*:/m.test(frontmatter[1]) ? source.slice(frontmatter[0].length) : source;
  }
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const version = note => JSON.stringify([note.title, note.content, note.updatedAt, note.createdAt, note.projectId, note.workspace, note.sourceAttachmentIds, note.revisionHistory, note.userEditedAt, note.aiDraft, note.folderPath]);
  function normalizeFolder(value) {
    const path = text(value).trim().replace(/\\/g, '/');
    if (path.length > 500) throw new Error('保存目录最多 500 个字符。');
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('保存目录应为项目内的相对目录，例如“文献/DemoGraph”。');
    const parts = path.split('/').map(part => part.trim()).filter(part => part && part !== '.');
    if (parts.includes('..')) throw new Error('保存目录不能包含上级目录“..”。');
    if (parts.length > 12) throw new Error('保存目录最多 12 层。');
    return parts.join('/');
  }
  function editableNote(state, id) {
    const note = (state.notes || []).find(item => item.id === id);
    if (!note || note.archived || note.deletedAt) throw new Error('这篇笔记已删除或归档，未保存的草稿仍保留在当前窗口。');
    if (note.projectId) {
      const project = (state.projects || []).find(item => item.id === note.projectId);
      if (!project || project.archived || project.deletedAt) throw new Error('所属项目已删除或归档，不能覆盖保存这篇笔记。');
    }
    return note;
  }
  function begin(state, id) {
    const note = editableNote(state, id);
    return { id, base: version(note), originalTitle: text(note.title), originalContent: text(note.content), originalFolderPath: text(note.folderPath), title: text(note.title), content: text(note.content), folderPath: text(note.folderPath) };
  }
  function dirty(session) { return session.title !== session.originalTitle || session.content !== session.originalContent || Object.hasOwn(session, 'folderPath') && session.folderPath !== session.originalFolderPath || !!session.appliedAiDraft; }
  function prepare(state, session, now = Date.now()) {
    const note = editableNote(state, session.id);
    if (version(note) !== session.base) throw new Error('笔记已被其他操作修改，未覆盖最新内容。你的草稿仍保留，可先复制草稿，再载入最新版本。');
    const title = session.title.trim();
    if (!title) throw new Error('请填写笔记标题。');
    if (title.length > 240) throw new Error('笔记标题最多 240 个字符。');
    if (session.content.length > 1000000) throw new Error('笔记正文过长，请拆分为多篇笔记。');
    const folderEdited = Object.hasOwn(session, 'folderPath') && session.folderPath !== session.originalFolderPath;
    const folderPath = folderEdited ? normalizeFolder(session.folderPath) : text(note.folderPath);
    const applyingAiDraft = !!session.appliedAiDraft && session.appliedAiDraft === JSON.stringify(note.aiDraft);
    if (title === text(note.title) && session.content === text(note.content) && folderPath === text(note.folderPath) && !applyingAiDraft) return { changed: false, note };
    const before = clone(note);
    const history = Array.isArray(note.revisionHistory) ? note.revisionHistory.slice(-(MAX_REVISIONS - 1)).map(clone) : [];
    history.push({ title: text(note.title), content: text(note.content), ...(Object.hasOwn(note, 'folderPath') ? { folderPath: note.folderPath } : {}), updatedAt: note.updatedAt || note.createdAt || null, savedAt: now, userEdited: note.userEdited === true });
    const after = { ...note, title, content: session.content, userEdited: true, userEditedAt: now, updatedAt: now, revisionHistory: history };
    if (folderEdited) after.folderPath = folderPath;
    if (applyingAiDraft) delete after.aiDraft;
    return { changed: true, note, before, after };
  }
  function createController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.save !== 'function') throw new Error('笔记编辑器需要 getState 和 save 接口。');
    const drafts = new Map();
    let dialog, form, titleInput, contentInput, sources, status, historySelect, historyPreview, historyDetails, saveButton, closeButton, cancelButton, reloadButton, aiDetails, aiPreview, applyAiButton;
    let session = null, saving = false, returnFocus = null;
    const doc = environment.document;
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (label, className, action) => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
    const report = message => { status.textContent = message; };
    function remember() {
      if (!session) return;
      session.title = titleInput.value; session.content = contentInput.value;
      if (dirty(session)) drafts.set(session.id, { ...session }); else if (!session.retainedDraft) drafts.delete(session.id);
    }
    function close() {
      if (saving) { report('正在保存，请稍候。'); return; }
      remember();
      if (dialog?.open) dialog.close();
    }
    function busy(value) {
      saving = value;
      [saveButton, closeButton, cancelButton, titleInput, contentInput, reloadButton, applyAiButton].forEach(node => { node.disabled = value; });
      saveButton.textContent = value ? '正在保存…' : '保存修改';
      dialog.setAttribute('aria-busy', String(value));
    }
    function renderHistory(note) {
      const revisions = Array.isArray(note.revisionHistory) ? note.revisionHistory.slice(-MAX_REVISIONS).reverse() : [];
      historySelect.replaceChildren();
      revisions.forEach((item, index) => { const option = element('option', '', `${new Date(item.savedAt || item.updatedAt || 0).toLocaleString()} · ${item.title || '未命名'}`); option.value = String(index); historySelect.append(option); });
      historySelect.onchange = () => { const item = revisions[Number(historySelect.value)] || revisions[0]; historyPreview.textContent = item ? `# ${item.title || ''}\n\n${item.content || ''}` : '首次保存修改后，将在这里保留修改前的版本。'; };
      historySelect.hidden = !revisions.length; historySelect.onchange();
      historyDetails.querySelector('summary').textContent = `历史版本 · ${revisions.length} / ${MAX_REVISIONS}`;
    }
    function showSession(note, message) {
      titleInput.value = session.title; contentInput.value = session.content;
      const state = hooks.getState();
      const project = (state.projects || []).find(item => item.id === note.projectId);
      const names = (note.sourceAttachmentIds || []).map(id => (state.imports || []).find(item => item.id === id)?.name || '来源已不可用');
      sources.textContent = `${note.workspace || '未指定空间'}${project ? ` › ${project.name}` : ''} · ${note.kind || '笔记'}\n${names.length ? `原始来源：${names.join('、')}` : '没有关联的原始资料。'}${note.userEdited ? '\n包含人工修订' : ''}`;
      aiDetails.hidden = !note.aiDraft || typeof note.aiDraft.content !== 'string';
      aiPreview.textContent = aiDetails.hidden ? '' : `# ${note.aiDraft.title || note.title || ''}\n\n${note.aiDraft.content}`;
      renderHistory(note); report(message || '关闭或按 Esc 保留当前窗口内的未保存草稿；刷新或退出应用后草稿不会保留。');
      reloadButton.hidden = !drafts.has(note.id) && version(note) === session.base;
    }
    async function submit(event) {
      event?.preventDefault(); if (saving || !session) return;
      remember(); let change;
      try { change = prepare(hooks.getState(), session); }
      catch (error) { report(error.message); reloadButton.hidden = false; return false; }
      if (!change.changed) { drafts.delete(session.id); session = null; dialog.close(); return true; }
      const noteId = session.id;
      Object.assign(change.note, change.after); if (!Object.hasOwn(change.after, 'aiDraft')) delete change.note.aiDraft; busy(true);
      try {
        const result = await hooks.save();
        if (result === false) throw new Error('保存未成功，请重试。');
      } catch (error) {
        // Never roll back another writer's changes while a save is in flight.
        const current = (hooks.getState().notes || []).find(item => item.id === noteId);
        if (current && !current.archived && !current.deletedAt && version(current) === version(change.after)) {
          for (const key of ['title', 'content', 'folderPath', 'userEdited', 'userEditedAt', 'updatedAt', 'revisionHistory', 'aiDraft']) {
            if (Object.hasOwn(change.before, key)) current[key] = clone(change.before[key]); else delete current[key];
          }
        }
        busy(false); report(`保存失败：${error.message || '请稍后重试'}。草稿仍保留在编辑器中。`); return false;
      }
      busy(false); drafts.delete(noteId); session = null; dialog.close();
      hooks.renderAll?.(); hooks.onSaved?.(noteId); hooks.toast?.('笔记修改已保存，上一版本已保留。'); return true;
    }
    function mount() {
      if (dialog) return;
      dialog = element('dialog', 'note-editor'); dialog.id = 'noteEditorDialog'; dialog.setAttribute('aria-labelledby', 'noteEditorHeading');
      form = element('form', 'note-editor-form'); form.addEventListener('submit', submit);
      const header = element('header', 'note-editor-header'); const heading = element('div'); const h2 = element('h2', '', '编辑笔记'); h2.id = 'noteEditorHeading'; heading.append(h2, element('p', '', '保留原始资料，补充你的理解与修订。'));
      closeButton = button('×', 'note-editor-close', close); closeButton.setAttribute('aria-label', '关闭笔记编辑器'); header.append(heading, closeButton);
      const body = element('div', 'note-editor-body');
      const titleLabel = element('label', 'note-editor-field'); titleInput = element('input'); titleInput.id = 'noteEditorTitle'; titleInput.type = 'text'; titleInput.maxLength = 240; titleInput.required = true; titleLabel.append(element('span', '', '标题'), titleInput);
      const contentLabel = element('label', 'note-editor-field note-editor-content'); contentInput = element('textarea'); contentInput.id = 'noteEditorContent'; contentInput.maxLength = 1000000; contentInput.spellcheck = false; contentLabel.append(element('span', '', '正文 · 支持 Markdown'), contentInput);
      sources = element('p', 'note-editor-sources'); sources.id = 'noteEditorSources'; sources.setAttribute('aria-label', '所属项目与原始来源');
      aiDetails = element('details', 'note-editor-ai-draft'); aiDetails.append(element('summary', '', 'AI 有新草稿待合并'));
      aiPreview = element('pre'); aiPreview.tabIndex = 0; aiPreview.id = 'noteEditorAiDraft';
      applyAiButton = button('放入编辑器', 'note-editor-button', () => {
        if (saving) return;
        try {
          const note = editableNote(hooks.getState(), session.id);
          if (version(note) !== session.base) throw new Error('笔记已有其他修改，请先载入最新版本再合并 AI 草稿。');
          if (!note.aiDraft || typeof note.aiDraft.content !== 'string') throw new Error('这份 AI 草稿已不可用。');
          session.appliedAiDraft = JSON.stringify(note.aiDraft); session.retainedDraft = false;
          titleInput.value = note.aiDraft.title || titleInput.value; contentInput.value = note.aiDraft.content; remember();
          report('AI 草稿已放入编辑器，可继续手动合并。点击保存修改后才会写入笔记并清除这份 AI 草稿。'); contentInput.focus();
        } catch (error) { report(error.message); }
      });
      aiDetails.append(element('p', '', '原人工笔记保持不变。先查看建议，放入编辑器后可继续修改；保存前不会应用。'), aiPreview, applyAiButton);
      historyDetails = element('details', 'note-editor-history'); historyDetails.append(element('summary', '', '历史版本')); historySelect = element('select'); historySelect.setAttribute('aria-label', '选择只读历史版本'); historyPreview = element('pre'); historyPreview.tabIndex = 0;
      historyDetails.append(element('p', '', `每次保存保留修改前的快照，最多保留最近 ${MAX_REVISIONS} 个；更早版本将被替换。此处历史内容只读。`), historySelect, historyPreview);
      body.append(titleLabel, contentLabel, aiDetails, sources, historyDetails);
      status = element('p', 'note-editor-status'); status.id = 'noteEditorStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const footer = element('footer', 'note-editor-footer');
      reloadButton = button('载入最新版本', 'note-editor-button', () => {
        if (saving) return;
        try {
          const note = editableNote(hooks.getState(), session.id);
          remember(); session = begin(hooks.getState(), session.id);
          showSession(note, '已载入最新版本。上次草稿仍保留；关闭后再次编辑可恢复。可复制两份内容进行手动合并。');
          // Keep the old draft until this latest version is explicitly saved or changed.
          session.retainedDraft = true;
        } catch (error) { report(error.message); }
      }); reloadButton.hidden = true;
      cancelButton = button('取消', 'note-editor-button', close); saveButton = element('button', 'note-editor-button note-editor-primary', '保存修改'); saveButton.type = 'submit'; footer.append(reloadButton, cancelButton, saveButton);
      form.append(header, body, status, footer); dialog.append(form); doc.body.append(dialog);
      [titleInput, contentInput].forEach(input => input.addEventListener('input', () => { session.retainedDraft = false; remember(); report('尚未保存 · 取消会保留当前窗口内的草稿。'); }));
      dialog.addEventListener('cancel', event => { if (saving) { event.preventDefault(); report('正在保存，请稍候。'); } else remember(); });
      dialog.addEventListener('close', () => { if (session) remember(); returnFocus?.focus?.({ preventScroll: true }); });
      form.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void submit(); } });
    }
    function open(id) {
      if (saving) return false;
      try {
        const note = editableNote(hooks.getState(), id); mount();
        if (dialog.open) remember(); else returnFocus = doc.activeElement;
        session = drafts.has(id) ? { ...drafts.get(id) } : begin(hooks.getState(), id);
        showSession(note, drafts.has(id) ? (version(note) === session.base ? '已恢复当前窗口内的未保存草稿。' : '已恢复草稿，但笔记已有其他修改。请复制草稿，载入最新版本后手动合并。') : '');
        if (!dialog.open) dialog.showModal(); titleInput.focus(); return true;
      } catch (error) { hooks.toast?.(error.message); return false; }
    }
    return { open, close, save: submit, getDraft: id => drafts.has(id) ? { ...drafts.get(id) } : null };
  }
  // The document editor uses the same optimistic revision check as the legacy
  // dialog. Drafts stay outside workspace state until the user saves them.
  function createInlineController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.save !== 'function') throw new Error('笔记编辑器需要 getState 和 save 接口。');
    const doc = environment.document, drafts = new Map();
    let session = null, container = null, surface = null, ui = null, mode = 'read', epoch = 0;
    let saving = false, savePromise = null, leaveResolve = null, leavePromise = null, previewTimer = null;
    let renderMarkdown = null;
    const node = (tag, className, value) => { const el = doc.createElement(tag); if (className) el.className = className; if (value !== undefined) el.textContent = value; return el; };
    const button = (label, action, className = '') => { const el = node('button', `note-document-button ${className}`, label); el.type = 'button'; el.addEventListener('click', action); return el; };
    const report = message => { if (ui) ui.status.textContent = message; };
    const remember = () => {
      if (!session || !ui) return;
      session.title = ui.title.value; session.content = ui.source.value; session.folderPath = ui.folder.value;
      if (dirty(session)) drafts.set(session.id, { ...session }); else if (!session.retainedDraft) drafts.delete(session.id);
    };
    const isDirty = () => { remember(); return !!session && dirty(session); };
    function resolveLeave(value) {
      const resolve = leaveResolve; leaveResolve = null; leavePromise = null;
      if (ui) ui.leave.hidden = true;
      resolve?.(value);
    }
    function setBusy(value) {
      saving = value;
      if (!ui) return;
      for (const el of [ui.title, ui.folder, ui.source, ui.edit, ui.preview, ui.save, ui.cancel, ui.reload, ui.applyAi, ui.discard, ui.stay, ui.leaveSave]) el.disabled = value;
      ui.save.textContent = value ? '保存中…' : '保存';
      surface.setAttribute('aria-busy', String(value));
    }
    function renderOutline() {
      ui.outlineItems.replaceChildren();
      const headings = Array.from(ui.previewBody.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      headings.forEach((heading, index) => {
        heading.id = `note-document-heading-${epoch}-${index}`;
        const entry = button(heading.textContent || '未命名标题', () => heading.scrollIntoView?.({ block: 'start', behavior: 'auto' }), 'note-document-outline-link');
        entry.style.setProperty('--heading-level', String(Math.max(0, Number(heading.tagName.slice(1)) - 1)));
        ui.outlineItems.append(entry);
      });
      ui.outline.hidden = !headings.length;
      ui.outlineSummary.textContent = `文档目录 · ${headings.length}`;
    }
    function renderPreview() {
      if (!session || !ui) return;
      const visibleBody = markdownBody(session.content);
      if (typeof renderMarkdown === 'function') ui.previewBody.innerHTML = renderMarkdown(visibleBody);
      else { const pre = node('pre', '', visibleBody || '这篇笔记还没有正文。'); ui.previewBody.replaceChildren(pre); }
      renderOutline();
      ui.count.textContent = `${Array.from(session.content).length.toLocaleString()} 字符${session.appliedAiDraft ? ' · 已载入 AI 草稿' : ''}`;
    }
    function setMode(value) {
      mode = value === 'edit' ? 'edit' : value === 'preview' ? 'preview' : 'read';
      surface.dataset.mode = mode;
      ui.edit.setAttribute('aria-pressed', String(mode === 'edit'));
      ui.preview.setAttribute('aria-pressed', String(mode !== 'edit'));
      ui.titleLabel.hidden = mode !== 'edit'; ui.folderLabel.hidden = mode !== 'edit'; ui.sourceLabel.hidden = mode !== 'edit';
      ui.save.hidden = ui.cancel.hidden = mode === 'read';
      ui.edit.textContent = mode === 'edit' ? '编辑中' : '编辑';
      renderPreview();
    }
    function refreshMetadata() {
      if (!session || !ui) return;
      const note = (hooks.getState().notes || []).find(item => item.id === session.id);
      const revisions = (Array.isArray(note?.revisionHistory) ? note.revisionHistory : []).slice(-MAX_REVISIONS).reverse();
      ui.historyItems.replaceChildren();
      revisions.forEach(revision => {
        const entry = node('details', 'note-document-revision');
        const date = revision.savedAt || revision.updatedAt;
        entry.append(node('summary', '', `${date ? new Date(date).toLocaleString() : '较早版本'} · ${revision.title || '未命名'}`), node('pre', '', `# ${revision.title || ''}\n\n${revision.content || ''}`));
        ui.historyItems.append(entry);
      });
      ui.history.hidden = !revisions.length; ui.historySummary.textContent = `历史版本 · ${revisions.length}`;
      ui.ai.hidden = typeof note?.aiDraft?.content !== 'string';
      ui.aiBody.textContent = ui.ai.hidden ? '' : `# ${note.aiDraft.title || note.title || ''}\n\n${note.aiDraft.content}`;
    }
    function discard() {
      if (saving || !session) return false;
      const id = session.id; drafts.delete(id);
      try {
        session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; ui.source.value = session.content;
        setMode('read'); report('未保存的修改已放弃。');
      } catch (_) { session = null; }
      resolveLeave(true); return true;
    }
    function requestLeave() {
      if (!session) return Promise.resolve(true);
      if (saving) return savePromise ? savePromise.then(Boolean) : Promise.resolve(false);
      if (!isDirty()) return Promise.resolve(true);
      try { editableNote(hooks.getState(), session.id); }
      catch (error) { hooks.toast?.(error.message); return Promise.resolve(true); }
      if (leavePromise) return leavePromise;
      leavePromise = new Promise(resolve => { leaveResolve = resolve; });
      ui.leave.hidden = false;
      ui.leaveTitle.textContent = `「${session.title || '未命名笔记'}」有未保存的修改`;
      ui.stay.focus?.({ preventScroll: true }); ui.leave.scrollIntoView?.({ block: 'nearest' });
      return leavePromise;
    }
    async function saveDocument() {
      if (saving) return savePromise;
      if (!session) return false;
      remember(); let change;
      try { change = prepare(hooks.getState(), session); }
      catch (error) { report(error.message); ui.reload.hidden = false; return false; }
      if (!change.changed) { drafts.delete(session.id); session = begin(hooks.getState(), session.id); ui.title.value = session.title; ui.folder.value = session.folderPath; ui.source.value = session.content; renderPreview(); report('所有修改已保存。'); resolveLeave(true); return true; }
      const editing = session, id = editing.id, generation = epoch;
      Object.assign(change.note, change.after); if (!Object.hasOwn(change.after, 'aiDraft')) delete change.note.aiDraft;
      setBusy(true);
      savePromise = (async () => {
        try {
          const result = await hooks.save();
          if (result === false) throw new Error('保存未成功，请重试。');
        } catch (error) {
          const current = (hooks.getState().notes || []).find(item => item.id === id);
          if (current && !current.archived && !current.deletedAt && version(current) === version(change.after)) {
            for (const key of ['title', 'content', 'folderPath', 'userEdited', 'userEditedAt', 'updatedAt', 'revisionHistory', 'aiDraft']) {
              if (Object.hasOwn(change.before, key)) current[key] = clone(change.before[key]); else delete current[key];
            }
          }
          if (epoch === generation && session === editing) { setBusy(false); report(`保存失败：${error.message || '请重试'}。修改仍保留在编辑器中。`); resolveLeave(false); }
          return false;
        }
        const latest = (hooks.getState().notes || []).find(item => item.id === id);
        if (!latest || latest.archived || latest.deletedAt || version(latest) !== version(change.after)) {
          drafts.set(id, { ...editing });
          if (epoch === generation && session === editing) { setBusy(false); ui.reload.hidden = false; report('保存期间笔记被其他操作更新或删除，未覆盖最新内容。当前编辑已保留为草稿，请核对后再保存。'); resolveLeave(false); }
          return false;
        }
        drafts.delete(id);
        if (epoch === generation && session === editing) {
          setBusy(false);
          try { session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; ui.source.value = session.content; }
          catch (error) { drafts.set(id, { ...editing }); session = null; report(error.message); resolveLeave(true); return true; }
          const leaving = !!leaveResolve;
          renderPreview(); refreshMetadata(); ui.reload.hidden = true; report('已保存 · 修改前的版本已保留。'); resolveLeave(true);
          hooks.renderAll?.(); hooks.onSaved?.(id, { inline: true, leaving });
        }
        return true;
      })();
      return savePromise;
    }
    function unmount({ force = false } = {}) {
      if (!force && (saving || isDirty())) return false;
      remember(); resolveLeave(false); epoch++;
      if (previewTimer) { (environment.clearTimeout || clearTimeout)(previewTimer); previewTimer = null; }
      surface?.remove?.(); surface = container = ui = session = null; saving = false; savePromise = null;
      return true;
    }
    function mount(target, id, options = {}) {
      let note;
      try { note = editableNote(hooks.getState(), id); } catch (error) { hooks.toast?.(error.message); return false; }
      if (session?.id === id && container === target && surface?.parentElement === target) {
        if (!saving && !isDirty() && version(note) !== session.base) { session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; ui.source.value = session.content; renderPreview(); }
        refreshMetadata(); return true;
      }
      if (session && (saving || isDirty())) { report('请先保存或放弃当前修改，再打开另一篇笔记。'); return false; }
      unmount({ force: true }); container = target;
      session = drafts.has(id) ? { ...drafts.get(id) } : begin(hooks.getState(), id);
      renderMarkdown = options.renderMarkdown || hooks.renderMarkdown;
      surface = node('section', 'note-document'); surface.setAttribute('aria-label', 'Markdown 笔记文档');
      const toolbar = node('div', 'note-document-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '笔记阅读与编辑');
      ui = {};
      ui.edit = button('编辑', () => { setMode('edit'); ui.source.focus(); }); ui.edit.dataset.noteAction = 'edit';
      ui.preview = button('预览', () => { remember(); setMode(isDirty() || mode !== 'read' ? 'preview' : 'read'); }); ui.preview.dataset.noteAction = 'preview';
      ui.count = node('span', 'note-document-count');
      ui.save = button('保存', () => { void saveDocument(); }, 'note-document-primary'); ui.save.dataset.noteAction = 'save'; ui.save.title = '保存（⌘S / Ctrl+S）';
      ui.cancel = button('取消', async () => { if (await requestLeave()) { if (session) { setMode('read'); report('已返回阅读。'); } } }); ui.cancel.dataset.noteAction = 'cancel';
      toolbar.append(ui.edit, ui.preview, ui.count, ui.cancel, ui.save);
      ui.leave = node('div', 'note-document-leave'); ui.leave.hidden = true; ui.leave.setAttribute('role', 'alert');
      ui.leaveTitle = node('strong');
      const leaveActions = node('div', 'note-document-leave-actions');
      ui.leaveSave = button('保存并继续', () => { void saveDocument(); }, 'note-document-primary'); ui.leaveSave.dataset.noteAction = 'save-leave';
      ui.discard = button('放弃修改', discard); ui.discard.dataset.noteAction = 'discard';
      ui.stay = button('继续编辑', () => { resolveLeave(false); ui.source.focus?.(); }); ui.stay.dataset.noteAction = 'stay';
      leaveActions.append(ui.leaveSave, ui.discard, ui.stay); ui.leave.append(ui.leaveTitle, node('p', '', '保存后写入知识库；放弃只撤销这次未保存的编辑。'), leaveActions);
      ui.titleLabel = node('label', 'note-document-title-field'); ui.title = node('input'); ui.title.value = session.title; ui.title.maxLength = 240; ui.title.setAttribute('aria-label', '笔记标题'); ui.titleLabel.append(ui.title);
      ui.folderLabel = node('label', 'note-document-folder-field'); ui.folder = node('input'); ui.folder.value = session.folderPath ?? text(note.folderPath); ui.folder.maxLength = 500; ui.folder.placeholder = '例如：文献/DemoGraph（留空使用默认目录）'; ui.folder.setAttribute('aria-label', '保存目录'); ui.folderLabel.append(node('span', '', '保存目录'), ui.folder);
      ui.outline = node('details', 'note-document-outline'); ui.outlineSummary = node('summary', '', '文档目录'); ui.outlineItems = node('nav'); ui.outlineItems.setAttribute('aria-label', '当前笔记标题目录'); ui.outline.append(ui.outlineSummary, ui.outlineItems);
      const body = node('div', 'note-document-body');
      ui.sourceLabel = node('label', 'note-document-source'); ui.source = node('textarea'); ui.source.value = session.content; ui.source.maxLength = 1000000; ui.source.spellcheck = false; ui.source.setAttribute('aria-label', 'Markdown 正文'); ui.sourceLabel.append(node('span', 'note-document-pane-label', 'Markdown'), ui.source);
      const previewPane = node('div', 'note-document-preview-pane'); previewPane.append(node('span', 'note-document-pane-label', '实时预览')); ui.previewBody = node('article', 'note-document-preview'); previewPane.append(ui.previewBody); body.append(ui.sourceLabel, previewPane);
      ui.ai = node('details', 'note-document-ai'); ui.ai.append(node('summary', '', 'AI 有待合并草稿'), node('p', '', '先放入编辑器检查，明确保存后才会替换正文。'));
      ui.aiBody = node('pre');
      ui.applyAi = button('放入编辑器', () => {
        if (saving || !session) return;
        try {
          const latest = editableNote(hooks.getState(), session.id);
          if (version(latest) !== session.base) throw new Error('笔记已有其他修改，请先载入最新版本再合并 AI 草稿。');
          if (typeof latest.aiDraft?.content !== 'string') throw new Error('这份 AI 草稿已不可用。');
          if (isDirty()) throw new Error('请先保存或取消当前修改，再载入 AI 草稿。');
          session.appliedAiDraft = JSON.stringify(latest.aiDraft); session.retainedDraft = false;
          ui.title.value = latest.aiDraft.title || ui.title.value; ui.source.value = latest.aiDraft.content; remember(); setMode('edit');
          report('已放入 AI 草稿。请检查并修改，点击保存后才写入笔记。'); ui.source.focus();
        } catch (error) { report(error.message); }
      }); ui.applyAi.dataset.noteAction = 'apply-ai'; ui.ai.append(ui.aiBody, ui.applyAi);
      ui.history = node('details', 'note-document-history'); ui.historySummary = node('summary'); ui.historyItems = node('div'); ui.history.append(ui.historySummary, node('p', '', '只读快照，保留最近 20 次修改前的版本。'), ui.historyItems);
      ui.status = node('p', 'note-document-status'); ui.status.setAttribute('role', 'status'); ui.status.setAttribute('aria-live', 'polite');
      ui.reload = button('载入最新版本', () => {
        if (saving || !session) return;
        try {
          remember(); const id = session.id; session = begin(hooks.getState(), id); session.retainedDraft = true;
          ui.title.value = session.title; ui.folder.value = session.folderPath; ui.source.value = session.content; renderPreview(); refreshMetadata();
          report('已载入最新版本。旧草稿仍保留在当前窗口，重新打开编辑可恢复。');
        } catch (error) { report(error.message); }
      }); ui.reload.dataset.noteAction = 'reload'; ui.reload.hidden = version(note) === session.base;
      surface.append(toolbar, ui.leave, ui.titleLabel, ui.folderLabel, ui.outline, body, ui.ai, ui.history, ui.status, ui.reload); target.replaceChildren(surface);
      for (const input of [ui.title, ui.folder, ui.source]) input.addEventListener('input', () => {
        if (!session || saving) return;
        session.retainedDraft = false; remember(); report('尚未保存');
        if (previewTimer) (environment.clearTimeout || clearTimeout)(previewTimer);
        const generation = epoch;
        previewTimer = (environment.setTimeout || setTimeout)(() => { previewTimer = null; if (generation === epoch) renderPreview(); }, 120);
      });
      surface.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation?.(); void saveDocument(); }
        if (event.key === 'Escape' && (mode !== 'read' || leavePromise)) { event.preventDefault(); event.stopPropagation?.(); if (leavePromise) resolveLeave(false); else void requestLeave().then(ok => { if (ok && session) setMode('read'); }); }
      });
      setMode(drafts.has(id) ? 'edit' : options.mode || 'read'); refreshMetadata();
      report(drafts.has(id) ? version(note) === session.base ? '已恢复当前窗口内的未保存草稿。' : '已恢复草稿；笔记已有外部更新，保存前需合并。' : 'Markdown 笔记 · 修改后按 ⌘S / Ctrl+S 保存');
      return true;
    }
    environment.addEventListener?.('beforeunload', event => { if (saving || isDirty() || drafts.size) { event.preventDefault(); event.returnValue = ''; } });
    return { mount, unmount, beforeLeave: requestLeave, save: saveDocument,
      edit(id) { if (!session || session.id !== id || saving) return false; setMode('edit'); ui.source.focus(); return true; },
      isActive: id => !!session && session.id === id && !!surface && surface.parentElement === container,
      getDraft: id => { if (session?.id === id) remember(); return drafts.has(id) ? { ...drafts.get(id) } : null; },
      snapshot: () => ({ id: session?.id || null, mode, dirty: isDirty(), saving, mounted: !!surface }) };
  }
  let controller, inlineController, currentHooks;
  return { MAX_REVISIONS, begin, dirty, prepare, markdownBody, normalizeFolder, createController, createInlineController,
    init(hooks) { currentHooks = hooks; controller ||= createController(hooks); return this; },
    open(id) { if (!controller) throw new Error('请先初始化笔记编辑器。'); return controller.open(id); },
    close() { controller?.close(); },
    mountInline(container, id, options) { if (!currentHooks) throw new Error('请先初始化笔记编辑器。'); inlineController ||= createInlineController(currentHooks); return inlineController.mount(container, id, options); },
    beforeLeave() { return inlineController?.beforeLeave() || Promise.resolve(true); },
    unmountInline(options) { return inlineController?.unmount(options); },
    inlineActive(id) { return inlineController?.isActive(id) || false; },
    editInline(id) { return inlineController?.edit(id) || false; },
    saveInline() { return inlineController?.save() || Promise.resolve(false); }
  };
}));
