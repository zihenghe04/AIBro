/* Durable edits to the next message selection. Sent messages and queued runs
 * keep their own snapshots; no source record is modified by this coordinator. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContextSelection = api;
})(globalThis, function (root) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const F = () => root.FileContext || require('./file-context.js');
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  function create(hooks) {
    let busy = false;
    const find = id => { const found = list(hooks.getState()?.conversations).filter(item => item.id === id); const item = found.length === 1 ? found[0] : null; return item && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !['archived', 'deleted'].includes(item.status) ? item : null; };
    function assertOwner(id) {
      const conversation = find(id);
      if (!conversation || hooks.getConversation()?.id !== id || hooks.isPrivate?.() || conversation.private || conversation.incognito || conversation.ephemeral)
        throw Error(t('当前对话已改变，请重新选择资料。', 'The current conversation changed. Select the material again.'));
      if (hooks.isPreparing?.()) throw Error(t('正在准备发送，请稍后调整下一轮资料。', 'A message is being prepared. Adjust the next selection afterwards.'));
      const projects = list(hooks.getState()?.projects).filter(item => item.id === conversation.projectId);
      const project = projects.length === 1 ? projects[0] : null;
      if (conversation.projectId && (!project || project.archived || project.archivedAt || project.deleted || project.deletedAt || ['archived', 'deleted'].includes(project.status))) throw Error(t('当前项目已不可用，请更换对话范围。', 'This project is unavailable. Change the conversation scope.'));
      if (project?.private || project?.incognito || project?.ephemeral) throw Error(t('私密项目不能在此修改上下文。', 'Context cannot be changed here for a private project.'));
      hooks.assertReady?.();
      return conversation;
    }
    async function mutate(command) {
      if (busy) throw Error(t('上一项资料选择正在保存，请稍候。', 'The previous selection is still being saved.'));
      if (!['add-reference', 'add-attachment', 'refresh-reference', 'remove-reference', 'remove-attachment'].includes(command?.action)) throw Error('Unsupported context selection action');
      const id = command.conversationId;
      const validString = value => typeof value === 'string' && value.trim().length > 0;
      if (!validString(id)) throw Error('Invalid conversation identity');
      let conversation = assertOwner(id), ref = ['remove-attachment', 'add-attachment'].includes(command.action) ? { type: 'import', id: command.id } : command.ref;
      const validRef = value => value && ['note', 'import', 'local'].includes(value.type) && (value.type === 'local' ? validString(value.candidateId) && validString(value.path) && validString(value.projectId) : validString(value.id));
      if (!validRef(ref)) throw Error('Invalid context reference');
      const key = F().key(ref), original = F().references(conversation).find(item => F().key(item) === key);
      const historicalAttachment = ref.type === 'import' && list(conversation.messages).some(message => !message.deletedAt && message.role === 'user' && (list(message.attachmentIds).includes(ref.id) || list(message.attachments).some(item => item.id === ref.id)));
      if (!command.action.startsWith('add-') && !original && !(ref.type === 'import' && (list(conversation.draftAttachmentIds).includes(ref.id) || historicalAttachment))) throw Error(t('这项资料已经不在下次发送中。', 'This material is no longer selected.'));
      busy = true; hooks.onChange?.();
      let patches, contextBefore, contextAfter, applied = false;
      try {
        if (['add-reference', 'add-attachment', 'refresh-reference'].includes(command.action)) {
          if (!hooks.access(hooks.getState(), ref).available) throw Error(t('来源已不可用，请重新选择。', 'The source is no longer available.'));
          if (command.action === 'refresh-reference') ref = await hooks.selectRef(ref);
          if (!validRef(ref) || F().key(ref) !== key) throw Error(t('来源身份发生变化，请重新选择。', 'The source identity changed. Select it again.'));
          conversation = assertOwner(id);
          if (!hooks.access(hooks.getState(), ref).available) throw Error(t('来源已不可用，请重新选择。', 'The source is no longer available.'));
          const current = F().references(conversation).find(item => F().key(item) === key);
          if (command.action === 'refresh-reference' && !equal(current, original)) throw Error(t('资料选择已经变化，请重新更新。', 'The material selection changed. Refresh it again.'));
        }
        const fields = ['draftFileReferences', 'excludedFileReferenceKeys', ...(ref.type === 'import' && (command.action.startsWith('remove-') || command.action === 'add-attachment') ? ['draftAttachmentIds'] : []), ...(command.action === 'add-attachment' ? ['attachments'] : [])];
        patches = fields.map(field => ({ field, before: clone(conversation[field]) }));
        contextBefore = F().contextSnapshot(conversation, ref);
        if (command.action.startsWith('remove-')) {
          F().remove(conversation, ref);
          if (ref.type === 'import') conversation.draftAttachmentIds = list(conversation.draftAttachmentIds).filter(value => value !== ref.id);
        } else if (command.action === 'add-attachment') {
          // Validate the portable selection limit before changing any fields.
          F().stage(conversation, ref);
          conversation.attachments = [...new Set([...list(conversation.attachments), ref.id])];
          conversation.draftAttachmentIds = [...new Set([...list(conversation.draftAttachmentIds), ref.id])];
        } else F().stage(conversation, ref);
        patches.forEach(patch => { patch.after = clone(conversation[patch.field]); });
        contextAfter = F().contextSnapshot(conversation, ref); applied = true;
        if ((await hooks.save()) === false) throw Error(t('上下文选择未保存，请重试。', 'The context selection was not saved. Try again.'));
        return true;
      } catch (error) {
        // Reconcile only this reference's entries. Draft text, other references,
        // queue entries and stream updates may have changed during the save.
        const live = find(id);
        if (live && applied) F().rollbackContext(live, ref, contextBefore, contextAfter);
        if (live && applied) for (const patch of patches) {
          const matches = value => patch.field === 'draftFileReferences' ? F().key(value) === key : patch.field === 'excludedFileReferenceKeys' ? value === key : value === ref.id;
          const current = list(live[patch.field]);
          if (equal(current.filter(matches), list(patch.after).filter(matches))) {
            const restored = [...current.filter(value => !matches(value)), ...list(patch.before).filter(matches)];
            if (!restored.length && patch.before === undefined && !current.filter(value => !matches(value)).length) delete live[patch.field];
            else live[patch.field] = restored;
          }
        }
        if (applied) hooks.onRollback?.();
        throw error;
      } finally { busy = false; hooks.onChange?.(); }
    }
    return { mutate, isBusy: () => busy };
  }
  return { create };
});
