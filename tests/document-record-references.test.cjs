'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Wiki = require('../app/research-wiki.js');
const Origin = require('../app/document-origin.js');
const options = { resolveOrigin: Origin.resolve };
const fixture = () => ({
  projects: [{ id:'p', name:'交互设计方法', workspace:'课程' }],
  notes: [{ id:'owner', title:'整理结果', content:'[note:n] [task:t] [project:p]' }, { id:'n', title:'原始观察', projectId:'p' }],
  tasks: [{ id:'t', title:'继续观察', projectId:'p' }], conversations: [], agentRuns: [], trash: [], ui: {},
});

test('typed references resolve live titles across workspaces without mutating source content', () => {
  const state = fixture(), before = JSON.stringify(state);
  for (const [target, title] of [['note:n','原始观察'], ['task:t','继续观察'], ['project:p','交互设计方法']]) {
    const [kind,id] = target.split(':');
    assert.deepEqual(Wiki.resolveReference(state,'owner',target,options), { kind,id,title });
  }
  assert.equal(JSON.stringify(state), before);
  state.notes[1].title = '修订后的标题';
  assert.equal(Wiki.resolveReference(state,'owner','note:n',options).title, '修订后的标题');
});

test('typed references inherit the real document access gate for hidden, retired, private and duplicate records', () => {
  for (const [kind, collection, id] of [['note','notes','n'], ['task','tasks','t'], ['project','projects','p']]) {
    for (const flag of ['hidden','hiddenAt','deleted','deletedAt','archived','archivedAt','private','ephemeral','incognito','tombstone','wikiFileError']) {
      const state = fixture(); state[collection].find(x=>x.id===id)[flag] = true;
      assert.equal(Wiki.resolveReference(state,'owner',`${kind}:${id}`,options), null, `${kind}:${flag}`);
    }
    const state = fixture(); state[collection].push({ ...state[collection].find(x=>x.id===id) });
    assert.equal(Wiki.resolveReference(state,'owner',`${kind}:${id}`,options), null, `${kind}:ambiguous`);
  }
  for (const target of ['note:n','task:t']) {
    const state = fixture(); state.projects[0].hidden = true;
    assert.equal(Wiki.resolveReference(state,'owner',target,options), null, 'A hidden parent cannot reveal the child title');
  }
  const privateOwner = fixture(); privateOwner.notes[1].sourceConversationId = 'secret'; privateOwner.conversations.push({ id:'secret', private:true, deletedAt:1 });
  assert.equal(Wiki.resolveReference(privateOwner,'owner','note:n',options), null);
  const retired = fixture(); retired.trash.push({ data:{ notes:[{ id:'n' }] } });
  assert.equal(Wiki.resolveReference(retired,'owner','note:n',options), null);
  const removedOwner = fixture(); removedOwner.notes[0].hidden = true;
  assert.equal(Wiki.resolveReference(removedOwner,'owner','note:n',options), null);
  assert.equal(Wiki.resolveReference(fixture(),'owner','note:n',{ ...options,privateMode:true }), null);
});

test('malformed references and absent access infrastructure fail closed', () => {
  for (const target of ['note:','[note:n]','note:../n','task:n\n','project:n"bad','import:n','https://example.org','NOTE:n']) assert.equal(Wiki.resolveReference(fixture(),'owner',target,options), null);
  assert.equal(Wiki.resolveReference(fixture(),'owner','note:n'), null);
  assert.equal(Wiki.resolveReference(fixture(),'owner','note:n',{resolveOrigin(){throw Error('unavailable');}}), null);
});

test('an already rendered project reference cannot navigate after the target becomes hidden or private', async () => {
  const source = fs.readFileSync(require.resolve('../app/app.js'),'utf8');
  const start = source.indexOf('async function openProject('), end = source.indexOf('async function navigateWorkspaceConversation(',start);
  assert.ok(start > 0 && end > start);
  for (const phase of ['before-click','during-route']) {
    const state = fixture(), routed = [], notices = [];
    assert.equal(Wiki.resolveReference(state,'owner','project:p',options).id, 'p', 'The reference was previously visible');
    const context = { state, window:{DocumentOrigin:Origin}, toast:value=>notices.push(value), workspaceName:value=>value,
      prepareWorkspaceRoute:async()=>{ if(phase==='during-route')state.projects[0].hidden=true;return()=>true; }, showView:(...args)=>routed.push(args) };
    vm.createContext(context);vm.runInContext(source.slice(start,end),context);
    if (phase==='before-click') state.projects[0].hidden=true;
    assert.equal(await context.openProject('p'), false);
    assert.deepEqual(routed, []);
    assert.equal(state.currentProjectId, undefined);
    assert.equal(Wiki.resolveReference(state,'owner','project:p',options), null, 'A rerender cannot expose the old title');
  }
});
