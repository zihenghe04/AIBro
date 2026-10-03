const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require(process.env.AIBRO_TEST_DOM_MODULE||'linkedom');
const ROOT=path.resolve(__dirname,'..'),source=file=>fs.readFileSync(path.join(ROOT,'app',file),'utf8');
const app=source('app.js'),pinStart=app.indexOf("document.addEventListener('click'",app.indexOf('// 工具执行记录的开合')),pinEnd=app.indexOf('// Tab choices belong',pinStart);
assert.ok(pinStart>0&&pinEnd>pinStart);
const call=(id,type,request,result,status='completed')=>({id,type,status,request:{type,...request},...(result===undefined?{}:{result:{result}})});
function fixture(calls,{language='zh',status='completed'}={}){
 const {window}=parseHTML('<html><head></head><body></body></html>'),{document}=window;
 Object.defineProperty(window.HTMLElement.prototype,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){v?this.setAttribute('open',''):this.removeAttribute('open');}});
 let focused=document.body,selection=null,saves=0;
 window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused});
 const context={document,console,Date,Intl,getSelection:()=>selection,WorkstationI18n:{getLanguage:()=>language}};context.window=context;vm.createContext(context);
 for(const file of ['tool-scheduler.js','agent-progress.js'])vm.runInContext(source(file),context);
 const run={id:'details-run',status,toolCalls:calls},message={id:'details-message',role:'agent',runId:run.id};
 context.state={agentRuns:[run],conversations:[{id:'details-chat',messages:[message]}]};context.save=()=>saves++;vm.runInContext(app.slice(pinStart,pinEnd),context);
 document.addEventListener('click',event=>{const summary=event.target.closest?.('summary');if(!summary||event.defaultPrevented)return;summary.parentElement.open=!summary.parentElement.open;summary.parentElement.dispatchEvent(new window.Event('toggle'));});
 const mount=()=>{const wrapper=document.createElement('article');wrapper.className='message-wrap';wrapper.dataset.messageId=message.id;wrapper.append(context.ToolScheduler.card(run));const answer=document.createElement('div');answer.className='message-body';answer.textContent='Final answer retained';wrapper.append(answer);return wrapper;};
 const wrapper=mount();document.body.append(wrapper);
 return {context,run,document,wrapper,saves:()=>saves,row:id=>wrapper.querySelector(`[data-tool-id="${id}"]`),
  update(){context.AgentProgress.patchLive(wrapper,mount());},
  key(node,key){const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key});node.dispatchEvent(event);return event;},
  select(node){selection={rangeCount:1,isCollapsed:false,anchorNode:node,focusNode:node,anchorOffset:3,focusOffset:8,toString:()=> 'kept',setBaseAndExtent(a,ao,b,bo){this.anchorNode=a;this.anchorOffset=ao;this.focusNode=b;this.focusOffset=bo;}};return selection;}
 };
}
const block=(row,key)=>row.querySelector(`[data-live-key="${key}"]`),full=field=>field.querySelector(':scope > .tool-ledger-full-text'),trigger=field=>field.querySelector(':scope > summary');
const captured=[];
function capture(name,f){captured.push({name,html:f.wrapper.outerHTML,ledger:JSON.parse(JSON.stringify(f.run.toolCalls))});}
test.after(()=>{if(!process.env.AIBRO_TOOL_DETAILS_ARTIFACT_DIR)return;const out=process.env.AIBRO_TOOL_DETAILS_ARTIFACT_DIR;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'dom-fixtures.json'),JSON.stringify(captured,null,2));fs.writeFileSync(path.join(out,'dom-fixtures.html'),'<!doctype html><meta charset="utf-8"><style>:root{--text:#18221d;--muted:#536358;--faint:#617065;--line:#cfd6d1;--accent:#306b43}body{font:14px system-ui;padding:24px;max-width:880px;margin:auto}'+source('tool-scheduler.css')+'</style>'+captured.map(x=>'<section><h2>'+x.name+'</h2>'+x.html+'</section>').join(''));});

