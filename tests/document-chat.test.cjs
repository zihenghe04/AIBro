'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FileContext = require('../app/file-context.js');
global.FileContext = FileContext;
const ContextSelection = require('../app/context-selection.js');
const DocumentChat = require('../app/document-chat.js');
const clone = value => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function until(condition) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected asynchronous operation did not start');
}

function fixture(options = {}) {
  const state = {
    projects: [{id:'p', name:'Project'}],
    notes: [{id:'n1', kind:'笔记', title:'Reading document', content:'Saved original', projectId:'p'},
            {id:'n2', kind:'笔记', title:'Another document', content:'Other saved body', projectId:'p'}],
    imports: [],
    conversations: ['c1', 'c2'].map(id => ({id, projectId:'p', draft:'Keep typed prompt '+id,
      messages:[{id:'sent-'+id,role:'user',text:'Original sent turn'}],
      queuedMessages:[{id:'queued-'+id,text:'Queued separately'}], draftFileReferences:[]})),
  };
  const targets = new Map([
    ['existing:c1', {key:'existing:c1',kind:'existing',conversationId:'c1',projectId:'p',workspace:'科研',label:'First chat'}],
    ['existing:c2', {key:'existing:c2',kind:'existing',conversationId:'c2',projectId:'p',workspace:'科研',label:'Second chat'}],
    ['new:p', {key:'new:p',kind:'new',projectId:'p',workspace:'科研',label:'New chat'}],
  ]);
  let sourceId = 'n1', currentId = 'c1', dirty = false, available = true, ready = true;
  let saveCalls = 0, navCalls = 0, selectCalls = 0, stageCalls = 0, focusCalls = 0, rollbacks = 0;
  const changes = [], notifications = [], selectionSignals = [];
  const source = () => {
    const note = state.notes.find(note => note.id === sourceId);
    return available && note ? {kind:'note',id:note.id,ref:{type:'note',id:note.id},title:note.title,
      projectId:note.projectId,workspace:'科研',dirty,version:note.content} : null;
  };
  const selection = ContextSelection.create({
    getState:()=>state, getConversation:()=>state.conversations.find(item=>item.id===currentId),
    access:(_state,ref)=>({available:available && state.notes.some(note=>note.id===ref.id)}),
    save:async()=> options.persist ? options.persist(api) : true,
    onRollback:()=>{rollbacks++;},
  });
  const controller = DocumentChat.create({
    getSource:source,
    isCurrentSource:expected=>{const live=source();return !!live && live.id===expected.id && live.version===expected.version;},
    targets:()=>[...targets.values()], getTarget:key=>targets.get(key),
    isReady:()=>ready,
    saveSource:async record=>{
      saveCalls++;
      if (options.saveSource) return options.saveSource(record, api);
      state.notes.find(note=>note.id===record.id).content='Explicitly saved draft'; dirty=false; return true;
    },
    navigate:async(target,guard)=>{
      navCalls++;
      if(options.navigate) return options.navigate(target,guard,api);
      if(!guard.isCurrent()) return null;
      currentId=target.conversationId || 'created-chat';
      if(!state.conversations.some(item=>item.id===currentId)) state.conversations.push({id:currentId,projectId:target.projectId,draft:'',messages:[]});
      return currentId;
    },
    selectRef:async(ref,context)=>{
      selectCalls++; selectionSignals.push(context.signal);
      return options.selectRef ? options.selectRef(ref,context,api) : FileContext.libraryRef(state,ref.type,ref.id);
    },
    stage:async command=>{stageCalls++; return options.stage ? options.stage(command,api) : selection.mutate(command);},
    getConversationId:()=>currentId,
    focusComposer:()=>{focusCalls++;},
    notify:(...values)=>notifications.push(values),
    canFocus:context=>options.canFocus ? options.canFocus(context,api) : true,
    onChange:()=>changes.push(controller?.isBusy()),
  });
  const api = {controller,state,targets,selection,notifications,changes,selectionSignals,
    get saveCalls(){return saveCalls;}, get navCalls(){return navCalls;}, get selectCalls(){return selectCalls;},
    get stageCalls(){return stageCalls;}, get focusCalls(){return focusCalls;}, get rollbacks(){return rollbacks;},
    get currentId(){return currentId;},
    current:id=>{currentId=id;}, read:id=>{sourceId=id;}, dirty:value=>{dirty=value;},
    available:value=>{available=value;}, ready:value=>{ready=value;},
    conversation:(id='c1')=>state.conversations.find(item=>item.id===id),
  };
  return api;
}

