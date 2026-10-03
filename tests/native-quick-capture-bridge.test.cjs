const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const CaptureNotes = require('../app/capture-notes.js');
const source = fs.readFileSync(path.join(__dirname, '../native/Resources/quick-capture.js'), 'utf8');
const id = 'quick_capture_01234567-89ab-4cde-8fab-0123456789ab';
const copy = value => JSON.parse(JSON.stringify(value));
const payload = (changes = {}) => ({ id, text: '记录一个想法\n继续研究', tags: [' 方法 ', '方法'], ...changes });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const calls = { persist: 0, render: 0, write: 0 };
  const state = options.state || {
    notes: [], tasks: [], imports: [], projects: [], links: [], trash: [], conversations: [], agentRuns: [],
    currentProjectId: 'project-keep', currentConversationId: 'conversation-keep',
    ui: { captureDraft: { text: '页面上尚未保存的随记', tags: 'existing', id: null } },
    previewRecord: { type: 'note', id: 'document-open' }
  };
  const forbidden = () => { throw Error('A background capture must not navigate or replace an editor'); };
  const context = {
    state, storageHydrated: true, serverConflict: false, purgeTrash: { syncPaused: false }, TextEncoder,
    document: { body: { dataset: { view: options.view || 'project' } } },
    openNote: forbidden, showView: forbidden, renderAll: forbidden, flushLocalDrafts: forbidden,
    saveDocumentDurably: async () => { calls.persist++; return options.persist ? options.persist(context, calls) : true; }
  };
  context.window = {
    crypto: options.crypto || webcrypto,
    CaptureNotes: {
      write(...args) { calls.write++; return CaptureNotes.write(...args); },
      render() { calls.render++; if (options.renderError) throw Error('render failed'); }
    }
  };
  vm.runInNewContext(source, context);
  return { context, state, calls, save: value => context.window.NativeQuickCapture.save(value) };
}

test('floating capture uses production capture storage and leaves page drafts, route and reader untouched', async () => {
  const f = fixture(), before = copy(f.state);
  const result = await f.save(payload());
  assert.deepEqual(copy(result), { status: 'saved', id });
  assert.equal(f.calls.write, 1); assert.equal(f.calls.persist, 1); assert.equal(f.calls.render, 0);
  const note = f.state.notes[0];
  assert.equal(note.kind, '随记'); assert.equal(note.workspace, '日常'); assert.equal(note.projectId, null);
  assert.equal(note.content, payload().text); assert.deepEqual(note.tags, ['方法']);
  assert.equal(note.sourceQuickCaptureId, id); assert.match(note.quickCaptureFingerprint, /^sha256:[a-f0-9]{64}$/);
  const after = copy(f.state); after.notes = [];
  assert.equal(after.ui.nativeQuickCaptureReceipts[id], note.quickCaptureFingerprint);
  delete after.ui.nativeQuickCaptureReceipts;
  assert.deepEqual(after, before);
});

test('same pending request shares one durable save while a different payload under that ID is refused', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture({ persist: async () => { started.resolve(); return gate.promise; } });
  const first = f.save(payload()), second = f.save(payload());
  assert.equal(first, second);
  await started.promise;
  assert.deepEqual(copy(await f.save(payload({ text: 'different' }))), { status: 'deferred', reason: 'busy' });
  assert.equal(f.calls.persist, 1); assert.equal(f.state.notes.length, 1);
  gate.resolve(true); assert.equal((await first).status, 'saved');
});

test('failed persistence retains the original identity and retries it without a second note', async () => {
  const f = fixture({ persist: (_, calls) => { if (calls.persist === 1) throw Error('offline'); return true; } });
  assert.equal((await f.save(payload())).reason, 'storage_failed');
  const original = copy(f.state.notes[0]);
  assert.equal((await f.save(payload())).status, 'saved');
  assert.equal(f.calls.write, 1); assert.equal(f.calls.persist, 2); assert.equal(f.state.notes.length, 1);
  assert.deepEqual(copy(f.state.notes[0]), original);
});