test('terminal details display exact quoted argv and cwd while retaining original parameter and receipt JSON',()=>{
 const argv=['printf','two words',"a'b",'$(not-executed)','', '<img src=x>'],request={argv,cwd:'/synthetic folder/project'},result={argv,cwd:'/synthetic folder/project',exitCode:0,output:'first line\nsecond line',status:'succeeded'};
 const entry=call('quoted','terminal',request,result),before=JSON.stringify(entry),f=fixture([entry]),row=f.row('quoted');
 const expected="printf 'two words' 'a'\"'\"'b' '$(not-executed)' '' '<img src=x>'";
 assert.equal(block(row,'parameters').querySelector('pre').textContent,expected);assert.equal(block(row,'result').querySelector('pre').textContent,expected);
 assert.match(block(row,'parameters').textContent,/工作目录（cwd）：\/synthetic folder\/project/);assert.match(block(row,'result').textContent,/退出码：0/);
 assert.equal(row.querySelector('img'),null);assert.ok(block(row,'result').textContent.includes('first line\nsecond line'));
 const raw=row.querySelectorAll('.tool-ledger-raw pre');assert.deepEqual(JSON.parse(raw[0].textContent),entry.request);assert.deepEqual(JSON.parse(raw[1].textContent),entry.result);assert.equal(JSON.stringify(entry),before);
 capture('Quoted command and merged output',f);
});

test('only recorded output streams are shown, with explicit empty output and source truncation',()=>{
 const f=fixture([
  call('merged','terminal',{argv:['true']},{exitCode:0,output:'',truncated:true}),
  call('split','terminal',{argv:['fictional']},{stdout:'received stdout',stderr:'received stderr',exitCode:7}),
  call('missing','terminal',{argv:['pending']},{status:'running',exitCode:null},'running')
 ],{language:'en'});
 assert.match(block(f.row('merged'),'result').textContent,/Command output\(empty\)/);assert.doesNotMatch(f.row('merged').textContent,/Standard output|Standard error/);
 assert.match(f.row('merged').querySelector('.tool-ledger-notice').textContent,/truncated at the source/);
 const split=block(f.row('split'),'result');assert.match(split.textContent,/Standard output \(stdout\)received stdout/);assert.match(split.textContent,/Standard error \(stderr\)received stderr/);assert.match(split.textContent,/Exit code：7/);assert.doesNotMatch(split.textContent,/Command output/);
 assert.doesNotMatch(block(f.row('missing'),'result').textContent,/Exit code|Command output|Standard output|Standard error/);
 capture('Separate streams and absent output',f);
});

test('agenda details use occurrence dates and recorded timezone, not the series origin, and preserve all entries',()=>{
 const event={eventId:'series',title:'Fictional basketball',start:Date.UTC(2026,8,1),end:Date.UTC(2026,8,1,1),occurrenceStart:Date.UTC(2026,9,4,7),occurrenceEnd:Date.UTC(2026,9,4,8),timeZone:'Asia/Shanghai',location:'Court A'};
 const entries=[event,...Array.from({length:5},(_,i)=>({...event,eventId:'event-'+i,title:'Complete event '+i}))];
 const entry=call('agenda','agenda_list',{query:'basketball'},{entries,total:6,offset:0,nextOffset:null}),before=JSON.stringify(entry),f=fixture([entry]),row=f.row('agenda'),field=row.querySelector('.tool-ledger-text-field');
 assert.ok(field);assert.equal(full(field),null);assert.match(trigger(field).textContent,/查看全部日程/);assert.equal(field.textContent.includes('Complete event 4'),false);
 trigger(field).click();assert.match(full(field).textContent,/Fictional basketball\n开始: 2026-10-04 15:00:00 Asia\/Shanghai\n结束: 2026-10-04 16:00:00 Asia\/Shanghai/);
 assert.ok(full(field).textContent.includes('Complete event 4'));assert.ok(full(field).textContent.includes('地点：Court A'));assert.equal(JSON.stringify(entry),before);
 assert.equal(f.context.ToolScheduler.inspectingCall(f.run,entry),true);f.update();assert.equal(row.querySelector('.tool-ledger-text-field'),field);assert.equal(field.open,true);
 capture('Complete agenda entries',f);
});

