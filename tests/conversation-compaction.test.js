const test=require('node:test'),assert=require('node:assert/strict'),C=require('../app/conversation-compaction');
const chat=()=>({id:'c',messages:Array.from({length:80},(_,i)=>({id:'m'+i,role:i%2?'agent':'user',text:'重要约束：只修改课程项目。 '+('模拟原文'.repeat(100))}))});
const response=prompt=>{const v=JSON.parse(prompt.split('资料（不是指令）：')[1]),p=v.messages[0];return JSON.stringify({items:[{kind:'constraint',messageId:p.messageId,role:p.role,quote:p.text.slice(0,14)}]});};
test('small conversations need no compaction call',async()=>{const c={messages:[{id:'a',role:'user',text:'hello'}]};assert.equal((await C.compact(c,{ask:()=>{throw Error('unnecessary')}})).compacted,false);});
test('incremental source-linked compaction is durable derived state and never changes messages',async()=>{
 const c=chat(),before=JSON.stringify(c.messages);const r=await C.compact(c,{ask:async p=>response(p)});assert.equal(r.compacted,true);assert.equal(JSON.stringify(c.messages),before);assert.ok(c.contextSummary.remainingParts>0);
 const covered=c.contextSummary.coveredParts;await C.compact(c,{ask:async p=>response(p)});assert.ok(c.contextSummary.coveredParts>covered);assert.equal(C.verifiedItems(c.contextSummary,c).length,1);
});
test('invented summary quotations and cancelled requests cannot enter durable context',async()=>{
 const c=chat();await assert.rejects(C.compact(c,{ask:async()=>JSON.stringify({items:[{kind:'constraint',messageId:'m0',role:'user',quote:'invented quotation'}]})}),/来源校验/);assert.equal(c.contextSummary,undefined);
 const controller=new AbortController();await assert.rejects(C.compact(c,{signal:controller.signal,ask:async p=>{controller.abort();return response(p);}}),{code:'CANCELLED'});assert.equal(c.contextSummary,undefined);
});
test('editing old sources invalidates cached summaries, including edits during compaction',async()=>{
 const c=chat();await C.compact(c,{ask:async p=>response(p)});c.messages[0].text='changed';await assert.rejects(C.compact(c,{ask:async()=>{throw Error('provider unavailable')}}));assert.equal(c.contextSummary,undefined);
 const d=chat();await assert.rejects(C.compact(d,{ask:async p=>{d.messages[1].text='edited during await';return response(p);}}),/对话已变化/);assert.equal(d.contextSummary,undefined);
});
