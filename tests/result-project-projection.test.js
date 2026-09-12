const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const cut = (start, end) => {
  const at = source.indexOf(start), stop = source.indexOf(end, at);
  assert.ok(at >= 0 && stop > at, `Real application function: ${start}`);
  return source.slice(at, stop);
};
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  projects: [{id:'old',name:'旧课程',workspace:'课程'}, {id:'new',name:'新课程',workspace:'课程'}, {id:'third',name:'科研项目',workspace:'科研'}],
  tasks: [], notes: [], imports: [], papers: [], conversations: [], agentRuns: []
});
const result = (type, id, projectId = 'old') => ({type,id,projectId,operation:'created',text:'原执行记录'});
function harness(state = fixture()) {
  const element = () => ({children:[],dataset:{},innerHTML:'',className:'',append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);}});
  const context = vm.createContext({state,window:{},document:{createElement:element},
    workspaceName:value=>value||'日常',esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    renderRichText:value=>value,statusLabel:value=>value||'待开始',formatDate:value=>value
  });
  vm.runInContext(cut('function dedupeResultEntries(', '\nfunction groupedEntities('), context);
  vm.runInContext(cut('function renderMessage(', '\nfunction renderStagedAttachments('), context);
  return {
    state, context,
    entries:results=>plain(context.currentResultEntries(results)),
    projects:conversation=>plain(context.conversationProjectIds(conversation)),
    render:message=>{const box=element();context.renderMessage({role:'assistant',text:'已完成',...message},box);return box.children[0].children;},
    projectConversations:projectId=>{
      // Exercise the exact filter used for the project's tree and conversation list.
      const line=source.split('\n').find(value=>value.startsWith('  const conversations = state.conversations.filter(conversation => conversationProjectIds('));
      assert.ok(line);context.projectId=projectId;vm.runInContext(line.replace('const conversations =','globalThis.selectedConversations ='),context);
      return plain(context.selectedConversations).map(item=>item.id);
    }
  };
}
test('message source and model metadata mark only fixed labels for localization',()=>{
  const h=harness();h.context.ConversationModels=require('../app/model-picker');h.context.window.ConversationModels=h.context.ConversationModels;
  h.state.imports.push({id:'source'});
  const children=h.render({modelConfig:{provider:'api',model:'中',effort:'medium'},retrievedSources:[{type:'import',id:'source',title:'第 1 页',page:1}]});
  const identity=children.find(item=>item.className==='message-identity'),info=identity.children.find(item=>item.className==='message-model-info');
  assert.match(info.innerHTML,/<span data-user-content>中<\/span>/);assert.match(info.innerHTML,/<span data-i18n>中<\/span>/);
  const citations=children.find(item=>item.className==='message-steps').innerHTML;
  assert.match(citations,/<span data-user-content>第 1 页<\/span>/);assert.match(citations,/<span data-i18n>第 1 页<\/span>/);assert.match(citations,/data-open-import="source" data-source-page="1"/);
  const unknown=h.render({modelConfig:{provider:'api',model:'设置',effort:'设置'}})[0].children[0].innerHTML;
  assert.equal((unknown.match(/data-user-content/g)||[]).length,2);assert.doesNotMatch(unknown,/data-i18n/);
});

test('current typed entities determine all result ownership without modifying execution history', () => {
  const h=harness(),results=[];
  for(const [type,key] of [['task','tasks'],['note','notes'],['import','imports'],['paper','papers']]) {
    h.state[key].push({id:'shared-id',title:type,projectId:'new',project:'旧课程',workspace:'课程'});
    results.push(result(type,'shared-id'));
  }
  const before=JSON.stringify({state:h.state,results});
  const entries=h.entries(results);
  assert.deepEqual(entries.map(item=>[item.type,item.entity.title,item.projectId,item.project.name]),[
    ['task','task','new','新课程'],['note','note','new','新课程'],['import','import','new','新课程'],['paper','paper','new','新课程']
  ]);
  assert.equal(JSON.stringify({state:h.state,results}),before);
});

test('a handled note draft no longer appears as pending in current result cards', () => {
  const h=harness(), note={id:'n',projectId:'new',content:'Saved text',aiDraft:{content:'Proposed text'}};
  h.state.notes.push(note);
  const results=[{...result('note','n'),operation:'drafted'}];
  assert.equal(h.entries(results)[0].operation,'drafted');
  delete note.aiDraft;
  assert.equal(h.entries(results)[0].operation,'reviewed');
  assert.equal(results[0].operation,'drafted','Keep the original execution history intact');
});

test('unassigned, missing and invalid typed records never reuse a stale historical project', () => {
  const h=harness();h.state.notes.push({id:'shared',projectId:null,project:'旧课程',workspace:'课程'});h.state.tasks.push({id:'shared',projectId:'third'});
  const entries=h.entries([result('note','shared'),result('task','missing'),result('paper','shared'),result('__proto__','shared'),null,{projectId:'old'}]);
  assert.equal(entries.length,1);assert.equal(entries[0].projectId,null);assert.equal(entries[0].project,null);
  assert.deepEqual(h.projects({projectId:null,messages:[{results:[result('note','shared'),result('task','missing')]}]}),[]);
});

