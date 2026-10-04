const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Policy = require('../app/permission-policy.js');

test('conversation mode is explicit and isolated, while unset or unrecognized preferences retain legacy policy', () => {
  for (const mode of ['request','smart','full']) assert.equal(Policy.effectiveMode({permissionMode:mode}),mode);
  for (const value of [undefined,null,{}, {permissionMode:''}, {permissionMode:'Full'}, {permissionMode:'__proto__'}, {permissionMode:{mode:'full'}}]) assert.equal(Policy.effectiveMode(value),'legacy');
  const first = Object.freeze({permissionMode:'request'}), second = Object.freeze({permissionMode:'full'});
  assert.equal(Policy.effectiveMode(first),'request'); assert.equal(Policy.effectiveMode(second),'full');
});

test('empty plans never request approval and request mode requires approval for every actual workstation action', () => {
  for (const mode of ['request','smart','full','legacy']) assert.equal(Policy.needsApproval({mode,actions:[],spaces:['科研'],permissions:{科研:'approval'}}),false);
  for (const type of ['create_project','create_task','update_note','rename_attachment','assign_attachment','link_local_project','delete_task']) assert.equal(Policy.needsApproval({mode:'request',actions:[{type}]}),true,type);
});

test('smart approves destructive changes while supported routine additions and updates proceed automatically', () => {
  for (const type of ['create_project','create_task','create_note','update_note','upsert_paper','create_link','link_local_project']) {
    assert.equal(Policy.needsApproval({mode:'smart',actions:[{type}],spaces:['科研'],permissions:{科研:'approval'}}),false,type);
  }
  for (const type of ['delete_task','delete_note','merge_projects','remove_project','archive_project','purge_trash']) assert.equal(Policy.needsApproval({mode:'smart',actions:[{type}]}),true,type);
  assert.equal(Policy.needsApproval({mode:'smart',actions:[{type:'create_task'},{type:'delete_note'}]}),true);
});

test('full is limited to the supported workstation executor and never auto-authorizes unknown external operations', () => {
  for (const type of ['delete_task','delete_note','create_note','link_local_project']) assert.equal(Policy.needsApproval({mode:'full',actions:[{type}],spaces:['科研'],permissions:{科研:'approval'}}),false,type);
  for (const mode of ['request','smart','full','legacy']) {
    for (const type of ['shell','exec_command','write_file','send_email','upload_file','merge_projects','__proto__','constructor','unknown_operation']) assert.equal(Policy.needsApproval({mode,actions:[{type}]}),true,`${mode}: ${type}`);
    for (const malformed of [[null],['create_task'],[{}],{type:'create_task'}]) assert.equal(Policy.needsApproval({mode,actions:malformed}),true);
  }
});

test('the permission catalogue stays aligned with actions actually supported by the transactional executor', () => {
  const supported = Object.keys(require('../app/workstation-core.js').actionLabels);
  for (const type of supported) {
    assert.equal(Policy.needsApproval({mode:'full',actions:[{type}]}),false,`${type} needs an explicit policy when added to Core`);
    assert.equal(Policy.needsApproval({mode:'request',actions:[{type}]}),true);
    assert.equal(Policy.needsApproval({mode:'smart',actions:[{type}]}),['delete_task','delete_note','delete_attachment','delete_project'].includes(type));
  }
});

test('legacy preserves per-space approval including actual cross-space targets and destructive operations', () => {
  const permissions = Object.freeze({日常:'auto',课程:'approval',科研:'approval'});
  const action = Object.freeze({type:'create_note',workspace:'日常'});
  assert.equal(Policy.needsApproval({mode:'legacy',actions:[action],spaces:['日常'],permissions}),false);
  assert.equal(Policy.needsApproval({actions:[action],spaces:new Set(['日常','科研']),permissions}),true);
  assert.equal(Policy.needsApproval({mode:'legacy',actions:[{type:'create_note',workspace:'课程'}],spaces:['日常'],permissions}),true);
  assert.equal(Policy.needsApproval({actions:[{type:'delete_task'}],spaces:['日常'],permissions}),true);
  assert.equal(Policy.needsApproval({actions:[{type:'merge_projects'}],spaces:['日常'],permissions}),true);
  assert.equal(Policy.needsApproval({actions:[action],spaces:['日常'],permissions:null}),false);
});

test('local search/root confirmation respects selected roots independently from the mode', () => {
  for (const mode of ['request','smart','full','legacy',undefined]) {
    for (const hasRoots of [false,undefined,null,0,[], 'true']) assert.equal(Policy.requiresLocalAccessConfirmation(mode,hasRoots),true,`${mode} cannot invent root authorization`);
  }
  assert.equal(Policy.requiresLocalAccessConfirmation('request',true),true,'request requires confirmation each time even inside existing roots');
  for (const mode of ['smart','full','legacy']) assert.equal(Policy.requiresLocalAccessConfirmation(mode,true),false);
});

test('policy decisions are immutable and ignore inherited/prototype workspace settings', () => {
  const permissions = Object.freeze(Object.create({科研:'approval'}));
  const inputs = Object.freeze({mode:'legacy',actions:Object.freeze([Object.freeze({type:'create_task'})]),spaces:Object.freeze(['科研','constructor','__proto__']),permissions});
  assert.equal(Policy.needsApproval(inputs),false);
  assert.equal(Object.isFrozen(Policy),true);
});

