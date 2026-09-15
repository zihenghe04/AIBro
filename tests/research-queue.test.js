const test=require('node:test'),assert=require('node:assert/strict'),Q=require('../app/research-queue');
const fixture=()=>({projects:[{id:'p',workspace:'科研'},{id:'q',workspace:'科研'}],imports:Array.from({length:101},(_,i)=>({id:'s'+i,projectId:i<97?'p':'q',workspace:'科研'})),conversations:[],agentRuns:[],notes:[]});
test('hundreds of sources form persisted bounded batches without crossing projects',()=>{const s=fixture(),q=Q.create(s,s.imports.map(n=>n.id),'batch',1);assert.equal(q.researchQueue.items.length,14);assert.equal(q.researchQueue.items.flatMap(i=>i.ids).length,101);assert(q.researchQueue.items.every(i=>i.ids.length<=8));q.researchQueue.items.forEach(i=>Q.validate(s,i));assert.equal(q.researchQueue.status,'paused');const roundtrip=JSON.parse(JSON.stringify(q));assert.deepEqual(roundtrip,q);s.imports[0].projectId='q';assert.throws(()=>Q.validate(s,q.researchQueue.items[0]));});
test('restart pauses unfinished batch and does not count a text-only reply as analysis',()=>{const s=fixture(),c=Q.create(s,['s0'],'batch');s.conversations.push(c);c.researchQueue.status='active';c.researchQueue.instance='old';c.researchQueue.items[0].status='running';s.agentRuns.push({id:'r',conversationId:'batch_0',status:'completed'});assert.equal(Q.reconcile(s,'new'),true);assert.equal(c.researchQueue.status,'paused');assert.equal(c.researchQueue.items[0].status,'attention');assert.equal(Q.reconcile(s,'new'),false);});
test('draft output is distinct from completed analysis and missing output prevents completion',()=>{const s=fixture(),i={projectId:'p',ids:['s0','s1']};s.notes.push({id:'n',projectId:'p',aiDraft:{content:'Findings',sourceAttachmentIds:['s0']}});assert.equal(Q.outcome(s,i),'attention');s.notes[0].aiDraft.sourceAttachmentIds.push('s1');assert.equal(Q.outcome(s,i),'review');s.notes[0].archived=true;assert.equal(Q.outcome(s,i),'attention');});
test('queue survives state replacement during save and send, and does not send completed batches twice',async()=>{
 let s=fixture();s.imports=s.imports.slice(0,1);const q=Q.create(s,['s0'],'durable');q.researchQueue.status='active';s.conversations.push(q);let sent=0;
 Q.init({getState:()=>s,idle:()=>true,persist:async()=>{s=JSON.parse(JSON.stringify(s));},toast:message=>{throw Error(message);},stop:()=>{},send:async options=>{sent++;s=JSON.parse(JSON.stringify(s));s.agentRuns.push({id:'actual',conversationId:options.conversationId,status:'completed',results:[{type:'note',id:'draft',operation:'drafted'}]});s.notes.push({id:'draft',projectId:'p',aiDraft:{content:'Synthetic evidence',sourceAttachmentIds:['s0']}});}});
 await Q.tick();assert.equal(sent,1);assert.equal(s.conversations[0].researchQueue.items[0].status,'review');assert.equal(s.conversations[0].researchQueue.status,'completed');await Q.tick();assert.equal(sent,1);assert.equal(s.conversations[1].projectId,'p');
});
test('empty draft does not complete source processing',()=>{const s=fixture();s.notes=[{id:'n',projectId:'p',aiDraft:{content:'   ',sourceAttachmentIds:['s0']}}];assert.equal(Q.outcome(s,{projectId:'p',ids:['s0']}),'attention');});
test('foreign-project, missing-file and withdrawn-source drafts cannot finish a batch',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0']};
 const note={id:'n',projectId:'q',aiDraft:{content:'Evidence to review',sourceAttachmentIds:['s0']}};s.notes.push(note);
 assert.equal(Q.outcome(s,item),'attention');note.projectId='p';assert.equal(Q.outcome(s,item),'review');
 note.wikiFileError='missing';assert.equal(Q.outcome(s,item),'attention');delete note.wikiFileError;
 note.sourceAttachmentIds=['s0'];note.aiDraft.sourceAttachmentIds=[];assert.equal(Q.outcome(s,item),'attention');
 note.aiDraft.sourceAttachmentIds=['s0'];s.imports[0].projectId='q';assert.equal(Q.outcome(s,item),'attention');
});
test('an unrelated pre-existing draft is not a successful outcome of the current batch run',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0'],runId:'r'};
 s.notes.push({id:'n',projectId:'p',aiDraft:{content:'Evidence',sourceAttachmentIds:['s0']}});
 const run={id:'r',status:'completed',results:[]};s.agentRuns.push(run);
 assert.equal(Q.outcome(s,item),'attention');run.results.push({type:'note',id:'n',operation:'drafted'});assert.equal(Q.outcome(s,item),'review');
 run.status='failed';assert.equal(Q.outcome(s,item),'attention');
});
test('approved analysis in another project does not complete a source batch',()=>{
 const s=fixture(),item={projectId:'p',ids:['s0']};
 s.notes.push({id:'n',projectId:'q',kind:'资料分析',content:'The comparison establishes that the second method needs a separate ablation to distinguish its effects.',sourceAttachmentIds:['s0']});
 assert.equal(Q.outcome(s,item),'attention');s.notes[0].projectId='p';assert.equal(Q.outcome(s,item),'completed');
});
