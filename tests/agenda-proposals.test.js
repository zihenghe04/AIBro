const test=require('node:test'),assert=require('node:assert/strict'),A=require('../app/agenda-proposals.js');
const state={notes:[{id:'n',content:'下周二十点开会，提前十五分钟提醒。',updatedAt:12}]},run={id:'r',userMessageId:'m',captureNoteIds:['n']},value={title:'讨论',sourceNoteId:'n',quote:'下周二十点开会',start:'2026-09-22T10:00:00+08:00',end:'2026-09-22T11:00:00+08:00',timeZone:'Asia/Shanghai',frequency:'weekly',weekdays:[3],count:4,reminderMinutes:15};
test('agenda proposals are immutable reviewed snapshots with stable retry identity',()=>{const out=A.validate([value],state,run);assert.equal(out[0].status,'pending');assert.equal(out[0].sourceVersion,12);assert.equal(out[0].id,A.validate([value],state,{...run,id:'retry'})[0].id);assert.equal(out[0].documentID,'n');assert.equal(out[0].start,Date.parse(value.start));assert.equal(state.notes[0].updatedAt,12);});
test('agenda proposal scope, evidence, dates and recurrence are validated before persistence',()=>{for(const changed of [{quote:'并未出现的原话'},{sourceNoteId:'other'},{start:'2026-09-22 10:00'},{end:value.start},{timeZone:'invented'},{timeZone:'America/New_York'},{start:'2026-02-30T10:00:00+08:00'},{weekdays:[9]},{interval:0},{count:0},{reminderMinutes:-1},{until:'2020-01-01T00:00Z'}])assert.throws(()=>A.validate([{...value,...changed}],state,run));assert.throws(()=>A.validate([value],state,{...run,captureNoteIds:[]}));assert.throws(()=>A.validate([value],{notes:[{...state.notes[0],deletedAt:1}]},run));assert.throws(()=>A.validate(Array(13).fill(value),state,run));assert.deepEqual(A.validate(undefined,state,run),[]);});
test('direct chat can propose weekly events with reviewed default duration and stable identity',()=>{
 const quote='每周四下午两点半参加组会',message={id:'user',role:'user',text:quote},s={notes:[],conversations:[{id:'c',messages:[message]}]},r={userMessageId:'user',conversationId:'c'};
 const v={title:'组会',sourceMessageId:'user',quote,start:'2026-09-17T14:30:00+08:00',end:null,timeZone:'Asia/Shanghai',frequency:'weekly',weekdays:[5],location:'腾讯会议：123-4567-8901'};
 const p=A.validate([v],s,r)[0];assert.equal(p.frequency,'weekly');assert.deepEqual(p.weekdays,[5]);assert.equal(p.end-p.start,3600000);assert.equal(p.endEstimated,true);assert.equal(p.documentID,'');assert.equal(p.sourceMessageId,'user');assert.equal(p.reminderMinutes,null);assert.equal(v.end,null);
 for(const changed of [{sourceMessageId:'other'},{quote:'未提供的证据'},{start:'2026-09-17T14:30:00Z'}])assert.throws(()=>A.validate([{...v,...changed}],s,r));
 assert.throws(()=>A.validate([v],s,{...r,conversationId:'other'}));message.deletedAt=1;assert.throws(()=>A.validate([v],s,r));
});

