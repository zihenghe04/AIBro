const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function harness() {
  const state = {projects:[{id:'p',workspace:'课程'}],tasks:[{id:'same',projectId:'p'}],notes:[{id:'same',projectId:'p'}],imports:[{id:'same',projectId:'p'}]};
  const opened=[],messages=[],renders=[];
  const context=vm.createContext({state,openTask:id=>opened.push(['task',id]),openNote:id=>opened.push(['note',id]),openImport:id=>opened.push(['import',id]),toast:message=>messages.push(message),workspaceName:value=>value});
  vm.runInContext(source.slice(source.indexOf('const projectIsActive ='),source.indexOf('const visibleRun =')),context);
  vm.runInContext(source.slice(source.indexOf('function openActivityEntity('),source.indexOf('function applySectionTabs(')),context);
  context.renderPlanning=()=>{};context.$=selector=>({selector});
  context.window={ActivityUI:{render:(container,state,options)=>renders.push({container,state,options})},WorkstationActivityCore:{}};
  return{context,state,opened,messages,renders};
}
test('activity navigation resolves exact typed IDs and uses existing task, note and source viewers',()=>{
  const h=harness();for(const type of ['task','note','import'])assert.equal(h.context.openActivityEntity(type,'same'),true);
  assert.deepEqual(h.opened,[['task','same'],['note','same'],['import','same']]);
  for(const type of ['paper','project','__proto__','constructor'])assert.equal(h.context.openActivityEntity(type,'same'),false);
  assert.equal(h.context.openActivityEntity('task',null),false);assert.equal(h.opened.length,3);
});
test('deletion, archive and missing or archived parent projects block stale chart entry navigation',()=>{
  for(const [type,key] of [['task','tasks'],['note','notes'],['import','imports']]) {
    for(const change of [h=>h.state[key]=[],h=>h.state[key][0].deletedAt=1,h=>h.state[key][0].archived=true,h=>h.state.projects[0].archived=true,h=>h.state.projects[0].deletedAt=1,h=>h.state.projects=[]]) {
      const h=harness();change(h);assert.equal(h.context.openActivityEntity(type,'same'),false,`${type} invalid record`);assert.deepEqual(h.opened,[]);assert.match(h.messages[0],/回收站、归档或不可用/);
    }
  }
});
test('standalone records remain navigable and array replacement is resolved from current state',()=>{
  const h=harness();const prior=h.context.state;
  h.context.state={projects:[],tasks:[{id:'fresh',projectId:null}],notes:[{id:'fresh',workspace:'科研'}],imports:[{id:'fresh',workspace:'日常'}]};
  assert.equal(h.context.openActivityEntity('task','same'),false);
  for(const type of ['task','note','import'])assert.equal(h.context.openActivityEntity(type,'fresh'),true);
  assert.equal(prior.tasks[0].id,'same');assert.deepEqual(h.opened,[['task','fresh'],['note','fresh'],['import','fresh']]);
});
test('all three actual render call sites pass a live state getter and the checked viewer callback',()=>{
  const h=harness();const calls=source.split('\n').filter(line=>line.includes('window.ActivityUI.render('));assert.equal(calls.length,3);
  Object.assign(h.context,{activity:{id:'scope-chart'},dashboard:{id:'global-chart'},workspace:'日常',project:{workspace:'课程'},projectId:'p'});
  for(const line of calls)vm.runInContext(line.slice(line.indexOf('window.ActivityUI.render(')),h.context);
  assert.equal(h.renders.length,3);
  const fresh={projects:[],tasks:[],notes:[],imports:[]};h.context.state=fresh;
  for(const call of h.renders){assert.equal(call.options.getState(),fresh);assert.equal(call.options.openEntity,h.context.openActivityEntity);assert.equal(call.options.openEntity('task','same'),false);}
  assert.equal(h.renders[0].options.workspace,'日常');assert.equal(h.renders[1].options.workspace,undefined);assert.equal(h.renders[2].options.projectId,'p');assert.deepEqual(h.opened,[]);
});
test('space and dashboard widget rendering retain their scope and collection behavior',()=>{
  const h=harness(),collections=[];h.context.window.CollectionUI={render:(container,options)=>collections.push(options)};
  h.context.renderWorkspaceWidgets('courses','课程');h.context.renderWorkspaceWidgets('dashboard');
  assert.equal(h.renders.length,2);assert.equal(h.renders[0].options.workspace,'课程');assert.equal(h.renders[1].container.selector,'#dashboardAnalytics');assert.equal(collections[0].workspace,'课程');
});
