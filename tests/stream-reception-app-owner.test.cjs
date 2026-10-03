const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Reception = require('../app/stream-reception.js');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const ownerStart = source.indexOf('  const ownsRun = () => state.agentRuns.find');
const ownerEnd = source.indexOf('\n', ownerStart);
const boundaryStart = source.indexOf("  Object.defineProperty(run, 'streamReception',");
const boundaryEnd = source.indexOf('  const stage =', boundaryStart);
assert.ok(ownerStart > 0 && ownerEnd > ownerStart && boundaryStart > ownerEnd && boundaryEnd > boundaryStart);
const actualOwner = source.slice(ownerStart, ownerEnd);
const actualReceiver = source.slice(boundaryStart, boundaryEnd);
function fixture() {
  const run = { id: 'synthetic-run', status: 'running' };
  const liveMessage = { id: 'synthetic-message', live: true, text: 'Unchanged synthetic answer' };
  const conversation = { id: 'synthetic-conversation', messages: [liveMessage] };
  const state = { agentRuns: [run], conversations: [conversation] }, refreshes = [];
  const context = { run, liveMessage, conversation, state, StreamReception: Reception, refreshLive: value => refreshes.push(value) };
  context.window = context; vm.createContext(context);
  vm.runInContext(`${actualOwner}\n${actualReceiver}\nglobalThis.receive = onReception;`, context);
  const emitter = Reception.createEmitter(context.receive);
  return { ...context, context, emitter, refreshes };
}
test('actual app ownership rejects callbacks after same-ID run, conversation or message is replaced', () => {
  for (const replace of [
    f => { f.state.agentRuns[0] = { ...f.run }; },
    f => { f.state.conversations[0] = { ...f.conversation }; },
    f => { f.conversation.messages[0] = { ...f.liveMessage }; },
  ]) {
    const f = fixture(); f.emitter.start();
    const receipt = f.run.streamReception;
    replace(f); f.emitter.content('output'); f.emitter.finish('completed');
    assert.equal(f.run.streamReception, receipt); assert.deepEqual(f.refreshes, [false]);
    assert.equal(f.liveMessage.text, 'Unchanged synthetic answer');
  }
});
test('actual app live/status gate rejects late callbacks in every terminal and approval/save state', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'awaiting-approval', 'awaiting-save']) {
    const f = fixture(); f.emitter.start(); const receipt = f.run.streamReception;
    f.run.status = status; f.emitter.content('summary');
    assert.equal(f.run.streamReception, receipt); assert.deepEqual(f.refreshes, [false]);
  }
  const f = fixture(); f.emitter.start(); const receipt = f.run.streamReception;
  f.liveMessage.live = false; f.emitter.content('output');
  assert.equal(f.run.streamReception, receipt); assert.deepEqual(f.refreshes, [false]);
});
test('actual transient property never serializes into workspace/sync/model copies', () => {
  const f = fixture(); f.emitter.start(); f.emitter.content('output');
  assert.ok(f.run.streamReception); assert.equal(Object.getOwnPropertyDescriptor(f.run, 'streamReception').enumerable, false);
  assert.equal(JSON.stringify(f.state).includes('streamReception'), false);
  assert.equal(Object.hasOwn(structuredClone(f.run), 'streamReception'), false);
  assert.equal(Object.hasOwn({ ...f.run }, 'streamReception'), false);
  assert.deepEqual(f.refreshes, [false, false]);
});