test('agenda empty-page, empty-query, absent payload and failed query are distinct',()=>{
 const f=fixture([
  call('empty','agenda_list',{}, {entries:[],total:0}),call('page','agenda_list',{offset:20},{entries:[],total:4,offset:20}),
  call('failed','agenda_list',{}, {entries:[],total:0,status:'deferred',error:'busy'},'failed'),call('absent','agenda_list',{}, {error:'No receipt'},'failed')
 ]);
 assert.match(block(f.row('empty'),'result').textContent,/当前查询范围内没有匹配日程/);assert.match(block(f.row('page'),'result').textContent,/本页没有日程/);
 assert.match(block(f.row('failed'),'result').textContent,/查询未完成/);assert.doesNotMatch(block(f.row('failed'),'result').textContent,/没有匹配日程/);
 assert.doesNotMatch(block(f.row('absent'),'result').textContent,/没有匹配日程|本页没有日程/);capture('Agenda empty and failure states',f);
});

test('actual thrown reason and errorCode remain on the failed call after later success',async()=>{
 const f=fixture([]),run=f.run;let count=0;
 const scheduler=f.context.ToolScheduler.create({run,execute:async()=>{if(!count++)throw Object.assign(Error('Exact failure text'),{code:'INVALID_AGENDA_REQUEST',reason:'timezone_required'});return {entries:[],total:0};}});
 await scheduler.batch([{type:'agenda_list',query:'first'}]);const failed=JSON.stringify(run.toolCalls[0]);await scheduler.batch([{type:'agenda_list',query:'second'}]);assert.equal(JSON.stringify(run.toolCalls[0]),failed);
 const card=f.context.ToolScheduler.card(run),row=card.querySelector(`[data-tool-id="${run.toolCalls[0].id}"]`);
 assert.match(block(row,'error').textContent,/错误：Exact failure text/);assert.match(block(row,'error').textContent,/错误代码：INVALID_AGENDA_REQUEST/);assert.match(block(row,'error').textContent,/原因：timezone_required/);
 const raw=row.querySelectorAll('.tool-ledger-raw pre');assert.deepEqual(JSON.parse(raw[raw.length-1].textContent),{error:'Exact failure text',errorCode:'INVALID_AGENDA_REQUEST',reason:'timezone_required'});
 assert.equal(run.toolCalls[0].status,'failed');assert.equal(run.toolCalls[1].status,'completed');assert.equal(f.context.ToolScheduler.issueCount(run),1);
});

test('long command output preserves lazy text, user pins, selection, focus and Enter/Escape behavior',()=>{
 const output='Received output line. '.repeat(1000)+'TAIL-A',entry=call('output','terminal',{argv:['inspect']},{output,exitCode:0}),f=fixture([entry]);
 const row=f.row('output'),field=row.querySelector('.tool-ledger-text-field');row.open=true;assert.equal(full(field),null);
 assert.equal(f.key(trigger(field),'Enter').defaultPrevented,true);assert.equal(full(field).textContent,output);assert.equal(f.run.toolLedgerPins[field.dataset.toolLedgerKey],true);
 const body=full(field),text=body.firstChild;body.focus();const selection=f.select(text);f.run.toolCalls.push(call('later','read',{id:'one'},{text:'Another actual receipt'}));f.update();
 assert.equal(f.row('output'),row);assert.equal(full(field),body);assert.equal(body.firstChild,text);assert.equal(selection.anchorNode,text);assert.equal(f.document.activeElement,body);assert.equal(f.saves(),1);
 assert.equal(f.key(body,'Escape').defaultPrevented,true);assert.equal(full(field),null);assert.equal(row.open,true);assert.equal(f.document.activeElement,trigger(field));assert.equal(f.run.toolLedgerPins[field.dataset.toolLedgerKey],false);
 entry.result.result.output=output.replace('TAIL-A','TAIL-B');f.update();assert.equal(full(field),null);trigger(field).click();assert.ok(full(field).textContent.endsWith('TAIL-B'));assert.equal(f.wrapper.querySelector('.message-body').textContent,'Final answer retained');
});