function projectFixture(){
 const quote='明天下午三点，安排二十分钟校园观察，关联当前课程。';
 return {s:{notes:[],projects:[{id:'course',name:'交互设计方法',workspace:'课程'},{id:'other',name:'另一课程',workspace:'课程'}],conversations:[{id:'c',projectId:'course',messages:[{id:'u',role:'user',text:quote}]}]},r:{userMessageId:'u',conversationId:'c',projectId:'course',status:'completed'},v:{title:'校园观察',sourceMessageId:'u',quote,start:'2026-10-02T15:00:00+08:00',end:'2026-10-02T15:20:00+08:00',timeZone:'Asia/Shanghai'}};
}
test('message proposals carry actual inherited project identity rather than explanatory notes',()=>{
 const {s,r,v}=projectFixture(),p=A.validate([v],s,r)[0];assert.equal(p.projectID,'course');assert.equal(p.end-p.start,1200000);assert.equal(Object.hasOwn(v,'projectID'),false);
 assert.equal(A.validate([v],s,{...r,projectId:null})[0].projectID,'course');
});
test('explicit independent and other project choices survive scoped conversations',()=>{
 const {s,r,v}=projectFixture();for(const projectId of [null,''])assert.equal(A.validate([{...v,projectId}],s,r)[0].projectID,'');
 assert.equal(A.validate([{...v,projectId:'other'}],s,r)[0].projectID,'other');
 assert.equal(A.validate([{...v,courseId:'course'}],s,r)[0].projectID,'course');
 for(const changed of [{projectId:'missing'},{projectId:7},{projectId:' '},{projectId:'course',projectID:'other'}])assert.throws(()=>A.validate([{...v,...changed}],s,r));
});
test('unavailable or duplicate projects reject association and source notes cannot cross projects',()=>{
 const {s,r,v}=projectFixture();for(const changed of [{archived:true},{deletedAt:1},{private:true},{incognito:true}])assert.throws(()=>A.validate([v],{...s,projects:[{...s.projects[0],...changed},s.projects[1]]},r));
 assert.throws(()=>A.validate([v],{...s,projects:[...s.projects,{...s.projects[0]}]},r));
 const scoped={...state,projects:s.projects,notes:[{...state.notes[0],projectId:'course'}]};assert.equal(A.validate([value],scoped,run)[0].projectID,'course');
 for(const projectId of ['other',null])assert.throws(()=>A.validate([{...value,projectId}],scoped,run));
});
test('legacy pending snapshots resolve from their original source, with no current project guess',()=>{
 const {s,r,v}=projectFixture(),old={...A.validate([v],s,r)[0]};delete old.projectID;
 assert.equal(A.projectID(old,s,r),'course');assert.equal(Object.hasOwn(old,'projectID'),false);
 assert.equal(A.projectID({...old,projectID:''},s,r),'');
 assert.equal(A.projectID({...old,conversationId:'unbound'},{...s,conversations:[...s.conversations,{id:'unbound',messages:[]}]},{...r,projectId:null}),'');
});
test('review card displays real proposal ownership and sends normalized legacy project to native editor',async()=>{
 const {s,r,v}=projectFixture(),p=A.validate([v],s,r)[0];delete p.projectID;r.agendaProposals=[p];
 class Node{constructor(){this.children=[];this.dataset={};}append(...values){this.children.push(...values);}}
 const names=['document','state','saveDocumentDurably','toast','workstationDesktop'],before=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(global,k)])),sent=[],issues=[];
 const find=(n,cls)=>String(n.className||'').split(' ').includes(cls)?n:n.children.map(c=>find(c,cls)).find(Boolean);
 try{
  global.document={createElement:()=>new Node()};global.state=s;global.saveDocumentDurably=async()=>true;global.toast=x=>issues.push(x);global.workstationDesktop={agendaRelated:async()=>[],agendaProposal:async x=>sent.push(x)};
  const card=A.card(r);assert.match(find(card,'agenda-proposal-project').textContent,/交互设计方法/);await find(card,'agenda-proposal-review').onclick();assert.equal(sent[0].projectID,'course');assert.equal(Object.hasOwn(p,'projectID'),false);
  sent.length=0;global.saveDocumentDurably=async()=>{s.projects[0].archived=true;return true;};await find(card,'agenda-proposal-review').onclick();assert.equal(sent.length,0);assert.match(issues.at(-1),/项目.*不可用/);
 }finally{for(const k of names){const descriptor=before.get(k);if(descriptor)Object.defineProperty(global,k,descriptor);else delete global[k];}}
});