test('archived or deleted entities and projects are not resurrected by result history', () => {
  const flags=[{archived:true},{archivedAt:1},{deleted:true},{deletedAt:1},{status:'archived'},{status:'deleted'}];
  for(const flag of flags) {
    for(const target of ['entity','project']) {
      const h=harness();h.state.notes.push({id:'n',projectId:'new'});Object.assign(target==='entity'?h.state.notes[0]:h.state.projects[1],flag);
      assert.deepEqual(h.entries([result('note','n')]),[]);
      assert.deepEqual(h.projects({messages:[{results:[result('note','n')]}]}),[]);
    }
    const h=harness();h.state.notes.push({id:'n',projectId:'new'});
    assert.deepEqual(h.projects({...flag,projectId:'old',messages:[{results:[result('note','n')]}]}),[]);
  }
});

test('moving a conversation and its outputs removes the old project link in the actual project filter', () => {
  const h=harness();h.state.notes.push({id:'n',projectId:'new'});h.state.tasks.push({id:'t',projectId:'new'});h.state.imports.push({id:'pdf',projectId:'new'});
  const results=[result('note','n'),result('task','t'),result('import','pdf')];
  h.state.conversations.push({id:'moved',projectId:'new',messages:[{results}]},{id:'old-conversation',projectId:'old',messages:[]});
  const before=JSON.stringify(h.state);
  assert.deepEqual(h.projectConversations('old'),['old-conversation']);assert.deepEqual(h.projectConversations('new'),['moved']);
  assert.equal(JSON.stringify(h.state),before);
});

test('explicit binding stays first while genuine live outcomes retain cross-project conversations', () => {
  const h=harness();h.state.notes.push({id:'n',projectId:'new'});h.state.tasks.push({id:'t',projectId:'third'});
  const conversation={id:'cross',projectId:'old',messages:[null,{results:'legacy'},{results:[result('note','n'),result('note','n'),result('task','t')]}]};
  assert.deepEqual(h.projects(conversation),['old','new','third']);h.state.conversations.push(conversation);
  for(const projectId of ['old','new','third'])assert.deepEqual(h.projectConversations(projectId),['cross']);
  assert.deepEqual(h.projects({messages:[{results:[result('project','new')]}]}),['new'],'an existing project result uses the project entity ID');
});

test('the rendered result heading and cards agree on the new project even when cached entity names are old', () => {
  const h=harness();h.state.notes.push({id:'n',title:'矩阵学习笔记',projectId:'new',project:'旧课程',workspace:'日常'});
  const message={results:[result('note','n'),result('note','n')]},before=JSON.stringify(message);
  const box=h.render(message).find(item=>item.className==='message-result-links');
  assert.match(box.innerHTML.replace(/<[^>]+>/g,''),/已归入「新课程」/);assert.match(box.innerHTML.replace(/<[^>]+>/g,''),/课程 · 新课程/);assert.doesNotMatch(box.innerHTML,/旧课程|日常/);
  assert.equal((box.innerHTML.match(/data-open-note="n"/g)||[]).length,1);assert.match(box.innerHTML,/新建 1 项/);assert.equal(JSON.stringify(message),before);
});

test('unassigned results are described accurately and deleted results cannot claim a current project', () => {
  const h=harness();h.state.notes.push({id:'n',title:'笔记',projectId:null,project:'旧课程',workspace:'课程'});
  const standalone=h.render({results:[result('note','n')]}).find(item=>item.className==='message-result-links');
  assert.match(standalone.innerHTML,/已保存至工作区/);assert.match(standalone.innerHTML,/未归属项目/);assert.doesNotMatch(standalone.innerHTML,/旧课程/);
  h.state.tasks.push({id:'t',title:'任务',projectId:'new',workspace:'课程'});
  const mixed=h.render({results:[result('note','n'),result('task','t'),result('import','gone')]}).find(item=>item.className==='message-result-links');
  assert.match(mixed.innerHTML,/已写入 1 个项目及未归属内容/);assert.doesNotMatch(mixed.innerHTML,/已归入「新课程」|data-open-import/);
});

test('routing-review approval uses clear labels while retaining normal approvals and action attributes', () => {
  for(const required of [true,false]) {
    const h=harness();h.state.agentRuns.push({id:'run',status:'awaiting-approval',routingReview:{required}});
    const box=h.render({pendingRunId:'run'}).find(item=>item.className==='pending-actions');
    assert.match(box.innerHTML,/data-approve-run="run"/);assert.match(box.innerHTML,/data-reject-run="run"/);
    assert.ok(box.innerHTML.includes(required?'确认归属并执行':'批准并执行'));assert.ok(box.innerHTML.includes(required?'暂不归入':'拒绝'));
    if(required)assert.doesNotMatch(box.innerHTML,/>拒绝</);
  }
});


test('result cards localize fixed status and receipt labels without translating identical user titles',()=>{
  const h=harness();h.state.projects[1].name='已保存';h.state.tasks.push({id:'task',title:'已归入',projectId:'new',workspace:'课程',status:'todo'});
  const before=JSON.stringify(h.state),box=h.render({results:[result('task','task')]}).find(item=>item.className==='message-result-links');
  assert.match(box.innerHTML,/<span data-i18n>已归入<\/span>/);assert.match(box.innerHTML,/<span data-user-content>已保存<\/span>/);assert.match(box.innerHTML,/<b data-user-content>已归入<\/b>/);assert.match(box.innerHTML,/<span data-i18n>课程<\/span>/);assert.equal(JSON.stringify(h.state),before);
  const dictionary=require('../app/i18n-en.js');
  for(const label of ['项目','任务','知识','论文','资料','新建','更新','已有','待合并','草稿已处理','已归档','已重命名','已保存','待开始','进行中','已完成','未命名','打开详情','日常空间','课程空间','科研空间','独立科研资料','未归属项目','已归入','已保存至工作区','内容已保存，可打开核对'])assert.ok(dictionary.exact[label],`missing result label: ${label}`);
});