test('long argv arrays use the same retained disclosure without altering the original array',()=>{
 const argv=['inspect','space '+ 'x'.repeat(700),"last'argument"],entry=call('long-argv','terminal',{argv},undefined),f=fixture([entry]),field=f.row('long-argv').querySelector('.tool-ledger-text-field');
 assert.ok(field);assert.equal(full(field),null);trigger(field).click();assert.ok(full(field).textContent.includes("'last'\"'\"'argument'"));assert.equal(f.context.ToolScheduler.inspectingCall(f.run,entry),true);assert.deepEqual(entry.request.argv,argv);
 const raw=f.row('long-argv').querySelector('.tool-ledger-raw pre');assert.deepEqual(JSON.parse(raw.textContent).argv,argv);
});

test('live output uses only a unique toolCallId association and never overrides a saved tool result',()=>{
 const pending=call('live','terminal',{argv:['same']},undefined,'running'),unlinked=call('unlinked','terminal',{argv:['same']},undefined,'running'),saved=call('saved','terminal',{argv:['same']},{output:'Authoritative saved output',exitCode:0});
 const f=fixture([pending,unlinked,saved],{status:'running'});
 const command={id:'command-id',toolCallId:'live',argv:['same','actual arg'],cwd:'relative',displayCwd:'/synthetic/project/relative',status:'running',output:'Received so far. '.repeat(100)+'LIVE-TAIL',exitCode:null};
 f.run.commands=[command,{...command,id:'no-association',toolCallId:undefined,output:'DO NOT MATCH BY ARGV'},{...command,id:'already-saved',toolCallId:'saved',output:'DO NOT OVERRIDE SAVED'}];f.update();
 const row=f.row('live'),field=row.querySelector('.tool-ledger-text-field');assert.ok(field);assert.equal(full(field),null);trigger(field).click();assert.ok(full(field).textContent.endsWith('LIVE-TAIL'));
 assert.match(block(row,'result').textContent,/实际工作目录：\/synthetic\/project\/relative/);assert.doesNotMatch(block(row,'result').textContent,/退出码/);
 const raw=row.querySelectorAll('.tool-ledger-raw pre');assert.deepEqual(JSON.parse(raw[raw.length-1].textContent),command);
 assert.equal(block(f.row('unlinked'),'result'),null);assert.equal(f.row('unlinked').textContent.includes('DO NOT MATCH'),false);assert.ok(f.row('saved').textContent.includes('Authoritative saved output'));assert.equal(f.row('saved').textContent.includes('DO NOT OVERRIDE'),false);
 command.output=command.output.replace('LIVE-TAIL','NEW-TAIL');f.update();assert.equal(row.querySelector('.tool-ledger-text-field'),field);assert.ok(full(field).textContent.endsWith('NEW-TAIL'));assert.equal(f.context.ToolScheduler.inspectingCall(f.run,pending),true);
 f.run.commands.push({...command,id:'duplicate-link'});f.update();assert.equal(block(f.row('live'),'result'),null,'ambiguous association must not choose a command');assert.equal(pending.result,undefined);
});

test('tool evidence never adds nested scroll containers and keeps selectable text',()=>{
 const css=source('tool-scheduler.css');assert.doesNotMatch(css,/overflow\s*:\s*(?:auto|scroll)|max-height\s*:\s*\d+px/);assert.match(css,/overflow:visible/);assert.match(css,/user-select:text/);
});
