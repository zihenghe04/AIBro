const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../local-project-agent');
const Core = require('../workstation-core');
const folder = {id:'local-1',rootId:'root-1',name:'homepage',path:'/fixture/homepage'};
const empty = () => ({projects:[],tasks:[],notes:[],imports:[],papers:[],links:[],trash:[]});
const snapshot = (text='Current source') => ({folder,tree:[{path:'README.md'}],files:[{path:'README.md',content:text}],summary:'1 source',totalFiles:1});

test('local intent recognizes missing-path project creation, not ordinary attached or web research', () => {
  for (const text of ['我在本机存着个人主页代码，帮我建项目','把本地保存的个人主页代码建成日常项目','找一下电脑上的论文代码','/local homepage','find my website on my mac']) assert.equal(Agent.wantsSearch(text),true,text);
  for (const text of ['分析附件的本机部署指南','搜索互联网资料','为我的主页创建项目']) assert.equal(Agent.wantsSearch(text),false,text);
});

test('search waits for scope consent, reads bounded candidates and keeps plaintext out of persistent metadata', async () => {
  const calls=[];
  const local={requestAccess:async()=>{calls.push('grant');return true},discover:async()=>{calls.push('search');return {candidates:[folder],scannedDirectories:2,truncated:true}},snapshot:async()=>{calls.push('read');return snapshot('fixture-content')}};
  const result=await Agent.prepare({goal:'搜索本机个人主页',permissionMode:'request',local,confirmRead:async()=>{calls.push('approve-read');return true}});
  assert.deepEqual(calls,['grant','approve-read','search','read']);
  assert.match(result.text,/fixture-content/);assert.match(result.text,/并不穷尽/);
  assert.equal(JSON.stringify(result.candidates).includes('fixture-content'),false);
});

test('refused or aborted read never searches or calls the model', async () => {
  let searched=0; const local={requestAccess:async()=>false,discover:async()=>searched++};
  await assert.rejects(Agent.prepare({goal:'找本机代码',local}),{code:'CANCELLED'});assert.equal(searched,0);
  const controller=new AbortController();controller.abort();local.requestAccess=async()=>{throw Error('Must not request')};
  await assert.rejects(Agent.prepare({goal:'找本机代码',signal:controller.signal,local}),{code:'CANCELLED'});
});

test('project conversation reads latest files on every turn and never searches a different project', async () => {
  let version=0;const project={name:'My homepage',localFolder:folder};
  const local={discover:async()=>{throw Error('Must not search')},snapshot:async p=>{assert.equal(p,project);return snapshot('version-'+(++version))}};
  const first=await Agent.prepare({goal:'描述架构',project,local,permissionMode:'smart'});
  const next=await Agent.prepare({goal:'刚才有更新吗',project,local,permissionMode:'full'});
  assert.match(first.text,/version-1/);assert.match(next.text,/version-2/);
});

test('revoked or missing linked folder fails honestly without stale source fallback',async()=>{
  await assert.rejects(Agent.prepare({goal:'看下这个项目',project:{localFolder:folder},local:{snapshot:async()=>{throw Error('授权已撤销')}}}),/授权已撤销/);
});

test('snapshot context is capped and signals partial files',()=>{
  const s=snapshot('x'.repeat(20000));s.files.push({path:'second.js',content:'y'.repeat(20000)});
  const text=Agent.formatSnapshot(s,6000);assert.ok(text.length<6200);assert.match(text,/部分内容/);assert.match(text,/不得声称已修改本机代码/);
});

test('linking uses trusted directory metadata and rolls back forged candidates',()=>{
  const state=empty(); const actions=[{type:'create_project',name:'个人主页',workspace:'日常',id:'new'},{type:'link_local_project',projectId:'new',candidateId:folder.id,path:'/forged',files:['secret']}];
  assert.throws(()=>Core.applyPlan(state,actions),/本次已验证/);assert.equal(state.projects.length,0);
  const result=Core.applyPlan(state,actions,{localCandidates:[folder],now:100});
  assert.equal(result.state.projects[0].workspace,'日常');assert.equal(result.state.projects[0].localFolder.path,folder.path);assert.equal(result.state.projects[0].localFolder.files,undefined);
  assert.equal(result.results[1].operation,'linked');assert.equal(result.projectIds.length,1);
});

