const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const read = file => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
test('native settings branch stays behind trusted origin and current webview, validates every shape, and reads one coordinator', () => {
  const native = read('native/Sources/AIBro/NativeDesktop.swift'), wiring = read('native/Sources/AIBro/AIBro.swift');
  const branch = native.slice(native.indexOf('if command == "quick-entry-settings"'), native.indexOf('if ["agenda-query"'));
  assert.ok(native.indexOf('message.frameInfo.isMainFrame') < native.indexOf('if command == "quick-entry-settings"'));
  assert.match(native, /url\.scheme=="http",url\.host==origin\.host,url\.port==origin\.port/);
  assert.match(branch, /message\.webView === workspace\.web/); assert.match(branch, /workspace\.ready && workspace\.selection == "settings"/);
  assert.match(branch, /CFGetTypeID\(value\) == CFBooleanGetTypeID\(\)/); assert.match(branch, /\["island","edge","menuBar"\]\.contains\(mode\)/);
  assert.equal((branch.match(/Set\(body\.keys\) == Set\(/g) || []).length, 4);
  assert.match(branch, /default: replyHandler\(\["status":"error","reason":"invalid_request"\]/);
  const source = wiring.slice(wiring.indexOf('model.desktop?.quickEntrySettings ='), wiring.indexOf('model.desktop?.nativeSettings ='));
  for (const value of ['self.model === model', 'self.quickEntry.setEnabled(enabled)', 'self.quickEntry.mode.rawValue', 'self.quickEntry.isEnabled', 'self.quickEntry.preferredEnabledMode.rawValue']) assert.ok(source.includes(value), value);
  assert.doesNotMatch(source, /preferences|localStorage|evaluateJavaScript/);
});
