const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = source.indexOf('function repairRelationships(');
const end = source.indexOf('function ensureConversation(', start);
assert.ok(start >= 0 && end > start);
function harness(projects, records) {
  let writes = 0;
  const state = { projects, imports:[], tasks:[], notes:[], conversations:[], ...records };
  const context = vm.createContext({ state, STORAGE_KEY:'fixture', localStorage:{setItem:()=>writes++},
    workspaceName: value => ['科研','课程'].includes(value) ? value : '日常',
    normalize:value=>String(value??'').trim().toLowerCase().replace(/[\s·_-]+/g,''),
    classifyWorkspace:()=> '科研'
  });
  vm.runInContext(source.slice(start,end),context);
  return { state, repair:context.repairRelationships, writes:()=>writes };
}
const kinds = ['imports','tasks','notes','conversations'];

test('repair never reassigns archived project descendants into a same-name active project', () => {
  const projects=[{id:'archived',name:'智能控制',workspace:'科研',archived:true},{id:'active',name:'智能控制',workspace:'科研'}];
  const records=Object.fromEntries(kinds.map(key=>[key,[{id:key,projectId:'archived',project:'智能控制',workspace:'科研'}]]));
  const {state,repair,writes}=harness(projects,records);
  const before=JSON.stringify(state);repair();
  assert.equal(JSON.stringify(state),before);
  assert.equal(writes(),0);
  for(const kind of kinds) assert.equal(state[kind][0].projectId,'archived');
});

test('an explicit missing or soft-deleted project ID cannot be replaced by a matching name', () => {
  for(const projectId of ['missing','soft-deleted']) {
    const projects=[{id:'other',name:'智能控制',workspace:'科研'},{id:'soft-deleted',name:'智能控制',workspace:'科研',deletedAt:1}];
    const records=Object.fromEntries(kinds.map(key=>[key,[{id:key,projectId,project:'智能控制',workspace:'科研'}]]));
    const {state,repair,writes}=harness(projects,records);repair();
    for(const kind of kinds) assert.equal(state[kind][0].projectId,projectId);
    assert.equal(writes(),0);
  }
});

test('legacy records without IDs only resolve an exact unique name in their explicit workspace', () => {
  const projects=[{id:'research',name:'智能控制',workspace:'科研'},{id:'course',name:'智能控制',workspace:'课程'}];
  const records=Object.fromEntries(kinds.map(key=>[key,[
    {id:`${key}-known`,project:'智能控制',workspace:'科研'},
    {id:`${key}-unknown`,project:'智能控制'},
    {id:`${key}-auto`,project:'智能控制',workspace:'auto'},
    {id:`${key}-near`,project:'智能-控制',workspace:'科研'}
  ]]));
  const {state,repair,writes}=harness(projects,records);repair();
  for(const kind of kinds) {
    assert.equal(state[kind][0].projectId,'research');
    for(const record of state[kind].slice(1)) assert.equal(record.projectId,undefined,record.id);
  }
  assert.equal(writes(),1);
});

test('ambiguous legacy names remain unresolved even if one matching project is archived', () => {
  const projects=[{id:'active',name:'智能控制',workspace:'科研'},{id:'old',name:'智能控制',workspace:'科研',archived:true}];
  const records=Object.fromEntries(kinds.map(key=>[key,[{id:key,project:'智能控制',workspace:'科研'}]]));
  const {state,repair,writes}=harness(projects,records);repair();
  for(const kind of kinds) assert.equal(state[kind][0].projectId,undefined);
  assert.equal(writes(),0);
});
