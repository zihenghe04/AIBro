const test = require('node:test');
const assert = require('node:assert/strict');
const Access = require('../app/project-access');
const Context = require('../app/agent-context');
const Core = require('../app/workstation-core');

const fixture = () => ({ projects: Array.from({length: 73}, (_, i) => ({ id: `p${i}`, name: `示例项目 ${i}`, workspace: '日常' })), conversations: [], tasks: [], notes: [], papers: [], imports: [], attachments: [], agentRuns: [], links: [], trash: [] });

test('project directory finds targets beyond the initial sixty, with no write to the workspace', () => {
  const state = fixture(), before = structuredClone(state), run = {}, ids = [];
  let offset = 0;
  do { const page = Access.catalog(state, {offset}, run); ids.push(...page.entries.map(row => row.id)); offset = page.nextOffset; } while (offset !== null);
  assert.equal(new Set(ids).size, 73);
  assert.deepEqual(state, before);
  assert.deepEqual(Access.catalog(state, {query: '示例项目 72'}, run).entries.map(row => row.id), ['p72']);
  assert.ok(run.projectSnapshots.p72);
  assert.throws(() => Access.catalog(state, {offset: -1}, run), /分页/);
});

test('unavailable and private projects are not returned or granted deletion snapshots', () => {
  const state = fixture(); state.projects.push({id:'retired', name:'示例项目', archived:true}, {id:'deleted', name:'示例项目', deletedAt:1}, {id:'private', name:'示例项目', private:true});
  const run = {}; let offset = 0;
  do { offset = Access.catalog(state, {offset}, run).nextOffset; } while (offset !== null);
  assert.equal(run.projectSnapshots.retired, undefined); assert.equal(run.projectSnapshots.deleted, undefined);
  // ContextRetrieval is the authority for visibility, including its private-project contract.
  const visible = require('../app/context-retrieval').accessibleProjects(state).map(row => row.id);
  assert.deepEqual(Object.keys(run.projectSnapshots), visible);
});

test('a second catalog read does not replace a pending deletion guard after edits', () => {
  const state = fixture(), run = {}; Access.catalog(state, {query:'p72'}, run);
  const old = run.projectSnapshots.p72; state.projects[72].name = 'Changed project';
  Access.catalog(state, {query:'p72'}, run);
  assert.equal(run.projectSnapshots.p72, old);
  assert.notEqual(Core.projectSnapshots(state,{projectIds:['p72']}).p72, old);
});

test('deleting a project loads its own capability instead of task deletion', () => {
  const context = Context.create({fullInstruction:'你是个人助手。\n项目查询与删除：delete_project(projectId)，只能用本轮目录的真实ID，移入可恢复回收站。',projectList:'p72 | 日常 | 示例项目 72'});
  assert.match(context.instructions(), /projects/); assert.match(context.instructions(), /project_list/);
  assert.deepEqual(context.missing({actions:[{type:'delete_project',projectId:'p72'}]}), ['projects']);
  context.capability('tasks'); assert.deepEqual(context.missing({actions:[{type:'delete_project',projectId:'p72'}]}), ['projects']);
  const loaded = context.capability('projects'); assert.match(loaded.instructions,/delete_project\(projectId\)/); assert.match(loaded.instructions,/p72/);
  assert.deepEqual(context.missing({actions:[{type:'delete_project',projectId:'p72'}]}), []);
});
