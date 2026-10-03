/* Production renderer/recorder/patch integration; synthetic content only.
 * No model, user state, browser/App, or native performance claim. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.AIBRO_FLOW_RESULT_DIR;
const measurements = {};
let measuring = null;
const prototype = parseHTML('<html></html>').window.Element.prototype;
const htmlProperty = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
Object.defineProperty(prototype, 'innerHTML', { ...htmlProperty, set(value) {
  if (measuring && this.classList.contains('conversation-flow-text')) { measuring.htmlWrites++; measuring.htmlCharacters += value.length; }
  htmlProperty.set.call(this, value);
} });
const source = (file, baseline) => fs.readFileSync(baseline && fs.existsSync(path.join(baseline, file)) ? path.join(baseline, file) : path.join(ROOT, 'app', file), 'utf8');
function fixture(baseline) {
  const { window, document } = parseHTML('<html><body></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
  let focus = document.body, selection = null;
  window.HTMLElement.prototype.focus = function() { focus = this; };
  Object.defineProperty(document, 'activeElement', { get: () => focus });
  // Linkedom omits the Range UTF-16 methods used by the production code path.
  document.createRange = () => { let element, end, offset; return {
    selectNodeContents(value) { element = value; }, setEnd(value, at) { end = value; offset = at; },
    toString() { let value = '', walker = document.createTreeWalker(element, 4), node;
      while (node = walker.nextNode()) { if (node === end) return value + node.nodeValue.slice(0, offset); value += node.nodeValue; }
      if (end === element) return [...element.childNodes].slice(0, offset).map(node => node.textContent).join('');
      throw new Error('Missing fixture selection endpoint'); },
  }; };
  const env = { document, URL, MutationObserver: window.MutationObserver, NodeFilter: { SHOW_TEXT: 4 }, console,
    getSelection: () => selection, WorkstationI18n: { getLanguage: () => 'zh' },
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    MathRender: { ...require('../app/math-render.js') }, CodeHighlight: { ...require('../app/code-highlight.js') },
    ConversationLink: { ...require('../app/conversation-link.js') }, state: {} };
  env.window = env; vm.createContext(env);
  for (const file of ['conversation-flow.js','conversation-stream-body.js','stream-code.js','stream-markdown.js','streaming-body.js','tool-scheduler.js','agent-progress.js','conversation-process.js']) vm.runInContext(source(file, baseline), env);
  const app = source('app.js', baseline), parser = app.slice(app.indexOf('function renderRichText('), app.indexOf('\nfunction renderMessage('));
  const render = vm.runInContext(`(${parser})`, env);
  const metrics = { parses: 0, parserCharacters: 0, htmlWrites: 0, htmlCharacters: 0 };
  const renderer = (text, wiki, cache) => { const html = render(text, wiki, cache);
    if (measuring && !cache?.probeOnly) { metrics.parses++; metrics.parserCharacters += cache?.parsedCharacters ?? text.length; }
    return html; };
  const run = { id:'run-fixture', status:'running', toolCalls:[], delegations:[{id:'child-fixture',title:'Synthetic child'}] };
  const message = { id:'message-fixture', role:'agent', text:'', live:true, steps:[] };
  const flow = env.ConversationFlow.create(message);
  let wrapper = null;
  const api = { env, document, metrics, run, message, flow, render,
    get wrapper() { return wrapper; },
    update(beforeCommit) { measuring = metrics;
      try {
        const next = document.createElement('article'); next.className = 'message-wrap'; next.dataset.messageId = message.id;
        next.innerHTML = env.AgentProgress.markup(message);
        const body = document.createElement('div'); body.className = 'message-body'; body.textContent = message.text; next.append(body);
        env.ConversationProcess.compose(next, message, run, { renderText:renderer, previous:wrapper });
        beforeCommit?.(wrapper, next);
        if (wrapper) { const prior = wrapper; env.AgentProgress.patchLive(prior, next); if (!prior.isConnected) wrapper = next; }
        else { wrapper = next; document.body.append(wrapper); }
      } finally { measuring = null; }
    },
    body(item) { return [...wrapper.querySelectorAll('.conversation-flow-item')].find(row => row.dataset.flowId === item.id)?.querySelector('.conversation-flow-text'); },
    select(node, from=0, to=8) { selection = { rangeCount:1, isCollapsed:false, anchorNode:node, focusNode:node, anchorOffset:from, focusOffset:to,
      getRangeAt() { return { startContainer:this.anchorNode, startOffset:this.anchorOffset }; },
      setBaseAndExtent(a, ao, b, bo) { Object.assign(this, {anchorNode:a,anchorOffset:ao,focusNode:b,focusOffset:bo}); } }; return selection; },
    detach() { wrapper.remove(); wrapper = null; },
  };
  return api;
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map(key => [key, after[key]-before[key]]));
function completed(f, count=6) {
  return Array.from({length:count}, (_, i) => f.flow.response('settled-'+i,
    `Selected paragraph ${i} with a [source](https://example.invalid/${i}).\n\n` + (`Stable **paragraph** ${i} with synthetic material.\n\n`).repeat(36) + `FULL-END-${i}`,
    {status:'completed'}));
}
function statusMeasurement(baseline) {
  const f = fixture(baseline), items = completed(f);
  const call = {id:'tool-fixture',type:'read',status:'running',request:{type:'read',id:'synthetic'},result:{text:'Synthetic output'}};
  f.run.toolCalls.push(call); f.flow.tool(call); f.update(); f.update();
  const bodies=items.map(item=>f.body(item)), paragraphs=bodies.map(body=>body.firstElementChild);
  const selected=paragraphs[0].firstChild, selection=f.select(selected,0,8), link=paragraphs[1].querySelector('a'); link.focus();
  const before={...f.metrics};
  for(let i=0;i<12;i++){call.result.text='Synthetic output '+i;f.update();}
  for(let i=0;i<items.length;i++){assert.equal(f.body(items[i]),bodies[i]);assert.equal(bodies[i].firstElementChild,paragraphs[i]);assert.match(bodies[i].textContent,new RegExp(`FULL-END-${i}$`));}
  assert.equal(selection.anchorNode,selected);assert.equal(selection.anchorOffset,0);assert.equal(selection.focusOffset,8);assert.equal(f.document.activeElement,link);
  return {f,items,measurement:delta(f.metrics,before)};
}
test('more than four completed flow replies perform no parse/HTML reconstruction during twelve real tool updates',()=>{
  const baseline=process.env.AIBRO_FLOW_BASELINE_DIR;
  if(baseline)measurements.before=statusMeasurement(baseline).measurement;
  const {f,measurement}=statusMeasurement();measurements.after=measurement;
  assert.equal(measurement.parses,0);assert.equal(measurement.htmlWrites,0);
  assert.equal(f.env.StreamMarkdown.inspect().entries,0,'completed prose does not occupy the active pool');
  if(baseline){assert.equal(measurements.before.parses,72);assert.ok(measurements.before.htmlCharacters>100000);}
});
test('a growing child reply uses the actual code continuation with six settled siblings and preserves selected UTF-16 text',()=>{
  const f=fixture(),items=completed(f),prefix='Stable header\n\nMiddle\n\nLast\n\n```js\nconst selected = "中😀";\n';
  const item=f.flow.response('child-attempt',prefix,{parentId:'child-fixture'});f.update();f.update();
  const code=f.body(item).querySelector('code'),text=code.firstChild,selection=f.select(text,0,5),oldBodies=items.map(value=>f.body(value));
  const before={...f.metrics};let accumulated=prefix;
  for(let i=0;i<24;i++){accumulated+=`const value${i} = ${i};\n`;f.flow.response('child-attempt',accumulated,{parentId:'child-fixture'});f.update();}
  measurements.liveCode=delta(f.metrics,before);
  assert.equal(measurements.liveCode.parses,0);assert.equal(measurements.liveCode.htmlWrites,0);
  assert.equal(f.body(item).querySelector('code'),code);assert.equal(code.firstChild,text);assert.equal(selection.anchorNode,text);assert.equal(selection.focusOffset,5);
  items.forEach((value,i)=>assert.equal(f.body(value),oldBodies[i]));assert.match(code.textContent,/const value23 = 23;\n$/);
  accumulated+='```\n\nFULL-CHILD-END';f.flow.response('child-attempt',accumulated,{parentId:'child-fixture',status:'completed'});f.update();
  const oracle=f.document.createElement('div');oracle.innerHTML=f.render(accumulated);assert.equal(f.body(item).innerHTML,oracle.innerHTML);
  assert.ok(selection.anchorNode.isConnected);assert.equal(f.env.StreamMarkdown.inspect().entries,0);
});
test('growing prose reuses the production Markdown frontier and retains completed blocks beside settled flow siblings',()=>{
  const f=fixture();completed(f);let text='# Synthetic child reply\n\n'+('Selected stable paragraph with **formatting**.\n\n').repeat(32)+'Unfinished tail';
  const item=f.flow.response('child-prose',text,{parentId:'child-fixture'});f.update();f.update();
  const body=f.body(item),paragraph=body.children[1],selected=paragraph.firstChild,selection=f.select(selected,0,8),before={...f.metrics};let completeWork=0;
  for(let i=0;i<20;i++){text+='\n\nNext synthetic paragraph '+i+'.';completeWork+=text.length;f.flow.response('child-prose',text,{parentId:'child-fixture'});f.update();}
  measurements.liveProse=delta(f.metrics,before);
  assert.ok(measurements.liveProse.parserCharacters<completeWork/4);assert.ok(measurements.liveProse.htmlCharacters<completeWork/4);
  assert.equal(f.body(item),body);assert.equal(body.children[1],paragraph);assert.equal(paragraph.firstChild,selected);assert.equal(selection.anchorNode,selected);
  const oracle=f.document.createElement('div');oracle.innerHTML=f.render(text);assert.equal(body.innerHTML,oracle.innerHTML);assert.match(body.textContent,/Next synthetic paragraph 19\.$/);
});
test('source corrections, helper changes and foreign DOM writes invalidate settled ownership before commit',()=>{
  const f=fixture(),item=f.flow.response('a','Math $x$\n\nSelected end',{status:'completed'});f.update();
  const previous=f.body(item);f.update();const before=f.metrics.parses;
  f.env.MathRender.inlineMath=()=>'<b>New math renderer</b>';f.update();assert.equal(f.metrics.parses,before+1);assert.match(previous.innerHTML,/New math renderer/);
  f.flow.response('a','Corrected source\n\nFULL-END',{status:'completed'});f.update();assert.equal(f.body(item),previous);assert.match(previous.textContent,/FULL-END$/);
  f.update(()=>{previous.firstElementChild.textContent='foreign content';});assert.equal(previous.firstElementChild.textContent,'Corrected source');
  const beforeClear=f.metrics.parses;f.env.StreamMarkdown.clear();f.update();assert.equal(f.metrics.parses,beforeClear+1);assert.match(previous.textContent,/FULL-END$/);
});
test('completion and cancellation retain complete prose and release parser owners; detached messages do not reuse stale bodies',()=>{
  for(const status of ['completed','cancelled']){
    const f=fixture(),items=completed(f),live=f.flow.response('child','A live partial answer\n\nFULL-PARTIAL-END',{parentId:'child-fixture'});f.update();f.update();
    const stable=f.body(items[0]),partial=f.body(live);f.flow.finish(status);f.message.live=false;f.run.status=status;f.update();
    assert.equal(f.body(items[0]),stable);assert.equal(f.body(live),partial);assert.match(partial.textContent,/FULL-PARTIAL-END$/);assert.equal(f.env.StreamMarkdown.inspect().entries,0);
    const before=f.metrics.parses;f.update();assert.equal(f.metrics.parses,before);
    f.detach();f.update();assert.notEqual(f.body(items[0]),stable);assert.equal(stable.isConnected,false);assert.match(f.body(live).textContent,/FULL-PARTIAL-END$/);
  }
});
test.after(()=>{if(OUT){fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'measurements.json'),JSON.stringify({boundary:'Actual production recorder, Markdown parser, flow composition and patch; synthetic Linkedom. Not WebKit paint or model latency.',measurements},null,2)+'\n');}});
