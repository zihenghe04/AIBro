/* Reference an explicitly chosen reading source in the next message. Routing,
 * source saving and durable context mutation stay with their existing owners. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocumentChat = api;
})(globalThis, function (root) {
  'use strict';
  const clone = value => value == null ? value : structuredClone(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const versioned = source => typeof source?.version === 'string' || (typeof source?.version === 'number' && Number.isFinite(source.version));
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  const referenceKey = ref => {
    if (!ref || !['note', 'import', 'local'].includes(ref.type)) return null;
    if (ref.type === 'local') return [ref.candidateId, ref.projectId, ref.path].every(nonempty)
      ? JSON.stringify([ref.type, ref.candidateId, ref.projectId, ref.path]) : null;
    return nonempty(ref.id) ? JSON.stringify([ref.type, ref.id]) : null;
  };
  const sourceKey = source => source && versioned(source) && nonempty(source.kind) && nonempty(source.id) && referenceKey(source.ref)
    ? JSON.stringify([source.kind, source.id, referenceKey(source.ref), source.projectId ?? null, source.workspace ?? null]) : null;
  const targetKey = target => target && nonempty(target.key)
    ? JSON.stringify([target.key, target.kind, target.conversationId ?? null, target.projectId ?? null, target.workspace ?? null]) : null;
  const cancelled = reason => Object.assign(Error(reason), { documentChatCancelled: true, reason });

  function create(hooks) {
    let generation = 0, active = null;
    const changed = () => hooks.onChange?.();
    const ready = () => hooks.isReady?.() !== false;

    function describe() {
      const source = clone(hooks.getSource());
      return { source, targets: sourceKey(source) ? clone(hooks.targets?.(source) || []) : [], busy: !!active };
    }

    function cancel() {
      generation++;
      active?.abort.abort();
      active = null;
      changed();
    }

    async function prepare(key, options = {}) {
      if (active) return { status: 'busy' };
      const operation = { ticket: ++generation, abort: new AbortController() };
      active = operation;
      changed();
      let source, target, conversationId, staged = false;
      const alive = () => active === operation && operation.ticket === generation && !operation.abort.signal.aborted;
      const assertAlive = () => { if (!alive()) throw cancelled('cancelled'); };
      const assertTarget = () => {
        const current = hooks.getTarget(key, source);
        if (!current || !targetKey(target) || targetKey(current) !== targetKey(target)) throw cancelled('target-changed');
      };
      const assertSource = () => {
        const current = hooks.getSource();
        if (!sourceKey(source) || sourceKey(current) !== sourceKey(source) ||
            current.dirty || current.version !== source.version || hooks.isCurrentSource?.(source) === false)
          throw cancelled('source-changed');
      };
      const guard = () => {
        assertAlive();
        if (!ready()) throw cancelled('unavailable');
        assertSource();
        assertTarget();
      };
      const navigationCurrent = () => {
        try { guard(); return true; } catch (_) { return false; }
      };
      const assertConversation = () => {
        if (!nonempty(conversationId) || hooks.getConversationId() !== conversationId) throw cancelled('conversation-changed');
      };

      try {
        source = clone(hooks.getSource());
        if (!sourceKey(source) || !ready() || hooks.isCurrentSource?.(source) === false)
          throw Error(t('这份资料已不可用，请重新打开后引用。', 'This source is unavailable. Reopen it before referencing it.'));
        target = clone(hooks.getTarget(key, source));
        if (!targetKey(target)) throw Error(t('目标对话已不可用，请重新选择。', 'The target is unavailable. Choose it again.'));
        const originConversation = hooks.getConversationId();
        if (source.dirty) {
          if (options.save !== true) throw Error(t('请先保存文档，或选择“保存并引用”。', 'Save the document first, or choose “Save and reference”.'));
          const originalKey = sourceKey(source);
          const saved = await hooks.saveSource(clone(source));
          assertAlive();
          if (saved !== true) throw Error(t('文档未确认保存，尚未加入对话。', 'The document was not confirmed saved. No reference was added.'));
          const current = hooks.getSource();
          // The explicit save can legitimately replace the saved version or
          // remount the same document. Never accept a different reader source.
          if (sourceKey(current) !== originalKey || current.dirty || hooks.getConversationId() !== originConversation)
            throw cancelled('source-changed');
          source = clone(current);
        }
        guard();
        if (hooks.getConversationId() !== originConversation) throw cancelled('conversation-changed');
        conversationId = await hooks.navigate(clone(target), { isCurrent: navigationCurrent, signal: operation.abort.signal });
        guard();
        assertConversation();
        if (target.conversationId && target.conversationId !== conversationId) throw cancelled('target-changed');
        const ref = await hooks.selectRef(clone(source.ref), { conversationId, signal: operation.abort.signal });
        guard();
        assertConversation();
        if (referenceKey(ref) !== referenceKey(source.ref) || !nonempty(ref?.version) ||
            (nonempty(source.ref.version) && ref.version !== source.ref.version))
          throw Error(t('资料引用已变化，请重新选择。', 'The source reference changed. Select it again.'));
        // ContextSelection owns the durable, reference-scoped mutation and its
        // rollback. This controller never writes composer text or sends a turn.
        const result = await hooks.stage({ action: 'add-reference', conversationId, ref: clone(ref) });
        if (result !== true) throw Error(t('资料引用尚未保存，请重试。', 'The reference was not saved. Try again.'));
        staged = true;
        guard();
        assertConversation();
        if (hooks.canFocus?.({ source: clone(source), target: clone(target), conversationId }) === false)
          return { status: 'staged', conversationId, focused: false };
        hooks.focusComposer();
        hooks.notify?.(t('已加入下一次提问的资料。', 'Added to the next message’s sources.'), { kind: 'success', conversationId });
        return { status: 'staged', conversationId, focused: true };
      } catch (error) {
        if (!alive() || error?.documentChatCancelled || error?.name === 'AbortError')
          return { status: 'cancelled', reason: error?.reason || 'cancelled', ...(staged ? { staged: true, conversationId } : {}) };
        return { status: 'error', error, message: error?.message || String(error) };
      } finally {
        if (active === operation) { active = null; changed(); }
      }
    }

    return { describe, prepare, cancel, isBusy: () => !!active };
  }
  return { create };
});
