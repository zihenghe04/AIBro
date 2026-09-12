const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Policy = require('../permission-policy.js');

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
  const supported = Object.keys(require('../workstation-core.js').actionLabels);
  for (const type of supported) {
    assert.equal(Policy.needsApproval({mode:'full',actions:[{type}]}),false,`${type} needs an explicit policy when added to Core`);
    assert.equal(Policy.needsApproval({mode:'request',actions:[{type}]}),true);
    assert.equal(Policy.needsApproval({mode:'smart',actions:[{type}]}),type==='delete_task'||type==='delete_note');
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
  vm.runInContext(fs.readFileSync(require.resolve('../permission-policy.js'),'utf8'),context);
  const browser = context.WorkstationPermissionPolicy;
  assert.equal(browser.effectiveMode({permissionMode:'full'}),'full');
  assert.equal(browser.needsApproval({mode:'smart',actions:[{type:'delete_task'}]}),true);
  assert.equal(browser.requiresLocalAccessConfirmation('full',false),true);
});
