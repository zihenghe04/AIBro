import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Store, MemoryAdapter } from '../src/store.js';
import { saveModelSettings, useModelProfile } from '../src/model-credentials.js';
import { createApiProfileEditor } from '../src/api-profile-editor.js';

// Exercise the production UI lifecycle without a renderer or native process.
// Only the DOM/Kit boundary is substituted; editor, Store and credential saves
// are the production implementations and all credentials are synthetic.
const source = (await readFile(new URL('../src/ui/api-profile-settings.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export async function mountApiProfileSettings', 'async function mountApiProfileSettings');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness() {
  const kit = { register() {}, mount(root, name, props) {
    root.props = props; root.paints = 0;
    return { update(next) { root.props = { ...root.props, ...next }; root.paints++; }, unmount() { root.unmounted = true; } };
  } };
  const context = vm.createContext({ loadMobileHalaska: async () => kit,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout, clearTimeout, FormData: class { constructor(form) { this.entries = form.elements.filter(e => e.name && !e.disabled).map(e => [e.name, e.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } } });
  vm.runInContext(source + '\nglobalThis.mount = mountApiProfileSettings;', context);
  return async editor => {
    const root = { isConnected: true }, listeners = new Map();
    const elements = ['profileId', 'profileName', 'base', 'model', 'format', 'key', 'submit'].map(name => ({ name: name === 'submit' ? '' : name, value: '', disabled: false }));
    const fieldset = { name: '', disabled: true }, loading = { removed: false, remove() { this.removed = true; } }; elements.unshift(fieldset);
    elements.namedItem = name => elements.find(e => e.name === name);
    const form = { elements, isConnected: true,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
      fire: name => listeners.get(name)?.({ preventDefault() {}, stopPropagation() {} }),
      field: name => elements.namedItem(name),
      querySelector: selector => selector === '[data-api-profile-fields]' ? fieldset : selector === '[data-api-profile-loading]' ? loading : null,
    };
    const errors = [], saved = [];
    const ui = await context.mount(root, form, editor, { purpose: 'chat', onSaved: () => saved.push(true), onError: error => errors.push(error) });
    return { root, form, ui, errors, saved, fieldset, loading };
  };
}
async function fixture({ gate, operation = 'save', failure = false } = {}) {
  const store = await new Store(new MemoryAdapter()).load(), secrets = new Map(); let tests = 0;
  const vault = { get: async k => secrets.get(k) || null, set: async (k, value) => secrets.set(k, value) };
  await saveModelSettings(store, vault, { base: 'https://synthetic.example.test/v1', model: 'model-a', key: 'synthetic-a', format: 'chat', profileName: '方案甲', profileId: '' });
  const a = store.state.settings.apiProfileSelection.chat;
  await saveModelSettings(store, vault, { base: 'https://synthetic.example.test/v1', model: 'model-b', key: 'synthetic-b', format: 'chat', profileName: '方案乙', profileId: '' });
  const b = store.state.settings.apiProfileSelection.chat;
  const editor = createApiProfileEditor({ store, purpose: 'chat',
    save: async values => { if (operation === 'save') await gate?.promise; if (failure) throw Error('synthetic write failed'); return saveModelSettings(store, vault, values); },
    use: id => useModelProfile(store, vault, id),
    test: async () => { tests++; await gate?.promise; return { message: '合成连接检查完成' }; },
  });
  return { store, vault, editor, a, b, mount: harness(), tests: () => tests };
}

test('remount during save inherits busy, then receives the committed ID, cleared key and completion once', async () => {
  const gate = deferred(), f = await fixture({ gate });
  await f.editor.select('');
  const first = await f.mount(f.editor);
  for (const [name, value] of Object.entries({ profileName: '方案丙', base: 'https://synthetic.example.test/v1', model: 'model-c', key: 'synthetic-c', format: 'chat' })) first.form.field(name).value = value;
  first.form.fire('input'); const saving = first.form.fire('submit');
  first.ui.unmount(); first.root.isConnected = first.form.isConnected = false;
  const next = await f.mount(f.editor), oldPaints = first.root.paints;
  assert.equal(next.fieldset.disabled, true); assert.equal(next.loading.removed, true);
  assert.equal(next.root.props.state.operation, 'save');
  assert.equal(next.form.field('model').disabled, true, 'reopened form must lock while the singleton editor is saving');
  gate.resolve(); await saving;
  assert.equal(f.editor.snapshot().busy, false); assert.equal(next.root.props.state.busy, false); assert.equal(next.root.props.state.operation, null);
  assert.equal(next.form.field('model').disabled, false);
  assert.equal(next.fieldset.disabled, false, 'the cold-load gate must not become a permanent disabled baseline');
  assert.equal(next.form.field('profileId').value, f.store.state.settings.apiProfileSelection.chat);
  assert.equal(next.form.field('key').value, ''); assert.match(next.root.props.message, /已保存/);
  assert.equal(first.root.paints, oldPaints); assert.equal(first.saved.length, 0); assert.equal(next.saved.length, 1);
  next.ui.unmount(); await f.store.tail;
});

test('remount during selection renders the destination before allowing edits, preventing A fields from overwriting B', async () => {
  const f = await fixture(); await f.editor.select(f.a);
  const gate = deferred(), tx = f.store.tx.bind(f.store); let delayed = false;
  f.store.tx = async fn => { if (!delayed) { delayed = true; await gate.promise; } return tx(fn); };
  const first = await f.mount(f.editor), selecting = first.root.props.select(f.b);
  first.ui.unmount(); first.root.isConnected = first.form.isConnected = false;
  const next = await f.mount(f.editor);
  assert.equal(next.root.props.state.operation, 'select');
  gate.resolve(); await selecting;
  assert.equal(next.form.field('model').value, 'model-b'); assert.equal(next.form.field('profileId').value, f.b);
  assert.equal(next.root.props.state.busy, false);
  next.form.field('profileName').value = '方案乙改名'; next.form.fire('input'); await next.form.fire('submit');
  assert.equal(f.store.state.settings.model.model, 'model-b');
  next.ui.unmount(); await f.store.tail;
});

test('remount during a test receives its actual result without resending or overwriting edited fields', async () => {
  const gate = deferred(), f = await fixture({ gate, operation: 'test' });
  const first = await f.mount(f.editor); first.form.field('model').value = 'draft-model'; first.form.fire('input');
  const testing = first.root.props.action('test'); first.ui.unmount();
  const next = await f.mount(f.editor); assert.equal(next.root.props.state.operation, 'test'); gate.resolve(); await testing;
  assert.equal(next.root.props.state.busy, false); assert.equal(next.form.field('model').value, 'draft-model');
  assert.equal(next.root.props.message, '合成连接检查完成'); assert.equal(next.saved.length, 1);
  assert.equal(f.tests(), 1, 'navigation must not resend the probe');
  assert.equal(f.store.state.settings.model.model, 'model-b'); next.ui.unmount(); await f.store.tail;
});

test('failed in-flight save after navigation unlocks the current form and preserves its draft', async () => {
  const gate = deferred(), f = await fixture({ gate, failure: true });
  const first = await f.mount(f.editor); first.form.field('model').value = 'draft-model'; first.form.field('key').value = 'synthetic-draft'; first.form.fire('input');
  const saving = first.form.fire('submit'); first.ui.unmount(); const next = await f.mount(f.editor);
  assert.equal(next.root.props.state.operation, 'save');
  gate.resolve(); await saving;
  assert.equal(next.root.props.state.busy, false); assert.equal(next.form.field('model').disabled, false);
  assert.equal(next.form.field('model').value, 'draft-model'); assert.equal(next.form.field('key').value, 'synthetic-draft');
  assert.match(next.root.props.message, /synthetic write failed/); assert.equal(next.saved.length, 0);
  assert.equal(f.store.state.settings.model.model, 'model-b'); next.ui.unmount(); await f.store.tail;
});
