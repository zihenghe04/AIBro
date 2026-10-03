'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const R = require('../app/context-retrieval'), K = require('../app/knowledge-access'), V = require('../app/vector-index');
const fixture = () => ({
  projects: [{id:'study',name:'Fictional study',workspace:'科研'},{id:'other',name:'Other project',workspace:'科研'}],
  notes: [{id:'target',projectId:'study',title:'阅读记录 07',tags:['候车心理'],content:'Perceived delay can differ from elapsed time.'}],
});
const scope = {projectId:'study'}, query = '之前关于候车心理的内容';
const ids = result => result.entries.map(e => e.recordId);
const template = () => '# 阅读记录 07\n\n> 实验 · 观察、推断与待验证结论分开记录。\n\n## 实验假设\n\nPerceived delay can differ from elapsed time. Synthetic test note.\n\n'
  + ['设置与对照','代码与数据版本','指标与结果','解释与局限','已有观察与依据','推断与待验证结论','矛盾、失效结论与适用边界','下一步与开放问题'].map(title=>`## ${title}\n\n未记录。`).join('\n\n');
const tagBasis = tags => ({fields:['tags'],tags,mode:'metadata-discovery'});

test('a remembered concept finds a saved tag without mistaking it for body evidence', async () => {
  const state=fixture(), before=JSON.stringify(state);
  state.notes.push({id:'noise',projectId:'study',title:'阅读记录 08',content:'A fictional nutrition experiment.'});
  const result=await K.execute(state,scope,{type:'search',query});
  assert.deepEqual(result.entries.map(e=>e.id),['target']);
  assert.deepEqual(result.entries[0].matchBasis,tagBasis(['候车心理']));
  assert.equal(result.entries[0].excerpt,state.notes[0].content);
  assert.equal(result.contentRead,false);
  const read=await K.execute(state,scope,{type:'read',id:'target'});
  assert.equal(read.text,state.notes[0].content);
  state.notes.pop();assert.equal(JSON.stringify(state),before);
});

test('in-place tag rename and clearing invalidate postings and old neighbor versions', () => {
  const state=fixture(), first=R.searchIndex(state,{...scope,query}).entries[0];
  assert.ok(first);
  state.notes[0].tags[0]='通勤感知';
  assert.deepEqual(ids(R.searchIndex(state,{...scope,query})),[]);
  const next=R.searchIndex(state,{...scope,query:'通勤感知'}).entries[0];
  assert.equal(next.recordId,'target');assert.notEqual(next.version,first.version);
  assert.throws(()=>R.neighbors(state,scope,{chunkId:first.id,version:first.version}),/更新/);
  state.notes[0].tags=[];
  assert.deepEqual(ids(R.searchIndex(state,{...scope,query:'通勤感知'})),[]);
  assert.equal(R.searchIndex(state,{...scope,query:'elapsed'}).entries[0].text,state.notes[0].content);
});

test('legacy string tags work; invalid values never stringify into searchable concepts', () => {
  const state=fixture();state.notes[0].tags=' 候车心理 ';
  assert.deepEqual(ids(R.searchIndex(state,{...scope,query})),['target']);
  state.notes[0].tags=['候车心理',' 候车心理 ',null,{},['NEVER_NESTED'],19,false];
  const entry=R.searchIndex(state,{...scope,query}).entries[0];
  assert.deepEqual(entry.tags,['候车心理']);
  for(const invalid of ['object','NEVER_NESTED','19'])assert.deepEqual(ids(R.searchIndex(state,{...scope,query:invalid})),[]);
  state.notes[0].tags={concept:'候车心理'};
  assert.deepEqual(ids(R.searchIndex(state,{...scope,query})),[]);
});

