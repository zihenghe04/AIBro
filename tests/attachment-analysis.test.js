const test = require('node:test');
const assert = require('node:assert/strict');
const Analysis = require('../attachment-analysis');
const Core = require('../workstation-core');
const Research = require('../research-library');

const content = '课程围绕数据建模展开。建议先用小规模数据核对误差，再比较不同参数设置；实际提交形式仍需向教师确认。';
function fixture() {
  const run = { id: 'live', status: 'completed', mode: 'ai', conversationId: 'conversation', attachmentIds: ['source'], modelConfig: { provider: 'openai-auth', model: 'real-model' }, results: [{ type: 'note', id: 'note', operation: 'created' }] };
  const state = { projects: [{ id: 'project', name: '项目', workspace: '科研' }], imports: [{ id: 'source', name: '原件.pdf', projectId: 'project', parser: 'local', content: '这是一份课件的原始文字，包含建模实验的基本要求、页码与参考资料。' }],
    notes: [], papers: [], tasks: [], agentRuns: [run], conversations: [{ id: 'conversation' }] };
  return { state, run, source: state.imports[0] };
}
const note = (patch = {}) => ({ id: 'note', title: '建模与实践', content, sourceAttachmentIds: ['source'], agentRunId: 'live', ...patch });
const result = (patch = {}) => ({ type: 'note', id: 'note', operation: 'created', ...patch });

