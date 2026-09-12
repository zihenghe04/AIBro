const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildContext, tokens } = require('../app/context-retrieval.js');

const library = () => ({
  projects: [{ id: 'visa', name: '差旅准备', workspace: '日常' }, { id: 'control', name: '智能控制', workspace: '课程' }, { id: 'lab', name: '控制研究', workspace: '科研' }],
  notes: [{ id: 'visa-note', title: '面试材料清单', projectId: 'visa', content: '携带预约单与已核对的材料。', sourceAttachmentIds: ['visa-pdf'] }, { id: 'control-note', title: '李雅普诺夫稳定性', projectId: 'control', content: '使用正定函数判断系统的渐近稳定性。', sourceAttachmentIds: ['control-pdf'] }],
  tasks: [{ id: 'visa-task', title: '核对面试时间', projectId: 'visa', status: 'todo', dueAt: '2026-10-03', description: '以预约单记载为准。', checklist: [{ text: '确认日期', done: true }, { text: '确认地点', done: false }], sourceAttachmentIds: ['visa-pdf'] }],
  papers: [{ id: 'control-paper', title: 'Stability analysis', projectId: 'lab', structured: { methods: { text: 'Use a Lyapunov function for stability.', citations: [{ attachmentId: 'research-pdf', page: 7 }] } }, sourceAttachmentIds: ['research-pdf'] }],
  imports: [{ id: 'visa-pdf', name: '预约单.pdf', projectId: 'visa', content: '面试日期为 2026-10-03。', pages: [{ page: 1, text: '面试日期为 2026-10-03。' }], rawBase64: 'PRIVATE_BYTES_MUST_NOT_BE_SENT' }],
  settings: { apiKey: 'SECRET_KEY_MUST_NOT_BE_SENT' }
});

