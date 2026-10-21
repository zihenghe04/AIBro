// Contract/lifecycle tests use a mock native bridge. They do not prove WKWebView
// navigation, screenshot fidelity, permissions, or real interaction delivery.
const {test}=require('node:test'),assert=require('node:assert/strict');
const B=require('../app/browser-tools.js');
function fixture(request){
 const original=global.workstationDesktop,originalDocument=global.document;
 const run={id:'run',conversationId:'chat',projectId:'project',status:'running'};
 const state={agentRuns:[run],projects:[{id:'project'}],conversations:[{id:'chat',projectId:'project'}]};
 const calls=[],saves=[],notices=[];
 global.workstationDesktop={browser:{request:async data=>{calls.push(data);return request(data);}}};
 const save=()=>saves.push(JSON.stringify(state));B.init({getState:()=>state,getCurrentConversation:()=>state.conversations[0],save,render(){},toast:value=>notices.push(value)});
 return {run,state,calls,saves,notices,execute:(req,options={})=>B.execute(req,state,run,{save,refresh(){},...options}),restore(){B.init({});global.workstationDesktop=original;global.document=originalDocument;}};
}
const session=(overrides={})=>({sessionId:'session',tabId:'tab',status:'ready',url:'https://example.com/',title:'Example',...overrides});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('browser lifecycle binds trusted ownership, expires refs after actions and keeps page/screenshot data ephemeral',async()=>{
 const h=fixture(async data=>{
  if(data.action==='snapshot')return session({snapshotId:'snapshot-1',text:'UNTRUSTED <script>page()</script>',elements:[{ref:'field-1',role:'textbox',name:'Query'}],...(data.screenshot?{imageDataUrl:'data:image/jpeg;base64,YWN0dWFsLW5hdGl2ZS1pbWFnZQ=='}:{})});
  if(data.action==='type')return session({snapshotId:'native-old-ref',text:'Typed confirmed'});
  return session();
 });
 try{
  await h.execute({type:'browser_open',url:'https://example.com',runId:'attacker',projectId:'other',conversationId:'other',operationId:'spoof',javascript:'alert(1)'});
  const open=h.calls[0];assert.equal(open.runId,'run');assert.equal(open.conversationId,'chat');assert.equal(open.projectId,'project');assert.notEqual(open.operationId,'spoof');assert.equal(open.javascript,undefined);
  const read=await h.execute({type:'browser_snapshot'});assert.equal(read.text,'UNTRUSTED <script>page()</script>');assert.equal(read.browserContentIsUntrusted,true);
  await h.execute({type:'browser_type',snapshotId:'snapshot-1',ref:'field-1',text:'private user text'});
  assert.equal(h.calls.at(-1).text,'private user text');assert.equal(h.run.browserSession.snapshotId,undefined);
  await assert.rejects(h.execute({type:'browser_click',snapshotId:'snapshot-1',ref:'field-1'}),{code:'STALE_SNAPSHOT'});
  const image=await h.execute({type:'browser_screenshot'});assert.equal(h.calls.at(-1).action,'snapshot');assert.equal(h.calls.at(-1).screenshot,true);
  assert.equal(image.imageDataUrl,undefined);assert.equal(image.blocks[0].type,'input_text');assert.equal(JSON.parse(image.blocks[0].text).snapshotId,'snapshot-1');assert.equal(image.blocks[1].type,'input_image');assert.match(image.blocks[1].image_url,/^data:image\/jpeg/);
  assert(h.saves.every(saved=>!['UNTRUSTED','private user text','imageDataUrl','base64,','field-1'].some(value=>saved.includes(value))));
  assert.equal(h.run.browserSession.history.length,4);
 }finally{h.restore();}
});

test('stopping an unresolved first navigation immediately cancels by trusted run identity without awaiting native delivery',async()=>{
 const pending=deferred(),controller=new AbortController();const h=fixture(data=>data.action==='cancel'?session({status:'cancelled'}):pending.promise);
 try{
  const result=h.execute({type:'browser_open',url:'https://example.com'},{signal:controller.signal});await tick();controller.abort();
  await assert.rejects(result,{code:'CANCELLED'});
  const cancellation=h.calls.find(c=>c.action==='cancel');assert.equal(cancellation.runId,'run');assert.equal(cancellation.sessionId,undefined);assert.equal(cancellation.operationId,h.calls[0].operationId);
  assert.equal(h.run.browserSession.status,'cancelled');pending.resolve(session({text:'late result'}));await tick();assert.equal(h.run.browserSession.status,'cancelled');
 }finally{h.restore();}
});

