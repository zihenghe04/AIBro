/* Isolated Node DOM integration/measurement. Run with
 * AIBRO_TEST_DOM_MODULE=/absolute/path/to/linkedom node tests/conversation-stream-body-dom.cjs
 * Tested with linkedom 0.18.12, installed only in a disposable /tmp prefix.
 * This is parser/DOM-adapter CPU, not WebKit paint, native FPS or model speed. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {performance}=require('node:perf_hooks');
const {parseHTML}=require(process.env.AIBRO_TEST_DOM_MODULE||'linkedom');
const ROOT=path.resolve(__dirname,'..'),OUT=process.env.AIBRO_STREAM_RESULT_DIR||path.join(ROOT,'test-results/conversation-stream-frontier-20261001');
fs.mkdirSync(OUT,{recursive:true});
const app=fs.readFileSync(path.join(ROOT,'app/app.js'),'utf8');
const parser=app.slice(app.indexOf('function renderRichText('),app.indexOf('\nfunction renderMessage('));
const checks=[],measurements=[];
// Linkedom shares its Element prototype across documents. One accessor wrapper
// records only the active measured render, with no per-node instrumentation or
// instrumentation traversal inside the timed section.
let activeMetrics=null;
const elementPrototype=parseHTML('<html></html>').window.Element.prototype;
for(const property of ['innerHTML','outerHTML']){
 const original=Object.getOwnPropertyDescriptor(elementPrototype,property);
 Object.defineProperty(elementPrototype,property,{...original,
  get(){const value=original.get.call(this);if(activeMetrics&&property==='outerHTML')activeMetrics.signatureCharacters+=value.length;return value;},
  ...(original.set?{set(value){if(activeMetrics&&property==='innerHTML')activeMetrics.htmlParseCharacters+=value.length;original.set.call(this,value);}}:{})});
}
function environment(enabled=true){
 const {window,document}=parseHTML('<html><body></body></html>');
 const metrics={htmlParseCharacters:0,signatureCharacters:0,parserCharacters:0,frames:0,elapsedMs:0};
 let measuring=false;
 const message={runId:'r'},run={id:'r',evidenceSources:[{sourceId:'s1',provided:true,type:'note',id:'n1',runId:'r',number:1,title:'Fictional source',excerpt:'Synthetic evidence only.'}]};
 const env={URL,document,MutationObserver:window.MutationObserver,NodeFilter:{SHOW_TEXT:4},
  esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  MathRender:{...require('../app/math-render.js')},CodeHighlight:{...require('../app/code-highlight.js')},state:{notes:[{id:'n1',title:'Fictional note',content:'Synthetic evidence only.'}],agentRuns:[run]},window:{ConversationLink:require('../app/conversation-link.js')}};
 const render=vm.runInNewContext(`(${parser})`,env);
 for(const file of ['citation-evidence.js',...(enabled?['conversation-stream-body.js']:[]),'stream-code.js','stream-markdown.js','streaming-body.js'])vm.runInNewContext(fs.readFileSync(path.join(ROOT,'app',file),'utf8'),env);
 // Linkedom has no browser Selection and its Range omits setEnd. This narrow
 // UTF-16 text-range contract lets the production StreamCode capture/restore
 // path run; it is not evidence of native browser selection behavior.
 document.createRange=()=>{let element,end,offset;return{
  selectNodeContents(value){element=value;},setEnd(value,at){end=value;offset=at;},
  toString(){let value='',walker=document.createTreeWalker(element,4),node;
   while(node=walker.nextNode()){if(node===end)return value+node.nodeValue.slice(0,offset);value+=node.nodeValue;}
   if(end===element)return [...element.childNodes].slice(0,offset).map(node=>node.textContent).join('');
   throw new Error('UTF-16 fixture endpoint missing');}
 };};
 const decorate=host=>env.CitationEvidence.decorate(host,message,run,env.state);
 const owner={},citations={message,run,state:env.state};let body;
 const renderer=(value,wiki,cache)=>{const html=render(value,wiki,cache);if(measuring&&!cache?.probeOnly)metrics.parserCharacters+=cache?.parsedCharacters??value.length;return html;};
 const push=(text,{live=true,selection=null,beforeCommit=null,check=true}={})=>{
  const next=document.createElement('div');next.className='message-body';
  const start=performance.now();measuring=true;activeMetrics=metrics;
  try{
   env.StreamMarkdown.renderBody(owner,next,text,renderer,{live,previous:body,citations,decorate});
   beforeCommit?.(body,next);
   if(body){if(!env.StreamingBody.patch(body,next,{selection,onTextEdit:(node,edit)=>env.StreamingBody.remapSelection(selection,node,edit)})){body.replaceWith(next);body=next;}}
   else{body=next;document.body.append(body);}
  }finally{measuring=false;activeMetrics=null;metrics.elapsedMs+=performance.now()-start;metrics.frames++;}
  if(check){const expected=document.createElement('div');expected.innerHTML=render(text,null,live?{liveCode:true}:null);decorate(expected);assert.equal(body.innerHTML,expected.innerHTML,'canonical renderer output at frame '+metrics.frames);}
  return body;
 };
 return{env,document,push,metrics,get body(){return body;},setSources:next=>run.evidenceSources=next.map(source=>({provided:true,type:'note',id:'n1',...source})),finish(){env.StreamMarkdown.clear();}};
}
function check(name,fn){fn();checks.push(name);console.log('PASS',name);}
check('every partial list/table/math/fence/citation boundary equals the existing complete live renderer',()=>{
 const e=environment();const text='# Heading\n\nA paragraph [[cite:s1]].\n\n- first\n\n- second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst n = "中";\n```\n\n$$\nx^2\n$$\n\nEnd';
 for(let i=1;i<=text.length;i++)e.push(text.slice(0,i));e.push(text,{live:false});e.finish();
});
check('nested read-only checklist and quote keep DOM ownership, citations, copy text and selected nodes across appends',()=>{
 const e=environment(),text='- [ ] Selected checklist [[cite:s1]]\n  - child\n    3. nested numbered\n- [x] finished\n\n> A folded source\n> continues here.\n>\n> Another paragraph.\n\n3. [ ] Ordered checkpoint\n4. Ordinary number\n\nTail';
 for(let i=1;i<=text.length;i++)e.push(text.slice(0,i));
 const item=e.body.querySelector('li.markdown-task-item'),label=item.querySelector('label'),selected=label.childNodes[1],source=label.querySelector('button');
 assert.ok(item.querySelector(':scope > ul > li > ol[start="3"]'));assert.equal(label.querySelector('ul'),null);
 assert.ok(label.querySelector('input').hasAttribute('disabled'));assert.equal(e.body.querySelector('ol[start="3"] > li:last-child').textContent,'nested numbered');
 assert.equal(e.body.querySelector('blockquote').querySelectorAll(':scope > p').length,2);
 const selection={anchor:selected,focus:selected,anchorOffset:1,focusOffset:9,anchorIsStart:true};
 e.push(text+' more',{selection});assert.equal(e.body.firstElementChild.firstElementChild,item);assert.equal(label.childNodes[1],selected);assert.equal(selected.nodeValue.slice(1,9),'Selected');
 e.setSources([{sourceId:'s1',runId:'r',number:1,title:'Fresh source in checklist'}]);e.push(text+' more again',{selection});
 assert.equal(label.querySelector('button'),source);assert.match(source.getAttribute('aria-label'),/Fresh source in checklist/);
 const exported=e.env.CitationEvidence.exportText({text,runId:'r'},e.env.state.agentRuns[0],e.env.state);assert.match(exported,/- \[ \] Selected checklist/);assert.match(exported,/3\. \[ \] Ordered checkpoint/);
 e.push(text+' more again',{live:false});assert.ok(e.body.querySelector('.markdown-task-item input').hasAttribute('disabled'));e.finish();
});
check('retained stable paragraphs and sources keep identity while visible source metadata refreshes',()=>{
 const e=environment(),prefix='# H\n\nA retained citation [[cite:s1]].\n\nSecond\n\nTail';e.push(prefix);e.push(prefix+' one');
 const paragraph=e.body.children[1],source=e.body.querySelector('button');
 e.setSources([{sourceId:'s1',runId:'r',number:1,title:'Updated visible source'}]);e.push(prefix+' one two');
 assert.equal(e.body.children[1],paragraph);assert.equal(e.body.querySelector('button'),source);assert.match(source.getAttribute('aria-label'),/Updated visible source/);e.finish();
});
check('unchanged tool-event bodies skip parser DOM construction while current citations and selected nodes survive',()=>{
 const e=environment(),text='A retained citation [[cite:s1]].\n\nMiddle\n\nAnother\n\nSelected ending';e.push(text);e.push(text);
 const paragraph=e.body.firstElementChild,selected=e.body.lastElementChild.firstChild;
 const before={...e.metrics};
 e.setSources([{sourceId:'s1',runId:'r',number:1,title:'Latest source title'}]);
 for(let i=0;i<12;i++)e.push(text,{selection:{anchor:selected,focus:selected,anchorOffset:0,focusOffset:8,anchorIsStart:true}});
 assert.equal(e.body.firstElementChild,paragraph);assert.equal(e.body.lastElementChild.firstChild,selected);
 assert.match(e.body.querySelector('button').getAttribute('aria-label'),/Latest source title/);
 assert.equal(e.metrics.htmlParseCharacters,before.htmlParseCharacters);
 assert.equal(e.metrics.parserCharacters,before.parserCharacters);
 e.push(text,{beforeCommit:body=>body.firstElementChild.textContent='Foreign overwrite'});
 assert.match(e.body.firstElementChild.textContent,/retained citation/);e.push('Stopped with a useful partial answer',{live:false});assert.equal(e.body.textContent,'Stopped with a useful partial answer');e.finish();
});
check('privacy/source invalidation returns to canonical rendering instead of retaining a stale citation',()=>{
 const e=environment(),text='A [[cite:s1]]\n\nB\n\nC\n\nD';e.push(text);e.push(text+' next');e.setSources([]);e.push(text+' next again');assert.equal(e.body.querySelector('button'),null);assert.ok(e.body.querySelector('[data-citation-invalid]'));e.finish();
});
check('production source privacy redacts retained citation bindings as well as visible labels',()=>{
 const e=environment(),text='A [[cite:s1]]\n\nB\n\nC\n\nD';e.push(text);e.push(text+' next');const citation=e.body.querySelector('button');
 e.env.state.notes[0].private=true;e.push(text+' next again');assert.equal(e.body.querySelector('button'),citation);assert.match(citation.getAttribute('aria-label'),/私密来源/);
 const target=e.env.CitationEvidence.resolveTarget(e.env.state,citation);assert.equal(target.source.excerpt,null);assert.equal(target.source.private,true);e.finish();
});
check('late web attribution rematerializes settled links with production citation decoration',()=>{
 const e=environment(),text='A [link](https://example.invalid/source)\n\nB\n\nC\n\nD';e.push(text);e.push(text+' next');
 e.setSources([{sourceId:'s1',runId:'r',number:1,type:'web',url:'https://example.invalid/source',title:'Fictional web source'}]);e.push(text+' next again');
 assert.ok(e.body.querySelector('[data-citation-linked]'));assert.ok(e.body.querySelector('.citation-web-chip'));e.finish();
});
check('source corrections, reference/footnote definitions and final replacement remain authoritative',()=>{
 const e=environment();for(const text of ['A\n\nB\n\nC\n\nD','A\n\nB\n\nC\n\nD tail','REPLACED\n\nB\n\nC\n\nD tail','[label][ref]\n\nB\n\nC\n\nD\n\n[ref]: https://example.invalid','Footnote [^a]\n\nB\n\nC\n\n[^a]: definition'])e.push(text);e.push('The final complete answer.',{live:false});e.finish();
});
check('foreign mutations between render and commit invalidate the planned frontier',()=>{
 const e=environment(),text='A\n\nB\n\nC\n\nD';e.push(text);e.push(text+' next');e.push(text+' next again',{beforeCommit:body=>body.firstElementChild.textContent='foreign stale text'});assert.equal(e.body.firstElementChild.textContent,'A');e.finish();
});
check('selection in an appended paragraph retains the same nodes and selected characters',()=>{
 const e=environment(),text='Stable\n\nMiddle\n\nLast\n\nselected suffix';e.push(text);e.push(text+' a');const selected=e.body.lastElementChild.firstChild;
 const selection={anchor:selected,focus:selected,anchorOffset:0,focusOffset:8,anchorIsStart:true};e.push(text+' a more',{selection});assert.equal(e.body.lastElementChild.firstChild,selected);assert.equal(selected.nodeValue.slice(selection.anchorOffset,selection.focusOffset),'selected');e.finish();
});
check('code selection falls back to the existing UTF-16 remapping instead of bypassing highlighting rules',()=>{
 const e=environment(),text='Stable\n\nMiddle\n\n```js\nconst value = 1;';e.push(text);e.push(text+'\n');const selected=e.body.querySelector('code').firstChild,selection={anchor:selected,focus:selected,anchorOffset:0,focusOffset:5,anchorIsStart:true};e.push(text+'\n```\n\nEnd',{selection});assert.ok(selection.anchor.isConnected);e.finish();
});
check('new parser dependencies replace stale settled output',()=>{
 const e=environment(),text='Math $x$\n\nMiddle\n\nLast\n\nTail';e.push(text);e.push(text+' one');
 e.env.MathRender.inlineMath=()=>'<b>new math renderer</b>';e.push(text+' one more');assert.match(e.body.innerHTML,/new math renderer/);e.finish();
});
check('late reference definitions, footnotes and stateful app links decline the partial DOM plan',()=>{
 const e=environment(),text='[title][later]\n\nMiddle\n\nLast\n\nTail';e.push(text);e.push(text+' one');
 for(const suffix of ['\n\n[later]: https://example.invalid','\n\nFootnote [^a]','\n\n[page](wiki:record)','\n\n[chat](aibro://conversation/test)']){
  e.push(text+' one'+suffix,{beforeCommit:(_,next)=>assert.equal(next.firstElementChild.textContent,'[title][later]')});
 }e.finish();
});
check('selection can span a retained prefix and a changing tail in either direction',()=>{
 for(const backwards of [false,true]){
  const e=environment(),text='Prefix selected\n\nMiddle\n\nLast\n\nselected tail';e.push(text);e.push(text+' more');
  const prefix=e.body.firstElementChild.firstChild,tail=e.body.lastElementChild.firstChild;
  const selection={anchor:backwards?tail:prefix,focus:backwards?prefix:tail,anchorOffset:backwards?8:7,focusOffset:backwards?7:8,anchorIsStart:!backwards};
  e.push(text+' more appended',{selection});assert.equal(e.body.firstElementChild.firstChild,prefix);assert.equal(e.body.lastElementChild.firstChild,tail);
  assert.equal(selection.anchorOffset,backwards?8:7);assert.equal(selection.focusOffset,backwards?7:8);e.finish();
 }
});
check('the direct code continuation remains active and closing it returns to exact Markdown',()=>{
 const e=environment(),text='Prefix\n\nMiddle\n\nLast\n\n```js\nconst n = ';e.push(text);e.push(text+'1');e.push(text+'12');
 assert.ok(e.env.StreamMarkdown.inspectBody(e.body).commits>0);e.push(text+'123;\n```\n\nFinal paragraph');e.push(text+'123;\n```\n\nFinal paragraph complete',{live:false});e.finish();
});
check('controller-owned roots decline tail adoption before changing either tree',()=>{
 const e=environment(),text='Prefix\n\nMiddle\n\nLast\n\nTail';e.push(text);e.push(text+' one');const previous=e.body;
 previous.firstElementChild.setAttribute('data-halaska-root','');const original=previous.innerHTML;
 e.push(text+' one more');assert.notEqual(e.body,previous);assert.equal(previous.innerHTML,original);e.finish();
});
check('frontier entries and character budget are bounded and release invalidates prepared work',()=>{
 const e=environment(),pool=e.env.ConversationStreamBody.create({maxEntries:2,maxCharacters:1500}),owners=[{},{},{}];let previous;
 for(const owner of owners){const host=e.document.createElement('div');e.document.body.append(host);pool.stage({owner,host,text:'a\n\nb\n\nc',html:'<p>a</p><p>b</p><p>c</p>',prefix:'<p>a</p>',dependencies:[],refresh:()=>{}});pool.adopt(host,host);previous=host;}
 assert.equal(pool.inspect().entries,2);assert.ok(pool.inspect().characters<=1500);
 const next=e.document.createElement('div');pool.stage({owner:owners[2],previous,host:next,text:'a\n\nb\n\nc more',html:'<p>a</p><p>b</p><p>c more</p>',prefix:'<p>a</p>',dependencies:[],refresh:()=>{}});
 assert.equal(next.firstChild.textContent,'b');pool.release(owners[2]);pool.prepare(previous,next,()=>true);assert.equal(next.firstChild.textContent,'a');
 pool.clear();assert.equal(pool.inspect().entries,0);e.finish();
});
const markdown=Array.from({length:70},(_,i)=>`## Synthetic section ${i}\n\n${'A fictional observation keeps its source [[cite:s1]]. '.repeat(5)}\n\n| Item | Value |\n| --- | --- |\n| Sample ${i} | ${i+2} |\n\n`).join('');
for(let pass=0;pass<3;pass++)for(const enabled of pass%2?[true,false]:[false,true]){
 const e=environment(enabled);for(let end=192;end<markdown.length+192;end+=192)e.push(markdown.slice(0,end),{check:false});e.push(markdown,{live:false});measurements.push({enabled,pass,...e.metrics});e.finish();
}
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=Object.fromEntries([false,true].map(enabled=>[enabled?'frontier':'previous',{...measurements.find(v=>v.enabled===enabled),elapsedMsMedian:median(measurements.filter(v=>v.enabled===enabled).map(v=>v.elapsedMs))}]));
assert.ok(summary.frontier.htmlParseCharacters<summary.previous.htmlParseCharacters/5);
assert.ok(summary.frontier.signatureCharacters<summary.previous.signatureCharacters/5);
const report={runtime:process.version,platform:process.platform,arch:process.arch,dom:'linkedom 0.18.12 in temporary test-only prefix',boundary:'Production Markdown renderer, CitationEvidence decoration, DOM parsing and patch CPU. Excludes model/network/WebKit layout/paint/native FPS. Disabled helper is the previous complete-DOM path.',checks,fixtureCharacters:markdown.length,measurements,summary};
fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(summary,null,2));
