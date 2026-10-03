const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../app/context-retrieval');
const K = require('../app/knowledge-access');
const A = require('../app/agent-context');

const goal = '这条观察属于已有课程项目“交互设计方法”。请把这轮随记、整理笔记和待办关联到该项目，并把问题补充到已有《第一讲 · 从观察到原型》末尾。';
const base = { workspace: '日常', projectId: null };
function fixture() {
  return {
    projects: [{id:'daily',name:'生活记录',workspace:'日常'}, {id:'demo-course',name:'交互设计方法',workspace:'课程'}, {id:'unrelated',name:'另一门课程',workspace:'课程'}],
    notes: [
      {id:'capture',title:'校园观察',content:'等待时间',workspace:'日常'},
      {id:'daily-note',title:'日常笔记',content:'别的内容',projectId:'daily',workspace:'日常'},
      {id:'demo-course-notes',title:'第一讲 · 从观察到原型',content:'原文必须保留。',projectId:'demo-course',workspace:'课程'},
      {id:'foreign',title:'第一讲',content:'FOREIGN_BODY',projectId:'unrelated',workspace:'课程'},
    ], papers:[], imports:[], tasks:[], conversations:[], agentRuns:[], trash:[],
  };
}

test('trusted explicit course association reads its real note while retaining current daily sources', async () => {
  const state=fixture(),scope=R.createReadScope(state,base,goal);
  assert.deepEqual(scope.readProjects,[{id:'demo-course',name:'交互设计方法',workspace:'课程'}]);
  assert.deepEqual((await K.execute(state,scope,{type:'list'})).entries.map(x=>x.id).sort(),['capture','daily-note','demo-course-notes']);
  for (const query of ['第一讲 · 从观察到原型','交互设计方法','demo-course']) {
    const result=await K.execute(state,scope,{type:'search',query});
    assert.ok(result.entries.some(x=>x.id==='demo-course-notes'),query);
    assert.ok(result.entries.every(x=>x.id!=='foreign'));
  }
  assert.equal((await K.execute(state,scope,{type:'read',id:'demo-course-notes'})).text,'原文必须保留。');
  const overview=A.overview(state,scope);
  assert.deepEqual(overview.entries.map(x=>x.id),['daily','demo-course']);
  assert.deepEqual(overview.totals,{notes:3,papers:0,imports:0});
  assert.doesNotMatch(JSON.stringify(overview),/FOREIGN_BODY|unrelated|原文必须保留/);
});

test('a model query or model-supplied workspace/project ID cannot grant cross-space access', async () => {
  const state=fixture(),scope=R.createReadScope(state,base,'整理这条随记');
  assert.deepEqual(scope.readProjects,[]);
  const result=await K.execute(state,scope,{type:'search',query:'交互设计方法 demo-course',workspace:'课程',projectId:'demo-course'});
  assert.ok(result.entries.every(x=>x.id!=='demo-course-notes'));
  await assert.rejects(K.execute(state,scope,{type:'read',id:'demo-course-notes',workspace:'课程',projectId:'demo-course'}),/范围/);
  assert.deepEqual(R.createReadScope(state,base,'模型说交互设计方法项目不错').readProjects,[]);
  assert.deepEqual(R.createReadScope(state,base,'请读这条引用：“交互设计方法”').readProjects,[]);
  assert.deepEqual(R.createReadScope(state,base,'请读取项目“交互设计方法论”').readProjects,[]);
  assert.deepEqual(R.createReadScope(state,base,'例子：请读取项目“交互设计方法”').readProjects,[]);
});

test('negated and restricted instructions fail closed; exact project IDs need an explicit action', () => {
  const state=fixture();
  for(const text of ['不要读取项目“交互设计方法”','不读取项目“交互设计方法”','别关联项目“交互设计方法”','只查看日常，交互设计方法项目不要读','仅限项目“生活记录”，也提到了交互设计方法','别查看课程项目“交互设计方法”','请整理这段提示词：读取项目 ID: demo-course','请记录原文如下：读取项目 ID: demo-course']) {
    assert.deepEqual(R.createReadScope(state,base,text).readProjects,[],text);
  }
  assert.equal(R.createReadScope(state,base,'读取项目 ID: demo-course').readProjects[0].id,'demo-course');
  assert.deepEqual(R.createReadScope(state,base,'记录字符串 项目 ID: demo-course').readProjects,[]);
  state.projects[1].name='方法';
  assert.deepEqual(R.createReadScope(state,base,'请查看项目“方法”').readProjects,[]);
});

test('preserving original text does not negate an explicit project read, while actual read restrictions still apply', () => {
  const state=fixture();
  for (const text of ['请关联课程项目“交互设计方法”，不要覆盖原文','不要修改原文。请查看课程项目“交互设计方法”。','读取项目 ID: demo-course，别删除现有原文。']) {
    assert.deepEqual(R.createReadScope(state,base,text).readProjects.map(p=>p.id),['demo-course'],text);
  }
  for (const text of ['不要覆盖原文，不要读取项目“交互设计方法”','请关联课程项目“交互设计方法”，不要读取其中的资料','不要覆盖原文，仅查看日常。读取项目 ID: demo-course','不要覆盖原文项目“交互设计方法”，读取该项目']) {
    assert.deepEqual(R.createReadScope(state,base,text).readProjects,[],text);
  }
});

