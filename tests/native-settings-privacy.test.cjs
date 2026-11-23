const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const swift = f => fs.readFileSync(path.join(root, 'native/Sources/AIBro', f), 'utf8');
const registry = swift('NativeSettingsRegistry.swift');
const bindings = fs.readdirSync(path.join(root, 'native/Sources/AIBro')).filter(f => /^NativeSettings.*Binding\.swift$/.test(f));
const more = fs.readFileSync(path.join(root, 'app/settings-pages-more.js'), 'utf8');

test('permission binding only reads status and never prompts', () => {
  const src = swift('NativeSettingsPermissionBinding.swift');
  assert.doesNotMatch(src, /requestAccess|requestAuthorization|AXIsProcessTrustedWithOptions|CGRequestListenEventAccess|SFSpeechRecognizer/);
  for (const api of ['AXIsProcessTrusted()', 'CGPreflightListenEventAccess()', 'authorizationStatus(for:', 'getNotificationSettings'])
    assert.ok(src.includes(api), api);
});

test('perm.* status items are read-only and perm.open.* is an action family', () => {
  for (const id of ['accessibility', 'inputMonitoring', 'microphone', 'camera', 'notifications', 'loginItem']) {
    const m = registry.match(new RegExp(`Item\\(id: "perm\\.${id}"[^\\n]*`));
    assert.ok(m, id);
    assert.match(m[0], /writable: false/, id);
  }
  assert.match(registry, /\("perm\.open\.", \.action\)/);
});

test('no credential-like id is in the native whitelist or any binding', () => {
  const ids = [...registry.matchAll(/"([a-zA-Z][\w.]*)"/g)].map(m => m[1]);
  for (const id of ids) assert.doesNotMatch(id, /key|token|secret|credential|password/i, id);
  for (const f of bindings) assert.doesNotMatch(swift(f), /apiKey|token|password|secret|credential/i, f);
});

test('page script only uses ids the registry knows and no credentials', () => {
  assert.doesNotMatch(more, /apiKey|\btoken\b|secret|password/i);
  for (const m of more.matchAll(/'(perm\.[a-zA-Z]+)'/g)) assert.ok(registry.includes(`"${m[1]}"`), m[1]);
});

test('automation permissions persist immediately and do not depend on the classic save button', () => {
  const app = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
  const hook = app.match(/window\.AIBroSettingsAccess = [\s\S]*?\n\}\);/)[0];
  assert.equal((hook.match(/await saveDocumentDurably\(\)/g) || []).length, 3);
  assert.doesNotMatch(more, /saveSettings/);
});

test('notifications page ids exist in the registry and only the explicit write can prompt', () => {
  for (const m of more.matchAll(/'((?:agenda|notify)\.[a-zA-Z.]+)'/g)) {
    const id = m[1];
    assert.ok(registry.includes(`"${id}"`) || registry.includes(`"${id.replace(/[^.]+$/, '')}"`), id);
  }
  const src = swift('NativeSettingsNotificationBinding.swift');
  assert.equal((src.match(/requestNotifications\(\)/g) || []).length, 1);
  assert.doesNotMatch(src, /requestAuthorization|requestAccess/);
  // The hook command goes to the pasteboard natively and is never part of the page-visible state.
  assert.doesNotMatch(src, /hookCommand[^\n]*(values|meta)\[/);
  assert.doesNotMatch(more, /hookCommand/);
});

test('models, sync and voice pages mount the connections module and give nodes back on leave', () => {
  const pages = fs.readFileSync(path.join(root, 'app/settings-pages.js'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'app/settings-shell.js'), 'utf8');
  assert.match(more, /mountConnections/); assert.match(more, /releaseConnections/);
  assert.match(more, /mountCloudSync/); assert.match(more, /releaseCloudSync/);
  assert.match(more, /mountRoles\?\.\(embHost, 'embedding'\)/);
  assert.match(pages, /mountRoles\(schemeHost, 'transcription'\)/);
  assert.doesNotMatch(pages, /toClassic/);
  assert.equal((more.match(/ui\.onLeave\(/g) || []).length >= 3, true);
  assert.match(shell, /runLeave\(\);\s*selected = id/);
});

test('usage price saves immediately through the access hook and stays out of the native bridge', () => {
  assert.match(more, /setUsagePrice\(\{ currency: cur\.value, input: inp\.value, output: out\.value \}\)/);
  assert.match(more, /addEventListener\('change', save\)/);
  assert.doesNotMatch(more, /nativeSettings[^\n]*usage/i);
});

test('the shell hides the save bar and the done bar, and the embedding tab moves out of models', () => {
  const css = fs.readFileSync(path.join(root, 'app/settings-shell.css'), 'utf8');
  assert.doesNotMatch(css, /st-active/);
  const ui = fs.readFileSync(path.join(root, 'app/providers-ui.js'), 'utf8');
  assert.match(ui, /hiddenTabs/);
  assert.match(ui, /if \(!hiddenTabs\.length\) ctx\.park/);
});
