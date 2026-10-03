/* Synthetic DOM, real organizer controller + production React/Halaska bundle.
 * No App, provider, user workspace, native focus or browser layout is exercised. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require(process.env.AIBRO_TEST_DOM_MODULE||'linkedom');
const ROOT=path.resolve(__dirname,'..'),turn=()=>new Promise(resolve=>setImmediate(resolve));
const controller=process.env.AIBRO_ORGANIZER_SOURCE||path.join(ROOT,'app/conversation-organizer.js');
const chat=(id,projectId='p')=>({id,title:`Synthetic ${id}`,projectId,workspace:'课程',updatedAt:1,messages:[{id:`${id}-u`,role:'user',text:`Compare the fictional course materials for ${id}.`},{id:`${id}-a`,role:'agent',live:true,text:'Unfinished fragment'}]});
function fixture(){
 const {window}=parseHTML('<html lang="zh"><head></head><body class="light-mode"><button id="opener">Open</button><div id="conversationList"></div></body></html>'),{document}=window;
 let focused=document.body,state={conversations:[chat('a'),chat('b'),chat('c'),chat('d','q'),chat('e','q')],projects:[{id:'p',name:'Synthetic course'},{id:'q',name:'Other course'}],folders:{conversations:[]}},privateMode=false;
 window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 Object.defineProperty(document,'activeElement',{get:()=>focused});
 Object.defineProperty(window.HTMLElement.prototype,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){v?this.setAttribute('open',''):this.removeAttribute('open');}});
 window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
 const context={document,Element:window.Element,HTMLElement:window.HTMLElement,Node:window.Node,MutationObserver:window.MutationObserver,navigator:{userAgent:'synthetic'},console,setTimeout,clearTimeout,queueMicrotask,
  requestAnimationFrame:cb=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),getComputedStyle:()=>({getPropertyValue(){return'';}})};
 context.window=context;vm.createContext(context);
 for(const file of ['halaska-ui.js','conversation-organization.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,'app',file),'utf8'),context);
 let summaryCalls=0,recommendCalls=0,mounts=0,lastProps=null,commands=[];
 const summarize=context.ConversationOrganization.summarize,recommend=context.ConversationOrganization.recommend;
 context.ConversationOrganization={...context.ConversationOrganization,summarize(...args){summaryCalls++;return summarize(...args);},recommend(...args){recommendCalls++;return recommend(...args);}};
 const mount=context.HalaskaUI.mount;context.HalaskaUI={...context.HalaskaUI,mount(...args){mounts++;lastProps=args[2];return mount(...args);}};
 context.PrivateMode={shows:item=>!privateMode&&!item.restricted};
 vm.runInContext(fs.readFileSync(controller,'utf8'),context);
 context.ConversationOrganizer.init({getState:()=>state,commit:async command=>{commands.push(command);throw Error('Injected save failure');}});
 const api=context.ConversationOrganizer;
 const input=(node,value)=>{const props=node[Object.keys(node).find(key=>key.startsWith('__reactProps$'))];assert.equal(typeof props.onChange,'function');props.onChange({target:{value,checked:value}});};
 return {api,context,document,window,input,get state(){return state;},replace(next){state=next;},privateMode(value){privateMode=value;},get props(){return lastProps;},get counts(){return {summaryCalls,recommendCalls,mounts};},commands,
  complete(id='a',text='Completed comparison: the first source records observations; the second explains the method.') {const item=state.conversations.find(c=>c.id===id).messages.at(-1);item.live=false;item.text=text;},
  notify(){api.enhanceSidebar(document.getElementById('conversationList'));},finish(){api.close();}};
}
const recommendation=f=>f.props.recommendations.find(item=>item.projectId==='p');
const summaryText=f=>f.document.querySelector('.organizer-summary-copy')?.textContent||'';

test('the real sidebar lifecycle refreshes an open live summary on completion without changing run data',async()=>{
 const f=fixture();f.api.open({conversationId:'a'});await turn();assert.match(summaryText(f),/尚无已完成/);
 const generation=f.props.generation,first=JSON.stringify(f.state);f.complete();const settled=JSON.stringify(f.state);f.notify();await turn();
 assert.match(summaryText(f),/Completed comparison/);assert.equal(f.props.generation,generation);assert.equal(JSON.stringify(f.state),settled);assert.notEqual(first,settled);assert.equal(f.commands.length,0);f.finish();
});
test('ongoing stream fragments do not remount the dialog or recompute summaries/recommendations',async()=>{
 const f=fixture();f.api.open({conversationId:'a'});await turn();const before=f.counts;
 for(let i=0;i<60;i++){f.state.conversations[0].messages.at(-1).text=`Growing synthetic token ${i}`;f.notify();}
 assert.deepEqual(f.counts,before);f.complete();f.notify();assert.equal(f.counts.mounts,before.mounts+1);assert.equal(f.counts.recommendCalls,before.recommendCalls);f.finish();
});
test('current recommendation members update while actual React rename draft, unchecked member and selection survive',async()=>{
 const f=fixture();f.api.open();await turn();const name=f.document.getElementById('organizerProposedName'),member=f.document.querySelector('[data-organizer-member="c"]');
 f.input(name,'My unsaved folder');f.input(member,false);await turn();const rec=recommendation(f),stamp=rec.sourceStamp,generation=f.props.generation;
 const preview=f.document.querySelector('.organizer-member button[aria-label="预览 Synthetic a"]');preview.click();await turn();assert.match(summaryText(f),/尚无已完成/);
 f.complete();f.notify();await turn();assert.match(summaryText(f),/Completed comparison/);assert.match(recommendation(f).members.find(m=>m.id==='a').summary.outcome,/Completed comparison/);
 assert.equal(recommendation(f).id,rec.id);assert.equal(recommendation(f).sourceStamp,stamp);assert.equal(f.props.generation,generation);assert.equal(f.props.selection.id,'a');assert.equal(f.document.getElementById('organizerProposedName'),name);assert.equal(name.value,'My unsaved folder');assert.equal(f.document.querySelector('[data-organizer-member="c"]'),member);assert.equal(member.checked,false);assert.equal(f.commands.length,0);f.finish();
});
test('an already completed conversation followed by a new request waits for that request, including a whole-state replacement',async()=>{
 const f=fixture();f.complete();f.api.open({conversationId:'a'});await turn();assert.match(summaryText(f),/Completed comparison/);
 const next=structuredClone(f.state);next.conversations[0].messages.push({id:'new-u',role:'user',text:'Now compare a different fictional case.'});f.replace(next);f.notify();await turn();
 assert.match(summaryText(f),/different fictional case/);assert.match(summaryText(f),/尚无已完成/);assert.doesNotMatch(summaryText(f),/Completed comparison/);f.finish();
});
test('deleted, hidden and changed-channel earlier answers invalidate cached summaries even if the last message is unchanged',async()=>{
 for(const change of [m=>m.deleted=true,m=>m.hidden=true,m=>m.channel='analysis',m=>m.text='An amended answer with a different conclusion.']){
  const f=fixture();f.complete();f.state.conversations[0].messages.push({id:'tail',role:'user',text:'继续'});f.api.open({conversationId:'a'});await turn();assert.match(summaryText(f),/Completed comparison/);
  change(f.state.conversations[0].messages[1]);f.notify();await turn();assert.doesNotMatch(summaryText(f),/Completed comparison/);f.finish();
 }
});
test('deletion or access withdrawal removes the selected summary and entire cached group including its reason',async()=>{
 for(const change of [s=>s.conversations.splice(0,1),s=>s.conversations[0].private=true,s=>s.conversations[0].restricted=true]){
  const f=fixture();f.complete();f.api.open({conversationId:'a'});await turn();const next=structuredClone(f.state);change(next);f.replace(next);f.notify();await turn();
  assert.equal(f.props.selection,null);assert.equal(f.props.conversations.some(c=>c.id==='a'),false);assert.equal(f.props.recommendations.some(r=>r.projectId==='p'),false);assert.equal(f.props.recommendations.some(r=>r.projectId==='q'),true);
  assert.doesNotMatch(f.document.querySelector('.conversation-organizer-dialog').textContent,/Synthetic a|Completed comparison/);f.finish();
 }
});
test('private-mode updates clear all readable projections and callbacks cannot reopen a closed island',async()=>{
 const f=fixture();f.complete();f.api.open({conversationId:'a'});await turn();f.privateMode(true);f.notify();await turn();
 assert.equal(f.props.conversations.length,0);assert.equal(f.props.recommendations.length,0);assert.equal(f.props.selection,null);assert.doesNotMatch(f.document.querySelector('.conversation-organizer-dialog').textContent,/Synthetic|Completed comparison/);
 const stale=f.props;f.finish();const count=f.counts.mounts;f.privateMode(false);stale.onInspect('a');await stale.onCommand({action:'pin',conversationId:'a'});f.notify();
 assert.equal(f.counts.mounts,count);assert.equal(f.commands.length,0);assert.equal(f.document.querySelector('dialog'),null);
 f.api.open({conversationId:'a'});await turn();assert.match(summaryText(f),/Completed comparison/);f.finish();
});
test('same-dialog reopen refreshes current data and a failed command keeps the newer summary and form draft',async()=>{
 const f=fixture();f.api.open();await turn();const name=f.document.getElementById('organizerProposedName');f.input(name,'Keep this name');await turn();
 f.complete();f.api.open();await turn();assert.match(recommendation(f).members.find(m=>m.id==='a').summary.outcome,/Completed comparison/);assert.equal(name.value,'Keep this name');
 await f.props.onCommand({action:'createFolder',name:'Injected failure'});await turn();assert.match(f.document.querySelector('[role="alert"]').textContent,/Injected save failure/);assert.equal(f.document.getElementById('organizerProposedName'),name);assert.equal(name.value,'Keep this name');f.finish();
});