test('same directory reuses the project, refuses duplicate owners and cross-space links',()=>{
  const state=empty();state.projects.push({id:'p1',name:'个人主页',workspace:'日常',localFolder:folder});
  const same=Core.applyPlan(state,[{type:'create_project',name:'个人主页',workspace:'日常',id:'new'},{type:'link_local_project',projectId:'new',candidateId:folder.id}],{localCandidates:[folder]});assert.equal(same.state.projects.length,1);
  assert.throws(()=>Core.applyPlan(state,[{type:'create_project',name:'重复主页',workspace:'日常',id:'new'},{type:'link_local_project',projectId:'new',candidateId:folder.id}],{localCandidates:[folder]}),/已关联/);
  assert.throws(()=>Core.applyPlan(state,[{type:'link_local_project',projectId:'p1',workspace:'科研',candidateId:folder.id}],{localCandidates:[folder]}),/归属不一致/);
});

test('pending association revalidates filesystem access before commit',async()=>{
  const run={localCandidates:[folder],pendingActions:[{type:'link_local_project',candidateId:folder.id}]};
  await assert.rejects(Agent.revalidate(run,{snapshot:async()=>{throw Error('撤权')}}),/撤权/);
  await assert.rejects(Agent.revalidate({...run,localCandidates:[]},{snapshot:async()=>snapshot()}),/未在本次搜索/);
  await assert.rejects(Agent.revalidate(run,{snapshot:async()=>({...snapshot(),folder:{...folder,path:'/changed'}})}),/目录已变化/);
});

test('a search-driven plan cannot silently create an unlinked empty project',()=>{
 const run={localSearched:true,localCandidates:[folder],pendingActions:[{type:'create_project',id:'p',name:'个人主页'}]};
 assert.throws(()=>Agent.validatePlan(run),/必须同时关联/);
 run.pendingActions.push({type:'link_local_project',projectId:'p',candidateId:folder.id});assert.doesNotThrow(()=>Agent.validatePlan(run));
});

test('archived directory owners cannot be bypassed; reconnecting same path renews the active link',()=>{
 const state=empty();state.projects.push({id:'p',name:'个人主页',workspace:'日常',localFolder:{...folder,id:'old',rootId:'old-root'}});
 const action={type:'link_local_project',projectId:'p',candidateId:folder.id};
 assert.equal(Core.applyPlan(state,[action],{localCandidates:[folder]}).state.projects[0].localFolder.id,folder.id);
 state.projects[0].archived=true;
 assert.throws(()=>Core.applyPlan(state,[{type:'create_project',name:'另一个主页',id:'new'}, {...action,projectId:'new'}],{localCandidates:[folder]}),/已归档/);
});

test('approval catches revocation of an earlier directory while checking a later one',async()=>{
 const run={localCandidates:[folder],pendingActions:[{type:'link_local_project',candidateId:folder.id}]};
 await assert.rejects(Agent.revalidate(run,{snapshot:async()=>snapshot(),ensureAccess:async()=>({roots:[]})}),/授权已撤销/);
});

test('an explicit read refusal blocks even full mode and an already connected project',async()=>{
 for (const goal of ['不要搜索本机文件','不用读取代码，先聊想法',"do not read local files"]){
  assert.equal(Agent.wantsSearch(goal),false);
  const result=await Agent.prepare({goal,project:{localFolder:folder},permissionMode:'full',local:{snapshot:async()=>{throw Error('Must not read')}}});
  assert.equal(result.skipped,true);assert.equal(result.text,'');
 }
});
