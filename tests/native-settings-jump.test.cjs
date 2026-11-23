// Island -> main-window settings jumps (batch 7). Source-wiring checks plus a compiled check of the Swift whitelist.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('native/Sources/AIBro/AIBro.swift'), entry = read('native/Sources/AIBro/NativeQuickEntry.swift'), desktop = read('native/Sources/AIBro/NativeDesktop.swift');
const jsIds = () => [...read('app/settings-shell.js').matchAll(/^\s*\['([a-z-]+)', '[a-z]+', '/gm)].map(m => m[1]);
const swiftIds = () => [...entry.match(/static let ids = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);

test('the Swift whitelist equals the shell categories', () => {
  assert.equal(jsIds().length, 8);
  assert.deepEqual(swiftIds(), jsIds());
});
test('the Swift whitelist accepts category ids and refuses everything else (compiled)', t => {
  const enumSrc = entry.match(/enum NativeSettingsCategory \{[\s\S]*?\n\}/)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-cat-'));
  const src = path.join(dir, 'main.swift'), bin = path.join(dir, 'cat');
  fs.writeFileSync(src, `${enumSrc}
for id in ${JSON.stringify(swiftIds())} { precondition(NativeSettingsCategory.resolve(id) == id) }
for bad in ["", "appearance", "General", "general ", "../x", "javascript:1", "models'); alert(1)//"] { precondition(NativeSettingsCategory.resolve(bad) == nil, bad) }
precondition(NativeSettingsCategory.resolve(nil) == nil)
print("ok")
`);
  const c = cp.spawnSync('swiftc', ['-o', bin, src], { encoding: 'utf8' });
  if (c.status !== 0) return t.skip('swiftc unavailable: ' + c.stderr.slice(0, 200));
  const r = cp.spawnSync(bin, [], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('the island settings sections are no longer registered', () => {
  assert.doesNotMatch(app, /registerSettingsSection\(/);
});
test('gear and menu entries jump to the main window with a category id only', () => {
  assert.match(entry, /coordinator\.openSettings\(category: "quick-entry"\)/);
  assert.doesNotMatch(entry, /coordinator\.select\(\.settings\)/);
  assert.match(entry, /coordinator\.openSettings\(category: "general"\)/);
  assert.match(app, /Island settings…"\)\)\{delegate\.quickEntry\.openSettings\(category:"quick-entry"\)\}/);
});
test('the coordinator validates the id, dismisses via perform and hands it over once', () => {
  assert.match(entry, /pendingSettingsCategory = NativeSettingsCategory\.resolve\(category\)\s*\n\s*perform\(\.settings\)/);
  assert.match(entry, /func takeSettingsCategory\(\) -> String\? \{ defer \{ pendingSettingsCategory = nil \}/);
});
test('the quick action restores the window, keeps its guards and passes the category through', () => {
  const body = app.slice(app.indexOf('private func performQuickAction'), app.indexOf('func applicationShouldHandleReopen'));
  assert.match(body, /takeSettingsCategory\(\)/);
  assert.ok(body.indexOf('takeSettingsCategory') < body.indexOf('guard model.ready'), 'category must be consumed before the guards can return');
  assert.match(body, /restoreWorkspaceWindow\(\)/);
  assert.match(body, /guard model\.ready,draftQuit\.phase == \.idle,window\?\.attachedSheet == nil/);
  assert.match(body, /case \.settings: model\.openWorkspaceSettings\(category:settingsCategory\)/);
});
test('openWorkspaceSettings raises the window, re-validates the id and passes it as a JS argument', () => {
  const body = app.slice(app.indexOf('func openWorkspaceSettings'), app.indexOf('private func cancelSettingsNavigation'));
  assert.match(body, /NativeSettingsCategory\.resolve/);
  assert.match(body, /deminiaturize/); assert.match(body, /makeKeyAndOrderFront/);
  assert.match(body, /"category":category \?\? ""/);
  assert.doesNotMatch(body, /\\\(category/, 'category must never be interpolated into the script');
});
test('a closed or parked main window is restored before the jump', () => {
  const fn = app.slice(app.indexOf('func restoreWorkspaceWindow'), app.indexOf('func restoreWorkspaceWindow') + 1500);
  assert.match(fn, /deminiaturize|makeKeyAndOrderFront|orderFront/);
});
test('the voice entries jump to the voice category without a DOM event', () => {
  const fn = app.slice(app.indexOf('func openMainSpeechSettings'), app.indexOf('private func configureSpeechEntry'));
  assert.match(fn, /openWorkspaceSettings\(category:"voice"\)/);
  assert.doesNotMatch(fn, /aibro-open-models-tab/);
  assert.match(app, /recordings\.openSettingsPage=\{[^\n]*openMainSpeechSettings/);
  assert.match(app, /model\.desktop\?\.openSpeechSettings=openMainSettings/);
});
test('the web bridge keeps its trusted-origin guard in front of every handler', () => {
  const guard = desktop.indexOf('isMainFrame');
  assert.ok(guard > 0 && guard < desktop.indexOf('quick-entry-settings'));
  assert.match(desktop, /scheme == "http"|\.scheme/);
});
test('the home widget gear opens the quick-entry page of the one settings shell', () => {
  const home = read('native/Sources/AIBro/NativeQuickHomeView.swift');
  assert.doesNotMatch(home, /NativeQuickPanelSettingsView/);
  assert.match(home, /openSettings\(category: "quick-entry"\)/);
});
