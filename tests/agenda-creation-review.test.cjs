const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../app/agenda-proposals');
function fixture(mode='full'){
 const quote='创建讨论会，明天下午三点到四点。',chat={id:'c',workspace:'auto',permissionMode:mode,messages:[{id:'u',role:'user',text:quote}]};
 const run={id:'r',status:'completed',conversationId:'c',userMessageId:'u',contextWorkspace:'auto',executionReceipt:{phase:'committed'}};
 const s={conversations:[chat],agentRuns:[run],projects:[],notes:[],settings:{permissions:{日常:'auto'}}};
 const p=A.validate([{title:'讨论会',sourceMessageId:'u',quote,start:'2026-10-09T15:00:00+08:00',end:'2026-10-09T16:00:00+08:00',timeZone:'Asia/Shanghai'}],s,run);
 run.agendaProposals=p;return {s,run,chat,p};
}
function allowed(f,automatic=true){global.state=f.s;return A.authorizeCreation(f.run.id,f.p,automatic).status==='authorized';}
test.afterEach(()=>{for(const k of ['state','PrivateMode','workstationDesktop','saveDocumentDurably','save','renderConversation'])delete global[k];});
test('full, smart and explicit automatic space settings authorize definite creations; manual mode stays manual',()=>{
 for(const mode of ['full','smart','legacy'])assert.equal(allowed(fixture(mode)),true);
 const f=fixture('request');assert.equal(allowed(f),false);assert.equal(allowed(f,false),true);
 f.chat.permissionMode='legacy';f.s.settings.permissions.日常='approval';assert.equal(allowed(f),false);
 delete f.s.settings.permissions.日常;assert.equal(allowed(f),false);
});
test('estimated end, explicit review, uncommitted state and routing remain reviewable but never automatic',()=>{
 for(const mutate of [f=>f.p[0].endEstimated=true,f=>f.run.approvalIntent={human:true},f=>f.run.routingReview={required:true},f=>f.run.executionReceipt.phase='applied']){
  const f=fixture();mutate(f);assert.equal(allowed(f),false);assert.equal(allowed(f,false),true);
 }
});
test('stale sources, scopes, duplicates and private workspaces cannot commit',()=>{
 const mutations=[f=>f.chat.messages[0].text='changed',f=>f.chat.archived=true,f=>f.chat.messages[0].deletedAt=1,f=>f.chat.messages[0].intentSource='automatic',f=>f.chat.projectId='moved',f=>f.chat.workspace='课程',f=>f.run.status='cancelled',f=>f.p.push({...f.p[0]}),f=>f.s.agentRuns.push({...f.run}),f=>f.s.conversations.push({...f.chat})];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(allowed(f,false),false);}
 const f=fixture();global.PrivateMode={isOn:()=>true};assert.equal(allowed(f,false),false);
});
test('native verification rejects forged fields and revoked permission during durable saving',async()=>{
 const f=fixture();global.state=f.s;assert.equal(A.authorizeCreation('r',[{...f.p[0],title:'forged'}],false).status,'denied');
 global.saveDocumentDurably=async()=>{f.chat.permissionMode='request';return true;};
 let commits=0;global.workstationDesktop={agendaCreateBatch:async(p,id,auto)=>{if(A.authorizeCreation(id,p,auto).status!=='authorized')throw Error('permission changed');commits++;return {status:'committed',persisted:true};}};
 await assert.rejects(A.reviewCreations(f.run,f.p,true),/permission changed|权限已变化/);assert.equal(commits,0);
});
test('automatic save does not open a review, duplicate invocations coalesce, failed saves stay retryable',async()=>{
 const f=fixture();global.state=f.s;global.saveDocumentDurably=async()=>true;
 let calls=0,release;global.workstationDesktop={agendaCreateBatch:async(p,id,auto)=>{calls++;assert.equal(auto,true);await new Promise(r=>release=r);return {status:'committed',persisted:true};}};
 const first=A.autoCreate(f.run);await new Promise(r=>setImmediate(r));await A.autoCreate(f.run);assert.equal(calls,1);release();await first;assert.equal(f.run.agendaAutoSaved,true);
 delete f.run.agendaAutoSaved;global.workstationDesktop.agendaCreateBatch=async()=>{throw Error('disk failure')};await A.autoCreate(f.run);assert.equal(f.run.agendaAutoSaved,undefined);assert.equal(f.run.agendaSaveError,'disk failure');
});
test('saved event cards use native title after editing, without mutating the original proposal',async()=>{
 const f=fixture();global.state=f.s;
 class Node{constructor(){this.children=[];this.dataset={};}append(...values){this.children.push(...values);}setAttribute(){}}
 global.document={createElement:()=>new Node()};
 global.workstationDesktop={agendaRelated:async()=>[{id:f.p[0].id,title:'已校对的日程',start:f.p[0].start+3600000}],agendaCreateBatch:async()=>{}};
 try{await A.refresh();const card=A.card(f.run),walk=n=>[n,...n.children.flatMap(walk)];assert.equal(walk(card).find(n=>n.className==='agenda-proposal-name').textContent,'已校对的日程');assert.equal(f.p[0].title,'讨论会');}finally{delete global.document;}
});

