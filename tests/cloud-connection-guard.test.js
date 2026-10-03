const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const code = source.slice(source.indexOf('function cloudHostBusy()'), source.indexOf('\nfunction adoptCloudSnapshot('));

function harness() {
  const calls = [], nodes = new Map(), reader = {visible:false,retained:false};
  const agent = {value:''};
  const context = vm.createContext({
    window:{ReadingPane:{snapshot:()=>reader},flushLocalDrafts:async()=>{calls.push('drafts');return true;},flushWorkspace:async()=>{calls.push('workspace');}},
    state:{},storageHydrated:true,serverSaveInFlight:false,serverConflict:false,importMaterials:{},
    approvalBusy:()=>false,stageAnswerFeedbackDraft:{},commitConversationOrganization:{},commitConversationPath:{},draftSaveTimer:null,
    sendMessage:{},purgeTrash:{},contentDeletePending:false,$:()=>agent,
    document:{activeElement:null,querySelector:selector=>nodes.get(selector)||null}
  });
  vm.runInContext(code,context);
  return {context,calls,nodes,reader,agent};
}

test('read-only and retained document sessions allow connection but defer remote snapshot replacement',()=>{
  const h=harness();
  for(const state of [{visible:true,retained:false},{visible:false,retained:true}]) {
    Object.assign(h.reader,state);assert.equal(h.context.cloudConnectionBusy(),false);assert.equal(h.context.cloudHostBusy(),true);
  }
  assert.deepEqual(h.calls,[],'checking availability does not flush, close or rebuild documents');
});

test('actual document loading, image insertion, saving and import work still block connection',()=>{
  for(const field of ['loading','saving','imageBusy']) {
    const h=harness();h.context.window.ProjectFiles={current:()=>({[field]:true})};assert.equal(h.context.cloudConnectionBusy(),true,field);
  }
  const h=harness();h.nodes.set('.note-document[aria-busy="true"]',{});assert.equal(h.context.cloudConnectionBusy(),true);
  h.nodes.clear();h.context.importMaterials.busy=true;assert.equal(h.context.cloudConnectionBusy(),true);
  h.context.importMaterials.busy=false;h.context.importMaterials.pending=()=>({id:'unacknowledged'});assert.equal(h.context.cloudConnectionBusy(),true);
});

test('model, workspace-write and maintenance-adjacent modal gates remain active',()=>{
  for(const set of [h=>h.context.sendMessage.busy=true,h=>h.context.serverSaveInFlight=true,h=>h.context.serverConflict=true,h=>h.context.state._pendingLocalSave=true,h=>h.context.commitConversationPath.busy=true,h=>h.context.window.AgentQueue={anyBusy:()=>true},h=>h.nodes.set('dialog[open]:not(#cloudSyncDialog)',{}),h=>h.nodes.set('#modelPicker:not([hidden])',{})]) {
    const h=harness();set(h);assert.equal(h.context.cloudConnectionBusy(),true);
  }
});

test('reauthorization flushes existing recovery drafts before workspace persistence without closing the reader',async()=>{
  const h=harness();h.reader.retained=true;
  assert.equal(await h.context.flushCloudConnection(),true);assert.deepEqual(h.calls,['drafts','workspace']);
  assert.equal(h.reader.retained,true);assert.equal(h.context.cloudHostBusy(),true);
});

test('an unacknowledged draft or failed composition flush prevents further connection preparation',async()=>{
  const h=harness();h.context.window.flushLocalDrafts=async()=>{h.calls.push('drafts');return false;};
  assert.equal(await h.context.flushCloudConnection(),false);assert.deepEqual(h.calls,['drafts']);
  h.context.window.flushLocalDrafts=async()=>{throw Error('draft write failed');};
  await assert.rejects(h.context.flushCloudConnection(),/draft write failed/);
});

test('new work or an unresolved durable-save result appearing during flush still prevents the connection',async()=>{
  for(const change of [h=>h.context.serverSaveInFlight=true,h=>h.context.state._pendingLocalSave=true,h=>h.context.importMaterials.busy=true,h=>h.context.sendMessage.busy=true]) {
    const h=harness();h.context.window.flushWorkspace=async()=>{change(h);};assert.equal(await h.context.flushCloudConnection(),false);
  }
});
