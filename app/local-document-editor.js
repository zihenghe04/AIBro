/* Local files use the same offline editing engines as notes. Explicit disk saves
 * remain versioned proposals; durable drafts never masquerade as file saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.LocalDocumentEditor = { create: options => factory(options, root) };
})(typeof globalThis !== 'undefined' ? globalThis : this, (hooks, root) => {
  'use strict';
  const doc = root.document, sessions = new Map();
  let current = null, sequence = 0;
  const el = (tag, cls = '', text) => { const n = doc.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, action, key) => { const n = el('button', 'project-file-button', text); n.type = 'button'; n.onclick = action; if (key) n.dataset.localDocumentAction = key; return n; };
  const live = session => current === session && !session.destroyed;
  const handle = session => session.mode === 'rich' ? session.visual : session.mode === 'edit' ? session.source : null;
  const imageBusy = session => !!(session.imagePicking || session.imageCounts?.visual || session.imageCounts?.source || session.visual?.isImageBusy?.() || session.source?.isImageBusy?.());
  const sync = session => { const active = handle(session); if (active) session.content = active.getValue(); return session.content; };
  const dirty = session => !!session && (sync(session) !== session.baseContent || !!session.retainedDraft);
  const selection = session => {
    const candidate = handle(session)?.selectionSource?.();
    const value = candidate && candidate.exact !== false ? candidate : session.bookmark?.selection;
    if (!value) return undefined;
    const length = session.content.length, start = Math.max(0, Math.min(length, Number(value.start) || 0));
    return { start, end: Math.max(start, Math.min(length, Number(value.end) || start)), direction: value.direction || 'none' };
  };
  function privateNow(session) {
    if (!session.private && hooks.isPrivate?.(session.ref)) {
      session.private = true; session.store?.dispose(); session.store = null;
    }
    return session.private;
  }
  const outerScroller = session => session.surface.closest?.('#previewDialog') || session.surface.parentElement;
  function capture(session = current) {
    if (!session) return null;
    const scroller = (session.mode === 'edit' ? session.sourceHost : session.richHost).querySelector('.cm-scroller');
    return { mode: session.mode, selection: selection(session), outlineOpen: !!session.outline?.open, scrollTop: outerScroller(session)?.scrollTop || 0, editorScrollTop: scroller?.scrollTop || 0, editorScrollLeft: scroller?.scrollLeft || 0 };
  }
  function draft(session) {
    return { id: session.ref.id, projectId: session.ref.projectId, candidateId: session.ref.candidateId, path: session.ref.path,
      baseContent: session.baseContent, content: sync(session), version: session.version, mode: session.mode, selection: selection(session),
      scroll: { top: capture(session)?.editorScrollTop || 0, left: capture(session)?.editorScrollLeft || 0 },
      ...(session.sourceConversationId ? { sourceConversationId: session.sourceConversationId } : {}),
      ...(session.recovery !== undefined ? { recoveryContent: session.recovery } : {}), retainedDraft: !!session.retainedDraft };
  }
  function report(session, text) { session.status.textContent = text + (session.historyTrimmed ? ' · 较早的撤销历史已释放' : ''); updateToolbar(session); }
  function updateToolbar(session) {
    if (!live(session)) return;
    session.toolbar?.update({ mode: session.mode, loading: session.loading || session.engineLoading, saving: !!(session.saving || session.saveGate),
      dirty: dirty(session), canVisual: session.markdown && session.supported !== false, imageBusy: imageBusy(session) ? 1 : 0,
      outlineOpen: !!session.outline?.open, status: session.status.textContent });
    // A save requested during upload waits for the mapped insertion. Disabling
    // the engine here would cancel that very insertion before flush can finish.
    const blocked = session.loading || session.engineLoading || !!session.saving || (!!session.saveGate && !imageBusy(session)) || !!session.io;
    session.source?.setDisabled(blocked || session.readOnly); session.visual?.setDisabled(blocked || session.readOnly);
    session.surface.setAttribute('aria-busy', String(blocked));
    session.reload.disabled = blocked; session.retry.hidden = !session.engineError;
    session.leave.querySelectorAll('button').forEach(control => { control.disabled = blocked; });
  }
  function remember(session) {
    if (session.loading || session.destroyed) return;
    session.suspended = false; session.editRevision = (session.editRevision || 0) + 1;
    session.bookmark = capture(session);
    if (dirty(session)) sessions.set(session.ref.id, { ...draft(session), bookmark: session.bookmark });
    else sessions.delete(session.ref.id);
    if (!privateNow(session) && session.store) session.store.schedule(dirty(session) ? draft(session) : null);
  }
  async function flushInput(session) {
    if (!live(session) || session.loading || session.engineLoading) return false;
    if (session.imagePicking && !(await session.imagePicking)) return false;
    if (!live(session)) return false;
    const active = handle(session);
    if (active && (active.isComposing?.() || await active.flushPending?.() === false)) {
      if (live(session)) report(session, session.imageError || '请先完成当前输入，再保存或切换文档。'); return false;
    }
    if (!live(session) || handle(session) !== active) return false;
    sync(session); return true;
  }
  async function flushSession(session, retry = true) {
    if (!(await flushInput(session))) return false;
    if (session.saving && !(await session.saving)) return false;
    if (!live(session)) return false;
    remember(session);
    if (!dirty(session)) return !session.store?.hasPending() || await session.store.flush({ retry });
    if (privateNow(session) || !session.store) { report(session, session.private ? '私密对话不保存持久草稿。请保存文件、放弃修改，或继续编辑。' : '草稿存储尚未就绪；请保存文件或继续编辑。'); return false; }
    const revision = session.editRevision;
    const saved = await session.store.flush({ retry });
    if (!saved && live(session)) report(session, '草稿未能保存到本机，当前编辑仍保留。请重试，或明确保存文件。');
    return saved && live(session) && session.editRevision === revision && !session.store.hasPending();
  }
  function preview(session) {
    if (session.previewContent !== session.content) {
      session.readingHandle?.destroy?.(); session.readingHandle = null;
      if (session.markdown && hooks.markdown) session.preview.innerHTML = hooks.markdown(session.content, { resolveImageUrl: url => imageUrl(session, url),
        resolveDocumentLink: url => live(session) && !session.readOnly ? hooks.resolveDocumentLink?.(session.ref, url) : null });
      else { const pre = el('pre'), code = el('code', '', session.content); pre.append(code); session.preview.replaceChildren(pre); }
      session.previewContent = session.content;
      session.readingHandle = root.DocumentReading?.mount?.(session.preview, { onOpenDocumentLink: (target, navigation) => openDocumentLink(session, target, navigation) });
      session.preview.querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
        if (live(session)) report(session, '图片暂时无法读取，Markdown 引用仍保留。请检查原图片和项目连接。');
      }, { once: true }));
    }
    renderOutline(session);
  }
  function openDocumentLink(session, target, navigation) {
    if (!live(session) || session.readOnly || session.loading || session.saving || session.saveGate || session.io) return false;
    hooks.valid(session.ref);
    if (!target) throw Error('此链接不在当前项目已连接的目录内，当前文档仍保留。');
    return hooks.openDocumentLink?.(session.ref, target, { ...navigation, isCurrent: () => live(session) && !session.readOnly && (!navigation?.isCurrent || navigation.isCurrent()) });
  }
  function renderOutline(session) {
    if (!live(session) || !session.markdown || !session.outline) return;
    if (session.mode !== 'read' && !session.outline.open) { session.outlineSummary.textContent = '文档目录'; session.outline.hidden = false; return; }
    if (session.outlineContent === session.content && session.outlineMode === session.mode && session.outlineRenderedOpen === !!session.outline.open) return;
    const source = session.content;
    const headings = root.DocumentMarkdown?.headings?.(source) || [];
    session.outlineItems.replaceChildren();
    headings.forEach((heading, index) => {
      const entry = button(heading.text || '未命名标题', async () => {
        const requestedMode = session.mode;
        if (!live(session) || session.saving || session.saveGate || session.io || !(await flushInput(session)) || session.mode !== requestedMode) return false;
        if (session.content !== source) { renderOutline(session); report(session, '目录已更新，请重新选择标题。'); return false; }
        if (session.mode === 'edit') {
          session.sourceHost.scrollIntoView?.({ block: 'start', behavior: 'auto' });
          session.source?.setSelectionRange?.(heading.start, heading.end, 'forward'); session.source?.focus(); return true;
        }
        const visible = session.mode === 'rich' ? session.richHost : session.preview;
        const nodes = Array.from(visible.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        const target = session.mode === 'rich' ? nodes[index] : nodes.find(node => node.dataset?.documentSourceStart === String(heading.start))
          || nodes.find(node => heading.id && node.id === heading.id) || nodes[index];
        if (target) { target.scrollIntoView?.({ block: 'start', behavior: 'auto' });
          if (session.mode === 'read') { target.setAttribute('tabindex', '-1'); target.focus?.({ preventScroll: true }); }
          return true; }
        report(session, '此标题暂时无法定位，请切换到源码查看。'); return false;
      });
      entry.className += ' note-document-outline-link'; entry.style.setProperty('--heading-level', String(heading.depth - 1)); session.outlineItems.append(entry);
    });
    if (!headings.length) session.outlineItems.append(el('p', 'local-document-outline-empty', '添加标题后会在这里显示目录。'));
    session.outline.hidden = !headings.length && !session.outline.open;
    session.outlineSummary.textContent = `文档目录 · ${headings.length}`;
    session.outlineContent = source; session.outlineMode = session.mode; session.outlineRenderedOpen = !!session.outline.open;
  }
  function imageUrl(session, url) {
    if (typeof url !== 'string' || !url || /^[a-z][a-z\d+.-]*:/i.test(url) || /^[/\\]/.test(url) || /[\x00-\x1f\x7f]/.test(url)) return '';
    const fields = { candidateId: session.ref.candidateId, projectId: session.ref.projectId, path: session.ref.path, image: url,
      ...(session.sourceConversationId ? { sourceConversationId: session.sourceConversationId } : {}) };
    return '/__local/document-images/read?' + Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  }
  function allowImageWrite(session) {
    if (!live(session) || !session.markdown || session.readOnly) throw Error('当前文档无法插入图片，请重新打开可编辑的 Markdown 文件。');
    hooks.valid(session.ref);
    if (privateNow(session)) throw Error('私密对话不向磁盘保存新图片。请在普通项目中插入图片。');
  }
  async function uploadImage(session, file) {
    allowImageWrite(session);
    if (!root.DocumentImages?.encodeFile) throw Error('图片保存模块未能载入，请重启应用后重试。');
    const data = await root.DocumentImages.encodeFile(file);
    allowImageWrite(session);
    const result = await hooks.request('/__local/document-images/upload', { candidateId: session.ref.candidateId, projectId: session.ref.projectId,
      path: session.ref.path, name: file.name || '图片', data,
      ...(session.sourceConversationId ? { sourceConversationId: session.sourceConversationId } : {}) });
    allowImageWrite(session);
    if (!result?.url || !imageUrl(session, result.url)) throw Error('图片保存没有返回可用引用，正文未被替换。');
    return result;
  }
  async function pickImages() {
    const session = current;
    if (!session || session.loading || session.engineLoading || session.saving || session.saveGate || session.io || imageBusy(session)) return false;
    try {
      allowImageWrite(session);
      if (session.mode === 'read' && !(await setMode(session.supported === false ? 'edit' : 'rich'))) return false;
      if (!(await flushInput(session))) return false;
      const active = handle(session), range = active?.selectionSource?.();
      if (!active?.insertImageFiles || !root.DocumentImages?.pickFiles) throw Error('图片插入模块未能载入，请重试编辑器。');
      const choosing = (async () => {
        const files = await root.DocumentImages.pickFiles(doc);
        if (!live(session) || handle(session) !== active) return false;
        if (!files?.length) { active.focus?.(); return true; }
        allowImageWrite(session);
        if (range && range.exact !== false) active.setSelectionRange?.(range.start, range.end, range.direction);
        return await active.insertImageFiles(files) !== false;
      })();
      session.imagePicking = choosing; updateToolbar(session);
      try { return await choosing; }
      finally { if (session.imagePicking === choosing) session.imagePicking = null;
        if (live(session)) report(session, session.imageError || (dirty(session) ? '未保存到文件 · 正在保留草稿' : '所有修改已保存')); }
    } catch (error) { if (live(session)) report(session, `图片未插入：${error.message}`); return false; }
  }
  async function requestHistory(direction) {
    const session = current;
    if (!session?.history || session.loading || session.saving || session.saveGate || session.io || session.engineLoading || session.historyBusy) return false;
    const requestedMode = session.mode, requestedEpoch = session.modeEpoch;
    session.historyBusy = true;
    try {
      if (!await flushInput(session) || !live(session) || requestedMode !== session.mode || requestedEpoch !== session.modeEpoch) return false;
      return session.history.move(direction, restored => {
        session.content = restored.value; session.mode = restored.mode;
        session.surface.dataset.mode = restored.mode;
        session.richHost.hidden = restored.mode !== 'rich'; session.sourceHost.hidden = restored.mode !== 'edit'; session.preview.hidden = true;
        remember(session); renderOutline(session); updateToolbar(session); handle(session)?.focus();
        report(session, `${requestedMode !== restored.mode ? `已${direction === 'undo' ? '撤销' : '重做'}${restored.mode === 'edit' ? '源码' : '可视编辑'}中的修改 · ` : ''}${dirty(session) ? '未保存到文件 · 正在保留草稿' : '所有修改已保存'}`);
      });
    } catch (error) { if (live(session)) report(session, `撤销或重做未完成：${error.message || error}。当前正文仍保留。`); return false; }
    finally { session.historyBusy = false; }
  }
  async function setMode(value, options = {}) {
    const session = current;
    if (!session || session.loading || session.saving || session.saveGate || session.io || session.engineLoading) return false;
    if (!['read', 'rich', 'edit'].includes(value)) value = 'edit';
    if (value === 'rich' && (!session.markdown || session.supported === false)) value = 'edit';
    const epoch = ++session.modeEpoch;
    if (!(await flushInput(session)) || !live(session) || epoch !== session.modeEpoch) return false;
    let creating = null;
    try {
      if (value !== 'read') {
        session.engineLoading = true; updateToolbar(session);
        await root.DocumentEditors.ensure();
        if (!live(session) || epoch !== session.modeEpoch) return false;
        session.history ||= root.DocumentEditHistory?.create({ onTrim: () => { if (live(session)) session.historyTrimmed = true; } });
        const kind = value === 'rich' ? 'visual' : 'source';
        let next = session[kind];
        if (!next) {
          const target = value === 'rich' ? session.richHost : session.sourceHost;
          const adapter = value === 'rich' ? root.DocumentVisualEditor : root.DocumentSourceEditor;
          next = session[kind] = adapter.mount(target, { value: session.content,
            onHistory: direction => { if (live(session)) void requestHistory(direction); },
            onHistoryChange: () => { if (live(session)) session.history?.changed(value); }, filename: session.ref.path, ariaLabel: '本机文件源码',
            onOpenDocumentLink: (url, navigation) => {
              let target;
              if (typeof url === 'string' && url.startsWith('#')) {
                try { target = { path: session.ref.path, fragment: decodeURIComponent(url.slice(1)) }; } catch (_) { throw Error('章节链接无效，当前文档仍保留。'); }
              } else target = hooks.resolveDocumentLink?.(session.ref, url);
              return openDocumentLink(session, target, navigation);
            },
            onChange: text => { if (!live(session) || session.mode !== value) return; session.content = text; remember(session); if (!imageBusy(session)) session.imageError = null;
              report(session, session.imageError || (dirty(session) ? '未保存到文件 · 正在保留草稿' : '所有修改已保存')); if (session.outline?.open) renderOutline(session); },
            onError: error => { if (live(session)) { if (imageBusy(session)) session.imageError = error.message; report(session, error.message); } },
            onStatus: status => { if (live(session) && kind === 'visual' && status && typeof status === 'object') { session.supported = status.supported; session.supportReason = status.reason; } },
            ...(session.markdown ? { onUploadImage: file => uploadImage(session, file), resolveImageUrl: url => imageUrl(session, url),
              onImageBusy: count => { if (!live(session)) return; if (!session.imageCounts[kind] && count) session.imageError = null; session.imageCounts[kind] = Number(count) || 0;
                if (imageBusy(session)) report(session, '正在保存图片…正文会在图片保存成功后插入引用。');
                else report(session, session.imageError || (dirty(session) ? '未保存到文件 · 正在保留草稿' : '所有修改已保存')); }
            } : {}),
            onRequestSource: range => { void setMode('edit').then(ok => { if (ok && live(session) && range?.exact !== false) session.source?.setSelectionRange(range.start, range.end, range.direction); }); }
          });
          creating = { kind, handle: next };
          if (await next.ready === false) throw Error('编辑器未能载入，原文和草稿仍保留。');
          creating = null;
        }
        if (session.history?.attach(value, next)) {
          if (!session.history.activate(value, session.content)) throw Error('请先完成当前输入，再切换文档模式。');
        } else if (next.getValue() !== session.content && next.setValue(session.content) === false) throw Error('请先完成当前输入，再切换文档模式。');
        if (!live(session) || epoch !== session.modeEpoch) return false;
        if (kind === 'visual' && session.supported === false) {
          session.engineLoading = false; session.engineError = false;
          report(session, session.supportReason || '这份文档包含特殊语法，已保留原文，请使用源码编辑。');
          return setMode('edit', options);
        }
      }
      if (!live(session) || epoch !== session.modeEpoch) return false;
      session.mode = value; session.surface.dataset.mode = value;
      session.richHost.hidden = value !== 'rich'; session.sourceHost.hidden = value !== 'edit'; session.preview.hidden = value !== 'read';
      if (value === 'read') preview(session);
      else renderOutline(session);
      session.engineError = false;
      if (options.focus !== false) handle(session)?.focus();
      remember(session); return true;
    } catch (error) {
      if (creating && session[creating.kind] === creating.handle) {
        creating.handle.destroy(); session[creating.kind] = null;
        if (creating.kind === 'visual') { session.supported = true; session.supportReason = ''; }
      }
      if (live(session)) { session.engineError = true; session.retryMode = value; report(session, error.message); }
      return false;
    }
    finally { if (live(session) && epoch === session.modeEpoch) { session.engineLoading = false; updateToolbar(session); } }
  }
  async function restorePosition(bookmark, options = {}) {
    const session = current;
    if (!session || !bookmark) return false;
    if (!(await setMode(bookmark.mode || 'read', { focus: options.focus === true })) || !live(session)) return false;
    session.bookmark = bookmark;
    if (session.outline) { session.outline.open = !!bookmark.outlineOpen; renderOutline(session); updateToolbar(session); }
    const range = bookmark.selection || bookmark.sourceSelection;
    if (range) handle(session)?.setSelectionRange?.(range.start, range.end, range.direction);
    const scroller = (session.mode === 'edit' ? session.sourceHost : session.richHost).querySelector('.cm-scroller');
    if (scroller) { scroller.scrollTop = bookmark.editorScrollTop || 0; scroller.scrollLeft = bookmark.editorScrollLeft || 0; }
    if (outerScroller(session)) outerScroller(session).scrollTop = bookmark.scrollTop || 0;
    return true;
  }
  async function revealFragment(fragment) {
    const session = current;
    if (!session || session.loading || session.readOnly || !session.markdown || typeof fragment !== 'string' || /[\x00-\x1f\x7f]/.test(fragment)) return false;
    if (!(await setMode('read', { focus: false })) || !live(session)) return false;
    if (!fragment) { session.preview.scrollIntoView?.({ block: 'start', behavior: 'auto' }); return true; }
    const id = root.DocumentMarkdown?.resolveFragment?.(session.content, fragment, { idPrefix: 'local-document' });
    if (id && session.readingHandle?.reveal?.(id)) return true;
    report(session, '文档已打开，但没有找到链接指定的章节。'); return false;
  }
  async function clearDraft(session) {
    if (!session.store) { sessions.delete(session.ref.id); session.retainedDraft = false; session.recovery = undefined; return true; }
    const ok = await session.store.clear(); session.retainedDraft = !ok;
    if (ok) { session.recovery = undefined; if (session.restore) session.restore.hidden = true; }
    if (ok) sessions.delete(session.ref.id);
    return ok;
  }
  function save() {
    const session = current; if (!session) return Promise.resolve(false);
    if (session.saveGate) return session.saveGate;
    if (handle(session)?.isComposing?.()) { report(session, '请先完成当前输入，再保存或切换文档。'); return Promise.resolve(false); }
    const task = saveInternal(); session.saveGate = task; updateToolbar(session);
    void task.finally(() => { if (session.saveGate === task) session.saveGate = null; if (live(session)) updateToolbar(session); }).catch(() => {});
    return task;
  }
  async function saveInternal() {
    const session = current;
    if (!session || session.loading || session.io) return false;
    if (session.readOnly) { report(session, '原文件暂不可访问。请先重新连接项目目录，再保存。'); return false; }
    if (session.saving) return session.saving;
    if (!(await flushInput(session))) return false;
    if (session.content === session.baseContent) {
      const cleared = await clearDraft(session); if (live(session)) { report(session, cleared ? '所有修改已保存。' : '文件已保存，恢复草稿清理失败。请重试保存。'); session.resolveLeave?.(cleared); } return cleared;
    }
    remember(session);
    const content = session.content;
    const task = (async () => {
      try {
        hooks.valid(session.ref);
        const proposal = await hooks.request('/__local/edits/propose', { projectId: session.ref.projectId, candidateId: session.ref.candidateId, path: session.ref.path, operation: 'update', content, version: session.version, runId: 'manual-editor' });
        hooks.valid(session.ref);
        const result = await hooks.request('/__local/edits/apply', { id: proposal.id });
        session.baseContent = content; session.version = result.afterVersion; session.lastEdit = result;
        const cleared = await clearDraft(session);
        if (!live(session)) return cleared;
        session.conflict.hidden = true; session.undo.hidden = false;
        report(session, cleared ? '已保存到本机 · 原版本已保留，可撤销此次保存。' : '文件已保存，但恢复草稿清理失败。请重试保存。');
        session.resolveLeave?.(cleared); try { hooks.onSaved?.(session.ref); } catch (_) { hooks.toast?.('文件已保存，界面同步暂未完成。'); }
        return cleared;
      } catch (error) {
        if (live(session)) { report(session, `保存失败：${error.message}。编辑草稿仍保留。`); session.conflict.hidden = false; session.conflictText.textContent = '当前文件未被覆盖。可读取磁盘版本，比较后手动合并。'; session.resolveLeave?.(false); }
        return false;
      } finally { if (live(session)) { session.saving = null; updateToolbar(session); } }
    })();
    session.saving = task; updateToolbar(session); return task;
  }
  async function beforeLeave() {
    const session = current; if (!session) return true;
    if (session.saveGate || session.saving) return !!(await (session.saveGate || session.saving));
    if (!(await flushInput(session))) return false;
    if (!dirty(session)) return true;
    root.ReadingPane?.resume?.();
    if (session.leavePromise) return session.leavePromise;
    session.leave.hidden = false;
    session.leavePromise = new Promise(resolve => { session.resolveLeave = result => { session.leave.hidden = true; session.leavePromise = null; session.resolveLeave = null; resolve(result); }; });
    session.stay.focus(); return session.leavePromise;
  }
  function unmount({ force = false } = {}) {
    const session = current; if (!session) return true;
    if (!force && (session.saving || session.saveGate || session.io || imageBusy(session) || handle(session)?.isComposing?.() || dirty(session) && !session.suspended)) return false;
    if (!session.loading) { sync(session); session.bookmark = capture(session); if (dirty(session)) sessions.set(session.ref.id, { ...draft(session), bookmark: session.bookmark }); }
    session.destroyed = true; ++session.modeEpoch; session.resolveLeave?.(false); session.history?.dispose(); session.source?.destroy(); session.visual?.destroy(); session.toolbar?.unmount(); session.readingHandle?.destroy?.(); session.store?.dispose(); session.surface.remove(); current = null; return true;
  }
  async function suspend({ release = false, isCurrent = () => true } = {}) {
    const session = current; if (!session) return true;
    if (!(await flushSession(session)) || !live(session) || !isCurrent()) return false;
    session.suspended = true;
    return release ? unmount() : true;
  }
  async function mount(container, ref, options = {}) {
    if (current?.ref.id === ref.id && current.surface.isConnected) {
      if (options.private && !current.private) { current.private = true; current.store?.dispose(); current.store = null; }
      privateNow(current);
      return options.bookmark ? restorePosition(options.bookmark) : true;
    }
    if (current && !(await beforeLeave())) return false;
    if (!unmount()) return false;
    const session = { ref: { ...ref }, epoch: ++sequence, modeEpoch: 0, mode: 'read', loading: true, content: '', baseContent: '', version: null,
      private: !!options.private || !!hooks.isPrivate?.(ref), sourceConversationId: options.sourceConversationId, supported: true, markdown: /\.(md|markdown|mdx)$/i.test(ref.path), readOnly: false, engineLoading: false, imageCounts: {} };
    current = session;
    const surface = session.surface = el('section', 'local-document note-document local-document-modern'); surface.dataset.mode = 'read'; surface.setAttribute('aria-label', '本机文件编辑器');
    const toolbarHost = el('div', 'local-document-toolbar');
    session.outline = el('details', 'note-document-outline local-document-outline');
    session.outlineSummary = el('summary', '', '文档目录'); session.outlineItems = el('nav'); session.outlineItems.setAttribute('aria-label', '当前文件标题目录');
    session.outline.append(session.outlineSummary, session.outlineItems); session.outline.hidden = !session.markdown;
    session.outline.addEventListener('toggle', () => { renderOutline(session); updateToolbar(session); });
    const body = el('div', 'local-document-body'); session.preview = el('article', 'local-document-preview note-document-preview'); session.preview.dataset.userContent = '';
    session.sourceHost = el('div', 'local-document-source-host'); session.richHost = el('div', 'local-document-rich'); session.sourceHost.hidden = session.richHost.hidden = true; body.append(session.preview, session.sourceHost, session.richHost);
    session.status = el('p', 'local-document-status', '正在读取完整文件与恢复草稿…'); session.status.setAttribute('role', 'status'); session.status.setAttribute('aria-live', 'polite');
    session.leave = el('div', 'note-document-leave'); session.leave.hidden = true; session.leave.setAttribute('role', 'alert'); session.leave.append(el('strong', '', '此文件有未保存的修改'));
    session.stay = button('继续编辑', () => { session.resolveLeave?.(false); handle(session)?.focus(); }, 'stay');
    const discard = button('放弃修改', async () => {
      if (!(await flushInput(session))) return;
      session.io = true; updateToolbar(session);
      try {
        if (!(await clearDraft(session))) { report(session, '恢复草稿未能清除，当前修改仍保留。请重试。'); return; }
        if (!live(session)) return;
        session.history?.clear(); session.historyTrimmed = false; session.content = session.baseContent; session.source?.setValue(session.content); session.visual?.setValue(session.content); preview(session); report(session, '已放弃未保存的修改。'); session.resolveLeave?.(true);
      } finally { if (live(session)) { session.io = false; updateToolbar(session); } }
    }, 'discard');
    session.leave.append(button('保存并继续', () => { void save(); }, 'save-leave'), discard, session.stay);
    session.conflict = el('div', 'local-document-conflict'); session.conflict.hidden = true; session.conflict.setAttribute('role', 'alert'); session.conflictText = el('p');
    const fresh = el('pre'); fresh.hidden = true;
    const restore = button('恢复我的草稿', async () => {
      if (session.recovery === undefined || !(await flushInput(session))) return;
      session.history?.clear(); session.historyTrimmed = false; session.content = session.recovery; session.source?.setValue(session.content); session.visual?.setValue(session.content); remember(session); restore.hidden = true; await setMode('edit'); report(session, '已恢复草稿，请合并磁盘更新后保存。');
    }, 'restore-draft'); restore.hidden = true; session.restore = restore;
    const useLatest = button('载入磁盘版本', async () => {
      if (!session.latest || !(await flushInput(session))) return;
      session.history?.clear(); session.historyTrimmed = false; session.recovery = session.content; restore.hidden = false; session.content = session.latest.content; session.baseContent = session.latest.content; session.version = session.latest.version; session.readOnly = false;
      session.source?.setValue(session.content); session.visual?.setValue(session.content); preview(session); session.conflict.hidden = true;
      // Keep the original unmerged draft durable until the user explicitly saves
      // or discards it. Merely viewing the disk version must not erase recovery.
      session.retainedDraft = true; remember(session); report(session, '已载入磁盘版本；原草稿仍保留，可恢复后手动合并。');
    }, 'use-latest'); useLatest.hidden = true;
    const compare = button('读取磁盘版本以便合并', async () => {
      try { const latest = await hooks.readFile(ref); if (!live(session)) return; session.latest = latest; fresh.textContent = latest.content; fresh.hidden = false; useLatest.hidden = false; session.conflictText.textContent = '当前编辑仍保留。比较后可载入磁盘版本，或继续手动合并。'; }
      catch (error) { if (live(session)) report(session, error.message); }
    }, 'compare'); session.conflict.append(session.conflictText, compare, useLatest, fresh);
    const actions = el('div', 'local-document-secondary');
    session.reload = button('重新读取', async () => {
      if (dirty(session)) { report(session, '请先保存或明确放弃当前修改，再重新读取。'); return; }
      if (!(await flushInput(session))) return;
      session.io = true; updateToolbar(session);
      try { const latest = await hooks.readFile(ref); if (!live(session)) return; session.history?.clear(); session.historyTrimmed = false; session.content = session.baseContent = latest.content; session.version = latest.version; session.readOnly = false; session.source?.setValue(latest.content); session.visual?.setValue(latest.content); preview(session); report(session, '已读取最新磁盘版本。'); }
      catch (error) { if (live(session)) report(session, error.message); }
      finally { if (live(session)) { session.io = false; updateToolbar(session); } }
    }, 'reload');
    session.retry = button('重试编辑器', () => { void setMode(session.retryMode || 'edit'); }, 'retry-editor'); session.retry.hidden = true;
    session.undo = button('撤销此次保存', async () => {
      if (!(await flushInput(session)) || dirty(session) || !session.lastEdit || session.io) { report(session, '请先处理未保存的修改，再撤销。'); return; }
      session.io = true; updateToolbar(session);
      try { hooks.valid(ref); await hooks.request('/__local/edits/undo', { id: session.lastEdit.id }); const latest = await hooks.readFile(ref); if (!live(session)) return; session.history?.clear(); session.historyTrimmed = false; session.content = session.baseContent = latest.content; session.version = latest.version; session.readOnly = false; session.source?.setValue(latest.content); session.visual?.setValue(latest.content); preview(session); session.undo.hidden = true; report(session, '已撤销此次保存。'); hooks.onSaved?.(ref); }
      catch (error) { if (live(session)) report(session, `撤销失败：${error.message}。磁盘现有内容未被覆盖。`); }
      finally { if (live(session)) { session.io = false; updateToolbar(session); } }
    }, 'undo'); session.undo.hidden = true;
    actions.append(session.reload, session.undo, session.retry); surface.append(toolbarHost, session.leave, session.outline, body, session.conflict, restore, actions, session.status); container.replaceChildren(surface);
    session.toolbar = root.HalaskaUI.mount(toolbarHost, 'DocumentToolbar', { mode: 'read', loading: true, canVisual: session.markdown,
      ...(session.markdown ? { onInsertImage: pickImages, imageBusy: 0 } : {}),
      ...(session.markdown ? { onOutline: () => { session.outline.open = !session.outline.open; renderOutline(session); updateToolbar(session); }, outlineOpen: false } : {}),
      onMode: value => setMode(value), onSave: save, onClose: async () => { if (await beforeLeave()) await setMode('read'); }, onFind: () => session.source?.find() });
    surface.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); }
      if (event.key === 'Escape' && !event.defaultPrevented && !surface.querySelector('.cm-search')) { event.preventDefault(); event.stopPropagation(); if (session.mode !== 'read') void setMode('read'); }
    });
    if (!session.private && root.LocalDocumentDrafts?.create) {
      session.store = root.LocalDocumentDrafts.create({ ref, request: hooks.draftRequest, onStatus: state => {
        if (!live(session) || session.loading || session.saving) return;
        if (['error', 'conflict', 'unavailable'].includes(state.state)) report(session, '草稿保存未完成，正文仍在编辑器中。');
        else if (state.state === 'saved' && dirty(session)) report(session, '未保存到文件 · 草稿已保留在本机');
      } });
    }
    try {
      // Do not publish an editable session until both reads finish; otherwise a
      // late recovery response could overwrite input already typed by the user.
      const results = await Promise.allSettled([hooks.readFile(ref), session.store?.load() || Promise.resolve(null)]);
      if (!live(session)) return false;
      const disk = results[0].status === 'fulfilled' ? results[0].value : null;
      const recovery = results[1].status === 'fulfilled' ? results[1].value : null;
      if (recovery?.blocked) throw Error('此项目当前不可访问，恢复草稿没有载入。');
      const retained = recovery?.session || sessions.get(ref.id);
      if (retained) { session.recovery = retained.recoveryContent; session.retainedDraft = !!retained.retainedDraft; restore.hidden = session.recovery === undefined; session.sourceConversationId = retained.sourceConversationId || session.sourceConversationId; }
      if (!disk && !retained) throw (results[0].reason || Error('文件无法读取。'));
      session.content = retained?.content ?? disk.content; session.baseContent = retained?.baseContent ?? disk.content; session.version = retained?.version ?? disk.version;
      session.readOnly = !!recovery?.recoveryOnly || !disk;
      session.loading = false; preview(session);
      if (retained && disk && retained.baseContent === disk.content) session.version = disk.version;
      if (retained && disk && retained.baseContent !== disk.content) { session.conflict.hidden = false; session.conflictText.textContent = '磁盘文件已有更新；你的未保存草稿仍保留。请比较后合并。'; }
      report(session, session.readOnly ? '已恢复草稿。原文件暂不可访问；可以选择和复制正文，重新连接后再保存。' : retained ? '已恢复未保存的本机草稿。' : '本机文件 · 修改后明确保存才会写入磁盘。');
      if (results[1].status === 'rejected') report(session, '恢复草稿暂不可读取。当前原文件可编辑，切换前请确保保存成功。');
      const bookmark = options.bookmark || retained?.bookmark || (retained ? { mode: retained.mode || 'edit', selection: retained.selection, editorScrollTop: retained.scroll?.top, editorScrollLeft: retained.scroll?.left } : null);
      if (bookmark) await restorePosition(bookmark); else if (options.mode) await setMode(options.mode, { focus: false });
      updateToolbar(session); return live(session);
    } catch (error) { if (live(session)) { session.loading = false; session.readOnly = true; report(session, error.message); } return false; }
  }
  const getDraft = id => {
    if (current?.ref.id === id) return dirty(current) ? { ...draft(current) } : null;
    const value = sessions.get(id); return value ? { ...value } : null;
  };
  const currentContent = () => current && !current.loading && !current.engineLoading && !imageBusy(current) && !handle(current)?.isComposing?.() ?
    { id: current.ref.id, title: current.ref.title, content: sync(current), dirty: dirty(current) } : null;
  async function prepareExport() {
    const session = current;
    if (!session || !(await flushInput(session)) || !live(session)) return null;
    hooks.valid(session.ref);
    const content = currentContent();
    return content ? { ...content, ref: { ...session.ref }, ...(session.sourceConversationId ? { sourceConversationId: session.sourceConversationId } : {}) } : null;
  }
  return { mount, setMode, save, getDraft, beforeLeave, close: beforeLeave, unmount, suspend, capturePosition: capture, restorePosition, revealFragment, prepareExport,
    flushDrafts: () => current ? flushSession(current) : Promise.resolve(true),
    current: () => current ? { id: current.ref.id, ref: { ...current.ref }, version: current.version, dirty: dirty(current), loading: current.loading || current.engineLoading, saving: !!(current.saving || current.saveGate), imageBusy: imageBusy(current), mode: current.mode } : null,
    currentContent };
});