test('an explicit target stages the saved reference with existing context mutation, preserving composer, sent turns and queue', async()=>{
  const f=fixture(), before=clone(f.conversation('c2'));
  const menu=f.controller.describe();
  assert.equal(menu.source.id,'n1'); assert.equal(menu.targets.length,3); assert.equal(menu.busy,false);
  menu.source.title='External mutation'; menu.targets[0].projectId='changed';
  assert.equal(f.controller.describe().source.title,'Reading document');
  assert.equal(f.targets.get('existing:c1').projectId,'p');
  const result=await f.controller.prepare('existing:c2');
  assert.deepEqual(result,{status:'staged',conversationId:'c2',focused:true});
  const after=f.conversation('c2'), ref=after.draftFileReferences[0];
  assert.equal(ref.id,'n1');
  assert.equal(ref.version,(await FileContext.libraryRef(f.state,'note','n1')).version);
  assert.equal(after.draft,before.draft); assert.deepEqual(after.messages,before.messages);
  assert.deepEqual(after.queuedMessages,before.queuedMessages);
  assert.deepEqual(f.conversation('c1').draftFileReferences,[]);
  assert.equal(f.saveCalls,0);assert.equal(f.stageCalls,1);assert.equal(f.focusCalls,1);
  assert.deepEqual(f.changes,[true,false]);assert.equal(f.notifications.length,1);
});

test('missing target never silently chooses a conversation',async()=>{
  const f=fixture();
  assert.equal((await f.controller.prepare('missing')).status,'error');
  assert.equal(f.navCalls,0);assert.equal(f.stageCalls,0);assert.equal(f.focusCalls,0);
});

test('dirty reading content requires explicit save and does not change the composer or route',async()=>{
  const f=fixture();f.dirty(true);
  const before=clone(f.state), result=await f.controller.prepare('existing:c2');
  assert.equal(result.status,'error');assert.match(result.message,/保存|Save/);
  assert.deepEqual(f.state,before);assert.equal(f.saveCalls,0);assert.equal(f.navCalls,0);
});

test('explicit save acknowledges then re-reads and references the new saved version',async()=>{
  const f=fixture();f.dirty(true);
  const result=await f.controller.prepare('existing:c2',{save:true});
  assert.equal(result.status,'staged');assert.equal(f.saveCalls,1);
  assert.equal(f.state.notes[0].content,'Explicitly saved draft');
  assert.equal(f.conversation('c2').draftFileReferences[0].version,(await FileContext.libraryRef(f.state,'note','n1')).version);
});

test('switching document during a delayed save prevents navigation and staging',async()=>{
  const gate=deferred(), f=fixture({saveSource:()=>gate.promise});f.dirty(true);
  const pending=f.controller.prepare('existing:c2',{save:true});
  f.read('n2');f.dirty(false);gate.resolve(true);
  assert.equal((await pending).status,'cancelled');assert.equal(f.navCalls,0);assert.equal(f.stageCalls,0);
  assert.equal(f.focusCalls,0);assert.equal(f.state.notes[1].content,'Other saved body');
});

test('failed or unconfirmed source save does not navigate or select anything',async t=>{
  for(const outcome of ['false','throw'])await t.test(outcome,async()=>{
    const f=fixture({saveSource:()=>{if(outcome==='throw')throw Error('disk full');return false;}});f.dirty(true);
    const result=await f.controller.prepare('existing:c2',{save:true});
    assert.equal(result.status,'error');assert.equal(f.navCalls,0);assert.equal(f.selectCalls,0);
    assert.equal(f.stageCalls,0);assert.equal(f.conversation().draft,'Keep typed prompt c1');
  });
});

test('deleted target and changed conversation during save cannot steal navigation',async t=>{
  for(const change of ['target','conversation'])await t.test(change,async()=>{
    const gate=deferred(), f=fixture({saveSource:()=>gate.promise});f.dirty(true);
    const pending=f.controller.prepare('existing:c2',{save:true});
    f.dirty(false);
    if(change==='target')f.targets.delete('existing:c2');else f.current('c2');
    gate.resolve(true);
    assert.equal((await pending).status,'cancelled');assert.equal(f.navCalls,0);assert.equal(f.stageCalls,0);
  });
});

test('navigation must honor its guard and still return the currently selected target conversation',async()=>{
  const gate=deferred(), f=fixture({navigate:async(target,guard,api)=>{
    await gate.promise;
    assert.equal(guard.isCurrent(),false);
    return target.conversationId;
  }});
  const pending=f.controller.prepare('existing:c2');
  f.available(false);gate.resolve();
  assert.equal((await pending).status,'cancelled');assert.equal(f.selectCalls,0);
  assert.equal(f.currentId,'c1');assert.equal(f.focusCalls,0);
});

test('user navigation, deleted target, modified source, and lost access during selection block staging',async t=>{
  for(const change of ['conversation','target','source-version','access','ready'])await t.test(change,async()=>{
    const gate=deferred(),f=fixture({selectRef:()=>gate.promise});
    const pending=f.controller.prepare('existing:c2');await until(()=>f.selectCalls===1);
    if(change==='conversation')f.current('c1');
    if(change==='target')f.targets.delete('existing:c2');
    if(change==='source-version')f.state.notes[0].content='Later edit';
    if(change==='access')f.available(false);
    if(change==='ready')f.ready(false);
    gate.resolve({type:'note',id:'n1',version:'previous-saved-version'});
    assert.equal((await pending).status,'cancelled');assert.equal(f.stageCalls,0);assert.equal(f.focusCalls,0);
    assert.deepEqual(f.conversation('c2').draftFileReferences,[]);
  });
});

