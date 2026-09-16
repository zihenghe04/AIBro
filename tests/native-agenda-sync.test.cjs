const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('native/Resources/agenda-sync.js','utf8');
const note=(id,title='原日程')=>({id,kind:'日程',title,content:JSON.stringify({format:'aibro.agenda.v1',title,start:1,end:2})});
function setup(){
 let saves=0,flushes=0;
 const c={window:{flushWorkspace:async()=>{flushes++}},storageHydrated:true,serverConflict:false,serverSaveInFlight:false,serverSaveQueued:false,sendMessage:{busy:false},purgeTrash:{syncPaused:false},state:{notes:[note('a')]},saveDocumentDurably:async()=>{saves++},save(){},renderAll(){}};
 vm.createContext(c);vm.runInContext(code,c);return {c,api:c.window.NativeAgendaSync,saves:()=>saves,flushes:()=>flushes};
}
test('agenda bridge read is read-only; exact CAS changes save durably',async()=>{
 const {c,api,saves,flushes}=setup();const read=JSON.parse(await api.read());
 assert.equal(flushes(),0);assert.equal(saves(),0);
 const result=await api.write([{id:'a',expected:read.a,note:JSON.stringify(note('a','手机日程'))}]);
 assert.equal(result[0],'a');assert.equal(saves(),1);assert.equal(c.state.notes[0].title,'手机日程');
});
test('stale baseline and invalid batch cannot partially modify native workspace notes',async()=>{
 const {c,api,saves}=setup();const read=JSON.parse(await api.read());c.state.notes[0].title='人编辑中';
 await assert.rejects(api.write([{id:'a',expected:read.a,note:JSON.stringify(note('a','覆盖'))}]),/更新/);assert.equal(saves(),0);
 await assert.rejects(api.write([{id:'new',expected:null,note:JSON.stringify(note('new'))},{id:'bad id',expected:null,note:JSON.stringify(note('bad id'))}]));
 assert.equal(c.state.notes.length,1);assert.equal(c.state.notes[0].title,'人编辑中');
});
test('failed durable save rolls back only its own note objects, preserving concurrent human edits',async()=>{
 const {c,api}=setup();const read=JSON.parse(await api.read());
 c.saveDocumentDurably=async()=>{throw Error('disk full')};
 await assert.rejects(api.write([{id:'a',expected:read.a,note:JSON.stringify(note('a','change'))}]),/disk full/);
 assert.equal(c.state.notes[0].title,'原日程');
 c.saveDocumentDurably=async()=>{c.state.notes[0]=note('a','newer human');throw Error('offline')};
 await assert.rejects(api.write([{id:'a',expected:read.a,note:JSON.stringify(note('a','change'))}]),/offline/);
 assert.equal(c.state.notes[0].title,'newer human');
});
