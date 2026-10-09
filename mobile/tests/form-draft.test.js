import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter, putRecord } from '../src/store.js';
import { createFormDraft, inspectFormDraft, getFormDraftWrite, formDraftKey, clearFormDraft } from '../src/form-draft.js';

const task = { id:'synthetic_task', title:'Mac 任务', description:'原文', status:'in_progress', checklist:[{id:'check-a',text:'原清单',custom:'保留'}], updatedAt:1 };
const taskValues = () => ({title:' 手机草稿 ',description:'未完成\n输入',status:'in_progress',priority:'high',due:'',start:'',reminder:'inherit',project:'',checklist:[{index:0,text:' ',done:true},{index:null,text:'新项',done:false}]});
const eventValues = () => ({title:'日程草稿',start:'2030-01-02T15:00',end:'2030-01-02T16:00',location:'',reminder:'15',project:'',details:'未提交',frequency:'weekly',repeatInterval:'',repeatCount:'',repeatUntil:'',repeatDays:['2','4'],weekdaysEdited:true});
const eventContext = {timeZone:'Asia/Shanghai',sourceID:'synthetic_source'};

test('raw incomplete task values reopen durably without changing or syncing any record', async () => {
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load(), key = formDraftKey('task', task.id);
  await store.put('tasks',task); const before = structuredClone(store.state.records);
  const values = taskValues(), draft = createFormDraft('task',task,values);
  values.checklist[0].text = 'outside mutation';
  await store.tx(s => {s.drafts[key] = draft;});
  const reopened = await new Store(adapter).load(), inspected = inspectFormDraft('task',reopened.state.drafts[key],reopened.get('tasks',task.id));
  assert.equal(inspected.state,'ready'); assert.equal(inspected.values.checklist[0].text,' ');
  assert.deepEqual(reopened.state.records,before); assert.equal(inspected.base.checklist[0].custom,'保留');
  inspected.values.title='UI mutation'; assert.equal(draft.values.title,' 手机草稿 ');
});

test('new task and event drafts have isolated scopes and retain time zone and repeated days', () => {
  const keys = [formDraftKey('task'),formDraftKey('task','new'),formDraftKey('task',null,{scopeID:'p'}),formDraftKey('task',null,{scopeID:'q'}),formDraftKey('event')];
  assert.equal(new Set(keys).size, keys.length);
  const draft = createFormDraft('event',null,eventValues(),eventContext);
  const view = inspectFormDraft('event',JSON.parse(JSON.stringify(draft)),null);
  assert.equal(view.state,'ready'); assert.equal(view.context.timeZone,'Asia/Shanghai');
  assert.deepEqual(view.values.repeatDays,['2','4']); assert.equal(view.values.repeatInterval,'');
  assert.equal(inspectFormDraft('event',draft,{id:'new_existing'}).reason,'new-record-already-exists');
});

test('sync updates, archive and removal cannot be overwritten by a reopened task draft', async () => {
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load(), key = formDraftKey('task',task.id);
  await store.put('tasks',task);
  const draft = createFormDraft('task',task,taskValues()); await store.tx(s=>{s.drafts[key]=draft;});
  for (const remote of [{...task,description:'Mac 新说明',updatedAt:2},{...task,archived:true},null]) {
    await store.tx(s=>{s.records['tasks:'+task.id]={...s.records['tasks:'+task.id],data:remote,deleted:!remote};});
    const reloaded = await new Store(adapter).load();
    await assert.rejects(reloaded.tx(s=>getFormDraftWrite('task',s.drafts[key],reloaded.get('tasks',task.id))), {code:'FORM_DRAFT_CHANGED'});
    assert.deepEqual(reloaded.state.drafts[key],draft); assert.deepEqual(reloaded.get('tasks',task.id),remote);
  }
});

test('transaction-time guard catches an event source change after ready inspection', async () => {
  const store = await new Store(new MemoryAdapter()).load(), note={id:'event',kind:'日程',content:'event JSON',sourceNoteIds:['old'],updatedAt:1};
  await store.put('notes',note);
  const draft=createFormDraft('event',note,eventValues(),eventContext);
  assert.equal(inspectFormDraft('event',draft,note).canSave,true);
  await store.put('notes',{...note,sourceNoteIds:['new']});
  await assert.rejects(store.tx(s=>getFormDraftWrite('event',draft,s.records['notes:event'].data)),{code:'FORM_DRAFT_CHANGED'});
  assert.deepEqual(store.get('notes','event').sourceNoteIds,['new']);
});

test('failed durable save keeps both original record and draft; successful transaction clears only submitted input', async () => {
  class FailingAdapter extends MemoryAdapter { async write(value) { if(this.fail)throw Error('synthetic disk failure');return super.write(value); } }
  const adapter=new FailingAdapter(),store=await new Store(adapter).load(),key=formDraftKey('task',task.id),draft=createFormDraft('task',task,taskValues());
  await store.put('tasks',task); await store.tx(s=>{s.drafts[key]=draft;});
  const save=()=>store.tx(s=>{const write=getFormDraftWrite('task',draft,s.records['tasks:'+task.id].data);putRecord(s,'tasks',{...write.base,title:write.values.title},write.base);clearFormDraft(s,key,draft);});
  adapter.fail=true; await assert.rejects(save(),/disk failure/); adapter.fail=false;
  let reloaded=await new Store(adapter).load(); assert.deepEqual(reloaded.get('tasks',task.id),task); assert.deepEqual(reloaded.state.drafts[key],draft);
  const newer=createFormDraft('task',task,{...taskValues(),title:'later text'});
  await store.tx(s=>{s.drafts[key]=newer;}); await save();
  reloaded=await new Store(adapter).load(); assert.equal(reloaded.get('tasks',task.id).title,draft.values.title); assert.deepEqual(reloaded.state.drafts[key],newer);
  await store.tx(s=>{assert.equal(clearFormDraft(s,key,newer),true);}); assert.equal(store.state.drafts[key],undefined);
});

test('invalid envelopes never adopt current baseline and cannot be saved or erase unrelated editor drafts', () => {
  const valid=createFormDraft('task',task,taskValues());
  for(const raw of [{...valid,base:undefined},{...valid,kind:'event'},{title:'old unversioned input'},{...valid,values:{...valid.values,checklist:[{index:-1,text:'a',done:false}]}}]) {
    assert.equal(inspectFormDraft('task',raw,task).state,'invalid'); assert.throws(()=>getFormDraftWrite('task',raw,task),{code:'FORM_DRAFT_INVALID'});
  }
  const state={drafts:{'editor:n':valid}};
  assert.equal(clearFormDraft(state,'editor:n',valid),false); assert.ok(state.drafts['editor:n']);
});
