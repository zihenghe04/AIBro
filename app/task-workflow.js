/* Four renameable workflow groups, adapted from TO-DO Panel (MIT).
 * P0–P3 are stable category identities, not task urgency or workspace scope.
 * Names are local document UI preferences; membership travels with tasks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const keys = Object.freeze(['P0', 'P1', 'P2', 'P3']);
  const defaults = Object.freeze({ P0: '课程', P1: '科研', P2: '创作', P3: '日常' });
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const validCategory = value => value === null || keys.includes(value);
  const validName = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 32 && !/[\x00-\x1f\x7f]/.test(value);
  function category(task) {
    // Explicit null is an intentional removal, never a request to reimport.
    if (own(task, 'workflowCategory')) return keys.includes(task.workflowCategory) ? task.workflowCategory : null;
    return keys.includes(task?.sourceTaskInbox?.category) ? task.sourceTaskInbox.category : null;
  }
  function names(state) {
    const saved = state?.ui?.taskWorkflowNames;
    return Object.fromEntries(keys.map(key => [key, validName(saved?.[key]) ? saved[key].trim() : defaults[key]]));
  }
  const version = state => JSON.stringify(keys.map(key => names(state)[key]));
  function rename(state, key, value, expectedVersion) {
    if (!keys.includes(key) || !validName(value)) throw Error('invalid');
    if (expectedVersion !== version(state)) {
      // A lost acknowledgement may be retried with the original baseline.
      let expected; try { expected = JSON.parse(expectedVersion); } catch (_) {}
      const current = names(state);
      if (!Array.isArray(expected) || expected.length !== keys.length ||
          !keys.every((id, index) => current[id] === (id === key ? value.trim() : expected[index]))) throw Error('changed');
    }
    const next = { ...names(state), [key]: value.trim() };
    if (keys.some(other => other !== key && next[other].toLocaleLowerCase() === next[key].toLocaleLowerCase())) throw Error('duplicate_name');
    return next;
  }
  return Object.freeze({ keys, defaults, category, validCategory, validName, names, version, rename });
});