test('a changed target scope with the same menu key is not accepted',async()=>{
  const gate=deferred(),f=fixture({selectRef:()=>gate.promise});
  const pending=f.controller.prepare('existing:c2');await until(()=>f.selectCalls===1);
  f.targets.get('existing:c2').projectId='moved-project';
  gate.resolve({type:'note',id:'n1',version:'saved'});
  assert.equal((await pending).status,'cancelled');assert.equal(f.stageCalls,0);
});

test('selection failure, wrong source identity and missing saved version cannot stage a reference',async t=>{
  for(const mode of ['failed','wrong-identity','missing-version'])await t.test(mode,async()=>{
    const f=fixture({selectRef:async()=>{
      if(mode==='failed')throw Error('File unavailable');
      return mode==='wrong-identity'?{type:'note',id:'n2',version:'saved'}:{type:'note',id:'n1'};
    }});
    const before=clone(f.conversation('c2'));
    assert.equal((await f.controller.prepare('existing:c2')).status,'error');
    assert.equal(f.stageCalls,0);assert.equal(f.focusCalls,0);assert.deepEqual(f.conversation('c2'),before);
  });
});

test('actual context rollback on failed stage preserves concurrent draft, other references and queue changes',async()=>{
  const gate=deferred(),f=fixture({persist:()=>gate.promise});
  const pending=f.controller.prepare('existing:c2');await until(()=>f.stageCalls===1);
  const conversation=f.conversation('c2');
  conversation.draft='Typed while the reference was being saved';
  FileContext.stage(conversation,{type:'note',id:'n2',version:'another-saved-reference'});
  conversation.queuedMessages.push({id:'new-queued',text:'Keep this queue entry'});
  const queue=clone(conversation.queuedMessages);
  gate.reject(Error('disk full'));
  const result=await pending;
  assert.equal(result.status,'error');assert.match(result.message,/disk full/);
  assert.equal(conversation.draft,'Typed while the reference was being saved');
  assert.deepEqual(conversation.draftFileReferences,[{type:'note',id:'n2',version:'another-saved-reference'}]);
  assert.deepEqual(conversation.queuedMessages,queue);assert.equal(f.rollbacks,1);assert.equal(f.focusCalls,0);
});

test('busy prevents duplicate requests; cancellation aborts selection and does not clear a newer intent',async()=>{
  const firstGate=deferred(),secondGate=deferred();
  const f=fixture({selectRef:(_ref,_context,api)=>api.selectCalls===1?firstGate.promise:secondGate.promise});
  const first=f.controller.prepare('existing:c1');await until(()=>f.selectCalls===1);
  assert.deepEqual(await f.controller.prepare('existing:c1'),{status:'busy'});
  f.controller.cancel();assert.equal(f.selectionSignals[0].aborted,true);
  const second=f.controller.prepare('existing:c2');await until(()=>f.selectCalls===2);
  firstGate.resolve({type:'note',id:'n1',version:'first'});
  assert.equal((await first).status,'cancelled');assert.equal(f.controller.isBusy(),true);
  assert.equal(f.stageCalls,0);assert.equal(f.focusCalls,0);
  secondGate.resolve({type:'note',id:'n1',version:'second'});
  assert.equal((await second).status,'staged');assert.equal(f.stageCalls,1);
  assert.equal(f.conversation('c2').draftFileReferences[0].version,'second');
  assert.equal(f.controller.isBusy(),false);
});

test('a reference acknowledged after user navigation stays in its owner but does not steal focus',async()=>{
  const gate=deferred(),f=fixture({persist:()=>gate.promise});
  const pending=f.controller.prepare('existing:c2');await until(()=>f.stageCalls===1);
  f.current('c1');gate.resolve(true);
  const result=await pending;
  assert.equal(result.status,'cancelled');assert.equal(result.staged,true);assert.equal(result.conversationId,'c2');
  assert.equal(f.conversation('c2').draftFileReferences.length,1);assert.deepEqual(f.conversation('c1').draftFileReferences,[]);
  assert.equal(f.focusCalls,0);assert.equal(f.notifications.length,0);
});

test('a separate route focus veto does not turn an acknowledged reference into an error',async()=>{
  const f=fixture({canFocus:()=>false});
  assert.deepEqual(await f.controller.prepare('existing:c2'),{status:'staged',conversationId:'c2',focused:false});
  assert.equal(f.focusCalls,0);assert.equal(f.notifications.length,0);
});

test('explicit new-chat target stages in the created conversation without drafting or sending a message',async()=>{
  const f=fixture();
  const result=await f.controller.prepare('new:p');
  assert.equal(result.conversationId,'created-chat');assert.equal(result.status,'staged');
  const conversation=f.conversation('created-chat');
  assert.equal(conversation.projectId,'p');assert.equal(conversation.draft,'');assert.deepEqual(conversation.messages,[]);
  assert.equal(conversation.draftFileReferences[0].id,'n1');
  assert.equal(f.conversation().draft,'Keep typed prompt c1');
});