test('the browser UMD exports the same pure contract without filesystem or DOM access', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../app/permission-policy.js'),'utf8'),context);
  const browser = context.WorkstationPermissionPolicy;
  assert.equal(browser.effectiveMode({permissionMode:'full'}),'full');
  assert.equal(browser.needsApproval({mode:'smart',actions:[{type:'delete_task'}]}),true);
  assert.equal(browser.requiresLocalAccessConfirmation('full',false),true);
});

test('reviewer delegation never widens the boundary: approval-required, non-destructive workstation actions only', () => {
  // 默认关闭。没有显式开启时代批一律不成立。
  assert.equal(Policy.canDelegateReview({ actions: [{ type: 'create_note' }] }), false);
  assert.equal(Policy.canDelegateReview({ actions: [{ type: 'create_note' }], enabled: false }), false);
  assert.equal(Policy.canDelegateReview({ actions: [{ type: 'create_note' }], enabled: 'true' }), false);
  // 开启后，白名单内的非破坏性动作才可代批。
  for (const type of ['set_workspace','create_project','rename_attachment','assign_attachment','create_knowledge_item','create_note','update_note','append_note','upsert_paper','upsert_wiki','create_task','update_task','add_tag','create_link','link_items','link_local_project']) {
    assert.equal(Policy.canDelegateReview({ actions: [{ type }], enabled: true }), true, type);
  }
  // 不可逆动作即使在白名单内也永远由人点头。
  for (const type of ['delete_task','delete_note','delete_attachment']) {
    assert.equal(Policy.canDelegateReview({ actions: [{ type }], enabled: true }), false, type);
  }
  // 白名单外的能力不由代批覆盖（代批不是授权）。
  for (const type of ['run_command','write_file','merge_notes','archive_project','',null,undefined,'__proto__']) {
    assert.equal(Policy.canDelegateReview({ actions: [{ type }], enabled: true }), false, String(type));
  }
  // 归属确认需要人的语义判断。
  assert.equal(Policy.canDelegateReview({ actions: [{ type: 'create_task' }], routingReview: true, enabled: true }), false);
  // 空批不代批；一批中只要有一项不可代批，整批交回人。
  assert.equal(Policy.canDelegateReview({ actions: [], enabled: true }), false);
  assert.equal(Policy.canDelegateReview({ actions: [{ type: 'create_task' }, { type: 'delete_note' }], enabled: true }), false);
  assert.equal(Policy.canDelegateReview({ enabled: true }), false);
});

test('session-level allowance only covers non-destructive workstation actions, by type', () => {
  // 可登记的类型 = 白名单内 + 非破坏性。
  assert.deepEqual(Policy.allowableTypes([{ type: 'create_task' }, { type: 'create_project' }]).sort(), ['create_project', 'create_task']);
  assert.deepEqual(Policy.allowableTypes([{ type: 'create_task' }, { type: 'delete_task' }]), ['create_task'], '不可逆动作不进入可登记清单');
  assert.deepEqual(Policy.allowableTypes([{ type: 'run_command' }, { type: 'delete_note' }]), [], '白名单外与破坏性动作都不登记');
  assert.deepEqual(Policy.allowableTypes([]), []);
  assert.deepEqual(Policy.allowableTypes(null), []);
});

test('session allowance never widens what is approvable: every action must be non-destructive and already granted', () => {
  const allows = { create_task: 1 };
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_task' }], allows }), true);
  // 未登记过的同类之外的类型仍然需要确认——按类型逐类放行。
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_project' }], allows }), false);
  // 一批里只要有一项未登记，整批仍需确认。
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_task' }, { type: 'create_note' }], allows }), false);
  // 破坏性动作即便出现在 allows 里也不放行（防止被手工写入或历史数据绕过）。
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'delete_task' }], allows: { delete_task: 1 } }), false);
  // 白名单外动作同样不放行。
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'run_command' }], allows: { run_command: 1 } }), false);
});

test('session allowance refuses empty batches and malformed allow maps', () => {
  assert.equal(Policy.canSessionAllow({ actions: [], allows: { create_task: 1 } }), false);
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_task' }], allows: null }), false);
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_task' }], allows: 'yes' }), false);
  assert.equal(Policy.canSessionAllow({ actions: [{ type: 'create_task' }] }), false, '没有登记就没有会话级放行');
  assert.equal(Policy.canSessionAllow({}), false);
});

test('project deletion follows explicit permission modes and cannot be delegated or session allowed', () => {
  const actions = [{ type: 'delete_project', projectId: 'project' }];
  for (const mode of ['request', 'smart', 'legacy', undefined]) assert.equal(Policy.needsApproval({ mode, actions }), true);
  assert.equal(Policy.needsApproval({ mode: 'full', actions }), false);
  assert.equal(Policy.canDelegateReview({ actions, enabled: true }), false);
  assert.equal(Policy.canSessionAllow({ actions, allows: { delete_project: true } }), false);
  assert.deepEqual(Policy.allowableTypes(actions), []);
});