test('explicit project is a strict boundary even when the query names another project', () => {
  const state = library(); const before = JSON.stringify(state);
  const context = buildContext(state, { projectId: 'visa', query: '智能控制 李雅普诺夫' });
  assert.deepEqual(new Set(context.entries.map(entry => entry.type)), new Set(['note', 'task', 'import']));
  assert.ok(context.entries.every(entry => entry.projectId === 'visa'));
  assert.doesNotMatch(context.text, /正定函数|SECRET_KEY|PRIVATE_BYTES|research-pdf/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(context.coverage.mode, 'project');
});

test('archived/deleted entries and their project descendants never enter retrieval', () => {
  const state = library();
  state.projects.push({ id: 'old', name: '旧资料', workspace: '日常', archived: true });
  state.notes.push(...[{ id: 'old-note', projectId: 'old' }, { id: 'gone-note', projectId: 'visa', deletedAt: 123 }, { id: 'archived-note', projectId: 'visa', archived: true }, { id: 'missing-parent', projectId: 'missing' }, { id: 'deleted-flag', projectId: 'visa', deleted: true }].map(note => ({ title: '面试', content: 'HIDDEN_CONTENT', ...note })));
  const context = buildContext(state, { query: '面试' });
  assert.doesNotMatch(context.text, /HIDDEN_CONTENT/);
  assert.deepEqual(buildContext(state, { projectId: 'old', query: '资料' }).entries, []);
  assert.deepEqual(buildContext(state, { projectId: 'missing', query: '面试' }).entries, []);
  assert.deepEqual(buildContext(state, { projectId: 'visa', workspace: '课程', query: '面试' }).entries, []);
});

test('automatic context stays empty for generic follow-ups and uses explicit project name for scope', () => {
  const state = library();
  for (const query of ['', '继续', '帮我总结一下之前的资料', 'please summarize my notes']) assert.deepEqual(buildContext(state, { query }).entries, [], query);
  const context = buildContext(state, { query: '差旅准备现在还有哪些任务' });
  assert.equal(context.coverage.mode, 'named-project');
  assert.ok(context.entries.length >= 2);
  assert.ok(context.entries.every(entry => entry.projectId === 'visa'));
  assert.deepEqual(buildContext(state, { workspace: '科研', query: '差旅准备' }).entries, []);
});

test('Chinese keyword retrieval works without spaces and avoids matching generic project preparation', () => {
  const state = library();
  state.notes.push({ id: 'travel', title: '旅行准备', workspace: '日常', content: '酒店和交通安排。' });
  const context = buildContext(state, { query: '李雅普诺夫稳定性怎么理解' });
  assert.ok(tokens('李雅普诺夫稳定性怎么理解').some(term => term.includes('稳定')));
  assert.ok(context.entries.some(entry => entry.recordId === 'control-note'));
  assert.ok(context.entries.every(entry => entry.projectId === 'control'));
  assert.equal(buildContext(state, { query: '差旅准备要什么材料' }).entries.some(entry => entry.recordId === 'travel'), false);
});

test('English keyword matching honors word boundaries', () => {
  const state = { notes: [{ id: 'exact', title: 'Attention mechanisms', content: 'Learn attention.' }, { id: 'substring', title: 'Inattention', content: 'Unrelated information.' }] };
  const context = buildContext(state, { query: 'attention' });
  assert.deepEqual(context.entries.map(entry => entry.recordId), ['exact']);
});

test('retrieval finds a relevant later page and preserves source/page metadata', () => {
  const state = library();
  state.imports.push({ id: 'control-pdf', name: '讲义.pdf', projectId: 'control', pages: [{ page: 1, text: '课程安排。'.repeat(700) }, { page: 42, text: '李雅普诺夫稳定性证明使用正定函数。' }], rawBase64: 'PRIVATE_BYTES' });
  const context = buildContext(state, { projectId: 'control', query: '李雅普诺夫稳定性证明', maxChars: 1200 });
  const entry = context.entries.find(item => item.recordId === 'control-pdf');
  assert.ok(entry);
  assert.equal(entry.page, 42);
  assert.deepEqual(entry.sourceAttachmentIds, ['control-pdf']);
  assert.match(entry.text, /稳定性证明/);
  assert.ok(context.text.length <= 1200);
  assert.equal(context.coverage.chars, context.text.length);
});

test('paper retrieval honors user edits and citation evidence instead of older machine text', () => {
  const state = library();
  state.papers[0].userEdits = { methods: { text: '人工修订的 Lyapunov 稳定性结论。', citations: [{ attachmentId: 'research-pdf', page: 9 }] } };
  const context = buildContext(state, { projectId: 'lab', query: 'Lyapunov 稳定性' });
  const entry = context.entries.find(item => item.type === 'paper');
  assert.match(entry.text, /人工修订/);
  assert.doesNotMatch(context.text, /Use a Lyapunov/);
  assert.equal(entry.page, 9);
  assert.deepEqual(entry.citations, [{ attachmentId: 'research-pdf', page: 9 }]);
});

test('new review sections remain searchable with their original evidence and human corrections', () => {
  for (const key of ['training','relatedWork','criticalAnalysis','counterArguments','dataGaps','reproduction']) {
    const state=library();
    state.papers[0].structured[key]={text:'This reproducibilitygap needs an independent holdout.',citations:[{attachmentId:'research-pdf',page:13}]};
    const context=buildContext(state,{workspace:'科研',query:'reproducibilitygap',maxChars:4000});
    const entry=context.entries.find(item=>item.recordId==='control-paper');
    assert.ok(entry, key); assert.match(entry.text,/independent holdout/); assert.equal(entry.page,13);
    state.papers[0].userEdits={[key]:{text:'The reproducibilitygap was corrected by the reader.',citations:[{attachmentId:'research-pdf',page:14}]}};
    const revised=buildContext(state,{workspace:'科研',query:'reproducibilitygap'});
    assert.match(revised.text,/corrected by the reader/); assert.doesNotMatch(revised.text,/independent holdout/);
  }
});

test('relevant excerpts can be retrieved from the end of a large note with stable chunk IDs', () => {
  const state = { notes: [{ id: 'long', title: '阅读记录', content: '普通笔记。'.repeat(2000) + '\n稀疏矩阵特征值求解采用迭代方法。' }] };
  const context = buildContext(state, { query: '稀疏矩阵特征值求解', maxChars: 1500 });
  assert.ok(context.entries.length);
  assert.match(context.entries[0].text, /稀疏矩阵特征值/);
  assert.equal(context.entries[0].id, buildContext(state, { query: '稀疏矩阵特征值求解', maxChars: 1500 }).entries[0].id);
  assert.ok(context.text.length <= 1500);
});

test('budget covers headers, escaped metadata and excerpts without malformed partial records', () => {
  const state = library(); state.notes[0].content = ('引号"与换行\n😀').repeat(5000);
  for (const maxChars of [0, 20, 180, 450, 777, 12000]) {
    const context = buildContext(state, { projectId: 'visa', maxChars });
    assert.ok(context.text.length <= maxChars, `${context.text.length} > ${maxChars}`);
    assert.equal(context.coverage.chars, context.text.length);
    if (context.text) for (const line of context.text.split('\n').slice(1)) assert.ok(JSON.parse(line).id);
    assert.ok(context.entries.every(entry => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(entry.text)));
  }
  assert.equal(buildContext(state, { projectId: 'visa', maxChars: 777 }).coverage.truncated, true);
});

test('task excerpts retain completion state, deadline and checklist, without reading conversations', () => {
  const state = library(); state.conversations = [{ projectId: 'visa', messages: [{ text: 'PRIVATE_CONVERSATION' }] }];
  const entry = buildContext(state, { projectId: 'visa' }).entries.find(item => item.type === 'task');
  assert.match(entry.text, /截止：2026-10-03/);
  assert.match(entry.text, /\[x\] 确认日期/);
  assert.match(entry.text, /\[ \] 确认地点/);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_CONVERSATION/);
});