test('handoff waits for actual native resume and user stop does not depend on a resolving handoff promise',async()=>{
 const pending=deferred(),controller=new AbortController();const h=fixture(data=>data.action==='takeover'?pending.promise:session());
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});
  let settled=false;const result=h.execute({type:'browser_handoff'},{signal:controller.signal}).finally(()=>{settled=true;});await tick();
  assert.equal(settled,false);assert.equal(h.run.browserSession.status,'paused');assert.equal(h.calls.at(-1).waitForResume,true);
  controller.abort();await assert.rejects(result,{code:'CANCELLED'});assert.equal(h.calls.at(-1).action,'cancel');assert.equal(h.calls.at(-1).sessionId,'session');
  pending.resolve(session());await tick();assert.equal(h.run.browserSession.status,'cancelled');
 }finally{h.restore();}
});

test('handoff completion invalidates old refs and ready reflects the real resume result',async()=>{
 const pending=deferred();const h=fixture(data=>data.action==='takeover'?pending.promise:session({snapshotId:'before-handoff'}));
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_snapshot'});
  const result=h.execute({type:'browser_handoff'});await tick();pending.resolve(session({title:'Changed by user'}));
  const output=await result;assert.equal(output.title,'Changed by user');assert.equal(h.run.browserSession.status,'ready');assert.equal(h.run.browserSession.snapshotId,undefined);
  await assert.rejects(h.execute({type:'browser_type',snapshotId:'before-handoff',ref:'input',text:'value'}),{code:'STALE_SNAPSHOT'});
 }finally{h.restore();}
});

test('late results cannot publish after the owning conversation moves project',async()=>{
 const pending=deferred();const h=fixture(data=>data.action==='snapshot'?pending.promise:session());
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});const result=h.execute({type:'browser_snapshot'});await tick();
  const saved=h.saves.length;h.state.conversations[0].projectId='different-project';pending.resolve(session({snapshotId:'late',title:'must not publish'}));
  await assert.rejects(result,{code:'CANCELLED'});assert.equal(h.saves.length,saved);assert.notEqual(h.run.browserSession.title,'must not publish');assert.equal(h.calls.at(-1).action,'cancel');assert.equal(h.calls.at(-1).projectId,'project');
 }finally{h.restore();}
});

test('foreign session IDs, unsafe URLs and unsupported browser scripts fail before native dispatch',async()=>{
 const h=fixture(()=>session());
 try{
  for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:secret@example.com'])await assert.rejects(h.execute({type:'browser_open',url}));
  assert.equal(h.calls.length,0);await h.execute({type:'browser_open',url:'https://example.com'});const n=h.calls.length;
  await assert.rejects(h.execute({type:'browser_snapshot',sessionId:'foreign'}));await assert.rejects(h.execute({type:'browser_snapshot',tabId:'foreign'}));await assert.rejects(h.execute({type:'browser_execute_js',code:'document.cookie'}));
  assert.equal(h.calls.length,n);
  h.run.browserSession.runId='foreign';await assert.rejects(h.execute({type:'browser_snapshot'}),{code:'CANCELLED'});assert.equal(h.calls.length,n);
 }finally{h.restore();}
});

test('scroll uses bounded CSS offsets against a fresh snapshot; screenshot coordinates cannot substitute for a DOM ref',async()=>{
 const h=fixture(()=>session({snapshotId:'snapshot'}));
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_snapshot'});const n=h.calls.length;
  await assert.rejects(h.execute({type:'browser_click',snapshotId:'snapshot',x:20,y:30}),/ref/);
  await assert.rejects(h.execute({type:'browser_scroll',snapshotId:'snapshot',y:Infinity}));await assert.rejects(h.execute({type:'browser_scroll',snapshotId:'snapshot',y:4001}));assert.equal(h.calls.length,n);
  await h.execute({type:'browser_scroll',snapshotId:'snapshot',y:600});assert.equal(h.calls.at(-1).action,'scroll');assert.equal(h.calls.at(-1).y,600);assert.equal(h.calls.at(-1).x,0);
  await assert.rejects(h.execute({type:'browser_scroll',snapshotId:'snapshot',y:600}),{code:'STALE_SNAPSHOT'});
 }finally{h.restore();}
});

