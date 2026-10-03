const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');

function fixture() {
  return { projects: [], tasks: [], imports: [], papers: [], links: [], trash: [], conversations: [], agentRuns: [], notes: [
    { id: 'calendar-mirror', title: '打篮球', kind: '日程', content: JSON.stringify({ format: 'aibro.agenda.v1', title: '打篮球', deleted: false }), workspace: '日常', projectId: null },
    { id: 'ordinary', title: '日程安排笔记', kind: '笔记', content: '记录我的时间管理方法', workspace: '日常', projectId: null }
  ] };
}
const options = { workspace: '日常', allowedNoteIds: ['calendar-mirror', 'ordinary'], protectNoteUpdates: true, uid: () => 'new-note' };

test('calendar mirror cannot be updated, appended or deleted through generic note actions', () => {
  for (const action of [
    { type: 'update_note', noteId: 'calendar-mirror', patch: { title: '下午打篮球' } },
    { type: 'append_note', noteId: 'calendar-mirror', content: '延期一天' },
    { type: 'delete_note', noteId: 'calendar-mirror' }
  ]) {
    const state = fixture(), before = structuredClone(state);
    assert.throws(() => Core.applyPlan(state, [action], options), /agenda_read/);
    assert.deepEqual(state, before);
  }
});
test('calendar format remains protected if legacy note kind is missing', () => {
  const state = fixture(); delete state.notes[0].kind;
  assert.throws(() => Core.applyPlan(state, [{ type: 'delete_note', noteId: 'calendar-mirror' }], options), /agendaProposals/);
});
test('new ordinary notes cannot create or impersonate calendar records or overwrite same-named mirrors', () => {
  for (const action of [
    { type: 'create_note', title: '新增', kind: '日程', content: '一个日程' },
    { type: 'create_knowledge_item', title: '新增', content: '{"format":"aibro.agenda.v1"}' },
    { type: 'create_note', title: '打篮球', content: '替换内容' },
    { type: 'update_note', noteId: 'ordinary', patch: { kind: '日程' } }
  ]) assert.throws(() => Core.applyPlan(fixture(), [action], options), /agendaProposals/);
});
test('ordinary time-management notes and task edits still work', () => {
  const outcome = Core.applyPlan(fixture(), [{ type: 'append_note', noteId: 'ordinary', content: '每周回顾一次' }], options);
  const ordinary = outcome.state.notes.find(n => n.id === 'ordinary');
  assert.match(ordinary.aiDraft?.content || ordinary.content, /每周回顾一次/);
  assert.deepEqual(outcome.state.notes[0], fixture().notes[0]);
});
test('paper upserts cannot claim a native calendar mirror as their output note', () => {
  const state = fixture(); state.imports.push({id:'paper-source',name:'Synthetic.pdf',workspace:'科研',projectId:null});
  const before = structuredClone(state);
  const action = { type: 'upsert_paper', title: 'Synthetic paper', noteId: 'calendar-mirror', workspace: '科研', sections: { summary: '合成分析' }, sourceAttachmentIds: ['paper-source'] };
  assert.throws(() => Core.applyPlan(state, [action], options), /agendaProposals/);
  assert.deepEqual(state, before);
});
test('appending to an empty note cannot manufacture a native calendar payload', () => {
  const state = fixture();state.notes[1].content = '';
  for (const protectNoteUpdates of [true, false]) {
    assert.throws(() => Core.applyPlan(state, [{ type: 'append_note', noteId: 'ordinary', content: '{"format":"aibro.agenda.v1"}' }], { ...options, protectNoteUpdates }), /agendaProposals/);
  }
});
