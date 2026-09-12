(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationPermissionPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = new Set(['request', 'smart', 'full']);
  const SPACES = new Set(['日常', '课程', '科研']);
  // This is an approval policy for the workstation's own transactional
  // executor, not an authorization to run shell commands or write arbitrary
  // local files. Newly introduced action types require an explicit review.
  const WORKSTATION_ACTIONS = new Set([
    'set_workspace', 'create_project', 'rename_attachment', 'assign_attachment',
    'create_knowledge_item', 'create_note', 'update_note', 'append_note', 'upsert_paper',
    'create_task', 'update_task', 'delete_task', 'delete_note', 'add_tag',
    'create_link', 'link_items', 'link_local_project'
  ]);
  const destructive = type => /(?:^|_)(?:delete|merge|remove|archive|purge)(?:_|$)/.test(type);
  const modeOf = mode => MODES.has(mode) ? mode : 'legacy';

  function effectiveMode(conversation) {
    return modeOf(conversation?.permissionMode);
  }

  function needsApproval({ mode, actions = [], spaces = [], permissions = {} } = {}) {
    if (!Array.isArray(actions)) return true;
    if (!actions.length) return false;
    const effective = modeOf(mode);
    if (effective === 'request') return true;

    // Unknown/external operations never become automatic under "full".
    // Returning true here does not make them supported: the host must still
    // validate every action and reject unsupported capabilities before commit.
    if (actions.some(action => !action || !WORKSTATION_ACTIONS.has(action.type))) return true;
    if (effective === 'full') return false;
    if (actions.some(action => destructive(action.type))) return true;
    if (effective === 'smart') return false;

    // The caller supplies actual affected spaces from the dry-run result,
    // including both link endpoints and before/after project ownership. A
    // model's top-level workspace declaration alone is not sufficient.
    const affected = new Set(Array.isArray(spaces) || spaces instanceof Set ? spaces : [spaces]);
    actions.forEach(action => { if (SPACES.has(action.workspace)) affected.add(action.workspace); });
    return [...affected].some(space => SPACES.has(space) && permissions &&
      Object.prototype.hasOwnProperty.call(permissions, space) && permissions[space] === 'approval');
  }

  function requiresLocalAccessConfirmation(mode, hasRoots) {
    // A mode never grants a filesystem root. Once explicitly selected, those
    // roots authorize the current read-only search/snapshot capability only.
    return hasRoots !== true || modeOf(mode) === 'request';
  }

  return Object.freeze({ effectiveMode, needsApproval, requiresLocalAccessConfirmation });
}));