test('commit followed by a lost acknowledgement can be retried after a bridge restart', async () => {
  let durable;
  const first = fixture({ persist: context => { durable = copy(context.state); throw Error('acknowledgement lost'); } });
  assert.equal((await first.save(payload())).reason, 'storage_failed');
  const restarted = fixture({ state: durable });
  assert.equal((await restarted.save(payload())).status, 'saved');
  assert.equal(restarted.calls.write, 0); assert.equal(restarted.calls.persist, 1);
  assert.equal(restarted.state.notes.length, 1);
});

test('retry acknowledges the original receipt without overwriting subsequent human edits', async () => {
  const f = fixture(); await f.save(payload());
  Object.assign(f.state.notes[0], { title: '人工标题', content: '人工修改后的正文', tags: ['new'], projectId: 'moved' });
  const edited = copy(f.state.notes[0]);
  assert.equal((await f.save(payload())).status, 'saved');
  assert.deepEqual(copy(f.state.notes[0]), edited); assert.equal(f.calls.write, 1);
  assert.equal((await f.save(payload({ text: 'different request' }))).reason, 'collision');
  assert.deepEqual(copy(f.state.notes[0]), edited);
});

for (const lifecycle of ['archived', 'deletedAt', 'trash']) {
  test(`retry never resurrects a ${lifecycle} capture`, async () => {
    const f = fixture(); await f.save(payload());
    if (lifecycle === 'trash') f.state.trash.push({ id: 'trash-one', data: { notes: f.state.notes.splice(0) } });
    else f.state.notes[0][lifecycle] = lifecycle === 'archived' ? true : 123;
    const before = copy(f.state);
    assert.equal((await f.save(payload())).reason, 'removed');
    assert.equal(f.calls.persist, 1); assert.deepEqual(copy(f.state), before);
  });
}

test('new ID collisions and duplicate IDs fail without touching unrelated notes', async () => {
  for (const place of ['notes', 'trash']) {
    const f = fixture(), foreign = { id, kind: '随记', content: payload().text };
    if (place === 'notes') f.state.notes.push(foreign);
    else f.state.trash.push({ data: { notes: [foreign] } });
    const before = copy(f.state);
    assert.equal((await f.save(payload())).reason, 'collision');
    assert.equal(f.calls.persist, 0); assert.deepEqual(copy(f.state), before);
  }
  const f = fixture(); await f.save(payload()); f.state.notes.push(copy(f.state.notes[0]));
  assert.equal((await f.save(payload())).reason, 'collision'); assert.equal(f.calls.persist, 1);
});

test('strict save confirmation and a live post-save receipt are both required', async () => {
  for (const result of [false, undefined, { ok: true }]) {
    const f = fixture({ persist: () => result });
    assert.equal((await f.save(payload())).reason, 'storage_failed'); assert.equal(f.state.notes.length, 1);
  }
  const f = fixture({ persist: context => { context.state = { ...context.state, notes: [] }; return true; } });
  assert.equal((await f.save(payload())).reason, 'removed');
  const merged = fixture({ persist: context => { context.state = copy(context.state); return true; } });
  assert.equal((await merged.save(payload())).status, 'saved');
  const removed = fixture({ persist: context => { context.state.notes[0].archived = true; return true; } });
  assert.equal((await removed.save(payload())).reason, 'removed');
});

test('hydration, sync conflicts, purge and unavailable hashing fail before mutation', async () => {
  for (const [field, value, reason] of [['storageHydrated', false, 'hydrating'], ['serverConflict', true, 'conflict'], ['purgeTrash', { syncPaused: true }, 'busy']]) {
    const f = fixture(); f.context[field] = value;
    assert.equal((await f.save(payload())).reason, reason); assert.equal(f.calls.write, 0); assert.equal(f.calls.persist, 0);
  }
  const f = fixture({ crypto: {} });
  assert.equal((await f.save(payload())).reason, 'unavailable'); assert.equal(f.calls.write, 0);
});

