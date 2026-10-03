const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');
const Evidence = require('../app/citation-evidence');
const FileReview = require('../app/file-review');
const Review = require('../app/draft-review');
const Analysis = require('../app/attachment-analysis');
const Continuity = require('../app/conversation-continuity');
const Outcome = require('../app/run-outcome-presentation');

function fixture() {
  let state = {
    projects: [{ id: 'course', workspace: '课程' }],
    imports: [{ id: 'source', name: 'Synthetic lesson.pdf', content: '课件要求先做观察记录，再通过访谈了解体验，最后提交纸面原型。', updatedAt: 100, projectId: 'course', analysis: { status: 'pending' } }],
    notes: [{ id: 'note', title: 'Course notes', content: 'Previous lesson notes.', projectId: 'course', workspace: '课程', updatedAt: 80, sourceAttachmentIds: [] }],
    tasks: [], papers: [], links: [], trash: [],
    conversations: [{ id: 'chat', projectId: 'course', workspace: '课程', messages: [{ id: 'user', role: 'user', attachmentIds: ['source'], text: '整理当前课件并补充课程笔记。' }] }],
    agentRuns: [{ id: 'run', conversationId: 'chat', userMessageId: 'user', projectId: 'course', workspace: '课程', mode: 'ai', status: 'completed', modelConfig: { provider: 'api', model: 'synthetic-model' } }],
  };
  let run = state.agentRuns[0];
  Evidence.capture(run, { type: 'import', id: 'source', origin: 'read_page', page: 1, excerpt: state.imports[0].content }, state);
  const before = structuredClone(state);
  const applied = Core.applyPlan(state, [{ type: 'append_note', noteId: 'note', content: '应先把观察所得与访谈陈述分开记录，再用纸面原型检验假设；不要将个别体验视作普遍结论。', sourceAttachmentIds: ['source'] }], {
    projectId: 'course', workspace: '课程', conversationId: 'chat', runId: run.id, provenanceRun: run, protectNoteUpdates: true, now: 150,
  });
  state = applied.state; run = state.agentRuns[0];
  run.results = applied.results;
  run.fileChanges = FileReview.capture(before, state, applied.results);
  run.approvalReceipt = { id: 'approval', messageId: 'reply', metadataSettled: true, appliedAt: 150, settledAt: 160, savePending: false };
  run.routingReview = { required: true, message: '本轮资料拟归入已有课程，但归属尚未确认。请确认目标课程后再保存。' };
  const message = { id: 'reply', role: 'agent', planPreview: true, runId: run.id, runStatus: 'completed', text: `${run.routingReview.message}\n\n• 补充笔记\n  1 个来源\n\n已批准并执行，具体结果见下方。`, results: structuredClone(run.results) };
  state.conversations[0].messages.push(message);
  return { state, run, message, conversation: state.conversations[0], source: state.imports[0] };
}
async function adopt(f, persist = async () => true) {
  return Review.commit(f.state, Review.begin(f.state, 'note', f.conversation), 'adopt', persist);
}
function status(f) { return Continuity.collect(f.state, f.conversation).ledger[0].status; }

test('a real append proposal stays pending until its separate adoption is saved, then survives reload', async () => {
  const f = fixture();
  assert.equal(f.run.results[0].operation, 'drafted');
  assert.equal(status(f), 'pending');
  assert.equal(Analysis.derive(f.state, f.source).status, 'pending');
  await adopt(f);
  const before = JSON.stringify(f.state);
  assert.equal(status(f), 'read');
  assert.deepEqual(Continuity.collect(f.state, f.conversation).pendingIds, []);
  assert.equal(Analysis.derive(f.state, f.source).status, 'analyzed');
  assert.deepEqual(Analysis.derive(f.state, f.source).noteIds, ['note']);
  assert.deepEqual(f.source.analysis, { status: 'pending' }, 'projection never rewrites persisted source stamps');
  assert.equal(f.run.results[0].operation, 'drafted', 'historical proposal operation is immutable');
  assert.equal(JSON.stringify(f.state), before);
  const reloaded = JSON.parse(before);
  assert.equal(Continuity.collect(reloaded, reloaded.conversations[0]).ledger[0].status, 'read');
});

test('an in-flight or failed adoption cannot clear the pending material indicator', async () => {
  for (const success of [true, false]) {
    const f = fixture(); let settle;
    const promise = adopt(f, () => new Promise(resolve => { settle = resolve; }));
    const checked = success ? promise : assert.rejects(promise, /尚未成功保存/);
    await Promise.resolve();
    assert.equal(f.state.notes[0].aiDraft, undefined, 'adoption is optimistically reflected in memory');
    assert.equal(status(f), 'pending');
    assert.equal(Analysis.derive(f.state, f.source).status, 'pending');
    settle(success); await checked;
    assert.equal(status(f), success ? 'read' : 'pending');
  }
});

