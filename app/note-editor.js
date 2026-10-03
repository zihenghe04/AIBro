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
  // Persistence sorts object keys. Their insertion order is not a document
  // change, including inside revisions, provenance and pending AI drafts.
  // Arrays and strings keep their exact order/content in this signature.
  const canonicalJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const versionFields = note => [note.title, note.content, note.updatedAt, note.createdAt, note.projectId, note.workspace, note.sourceAttachmentIds, note.sourceNoteIds, note.revisionHistory, note.userEditedAt, note.aiDraft, note.folderPath, note.wikiSourceLinks, note.provenance];
  const version = note => canonicalJSON(versionFields(note));
  // Review receipts do not change the legacy recovery base, but they are part
  // of the write being acknowledged or rolled back by this save operation.
  const committedVersion = note => canonicalJSON([version(note), note.aiDraftHistory]);
  const active = value => !!value && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt && !['archived', 'deleted'].includes(value.status);
  const unique = (items, id) => {
    const matches = (Array.isArray(items) ? items : []).filter(item => item?.id === id);
    return matches.length === 1 ? matches[0] : null;
  };
  function normalizeBase(base) {
    // A legacy raw snapshot can prove equality of every version field. An old
    // hash cannot: never infer its missing metadata from title/body equality.
    if (typeof base !== 'string' || !base.startsWith('[')) return base;
    try { const parsed = JSON.parse(base); return Array.isArray(parsed) && parsed.length === 14 ? canonicalJSON(parsed) : base; }
    catch (_) { return base; }
  }
  function normalizeAiDraft(marker) {
    try { const parsed = JSON.parse(marker); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? canonicalJSON(parsed) : marker; }
    catch (_) { return marker; }
  }
  const uncertainBaseMessage = '笔记已被其他操作修改，或恢复草稿来自旧版且无法确认完整版本。未覆盖最新内容；草稿仍保留，请先复制并核对，再载入最新版本合并。';
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
    const note = unique(state.notes, id);
    if (!active(note)) throw new Error('这篇笔记已删除、归档或身份不明确，未保存的草稿仍保留在当前窗口。');
    if (note.projectId) {
      const project = unique(state.projects, note.projectId);
      if (!active(project)) throw new Error('所属项目已删除、归档或身份不明确，不能覆盖保存这篇笔记。');
    }
    return note;
  }
  function begin(state, id) {
    const note = editableNote(state, id);
    return { id, base: version(note), originalTitle: text(note.title), originalContent: text(note.content), originalFolderPath: text(note.folderPath), title: text(note.title), content: text(note.content), folderPath: text(note.folderPath) };
  }
  const legacyBases = (state, id) => [JSON.stringify(versionFields(editableNote(state, id)))];
  function dirty(session) { return session.title !== session.originalTitle || session.content !== session.originalContent || Object.hasOwn(session, 'folderPath') && session.folderPath !== session.originalFolderPath || !!session.appliedAiDraft; }
  function prepare(state, session, now = Date.now()) {
    const note = editableNote(state, session.id);
    if (version(note) !== normalizeBase(session.base)) throw new Error(uncertainBaseMessage);
    const title = session.title.trim();
    if (!title) throw new Error('请填写笔记标题。');
    if (title.length > 240) throw new Error('笔记标题最多 240 个字符。');
    if (session.content.length > 1000000) throw new Error('笔记正文过长，请拆分为多篇笔记。');
    const folderEdited = Object.hasOwn(session, 'folderPath') && session.folderPath !== session.originalFolderPath;
    const folderPath = folderEdited ? normalizeFolder(session.folderPath) : text(note.folderPath);
    const applyingAiDraft = !!session.appliedAiDraft && normalizeAiDraft(session.appliedAiDraft) === canonicalJSON(note.aiDraft);
    if (title === text(note.title) && session.content === text(note.content) && folderPath === text(note.folderPath) && !applyingAiDraft) return { changed: false, note };
    const before = clone(note);
    const history = Array.isArray(note.revisionHistory) ? note.revisionHistory.slice(-(MAX_REVISIONS - 1)).map(clone) : [];
    history.push({ title: text(note.title), content: text(note.content), ...(Object.hasOwn(note, 'folderPath') ? { folderPath: note.folderPath } : {}), updatedAt: note.updatedAt || note.createdAt || null, savedAt: now, userEdited: note.userEdited === true, ...(note.provenance ? { provenance: clone(note.provenance) } : {}) });
    const after = { ...note, title, content: session.content, userEdited: true, userEditedAt: now, updatedAt: now, revisionHistory: history };
    if (folderEdited) after.folderPath = folderPath;
    if (applyingAiDraft) {
      // The newly adopted body belongs to the draft's run, while its previous
      // body retains its own origin in revisionHistory. Unknown legacy draft
      // origins remain explicitly unknown rather than inheriting old proof.
      after.provenance = note.aiDraft.provenance ? clone(note.aiDraft.provenance) : null;
      if (after.provenance?.output) after.provenance.output.variant = 'body';
      for(const field of ['sourceNoteIds','sourceAttachmentIds'])if(Array.isArray(note.aiDraft[field])){history.at(-1)[field]=clone(note[field]||[]);after[field]=[...new Set([...(note[field]||[]),...note.aiDraft[field]])];}
      if(note.aiDraft.wikiSourceLinks){history.at(-1).wikiSourceLinks=clone(note.wikiSourceLinks||{});after.wikiSourceLinks={...(note.wikiSourceLinks||{}),...note.aiDraft.wikiSourceLinks};}
      after.aiDraftHistory = [...clone(Array.isArray(note.aiDraftHistory) ? note.aiDraftHistory : []), { action: 'adopt', reviewedAt: now, draft: clone(note.aiDraft) }];
      delete after.aiDraft;
    }
    return { changed: true, note, before, after };
  }
  function createController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.save !== 'function') throw new Error('笔记编辑器需要 getState 和 save 接口。');
    const drafts = new Map();
    let dialog, form, titleInput, contentInput, sources, status, historySelect, historyPreview, historyDetails, saveButton, closeButton, cancelButton, reloadButton, aiDetails, aiPreview, applyAiButton;
    let session = null, saving = false, loading = false, returnFocus = null, recoveryHost;
    const doc = environment.document;
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (label, className, action) => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
    const report = message => { status.textContent = message; };
    const recovery = environment.NoteEditorRecovery?.create({ getState: hooks.getState, begin, dirty, normalizeBase, legacyBases, getSession: () => session,
      onRestore: restored => {
        if (!session || saving) return;
        try {
          const note = editableNote(hooks.getState(), session.id);
          if (restored && restored.id !== session.id) return;
          session = restored ? { ...restored } : begin(hooks.getState(), session.id);
          if (dirty(session)) drafts.set(session.id, { ...session }); else drafts.delete(session.id);
          showSession(note, restored ? version(note) === session.base ? '已恢复本机未保存草稿；保存后才会写入笔记。' : uncertainBaseMessage : '已载入最新笔记。');
        } catch (error) { report(error.message); }
      },
      onCleared: id => {
        const kept = drafts.get(id), note = (hooks.getState().notes || []).find(item => item.id === id);
        if (session?.id === id && dirty(session)) return;
        if (kept && note && kept.title.trim() === text(note.title) && kept.content === text(note.content) && text(kept.folderPath) === text(note.folderPath)) drafts.delete(id);
        if (session?.id === id && !dirty(session)) session.retainedDraft = false;
      },
      onLoading: value => { loading = value; if (dialog) busy(saving); }, notice: report }, environment);
    function remember() {
      if (!session || loading) return;
      session.title = titleInput.value; session.content = contentInput.value;
      if (dirty(session)) drafts.set(session.id, { ...session }); else if (!session.retainedDraft) drafts.delete(session.id);
      recovery?.remember(session);
    }
    function close() {
      if (saving) { report('正在保存，请稍候。'); return; }
      remember();
      void recovery?.flushAll();
      if (dialog?.open) dialog.close();
    }
    function busy(value) {
      saving = value;
      [saveButton, titleInput, contentInput, reloadButton, applyAiButton].forEach(node => { node.disabled = value || loading; });
      [closeButton, cancelButton].forEach(node => { node.disabled = value; });
      saveButton.textContent = value ? '正在保存…' : '保存修改';
      dialog.setAttribute('aria-busy', String(value || loading));
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
      renderHistory(note); report(message || (recovery ? '修改会另存为本机草稿；点击保存修改后才写入笔记。' : '关闭或按 Esc 保留当前窗口内的未保存草稿；刷新或退出应用后草稿不会保留。'));
      reloadButton.hidden = !drafts.has(note.id) && version(note) === session.base;
    }
    async function submit(event) {
      event?.preventDefault(); if (saving || loading || !session) return false;
      remember(); let change;
      try { change = prepare(hooks.getState(), session); }
      catch (error) { report(error.message); reloadButton.hidden = false; return false; }
      if (!change.changed) {
        const unchangedVersion = committedVersion(change.note);
        if (recovery) {
          busy(true); const cleared = await recovery.saved(session.id); busy(false);
          if (!cleared) { report('笔记已保存，但本机草稿清理尚未确认，请重试。'); return false; }
        }
        try {
          if (committedVersion(editableNote(hooks.getState(), session.id)) !== unchangedVersion) throw new Error('保存期间笔记被其他操作修改，请核对最新内容。');
        } catch (error) { recovery?.remember(session); report(error.message); reloadButton.hidden = false; return false; }
        drafts.delete(session.id); session = null; dialog.close(); return true;
      }
      const noteId = session.id;
      Object.assign(change.note, change.after); if (!Object.hasOwn(change.after, 'aiDraft')) delete change.note.aiDraft; busy(true);
      try {
        const result = await hooks.save();
        if (result === false) throw new Error('保存未成功，请重试。');
      } catch (error) {
        // Never roll back another writer's changes while a save is in flight.
        const current = unique(hooks.getState().notes, noteId);
        if (current && committedVersion(current) === committedVersion(change.after)) {
          for (const key of ['title', 'content', 'folderPath', 'wikiSourceLinks', 'sourceNoteIds', 'sourceAttachmentIds', 'userEdited', 'userEditedAt', 'updatedAt', 'revisionHistory', 'aiDraft', 'aiDraftHistory', 'provenance']) {
            if (Object.hasOwn(change.before, key)) current[key] = clone(change.before[key]); else delete current[key];
          }
        }
        busy(false); report(`保存失败：${error.message || '请稍后重试'}。草稿仍保留在编辑器中。`); return false;
      }
      let latest;
      try { latest = editableNote(hooks.getState(), noteId); } catch (_) { /* Retain the draft when its scope changed during persistence. */ }
      if (!latest || committedVersion(latest) !== committedVersion(change.after)) {
        busy(false); reloadButton.hidden = false; report('保存期间笔记被其他操作更新或删除，当前草稿仍保留，请核对后再保存。'); return false;
      }
      const cleared = recovery ? await recovery.saved(noteId) : true;
      busy(false);
      try {
        latest = editableNote(hooks.getState(), noteId);
        if (committedVersion(latest) !== committedVersion(change.after)) throw new Error('保存期间笔记被其他操作修改，当前草稿仍保留，请核对后再保存。');
      } catch (error) { recovery?.remember(session); report(error.message); reloadButton.hidden = false; return false; }
      if (!cleared) {
        session = begin(hooks.getState(), noteId); session.retainedDraft = true;
        showSession(latest, '笔记已保存，但本机草稿清理尚未确认，请重试。'); hooks.renderAll?.(); return false;
      }
      drafts.delete(noteId); session = null; dialog.close();
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
        if (saving || loading || !session) return;
        try {
          const note = editableNote(hooks.getState(), session.id);
          if (version(note) !== session.base) throw new Error('笔记已有其他修改，请先载入最新版本再合并 AI 草稿。');
          if (!note.aiDraft || typeof note.aiDraft.content !== 'string') throw new Error('这份 AI 草稿已不可用。');
          session.appliedAiDraft = canonicalJSON(note.aiDraft); session.retainedDraft = false;
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
        if (saving || loading || !session) return;
        try {
          const note = editableNote(hooks.getState(), session.id);
          remember(); session = begin(hooks.getState(), session.id);
          showSession(note, '已载入最新版本。上次草稿仍保留；关闭后再次编辑可恢复。可复制两份内容进行手动合并。');
          // Keep the old draft until this latest version is explicitly saved or changed.
          session.retainedDraft = true;
        } catch (error) { report(error.message); }
      }); reloadButton.hidden = true;
      cancelButton = button('取消', 'note-editor-button', close); saveButton = element('button', 'note-editor-button note-editor-primary', '保存修改'); saveButton.type = 'submit'; footer.append(reloadButton, cancelButton, saveButton);
      recoveryHost = element('div', 'note-editor-recovery');
      form.append(header, recoveryHost, body, status, footer); dialog.append(form); doc.body.append(dialog);
      [titleInput, contentInput].forEach(input => input.addEventListener('input', () => { if (!session || saving || loading) return; session.retainedDraft = false; remember(); report(recovery ? '尚未写入笔记 · 正在保留本机草稿。' : '尚未保存 · 取消会保留当前窗口内的草稿。'); }));
      dialog.addEventListener('cancel', event => { if (saving) { event.preventDefault(); report('正在保存，请稍候。'); } else remember(); });
      dialog.addEventListener('close', () => { if (session) remember(); recovery?.unmount(); void recovery?.flushAll(); returnFocus?.focus?.({ preventScroll: true }); });
      form.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void submit(); } });
    }
    function open(id) {
      if (saving) return false;
      try {
        const note = editableNote(hooks.getState(), id); mount();
        if (dialog.open) remember(); else returnFocus = doc.activeElement;
        recovery?.unmount();
        session = drafts.has(id) ? { ...drafts.get(id) } : begin(hooks.getState(), id);
        showSession(note, drafts.has(id) ? (version(note) === session.base ? '已恢复当前窗口内的未保存草稿。' : '已恢复草稿，但笔记已有其他修改。请复制草稿，载入最新版本后手动合并。') : '');
        if (!dialog.open) dialog.showModal();
        if (recovery) void Promise.resolve(recovery.mount(recoveryHost, id)).catch(error => report(error.message));
        titleInput.focus(); return true;
      } catch (error) { hooks.toast?.(error.message); return false; }
    }
    return { open, close, save: submit, flushDrafts: () => { remember(); return recovery?.flushAll() ?? Promise.resolve(true); }, getDraft: id => drafts.has(id) ? { ...drafts.get(id) } : null };
  }
  // The document editor uses the same optimistic revision check as the legacy
  // dialog. Drafts stay outside workspace state until the user saves them.
  function createInlineController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.save !== 'function') throw new Error('笔记编辑器需要 getState 和 save 接口。');
    const doc = environment.document, drafts = new Map();
    let session = null, container = null, surface = null, ui = null, mode = 'read', epoch = 0;
    let saving = false, loading = false, savePromise = null, leaveResolve = null, leavePromise = null, previewTimer = null;
    let renderMarkdown = null, canvas = null, cancelSaveFocus = null;
    const node = (tag, className, value) => { const el = doc.createElement(tag); if (className) el.className = className; if (value !== undefined) el.textContent = value; return el; };
    const button = (label, action, className = '') => { const el = node('button', `note-document-button ${className}`, label); el.type = 'button'; el.addEventListener('click', action); return el; };
    let modeRequest = 0, positionRequest = 0;
    const modernAvailable = () => !!(environment.DocumentEditors?.ensure || environment.DocumentSourceEditor?.mount);
    const activeEditor = () => mode === 'rich' ? ui?.richEditor : mode === 'edit' ? ui?.sourceEditor : null;
    const composingMetadata = input => ui?.metadataComposing?.has(input) || ui?.metadataSettling?.has(input);
    const readMetadata = () => {
      if (!composingMetadata(ui.title)) session.title = ui.title.value;
      if (!composingMetadata(ui.folder)) session.folderPath = ui.folder.value;
    };
    const composing = () => {
      if (ui?.metadataComposing?.size || ui?.metadataSettling?.size) return true;
      const editor = activeEditor();
      return !!(typeof editor?.isComposing === 'function' ? editor.isComposing() : editor?.isComposing);
    };
    const report = message => { if (ui) { ui.status.textContent = message; updateToolbar(); } };
    const reportEditState = () => report((session && dirty(session) ? '尚未保存' : '与已保存笔记一致') + (ui?.historyTrimmed ? ' · 较早的撤销历史已释放' : ''));
    function updateToolbar() {
      if (!ui?.toolbarIsland || !session) return;
      ui.toolbarIsland.update({ mode, loading: loading || !!ui.editorLoading, saving, dirty: dirty(session) || !!session.retainedDraft, canVisual: ui.visualStatus?.supported !== false,
        imageBusy: ui.imageBusy || 0, outlineOpen: !!ui.outline.open, status: ui.status?.textContent || '' });
    }
    function focusEditor() { (activeEditor() || ui?.source)?.focus?.(); }
    // WebKit drops DOM focus when saving switches contenteditable to read-only.
    // The adapter retains its model selection; never remount it or restore undo
    // history merely to put keyboard editing back where a save began.
    function retainSaveFocus() {
      const owner = ui, generation = epoch, requestedMode = mode, editor = activeEditor();
      const focused = doc.activeElement, host = mode === 'rich' ? ui?.richHost : mode === 'edit' ? ui?.sourceHost : null;
      const textarea = focused === ui?.source ? focused : null;
      if (!textarea && !(editor && host?.contains(focused) && (focused?.isContentEditable || focused?.getAttribute?.('contenteditable') === 'true'))) return () => {};
      const before = editor?.selectionSource?.(), value = editor?.getValue?.() ?? textarea?.value;
      const range = before?.exact ? before : textarea ? { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection } : null;
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      const moved = event => { if (event.target !== focused && event.target !== doc.body && event.target !== doc.documentElement) cancel(); };
      const events = [['pointerdown', cancel], ['keydown', cancel], ['wheel', cancel], ['focusin', moved]];
      for (const [type, listener] of events) doc.addEventListener?.(type, listener, true);
      environment.addEventListener?.('blur', cancel);
      cancelSaveFocus = cancel;
      return () => {
        for (const [type, listener] of events) doc.removeEventListener?.(type, listener, true);
        environment.removeEventListener?.('blur', cancel);
        if (cancelSaveFocus === cancel) cancelSaveFocus = null;
        if (cancelled || owner !== ui || generation !== epoch || requestedMode !== mode || activeEditor() !== editor || !surface?.isConnected || leaveResolve || saving || loading || composing()) return;
        if ((editor?.getValue?.() ?? textarea?.value) !== value) return;
        const active = doc.activeElement;
        // A save-induced blur lands on the document. Other explicit focus wins,
        // including a different editor control, even if it did not emit focusin.
        if (active && active !== focused && active !== doc.body && active !== doc.documentElement) return;
        if (range) {
          const current = editor?.selectionSource?.() || { start: textarea?.selectionStart, end: textarea?.selectionEnd, direction: textarea?.selectionDirection };
          if (current.start !== range.start || current.end !== range.end || current.direction !== range.direction) {
            (editor || textarea).setSelectionRange?.(range.start, range.end, range.direction);
          }
        }
        if (doc.activeElement !== focused) {
          if (editor) editor.focus(); else textarea.focus({ preventScroll: true });
        }
      };
    }
    async function insertImages() {
      if (!session || !ui || saving || loading || !inputReady()) return false;
      const owner = ui, generation = epoch, editor = activeEditor();
      if (!editor?.insertImageFiles || !environment.DocumentImages) return false;
      try {
        const files = await environment.DocumentImages.pickFiles(doc);
        if (ui !== owner || generation !== epoch || activeEditor() !== editor || saving || loading) return false;
        return files.length ? await editor.insertImageFiles(files) : false;
      } catch (error) { if (ui === owner && generation === epoch) report(error.message); return false; }
    }
    function inputReady() {
      if (!composing()) return true;
      report('请先完成当前输入，再切换、保存或离开文档。');
      const input = ui?.metadataComposing?.values().next().value || ui?.metadataSettling?.keys().next().value;
      if (input) input.focus(); else focusEditor();
      return false;
    }
    function writeContent(value, origin = 'sync') {
      if (!session || !ui || !inputReady()) return false;
      const next = text(value);
      if (origin === 'save' && ui.editHistory) { session.content = next; return true; }
      if (origin === 'ai' && ui.editHistory && ui.sourceEditor) {
        // AI proposals are exact raw-text replacements and already open source
        // for review. Keep BOM/frontmatter in CodeMirror's invertible transaction.
        if (!ui.editHistory.activate('edit', session.content) || ui.sourceEditor.setValue(next, { origin, addToHistory: true }) === false) return false;
        ui.editHistory.changed('edit'); session.content = next; void applyMode('edit'); return true;
      }
      if (origin !== 'ai') { ui.editHistory?.clear(); ui.historyTrimmed = false; }
      for (const editor of [ui.sourceEditor, ui.richEditor]) {
        // An inactive engine may predate manual edits in the other mode. AI
        // undo must return to this current draft, never that older view value.
        if (origin === 'ai' && editor && editor.getValue() !== session.content && editor.setValue(session.content, { origin: 'sync' }) === false) return false;
        if (editor && editor.getValue() !== next && editor.setValue(next, { origin, addToHistory: origin === 'ai' }) === false) return false;
      }
      session.content = next;
      if (ui.source) ui.source.value = next;
      return true;
    }
    const recovery = environment.NoteEditorRecovery?.create({ getState: hooks.getState, begin, dirty, normalizeBase, legacyBases, getSession: () => session,
      onRestore: restored => {
        if (!session || !ui || saving || restored && restored.id !== session.id || !inputReady()) return;
        try {
          editableNote(hooks.getState(), session.id);
          session = restored ? { ...restored } : begin(hooks.getState(), session.id);
          if (dirty(session)) drafts.set(session.id, { ...session }); else drafts.delete(session.id);
          ui.title.value = session.title; ui.folder.value = session.folderPath || ''; writeContent(session.content, 'restore');
          applyMode(restored ? 'edit' : 'read'); refreshMetadata(); ui.reload.hidden = version(editableNote(hooks.getState(), session.id)) === session.base;
          setBusy(saving);
          if (restored && !ui.reload.hidden) report(uncertainBaseMessage);
        } catch (error) { report(error.message); }
      },
      onCleared: id => {
        const kept = drafts.get(id), note = (hooks.getState().notes || []).find(item => item.id === id);
        if (session?.id === id && dirty(session)) return;
        if (kept && note && kept.title.trim() === text(note.title) && kept.content === text(note.content) && text(kept.folderPath) === text(note.folderPath)) drafts.delete(id);
        if (session?.id === id && !dirty(session)) session.retainedDraft = false;
      },
      onLoading: value => { loading = value; setBusy(saving); }, notice: report }, environment);
    const remember = () => {
      if (!session || !ui || loading) return;
      readMetadata();
      const editor = activeEditor();
      // The adapter owns editing state; the session is the single raw text
      // buffer. An inactive engine is rebased only when it is shown again.
      if (editor && !composing()) session.content = text(editor.getValue());
      else if (ui.source && !ui.modern) session.content = environment.CanvasEdit ? environment.CanvasEdit.textareaEdit(session.content, ui.source.value) : ui.source.value;
      if (dirty(session)) drafts.set(session.id, { ...session }); else if (!session.retainedDraft) drafts.delete(session.id);
      recovery?.remember(session);
      updateToolbar();
    };
    const isDirty = () => { remember(); return !!session && dirty(session); };
    async function flushEditor() {
      if (!session || !ui) return true;
      if (!inputReady()) return false;
      const editing = session, owner = ui, generation = epoch, editor = activeEditor();
      try {
        if (editor?.flushPending && await editor.flushPending() !== true) {
          if (generation === epoch && ui === owner) report('当前输入尚未完成，修改仍保留在编辑器中。');
          return false;
        }
        if (generation !== epoch || session !== editing || ui !== owner || !inputReady()) return false;
        remember(); return true;
      } catch (error) { if (generation === epoch && ui === owner) report(`未能确认当前编辑内容：${error.message || error}`); return false; }
    }
    // Tabs retain raw drafts through the existing durable recovery store, not
    // by keeping every ProseMirror/CodeMirror view alive in a hidden DOM.
    async function suspend({ release = false, isCurrent } = {}) {
      cancelSaveFocus?.();
      if (!session) return true;
      const owner = ui, generation = epoch;
      if (loading && owner.recoveryReady) await owner.recoveryReady;
      if (saving && savePromise) await savePromise;
      if (owner !== ui || generation !== epoch || saving || loading || !await flushEditor()) return false;
      if (owner !== ui || generation !== epoch || isCurrent && !isCurrent()) return false;
      const before = canonicalJSON(session);
      if (dirty(session) && !recovery) {
        report('本机草稿存储尚未就绪，请先保存当前文档再切换。'); return false;
      }
      try {
        if (recovery && await recovery.flushAll() !== true) {
          if (owner === ui) report('本机草稿尚未保存成功，当前文档仍保留，请重试。');
          return false;
        }
      } catch (error) { if (owner === ui) report(`本机草稿保存失败：${error.message || error}`); return false; }
      if (owner !== ui || generation !== epoch || isCurrent && !isCurrent()) return false;
      remember();
      // Typing can continue during disk I/O. A successful old write does not
      // authorize releasing newer input that has not reached the draft store.
      if (before !== canonicalJSON(session) || composing()) {
        report('保存草稿期间内容发生变化，请完成输入后再次切换。'); return false;
      }
      return release ? unmount({ force: true }) : true;
    }
    const scrollValue = value => Number.isFinite(value) && value >= 0 ? value : 0;
    function documentScroller() { return surface?.closest?.('#previewDialog') || container; }
    function capturePosition() {
      if (!session || !ui) return null;
      const selection = activeEditor()?.selectionSource?.();
      return { mode, scrollTop: scrollValue(documentScroller()?.scrollTop),
        editorScrollTop: scrollValue(ui.sourceHost?.querySelector('.cm-scroller')?.scrollTop),
        outlineOpen: !!ui.outline.open,
        ...(selection?.exact && Number.isSafeInteger(selection.start) && Number.isSafeInteger(selection.end)
          ? { selection: { start: selection.start, end: selection.end, direction: selection.direction === 'backward' ? 'backward' : 'forward' } } : {}) };
    }
    async function restorePosition(bookmark) {
      if (!session || !ui || !bookmark || typeof bookmark !== 'object') return false;
      const owner = ui, generation = epoch, request = ++positionRequest;
      await owner.recoveryReady;
      if (ui !== owner || generation !== epoch || request !== positionRequest || saving || composing()) return false;
      const nextMode = ['read', 'preview', 'rich', 'edit'].includes(bookmark.mode) ? bookmark.mode : mode;
      if (await applyMode(nextMode) === false || ui !== owner || generation !== epoch || request !== positionRequest) return false;
      const range = bookmark.selection;
      if (range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start) {
        const start = Math.min(range.start, session.content.length), end = Math.min(range.end, session.content.length);
        activeEditor()?.setSelectionRange?.(start, end, range.direction === 'backward' ? 'backward' : 'forward');
      }
      ui.outline.open = !!bookmark.outlineOpen; renderOutline(); updateToolbar();
      const restoreScroll = () => {
        if (ui !== owner || generation !== epoch || request !== positionRequest) return;
        const scroller = documentScroller(), sourceScroll = owner.sourceHost?.querySelector('.cm-scroller');
        if (scroller) scroller.scrollTop = scrollValue(bookmark.scrollTop);
        if (sourceScroll) sourceScroll.scrollTop = scrollValue(bookmark.editorScrollTop);
      };
      restoreScroll();
      // CodeMirror may measure its requested selection in the next frame.
      // Do not await a frame: hidden native WebViews can suspend frames.
      environment.requestAnimationFrame?.(() => { restoreScroll(); environment.requestAnimationFrame?.(restoreScroll); });
      return true;
    }
    function sourceSelection(start, end, direction) {
      if (ui?.sourceEditor) ui.sourceEditor.setSelectionRange(start, end, direction);
      else if (ui?.source) ui.source.setSelectionRange?.(environment.CanvasEdit ? environment.CanvasEdit.toDisplayOffset(session.content, start) : start, environment.CanvasEdit ? environment.CanvasEdit.toDisplayOffset(session.content, end) : end, direction);
    }
    function showSource(range) {
      const owner = ui, generation = epoch;
      return Promise.resolve(setMode('edit')).then(ok => {
        if (ok === false || generation !== epoch || owner !== ui) return false;
        focusEditor();
        if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) sourceSelection(range.start, range.end, range.direction);
        return true;
      });
    }
    function canvasDocument() {
      if (!session || !ui) return null; remember();
      const note = (hooks.getState().notes || []).find(item => item.id === session.id);
      let available = true; try { editableNote(hooks.getState(), session.id); } catch (_) { available = false; }
      return { id: session.id, title: session.title, content: session.content, baseVersion: session.base, version: note ? version(note) : null, available, saving: saving || loading || composing() || !!ui.editorLoading };
    }
    function rewriteSelection() {
      if (!canvas || !session || saving || loading || !inputReady()) return false;
      try {
        remember(); let range;
        if (mode === 'rich') {
          range = ui.richEditor?.selectionSource?.();
          if (!range || !range.exact) {
            void showSource(range).then(ok => { if (ok) report(range?.reason || '请在源码中确认或重新选择准确范围，再点击 AI 改写。'); });
            return false;
          }
        } else if (mode === 'edit') range = ui.sourceEditor ? ui.sourceEditor.selectionSource() : environment.CanvasEdit.displayRange(session.content, ui.source.selectionStart, ui.source.selectionEnd);
        else { void showSource().then(ok => { if (ok) report('请在源码中选择要改写的文字，再点击 AI 改写。'); }); return false; }
        if (!range || range.value !== undefined && range.value !== session.content) throw new Error('选区内容已变化，请重新选择。');
        return canvas.open(range);
      } catch (error) { report(environment.CanvasEdit.message(error.message)); return false; }
    }
    function resolveLeave(value) {
      const resolve = leaveResolve; leaveResolve = null; leavePromise = null;
      if (ui) ui.leave.hidden = true;
      resolve?.(value);
    }
    function setBusy(value) {
      saving = value;
      if (!ui) return;
      for (const el of [ui.title, ui.folder, ui.source, ui.rich, ui.edit, ui.save, ui.reload, ui.applyAi, ui.discard, ui.leaveSave]) if(el) el.disabled = value || loading;
      for (const el of [ui.preview, ui.cancel, ui.stay]) if(el) el.disabled = value;
      ui.sourceEditor?.setDisabled(value || loading); ui.richEditor?.setDisabled(value || loading);
      ui.canvasTrigger?.update({ disabled: value || loading || !!ui.editorLoading });
      if (ui.save) ui.save.textContent = value ? '保存中…' : '保存';
      surface.setAttribute('aria-busy', String(value || loading || !!ui.editorLoading));
      updateToolbar();
    }
    function renderOutline() {
      if (ui.modern && !ui.outline.open && !['read', 'preview'].includes(mode)) {
        // Closed navigation must not reparse a long document on every edit.
        ui.outlineSummary.textContent = '文档目录'; ui.outline.hidden = false; return;
      }
      if (ui.outlineContent === session.content && ui.outlineMode === mode && ui.outlineRenderedOpen === !!ui.outline.open) return;
      ui.outlineItems.replaceChildren();
      if (ui.modern) {
        const source = session.content, owner = ui;
        const headings = environment.DocumentMarkdown?.headings?.(source) || [];
        headings.forEach((heading, index) => {
          const entry = button(heading.text || '未命名标题', async () => {
            if (ui !== owner || saving || loading || !inputReady()) return;
            const requestedMode = mode;
            if (!(await flushEditor()) || ui !== owner || mode !== requestedMode) return;
            remember();
            if (session.content !== source) { renderOutline(); report('目录已更新，请重新选择标题。'); return; }
            const visible = mode === 'rich' ? ui.richHost : ['read','preview'].includes(mode) ? ui.previewBody : null;
            const nodes = Array.from(visible?.querySelectorAll('h1,h2,h3,h4,h5,h6') || []);
            const target = mode === 'rich' ? nodes[index] : nodes.find(node => node.dataset?.documentSourceStart === String(heading.start))
              || nodes.find(node => heading.id && node.id === heading.id) || nodes[index];
            if (target) {
              target.scrollIntoView?.({ block: 'start', behavior: 'auto' });
              if (mode === 'read' || mode === 'preview') { target.setAttribute('tabindex', '-1'); target.focus?.({ preventScroll: true }); }
            }
            else if (mode === 'edit') { ui.sourceHost?.scrollIntoView?.({ block: 'start', behavior: 'auto' }); await showSource(heading); }
            else report('此标题暂时无法定位，请切换到源码查看。');
          }, 'note-document-outline-link');
          entry.style.setProperty('--heading-level', String(heading.depth - 1)); ui.outlineItems.append(entry);
        });
        if (!headings.length) ui.outlineItems.append(node('p', 'muted', '添加标题后会在这里显示目录。'));
        ui.outline.hidden = !headings.length && !ui.outline.open; ui.outlineSummary.textContent = `文档目录 · ${headings.length}`;
      } else {
        const headings = Array.from(ui.previewBody.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        headings.forEach((heading, index) => {
          heading.id = `note-document-heading-${epoch}-${index}`;
          const entry = button(heading.textContent || '未命名标题', () => heading.scrollIntoView?.({ block: 'start', behavior: 'auto' }), 'note-document-outline-link');
          entry.style.setProperty('--heading-level', String(Math.max(0, Number(heading.tagName.slice(1)) - 1))); ui.outlineItems.append(entry);
        });
        ui.outline.hidden = mode === 'rich' || !headings.length; ui.outlineSummary.textContent = `文档目录 · ${headings.length}`;
      }
      ui.outlineContent = session.content; ui.outlineMode = mode; ui.outlineRenderedOpen = !!ui.outline.open;
    }
    const documentVariant = () => session?.appliedAiDraft ? 'draft' : 'body';
    function renderPreview() {
      if (!session || !ui) return;
      // Editable modes are full-width engine views, not a second full Markdown
      // parse/DOM rebuild on every keystroke. Reading is rendered on demand.
      if (!ui.modern || mode === 'read' || mode === 'preview') {
        if (ui.previewContent !== session.content || ui.previewVariant !== documentVariant()) {
          ui.previewContent = session.content;
          ui.previewVariant = documentVariant();
          ui.readingHandle?.destroy?.(); ui.readingHandle = null;
          if (typeof renderMarkdown === 'function') ui.previewBody.innerHTML = renderMarkdown(session.content, { noteId: session.id, variant: documentVariant() });
          else { const pre = node('pre', '', markdownBody(session.content) || '这篇笔记还没有正文。'); ui.previewBody.replaceChildren(pre); }
          ui.readingHandle = environment.DocumentReading?.mount?.(ui.previewBody);
        }
      }
      renderOutline(); ui.count.textContent = `${session.content.length.toLocaleString()} 字符${session.appliedAiDraft ? ' · 已载入草稿' : ''}`;
      updateToolbar();
    }
    function schedulePreview() {
      if (previewTimer) (environment.clearTimeout || clearTimeout)(previewTimer);
      const generation = epoch;
      previewTimer = (environment.setTimeout || setTimeout)(() => { previewTimer = null; if (generation === epoch) renderPreview(); }, 120);
    }
    async function requestHistory(direction) {
      if (!session || !ui?.editHistory || saving || loading || ui.editorLoading || ui.historyBusy || !inputReady()) return false;
      const owner = ui, generation = epoch, requestedMode = mode, requestedTransition = modeRequest; owner.historyBusy = true;
      try {
        if (!await flushEditor() || owner !== ui || generation !== epoch || requestedMode !== mode || requestedTransition !== modeRequest || saving || loading) return false;
        return owner.editHistory.move(direction, restored => {
          session.content = restored.value; session.retainedDraft = false;
          void applyMode(restored.mode); remember(); reportEditState();
          if (requestedMode !== restored.mode) report(`已${direction === 'undo' ? '撤销' : '重做'}${restored.mode === 'edit' ? '源码' : '可视编辑'}中的修改 · ${ui.status.textContent}`);
          schedulePreview(); focusEditor();
        });
      } catch (error) { if (owner === ui && generation === epoch) report(`撤销或重做未完成：${error.message || error}。当前正文仍保留。`); return false; }
      finally { owner.historyBusy = false; }
    }
    function ensureEditor(kind, options = {}) {
      const owner = ui, generation = epoch, key = kind === 'rich' ? 'richEditor' : 'sourceEditor';
      owner.editorPromises ||= {};
      if (owner.editorPromises[key]) return owner.editorPromises[key].then(ready => {
        if (!ready || owner !== ui || generation !== epoch) return false;
        if (options.activate !== false && mode === kind && owner.editHistory?.attach(kind, owner[key])) return owner.editHistory.activate(kind, session.content);
        return true;
      });
      if (owner[key]) {
        const editor = owner[key];
        if (options.activate !== false && owner.editHistory?.attach(kind, editor)) {
          if (!owner.editHistory.activate(kind, session.content)) return Promise.resolve(false);
        } else if (options.activate !== false && editor.getValue() !== session.content && editor.setValue(session.content, { origin: 'sync' }) === false) return Promise.resolve(false);
        return Promise.resolve(editor.ready).then(() => generation === epoch && ui === owner);
      }
      owner.editorLoading = true; setBusy(saving);
      const alive = () => generation === epoch && ui === owner && !!session;
      const promise = (async () => {
        // Install the single-flight promise before a synchronous mount failure
        // reaches finally; otherwise a failed promise would remain cached.
        await Promise.resolve();
        try {
          const name = kind === 'rich' ? 'DocumentVisualEditor' : 'DocumentSourceEditor';
          if (!environment[name]?.mount) await environment.DocumentEditors?.ensure?.();
          if (!alive()) return false;
          const api = environment[name];
          if (!api?.mount) throw new Error('文档编辑器未能加载，请重试。');
          owner.editorNotice.hidden = true;
          owner.editHistory ||= environment.DocumentEditHistory?.create({ onTrim: () => { if (alive()) owner.historyTrimmed = true; } });
          const handle = api.mount(kind === 'rich' ? owner.richHost : owner.sourceHost, {
            value: session.content, disabled: saving || loading,
            onHistory: direction => { if (alive()) void requestHistory(direction); },
            onHistoryChange: () => { if (alive()) owner.editHistory?.changed(kind); },
            onOpenDocumentLink: (href, navigation = {}) => {
              if (!alive() || saving || loading || !inputReady() || navigation.isCurrent && !navigation.isCurrent()) return false;
              if (typeof href !== 'string' || !href.startsWith('#aibro-source-') || typeof hooks.onOpenLink !== 'function') throw Error('此链接没有可用的文档来源。');
              const noteId = session.id, variant = documentVariant();
              const current = () => alive() && session.id === noteId && (!navigation.isCurrent || navigation.isCurrent());
              return hooks.onOpenLink(noteId, href, { ...navigation, variant, isCurrent: current });
            },
            ...(environment.DocumentImages ? {
              onUploadImage: async file => {
                if (!alive() || mode !== kind || saving || loading) throw Error('当前文档已切换，图片没有插入。');
                editableNote(hooks.getState(), session.id);
                const id = session.id;
                const result = await environment.DocumentImages.uploadNote(id, file);
                if (!alive() || session.id !== id || mode !== kind) throw Error('当前文档已切换，图片没有插入。');
                editableNote(hooks.getState(), id);
                return result;
              },
              resolveImageUrl: url => alive() ? environment.DocumentImages.resolveNote(session.id, url) : '',
              onImageBusy: count => { if (alive()) { owner.imageBusy = count; updateToolbar(); } }
            } : {}),
            onChange: value => {
              if (!alive() || mode !== kind || saving || loading) return;
              positionRequest++;
              session.content = text(value); session.retainedDraft = false;
              if (kind === 'edit') owner.visualStatus = null;
              // onChange is the committed raw document, independent of view DOM.
              readMetadata();
              if (dirty(session)) drafts.set(session.id, { ...session }); else drafts.delete(session.id);
              recovery?.remember(session); reportEditState(); schedulePreview();
            },
            onError: error => { if (alive()) report(`编辑器：${error?.message || error}`); },
            onStatus: status => {
              if (!alive()) return;
              if (kind === 'rich' && status && typeof status === 'object') {
                owner.visualStatus = status;
                owner.modeHint.textContent = status.supported === false ? status.reason || '这份文档含暂不支持的格式，可以继续编辑完整源码。' : '可视编辑会使用标准 Markdown 写法；源码中可检查完整内容。';
              }
              updateToolbar();
            },
            onRequestSource: range => { if (alive()) void showSource(range); }
          });
          owner[key] = handle;
          await handle.ready;
          if (!alive()) { handle.destroy(); return false; }
          if (owner.editHistory?.attach(kind, handle) && options.activate !== false && mode === kind && !owner.editHistory.activate(kind, session.content)) return false;
          handle.setDisabled(saving || loading); handle.requestMeasure?.();
          // AI rewrite applies synchronously after review. Prepare the one source
          // handle without changing the visible mode or creating history events.
          if (kind === 'rich' && environment.DocumentEditHistory && !owner.sourceEditor) void ensureEditor('edit', { activate: false });
          return true;
        } catch (error) {
          if (alive()) {
            owner[key]?.destroy(); owner[key] = null;
            owner.failedMode = kind; owner.editorNotice.hidden = false;
            report(`编辑器加载失败：${error.message || error}。原文仍保留，请重试或使用源码。`);
          }
          return false;
        } finally {
          if (alive()) { delete owner.editorPromises[key]; owner.editorLoading = Object.keys(owner.editorPromises).length > 0; setBusy(saving); }
        }
      })();
      owner.editorPromises[key] = promise; return promise;
    }
    function applyMode(value) {
      if (!ui || !session) return false;
      mode = value === 'rich' && (ui.modern || environment.MarkdownEditor) ? 'rich' : value === 'edit' ? 'edit' : value === 'preview' ? 'preview' : 'read';
      surface.dataset.mode = mode;
      ui.edit?.setAttribute('aria-pressed', String(mode === 'edit')); ui.rich?.setAttribute('aria-pressed', String(mode === 'rich'));
      ui.preview?.setAttribute('aria-pressed', String(mode !== 'edit' && mode !== 'rich'));
      ui.titleLabel.hidden = !['edit','rich'].includes(mode); ui.folderLabel.hidden = !['edit','rich'].includes(mode); ui.sourceLabel.hidden = mode !== 'edit';
      ui.properties.hidden = !['edit','rich'].includes(mode); ui.properties.open = false;
      ui.richHost.hidden = mode !== 'rich'; ui.previewPane.hidden = ui.modern ? mode === 'rich' || mode === 'edit' : mode === 'rich';
      ui.modeHint.hidden = mode !== 'rich';
      if (ui.save) ui.save.hidden = ui.cancel.hidden = mode === 'read';
      if (ui.edit) ui.edit.textContent = mode === 'edit' ? '源码编辑中' : '源码';
      if (ui.modern && ['edit','rich'].includes(mode)) {
        renderPreview(); return ensureEditor(mode);
      }
      if (mode === 'rich') {
        if (!ui.richEditor) ui.richEditor = environment.MarkdownEditor.mount(ui.richHost, { value: session.content, renderMarkdown, onRequestSource: showSource, onChange: value => { if (!session || saving || loading) return; session.content = value; ui.source.value = value; session.retainedDraft = false; remember(); reportEditState(); } });
        else if (ui.richEditor.getValue() !== session.content) ui.richEditor.setValue(session.content);
      }
      renderPreview(); return true;
    }
    function setMode(value) {
      if (!session || !ui || saving || !inputReady()) return false;
      positionRequest++;
      const owner = ui, generation = epoch, request = ++modeRequest;
      const change = okay => {
        if (okay === false || owner !== ui || generation !== epoch || request !== modeRequest) return false;
        remember(); const result = applyMode(value);
        return Promise.resolve(result).then(ready => { if (ready && owner === ui && request === modeRequest) { activeEditor()?.requestMeasure?.(); focusEditor(); } return ready; });
      };
      if (ui.modern && activeEditor()?.flushPending) return flushEditor().then(change);
      // Preserve the synchronous legacy document contract in older bundles.
      if (!ui.modern) { remember(); return applyMode(value); }
      return change(true);
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
      if (saving || loading || !session || !inputReady()) return false;
      canvas?.close();
      const id = session.id, generation = epoch;
      const finish = () => {
        if (generation !== epoch || session?.id !== id) return true;
        drafts.delete(id);
        try {
          session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; writeContent(session.content, 'restore');
          setMode('read'); report('未保存的修改已放弃。');
        } catch (_) { session = null; }
        resolveLeave(true); return true;
      };
      if (!recovery) return finish();
      setBusy(true);
      savePromise = (async () => {
        const cleared = await recovery.discard(id);
        if (generation === epoch && session?.id === id) {
          setBusy(false);
          if (!cleared) { report('未能确认本机草稿已清除，修改仍保留，请重试。'); resolveLeave(false); }
        }
        return cleared ? finish() : false;
      })();
      return savePromise;
    }
    function requestLeave() {
      cancelSaveFocus?.();
      if (!session) return true;
      if (!inputReady()) return false;
      if (ui?.modern && activeEditor()?.flushPending && !saving) {
        const owner = ui;
        if (owner.leaveFlushPromise) return owner.leaveFlushPromise;
        owner.leaveFlushPromise = flushEditor().then(ok => ok ? requestLeaveReady() : false).finally(() => { owner.leaveFlushPromise = null; });
        return owner.leaveFlushPromise;
      }
      return requestLeaveReady();
    }
    function requestLeaveReady() {
      if (!session) return true;
      canvas?.stop();
      if (saving) return savePromise ? savePromise.then(Boolean) : Promise.resolve(false);
      if (!isDirty()) return true;
      try { editableNote(hooks.getState(), session.id); }
      catch (error) { hooks.toast?.(error.message); }
      // Navigation may have retained this editor outside the visible workspace.
      // A decision to replace/close it must be visible and keyboard reachable.
      environment.ReadingPane?.resume?.();
      if (leavePromise) return leavePromise;
      leavePromise = new Promise(resolve => { leaveResolve = resolve; });
      ui.leave.hidden = false;
      ui.leaveTitle.textContent = `「${session.title || '未命名笔记'}」有未保存的修改`;
      ui.stay.focus?.({ preventScroll: true }); ui.leave.scrollIntoView?.({ block: 'nearest' });
      return leavePromise;
    }
    async function saveDocument({ preserveFocus = true } = {}) {
      if (saving) return savePromise;
      if (!session || loading || !inputReady()) return false;
      if (ui?.modern && activeEditor()?.flushPending) {
        if (!await flushEditor()) return false;
        if (saving) return savePromise;
        if (!session || loading) return false;
      }
      const finishFocus = preserveFocus && !leaveResolve ? retainSaveFocus() : () => {};
      try {
      remember(); let change;
      try { change = prepare(hooks.getState(), session); }
      catch (error) { report(error.message); ui.reload.hidden = false; return false; }
      if (!change.changed) {
        const id = session.id, generation = epoch, unchangedVersion = committedVersion(change.note);
        if (recovery) {
          setBusy(true);
          savePromise = recovery.saved(id);
          const cleared = await savePromise;
          if (generation !== epoch || session?.id !== id) return cleared;
          setBusy(false);
          if (!cleared) { report('笔记已保存，但本机草稿清理尚未确认，请重试。'); resolveLeave(false); return false; }
        }
        try {
          const latest = editableNote(hooks.getState(), id);
          if (committedVersion(latest) !== unchangedVersion) throw new Error('保存期间笔记被其他操作修改，请核对最新内容。');
          session = begin(hooks.getState(), id);
        } catch (error) { recovery?.remember(session); report(error.message); ui.reload.hidden = false; resolveLeave(false); return false; }
        drafts.delete(id); ui.title.value = session.title; ui.folder.value = session.folderPath; writeContent(session.content, 'save'); renderPreview(); report('所有修改已保存。'); resolveLeave(true); return true;
      }
      const editing = session, id = editing.id, generation = epoch;
      Object.assign(change.note, change.after); if (!Object.hasOwn(change.after, 'aiDraft')) delete change.note.aiDraft;
      setBusy(true);
      savePromise = (async () => {
        try {
          const result = await hooks.save();
          if (result === false) throw new Error('保存未成功，请重试。');
        } catch (error) {
          const current = unique(hooks.getState().notes, id);
          if (current && committedVersion(current) === committedVersion(change.after)) {
            for (const key of ['title', 'content', 'folderPath', 'wikiSourceLinks', 'sourceNoteIds', 'sourceAttachmentIds', 'userEdited', 'userEditedAt', 'updatedAt', 'revisionHistory', 'aiDraft', 'aiDraftHistory', 'provenance']) {
              if (Object.hasOwn(change.before, key)) current[key] = clone(change.before[key]); else delete current[key];
            }
          }
          if (epoch === generation && session === editing) { setBusy(false); report(`保存失败：${error.message || '请重试'}。修改仍保留在编辑器中。`); resolveLeave(false); }
          return false;
        }
        let latest;
        try { latest = editableNote(hooks.getState(), id); } catch (_) { /* The current session remains available to copy or discard. */ }
        if (!latest || committedVersion(latest) !== committedVersion(change.after)) {
          drafts.set(id, { ...editing });
          if (epoch === generation && session === editing) { setBusy(false); ui.reload.hidden = false; report('保存期间笔记被其他操作更新或删除，未覆盖最新内容。当前编辑已保留为草稿，请核对后再保存。'); resolveLeave(false); }
          return false;
        }
        // A forced remount can start a newer draft while the old formal save is
        // still awaiting persistence. That older response does not own the
        // current per-note recovery slot and must not clear the newer input.
        if (recovery && (epoch !== generation || session !== editing)) return false;
        const cleared = recovery ? await recovery.saved(id) : true;
        if (epoch === generation && session === editing) {
          setBusy(false);
          try {
            const current = editableNote(hooks.getState(), id);
            if (committedVersion(current) !== committedVersion(change.after)) throw new Error('保存期间笔记被其他操作修改，当前草稿仍保留，请核对后再保存。');
            session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; writeContent(session.content, 'save');
          }
          catch (error) { drafts.set(id, { ...editing }); session = editing; recovery?.remember(session); report(error.message); resolveLeave(false); return false; }
          if (cleared) drafts.delete(id);
          const leaving = !!leaveResolve;
          canvas?.saved();
          if (!cleared) {
            session.retainedDraft = true;
            renderPreview(); refreshMetadata(); report('笔记已保存，但本机草稿清理尚未确认，请重试。'); resolveLeave(false); hooks.renderAll?.(); return false;
          }
          renderPreview(); refreshMetadata(); ui.reload.hidden = true; report('已保存 · 修改前的版本已保留。'); resolveLeave(true);
          hooks.renderAll?.(); hooks.onSaved?.(id, { inline: true, leaving });
        }
        return cleared;
      })();
      return await savePromise;
      } finally { finishFocus(); }
    }
    function unmount({ force = false } = {}) {
      cancelSaveFocus?.();
      if (!inputReady() || !force && (saving || activeEditor()?.isImageBusy?.() || isDirty())) return false;
      remember(); recovery?.unmount(); resolveLeave(false); epoch++;
      for (const timer of ui?.metadataSettling?.values() || []) (environment.clearTimeout || clearTimeout)(timer);
      ui?.metadataSettling?.clear(); ui?.metadataComposing?.clear();
      if (previewTimer) { (environment.clearTimeout || clearTimeout)(previewTimer); previewTimer = null; }
      canvas?.dispose(); canvas = null; ui?.canvasTrigger?.unmount();
      ui?.editHistory?.dispose(); ui?.sourceEditor?.destroy(); ui?.richEditor?.destroy(); ui?.toolbarIsland?.unmount(); ui?.readingHandle?.destroy?.();
      modeRequest++;
      surface?.remove?.(); surface = container = ui = session = null; saving = loading = false; savePromise = null;
      return true;
    }
    function mount(target, id, options = {}) {
      let note;
      try { note = editableNote(hooks.getState(), id); } catch (error) { hooks.toast?.(error.message); return false; }
      if (session?.id === id && container === target && surface?.parentElement === target) {
        if (!saving && !loading && !composing() && !isDirty() && version(note) !== session.base) { session = begin(hooks.getState(), id); ui.title.value = session.title; ui.folder.value = session.folderPath; writeContent(session.content, 'restore'); renderPreview(); }
        refreshMetadata(); return true;
      }
      if (session && (saving || composing() || activeEditor()?.isImageBusy?.() || isDirty())) { report('请先等待图片处理、保存或放弃当前修改，再打开另一篇笔记。'); return false; }
      if (!unmount({ force: true })) return false; container = target;
      session = drafts.has(id) ? { ...drafts.get(id) } : begin(hooks.getState(), id);
      renderMarkdown = options.renderMarkdown || hooks.renderMarkdown;
      surface = node('section', 'note-document'); surface.setAttribute('aria-label', 'Markdown 笔记文档');
      const toolbar = node('div', 'note-document-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '笔记阅读与编辑');
      ui = { modern: modernAvailable(), metadataComposing: new Set(), metadataSettling: new Map() };
      surface.dataset.editorFoundation = ui.modern ? 'modern' : 'legacy';
      const useKitToolbar = environment.HalaskaUI?.componentNames?.includes('DocumentToolbar');
      if (!useKitToolbar) {
        ui.rich = button('编辑', () => setMode('rich')); ui.rich.dataset.noteAction = 'rich'; ui.rich.hidden = !ui.modern && !environment.MarkdownEditor;
        ui.edit = button('源码', () => { const result = setMode('edit'); if (!ui.modern) ui.source.focus(); return result; }); ui.edit.dataset.noteAction = 'edit';
        ui.preview = button('阅读', () => setMode(ui.modern ? 'read' : isDirty() || mode !== 'read' ? 'preview' : 'read')); ui.preview.dataset.noteAction = 'preview';
        ui.save = button('保存', () => { void saveDocument({ preserveFocus: false }); }, 'note-document-primary'); ui.save.dataset.noteAction = 'save'; ui.save.title = '保存（⌘S / Ctrl+S）';
        ui.cancel = button('取消', async () => { if (await requestLeave()) { if (session) { setMode('read'); report('已返回阅读。'); } } }); ui.cancel.dataset.noteAction = 'cancel';
      }
      ui.count = node('span', 'note-document-count');
      ui.leave = node('div', 'note-document-leave'); ui.leave.hidden = true; ui.leave.setAttribute('role', 'alert');
      ui.leaveTitle = node('strong');
      const leaveActions = node('div', 'note-document-leave-actions');
      ui.leaveSave = button('保存并继续', () => { void saveDocument({ preserveFocus: false }); }, 'note-document-primary'); ui.leaveSave.dataset.noteAction = 'save-leave';
      ui.discard = button('放弃修改', discard); ui.discard.dataset.noteAction = 'discard';
      ui.stay = button('继续编辑', () => { resolveLeave(false); focusEditor(); }); ui.stay.dataset.noteAction = 'stay';
      leaveActions.append(ui.leaveSave, ui.discard, ui.stay); ui.leave.append(ui.leaveTitle, node('p', '', '保存后写入知识库；放弃只撤销这次未保存的编辑。'), leaveActions);
      ui.titleLabel = node('label', 'note-document-title-field'); ui.title = node('input'); ui.title.value = session.title; ui.title.maxLength = 240; ui.title.setAttribute('aria-label', '笔记标题'); ui.titleLabel.append(ui.title);
      ui.folderLabel = node('label', 'note-document-folder-field'); ui.folder = node('input'); ui.folder.value = session.folderPath ?? text(note.folderPath); ui.folder.maxLength = 500; ui.folder.placeholder = '例如：文献/DemoGraph（留空使用默认目录）'; ui.folder.setAttribute('aria-label', '保存目录'); ui.folderLabel.append(node('span', '', '保存目录'), ui.folder);
      ui.outline = node('details', 'note-document-outline'); ui.outlineSummary = node('summary', '', '文档目录'); ui.outlineItems = node('nav'); ui.outlineItems.setAttribute('aria-label', '当前笔记标题目录'); ui.outline.append(ui.outlineSummary, ui.outlineItems);
      const body = node('div', 'note-document-body');
      ui.sourceLabel = node(ui.modern ? 'div' : 'label', 'note-document-source');
      if (ui.modern) {
        ui.sourceHost = node('div', 'note-document-source-host'); ui.sourceHost.setAttribute('aria-label', 'Markdown 源码编辑器'); ui.sourceLabel.append(ui.sourceHost);
      } else {
        ui.source = node('textarea'); ui.source.value = session.content; ui.source.maxLength = 1000000; ui.source.spellcheck = false; ui.source.setAttribute('aria-label', 'Markdown 正文'); ui.sourceLabel.append(node('span', 'note-document-pane-label', 'Markdown'), ui.source);
      }
      const previewPane = node('div', 'note-document-preview-pane'); ui.previewPane = previewPane;
      if (!ui.modern) previewPane.append(node('span', 'note-document-pane-label', '实时预览'));
      ui.previewBody = node('article', 'note-document-preview'); previewPane.append(ui.previewBody);
      ui.richHost = node('div', 'note-document-rich'); ui.richHost.hidden = true;
      ui.modeHint = node('p', 'note-document-mode-hint', '可视编辑会使用标准 Markdown 写法；源码中可检查完整内容。'); ui.modeHint.hidden = true;
      ui.editorNotice = node('div', 'note-document-editor-notice'); ui.editorNotice.hidden = true; ui.editorNotice.setAttribute('role', 'alert');
      ui.editorNotice.append(node('span', '', '编辑器尚未加载，文档原文仍保留。'), button('重试加载', () => setMode(ui.failedMode || 'edit')), button('打开源码', () => setMode('edit')));
      body.append(ui.sourceLabel, previewPane, ui.richHost);
      ui.ai = node('details', 'note-document-ai'); ui.ai.append(node('summary', '', note.aiDraft?.origin==='manual-wiki-merge'?'有待审阅的合并草稿':'AI 有待合并草稿'), node('p', '', '先放入编辑器检查，明确保存后才会替换正文。'));
      ui.aiBody = node('pre');
      ui.applyAi = button('放入编辑器', async () => {
        if (saving || loading || !session || !inputReady()) return;
        try {
          const owner = ui, editing = session;
          if (ui.modern && (!await showSource() || ui !== owner || session !== editing)) return;
          const latest = editableNote(hooks.getState(), session.id);
          if (version(latest) !== session.base) throw new Error('笔记已有其他修改，请先载入最新版本再合并 AI 草稿。');
          if (typeof latest.aiDraft?.content !== 'string') throw new Error('这份 AI 草稿已不可用。');
          if (isDirty()) throw new Error('请先保存或取消当前修改，再载入 AI 草稿。');
          session.appliedAiDraft = canonicalJSON(latest.aiDraft); session.retainedDraft = false;
          ui.title.value = latest.aiDraft.title || ui.title.value; writeContent(latest.aiDraft.content, 'ai'); remember();
          void showSource(); report('已放入草稿。请检查并修改，点击保存后才写入笔记。');
        } catch (error) { report(error.message); }
      }); ui.applyAi.dataset.noteAction = 'apply-ai'; ui.ai.append(ui.aiBody, ui.applyAi);
      ui.history = node('details', 'note-document-history'); ui.historySummary = node('summary'); ui.historyItems = node('div'); ui.history.append(ui.historySummary, node('p', '', '只读快照，保留最近 20 次修改前的版本。'), ui.historyItems);
      ui.status = node('p', 'note-document-status'); ui.status.setAttribute('role', 'status'); ui.status.setAttribute('aria-live', 'polite');
      ui.reload = button('载入最新版本', () => {
        if (saving || loading || !session || !inputReady()) return;
        canvas?.stop();
        try {
          remember(); const id = session.id; session = begin(hooks.getState(), id); session.retainedDraft = true;
          ui.title.value = session.title; ui.folder.value = session.folderPath; writeContent(session.content, 'restore'); renderPreview(); refreshMetadata();
          report('已载入最新版本。旧草稿仍保留在当前窗口，重新打开编辑可恢复。');
        } catch (error) { report(error.message); }
      }); ui.reload.dataset.noteAction = 'reload'; ui.reload.hidden = version(note) === session.base;
      ui.properties=node('details','note-document-properties');
      const fields=node('div','note-document-property-fields');fields.append(ui.titleLabel,ui.folderLabel);
      const propertiesSummary=node('summary','','信息');propertiesSummary.title='修改笔记标题与保存目录';
      ui.properties.append(propertiesSummary, fields);
      if (useKitToolbar) { ui.toolbarHost = node('div', 'note-document-toolbar-island'); toolbar.append(ui.toolbarHost, ui.properties, ui.count); }
      else toolbar.append(ui.rich, ui.edit, ui.preview, ui.properties, ui.count, ui.cancel, ui.save);
      ui.recoveryHost = node('div', 'note-document-recovery');
      surface.append(toolbar, ui.recoveryHost, ui.leave, ui.outline, ui.modeHint, ui.editorNotice, body, ui.ai, ui.history, ui.status, ui.reload); target.replaceChildren(surface);
      if (useKitToolbar) ui.toolbarIsland = environment.HalaskaUI.mount(ui.toolbarHost, 'DocumentToolbar', {
        mode, loading, saving, dirty: dirty(session), canVisual: true, outlineOpen: false,
        onMode: setMode, onSave: () => saveDocument({ preserveFocus: false }),
        onInsertImage: environment.DocumentImages ? insertImages : undefined,
        onClose: async () => { const owner = ui; if (await requestLeave() && owner === ui && session) { applyMode('read'); report('已返回阅读。'); } },
        onFind: async () => { const owner = ui; if (await showSource() && owner === ui) { ui.sourceEditor?.find?.(); } },
        onOutline: () => { ui.outline.open = !ui.outline.open; renderOutline(); updateToolbar(); }
      });
      ui.outline.addEventListener('toggle', () => { renderOutline(); updateToolbar(); });
      if (environment.CanvasEdit && environment.HalaskaUI?.componentNames?.includes('CanvasEditSurface')) {
        const triggerHost = node('span', 'note-canvas-trigger'), canvasHost = node('div');
        triggerHost.addEventListener('mousedown', event => event.preventDefault());
        toolbar.insertBefore(triggerHost, ui.count); surface.insertBefore(canvasHost, body);
        const english = /^en(?:-|$)/i.test(doc.documentElement?.lang || '');
        ui.canvasTrigger = environment.HalaskaUI.mount(triggerHost, 'Button', { size: 'sm', variant: 'ghost', children: english ? 'AI rewrite' : 'AI 改写', title: english ? 'Select text to generate and review a rewrite' : '选择一段文字，生成并审阅改写草稿', onClick: rewriteSelection });
        canvas = environment.CanvasEdit.mount(canvasHost, {
          read: canvasDocument, generate: hooks.generateSelection, report,
          writeDraft: (content, range) => {
            if (!session || saving || loading || !inputReady() || canvasDocument()?.content !== range.expected) return false;
            if (!writeContent(content, 'ai')) return false;
            session.retainedDraft = false; remember(); void showSource(range);
            report(environment.CanvasEdit.message('已更新未保存草稿；点击「保存」后才写入笔记。')); return true;
          }
        }, environment);
      }
      const owner = ui, generation = epoch;
      const startMetadataComposition = input => {
        if (ui !== owner || epoch !== generation) return;
        const timer = owner.metadataSettling.get(input);
        if (timer !== undefined) (environment.clearTimeout || clearTimeout)(timer);
        owner.metadataSettling.delete(input); owner.metadataComposing.add(input); positionRequest++;
      };
      for (const input of [ui.title, ui.folder]) {
        input.addEventListener('compositionstart', () => startMetadataComposition(input));
        input.addEventListener('compositionend', () => {
          if (ui !== owner || epoch !== generation) return;
          owner.metadataComposing.delete(input);
          const previous = owner.metadataSettling.get(input);
          if (previous !== undefined) (environment.clearTimeout || clearTimeout)(previous);
          // The browser can publish the final input after compositionend.
          // Keep routing/save guarded through that task and read the final DOM value once.
          const timer = (environment.setTimeout || setTimeout)(() => {
            if (ui !== owner || epoch !== generation || owner.metadataSettling.get(input) !== timer) return;
            owner.metadataSettling.delete(input);
            session.retainedDraft = false; remember(); reportEditState(); schedulePreview();
          }, 0);
          owner.metadataSettling.set(input, timer);
        });
      }
      for (const input of [ui.title, ui.folder, ui.source].filter(Boolean)) input.addEventListener('input', event => {
        if (!session || saving || loading) return;
        if (input !== ui.source && event.isComposing) startMetadataComposition(input);
        if (composingMetadata(input)) return;
        positionRequest++;
        session.retainedDraft = false; remember(); reportEditState(); schedulePreview();
      });
      surface.addEventListener('keydown', event => {
        // CodeMirror's search inputs live outside its content DOM. Its own
        // Escape handler may already have removed the panel before bubbling
        // reaches this host, so inspect the original event path as well.
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        if (event.key === 'Escape' && mode === 'edit' && path.some(target => target?.classList?.contains?.('cm-search') || target?.closest?.('.cm-search'))) {
          event.stopPropagation?.(); return;
        }
        if (event.defaultPrevented) return;
        if (event.isComposing || event.keyCode === 229 || composing()) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation?.(); void saveDocument(); }
        if(event.key==='Escape'&&ui.properties.open){event.preventDefault();event.stopPropagation?.();ui.properties.open=false;ui.properties.querySelector('summary').focus();return;}
        if (event.key === 'Escape' && (mode !== 'read' || leavePromise)) { event.preventDefault(); event.stopPropagation?.(); if (leavePromise) resolveLeave(false); else void Promise.resolve(requestLeave()).then(ok => { if (ok && session) setMode('read'); }); }
      });
      applyMode(drafts.has(id) ? 'edit' : options.mode || 'read'); refreshMetadata();
      report(drafts.has(id) ? version(note) === session.base ? '已恢复当前窗口内的未保存草稿。' : '已恢复草稿；笔记已有外部更新，保存前需合并。' : 'Markdown 笔记 · 修改后按 ⌘S / Ctrl+S 保存');
      if (recovery) ui.recoveryReady = Promise.resolve(recovery.mount(ui.recoveryHost, id)).catch(error => { report(error.message); return false; });
      if (options.bookmark) void restorePosition(options.bookmark);
      return true;
    }
    environment.addEventListener?.('beforeunload', event => { if (saving || composing() || activeEditor()?.isImageBusy?.() || isDirty() || drafts.size) { event.preventDefault(); event.returnValue = ''; } });
    return { mount, unmount, beforeLeave: requestLeave, save: saveDocument, suspend, capturePosition, restorePosition,
      currentContent: () => { if (!session || !ui || composing() || activeEditor()?.isImageBusy?.()) return null; remember(); return { id: session.id, title: session.title, content: session.content, dirty: dirty(session) }; },
      prepareExport: async () => { const owner = ui, editing = session; if (!await flushEditor() || owner !== ui || editing !== session || !session) return null; return { id: session.id, title: session.title, content: session.content, dirty: dirty(session) }; },
      rewriteSelection,
      flushDrafts: async () => { if (!await flushEditor()) return false; remember(); return recovery?.flushAll() ?? true; },
      edit(id) { if (!session || session.id !== id || saving || loading || !inputReady()) return false; void setMode(ui.modern || environment.MarkdownEditor ? 'rich' : 'edit'); return true; },
      isActive: id => !!session && session.id === id && !!surface && surface.parentElement === container,
      getDraft: id => { if (session?.id === id) remember(); return drafts.has(id) ? { ...drafts.get(id) } : null; },
      snapshot: () => ({ id: session?.id || null, mode, dirty: isDirty(), saving, mounted: !!surface }) };
  }
  let controller, inlineController, currentHooks;
  return { MAX_REVISIONS, begin, dirty, prepare, markdownBody, normalizeFolder, normalizeBase, legacyBases, createController, createInlineController,
    init(hooks) { currentHooks = hooks; controller ||= createController(hooks); return this; },
    open(id) { if (!controller) throw new Error('请先初始化笔记编辑器。'); return controller.open(id); },
    close() { controller?.close(); },
    mountInline(container, id, options) { if (!currentHooks) throw new Error('请先初始化笔记编辑器。'); inlineController ||= createInlineController(currentHooks); return inlineController.mount(container, id, options); },
    beforeLeave() { return inlineController?.beforeLeave() ?? true; },
    unmountInline(options) { return inlineController?.unmount(options); },
    inlineActive(id) { return inlineController?.isActive(id) || false; },
    editInline(id) { return inlineController?.edit(id) || false; },
    saveInline() { return inlineController?.save() || Promise.resolve(false); },
    suspendInline(options) { return inlineController?.suspend(options) ?? true; },
    capturePosition() { return inlineController?.capturePosition() ?? null; },
    restorePosition(bookmark) { return inlineController?.restorePosition(bookmark) ?? false; },
    currentContent() { return inlineController?.currentContent() ?? null; },
    prepareExport() { return inlineController?.prepareExport() ?? Promise.resolve(null); },
    getInlineDraft(id) { return inlineController?.getDraft(id) ?? null; },
    async flushDrafts() { const results = await Promise.all([controller?.flushDrafts() ?? true, inlineController?.flushDrafts() ?? true]); return results.every(result => result !== false); }
  };
}));
