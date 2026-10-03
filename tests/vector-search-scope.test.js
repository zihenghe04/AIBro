'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../app/context-retrieval');
const V = require('../app/vector-index');

// Exercise the actual settings/Agent wrapper with an isolated DOM and local
// engine fixture. No provider, credentials or persistent user settings exist.
function fixture(search, enabled = true) {
  const nodes = new Map(), searches = [];
  function element(id = '') {
    const node = {id, value:'', checked:false, hidden:false, disabled:false,
      append(child) { nodes.set(child.id, child); }, querySelectorAll() { return []; },
      addEventListener() {}};
    Object.defineProperty(node, 'innerHTML', {set(html) {
      for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element(match[1]));
    }});
    return node;
  }
  nodes.set('settings', element('settings'));
  const state = {projects:[{id:'course',name:'交互设计方法',workspace:'课程'},{id:'other',name:'其他课程项目',workspace:'课程'}], notes:[
    {id:'daily',title:'随记',content:'日常内容',workspace:'日常'},
    {id:'target',title:'第一讲',content:'保留的原文',workspace:'课程',projectId:'course'},
    {id:'foreign',title:'第一讲',content:'NEVER_EXPOSE',workspace:'课程',projectId:'other'},
  ]};
  const scope = R.createReadScope(state, {workspace:'日常'}, '请查看课程项目“交互设计方法”');
  const config = {base:'https://fixture.invalid/v1',model:'fixture',enabled,autoUpdate:false,noKey:true};
  const context = {
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>element()},
    localStorage:{getItem:()=>JSON.stringify(config),setItem:()=>{throw Error('Unexpected settings mutation');}},
    ContextRetrieval:R,
    VectorIndex:{configuration:V.configuration,validate:V.validate,create:()=>({
      status:async()=>({total:0,ready:0,pending:0}),
      search:async(...args)=>{searches.push(args);return search(state, ...args);},
    })},
    workstationDesktop:{vectorIndex:{}}, AbortController, setTimeout:()=>0, clearTimeout(){},
    fetch:()=>{throw Error('Network must not be used');},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/vector-knowledge-ui'),'utf8'),context);
  context.VectorKnowledge.init({getState:()=>state,isBusy:()=>false});
  return {api:context.VectorKnowledge,state,scope,nodes,searches};
}

test('hybrid search exposes the same current scope and empty-result diagnosis even without indexed vectors', async () => {
  const f=fixture(()=>({entries:[],coverage:{strategy:'hybrid-rrf',semanticStatus:'not-indexed',totalChunks:0,offset:0,nextOffset:null}}));
  const result=await f.api.searchRequest(f.state,f.scope,{type:'search',query:'不存在的检索词'});
  assert.equal(f.searches.length,1);
  assert.deepEqual(f.searches[0][2].readProjects,f.scope.readProjects);
  assert.equal(result.strategy,'hybrid-rrf');assert.equal(result.semanticStatus,'not-indexed');
  assert.deepEqual(result.scope,R.readScopeSummary(f.state,f.scope));
  assert.deepEqual(result.coverage.scope,result.scope);
  assert.match(result.hint,/当前可读范围内未命中/);assert.match(result.hint,/不会扩大范围/);
  assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE|其他课程项目/);
});

test('unavailable semantic search falls back to scoped lexical results and says which strategy actually ran', async () => {
  const f=fixture(()=>{throw Error('Synthetic embedding unavailable');});
  const result=await f.api.searchRequest(f.state,f.scope,{type:'search',query:'交互设计方法'});
  assert.equal(result.strategy,'local-bm25');assert.equal(result.semanticStatus,'unavailable');
  assert.deepEqual(Array.from(result.entries,x=>x.id),['target']);
  assert.equal(result.entries[0].excerpt,'保留的原文');assert.equal(result.contentRead,false);
  assert.deepEqual(result.scope.explicitProjects,[{id:'course',name:'交互设计方法',workspace:'课程'}]);
  assert.match(result.hint,/命中段落不等于已读全文/);
  const empty=await f.api.searchRequest(f.state,f.scope,{type:'search',query:'UNMATCHABLE_TERM'});
  assert.equal(empty.total,0);assert.equal(empty.semanticStatus,'unavailable');assert.match(empty.hint,/不代表全库不存在/);
});

test('search wrapper preserves cancellation and retains the ordinary lexical route when hybrid is disabled', async () => {
  const f=fixture(()=>{throw Object.assign(Error('cancelled'),{code:'CANCELLED'});});
  await assert.rejects(f.api.searchRequest(f.state,f.scope,{type:'search',query:'第一讲'}),{code:'CANCELLED'});
  const disabled=fixture(()=>{throw Error('Disabled engine should not run');},false);
  assert.equal(await disabled.api.searchRequest(disabled.state,disabled.scope,{type:'search',query:'第一讲'}),null);
  assert.equal(await f.api.searchRequest(f.state,f.scope,{type:'list'}),null);
  assert.equal(disabled.searches.length,0);
});
