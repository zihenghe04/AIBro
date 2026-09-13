const test = require('node:test');
const assert = require('node:assert/strict');
const Review = require('../app/draft-review.js');
const fixture = () => ({
  projects: [{ id: 'p' }, { id: 'other' }],
  notes: [{ id: 'n', projectId: 'p', workspace: 'research', title: 'Synthetic note', content: 'Human-authored body', sourceAttachmentIds: ['old'], updatedAt: 1, userEdited: true, aiDraft: { title: 'Synthetic merged note', content: 'Human-authored body\n\nNew source analysis', sourceAttachmentIds: ['old', 'new'], createdAt: 2 } }],
  conversations: [{ id: 'c', projectId: 'p', workspace: 'research', messages: [{ id: 'm', role: 'assistant', at: 2, results: [{ type: 'note', id: 'n', operation: 'drafted' }] }] }], agentRuns: []
});
test('adoption reads saved draft directly and prepares a non-mutating source-preserving revision', () => {
  const state = fixture(), before = JSON.stringify(state);
  const result = Review.resolve(state, state.conversations[0], '采纳');
  assert.equal(result.status, 'resolved');
  const change = Review.prepare(state, result.review, result.action, 9);
  assert.equal(JSON.stringify(state), before);
  assert.equal(change.after.content, state.notes[0].aiDraft.content);
  assert.deepEqual(change.after.sourceAttachmentIds, ['old', 'new']);
  assert.equal(change.after.revisionHistory.at(-1).content, 'Human-authored body');
  assert.deepEqual(change.after.revisionHistory.at(-1).sourceAttachmentIds, ['old']);
  assert.equal(change.after.aiDraft, undefined);
  assert.deepEqual(change.after.aiDraftHistory[0].draft, state.notes[0].aiDraft);
});
test('discard retains full reversible draft while preserving original body and provenance', () => {
  const state = fixture(), note = state.notes[0];
  const change = Review.prepare(state, Review.begin(state, 'n'), 'discard', 10);
  assert.equal(change.after.content, note.content);
  assert.equal(change.after.title, note.title);
  assert.deepEqual(change.after.sourceAttachmentIds, ['old']);
  assert.equal(change.after.revisionHistory, undefined);
  assert.deepEqual(change.after.aiDraftHistory, [{ action: 'discard', reviewedAt: 10, draft: note.aiDraft }]);
  change.after.aiDraftHistory[0].draft.content = 'modified return value';
  assert.notEqual(note.aiDraft.content, 'modified return value');
});
test('stale note, source, draft, history, project, and conversation scope cannot be overwritten', () => {
  for (const mutate of [
    s => { s.notes[0].content = 'concurrent edit'; },
    s => { s.notes[0].aiDraft.content = 'newer draft'; },
    s => { delete s.notes[0].aiDraft; },
    s => { s.notes[0].sourceAttachmentIds.push('concurrent'); },
    s => { s.notes[0].aiDraftHistory = [{ draft: { content: 'saved' } }]; },
    s => { s.projects[0].archived = true; },
    s => { s.conversations[0].projectId = 'other'; },
    s => { s.conversations = []; }
  ]) {
    const state = fixture(), review = Review.begin(state, 'n', state.conversations[0]);
    mutate(state); const before = JSON.stringify(state);
    assert.throws(() => Review.prepare(state, review, 'adopt'), /修改|归属|归档/);
    assert.equal(JSON.stringify(state), before);
  }
});
test('recent result group wins while multiple active drafts in the same result require choice', () => {
  const state = fixture(), conversation = state.conversations[0];
  state.notes.push({ ...structuredClone(state.notes[0]), id: 'n2' });
  conversation.messages.push({ at: 3, results: [{ type: 'note', id: 'n2' }] });
  assert.deepEqual(Review.resolve(state, conversation, 'accept draft').candidateIds, ['n2']);
  conversation.messages.at(-1).results.push({ type: 'note', id: 'n' });
  const result = Review.resolve(state, conversation, '采纳草稿。');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidateIds, ['n2', 'n']);
});
test('short command resolution enforces project and unbound conversation result scope', () => {
  const state = fixture(), conversation = state.conversations[0];
  state.notes.push({ ...structuredClone(state.notes[0]), id: 'foreign', projectId: 'other' });
  conversation.messages.push({ at: 3, results: [{ type: 'note', id: 'foreign' }] });
  assert.deepEqual(Review.resolve(state, conversation, '采纳').candidateIds, ['n']);
  assert.throws(() => Review.begin(state, 'foreign', conversation), /不属于/);
  conversation.projectId = null;
  conversation.workspace = 'auto';
  conversation.messages = [];
  assert.equal(Review.resolve(state, conversation, '采纳').status, 'missing');
  assert.throws(() => Review.begin(state, 'n', conversation), /不属于/);
  state.agentRuns.push({ id: 'r', conversationId: 'c', startedAt: 5, results: [{ type: 'note', id: 'n' }] });
  assert.deepEqual(Review.resolve(state, conversation, 'discard draft').candidateIds, ['n']);
});
test('ordinary supplementary messages and quoted commands never trigger direct adoption', () => {
  for (const text of ['这个是论文全文', '请说明采纳草稿会做什么', '不要采纳', '"采纳"', 'accept draft and delete project']) assert.equal(Review.command(text), null);
  for (const text of ['采纳', '采纳草稿', 'Accept draft!', 'accept']) assert.equal(Review.command(text), 'adopt');
});
test('discarded draft history survives later adoption and removed draft cannot be adopted twice', () => {
  const state = fixture();
  const discard = Review.prepare(state, Review.begin(state, 'n'), 'discard', 8);
  state.notes[0] = discard.after;
  assert.equal(Review.resolve(state, state.conversations[0], '采纳').status, 'missing');
  state.notes[0].aiDraft = { content: 'Newer full draft', sourceAttachmentIds: ['newer'] };
  const change = Review.prepare(state, Review.begin(state, 'n'), 'adopt', 9);
  assert.equal(change.after.aiDraftHistory.length, 2);
  assert.equal(change.after.aiDraftHistory[0].action, 'discard');
  assert.deepEqual(change.after.sourceAttachmentIds, ['old', 'newer']);
});