test('closing and reopening obtains a new owned session, native errors are actual failures',async()=>{
 let count=0;const h=fixture(data=>data.action==='open'?session({sessionId:++count===1?'session':'new-session',tabId:count===1?'tab':'new-tab'}):data.action==='close'?session({status:'closed'}):{status:'failed',error:'User denied navigation',code:'DENIED'});
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_close'});assert.equal(h.run.browserSession.status,'closed');
  await h.execute({type:'browser_open',url:'https://example.com/new'});assert.equal(h.run.browserSession.sessionId,'new-session');assert.equal(h.calls.at(-1).sessionId,undefined);
  await assert.rejects(h.execute({type:'browser_snapshot'}),{message:'User denied navigation',code:'DENIED'});assert.equal(h.run.browserSession.status,'failed');
 }finally{h.restore();}
});

class Element{
 constructor(tag){this.tagName=tag;this.childNodes=[];this.dataset={};this.attributes={};this.textContent='';}
 append(...nodes){this.childNodes.push(...nodes);}setAttribute(key,value){this.attributes[key]=value;}
 querySelectorAll(tag){return this.childNodes.flatMap(node=>[...(node.tagName===tag?[node]:[]),...node.querySelectorAll(tag)]);}
 set innerHTML(_){throw Error('Untrusted content must never be inserted as HTML');}
}
test('browser card escapes page/user strings and trusted takeover/resume/stop controls reach native',async()=>{
 const pending=deferred();const h=fixture(data=>data.action==='type'?pending.promise:session({status:data.action==='takeover'?'paused':'ready',snapshotId:'snapshot',title:'<img src=x onerror=alert(1)>'}));
 global.document={createElement:tag=>new Element(tag)};
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_snapshot'});
  const work=h.execute({type:'browser_type',snapshotId:'snapshot',ref:'field',text:'<script>private()</script>'});await tick();
  const card=B.card(h.run);const text=JSON.stringify(card);assert.match(text,/<script>private\(\)<\/script>/);assert.match(text,/<img src=x/);
  const takeover=card.querySelectorAll('button').find(b=>b.dataset.browserAction==='takeover');await takeover.onclick();assert.equal(h.calls.at(-1).action,'takeover');assert.equal(h.calls.at(-1).waitForResume,false);assert.equal(h.run.browserSession.status,'paused');
  const resume=B.card(h.run).querySelectorAll('button').find(b=>b.dataset.browserAction==='resume');await resume.onclick();assert.equal(h.calls.at(-1).action,'resume');
  const stop=B.card(h.run).querySelectorAll('button').find(b=>b.dataset.browserAction==='cancel');await stop.onclick();await assert.rejects(work,{code:'CANCELLED'});assert.equal(h.calls.at(-1).action,'cancel');
  pending.resolve(session());await tick();assert(h.saves.every(saved=>!saved.includes('private()')));
 }finally{h.restore();}
});

test('the completion refresh removes the live operation and renders Close instead of a stale Stop control',async()=>{
 const h=fixture(()=>session({snapshotId:'snapshot'}));global.document={createElement:tag=>new Element(tag)};
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_snapshot'});
  const renders=[];await h.execute({type:'browser_type',snapshotId:'snapshot',ref:'field',text:'ephemeral typing'},{refresh(){const card=B.card(h.run);renders.push({text:JSON.stringify(card),actions:card.querySelectorAll('button').map(b=>b.dataset.browserAction)});}});
  assert(renders[0].actions.includes('cancel'));assert(renders[0].text.includes('ephemeral typing'));
  assert(renders.at(-1).actions.includes('close'));assert(!renders.at(-1).actions.includes('cancel'));assert(!renders.at(-1).text.includes('ephemeral typing'));
 }finally{h.restore();}
});

