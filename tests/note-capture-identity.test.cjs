const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.NOTE_CAPTURE_SOURCE_DIR || path.join(root, 'app');
const app = fs.readFileSync(path.join(sourceRoot, 'app.js'), 'utf8');
const take = (start, end) => {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return app.slice(a, b);
};
const handler = take('async function saveMessageAsNote(', '\nfunction openNote(');
const branch = take('function branchConversationFrom(', '\n\n\n// 会话内分支');
const clone = value => JSON.parse(JSON.stringify(value));
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

function harness(persist = async () => true) {
  const state = { notes: [], imports: [], agentRuns: [], tasks: [], papers: [], links: [], trash: [],
    currentConversationId: 'original', currentProjectId: 'course', ui: { lastView: 'agent' },
    projects: [{ id: 'course', name: '虚构课程', workspace: '课程' }, { id: 'research', name: '虚构研究', workspace: '科研' }],
    conversations: [{ id: 'original', title: '虚构资料问答', workspace: '课程', projectId: 'course',
      messages: [{ id: 'answer', role: 'agent', text: '# 资料整理\n\n这是虚构回答。', at: 1 }] }] };
  const calls = { opened: [], edited: [], durable: [], toasts: [] };
  let next = 0;
  const context = vm.createContext({ state, Date, URL, structuredClone,
    document: { body: { dataset: { view: 'agent' } } }, previewRequestVersion: 0,
    showView() {}, renderAll() {}, save() { return true; },
    currentConversation: () => state.conversations.find(c => c.id === state.currentConversationId),
    conversationPathSaving: () => false,
    openConversation: id => { state.currentConversationId = id; state.currentProjectId = state.conversations.find(c => c.id === id).projectId; },
    uid: prefix => `${prefix}_${++next}`, toast: text => calls.toasts.push(String(text)),
    openNote: async id => calls.opened.push(id),
    saveDocumentDurably: async () => { calls.durable.push(clone(state.notes)); return persist(state, calls); },
    ReadingPane: { isActive: () => true }, NoteEditor: { editInline: id => calls.edited.push(id) },
  });
  context.window = context;
  for (const name of ['artifact-provenance.js', 'citation-evidence.js', 'note-capture.js']) {
    const file = name === 'note-capture.js' ? path.join(sourceRoot, name) : path.join(root, 'app', name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: name });
  }
  vm.runInContext(`${handler}\n${branch}`, context);
  return { state, calls, context, capture: () => context.saveMessageAsNote('answer'), branch: () => context.branchConversationFrom('answer') };
}

test('actual new-conversation fork saves copied reply in its current project with its own source identity', async () => {
  const h = harness(), original = clone(h.state.conversations[0]);
  const child = h.branch();
  assert.equal(child.messages[0].id, original.messages[0].id, 'real fork deliberately retains the prefix message ID');
  child.projectId = 'research'; child.workspace = '科研'; h.state.currentProjectId = 'research';
  await h.capture();
  const note = h.state.notes[0];
  assert.equal(note.sourceConversationId, child.id);
  assert.equal(note.projectId, 'research'); assert.equal(note.workspace, '科研');
  assert.equal(note.sourceMessageId, 'answer');
  assert.deepEqual(clone(h.state.conversations[0]), original);
  assert.deepEqual(h.calls.opened, [note.id]); assert.deepEqual(h.calls.edited, [note.id]);
});

test('branch save cannot open or overwrite the original edited note; each pair is independently idempotent', async () => {
  const h = harness(); await h.capture();
  const original = h.state.notes[0]; original.content = '原文档中的人工修改';
  const before = clone(original), child = h.branch();
  await h.capture(); await h.capture();
  assert.equal(h.state.notes.length, 2);
  const childNote = h.state.notes.find(n => n.sourceConversationId === child.id);
  assert.ok(childNote); assert.notEqual(childNote.id, original.id);
  assert.deepEqual(clone(original), before);
  assert.deepEqual(h.calls.opened, [original.id, childNote.id, childNote.id]);
  assert.equal(h.calls.durable.length, 2);
});

test('concurrent same-ID replies in different conversations save independently while duplicate clicks merge', async () => {
  const first = gate(), second = gate(), h = harness((_s, c) => c.durable.length === 1 ? first.promise : second.promise);
  const originalSave = h.capture(); h.branch();
  const childSave = h.capture(), duplicate = h.capture();
  assert.equal(h.calls.durable.length, 2);
  assert.equal(h.state.notes.length, 2);
  assert.equal(new Set(h.state.notes.map(n => n.sourceConversationId)).size, 2);
  second.resolve(true); await childSave; await duplicate;
  first.resolve(true); await originalSave;
  assert.deepEqual(h.calls.opened, [h.state.notes[1].id], 'late original save does not open across the new route');
});

test('stale or ambiguous current conversation never falls back to another conversation with the same message ID', async () => {
  const h = harness(); h.state.currentConversationId = 'missing';
  await h.capture(); assert.equal(h.state.notes.length, 0); assert.equal(h.calls.durable.length, 0);
  h.state.currentConversationId = 'original'; h.state.conversations.push(clone(h.state.conversations[0]));
  await h.capture(); assert.equal(h.state.notes.length, 0);
  assert.deepEqual(h.calls.opened, []);
});

