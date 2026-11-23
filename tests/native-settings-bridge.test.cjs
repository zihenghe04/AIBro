const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const plain = v => JSON.parse(JSON.stringify(v));
const read = file => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
function setup() {
  const calls = [];
  class Event { constructor(trusted) { Object.defineProperty(this, 'isTrusted', { value: trusted }); } }
  class Storage { constructor() { this.map = new Map(); } setItem(k, v) { this.map.set(k, String(v)); } getItem(k) { return this.map.get(k) || null; } removeItem(k) { this.map.delete(k); } }
  const window = { Event, __nativePreferences: {}, webkit: { messageHandlers: { desktop: { postMessage: async b => { calls.push(b); return { status: 'ok', values: {} }; } } } } };
  vm.runInNewContext(read('native/Resources/desktop.js'), { window, Storage, localStorage: new Storage() });
  const inside = { isConnected: true, closest: sel => sel === '#nativeSettingsRoot' ? {} : null };
  const outside = { isConnected: true, closest: () => null };
  const detached = { isConnected: false, closest: () => ({}) };
  const evt = (trusted, currentTarget) => Object.assign(new Event(trusted), { currentTarget });
  return { api: window.workstationDesktop.nativeSettings, calls, evt, inside, outside, detached };
}
test('state needs no gesture and sends only the state action', async () => {
  const x = setup(); await x.api.state();
  assert.deepEqual(JSON.parse(JSON.stringify(x.calls)), [{ command: 'native-settings', action: 'state' }]);
});
test('set is refused without a trusted event inside the settings root', async () => {
  const x = setup();
  for (const event of [undefined, null, {}, x.evt(false, x.inside), x.evt(true, x.outside), x.evt(true, x.detached), { isTrusted: true, currentTarget: x.inside }]) {
    assert.deepEqual(plain(await x.api.set('login.enabled', true, event)), { status: 'error', reason: 'user_gesture_required' });
  }
  assert.equal(x.calls.length, 0);
});
test('set rejects bad ids and value types locally', async () => {
  const x = setup(), good = x.evt(true, x.inside);
  for (const [id, value] of [['', true], [5, true], ['a'.repeat(81), true], ['login.enabled', null], ['login.enabled', {}], ['speech.silence', NaN], ['speech.silence', Infinity]]) {
    assert.equal((await x.api.set(id, value, good)).reason, 'invalid_request');
  }
  assert.equal(x.calls.length, 0);
});
test('a trusted event inside the root sends exactly the whitelisted shape', async () => {
  const x = setup(); await x.api.set('dictate.trigger', 'combo', x.evt(true, x.inside));
  assert.deepEqual(JSON.parse(JSON.stringify(x.calls)), [{ command: 'native-settings', action: 'set', id: 'dictate.trigger', value: 'combo' }]);
});
test('finite numbers are sent as numbers', async () => {
  const x = setup(); await x.api.set('speech.silence', 2.5, x.evt(true, x.inside));
  assert.deepEqual(plain(x.calls), [{ command: 'native-settings', action: 'set', id: 'speech.silence', value: 2.5 }]);
});
test('the API object is frozen', () => {
  const x = setup(); assert.equal(Object.isFrozen(x.api), true);
});
test('native handler checks sender, parse and settings visibility before dispatch', () => {
  const src = read('native/Sources/AIBro/NativeDesktop.swift'), at = src.indexOf('command == "native-settings"'), block = src.slice(at, at + 1200);
  assert.ok(at > 0);
  for (const needle of ['message.webView === workspace.web', 'NativeSettingsRegistry.parse(body)', 'NativeSettingsRegistry.visibility', 'workspace.ready', 'workspace.selection', 'unavailable']) assert.ok(block.includes(needle), needle);
  assert.ok(block.indexOf('visibility') < block.indexOf('nativeSettings?('));
});