test('discarded proposals, unrelated decisions and a replaced body are not completed analysis', async () => {
  const discarded = fixture();
  await Review.commit(discarded.state, Review.begin(discarded.state, 'note'), 'discard', async () => true);
  assert.equal(status(discarded), 'pending');
  for (const mutate of [
    f => { f.state.notes[0].content = '另一个话题的充实正文，但并非此次课件的分析。'; },
    f => { f.state.notes[0].provenance.origin.runId = 'different-run'; },
    f => { f.run.fileChanges[0].after.aiDraft.provenance.origin.runId = 'different-run'; },
    f => { f.state.notes[0].aiDraft = structuredClone(f.run.fileChanges[0].after.aiDraft); },
    f => { delete f.state.notes[0].provenance.outputStamp; },
    f => { f.state.notes[0].sourceAttachmentIds = []; },
  ]) {
    const f = fixture(); await adopt(f); mutate(f);
    assert.equal(status(f), 'pending', mutate.toString());
  }
});

test('missing receipts, changed sources, private/removed outputs and non-real runs fail closed', async () => {
  for (const mutate of [
    f => { f.run.approvalReceipt.savePending = true; },
    f => { delete f.run.approvalReceipt; },
    f => { f.run.approvalSaveError = 'Save failed'; },
    f => { f.run.executionReceipt = { version: 1, phase: 'applied', results: f.run.results }; },
    f => { f.run.executionReceipt = { version: 1, phase: 'committed', results: [] }; },
    f => { f.source.content += 'Updated requirements'; },
    f => { f.source.updatedAt = 101; },
    f => { f.run.evidenceSources = []; },
    f => { f.run.evidenceSources[0].origin = 'search'; },
    f => { f.run.evidenceSources[0].provided = false; },
    f => { f.run.mode = 'local'; },
    f => { f.run.status = 'failed'; },
    f => { f.run.cancelled = true; },
    f => { f.run.private = true; },
    f => { f.run.deletedAt = 200; },
    f => { f.run.results[0].operation = 'matched'; },
    f => { f.state.agentRuns.push(structuredClone(f.run)); },
    f => { f.state.notes[0].private = true; },
    f => { f.state.notes[0].hidden = true; },
    f => { f.state.notes[0].deletedAt = 200; },
    f => { f.state.notes = []; },
  ]) {
    const f = fixture(); await adopt(f); mutate(f);
    assert.equal(status(f), 'pending', mutate.toString());
    assert.equal(Analysis.derive(f.state, f.source).status, 'pending', mutate.toString());
  }
});

test('adopted output evidence remains conversation scoped; explicit full review can still reread it', async () => {
  const f = fixture(); await adopt(f);
  const other = { ...f.conversation, id: 'other' };
  assert.equal(Continuity.collect(f.state, other).ledger[0].status, 'pending');
  assert.ok(Continuity.build(f.state, f.conversation, { goal: '请逐份核对全部材料' }).attachmentIds.includes('source'));
});

test('only the exact settled routing envelope gets a current approval label, including copied text', () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const text = Outcome.settledApprovalText(f.message, f.run);
  assert.equal(text, '课程归属已确认，以下操作已批准并执行。\n\n• 补充笔记\n  1 个来源');
  assert.equal(Outcome.present(f.message, f.run).answerText, text);
  assert.match(Outcome.present(f.message, f.run, { language: 'en' }).answerText, /^Course confirmed/);
  assert.doesNotMatch(Evidence.exportText({ ...f.message, text }, f.run, f.state), /尚未确认|请确认目标课程/);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(Outcome.settledApprovalText({ ...f.message, text }, f.run), text, 'projection is idempotent');
});

test('unsettled receipts and genuine replies mentioning course routing are not rewritten', () => {
  for (const mutate of [
    f => { f.run.status = 'awaiting-save'; },
    f => { f.run.approvalReceipt.savePending = true; },
    f => { delete f.run.approvalReceipt.settledAt; },
    f => { f.run.approvalReceipt.messageId = 'other'; },
    f => { f.run.routingReview.required = false; },
    f => { f.run.executionReceipt = { version: 1, phase: 'applied' }; },
    f => { f.message.planPreview = false; },
    f => { f.message.role = 'user'; },
    f => { f.message.live = true; },
    f => { f.message.text = '引用先前的说法：\n' + f.message.text; },
    f => { f.message.text += '\n不过还需要确认第二门课程。'; },
    f => { f.message.runId = 'different'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(Outcome.settledApprovalText(f.message, f.run), f.message.text, mutate.toString());
  }
});