test('state is rechecked after asynchronous hashing', async () => {
  const gate = deferred();
  const f = fixture({ crypto: { subtle: { digest: async (...args) => { await gate.promise; return webcrypto.subtle.digest(...args); } } } });
  const pending = f.save(payload()); f.context.serverConflict = true; gate.resolve();
  assert.equal((await pending).reason, 'conflict'); assert.equal(f.calls.write, 0);
});

test('caller mutation while hashing cannot change the immutable pending text or tags', async () => {
  const gate = deferred();
  const f = fixture({ crypto: { subtle: { digest: async (...args) => { await gate.promise; return webcrypto.subtle.digest(...args); } } } });
  const value = payload(), original = copy(value), pending = f.save(value);
  value.text = 'new input'; value.tags.push('later'); gate.resolve();
  assert.equal((await pending).status, 'saved');
  assert.equal(f.state.notes[0].content, original.text); assert.deepEqual(f.state.notes[0].tags, ['方法']);
  assert.equal((await f.save(original)).status, 'saved'); assert.equal(f.state.notes.length, 1);
});

test('invalid input is rejected before any persistence, including UTF-16 overflow', async () => {
  const f = fixture();
  for (const value of [null, [], {}, payload({ id: 'unrelated' }), payload({ id: id.toUpperCase() }), payload({ text: ' \n' }), payload({ text: '😀'.repeat(100001) }), payload({ tags: [1] }), payload({ tags: null }), { ...payload(), projectId: 'injected' }]) {
    assert.equal((await f.save(value)).reason, 'invalid');
  }
  assert.equal(f.calls.write, 0); assert.equal(f.calls.persist, 0);
  assert.equal((await f.save(payload({ text: '😀'.repeat(100000) }))).status, 'saved');
});

test('only the active capture list refreshes, and an optional render error does not discard success', async () => {
  const f = fixture({ view: 'captures', renderError: true });
  const before = copy(f.state.ui.captureDraft);
  assert.equal((await f.save(payload())).status, 'saved'); assert.equal(f.calls.render, 1);
  assert.deepEqual(copy(f.state.ui.captureDraft), before);
});

test('durable hash receipts prevent resurrection after permanent trash purge and restart', async () => {
  let durable;
  const f = fixture({ persist: context => { durable = copy(context.state); throw Error('lost acknowledgement'); } });
  assert.equal((await f.save(payload())).reason, 'storage_failed');
  durable.notes = []; durable.trash = [];
  const restarted = fixture({ state: durable });
  const before = copy(restarted.state);
  assert.equal((await restarted.save(payload())).reason, 'removed');
  assert.equal(restarted.calls.write, 0); assert.equal(restarted.calls.persist, 0);
  assert.deepEqual(copy(restarted.state), before);
  assert.equal((await restarted.save(payload({ text: 'different' }))).reason, 'collision');
});

test('a matching older note receipt is backfilled, while malformed or conflicting ledgers are preserved', async () => {
  const f = fixture(); await f.save(payload());
  const note = copy(f.state.notes[0]); delete f.state.ui.nativeQuickCaptureReceipts;
  assert.equal((await f.save(payload())).status, 'saved');
  assert.deepEqual(copy(f.state.notes[0]), note);
  assert.equal(f.state.ui.nativeQuickCaptureReceipts[id], note.quickCaptureFingerprint);
  f.state.ui.nativeQuickCaptureReceipts[id] = 'sha256:' + 'f'.repeat(64);
  const before = copy(f.state);
  assert.equal((await f.save(payload())).reason, 'collision'); assert.deepEqual(copy(f.state), before);
  f.state.ui.nativeQuickCaptureReceipts = ['malformed'];
  assert.equal((await f.save(payload())).reason, 'unavailable'); assert.deepEqual(f.state.ui.nativeQuickCaptureReceipts, ['malformed']);
});
