const test=require('node:test'),assert=require('node:assert/strict'),C=require('../app/agent-context'),W=require('../app/context-window');
test('history retains recent exact messages, original intent and can recover every omitted message in scope',()=>{
 const c={id:'c',messages:Array.from({length:100},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',text:'message '+i+' '+('example '.repeat(100)),at:i}))};
 c.messages[25].text='早先确认的组会时间是周四下午两点半';
 const before=JSON.stringify(c),result=C.history({agentRuns:[]},c,{goal:'组会时间',maxTokens:1800});
 assert.ok(result.coverage.omittedMessages>0);assert.ok(result.coverage.estimatedTokens<=1800);assert.equal(JSON.stringify(c),before);
 const found=C.readHistory(c,{type:'history_search',query:'组会时间'});assert.equal(found.entries[0].messageId,'m25');assert.match(C.readHistory(c,{type:'history_read',messageId:'m25'}).text,/周四/);
 assert.throws(()=>C.readHistory(c,{type:'history_read',messageId:'other-conversation'}));c.messages[25].deletedAt=1;assert.throws(()=>C.readHistory(c,{type:'history_read',messageId:'m25'}));
});
test('long messages remain recoverable exactly through paging without inventing a summary',()=>{
 const text='AB'.repeat(17000),c={messages:[{id:'long',role:'user',text}]};let offset=0,out='';do{const r=C.readHistory(c,{type:'history_read',messageId:'long',offset});out+=r.text;offset=r.nextOffset;}while(offset!==null);assert.equal(out,text);
});
test('capabilities are loaded on demand and final mutations cannot bypass schema loading',()=>{
 const c=C.create({fullInstruction:'你是 TASK_SCHEMA\n文档组织 NOTE_SCHEMA\nOffice FILE_SCHEMA',history:{text:'history'},projectList:'p | 课程 | 示例课',taskContext:'task-1'});
 assert.doesNotMatch(c.instructions(),/TASK_SCHEMA|FILE_SCHEMA/);assert.deepEqual(c.missing({actions:[{type:'create_task'},{type:'update_note'}],agendaProposals:[{}]}),['tasks','knowledge','agenda']);
 c.capability('tasks');assert.match(c.instructions(),/TASK_SCHEMA/);assert.match(c.instructions(),/task-1/);assert.doesNotMatch(c.instructions(),/FILE_SCHEMA/);assert.deepEqual(c.missing({actions:[{type:'update_task'}]}),[]);assert.throws(()=>c.capability('bogus'));
});
test('token budget controls payload size, not fixed chunk count, and every result is pageable',()=>{
 const short=Array.from({length:140},(_,i)=>({id:'c'+i,type:'note',recordId:'n'+i,text:'small evidence'}));
 assert.ok(W.page(short,{maxTokens:4000}).entries.length>20);
 const long=short.map(x=>({...x,text:'科研'.repeat(500)}));assert.ok(W.page(long,{maxTokens:4000}).entries.length<20);
 const seen=[];let offset=0;do{const p=W.page(long,{offset,maxTokens:4000});seen.push(...p.entries.map(x=>x.id));offset=p.nextOffset;}while(offset!==null);assert.equal(new Set(seen).size,140);assert.throws(()=>W.page(short,{maxTokens:-1}));
});
test('source diversification never loses a lower-ranked source or duplicates chunks',()=>{
 const rows=Array.from({length:30},(_,i)=>({id:'c'+i,type:'note',recordId:i<20?'long-document':'other-'+i}));const out=W.diversify(rows);assert.ok(out.findIndex(e=>e.id==='c20')<20);assert.equal(new Set(out.map(x=>x.id)).size,30);
});

test('library overview exposes available spaces and projects without dumping bodies or foreign/deleted sources',()=>{
 const s={projects:[{id:'p',name:'示例课程',workspace:'课程'},{id:'q',name:'其他项目',workspace:'科研'}],notes:[{id:'n',projectId:'p',content:'PRIVATE_BODY'},{id:'hidden',projectId:'p',deletedAt:1,content:'deleted'},{id:'other',projectId:'q',content:'foreign'}]};
 const map=C.overview(s,{workspace:'课程'});assert.equal(map.totals.notes,1);assert.equal(map.entries[0].name,'示例课程');assert.doesNotMatch(JSON.stringify(map),/PRIVATE_BODY|foreign|其他项目/);
});
