const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function fixture(){
 const posted=[],calls=[]; const classes=new Set(),listeners=new Map();
 const state={projects:[{id:'p',name:'Travel',workspace:'日常'}],conversations:[],tasks:[{id:'t',title:'Plan',projectId:'p',status:'todo',dueAt:'2026-09-20T12:00:00Z'},{id:'gone',deletedAt:1}],notes:[{id:'n',title:'Note',projectId:'p'}],imports:[],ui:{}};
 const env={state,storageHydrated:true,sendMessage:{busy:false},setInterval(){},document:{hidden:false,addEventListener:(name,handler)=>listeners.set(name,handler),body:{dataset:{view:'daily'},classList:{add:x=>classes.add(x),contains:x=>classes.has(x),toggle:(x,force)=>{const add=force===undefined?!classes.has(x):!!force;add?classes.add(x):classes.delete(x);return add;}}},querySelector:()=>null,getElementById:()=>({click(){calls.push('reader')}})},window:{webkit:{messageHandlers:{workspace:{postMessage:x=>posted.push(x)}}}},openTask:id=>calls.push(id),openNote:id=>calls.push(id),openImport:id=>calls.push(id),openProject:id=>calls.push(id),PlanningWorkbench:{createTask:x=>calls.push(x.workspace)}};
 vm.runInNewContext(fs.readFileSync('native/Resources/bridge.js','utf8'),env);return{env,state,posted,calls,classes,listeners,run:x=>env.window.NativeShell.perform(x)};
}
test('native snapshot uses persisted ownership and dates; omits deleted records',()=>{const f=fixture(),s=f.posted[0];assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].workspace,'日常');assert.equal(s.tasks[0].due,Date.parse('2026-09-20T12:00:00Z'));assert.equal(s.documents[0].kind,'note');assert.equal(s.taskCount,1);});
test('native content commands reject missing, archived and unknown targets',()=>{const f=fixture();assert.equal(f.run({type:'task',id:'gone'}),false);assert.equal(f.run({type:'note',id:'missing'}),false);assert.equal(f.run({type:'evil',id:'t'}),false);f.state.projects[0].archivedAt=1;assert.equal(f.run({type:'project',id:'p'}),false);assert.equal(f.calls.length,0);assert.equal(f.run({type:'task',id:'t'}),true);assert.deepEqual(f.calls,['t']);});
test('task creation accepts only valid spaces and reader can reopen',()=>{const f=fixture();assert.equal(f.run({type:'create-task',id:'unknown'}),false);assert.equal(f.run({type:'create-task',id:'课程'}),true);assert.equal(f.run({type:'reader'}),true);assert.deepEqual(f.calls,['课程','reader']);});
test('project task creation binds the exact project and rejects stale destinations',()=>{const f=fixture();let received;f.env.PlanningWorkbench.createTask=x=>{received=x};assert.equal(f.run({type:'create-project-task',id:'p'}),true);assert.equal(received.projectId,'p');assert.equal(received.workspace,'日常');f.state.projects[0].deletedAt=1;received=null;assert.equal(f.run({type:'create-project-task',id:'p'}),false);assert.equal(received,null);});
test('new project conversation binds persisted owner and rejects archived project',()=>{const f=fixture();f.env.newConversation=(workspace,projectId)=>f.calls.push({workspace,projectId});assert.equal(f.run({type:'new-project-conversation',id:'p'}),true);assert.deepEqual(f.calls,[{workspace:'日常',projectId:'p'}]);f.state.projects[0].archived=true;assert.equal(f.run({type:'new-project-conversation',id:'p'}),false);assert.equal(f.calls.length,1);});
test('conversation snapshots retain project IDs independently of folders',()=>{const f=fixture();f.state.conversations.push({id:'chat',title:'Discussion',projectId:'p',folderId:'f',updatedAt:42});f.run({type:'reader'});const row=f.posted.at(-1).conversationLibrary[0];assert.equal(row.projectId,'p');assert.equal(row.folderId,'f');assert.equal(row.updatedAt,42);});

test('background WebView rendering follows actual visibility changes',()=>{const f=fixture();assert.equal(f.classes.has('native-background-render'),false);f.env.document.hidden=true;f.listeners.get('visibilitychange')();assert.equal(f.classes.has('native-background-render'),true);f.env.document.hidden=false;f.listeners.get('visibilitychange')();assert.equal(f.classes.has('native-background-render'),false);});

test('overview snapshot carries priority and updates dependency readiness without changing tasks',()=>{
 const f=fixture(),task=f.state.tasks[0];task.priority='high';task.dependsOn=['before'];
 const before={id:'before',projectId:task.projectId,status:'todo'};f.state.tasks.push(before);
 f.run({type:'reader'});let current=f.posted.at(-1).tasks.find(t=>t.id===task.id);
 assert.equal(current.priority,'high');assert.equal(current.waitingOnDependencies,true);
 before.status='done';f.run({type:'reader'});current=f.posted.at(-1).tasks.find(t=>t.id===task.id);
 assert.equal(current.waitingOnDependencies,false);assert.equal(task.status,'todo');
 before.deletedAt=1;f.run({type:'reader'});assert.equal(f.posted.at(-1).tasks[0].waitingOnDependencies,true);
});
