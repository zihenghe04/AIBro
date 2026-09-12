const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Routing = require('../course-routing');
const Core = require('../workstation-core');

const ai = { id: 'course-ai', name: '智能系统：原理、模型与算法', workspace: '课程' };
const algebra = { id: 'course-algebra', name: '矩阵代数', workspace: '课程' };
function fixture() {
  return { projects: [{ ...ai }], imports: [{ id: 'new-ppt', name: '矩阵代数第一章.pdf', projectId: null }], notes: [], tasks: [], papers: [], links: [], trash: [], conversations: [], agentRuns: [] };
}
const run = (patch = {}) => ({ goal: '这门课的第一章 PPT 如下，请整理笔记。', projectId: null, attachmentIds: ['new-ppt'], ...patch });
const preview = (projectIds = [ai.id]) => ({ projectIds, results: [], state: {} });
const assess = (state = fixture(), dry = preview(), context = run()) => Routing.assess(state, dry, context);

test('an unbound generic course upload cannot be merged into the only existing AI course', () => {
  const result = assess(); assert.equal(result.required, true); assert.deepEqual(result.candidates, [{ id: ai.id, name: ai.name }]); assert.match(result.message, /归属尚未确认/);
});
test('explicit conversation binding supports its existing course but not another course', () => {
  assert.equal(assess(fixture(), preview(), run({ projectId: ai.id })).required, false);
  const state = fixture(); state.projects.push({ ...algebra });
  assert.deepEqual(assess(state, preview([ai.id, algebra.id]), run({ projectId: algebra.id })).candidates.map(item => item.id), [ai.id]);
});
test('an exact current user title allows punctuation, whitespace and normalized Latin case differences', () => {
  for (const goal of ['请放入智能系统 原理 模型与算法课程。', '这是《智能系统：原理、模型与算法》的课件', '智能系统：原理、模型与算法']) assert.equal(assess(fixture(), preview(), run({ goal })).required, false, goal);
  const state = fixture(); state.projects[0].name = 'Advanced AI: Models';
  assert.equal(assess(state, preview(), run({ goal: 'Please analyze the attachment for “ADVANCED AI Models”.' })).required, false);
});
test('a similar title or title embedded in another course name does not authorize routing', () => {
  for (const goal of ['这是智能系统导论的课件', '请整理智能系统课程', '这门课叫矩阵代数']) assert.equal(assess(fixture(), preview(), run({ goal })).required, true, goal);
  const state = fixture(); state.projects[0].name = '智能控制';
  for (const goal of ['这是智能控制原理的课件', '请整理高级智能控制的课件']) assert.equal(assess(state, preview(), run({ goal })).required, true, goal);
  state.projects[0].name = 'AI'; assert.equal(assess(state, preview(), run({ goal: 'Please explain this chapter.' })).required, true);
  state.projects[0].name = 'Algebra'; assert.equal(assess(state, preview(), run({ goal: 'Algebraic topology first chapter' })).required, true);
});
test('negated names do not count as explicit consent, even with a stale bound project or original attachment', () => {
  const state = fixture(); state.projects[0].name = '智能系统'; state.imports[0].projectId = ai.id;
  for (const goal of ['这不是智能系统的课件', '这并非智能系统的课件', '不属于智能系统这门课', '不要放入智能系统项目', '不要保存在智能系统项目', '别把它当成智能系统的课件', '别再把它合并到智能系统课程', '智能系统不是这门课', '智能系统这门课不对', '这与智能系统无关', '不要归入《智能系统》。']) {
    assert.equal(assess(state, preview(), run({ goal, projectId: ai.id })).required, true, goal);
  }
});
test('a correction denies the old course while supporting the explicitly named new course', () => {
  const state = fixture(); state.projects[0].name = '智能系统'; state.projects.push({ ...algebra });
  for (const goal of ['不是智能系统，是矩阵代数的第一章。', '不是智能系统而是矩阵代数的第一章。']) {
    const context = run({ goal, projectId: ai.id });
    assert.deepEqual(assess(state, preview([ai.id, algebra.id]), context).candidates.map(item => item.id), [ai.id]);
    assert.equal(assess(state, preview([algebra.id]), context).required, false);
  }
});
test('comparing or merely contrasting two course titles is not routing consent', () => {
  const state = fixture(); state.projects[0].name = '智能系统'; state.projects.push({ ...algebra });
  for (const goal of ['对比智能系统和矩阵代数', '比较《智能系统》和《矩阵代数》的内容', '智能系统和矩阵代数有什么区别？', '《智能系统》，和《矩阵代数》有什么区别？']) {
    assert.deepEqual(assess(state, preview([ai.id, algebra.id]), run({ goal })).candidates.map(item => item.id), [ai.id, algebra.id], goal);
  }
  const explicit = run({ goal: '比较智能系统和矩阵代数，但请把附件归入智能系统课程。' });
  assert.deepEqual(assess(state, preview([ai.id, algebra.id]), explicit).candidates.map(item => item.id), [algebra.id]);
});
test('an affirmative correction to B overrides stale A binding and source membership without requiring a negative A mention', () => {
  const state = fixture(); state.projects.push({ ...algebra }); state.imports[0].projectId = ai.id;
  for (const goal of ['这门课程的正确名称是矩阵代数。', '请纠正：课程应该归入「矩阵代数」。', '当前课程是矩阵代数。', '请把这份课件放到矩阵代数项目。', `参照《${ai.name}》的模板，但当前课程是《矩阵代数》。`]) {
    const context = run({ goal, projectId: ai.id });
    assert.deepEqual(assess(state, preview([ai.id, algebra.id]), context).candidates.map(item => item.id), [ai.id], goal);
    assert.equal(assess(state, preview([algebra.id]), context).required, false, goal);
  }
});
test('an explicitly corrected new course from the actual dry-run still blocks accidental writes to the old course', () => {
  const state = fixture(); state.imports[0].projectId = ai.id;
  const name = '智能系统基础数学理论和算法';
  const dry = Core.applyPlan(state, [
    { type: 'create_project', id: 'new-course', workspace: '课程', name },
    { type: 'create_note', title: '本轮笔记', content: '矩阵与特征空间的关系。', workspace: '课程', projectId: ai.id, sourceAttachmentIds: ['new-ppt'] }
  ], { workspace: '课程', now: 110, uid: prefix => prefix + '-new' });
  for (const goal of [`这门课程的正确名称是${name}。`, `请纠正：课程应该归入「${name}」。`]) assert.deepEqual(assess(state, dry, run({ goal, projectId: ai.id })).candidates.map(item => item.id), [ai.id]);
  const onlyNew = { ...dry, projectIds: ['project-new'], results: dry.results.filter(item => item.type === 'project') };
  assert.equal(assess(state, onlyNew, run({ goal: `课程应该归入「${name}」。`, projectId: ai.id })).required, false);
});
test('comparison and template references alone do not contradict an otherwise explicit existing binding', () => {
  const state = fixture(); state.projects.push({ ...algebra });
  for (const goal of [`比较《${ai.name}》和《矩阵代数》的内容。`, '参照《矩阵代数》的笔记模板整理本课附件。']) assert.equal(assess(state, preview(), run({ goal, projectId: ai.id })).required, false, goal);
});
test('an explicitly named new B absent from the erroneous dry-run still overrides old A evidence', () => {
  const state = fixture(); state.imports[0].projectId = ai.id;
  const name = '智能系统基础数学理论和算法';
  for (const goal of [`这门课程的正确名称是${name}。`, `请纠正：课程应该归入「${name}」。`, `当前课程是《${name}》。`]) assert.equal(assess(state, preview(), run({ goal, projectId: ai.id })).required, true, goal);
  for (const goal of ['请整理矩阵和特征值的知识。', '附录讨论了一种新的算法。', '这个课件是 PDF，附件是扫描版。']) assert.equal(assess(state, preview(), run({ goal, projectId: ai.id })).required, false, 'arbitrary unfamiliar nouns and file descriptions do not become a target name');
});
test('unbound references to another course template or format are not routing evidence', () => {
  const state = fixture(); state.projects[0].name = '智能系统';
  for (const goal of ['参照《智能系统》的笔记模板整理这个课件，课程名还没确认。', '请按《智能系统》的格式整理，但这份附件的课程需要确认。']) assert.equal(assess(state, preview(), run({ goal })).required, true, goal);
  assert.equal(assess(state, preview(), run({ goal: '参考别的课的模板，但把这份附件归入智能系统课程。' })).required, false);
});
test('English negative routing does not authorize the named course', () => {
  const state = fixture(); state.projects[0].name = 'Linear Algebra';
  for (const goal of ['Do not put this in Linear Algebra.', 'This is not Linear Algebra.', "Don't merge into Linear Algebra.", 'Linear Algebra is not the correct course.']) assert.equal(assess(state, preview(), run({ goal })).required, true, goal);
});
test('only original current attachment membership can support reuse', () => {
  const state = fixture(); state.imports[0].projectId = ai.id;
  assert.equal(assess(state).required, false);
  for (const field of ['archived', 'archivedAt', 'deleted', 'deletedAt']) {
    const stale = structuredClone(state); stale.imports[0][field] = true; assert.equal(assess(stale).required, true, field);
  }
  state.imports[0].projectId = null; state.imports.push({ id: 'old-ppt', projectId: ai.id });
  assert.equal(assess(state).required, true, 'unrelated historical attachment is not evidence');
  const dry = preview(); dry.state = structuredClone(state); dry.state.imports[0].projectId = ai.id;
  assert.equal(assess(state, dry).required, true, 'model-proposed attachment routing is not pre-existing evidence');
});
test('a truly new course is not blocked; only unsupported pre-existing targets are listed', () => {
  assert.equal(assess(fixture(), preview(['new-course'])).required, false);
  const state = fixture(); state.projects.push({ ...algebra });
  const dry = preview(['new-course', algebra.id, ai.id, ai.id]);
  assert.deepEqual(assess(state, dry, run({ goal: '请整理矩阵代数的这份课件' })).candidates.map(item => item.id), [ai.id]);
});
test('create_project deduplication and implicit source routing cannot bypass the guard', () => {
  const state = fixture();
  const dry = Core.applyPlan(state, [
    { type: 'create_project', id: 'model-new-course', workspace: '课程', name: ai.name },
    { type: 'create_note', title: '第一章笔记', workspace: '课程', projectId: 'model-new-course', content: '线性方程组与矩阵消元。', sourceAttachmentIds: ['new-ppt'] }
  ], { workspace: '课程', now: 100, uid: prefix => prefix + '-fixture' });
  assert.equal(dry.state.projects.length, 1); assert.equal(dry.state.imports[0].projectId, ai.id); assert.deepEqual(dry.projectIds, [ai.id]);
  assert.equal(assess(state, dry).required, true); assert.equal(state.imports[0].projectId, null);
});
test('actual result project IDs also capture reused courses without scanning unrelated preview state', () => {
  assert.equal(assess(fixture(), { state: fixture(), results: [{ type: 'project', id: ai.id, operation: 'matched' }] }).required, true);
  assert.equal(assess(fixture(), { state: fixture(), results: [{ type: 'note', id: 'note', projectId: ai.id }] }).required, true);
  assert.equal(assess(fixture(), { state: fixture(), results: [], projectIds: [] }).required, false);
});
test('no-attachment task updates and daily or research projects retain existing behavior', () => {
  assert.equal(assess(fixture(), preview(), run({ attachmentIds: [] })).required, false);
  assert.equal(assess(fixture(), preview(), { goal: 'ddl 明天下午三点' }).required, false);
  for (const workspace of ['日常', '科研']) { const state = fixture(); state.projects[0].workspace = workspace; assert.equal(assess(state).required, false); }
});
test('malformed optional inputs are harmless and all inputs remain unchanged', () => {
  assert.deepEqual(Routing.assess(null, null, null), { required: false, candidates: [], message: '' });
  const state = fixture(), dry = preview(), context = run(); state.projects.push(null); state.imports.push(null); dry.results.push(null); dry.projectIds.push(null); context.attachmentIds.push(null);
  const before = structuredClone({ state, dry, context });
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(state); freeze(dry); freeze(context); assert.equal(Routing.assess(state, dry, context).required, true); assert.deepEqual({ state, dry, context }, before);
});
test('browser UMD exposes the same pure assess API without Node or DOM dependencies', () => {
  const sandbox = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../course-routing'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.CourseRouting.assess, 'function'); assert.equal(sandbox.CourseRouting.assess(fixture(), preview(), run()).required, true);
});
