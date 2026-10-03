/* Local workspace actions and their receipt share one durable snapshot. This
 * controller never resumes provider, terminal, browser or filesystem effects. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./workstation-core.js') : root.WorkstationCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunCheckpoint = api;
})(globalThis, Core => {
  'use strict';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(value, function (_, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  const stamp = actions => Core?.contentStamp ? Core.contentStamp(stable(actions)) : stable(actions);
  const fault = (code, message) => Object.assign(new Error(message), { code });
  const phases = new Set(['prepared', 'applied', 'committed']);
  const supported = receipt => receipt?.version === 1 && phases.has(receipt.phase);
  // These are applied result operations emitted by WorkstationCore. A saved
  // answer, a matched record or a retained proposal is not a saved output.
  const savedOperations = new Map([
    ['note', new Set(['created', 'updated'])], ['task', new Set(['created', 'updated'])],
    ['paper', new Set(['created', 'updated'])], ['project', new Set(['created', 'linked'])],
    ['import', new Set(['assigned', 'renamed', 'updated'])],
  ]);
  const hasSavedResult = receipt => receipt.phase === 'committed'
    && Number.isSafeInteger(receipt.actionCount) && receipt.actionCount > 0
    && Array.isArray(receipt.results) && receipt.results.some(result =>
      typeof result?.id === 'string' && !!result.id.trim() && !result.undoneAt
      && savedOperations.get(result.type)?.has(result.operation));
  function messageFor(state, run, receipt) {
    return state.conversations?.find(item => item.id === run.conversationId)?.messages?.find(item => item.id === receipt.messageId);
  }
  function present(run, message, receipt) {
    if (receipt.phase === 'committed') {
      run.status = 'completed'; run.finishedAt = receipt.appliedAt || receipt.committedAt;
      message.live = false; message.runStatus = 'completed'; message.pendingRunId = null;
      delete message.retryRunId;
      message.text = receipt.answer; message.results = clone(receipt.results || []);
      if (receipt.clarify !== undefined) message.clarify = clone(receipt.clarify);
      message.steps = run.steps;
    } else {
      run.status = receipt.phase === 'applied' ? 'awaiting-save' : 'interrupted';
      message.live = false; message.runStatus = run.status;
      if (receipt.phase === 'applied') { message.pendingRunId = run.id; delete message.retryRunId; }
    }
  }
  function recover(state) {
    let changed = false;
    for (const run of state?.agentRuns || []) {
      const receipt = run.executionReceipt;
      if (!supported(receipt)) continue;
      if (run.approvalReceipt || receipt.phase === 'prepared' && ['awaiting-approval', 'rejected'].includes(run.status)) continue;
      const message = messageFor(state, run, receipt);
      if (!message) continue;
      const before = stable([run.status, run.finishedAt, message]);
      present(run, message, receipt);
      if (stable([run.status, run.finishedAt, message]) !== before) changed = true;
    }
    return changed;
  }
  function view(run) {
    const receipt = run?.executionReceipt;
    return supported(receipt) ? {
      phase: receipt.phase, receiptId: receipt.id, actionCount: receipt.actionCount, hasSavedResult: hasSavedResult(receipt),
      error: receipt.error || '', canContinue: receipt.phase === 'prepared', canSave: receipt.phase === 'applied', busy: false,
    } : null;
  }
  function create({ getState, persist, apply, validate = () => {}, onSettled = () => {}, changed = () => {}, uid, now = Date.now }) {
    if (typeof getState !== 'function' || typeof persist !== 'function' || typeof apply !== 'function') throw new TypeError('RunCheckpoint requires getState, persist and synchronous apply');
    let owner = null, ownedRecord = null, sequence = 0;
    function lookup(runId) {
      const state = getState(), run = state?.agentRuns?.find(item => item.id === runId);
      if (!run || run.deletedAt || run.deleted || run.archivedAt || run.archived) throw fault('CHECKPOINT_GONE', '执行记录已删除或归档，请核对历史。');
      const receipt = run.executionReceipt;
      if (!supported(receipt)) throw fault('CHECKPOINT_PHASE', '这条执行记录没有可继续的本机动作检查点。');
      const message = messageFor(state, run, receipt);
      if (!message || message.deletedAt || message.deleted) throw fault('CHECKPOINT_GONE', '检查点所属消息已不可用。');
      return { run, receipt, message };
    }
    function verify(record) {
      const current = lookup(record.run.id);
      if (current.run !== record.run || current.receipt !== record.receipt || current.message !== record.message)
        throw fault('CHECKPOINT_CHANGED', '保存或核对期间执行记录已被替换，请重新检查当前记录。');
      const receipt = current.receipt;
      if (stamp(receipt.actions) !== receipt.planStamp || receipt.actionCount !== receipt.actions?.length)
        throw fault('CHECKPOINT_PLAN_CHANGED', '已保存的动作检查点发生变化，请重新核对。');
      if (receipt.phase === 'prepared' && stamp(current.run.pendingActions || []) !== receipt.planStamp)
        throw fault('CHECKPOINT_PLAN_CHANGED', '待执行动作与已保存检查点不一致，未执行。');
      if (receipt.phase !== 'prepared' && stable(current.run.results || []) !== stable(receipt.results || []))
        throw fault('CHECKPOINT_RESULTS_CHANGED', '已应用结果与检查点不一致，未再次执行动作。');
      return current;
    }
    function notify(record, reason) {
      try { changed(record.run, reason); } catch (error) { record.receipt.displayError = String(error?.message || error); }
    }
    async function checkpoint(record) {
      verify(record);
      const signature = stable(record.receipt), phase = record.receipt.phase;
      let result;
      try { result = await persist(); }
      catch (error) { if (error?.code) throw error; throw fault('CHECKPOINT_SAVE_FAILED', String(error?.message || error)); }
      verify(record);
      if (record.receipt.phase !== phase || stable(record.receipt) !== signature)
        throw fault('CHECKPOINT_CHANGED', '保存期间检查点发生变化，请核对实际保存的记录。');
      if (result === false) throw fault('CHECKPOINT_SAVE_FAILED', '本机检查点尚未保存，请重试保存。');
    }
    async function commit(record) {
      ownedRecord ||= record;
      verify(record);
      if (record.receipt.phase === 'committed') return record.receipt;
      if (record.receipt.phase !== 'applied') throw fault('CHECKPOINT_PHASE', '动作尚未应用，请从已保存的计划继续。');
      delete record.receipt.error;
      record.run.status = 'awaiting-save'; record.message.live = false;
      record.message.runStatus = 'awaiting-save'; record.message.pendingRunId = record.run.id; delete record.message.retryRunId;
      notify(record, 'saving');
      await checkpoint(record);
      record.receipt.phase = 'committed'; record.receipt.committedAt = now();
      present(record.run, record.message, record.receipt);
      // This marker may join the host's next ordinary snapshot. If the process
      // exits first, the durable `applied` receipt can only re-save, never apply.
      notify(record, 'committed');
      try { await onSettled(record.run, record.receipt); }
      catch (error) { record.receipt.followupError = String(error?.message || error); }
      return record.receipt;
    }
    async function advance(record) {
      ownedRecord ||= record;
      verify(record);
      if (record.receipt.phase !== 'prepared') return commit(record);
      delete record.receipt.error;
      notify(record, 'preparing');
      // Re-save on explicit continuation too: a previous preparation save may
      // have failed or its acknowledgement may have been lost.
      await checkpoint(record);
      const signature = stable(record.receipt);
      const valid = await validate(record.run, clone(record.receipt.actions), record.receipt);
      verify(record);
      if (stable(record.receipt) !== signature) throw fault('CHECKPOINT_CHANGED', '核对期间检查点发生变化，未执行。');
      if (valid === false) throw fault('CHECKPOINT_VALIDATION', '动作范围核对未通过，未执行。');
      let entered = false, committing = true;
      const beforeCommit = () => {
        if (!committing) throw fault('CHECKPOINT_APPLY_CONTRACT', '本机提交回调不能延迟到异步任务中执行。');
        verify(record);
        if (entered) throw fault('CHECKPOINT_APPLY_CONTRACT', '本机动作只能提交一次。');
        entered = true; record.receipt.phase = 'applied'; record.receipt.appliedAt = now();
        record.run.status = 'awaiting-save'; record.message.live = false;
        record.message.runStatus = 'awaiting-save'; record.message.pendingRunId = record.run.id; delete record.message.retryRunId;
      };
      let result;
      try {
        // Contract: the hook prepares a cloned applyPlan result first, invokes
        // beforeCommit immediately before replacing local collections, and
        // performs that replacement synchronously with no callbacks/awaits.
        result = apply(clone(record.receipt.actions), record.run, beforeCommit);
        if (result?.then) throw fault('CHECKPOINT_APPLY_CONTRACT', '本机动作提交必须同步完成。');
        if (!entered) throw fault('CHECKPOINT_APPLY_CONTRACT', '本机动作提交缺少检查点回执。');
      } finally {
        committing = false;
        // A host failure after its commit boundary must never enable replay.
        if (entered) record.receipt.results = clone(record.run.results || (Array.isArray(result) ? result : []));
      }
      verify(record);
      notify(record, 'applied');
      return commit(record);
    }
    async function locked(runId, task) {
      if (owner !== null) throw fault('CHECKPOINT_BUSY', '另一条本机动作检查点正在保存或核对，请稍候。');
      owner = runId; ownedRecord = null;
      try { return await task(); }
      catch (error) {
        // Never modify a removed/replaced closure. Only the currently owned
        // receipt can be made retryable, and applied actions remain save-only.
        const run = getState()?.agentRuns?.find(item => item.id === runId), receipt = run?.executionReceipt;
        if (run === ownedRecord?.run && receipt === ownedRecord?.receipt && supported(receipt) && receipt.phase !== 'committed') {
          receipt.error = String(error?.message || error);
          const message = messageFor(getState(), run, receipt);
          if (message) present(run, message, receipt);
          notify({ run, receipt }, 'blocked');
        }
        throw error;
      } finally {
        const finished = ownedRecord; owner = null; ownedRecord = null;
        if (finished && getState()?.agentRuns?.find(item => item.id === runId) === finished.run && finished.run.executionReceipt === finished.receipt) notify(finished, 'idle');
      }
    }
    return {
      prepare(runId, messageId, { answer = '', clarify } = {}) {
        return locked(runId, async () => {
          const run = getState()?.agentRuns?.find(item => item.id === runId);
          if (!run) throw fault('CHECKPOINT_GONE', '执行记录已不可用。');
          if (!run.executionReceipt) {
            const actions = clone(run.pendingActions || []);
            run.executionReceipt = { version: 1, id: uid ? uid('execution') : `execution_${now()}_${++sequence}`, phase: 'prepared', messageId,
              answer: String(answer), actions, actionCount: actions.length, planStamp: stamp(actions), preparedAt: now(),
              ...(clarify === undefined ? {} : { clarify: clone(clarify) }) };
          } else if (run.executionReceipt.messageId !== messageId) throw fault('CHECKPOINT_CHANGED', '检查点已属于另一条消息，不会覆盖。');
          return advance(lookup(runId));
        });
      },
      continue: runId => locked(runId, () => advance(lookup(runId))),
      save: runId => locked(runId, () => commit(lookup(runId))),
      recover,
      isBusy: () => owner !== null,
      view(run) { const value = view(run); return value && { ...value, busy: owner !== null, canContinue: value.canContinue && owner === null, canSave: value.canSave && owner === null }; },
    };
  }
  return { create, recover, view };
});
