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
    'set_workspace', 'create_project', 'delete_project', 'rename_attachment', 'assign_attachment', 'assign_record',
    'create_knowledge_item', 'create_note', 'update_note', 'append_note', 'upsert_paper', 'upsert_wiki',
    'create_task', 'update_task', 'delete_task', 'delete_note', 'delete_attachment', 'add_tag',
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

  // Which already-approval-required actions a reviewer may decide instead of the
  // user. This NEVER widens the boundary: the action still had to be flagged as
  // needing approval by needsApproval(), still has to be one of the workstation's
  // own transactional actions, and must not be destructive or a routing decision.
  // Replacing who approves must not change what is approvable.
  function canDelegateReview({ actions = [], routingReview = false, enabled = false } = {}) {
    if (enabled !== true) return false;
    if (routingReview) return false;          // 跨空间归属需要人的语义判断
    if (!Array.isArray(actions) || !actions.length) return false;
    return actions.every(action => action && WORKSTATION_ACTIONS.has(action.type) && !destructive(action.type) && action.type !== 'assign_record');
  }

  // 会话级授权（「本会话允许」）：用户在审批卡上点过一次后，**同类型的**非破坏性
  // 事务动作在本会话内自动通过。四条边界：
  //   1) 只放行本来就需要审批的动作——它不创造新权限，只是"这个头已经点过了"；
  //   2) 必须是本应用自己的事务动作、且非破坏性（不可逆动作永远由人逐次点头）；
  //   3) 归属确认（routingReview）永不自动通过——那是需要人的语义判断；
  //   4) 放行按**动作类型**逐类登记：允许了 create_task 不等于允许 create_note。
  function canSessionAllow({ actions = [], allows = {} } = {}) {
    if (!allows || typeof allows !== 'object') return false;
    if (!Array.isArray(actions) || !actions.length) return false;
    return actions.every(action => action
      && WORKSTATION_ACTIONS.has(action.type)
      && !destructive(action.type)
      && action.type !== 'assign_record'
      && Object.prototype.hasOwnProperty.call(allows, action.type));
  }

  // 哪些类型可以被登记为"本会话允许"——用于决定是否在审批卡上给出这个按钮。
  function allowableTypes(actions = []) {
    if (!Array.isArray(actions)) return [];
    return [...new Set(actions
      .filter(action => action && WORKSTATION_ACTIONS.has(action.type) && !destructive(action.type) && action.type !== 'assign_record')
      .map(action => action.type))];
  }

  return Object.freeze({ effectiveMode, needsApproval, requiresLocalAccessConfirmation, canDelegateReview, canSessionAllow, allowableTypes });
}));
