const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');
const blank = () => ({ projects: [{ id: 'course', name: '智能控制课程', workspace: '课程' }, { id: 'research', name: '鲁棒控制研究', workspace: '科研' }], imports: [{ id: 'pdf', name: 'paper.pdf', url: 'https://arxiv.org/abs/2401.12345', projectId: null }], papers: [], notes: [], tasks: [], links: [], trash: [] });
const paper = (patch = {}) => ({ type: 'upsert_paper', title: 'Robust control', workspace: '科研', sourceAttachmentIds: ['pdf'], url: 'https://arxiv.org/abs/2401.12345', structured: { methods: { text: 'Analyze stability under bounded uncertainty.' } }, ...patch });
const context = projectId => ({ workspace: '科研', projectId, conversationId: 'conversation', runId: 'run' });

test('explicit null saves research paper, source and note independently from a course conversation', () => {
  const state = blank(); const before = JSON.stringify(state);
  const out = Core.applyPlan(state, [{ type: 'assign_attachment', attachmentId: 'pdf', workspace: '科研', projectId: null, folderPath: '独立文献' }, paper({ projectId: null })], context('course'));
  for (const item of [out.state.imports[0], out.state.papers[0], out.state.notes[0]]) { assert.equal(item.projectId, null); assert.equal(item.workspace, '科研'); }
  assert.equal(out.state.notes[0].paperId, out.state.papers[0].id);
  assert.ok(out.state.links.some(link => link.sourceId === 'pdf' && link.targetId === out.state.notes[0].id));
  assert.deepEqual(out.projectIds, []); assert.equal(out.state.projects.length, 2); assert.equal(JSON.stringify(state), before);
});

test('explicit null also opts out of an existing research binding while omitted project inherits it', () => {
  const independent = Core.applyPlan(blank(), [paper({ projectId: null })], context('research'));
  assert.equal(independent.state.papers[0].projectId, null); assert.equal(independent.state.notes[0].projectId, null);
  for (const action of [paper(), paper({ projectId: undefined })]) {
    const inherited = Core.applyPlan(blank(), [action], context('research'));
    assert.equal(inherited.state.papers[0].projectId, 'research'); assert.equal(inherited.state.imports[0].projectId, 'research');
  }
});

test('explicit null does not guess between independent storage and contradictory project aliases', () => {
  const state = blank(), before = JSON.stringify(state);
  for (const field of ['project', 'projectName']) assert.throws(() => Core.applyPlan(state, [paper({ projectId: null, [field]: '鲁棒控制研究' })], context('research')), /项目归属不一致/);
  assert.equal(JSON.stringify(state), before);
});

test('null isolation also applies to new notes and tasks without changing implicit project inheritance', () => {
  const out = Core.applyPlan(blank(), [{ type: 'create_note', title: '独立研究问题', workspace: '科研', projectId: null, content: 'Follow-up research idea.' }, { type: 'create_task', title: '阅读论文', workspace: '科研', projectId: null }], context('course'));
  assert.equal(out.state.notes[0].projectId, null); assert.equal(out.state.tasks[0].projectId, null);
  const inherited = Core.applyPlan(blank(), [{ type: 'create_task', title: '课程复习', workspace: '课程' }], { ...context('course'), workspace: '课程' });
  assert.equal(inherited.state.tasks[0].projectId, 'course');
});

test('a duplicate URL with null keeps the existing paper project, identity and manual edits and aligns its new source', () => {
  let state = Core.applyPlan(blank(), [paper({ projectId: 'research' })], context('research')).state;
  const id = state.papers[0].id, noteId = state.notes[0].id;
  state.papers[0].userEdits = { methods: { text: 'Manually checked analysis.' } }; state.papers[0].reviewed = true;
  state.imports.push({ id: 'retry-pdf', name: 'download.pdf', url: 'https://arxiv.org/pdf/2401.12345v2.pdf', projectId: null });
  const out = Core.applyPlan(state, [{ type: 'assign_attachment', attachmentId: 'retry-pdf', workspace: '科研', projectId: null }, paper({ projectId: null, url: 'https://arxiv.org/pdf/2401.12345v2.pdf', sourceAttachmentIds: ['retry-pdf'] })], context('course'));
  assert.equal(out.state.papers.length, 1); assert.equal(out.state.notes.length, 1);
  assert.equal(out.state.papers[0].id, id); assert.equal(out.state.notes[0].id, noteId);
  assert.equal(out.state.papers[0].projectId, 'research'); assert.equal(out.state.notes[0].projectId, 'research');
  assert.equal(out.state.imports.find(item => item.id === 'retry-pdf').projectId, 'research');
  assert.deepEqual(out.state.papers[0].sourceAttachmentIds, ['pdf', 'retry-pdf']);
  assert.equal(out.state.papers[0].structured.methods.text, 'Manually checked analysis.'); assert.equal(out.state.papers[0].reviewed, true);
});

test('an explicit known paper ID with null preserves its existing destination rather than moving it out', () => {
  const state = Core.applyPlan(blank(), [paper({ projectId: 'research' })], context('research')).state;
  const out = Core.applyPlan(state, [paper({ id: state.papers[0].id, projectId: null })], context('course'));
  assert.equal(out.state.papers.length, 1); assert.equal(out.state.papers[0].projectId, 'research'); assert.equal(out.state.notes[0].projectId, 'research');
});

test('retrying a hidden paper or project rejects the whole transaction, including preceding file changes', () => {
  for (const change of [state => { state.papers[0].archived = true; }, state => { state.papers[0].deletedAt = 1; }, state => { state.projects[1].archived = true; }, state => { state.projects = state.projects.filter(project => project.id !== 'research'); }]) {
    const state = Core.applyPlan(blank(), [paper({ projectId: 'research' })], context('research')).state; change(state);
    const before = JSON.stringify(state);
    assert.throws(() => Core.applyPlan(state, [{ type: 'rename_attachment', attachmentId: 'pdf', newName: 'must-not-rename.pdf' }, paper({ projectId: null })], context(null)), /请先恢复/);
    assert.equal(JSON.stringify(state), before);
  }
});

test('an invalid later action leaves an independent paper plan completely unapplied', () => {
  const state = blank(), before = JSON.stringify(state);
  assert.throws(() => Core.applyPlan(state, [{ type: 'assign_attachment', attachmentId: 'pdf', workspace: '科研', projectId: null }, paper({ projectId: null }), { type: 'delete_task', taskId: 'missing' }], context('course')), /找不到任务/);
  assert.equal(JSON.stringify(state), before);
});