test('tag-only PDFs stay metadata-only; paper edits remain the actual returned body', async () => {
  const state=fixture();state.notes=[];
  state.imports=[{id:'pdf',projectId:'study',title:'Scan 04',tags:['候车心理'],rawBase64:'NEVER_READ_FILE_BYTES'}];
  state.papers=[{id:'paper',projectId:'study',title:'Study 09',tags:['候车心理'],structured:{methods:{text:'Earlier hypothesis'}},userEdits:{methods:{text:'Corrected method',citations:[{attachmentId:'pdf',page:2}]}}}];
  const result=R.searchIndex(state,{...scope,query});
  assert.equal(result.coverage.metadataOnlyRecords,1);assert.equal(result.coverage.textIndexedRecords,1);
  const pdf=result.entries.find(e=>e.type==='import');assert.equal(pdf.text,'');assert.deepEqual(pdf.matchBasis.fields,['tags']);
  const paper=result.entries.find(e=>e.type==='paper');assert.equal(paper.text,'Corrected method');assert.equal(paper.page,2);
  assert.doesNotMatch(JSON.stringify(result),/NEVER_READ_FILE_BYTES|Earlier hypothesis/);
  const read=await K.execute(state,scope,{type:'read',recordType:'import',id:'pdf'});
  assert.equal(read.text,'');assert.match(read.hint,/read_page/);
});

test('concept tags cannot widen project, private, provenance, deleted or task scopes', () => {
  const state=fixture();
  state.notes.push(...[
    {id:'foreign',projectId:'other'}, {id:'private',projectId:'study',private:true},
    {id:'deleted',projectId:'study',deletedAt:1}, {id:'origin',projectId:'study',provenance:{origin:{private:true}}},
  ].map(item=>({...item,title:'NEVER_EXPOSE_'+item.id,tags:['候车心理'],content:'NEVER_EXPOSE_BODY'})));
  state.tasks=[{id:'task',projectId:'study',title:'NEVER_EXPOSE_TASK',tags:['候车心理']}];
  const result=R.searchIndex(state,{...scope,query,allowedTaskIds:[]});
  assert.deepEqual(ids(result),['target']);assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE/);
  state.notes[0].private=true;
  assert.equal(R.searchIndex(state,{...scope,query,allowedTaskIds:[]}).entries.length,0);
});

test('tag-only updates do not change the embedding input or schedule a corpus re-embedding', async () => {
  const state=fixture(), before=await V.snapshot(state,scope);
  state.notes[0].tags=['通勤感知'];
  const after=await V.snapshot(state,scope);
  assert.equal(after[0].input,before[0].input);assert.equal(after[0].hash,before[0].hash);
  assert.notEqual(after[0].version,before[0].version);
});

test('a long tag cannot displace searchable body text or later saved tags', () => {
  const state=fixture();state.notes[0].tags=['oldtopic '.repeat(500),'候车心理'];
  assert.deepEqual(ids(R.searchIndex(state,{...scope,query})),['target']);
  const result=R.searchIndex(state,{...scope,query:'elapsed'});
  assert.deepEqual(ids(result),['target']);assert.deepEqual(result.entries[0].matchBasis,{fields:['body']});
});

test('healthy hybrid search does not keep a tag-only match removed during provider await', async () => {
  const state=fixture(), cfg=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:true});
  const rows=(await V.snapshot(state)).map(e=>({id:e.id,hash:e.hash,vector:[1,0]}));
  let resolve, started;const pending=new Promise(r=>{resolve=r;}), waiting=new Promise(r=>{started=r;});
  const engine=V.create({getState:()=>state,store:{load:async()=>rows,write(){throw Error('Read only');}},embed:async()=>{started();return pending;}});
  const result=engine.search(cfg,query,scope);await waiting;
  state.notes[0].tags=[];resolve([[0,1]]);
  assert.deepEqual(ids(await result),[]);
});

test('healthy hybrid results report only current keyword evidence beside semantic rankings', async () => {
  const state=fixture(), cfg=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:true});
  const rows=(await V.snapshot(state)).map(e=>({id:e.id,hash:e.hash,vector:[1,0]}));
  const engine=V.create({getState:()=>state,store:{load:async()=>rows,write(){throw Error('Read only');}},embed:async()=>[[0,1]]});
  const result=await engine.search(cfg,query,scope);
  assert.deepEqual(ids(result),['target']);assert.deepEqual(result.entries[0].matchBasis,tagBasis(['候车心理']));
});

