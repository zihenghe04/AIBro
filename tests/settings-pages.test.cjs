const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const api = require('../app/settings-pages.js');

test('shortcutCode builds mods:keyCode and rejects bare modifiers', () => {
  assert.equal(api.shortcutCode({ code: 'KeyK', altKey: true }), '2048:40');
  assert.equal(api.shortcutCode({ code: 'Space', ctrlKey: true }), '4096:49');
  assert.equal(api.shortcutCode({ code: 'KeyA', metaKey: true, shiftKey: true }), '768:0');
  assert.equal(api.shortcutCode({ code: 'ShiftLeft', shiftKey: true }), null);
});
test('formatBytes and keysOf', () => {
  assert.equal(api.formatBytes(0), '0 B');
  assert.equal(api.formatBytes(1536), '1.5 KB');
  assert.equal(api.formatBytes(20 * 1024 * 1024), '20 MB');
  assert.deepEqual(api.keysOf('⌥Space'), ['⌥', 'Space']);
  assert.deepEqual(api.keysOf('⌃⇧K'), ['⌃', '⇧', 'K']);
});
test('pages are registered and every category is migrated (new shell is the default)', () => {
  assert.deepEqual(Object.keys(api.pages).sort(), ['general', 'quick-entry', 'voice'].sort());
  const shell = fs.readFileSync(path.join(root, 'app/settings-shell.js'), 'utf8');
  assert.doesNotMatch(shell, /MIGRATED|toClassic/);
});
test('page script is loaded by index.html and listed in the asset manifest', () => {
  assert.match(fs.readFileSync(path.join(root, 'app/index.html'), 'utf8'), /settings-pages\.js/);
  assert.match(fs.readFileSync(path.join(root, 'app/asset-manifest.json'), 'utf8'), /settings-pages\.js/);
});
test('pages never send credentials or unknown ids through the bridge', () => {
  const src = fs.readFileSync(path.join(root, 'app/settings-pages.js'), 'utf8');
  assert.doesNotMatch(src, /apiKey|token|secret|password/i);
  const reg = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeSettingsRegistry.swift'), 'utf8');
  const ids = [...src.matchAll(/'((?:login|quickEntry|quickPanel|clipboard|dictate|speech)\.[\w.]+)'/g)].map(m => m[1]);
  assert.ok(ids.length > 15);
  for (const id of new Set(ids)) {
    const family = /^quickPanel\.(section|home|size|move)\.$/.test(id);
    assert.ok(family || reg.includes(`"${id}"`), `${id} is not in the native whitelist`);
  }
});