test('browser UMD exposes the same pure API with malformed collections handled safely', () => {
  const context = { self: {} }; vm.runInNewContext(fs.readFileSync(require.resolve('../app/context-retrieval.js'), 'utf8'), context);
  assert.equal(typeof context.self.ContextRetrieval.buildContext, 'function');
  const result = context.self.ContextRetrieval.buildContext({ projects: null, notes: 'invalid', tasks: [null] }, { query: 'attention' });
  assert.equal(result.text, '');
  assert.equal(result.entries.length, 0);
});


test('tight budgets retain the keyword neighborhood instead of unrelated leading text', () => {
  const state = { notes: [{ id: 'window', title: '长篇记录', content: '普通内容'.repeat(230) + '稀疏矩阵特征值求解方法在这里。' + '结尾'.repeat(20) }] };
  const context = buildContext(state, { query: '稀疏矩阵特征值', maxChars: 550 });
  assert.ok(context.entries.length);
  assert.match(context.entries[0].text, /稀疏矩阵特征值/);
  assert.ok(context.text.length <= 550);
});

test('new unscoped attachments do not pull unrelated projects through generic checklist wording', () => {
  const { buildContext } = require('../app/context-retrieval');
  const state = { projects:[{id:'visa',name:'签证准备',workspace:'日常'}], notes:[{id:'visa-list',title:'材料清单',content:'截止日期与材料清单，护照原件',projectId:'visa',workspace:'日常'}] };
  assert.equal(buildContext(state,{query:'露营新项目，整理材料清单与截止日期',requireProjectMatch:true}).entries.length,0);
  assert.equal(buildContext(state,{query:'签证准备，整理材料清单与截止日期',requireProjectMatch:true}).entries[0].recordId,'visa-list');
});

test('an explicit task allowlist prevents generic time wording from pulling another project task', () => {
  const state = { projects: [{ id: 'daily', workspace: '日常' }, { id: 'research', workspace: '科研' }], tasks: [
    { id: 'own', title: '明天下午准备材料', projectId: 'daily', description: '先核对已有清单。' },
    { id: 'other', title: '明天下午研究讨论', projectId: 'research', description: 'PRIVATE_OTHER_PROJECT_TASK' }
  ] };
  const before = JSON.stringify(state);
  assert.deepEqual(buildContext(state, { query: '明天下午' }).entries.map(entry => entry.recordId).sort(), ['other', 'own']);
  const context = buildContext(state, { query: '明天下午', allowedTaskIds: ['own'] });
  assert.deepEqual(context.entries.map(entry => entry.recordId), ['own']);
  assert.doesNotMatch(context.text, /PRIVATE_OTHER_PROJECT_TASK|明天下午研究讨论/);
  assert.equal(context.coverage.eligibleRecords, 1); assert.equal(context.coverage.matchedRecords, 1); assert.equal(context.coverage.returnedRecords, 1);
  assert.equal(JSON.stringify(state), before);
});

test('empty task scope keeps note, paper and original retrieval intact, even for equal typed IDs', () => {
  const state = library();
  state.papers.push({ id: 'visa-task', title: '签证分析论文', projectId: 'visa', structured: { methods: { text: '研究预约信息验证。' } } });
  state.notes[0].id = 'visa-task'; state.imports[0].id = 'visa-task';
  const context = buildContext(state, { projectId: 'visa', allowedTaskIds: [] });
  assert.deepEqual(context.entries.map(entry => entry.type).sort(), ['import', 'note', 'paper']);
  assert.equal(context.coverage.eligibleRecords, 3); assert.equal(context.coverage.matchedRecords, 3); assert.equal(context.coverage.returnedRecords, 3);
  assert.equal(context.coverage.returnedChunks, 3);
});

test('task allowlists only narrow existing lifecycle, project and workspace restrictions', () => {
  const state = library();
  state.tasks.push({ id: 'archived', title: '面试归档任务', projectId: 'visa', archived: true });
  const all = ['visa-task', 'archived', 'missing'];
  assert.deepEqual(buildContext(state, { projectId: 'visa', allowedTaskIds: all }).entries.filter(entry => entry.type === 'task').map(entry => entry.recordId), ['visa-task']);
  assert.deepEqual(buildContext(state, { projectId: 'control', allowedTaskIds: all }).entries.filter(entry => entry.type === 'task'), []);
  assert.deepEqual(buildContext(state, { workspace: '科研', query: '面试', allowedTaskIds: all }).entries.filter(entry => entry.type === 'task'), []);
});

test('omitted task scope preserves read retrieval; malformed explicit scopes fail closed for tasks only', () => {
  const state = library(), normal = buildContext(state, { projectId: 'visa' });
  assert.deepEqual(buildContext(state, { projectId: 'visa', allowedTaskIds: undefined }), normal);
  for (const allowedTaskIds of [null, 'visa-task', {}, [null, 3, false]]) {
    const context = buildContext(state, { projectId: 'visa', allowedTaskIds });
    assert.ok(context.entries.some(entry => entry.type === 'note'));
    assert.ok(context.entries.some(entry => entry.type === 'import'));
    assert.ok(context.entries.every(entry => entry.type !== 'task'));
    assert.equal(context.coverage.eligibleRecords, normal.coverage.eligibleRecords - 1);
  }
});