function repeatedFixture(){
 const f=fixture(),q={...f.p[0],id:'agenda_prior_0',sourceMessageId:'prior'};
 f.s.agentRuns.unshift({id:'prior-run',conversationId:'c',status:'completed',agendaProposals:[q]});
 const event={...q,kind:'event',allDay:false,deleted:false,details:'\n\n来源消息：'+q.quote};
 return {...f,q,event};
}
test('repeated follow-up recognizes a native saved event and opens its original identity',async()=>{
 const f=repeatedFixture();f.p[0].details='同一场讨论会的另一种概括';global.state=f.s;let opened;
 class Node{constructor(){this.children=[];this.dataset={};}append(...values){this.children.push(...values);}setAttribute(){}}
 global.document={createElement:()=>new Node()};
 global.workstationDesktop={agendaRelated:async()=>[f.event],agendaProposal:async()=>{},agendaOpen:async id=>opened=id};
 try{await A.refresh();assert.equal(A.hasPending(f.run),false);const walk=n=>[n,...n.children.flatMap(walk)],nodes=walk(A.card(f.run));assert.equal(nodes.find(n=>String(n.className||'').split(' ').includes('agenda-proposal-review')).textContent,'打开已保存日程');await nodes.find(n=>String(n.className||'').split(' ').includes('agenda-proposal-review')).onclick();assert.equal(opened,f.q.id);}finally{delete global.document;}
});
test('batch confirmation omits exact duplicates from earlier messages, without rewriting the source proposals',async()=>{
 const f=repeatedFixture(),newProposal={...f.p[0],id:'agenda_u_1',title:'另一场讨论会'};f.p.push(newProposal);global.state=f.s;global.saveDocumentDurably=async()=>true;
 let sent;global.workstationDesktop={agendaRelated:async()=>[f.event],agendaCreateBatch:async p=>{sent=p;return {status:'pending_review'};}};
 await A.reviewCreations(f.run,f.p);assert.deepEqual(sent,[newProposal]);assert.equal(f.p[0].id,'agenda_u_0');
});
test('changed native events, different conversations and cancellations never suppress a new proposal',async()=>{
 const changes=[f=>f.event.title='人工修改',f=>f.event.end+=60000,f=>f.event.projectID='other',f=>f.event.frequency='weekly',f=>f.event.reminderMinutes=10,f=>f.event.details+='manual edit',f=>f.event.deleted=true,f=>f.s.agentRuns[0].conversationId='other',f=>f.p[0].location='另一地点'];
 for(const change of changes){const f=repeatedFixture();change(f);global.state=f.s;global.workstationDesktop={agendaRelated:async()=>[f.event]};await A.refresh();assert.equal(A.hasPending(f.run),true);}
});