// Exercise the actual Agent wrapper with the real engine and an isolated,
// credential-free fake transport. No app session, network or durable store.
async function wrapperFixture({reject=true}={}) {
  const state=fixture(), nodes=new Map(), calls=[];
  state.notes.push({id:'hidden',projectId:'study',private:true,title:'NEVER_EXPOSE',tags:['候车心理'],content:'NEVER_EXPOSE'});
  const node=(id='')=>{
    const value={id,value:'',checked:false,hidden:false,disabled:false,textContent:'',append(child){nodes.set(child.id,child);},querySelectorAll(){return [];},addEventListener(){}};
    Object.defineProperty(value,'innerHTML',{set(html){for(const m of html.matchAll(/\bid="([^"]+)"/g))nodes.set(m[1],node(m[1]));}});
    return value;
  };
  nodes.set('settings',node('settings'));
  const config=V.configuration({base:'https://fixture.invalid/v1',model:'synthetic',enabled:true,noKey:true});
  const rows=(await V.snapshot(state)).map(e=>({id:e.id,hash:e.hash,vector:[1,0]}));
  const context={document:{getElementById:id=>nodes.get(id)||null,createElement:()=>node()},
    localStorage:{getItem:()=>JSON.stringify(config),setItem(){throw Error('No configuration writes');}},
    ContextRetrieval:R,VectorIndex:V,AbortController,setTimeout,clearTimeout,
    workstationDesktop:{vectorIndex:{load:async()=>rows,write(){throw Error('No vector writes');}}},
    fetch:async(url,options)=>{calls.push({url,options});return reject?{ok:false,status:401}:{ok:true,json:async()=>({data:[{index:0,embedding:[0,1]}]})};},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/vector-knowledge-ui'),'utf8'),context);
  context.VectorKnowledge.init({getState:()=>state,isBusy:()=>false});
  return {state,calls,api:context.VectorKnowledge};
}

test('provider unavailable fallback finds the concept but still reports unavailable and unread', async () => {
  const f=await wrapperFixture(),result=await f.api.searchRequest(f.state,scope,{type:'search',query});
  assert.equal(result.strategy,'local-bm25');assert.equal(result.semanticStatus,'unavailable');
  assert.match(result.coverage.semanticError,/认证失败/);assert.equal(result.contentRead,false);
  assert.deepEqual(Array.from(result.entries,e=>e.id),['target']);
  assert.deepEqual(result.entries[0].matchBasis,tagBasis(['候车心理']));
  assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE/);assert.equal(f.calls.length,1);
  const context=await f.api.retrieve(f.state,{...scope,query});
  assert.match(context.text,/语义检索不可用/);assert.match(context.text,/不能声称已进行语义检索/);
  assert.equal(context.entries[0].text,f.state.notes[0].content);
  const noMatch=await f.api.searchRequest(f.state,scope,{type:'search',query:'内容中完全没有的概念xyz'});
  assert.equal(noMatch.total,0);assert.equal(noMatch.semanticStatus,'unavailable');
});

test('healthy wrapper preserves the distinction between tag matching and semantic availability', async () => {
  const f=await wrapperFixture({reject:false}),result=await f.api.searchRequest(f.state,scope,{type:'search',query});
  assert.equal(result.strategy,'hybrid-rrf');assert.equal(result.semanticStatus,'ready');
  assert.deepEqual(Array.from(result.entries,e=>e.id),['target']);assert.equal(result.contentRead,false);
  assert.deepEqual(result.entries[0].matchBasis,tagBasis(['候车心理']));
});

test('ten-section templates yield one stable tag-discovery entry, not ten placeholder hits', async () => {
  const state=fixture();state.notes[0].content=template();state.notes[0].tags=['雨廊候车'];
  const chunks=R.indexEntries(state,scope);assert.equal(chunks.length,10);
  const result=await K.execute(state,scope,{type:'search',query:'雨廊候车'});
  assert.equal(result.total,1);assert.equal(result.nextOffset,null);assert.equal(result.coverage.indexedChunks,10);
  assert.equal(result.contentRead,false);assert.equal(result.entries[0].chunkId,chunks[0].id);
  assert.equal(result.entries[0].chunkOffset,0);assert.equal(result.entries[0].excerpt,chunks[0].text);
  assert.deepEqual(result.entries[0].matchBasis,tagBasis(['雨廊候车']));
  // A later placeholder becoming even shorter must not take over the record entry.
  state.notes[0].content=state.notes[0].content.replace('## 指标与结果\n\n未记录。','## 指标\n');
  assert.equal(R.searchIndex(state,{...scope,query:'雨廊候车'}).entries[0].offset,0);
  const read=await K.execute(state,scope,{type:'read',id:'target'});
  assert.equal(read.text,state.notes[0].content);assert.match(read.text,/Perceived delay/);
});

test('real body and heading hits replace tag-only siblings without losing offsets or citations', async () => {
  const state=fixture();state.notes[0].content=template();state.notes[0].tags=['雨廊候车'];
  state.notes.push({id:'second',projectId:'study',title:'Reading 08',tags:['雨廊候车'],content:'# Notes\nA different fictional subject.\n## Placeholder\nNot yet recorded.'});
  const result=R.searchIndex(state,{...scope,query:'雨廊候车 elapsed 假设'});
  const own=result.entries.filter(e=>e.recordId==='target');assert.equal(own.length,1);
  assert.ok(own[0].matchBasis.fields.includes('body'));assert.ok(own[0].matchBasis.fields.includes('heading'));
  assert.equal(own[0].matchBasis.mode,undefined);assert.match(own[0].text,/Perceived delay/);
  assert.equal(state.notes[0].content.slice(own[0].offset,own[0].end),own[0].text);
  assert.equal(result.entries.filter(e=>e.recordId==='second').length,1);
  assert.equal(result.entries.find(e=>e.recordId==='second').matchBasis.mode,'metadata-discovery');
  state.papers=[{id:'target',projectId:'study',title:'Study 09',tags:['雨廊候车'],structured:{methods:{text:'Elapsed minutes.',citations:[{attachmentId:'pdf',page:2}]},limitations:{text:'More elapsed minutes.',citations:[{attachmentId:'pdf',page:3}]},abstract:{text:'Not yet recorded.'}}}];
  const paper=R.searchIndex(state,{...scope,query:'雨廊候车 elapsed'}).entries.filter(e=>e.type==='paper');
  assert.equal(paper.length,2);assert.deepEqual(paper.map(e=>e.page).sort(),[2,3]);
  assert.ok(paper.every(e=>e.matchBasis.fields.includes('body')&&e.sourceAttachmentIds.includes('pdf')));
});

test('many tag-discovered records paginate once each while keeping the full source index', async () => {
  const state=fixture();state.notes=Array.from({length:45},(_,i)=>({id:'n'+i,projectId:'study',title:'Reading '+i,tags:['雨廊候车'],content:template()}));
  const found=[];let offset=0,pages=0;
  do {
    const page=await K.execute(state,scope,{type:'search',query:'雨廊候车',offset,maxTokens:1200});pages++;
    assert.equal(page.total,45);assert.equal(page.coverage.indexedChunks,450);assert.equal(page.contentRead,false);
    for(const row of page.entries){assert.equal(row.chunkOffset,0);assert.equal(row.matchBasis.mode,'metadata-discovery');found.push(row.id);}
    offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(found.length,45);assert.equal(new Set(found).size,45);
  assert.ok(pages>1);
  assert.deepEqual(new Set(found),new Set(state.notes.map(n=>n.id)));
});