test('native takeover preserves Resume and the next observation waits for actual user resume',async()=>{
 const resumed=deferred();let paused=false,reads=0;
 const h=fixture(data=>{
  if(data.action==='snapshot'){reads++;return paused?{status:'failed',code:'HUMAN_TAKEOVER',error:'User is controlling this page'}:session({snapshotId:'after-resume'});}
  if(data.action==='takeover'&&data.waitForResume)return resumed.promise;
  if(data.action==='resume'){paused=false;resumed.resolve(session());return session();}
  return session();
 });global.document={createElement:tag=>new Element(tag)};
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});paused=true;
  await assert.rejects(h.execute({type:'browser_snapshot'}),{code:'HUMAN_TAKEOVER'});
  assert.equal(h.run.browserSession.status,'paused');assert(B.card(h.run).querySelectorAll('button').some(b=>b.dataset.browserAction==='resume'));
  let settled=false;const observing=h.execute({type:'browser_snapshot'}).finally(()=>{settled=true;});await tick();
  assert.equal(settled,false);assert.equal(reads,1);assert.equal(h.run.browserSession.status,'paused');
  await B.card(h.run).querySelectorAll('button').find(b=>b.dataset.browserAction==='resume').onclick();
  assert.equal((await observing).snapshotId,'after-resume');assert.equal(reads,2);assert.equal(h.run.browserSession.status,'ready');
 }finally{h.restore();}
});

test('taking over a pending native approval keeps the paused state when that approval is rejected',async()=>{
 const pending=deferred();let paused=false;
 const h=fixture(data=>{
  if(data.action==='type')return pending.promise;
  if(data.action==='takeover'){paused=true;pending.resolve({status:'failed',code:'DENIED',error:'Approval cancelled for takeover'});}
  return session({status:paused?'paused':'ready',snapshotId:'snapshot'});
 });global.document={createElement:tag=>new Element(tag)};
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await h.execute({type:'browser_snapshot'});
  const typing=h.execute({type:'browser_type',snapshotId:'snapshot',ref:'field',text:'proposed text'});await tick();
  await B.card(h.run).querySelectorAll('button').find(b=>b.dataset.browserAction==='takeover').onclick();
  await assert.rejects(typing,{code:'DENIED'});assert.equal(h.run.browserSession.status,'paused');assert(B.card(h.run).querySelectorAll('button').some(b=>b.dataset.browserAction==='resume'));
 }finally{h.restore();}
});

test('closing a native tab externally invalidates persisted session IDs and allows an explicit fresh open',async()=>{
 let opens=0;const h=fixture(data=>data.action==='open'?session({sessionId:`session-${++opens}`,tabId:`tab-${opens}`}):{status:'failed',code:'UNKNOWN_TAB',error:'Native tab no longer exists'});
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});await assert.rejects(h.execute({type:'browser_snapshot'}),{code:'UNKNOWN_TAB'});
  assert.equal(h.run.browserSession.status,'closed');assert.equal(h.run.browserSession.sessionId,undefined);assert.equal(h.run.browserSession.tabId,undefined);
  await h.execute({type:'browser_open',url:'https://example.com/new'});assert.equal(h.calls.at(-1).action,'open');assert.equal(h.calls.at(-1).tabId,undefined);assert.equal(h.run.browserSession.sessionId,'session-2');
 }finally{h.restore();}
});

test('missing bridge is reported truthfully and manual open uses host conversation identity',async()=>{
 const h=fixture(()=>session());
 try{
  assert.equal(B.available(),true);assert.match(B.instructions(),/browser_snapshot/);await B.open('http://127.0.0.1:18940');assert.equal(h.calls[0].runId,'manual');assert.equal(h.calls[0].conversationId,'chat');
  global.workstationDesktop={};assert.equal(B.available(),false);assert.match(B.instructions(),/not connected/);await assert.rejects(h.execute({type:'browser_open',url:'https://example.com'}));
 }finally{h.restore();}
});

