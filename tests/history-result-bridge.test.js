const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function render(run) {
  const classes = new Map();
  const box = { innerHTML: '', classList: { toggle(name, value) { classes.set(name, value); } } };
  const state = { agentRuns: [{ id:'legacy-run',conversationId:'original',startedAt:1,...run }],tasks:[],notes:[{id:'note',title:'研究笔记'}],imports:[],projects:[] };
  const before = JSON.stringify(state);
  const context = vm.createContext({state,$:()=>box,currentConversation:()=>({id:'original'}),visibleTask:()=>true,visibleNote:()=>true,visibleImport:()=>true,visibleProject:()=>true,uiIcon:()=>'',esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),actionSummary:actions=>actions.map(a=>a.title||a.type).join(' / ')});
  vm.runInContext(body('function dedupeResultEntries(', '\nfunction groupedEntities('),context);
  vm.runInContext(body('function renderResults(', '\nfunction renderAll('),context);
  context.renderResults();
  assert.equal(JSON.stringify(state),before,'opening a history result must not mutate stored run data');
  return {html:box.innerHTML,empty:classes.get('empty-list')};
}
test('opening an old run tolerates null results and preserves the valid entity link',()=>{
  const result=render({status:'completed',results:[null,false,7,'legacy text',{type:'note',id:'note',text:'研究笔记'},{type:'note',id:'note',text:'补充引用'}]});
  assert.equal(result.empty,false);
  assert.equal((result.html.match(/data-open-note="note"/g)||[]).length,1);
  assert.match(result.html,/研究笔记/);
  assert.match(result.html,/补充引用/);
});
test('old non-array results safely produce the empty inspector',()=>{
  for(const results of [null,'legacy',{unexpected:true},25]) {
    const result=render({status:'completed',results});
    assert.equal(result.empty,true);
    assert.match(result.html,/Agent 执行后/);
  }
});
test('old pending-action lists ignore invalid entries without blocking valid actions',()=>{
  const result=render({status:'awaiting-approval',pendingActions:[null,false,{},7,{type:'create_note',title:'待审批笔记'}]});
  assert.equal(result.empty,false);
  assert.match(result.html,/待审批笔记/);
  const invalid=render({status:'awaiting-approval',pendingActions:{type:'create_note'}});
  assert.equal(invalid.empty,true);
});
test('a completed execution step settles prior running steps without rewriting failures',()=>{
  const box={textContent:''};const c=vm.createContext({$:()=>box,uid:prefix=>prefix+'-fixture'});
  const declaration=source.split('\n').find(line=>line.startsWith('function addRunStep('));
  vm.runInContext(declaration,c);
  const run={steps:[{text:'已完成解析',status:'done'},null,{text:'旧失败',status:'error'},{text:'写入项目',status:'running'}]};
  c.addRunStep(run,'成果已保存');
  assert.equal(run.steps.filter(step=>step?.status==='running').length,0);
  assert.equal(run.steps.find(step=>step?.text==='写入项目').status,'done');
  assert.equal(run.steps.find(step=>step?.text==='旧失败').status,'error');
  assert.equal(run.steps.at(-1).status,'done');
  assert.match(box.textContent,/执行完成/);
});
