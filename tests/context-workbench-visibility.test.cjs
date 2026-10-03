const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FileContext = require('../app/file-context.js');
const Evidence = require('../app/citation-evidence.js');
const source = fs.readFileSync(path.join(__dirname, '../app/context-workbench.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ open = false, selected = false, libraryRef, shell = true } = {}) {
  const state = {
    ui: { inspectorOpen: open, inspector: 'context' },
    projects: [], imports: [], tasks: [], papers: [],
    notes: [{ id: 'note', title: 'Current source', content: 'Original passage '.repeat(6000) }],
    conversations: [{ id: 'conversation', draft: 'Unsent question', draftAttachmentIds: [], messages: [{ id: 'answer', role: 'assistant', runId: 'run', text: 'Saved answer' }] }],
    agentRuns: [{ id: 'run', conversationId: 'conversation', status: 'completed', startedAt: 1 }]
  };
  const conversation = state.conversations[0], note = state.notes[0];
  Evidence.capture(state.agentRuns[0], { type: 'note', id: 'note', title: 'Frozen source', excerpt: 'Original passage' }, state);
  if (selected) conversation.draftFileReferences = [await FileContext.libraryRef(state, 'note', 'note')];
  const counts = { sourceModels: 0, statuses: 0, bodyReads: 0, hashes: 0, models: 0, skills: 0, mounts: 0, updates: 0, unmounts: 0 };
  let content = note.content, privateMode = false, chosenModel = 'before-model';
  Object.defineProperty(note, 'content', { enumerable: true, configurable: true, get() { counts.bodyReads++; return content; }, set(value) { content = value; } });
  const elements = new Map([['contextWorkbench', { scrollTop: 0 }], ['composerContextWorkbench', {}]]);
  if (shell) elements.set('conversationInspector', {});
  const roots = [];
  const document = { documentElement: { lang: 'en' }, body: { dataset: { view: 'agent' } }, getElementById: id => elements.get(id) };
  const sandbox = { document, FileContext: { ...FileContext, libraryRef: (...args) => { counts.hashes++; return libraryRef ? libraryRef(...args) : FileContext.libraryRef(...args); } }, CitationEvidence: {
    ...Evidence, sourcesFor: (...args) => { counts.sourceModels++; return Evidence.sourcesFor(...args); }, status: (...args) => { counts.statuses++; return Evidence.status(...args); }
  }, HalaskaUI: { componentNames: ['ContextWorkbenchSurface'], mount(host, component, props) {
    counts.mounts++;
    const handle = { host, component, props, mounted: true, updates: 0, unmounts: 0,
      update(next) { assert.equal(this.mounted, true, 'cannot update a disposed root'); this.props = next; this.updates++; counts.updates++; },
      unmount() { assert.equal(this.mounted, true, 'a root is disposed once'); this.mounted = false; this.props = null; this.unmounts++; counts.unmounts++; }
    };
    roots.push(handle); return handle;
  } } };
  vm.runInNewContext(source, sandbox, { filename: 'context-workbench.js' });
  const Context = sandbox.ContextWorkbench;
  const hooks = { getState: () => state, getConversation: () => conversation,
    getModel: () => { counts.models++; return { model: chosenModel }; },
    getSkills: () => { counts.skills++; return []; }, isPrivate: () => privateMode,
    onOpen: () => { state.ui.inspectorOpen = true; state.ui.inspector = 'context'; }
  };
  return { state, conversation, note, counts, document, roots, Context, hooks,
    setPrivate(value) { privateMode = value; }, setModel(value) { chosenModel = value; },
    entry: () => roots.findLast(item => item.component === 'Button' && item.mounted),
    panel: () => roots.findLast(item => item.component === 'ContextWorkbenchSurface' && item.mounted),
    resetCounts() { Object.keys(counts).forEach(key => { counts[key] = 0; }); }
  };
}

test('closed inspector skips actual source modeling, body hashing, version work and React updates', async () => {
  const f = await fixture({ selected: true });
  const before = JSON.stringify(f.state);
  f.resetCounts();
  assert.equal(f.Context.init(f.hooks), true);
  assert.equal(f.entry().props['aria-expanded'], false);
  assert.equal(f.panel(), undefined);
  assert.equal(f.counts.mounts, 1, 'only the cheap entry is mounted');
  f.resetCounts();
  for (let i = 0; i < 5; i++) f.Context.refresh();
  await tick();
  assert.deepEqual(f.counts, { sourceModels: 0, statuses: 0, bodyReads: 0, hashes: 0, models: 0, skills: 0, mounts: 0, updates: 0, unmounts: 0 });
  assert.equal(JSON.stringify(f.state), before, 'rendering does not change draft, selections, saved sources or route');
});

test('closed entry stays usable and reflects language and disclosure changes without reading sources', async () => {
  const f = await fixture(); f.Context.init(f.hooks); f.resetCounts();
  f.document.documentElement.lang = 'zh'; f.Context.refresh();
  assert.equal(f.entry().props.children, '上下文');
  assert.equal(f.counts.updates, 1);
  f.note.content = 'Changed while hidden'; f.setModel('latest-model');
  f.entry().props.onClick();
  assert.equal(f.entry().props['aria-expanded'], true);
  assert.equal(f.panel().props.data.model.model, 'latest-model');
  assert.equal(f.panel().props.data.recent.sources[0].status.kind, 'changed');
  assert.equal(f.panel().props.data.recent.sources[0].excerpt, 'Original passage');
});

test('reopening recomputes source and owner privacy before publishing any data', async () => {
  const f = await fixture({ open: true }); f.Context.init(f.hooks);
  const oldPanel = f.panel(); assert.equal(oldPanel.props.data.recent.sources[0].title, 'Frozen source');
  f.state.ui.inspectorOpen = false; f.Context.refresh();
  assert.equal(oldPanel.mounted, false); assert.equal(oldPanel.props, null);
  f.note.private = true; f.note.title = 'PRIVATE_CURRENT_TITLE';
  f.resetCounts(); for (let i = 0; i < 5; i++) f.Context.refresh();
  assert.equal(f.counts.sourceModels, 0); assert.equal(f.counts.bodyReads, 0); assert.equal(f.counts.updates, 0);
  f.Context.open();
  assert.equal(f.panel().props.data.recent.sources[0].private, true);
  assert.doesNotMatch(JSON.stringify(f.panel().props.data), /Frozen source|PRIVATE_CURRENT_TITLE|Original passage/);
  assert.equal(f.counts.bodyReads, 0, 'private bodies are not hashed on reopen');
  f.state.ui.inspectorOpen = false; f.Context.refresh(); f.setPrivate(true); f.resetCounts();
  f.Context.open();
  assert.equal(f.panel().props.data.private, true);
  assert.equal(f.panel().props.data.recent, null);
  assert.equal(f.counts.sourceModels, 0);
  assert.equal(f.counts.bodyReads, 0);
});

test('other inspector tabs and non-conversation routes defer the panel, then restore from current data', async () => {
  const f = await fixture({ open: true });
  f.state.ui.inspector = 'results'; f.Context.init(f.hooks);
  assert.equal(f.panel(), undefined); assert.equal(f.counts.sourceModels, 0);
  f.state.ui.inspector = 'context'; f.document.body.dataset.view = 'settings'; f.Context.refresh();
  assert.equal(f.panel(), undefined); assert.equal(f.counts.sourceModels, 0);
  f.document.body.dataset.view = 'agent'; f.Context.refresh();
  assert.equal(f.panel().props.data.conversationId, 'conversation');
});

test('visible refreshes keep the mounted root and host scroll instead of resetting controls', async () => {
  const f = await fixture({ open: true }); f.Context.init(f.hooks);
  const panel = f.panel(); panel.host.scrollTop = 417;
  f.note.content = 'Updated source'; f.Context.refresh(); f.Context.refresh();
  assert.equal(f.panel(), panel); assert.equal(panel.unmounts, 0);
  assert.equal(panel.host.scrollTop, 417);
  assert.equal(panel.props.data.recent.sources[0].status.kind, 'changed');
  assert.equal(f.entry().updates, 0, 'unchanged entry does not rerender with the panel');
});

test('closing before the microtask starts cancels queued version hashing', async () => {
  const f = await fixture({ open: true, selected: true }); f.Context.init(f.hooks);
  f.state.ui.inspectorOpen = false; f.Context.refresh(); f.resetCounts(); await tick();
  assert.equal(f.counts.hashes, 0); assert.equal(f.counts.bodyReads, 0);
  assert.equal(f.counts.updates, 0); assert.equal(f.panel(), undefined);
});

test('a hash settling after close cannot read sources or repaint, even before a host refresh', async () => {
  let resolve;
  const f = await fixture({ open: true, selected: true, libraryRef: () => new Promise(done => { resolve = done; }) });
  f.Context.init(f.hooks); await tick(); assert.equal(f.counts.hashes, 1);
  const oldPanel = f.panel(); f.state.ui.inspectorOpen = false;
  f.resetCounts(); resolve({ version: f.conversation.draftFileReferences[0].version }); await tick();
  assert.equal(f.panel(), undefined); assert.equal(oldPanel.unmounts, 1);
  assert.equal(f.counts.sourceModels, 0); assert.equal(f.counts.bodyReads, 0); assert.equal(oldPanel.updates, 0);
  assert.equal(f.entry().props['aria-expanded'], false);
});

test('reopen invalidates an older in-flight version and checks the new content', async () => {
  const requests = [];
  const f = await fixture({ open: true, selected: true, libraryRef: () => new Promise(done => { requests.push(done); }) });
  f.Context.init(f.hooks); await tick();
  f.state.ui.inspectorOpen = false; f.Context.refresh(); f.note.content = 'New content while hidden';
  f.Context.open(); await tick(); assert.equal(requests.length, 2);
  assert.equal(f.panel().props.data.materials[0].state, 'checking');
  const panel = f.panel(), updates = panel.updates;
  requests[0]({ version: f.conversation.draftFileReferences[0].version }); await tick();
  assert.equal(panel.updates, updates); assert.equal(panel.props.data.materials[0].state, 'checking');
  requests[1]({ version: 'new-version' }); await tick();
  assert.equal(panel.props.data.materials[0].state, 'changed');
});

test('suspending version work does not unlock a durable selection save or lose its failure', async () => {
  const f = await fixture({ selected: true }); let visible = true, finish, writes = 0;
  const controller = f.Context.createController({ ...f.hooks, isVisible: () => visible,
    mutate: () => { writes++; return new Promise(done => { finish = done; }); } });
  controller.refresh();
  const command = { conversationId: 'conversation', action: 'remove-reference', ref: f.conversation.draftFileReferences[0] };
  const save = controller.mutate(command); visible = false; controller.refresh(); await tick();
  assert.equal(controller.isBusy(), true); assert.equal(controller.getView().recent, undefined);
  visible = true; controller.refresh();
  assert.equal(await controller.mutate(command), false); assert.equal(writes, 1);
  visible = false; controller.refresh(); finish(false); assert.equal(await save, false);
  visible = true; controller.refresh();
  assert.equal(controller.isBusy(), false); assert.match(controller.getView().error, /not saved/);
  assert.equal(f.conversation.draft, 'Unsent question');
  controller.destroy();
});

test('standalone Kit surfaces remain visible and reinitialization never reuses disposed handles', async () => {
  const f = await fixture({ shell: false }); f.Context.init(f.hooks);
  assert.ok(f.panel()); const old = f.panel();
  f.Context.init(f.hooks); assert.equal(old.unmounts, 1); assert.notEqual(f.panel(), old);
  f.Context.refresh(); assert.equal(f.panel().mounted, true);
});
