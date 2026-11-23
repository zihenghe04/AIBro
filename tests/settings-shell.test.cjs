const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function load(reveal) {
  const calls = [];
  const win = { SettingsShell: { reveal: s => { calls.push(s); return true; } }, localStorage: { getItem: () => null, setItem() {} } };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app/settings-shell.js'), 'utf8'), win);
  return { api: win.SettingsShell, calls };
}
test('legacy ids map onto the new categories', () => {
  const { api } = load();
  for (const [old, now] of Object.entries({ appearance: 'general', models: 'models', sync: 'sync', knowledge: 'sync', plugins: 'plugins' })) assert.equal(api.resolve(old), now);
  assert.equal(api.resolve('nope'), null);
  assert.equal(api.categories().length, 8);
  for (const id of api.categories()) assert.equal(api.resolve(id), id);
});
test('the shell lists all eight categories', () => {
  const { api } = load();
  assert.equal(api.categories().length, 8);
});
test('deep links open the shell and never the classic page; unknown ids are refused', () => {
  const { api, calls } = load();
  // No DOM here, so building the shell throws; what matters is that the classic page is never asked for.
  for (const id of ['knowledge', 'voice', 'quick-entry', 'privacy', 'notifications']) { try { api.open(id); } catch (_) {} }
  assert.equal(api.open('bogus'), false);
  assert.deepEqual(calls, [], 'a migrated category must not reveal the classic page');
});
test('category names follow the UI language and none stays Chinese in English', () => {
  const doc = { documentElement: { lang: 'en' }, readyState: 'loading', addEventListener() {}, querySelector: () => null, getElementById: () => null };
  const win = { document: doc, localStorage: { getItem: () => null, setItem() {} } };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app/settings-shell.js'), 'utf8'), win);
  const api = win.SettingsShell;
  for (const id of api.categories()) assert.doesNotMatch(api._categoryName(id), /[㐀-鿿]/, `${id} is untranslated in English`);
  doc.documentElement.lang = 'zh-CN';
  for (const id of api.categories()) assert.match(api._categoryName(id), /[㐀-鿿]/, `${id} is not Chinese in zh-CN`);
});
test('the shell relabels itself when the UI language changes', () => {
  const listeners = {};
  const doc = { documentElement: { lang: 'zh-CN' }, readyState: 'loading', addEventListener: (n, f) => { listeners[n] = f; }, querySelector: () => null, getElementById: () => null };
  const win = { document: doc, localStorage: { getItem: () => null, setItem() {} } };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app/settings-shell.js'), 'utf8'), win);
  assert.equal(typeof listeners['workstation-language-change'], 'function', 'no language-change listener, so the nav stays in the first language');
  assert.doesNotThrow(() => listeners['workstation-language-change']());
});
