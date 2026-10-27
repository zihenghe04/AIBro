const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function fixture(active = true) {
  const calls = [];
  class Storage { setItem() {} removeItem() {} }
  const window = { navigator: { userActivation: { isActive: active } }, webkit: { messageHandlers: { desktop: { postMessage: async x => { calls.push(structuredClone(x)); return { status: 'ok' }; } } } } };
  vm.runInNewContext(fs.readFileSync('native/Resources/desktop.js', 'utf8'), { window, Storage, localStorage: new Storage() });
  return { api: window.workstationDesktop.speech, calls };
}

test('speech settings bridge sends only the exact commands, never a key field', async () => {
  const { api, calls } = fixture();
  await api.state(); await api.select('s1'); await api.setRealtime(true); await api.test('cloud'); await api.test('realtime');
  await api.open('cloud'); await api.open('cloud', 's2'); await api.open('cloud-new'); await api.open('realtime');
  assert.deepEqual(calls.map(call => Object.keys(call).sort().join(',')), [
    'action,command', 'action,command,id', 'action,command,enabled', 'action,command,target', 'action,command,target', 'action,command,target', 'action,command,id,target', 'action,command,target', 'action,command,target']);
  assert.ok(calls.every(call => call.command === 'speech-settings'));
  assert.ok(!JSON.stringify(calls).match(/token|key|secret/i));
});

test('speech settings bridge rejects malformed requests locally', async () => {
  const { api, calls } = fixture();
  for (const reply of [await api.select(''), await api.select(5), await api.setRealtime('yes'), await api.test('everything'), await api.open('../x'), await api.open('realtime', 's2'), await api.open('cloud', '')]) {
    assert.equal(reply.status, 'error'); assert.equal(reply.reason, 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

test('changes need a live user gesture; reading state does not', async () => {
  const { api, calls } = fixture(false);
  assert.equal((await api.select('s1')).reason, 'user_gesture_required');
  assert.equal((await api.setRealtime(false)).reason, 'user_gesture_required');
  assert.equal((await api.state()).status, 'ok');
  assert.equal(calls.length, 1);
});

test('native side whitelists the same actions and answers settings_not_visible outside Settings', () => {
  const swift = fs.readFileSync('native/Sources/AIBro/NativeDesktop.swift', 'utf8');
  const block = swift.slice(swift.indexOf('if command == "speech-settings"'), swift.indexOf('if ["agenda-query"'));
  for (const action of ['"state"', '"select"', '"realtime"', '"test"', '"open"', '"save-cloud"', '"test-cloud"', '"delete-cloud"', '"save-realtime"', '"test-realtime"', '"delete-realtime"', '"select-realtime"', '"silence"']) assert.ok(block.includes(`case ${action} where`), action);
  assert.ok(block.includes('["cloud","realtime"].contains(target)') && block.includes('["cloud","cloud-new","realtime"].contains(target)'));
  assert.ok(block.includes('workspace.selection == "settings"') && block.includes('settings_not_visible'));
  const app = fs.readFileSync('native/Sources/AIBro/AIBro.swift', 'utf8');
  const state = app.slice(app.indexOf('static func speechSettingsState'), app.indexOf('func invokeVoiceCommand'));
  assert.ok(!/token|apiKey|\.key\b/i.test(state), 'the public state carries no key material');
});

test('editing commands carry a draft whose Key is write-only; malformed drafts are refused locally', async () => {
  const { api, calls } = fixture();
  const cloud = { name: 'n', provider: 'selfHosted', baseURL: 'http://192.0.2.10:8000/v1', model: 'm', language: '', key: 'synthetic-key' };
  await api.saveCloud(cloud); await api.testCloud({ ...cloud, id: 's1' }); await api.deleteCloud('s1');
  await api.saveRealtime({ name: 'r', provider: 'selfHosted', language: '', enabled: true, reuseCloudID: 's1' }); await api.testRealtime({ name: 'r', provider: 'bailian', language: 'zh', enabled: true, key: 'k' });
  await api.deleteRealtime('r1'); await api.selectRealtime('r1'); await api.setSilence(1.5);
  assert.deepEqual(calls.map(call => call.action), ['save-cloud', 'test-cloud', 'delete-cloud', 'save-realtime', 'test-realtime', 'delete-realtime', 'select-realtime', 'silence']);
  assert.ok(calls.every(call => call.command === 'speech-settings'));
  assert.equal(calls[0].draft.key, 'synthetic-key');
  for (const reply of [await api.saveCloud(null), await api.saveCloud([]), await api.deleteCloud(''), await api.setSilence(-1), await api.setSilence(11), await api.setSilence('1'), await api.selectRealtime(5)]) assert.equal(reply.reason, 'invalid_request');
  assert.equal(calls.length, 8);
});

test('editing commands need a live user gesture', async () => {
  const { api, calls } = fixture(false);
  for (const reply of [await api.saveCloud({ name: 'n' }), await api.saveRealtime({ name: 'n' }), await api.deleteCloud('s1'), await api.setSilence(2)]) assert.equal(reply.reason, 'user_gesture_required');
  assert.equal(calls.length, 0);
});

test('native side validates every draft field and never returns a Key in state', () => {
  const swift = fs.readFileSync('native/Sources/AIBro/NativeDesktop.swift', 'utf8');
  const cloud = swift.slice(swift.indexOf('static func speechCloudInput'), swift.indexOf('static func speechRealtimeInput'));
  assert.ok(cloud.includes('isSubset(of:["id","name","provider","baseURL","model","language","timeoutSeconds","key"])'));
  assert.ok(cloud.includes('key.utf8.count<=16384'));
  const app = fs.readFileSync('native/Sources/AIBro/AIBro.swift', 'utf8');
  const state = app.slice(app.indexOf('static func speechSettingsState'), app.indexOf('func invokeVoiceCommand'));
  assert.ok(!/"key"|"token"|apiKey/i.test(state), 'state carries no key material, only keySaved');
  assert.ok(app.includes('schemeKey(cloudID)'), 'reusing the cloud Key happens inside native code');
});