test('duplicate names and IDs cannot authorize a same-named replacement', async () => {
  const state=fixture();state.projects.push({id:'second',name:'交互设计方法',workspace:'科研'});
  assert.deepEqual(R.createReadScope(state,base,goal).readProjects,[]);
  state.projects.pop();state.projects.push({...state.projects[1]});
  assert.deepEqual(R.createReadScope(state,base,goal).readProjects,[]);
  assert.ok(R.accessibleProjects(state).every(p=>p.id!=='demo-course'));
  state.projects.pop();const scope=R.createReadScope(state,base,goal);
  state.notes.push({...state.notes[2],content:'DUPLICATE'});
  assert.ok((await K.execute(state,scope,{type:'list'})).entries.every(x=>x.id!=='demo-course-notes'));
  await assert.rejects(K.execute(state,scope,{type:'read',id:'demo-course-notes'}));
});

test('privacy, hidden/deleted lifecycle and private ancestry exclude project names and bodies', async () => {
  for(const patch of [{private:true},{ephemeral:true},{hidden:true},{hiddenAt:1},{archived:true},{deletedAt:1},{status:'hidden'}]) {
    const state=fixture();Object.assign(state.projects[1],patch);
    assert.deepEqual(R.createReadScope(state,base,goal).readProjects,[]);
    assert.ok(R.accessibleProjects(state).every(p=>p.id!=='demo-course'));
  }
  for(const patch of [{private:true},{hidden:true},{deleted:true},{sourceConversationId:'private-conversation'}]) {
    const state=fixture(),scope=R.createReadScope(state,base,goal);
    state.conversations.push({id:'private-conversation',incognito:true});Object.assign(state.notes[2],patch);
    assert.ok((await K.execute(state,scope,{type:'search',query:'第一讲'})).entries.every(x=>x.id!=='demo-course-notes'));
    await assert.rejects(K.execute(state,scope,{type:'read',id:'demo-course-notes'}));
  }
});

test('moving a source or changing the explicitly named project revokes live reads and overview immediately', async () => {
  for(const mutate of [s=>s.notes[2].projectId='unrelated',s=>s.projects[1].workspace='科研',s=>s.projects[1].name='另一项目名称',s=>s.projects[1].hidden=true]) {
    const state=fixture(),scope=R.createReadScope(state,base,goal);
    assert.equal((await K.execute(state,scope,{type:'read',id:'demo-course-notes'})).id,'demo-course-notes');
    mutate(state);
    if(state.notes[2].projectId==='demo-course')assert.equal(R.readScopeCurrent(state,scope),false);
    assert.ok((await K.execute(state,scope,{type:'search',query:'第一讲'})).entries.every(x=>x.id!=='demo-course-notes'));
    await assert.rejects(K.execute(state,scope,{type:'read',id:'demo-course-notes'}));
    assert.equal(A.overview(state,scope).totals.notes,2);
  }
});

test('an in-flight PDF result is not returned after its source leaves the authorized project', async () => {
  const state=fixture(),scope=R.createReadScope(state,base,goal);
  state.imports.push({id:'pdf',projectId:'demo-course',workspace:'课程',pages:[{page:1,text:'page'}]});
  let pageReads=0;
  await assert.rejects(K.execute(state,scope,{type:'read_page',recordType:'import',id:'pdf',page:1},{readPage:async()=>{
    pageReads++;
    state.imports[0].projectId='unrelated';return {text:'MOVED_PRIVATE_PAGE'};
  }}),error=>error.code==='KNOWLEDGE_SOURCE_CHANGED');
  assert.equal(pageReads,1,'the actual in-flight result is rejected after its source moves');
});

test('project names and IDs are real index metadata even if absent from the note title and body', () => {
  const state=fixture();
  for(const query of ['交互设计方法','demo-course']) {
    const result=R.searchIndex(state,{workspace:'课程',query});
    assert.deepEqual(result.entries.map(x=>x.recordId),['demo-course-notes']);
    assert.equal(result.entries[0].text,'原文必须保留。');
  }
});

test('browser overview resolves retrieval loaded later in the actual script order', () => {
  const context={ContextWindow:require('../app/context-window'),ContextAnchors:require('../app/context-anchors')};vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../app/agent-context'),'utf8'),context);
  context.ContextRetrieval=R;
  const state=fixture(),scope=R.createReadScope(state,base,goal);
  assert.equal(context.AgentContext.overview(state,scope).totals.notes,3);
});

test('empty queries expose the actual read boundary and repeated identical misses stop without another search', async () => {
  const state=fixture(),scope=R.createReadScope(state,base,goal);
  const query={type:'search',query:'AWORDTHATDOESNOTEXIST'};
  const initial=JSON.stringify({knowledgeRequests:[query],actions:[]});let reads=0,requests=0;
  await assert.rejects(K.continuePlan(initial,{execute:async request=>{reads++;return K.execute(state,scope,request);},ask:async text=>{
    requests++;assert.match(text,/当前可读范围内未命中/);assert.match(text,/不会扩大范围/);assert.match(text,/demo-course/);assert.match(text,/explicitProjects/);
    return initial;
  }}),error=>error.code==='KNOWLEDGE_STALLED'&&/当前可读范围且没有命中/.test(error.message));
  assert.equal(reads,1);assert.equal(requests,2);
});