test('browser operation budget counts native operations once and blocks only further browser requests',async()=>{
 const h=fixture(()=>session({snapshotId:'snapshot'}));
 try{
  await h.execute({type:'browser_open',url:'https://example.com'});assert.equal(h.run.browserSession.operationCount,1);
  for(let n=1;n<80;n++)await h.execute({type:'browser_snapshot'});
  assert.equal(h.calls.length,80);assert.equal(h.run.browserSession.operationCount,80);assert.equal(h.run.browserSession.history.length,40);
  await assert.rejects(h.execute({type:'browser_snapshot'}),{code:'BROWSER_LIMIT'});assert.equal(h.calls.length,80);assert.equal(h.run.status,'running');
 }finally{h.restore();}
});


test('manual browser entry brings the existing tab forward and recovers a closed native tab',async()=>{
 let closed=false,count=0;const h=fixture(data=>data.tabId&&closed?{code:'UNKNOWN_TAB',error:'Closed'}:session({sessionId:data.sessionId||`manual-session-${++count}`,tabId:data.tabId||`manual-tab-${count}`}));
 try{
  const first=await B.open();await B.open();assert.equal(h.calls[1].tabId,first.tabId);assert.equal(count,1);
  closed=true;await B.open();assert.equal(h.calls[2].tabId,first.tabId);assert.equal(h.calls[3].tabId,undefined);assert.equal(count,2);
 }finally{h.restore();}
});

test('browser policy comes from the host run: default, smart and full browse automatically; request mode asks',async()=>{
 const h=fixture(()=>session({snapshotId:'policy-snapshot'}));
 try{
  for(const mode of [undefined,'legacy','smart','full','request']){
   h.run.permissionMode=mode;
   await h.execute({type:'browser_open',url:'https://example.com',browserPermission:mode==='request'?'auto':'ask'});
   assert.equal(h.calls.at(-1).browserPermission,mode==='request'?'ask':'auto');
  }
  h.run.permissionMode='request';await h.execute({type:'browser_snapshot',browserPermission:'auto'});
  await h.execute({type:'browser_type',snapshotId:'policy-snapshot',ref:'field',text:'query',browserPermission:'auto'});
  assert.equal(h.calls.at(-1).browserPermission,'ask');
  assert.match(B.instructions(),/automatic by default/);
 }finally{h.restore();}
});

test('manual browser policy uses the current conversation and never copies model or persisted session policy',async()=>{
 const h=fixture(()=>session());
 try{
  h.state.conversations[0].id='manual-policy';h.state.conversations[0].permissionMode='request';
  await B.open('https://example.com');assert.equal(h.calls.at(-1).browserPermission,'ask');
  h.state.conversations[0].permissionMode='smart';await B.open();assert.equal(h.calls.at(-1).browserPermission,'auto');
 }finally{h.restore();}
});

test('a later run in the same conversation continues the page an earlier run left open',async()=>{
 const h=fixture(async data=>session({snapshotId:'snapshot-2',text:'signed in',elements:[]}));
 try{
  h.run.browserSession={runId:'run-1',conversationId:'chat',projectId:'project',browserOwner:'conversation:chat:project',sessionId:'session',tabId:'tab',status:'ready',url:'https://example.com/',title:'Example',history:[]};
  const earlier={id:'run-1',conversationId:'chat',projectId:'project',browserSession:h.run.browserSession};
  h.run.browserSession=undefined;h.state.agentRuns.unshift(earlier);
  const result=await h.execute({type:'browser_snapshot'});
  assert.equal(result.text,'signed in');
  assert.equal(h.calls[0].sessionId,'session');assert.equal(h.calls[0].tabId,'tab');
  assert.equal(h.calls[0].runId,'run');assert.equal(h.calls[0].browserOwner,'conversation:chat:project');
  assert.equal(h.run.browserSession.sessionId,'session');
  // A closed earlier session is not adopted: the new run must open its own page.
  const fresh=fixture(async()=>session());
  fresh.state.agentRuns.unshift({id:'run-0',conversationId:'chat',projectId:'project',browserSession:{runId:'run-0',browserOwner:'conversation:chat:project',status:'closed',conversationId:'chat',projectId:'project'}});
  await assert.rejects(fresh.execute({type:'browser_snapshot'}),/browser_open/);fresh.restore();
 }finally{h.restore();}
});