test('parser success, original storage metadata, rename, tags, and project membership remain pending', () => {
  const { state, source } = fixture(); Object.assign(source, { blobHash: 'a'.repeat(64), name: '已整理的新名称.pdf', tags: ['已解析'], parser: 'indexed', parsed: true, analyzed: true });
  assert.deepEqual(Analysis.derive(state, source), { status: 'pending', label: '待 AI 分析', detail: '尚无可用的分析笔记或论文记录；文字索引、改名和归档不代表已分析。', noteIds: [], paperIds: [], taskIds: [] });
});
test('task-only output stays pending while listing explicit related tasks', () => {
  const { state, source, run } = fixture(); state.tasks.push({ id: 'task', sourceAttachmentIds: ['source'], description: content });
  const derived = Analysis.derive(state, source); assert.equal(derived.status, 'pending'); assert.deepEqual(derived.taskIds, ['task']);
  assert.match(derived.detail, /1 个任务/);
  assert.deepEqual(Analysis.markCompleted(state, [{ type: 'task', id: 'task', operation: 'created' }], run).markedIds, []);
});
test('meaningful source-linked note with a completed real run is analyzed, without mutating state', () => {
  const { state, source } = fixture(); state.notes.push(note()); const before = structuredClone(state);
  const derived = Analysis.derive(state, source);
  assert.equal(derived.status, 'analyzed'); assert.deepEqual(derived.noteIds, ['note']); assert.deepEqual(derived.paperIds, []); assert.deepEqual(state, before);
});
test('missing source links and same project/title never imply analysis', () => {
  const { state, source } = fixture(); state.notes.push(note({ sourceAttachmentIds: [], projectId: 'project', title: source.name }));
  state.papers.push({ id: 'paper', projectId: 'project', title: source.name, structured: { methods: content } });
  assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('empty body, headings, placeholders, and arbitrary manual notes without provenance do not count', () => {
  const { state, source } = fixture();
  for (const text of ['', '   ', '# 这份材料的分析笔记标题', '未核验\n\n待补充\nN/A', '**尚未分析**']) { state.notes = [note({ content: text })]; assert.equal(Analysis.derive(state, source).status, 'pending', text); }
  state.notes = [note({ id: 'manual', agentRunId: undefined, content })]; assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('raw copied body and extracted fragments in bullets/headings are indexing rather than analysis', () => {
  const { state, source } = fixture(); source.content = '第一部分要求开展线性拟合实验并记录误差。\n第二部分要求核对参数设置与参考资料。';
  for (const text of [source.content, `# 资料摘要\n${source.content}`, '- 第一部分要求开展线性拟合实验并记录误差。\n- 第二部分要求核对参数设置与参考资料。']) {
    state.notes = [note({ content: text })]; assert.equal(Analysis.derive(state, source).status, 'pending', text);
    assert.deepEqual(Analysis.markCompleted(state, [result()], state.agentRuns[0], 10).markedIds, []);
  }
  state.notes = [note({ content: `${source.content}\n建议将两部分实验使用同一份基准数据，以便控制变量并比较误差来源。` })];
  assert.equal(Analysis.derive(state, source).status, 'analyzed');
});
test('local fallback, simulation, failed, pending approval, and cancelled runs cannot qualify', () => {
  for (const patch of [{ mode: 'local' }, { mode: 'local-fallback' }, { status: 'completed-local' }, { status: 'completed-local-fallback' }, { status: 'failed' }, { status: 'awaiting-approval' }, { status: 'cancelled' }, { status: 'running' }, { error: 'provider failed' }]) {
    const { state, source, run } = fixture(); Object.assign(run, patch); state.notes.push(note({ kind: '论文分析' }));
    assert.equal(Analysis.derive(state, source).status, 'pending', JSON.stringify(patch)); assert.deepEqual(Analysis.markCompleted(state, [result()], run, 10).markedIds, []);
  }
});
test('known local provenance defeats legacy analysis kinds and source-conversation-only paper fallback', () => {
  const { state, source, run } = fixture(); run.mode = 'local';
  state.notes = [note({ agentRunId: undefined, sourceConversationId: run.conversationId, kind: '资料摘要' })];
  state.papers = [{ id: 'paper', sourceConversationId: run.conversationId, sourceAttachmentIds: ['source'], structured: { methods: content } }];
  assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('fallback text is excluded even when historical provenance is missing', () => {
  const { state, source } = fixture(); state.agentRuns = [];
  state.notes = [note({ agentRunId: undefined, kind: '论文分析', content: `基于已提取文本的初步摘要：${content}` })];
  state.papers = [{ id: 'paper', sourceAttachmentIds: ['source'], structured: { tldr: `基于已提取文本的初步摘要：${content}`, methods: '未核验' } }];
  assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('fallback parser instructions and a filename-only summary are not substantive analysis', () => {
  const { state, source } = fixture(); state.agentRuns = []; source.content = ''; source.name = '课程理论与实践讲义完整版.pdf';
  state.notes = [note({ agentRunId: undefined, kind: '资料摘要', content: source.name })];
  assert.equal(Analysis.derive(state, source).status, 'pending');
  state.notes[0].content = '未核验：当前解析器没有提取到论文正文，请使用支持视觉/文件输入的模型继续分析。';
  assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('legacy real runs and explicit meaningful analysis kinds remain readable without retroactive metadata mutation', () => {
  const { state, source, run } = fixture(); delete run.mode; state.notes = [note()];
  assert.equal(Analysis.derive(state, source).status, 'analyzed');
  state.notes[0].agentRunId = undefined; state.notes[0].sourceConversationId = run.conversationId; assert.equal(Analysis.derive(state, source).status, 'analyzed');
  state.agentRuns = []; state.notes[0].sourceConversationId = undefined; state.notes[0].kind = '资料分析';
  assert.equal(Analysis.derive(state, source).status, 'analyzed'); assert.equal(source.analysis, undefined);
});
test('a bare analyzed flag and dangling metadata references never override missing analysis output', () => {
  const { state, source } = fixture(); source.analysis = { status: 'analyzed', runId: 'live', analyzedAt: 10, noteIds: ['missing'], paperIds: ['missing'] };
  assert.equal(Analysis.derive(state, source).status, 'pending');
  state.notes = [note({ content: '未核验' })]; source.analysis.noteIds = ['note']; assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('explicit bounded metadata preserves valid evidence when device-local run history is absent', () => {
  const { state, source } = fixture(); state.agentRuns = []; state.notes = [note({ agentRunId: undefined })];
  source.analysis = { status: 'analyzed', runId: 'cloud-synced-run', analyzedAt: 10, noteIds: ['note'], paperIds: [] };
  assert.equal(Analysis.derive(state, source).status, 'analyzed');
  source.analysis.analyzedAt = 'fake'; assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('explicit pending metadata blocks permissive legacy kinds and cross-device intermediate outputs', () => {
  const { state, source, run } = fixture(); source.analysis = { status: 'pending' };
  state.notes = [note({ kind: '论文分析' })];
  state.papers = [{ id: 'paper', sourceAttachmentIds: ['source'], sourceConversationId: run.conversationId, structured: { methods: content } }];
  assert.equal(Analysis.derive(state, source).status, 'analyzed'); // A known completed live run is durable evidence on this device.
  state.agentRuns = []; assert.equal(Analysis.derive(state, source).status, 'pending');
  const stamped = Analysis.markCompleted(state, [result(), { type: 'paper', id: 'paper', operation: 'created' }], run, 10).state;
  assert.equal(Analysis.derive(stamped, stamped.imports[0]).status, 'analyzed');
  assert.equal(Analysis.derive(stamped, stamped.imports[0]).label, '已分析 · 已关联');
});
test('completed matched, drafted, task-only and answer-only runs cannot promote pending source-linked notes', () => {
  for (const rows of [[result({ operation: 'matched' })], [result({ operation: 'drafted' })], [{ type: 'task', id: 'note', operation: 'created' }], []]) {
    for (const ownership of ['run', 'conversation']) {
      const { state, source, run } = fixture(); source.analysis = { status: 'pending' }; run.results = rows;
      state.notes = [note({ agentRunId: ownership === 'run' ? run.id : undefined, sourceConversationId: run.conversationId, kind: '资料分析' })];
      assert.equal(Analysis.derive(state, source).status, 'pending', `${ownership}: ${JSON.stringify(rows)}`);
      assert.deepEqual(Analysis.markCompleted(state, rows, run, 10).markedIds, []);
    }
  }
});
test('sourceConversationId alone cannot upgrade pending notes after a later successful reply', () => {
  const { state, source, run } = fixture(); source.analysis = { status: 'pending' }; run.results = [];
  state.notes = [note({ agentRunId: undefined, sourceConversationId: run.conversationId, kind: '资料分析' })];
  state.agentRuns.push({ id: 'later', status: 'completed', mode: 'ai', conversationId: run.conversationId, attachmentIds: ['source'], results: [{ type: 'note', id: 'unrelated', operation: 'created' }] });
  assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('deleted or archived outputs, source, and parent projects cannot keep an analyzed badge alive', () => {
  for (const flag of ['archived', 'archivedAt', 'deleted', 'deletedAt']) {
    const { state, source } = fixture(); state.notes = [note({ [flag]: true })]; assert.equal(Analysis.derive(state, source).status, 'pending', flag);
  }
  const { state, source } = fixture(); state.notes = [note({ projectId: 'project' })]; state.projects[0].archived = true;
  assert.equal(Analysis.derive(state, source).status, 'pending'); state.projects[0].archived = false; assert.equal(Analysis.derive(state, source).status, 'analyzed');
  state.imports = []; assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('archiving successful run history does not invalidate still-active durable analysis', () => {
  const { state, source, run } = fixture(); state.notes = [note()]; run.archived = true;
  assert.equal(Analysis.derive(state, source).status, 'analyzed'); assert.deepEqual(Analysis.markCompleted(state, [result()], run, 10).markedIds, []);
});
test('markCompleted returns a pure imports-only update and touches only real changed linked outputs', () => {
  const { state, source, run } = fixture(); state.imports.push({ id: 'untouched', name: '其他文件.pdf' }); state.notes = [note()];
  const before = structuredClone(state), outcome = Analysis.markCompleted(state, [result(), result(), { type: 'import', id: 'untouched', operation: 'renamed' }], run, 123);
  assert.deepEqual(state, before); assert.notEqual(outcome.state, state); assert.equal(outcome.state.notes, state.notes); assert.equal(outcome.state.agentRuns, state.agentRuns);
  assert.equal(outcome.state.imports[1], state.imports[1]); assert.equal(source.analysis, undefined); assert.deepEqual(outcome.markedIds, ['source']);
  assert.deepEqual(outcome.state.imports[0].analysis, { status: 'analyzed', runId: 'live', analyzedAt: 123, noteIds: ['note'], paperIds: [] });
  assert.equal(Analysis.derive(outcome.state, outcome.state.imports[0]).status, 'analyzed');
  const retry = Analysis.markCompleted(outcome.state, [result()], run, 123); assert.equal(retry.state, outcome.state); assert.deepEqual(retry.markedIds, []);
});
test('matched, drafted, deleted, rename, membership, and task-only results do not stamp analysis', () => {
  const { state, run } = fixture(); state.notes = [note({ aiDraft: { content } })];
  for (const operation of ['matched', 'drafted', 'deleted', 'renamed', 'assigned', undefined]) assert.deepEqual(Analysis.markCompleted(state, [result({ operation })], run, 10).markedIds, [], String(operation));
  assert.equal(state.imports[0].analysis, undefined);
});
test('live updated analysis can replace old fallback provenance, but matching a copied fallback cannot', () => {
  const { state, source, run } = fixture(); state.agentRuns.push({ id: 'old-local', status: 'completed-local', mode: 'local' });
  state.notes = [note({ agentRunId: 'old-local' })]; assert.equal(Analysis.derive(state, source).status, 'pending');
  const updated = Analysis.markCompleted(state, [result({ operation: 'updated' })], run, 123);
  assert.equal(Analysis.derive(updated.state, updated.state.imports[0]).status, 'analyzed');
  state.notes[0].content = source.content; const matched = Analysis.markCompleted(state, [result({ operation: 'matched' })], run, 123);
  assert.deepEqual(matched.markedIds, []); assert.equal(Analysis.derive(matched.state, source).status, 'pending');
});
test('paper metadata, citations and placeholder Markdown without substantive sections are not analysis', () => {
  const { state, source, run } = fixture(); const paper = { id: 'paper', title: '论文标题', noteId: 'paper-note', sourceAttachmentIds: ['source'], sourceConversationId: run.conversationId, structured: { methods: { text: '未核验', citations: [{ attachmentId: 'source', page: 1, quote: '原始引用文字是一段完整句子。' }] } } };
  state.papers = [paper]; state.notes = [note({ id: 'paper-note', paperId: 'paper', kind: '论文分析', content: Research.paperMarkdown(paper) })];
  assert.equal(Analysis.derive(state, source).status, 'pending');
  state.papers = []; assert.equal(Analysis.derive(state, source).status, 'pending');
});
test('actual Core upsert_paper note result marks both durable analysis outputs and survives loss of either one', () => {
  const { state, source, run } = fixture(); state.links = []; state.trash = [];
  const applied = Core.applyPlan(state, [{ type: 'upsert_paper', title: '实验分析', projectId: 'project', sourceAttachmentIds: ['source'], structured: { methods: { text: content, verified: false } } }], { workspace: '科研', runId: run.id, conversationId: run.conversationId, now: 123 });
  assert.equal(applied.results.length, 1); assert.equal(applied.results[0].type, 'note');
  const outcome = Analysis.markCompleted(applied.state, applied, run, 123), currentSource = outcome.state.imports[0];
  assert.deepEqual(outcome.markedIds, ['source']); assert.equal(currentSource.analysis.noteIds.length, 1); assert.equal(currentSource.analysis.paperIds.length, 1);
  assert.equal(Analysis.derive(outcome.state, currentSource).status, 'analyzed');
  outcome.state.notes = []; assert.equal(Analysis.derive(outcome.state, currentSource).status, 'analyzed');
  outcome.state.papers = []; assert.equal(Analysis.derive(outcome.state, currentSource).status, 'pending');
  assert.equal(source.analysis, undefined);
});
test('multiple source links are explicit and existing valid analysis references remain after another successful output', () => {
  const { state, source, run } = fixture(); state.imports.push({ id: 'second', name: '图表.pdf' }); state.notes = [note()];
  const first = Analysis.markCompleted(state, [result()], run, 10).state;
  first.notes.push(note({ id: 'new-note', sourceAttachmentIds: ['source', 'second'], agentRunId: undefined }));
  const second = Analysis.markCompleted(first, [result({ id: 'new-note', operation: 'updated' })], run, 20);
  assert.deepEqual(second.markedIds, ['source', 'second']); assert.deepEqual(second.state.imports[0].analysis.noteIds, ['note', 'new-note']);
  assert.deepEqual(second.state.imports[1].analysis.noteIds, ['new-note']); assert.equal(source.analysis, undefined);
});
test('IDs stay typed and invalid result references or timestamps cannot create claims', () => {
  const { state, run } = fixture(); state.notes = [note()]; state.tasks = [{ id: 'note', sourceAttachmentIds: ['source'] }];
  assert.deepEqual(Analysis.markCompleted(state, [{ type: 'task', id: 'note', operation: 'created' }, result({ id: 'missing' }), result({ id: {} })], run, 10).markedIds, []);
  for (const now of [NaN, Infinity, -1, '123']) assert.deepEqual(Analysis.markCompleted(state, [result()], run, now).markedIds, []);
  const valid = Analysis.derive(state, state.imports[0]); assert.deepEqual(valid.noteIds, ['note']); assert.deepEqual(valid.taskIds, ['note']);
});
test('legacy AI migration persists proof for ordinary course notes so a peer without run history stays analyzed', () => {
  const { state, source, run } = fixture(); delete run.mode; run.finishedAt = 1000; state.notes = [note({ kind: 'note' })];
  const before = structuredClone(state), migrated = Analysis.migrateLegacy(state, 2000);
  assert.deepEqual(migrated.markedIds, ['source']); assert.deepEqual(state, before);
  assert.equal(migrated.state.notes, state.notes); assert.equal(migrated.state.agentRuns, state.agentRuns);
  assert.deepEqual(migrated.state.imports[0].analysis, { status: 'analyzed', runId: 'live', analyzedAt: 1000, noteIds: ['note'], paperIds: [] });
  const peer = { ...migrated.state, agentRuns: [] }; assert.equal(Analysis.derive(peer, peer.imports[0]).status, 'analyzed');
  assert.equal(Analysis.derive({ ...state, agentRuns: [] }, source).status, 'pending');
  const retry = Analysis.migrateLegacy(migrated.state, 9000); assert.equal(retry.state, migrated.state); assert.deepEqual(retry.markedIds, []);
});
test('migration never touches explicit pending or other existing modern analysis metadata', () => {
  const { state, run } = fixture(); state.imports[0].analysis = { status: 'pending' };
  state.imports.push({ id: 'modern', analysis: { status: 'analyzed', runId: 'previous', analyzedAt: 10, noteIds: ['existing'], paperIds: [] } });
  state.notes = [note({ sourceAttachmentIds: ['source', 'modern'] })]; run.finishedAt = 123;
  const before = structuredClone(state), outcome = Analysis.migrateLegacy(state, 500);
  assert.equal(outcome.state, state); assert.deepEqual(outcome.markedIds, []); assert.deepEqual(state, before);
});
test('migration requires explicit completed live created/updated evidence and skips local, failure, draft, matches, and no-run kinds', () => {
  for (const change of [{ mode: 'local' }, { status: 'completed-local' }, { status: 'failed' }, { status: 'awaiting-approval' }, { results: [result({ operation: 'matched' })] }, { results: [result({ operation: 'drafted' })] }, { results: [] }, { results: undefined }, { archived: true }]) {
    const { state, run } = fixture(); Object.assign(run, change); state.notes = [note({ kind: '资料分析' })];
    const outcome = Analysis.migrateLegacy(state, 500); assert.equal(outcome.state, state, JSON.stringify(change)); assert.deepEqual(outcome.markedIds, []);
  }
  const { state } = fixture(); state.agentRuns = []; state.notes = [note({ kind: '资料分析' })];
  assert.equal(Analysis.migrateLegacy(state, 500).state, state);
});
test('migration preserves monotonic updatedAt and uses real finish time or an explicit fallback time', () => {
  const { state, run } = fixture(); state.notes = [note()]; run.finishedAt = 1000; state.imports[0].updatedAt = 5000;
  let outcome = Analysis.migrateLegacy(state, 9000); assert.equal(outcome.state.imports[0].updatedAt, 5000); assert.equal(outcome.state.imports[0].analysis.analyzedAt, 1000);
  const later = '2026-09-12T12:00:00Z'; state.imports[0].updatedAt = later; run.finishedAt = '2026-09-11T12:00:00Z';
  outcome = Analysis.migrateLegacy(state, 9000); assert.equal(outcome.state.imports[0].updatedAt, later); assert.equal(outcome.state.imports[0].analysis.analyzedAt, Date.parse(run.finishedAt));
  delete run.finishedAt; state.imports[0].updatedAt = 5000; outcome = Analysis.migrateLegacy(state, 9000);
  assert.equal(outcome.state.imports[0].updatedAt, 9000); assert.equal(outcome.state.imports[0].analysis.analyzedAt, 9000);
});
test('migration aggregates actual successful outputs but never stamps unrelated kind-only legacy notes', () => {
  const { state, run } = fixture(); run.finishedAt = 10; state.notes = [note(), note({ id: 'kind-only', agentRunId: undefined, kind: '资料分析' }), note({ id: 'second', agentRunId: 'second-run', kind: 'note' })];
  state.agentRuns.unshift({ ...run, id: 'second-run', finishedAt: 20, results: [result({ id: 'second', operation: 'updated' })] });
  const outcome = Analysis.migrateLegacy(state, 50), analysis = outcome.state.imports[0].analysis;
  assert.equal(analysis.runId, 'second-run'); assert.equal(analysis.analyzedAt, 20);
  assert.deepEqual(new Set(analysis.noteIds), new Set(['note', 'second'])); assert.ok(!analysis.noteIds.includes('kind-only'));
});
test('migration retains modern originals for raw-copy checks and cannot mistake copied text as proof', () => {
  const { state } = fixture(); const copied = '这个完整段落来自另一个现代原件，不能因为迁移时过滤原件就被误认为新的分析。';
  state.imports.push({ id: 'modern', content: copied, analysis: { status: 'pending' } });
  state.notes = [note({ content: copied, sourceAttachmentIds: ['source', 'modern'] })];
  const outcome = Analysis.migrateLegacy(state, 50); assert.equal(outcome.state, state); assert.deepEqual(outcome.markedIds, []);
});