test('legacy ownerless note is reused only when the source conversation is provably unique', async () => {
  const h = harness(), legacy = { id: 'legacy', sourceMessageId: 'answer', content: '原有人工编辑', workspace: '课程' };
  h.state.notes.push(legacy);
  await h.capture(); assert.deepEqual(h.calls.opened, ['legacy']);
  const child = h.branch(); await h.capture();
  assert.equal(h.state.notes.length, 2);
  assert.equal(h.state.notes[1].sourceConversationId, child.id);
  assert.equal(legacy.content, '原有人工编辑'); assert.equal(legacy.sourceConversationId, undefined);
  assert.equal(h.calls.opened[1], h.state.notes[1].id);
});

test('archiving, trashing or deleting the original cannot transfer an ownerless legacy note to its branch', async () => {
  for (const retire of ['archive', 'trash', 'delete']) {
    const h = harness(), original = h.state.conversations[0];
    const legacy = { id: 'legacy', sourceMessageId: 'answer', content: '原对话已人工编辑的笔记' };
    h.state.notes.push(legacy); const child = h.branch();
    if (retire === 'archive') original.archived = true;
    else { h.state.conversations = h.state.conversations.filter(c => c !== original); if (retire === 'trash') h.state.trash.push({ data: { conversations: [original] } }); }
    await h.capture();
    assert.equal(h.state.notes.length, 2, retire);
    assert.equal(h.state.notes[1].sourceConversationId, child.id, retire);
    assert.notEqual(h.calls.opened[0], legacy.id, retire);
    assert.equal(legacy.content, '原对话已人工编辑的笔记');
  }
});

test('deleted notes are not reused, and a restored note is reused only within its conversation', async () => {
  const h = harness(); await h.capture(); const original = h.state.notes[0];
  const child = h.branch(); await h.capture(); const saved = h.state.notes[1];
  saved.deletedAt = 2;
  const missing = h.context.NoteCapture.existingNote(h.state, 'answer', child.id);
  assert.equal(missing, null, 'must not substitute the original note');
  delete saved.deletedAt; await h.capture();
  assert.equal(h.state.notes.length, 2); assert.equal(h.calls.opened.at(-1), saved.id);
  saved.deletedAt = 3; await h.capture();
  assert.equal(h.state.notes.length, 3); assert.notEqual(h.calls.opened.at(-1), original.id);
  assert.equal(h.state.notes[2].sourceConversationId, child.id);
});

test('same-conversation paths reuse a saved prefix while an unqualified ambiguous lookup fails closed', async () => {
  const h = harness(); await h.capture(); const note = h.state.notes[0];
  h.state.conversations[0].messages = clone(h.state.conversations[0].messages);
  await h.capture(); assert.equal(h.calls.opened.at(-1), note.id); assert.equal(h.state.notes.length, 1);
  h.branch(); assert.equal(h.context.NoteCapture.findMessage(h.state, 'answer'), null);
});

test('actual branch citation receipt survives saved-note capture, page reopening and live source revocation', async () => {
  const h = harness(), E = h.context.CitationEvidence;
  const original = h.state.conversations[0], message = original.messages[0];
  const run = { id: 'execution', conversationId: original.id, status: 'completed' };
  h.state.agentRuns.push(run); message.runId = run.id;
  h.state.imports.push({ id: 'pdf', name: '虚构课件.pdf', projectId: 'course', workspace: '课程',
    pages: [{ page: 3, text: '虚构课件第三页的限定结论。' }] });
  const evidence = E.capture(run, { type: 'import', id: 'pdf', title: '虚构课件.pdf', page: 3, excerpt: '虚构课件第三页的限定结论。' }, h.state);
  message.text = `# 整理\n这份课件提供一个限定结论。[[cite:${evidence.sourceId}]]`;
  const child = h.branch(); child.projectId = 'research'; child.workspace = '科研'; h.state.currentProjectId = 'research';
  assert.equal(child.messages[0].runId, undefined, 'the copy is not an execution');
  await h.capture(); const note = h.state.notes[0];
  assert.equal(note.sourceConversationId, child.id); assert.equal(note.projectId, 'research');
  assert.equal(note.provenance.origin.runId, run.id, 'provenance records the actual original execution');
  assert.equal(note.provenance.origin.conversationId, original.id);
  assert.deepEqual(clone(note.sourceAttachmentIds), ['pdf']);
  const href = `#aibro-source-${encodeURIComponent(evidence.sourceId)}`;
  assert.ok(note.content.includes(href));
  const source = E.documentSource(h.state, note.id, href);
  assert.equal(source.id, 'pdf'); assert.equal(source.page, 3);
  h.state.imports[0].private = true;
  assert.equal(E.documentSource(h.state, note.id, href), null);
  assert.doesNotMatch(E.documentText(child.messages[0], null, h.state), /#aibro-source-/);
  delete h.state.imports[0].private;
  original.deletedAt = 4;
  const blocked = h.context.NoteCapture.plan(h.state, 'answer', { conversationId: child.id, id: 'after-delete', citationEvidence: E });
  assert.equal(blocked.kind, 'exists', 'existing notes remain user-owned and are not silently rewritten');
  note.deletedAt = 5;
  const recaptured = h.context.NoteCapture.plan(h.state, 'answer', { conversationId: child.id, id: 'new-after-delete', citationEvidence: E });
  assert.equal(recaptured.kind, 'create'); assert.deepEqual(clone(recaptured.note.sourceAttachmentIds), []);
  assert.equal(recaptured.note.provenance, undefined);
  assert.doesNotMatch(recaptured.note.content, /#aibro-source-/);
});
