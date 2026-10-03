const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
const start = appSource.indexOf('async function saveMessageAsNote(');
const end = appSource.indexOf('\nfunction openNote(', start);
assert.ok(start >= 0 && end > start, 'extract the actual production capture handler');
const handler = appSource.slice(start, end);
const copy = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  return {
    notes: [], imports: [], tasks: [], papers: [], links: [],
    currentConversationId: 'conversation', currentProjectId: 'course', ui: { lastView: 'agent' },
    projects: [{ id: 'course', name: '语言模型课程', workspace: '课程' }],
    conversations: [{ id: 'conversation', title: '课程整理', workspace: '课程', projectId: 'course',
      messages: [{ id: 'answer', role: 'agent', runId: 'run', text: '# 学习笔记\n\n这是实际回答。', at: 1 }] }],
    agentRuns: [{ id: 'run', conversationId: 'conversation', status: 'completed' }],
  };
}

function harness(options = {}) {
  const state = options.state || fixture();
  const calls = { durable: [], rollback: [], opened: [], edited: [], toasts: [], events: [], renders: 0 };
  let nextId = 0;
  const context = vm.createContext({
    state, Date, URL, structuredClone,
    document: { body: { dataset: { view: state.ui?.lastView || 'agent' } } },
    previewRequestVersion: 0,
    showView() {},
    uid: prefix => `${prefix}_${++nextId}`,
    toast: message => { calls.toasts.push(String(message)); calls.events.push('toast'); },
    save: () => { calls.rollback.push(copy(state.notes)); calls.events.push('save'); return true; },
    renderAll: () => { calls.renders++; calls.events.push('render'); },
    openNote: async id => { calls.opened.push(id); calls.events.push('open'); },
    saveDocumentDurably: async () => {
      calls.durable.push(copy(state.notes)); calls.events.push('durable:start');
      try {
        const result = options.persist ? await options.persist(state, calls) : true;
        calls.events.push('durable:resolved'); return result;
      } catch (error) { calls.events.push('durable:rejected'); throw error; }
    },
    ReadingPane: { isActive: () => true },
    NoteEditor: { editInline: id => { calls.edited.push(id); calls.events.push('edit'); } },
  });
  context.window = context;
  for (const name of ['artifact-provenance.js', 'citation-evidence.js', 'note-capture.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'app', name), 'utf8'), context, { filename: name });
  }
  vm.runInContext(handler, context, { filename: 'app.js:saveMessageAsNote' });
  return { state, calls, context, capture: id => context.saveMessageAsNote(id) };
}

function noSuccess(calls) {
  assert.deepEqual(calls.opened, [], 'no preview before durable confirmation');
  assert.deepEqual(calls.edited, [], 'no editor before durable confirmation');
  assert.ok(!calls.toasts.some(value => /已存为文档|已为你打开|已进入编辑/.test(value)), 'no success toast');
}

test('capture awaits durable confirmation and concurrent clicks on one message create and open once', async () => {
  const gate = deferred(), h = harness({ persist: () => gate.promise });
  const first = h.capture('answer');
  const second = h.capture('answer');
  assert.equal(h.calls.durable.length, 1);
  assert.equal(h.state.notes.length, 1);
  noSuccess(h.calls);
  gate.resolve(true);
  await Promise.all([first, second]);
  assert.equal(h.calls.opened.length, 1);
  assert.deepEqual(h.calls.edited, h.calls.opened);
  assert.equal(h.calls.opened[0], h.state.notes[0].id);
  assert.ok(h.calls.events.indexOf('durable:resolved') < h.calls.events.indexOf('open'));
  assert.equal(h.calls.toasts.filter(value => /已存为文档/.test(value)).length, 1);
});

test('pending capture only locks its own message, not another answer', async () => {
  const firstGate = deferred(), secondGate = deferred();
  const h = harness({ persist: (_state, calls) => calls.durable.length === 1 ? firstGate.promise : secondGate.promise });
  h.state.conversations[0].messages.push({ id: 'other', role: 'agent', text: '另一份整理', at: 2 });
  const first = h.capture('answer'), second = h.capture('other');
  assert.equal(h.calls.durable.length, 2);
  assert.deepEqual(h.state.notes.map(note => note.sourceMessageId).sort(), ['answer', 'other']);
  noSuccess(h.calls);
  secondGate.resolve(true); await second;
  assert.deepEqual(h.calls.opened, [h.state.notes.find(note => note.sourceMessageId === 'other').id]);
  firstGate.resolve(true); await first;
  assert.equal(h.calls.opened.length, 2);
});

for (const failure of ['rejected', 'false']) {
  test(`a ${failure} durable save rolls back only the new note and permits one clean retry`, async () => {
    let fail = true;
    const h = harness({ persist: async () => {
      if (!fail) return true;
      if (failure === 'false') return false;
      throw Error('Fixture durable write failure');
    } });
    const unrelated = { id: 'unrelated', content: '不要修改', sourceAttachmentIds: ['other-pdf'] };
    h.state.notes.push(unrelated);
    await h.capture('answer');
    assert.deepEqual(h.state.notes, [unrelated]);
    assert.equal(h.calls.rollback.length, 1, 'queue the rolled-back state for ordinary persistence');
    assert.deepEqual(h.calls.rollback[0], [unrelated]);
    noSuccess(h.calls);
    assert.ok(h.calls.toasts.length > 0, 'surface the failed save');
    fail = false;
    await h.capture('answer');
    const saved = h.state.notes.filter(note => note.sourceMessageId === 'answer');
    assert.equal(saved.length, 1);
    assert.equal(h.calls.durable.length, 2);
    assert.deepEqual(h.calls.opened, [saved[0].id]);
    assert.equal(h.state.notes[0], unrelated);
  });
}

const concurrentChanges = {
  edited(note) { note.content = '保存期间的人工编辑'; note.updatedAt += 1; },
  replaced(note, state) { state.notes[state.notes.indexOf(note)] = copy(note); },
  archived(note) { note.archived = true; },
  deleted(note) { note.deletedAt = 123; },
};
for (const [name, change] of Object.entries(concurrentChanges)) {
  test(`failed capture preserves a concurrently ${name} note`, async () => {
    const gate = deferred(), h = harness({ persist: () => gate.promise });
    const pending = h.capture('answer');
    const original = h.state.notes[0];
    assert.ok(original);
    change(original, h.state);
    const survivor = h.state.notes[0], before = copy(survivor);
    gate.reject(Error('Fixture durable write failure'));
    await pending;
    assert.equal(h.state.notes.length, 1);
    assert.equal(h.state.notes[0], survivor, 'a failed capture cannot remove a concurrently owned record');
    assert.deepEqual(copy(h.state.notes[0]), before);
    noSuccess(h.calls);
  });
}

const concurrentReferences = {
  task(note, state) { state.tasks.push({ id: 'referencing-task', sourceNoteIds: [note.id] }); },
  result(note, state) { state.conversations[0].messages.push({ id: 'referencing-result', role: 'agent', results: [{ type: 'note', id: note.id }] }); },
  'incoming link'(note, state) { state.links.push({ id: 'referencing-link', sourceType: 'task', sourceId: 'task', targetType: 'note', targetId: note.id }); },
  'outgoing link'(note, state) { state.links.push({ id: 'referencing-link', sourceType: 'note', sourceId: note.id, targetType: 'task', targetId: 'task' }); },
};
for (const [name, reference] of Object.entries(concurrentReferences)) {
  test(`failed capture preserves an unchanged note newly referenced by a ${name}`, async () => {
    const gate = deferred(), h = harness({ persist: () => gate.promise });
    const pending = h.capture('answer');
    const note = h.state.notes[0], noteBefore = copy(note);
    reference(note, h.state);
    const before = copy(h.state);
    assert.deepEqual(copy(note), noteBefore, 'only a foreign reference changed, not the captured note');
    gate.reject(Error('Fixture durable write failure'));
    await pending;
    assert.equal(h.state.notes[0], note, 'a newly referenced note must not become a dangling link');
    assert.deepEqual(copy(h.state), before);
    noSuccess(h.calls);
  });
}

test('failed capture does not resurrect a concurrently removed note or delete another new note', async () => {
  const gate = deferred(), h = harness({ persist: () => gate.promise });
  const pending = h.capture('answer');
  h.state.notes.splice(0, 1);
  const other = { id: 'another-note', content: '另一操作创建的笔记' };
  h.state.notes.push(other);
  gate.reject(Error('Fixture durable write failure'));
  await pending;
  assert.deepEqual(h.state.notes, [other]);
  noSuccess(h.calls);
});

test('retrying an unconfirmed concurrent edit persists the same document before opening it', async () => {
  const firstGate = deferred(), retryGate = deferred();
  const h = harness({ persist: (_state, calls) => calls.durable.length === 1 ? firstGate.promise : retryGate.promise });
  const first = h.capture('answer'), note = h.state.notes[0];
  note.content = '等待保存期间的人工修订';
  note.updatedAt += 1;
  firstGate.reject(Error('Fixture write failed'));
  await first;
  noSuccess(h.calls);
  const retry = h.capture('answer');
  assert.equal(h.calls.durable.length, 2, 'an existing but unconfirmed capture must retry persistence');
  assert.equal(h.state.notes.length, 1);
  assert.equal(h.state.notes[0], note);
  assert.equal(h.calls.durable[1][0].content, '等待保存期间的人工修订');
  noSuccess(h.calls);
  retryGate.resolve(true);
  await retry;
  assert.deepEqual(h.calls.opened, [note.id]);
  assert.deepEqual(h.calls.edited, [note.id]);
  assert.equal(h.calls.rollback.length, 0);
});

test('a reader failure after confirmed persistence keeps the committed note and opens it on retry', async () => {
  const h = harness();
  const open = h.context.openNote;
  h.context.openNote = async () => { throw Error('Fixture reader unavailable'); };
  assert.equal(await h.capture('answer'), false);
  assert.equal(h.state.notes.length, 1);
  const note = h.state.notes[0];
  assert.equal(h.calls.durable.length, 1);
  assert.equal(h.calls.rollback.length, 0, 'a committed record is never rolled back because its reader failed');
  noSuccess(h.calls);
  h.context.openNote = open;
  await h.capture('answer');
  assert.equal(h.state.notes.length, 1);
  assert.equal(h.state.notes[0], note);
  assert.equal(h.calls.durable.length, 1, 'retry an open, not the already confirmed write');
  assert.deepEqual(h.calls.opened, [note.id]);
});

const laterNavigation = {
  conversation(h) { h.state.currentConversationId = 'other-conversation'; },
  settings(h) { h.state.ui.lastView = 'settings'; h.context.document.body.dataset.view = 'settings'; },
  project(h) { h.state.currentProjectId = 'another-project'; },
  'reader document'(h) { h.context.previewRequestVersion += 1; h.state.previewRecord = { type: 'import', id: 'another-pdf' }; },
  'away and back to the same route'(h) { h.context.showView.navigationVersion = 2; },
};
for (const [name, navigate] of Object.entries(laterNavigation)) {
  test(`durable completion after navigating to ${name} preserves the latest location`, async () => {
    const gate = deferred(), h = harness({ persist: () => gate.promise });
    const pending = h.capture('answer'), note = h.state.notes[0];
    navigate(h);
    const latest = copy({ ui: h.state.ui, conversationId: h.state.currentConversationId, projectId: h.state.currentProjectId, preview: h.state.previewRecord });
    gate.resolve(true);
    assert.equal(await pending, true, 'the background write still succeeded');
    assert.equal(h.state.notes[0], note);
    assert.deepEqual(copy({ ui: h.state.ui, conversationId: h.state.currentConversationId, projectId: h.state.currentProjectId, preview: h.state.previewRecord }), latest);
    noSuccess(h.calls);
    assert.ok(h.calls.toasts.some(value => /文档已保存.*稍后/.test(value)), 'notify that the saved note can be opened later');
    if (name === 'conversation') {
      await h.capture('answer');
      assert.deepEqual(h.calls.opened, [], 'an old message ID cannot open from a different conversation');
      h.state.currentConversationId = note.sourceConversationId;
    }
    await h.capture('answer');
    assert.equal(h.calls.durable.length, 1);
    assert.equal(h.state.notes.length, 1);
    assert.deepEqual(h.calls.opened, [note.id], 'a later explicit action may open the existing document');
  });
}

test('a route change while opening a confirmed note does not subsequently force its editor', async () => {
  const gate = deferred(), h = harness();
  h.context.openNote = async id => { h.calls.opened.push(id); await gate.promise; };
  const pending = h.capture('answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.opened.length, 1);
  h.state.currentConversationId = 'newer-conversation';
  gate.resolve();
  await pending;
  assert.deepEqual(h.calls.edited, []);
  assert.ok(h.calls.toasts.some(value => /文档已保存.*稍后/.test(value)));
});

test('an existing captured note opens directly without overwriting manual text or provenance', async () => {
  const h = harness({ persist: async () => { throw Error('Existing notes must not save again'); } });
  const note = { id: 'existing', sourceMessageId: 'answer', sourceConversationId: 'conversation',
    title: '人工标题', content: '人工修订后的正文', sourceAttachmentIds: ['manual-pdf'], sourceNoteIds: ['manual-note'], updatedAt: 72 };
  h.state.notes.push(note);
  const before = copy(h.state);
  await h.capture('answer');
  assert.deepEqual(copy(h.state), before);
  assert.equal(h.state.notes[0], note);
  assert.equal(h.calls.durable.length, 0);
  assert.equal(h.calls.rollback.length, 0);
  assert.deepEqual(h.calls.opened, ['existing']);
});

test('actual PDF citation evidence reaches the saved note, its portable text and durable snapshot', async () => {
  const h = harness();
  const pdf = { id: 'source-pdf', name: '语言模型.pdf', mimeType: 'application/pdf', workspace: '课程', projectId: 'course',
    pages: [{ page: 7, text: '第七页实际证据。' }, { page: 8, text: '第八页补充证据。' }] };
  h.state.imports.push(pdf);
  const run = h.state.agentRuns[0], message = h.state.conversations[0].messages[0];
  const retained = h.context.CitationEvidence.captureRetained(run, [7, 8].map(page => ({
    request: { type: 'read', recordType: 'import', id: pdf.id },
    result: { type: 'import', id: pdf.id, title: pdf.name, page, text: pdf.pages.find(item => item.page === page).text },
  })), h.state);
  message.text = `# 语言模型整理\n\n结论一。[[cite:${retained[0].result.evidenceRef}]]\n\n结论二。[[cite:${retained[1].result.evidenceRef}]]`;
  const before = copy({ message, run, pdf });
  const documentText = h.context.CitationEvidence.documentText(message, run, h.state);
  await h.capture('answer');
  const note = h.state.notes[0];
  assert.equal(note.content, documentText);
  for (const [index, page] of [7, 8].entries()) {
    const href = `#aibro-source-${encodeURIComponent(retained[index].result.evidenceRef)}`;
    assert.ok(note.content.includes(href));
    assert.equal(h.context.CitationEvidence.documentSource(h.state, note.id, href).page, page);
  }
  assert.deepEqual(copy(note.provenance.inputs.map(input => input.page)), [7, 8]);
  assert.ok(!note.content.includes('第七页实际证据'), 'capture retains the answer and source identity without copying immutable excerpts');
  assert.deepEqual(copy(note.sourceAttachmentIds), [pdf.id], 'two cited pages link one real PDF');
  assert.equal(note.sourceMessageId, message.id);
  assert.equal(note.sourceConversationId, 'conversation');
  assert.equal(note.projectId, 'course');
  assert.equal(note.workspace, '课程');
  assert.deepEqual(h.calls.durable[0], [copy(note)]);
  assert.deepEqual(copy({ message, run, pdf }), before, 'capture must not modify the reply, run evidence or original');
  assert.deepEqual(h.calls.opened, [note.id]);
});
