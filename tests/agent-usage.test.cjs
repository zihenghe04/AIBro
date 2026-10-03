const test = require('node:test');
const assert = require('node:assert/strict');
const Usage = require('../app/agent-usage');
const route = { provider: 'api', model: 'fixture-model' };
const sample = (n = 100) => ({ input: n, output: 10, total: n + 10 });
function fixture() { const run = {}, message = {}, recorder = Usage.create(run, message); return { run, message, recorder }; }
function complete(h, id, usage, scope = route) { h.recorder.attempt({ id, status: 'running' }, scope); if (usage) h.recorder.report(usage, { attemptId: id }, scope); h.recorder.attempt({ id, status: 'completed' }, scope); }

test('latest snapshots replace within one attempt and distinct attempts sum once after persistence', () => {
 const h = fixture(); h.recorder.attempt({ id: 'one', status: 'running' }, route);
 for (const n of [10, 100, 100, 90]) h.recorder.report(sample(n), { attemptId: 'one' });
 h.recorder.attempt({ id: 'one', status: 'completed' }); complete(h, 'two', sample(200));
 assert.equal(h.run.usage.total, 310); assert.equal(h.run.usage.input, 290); assert.equal(h.run.usage.output, 20);
 assert.equal(h.run.usageLedger.attempts.length, 2); assert.equal(h.run.usage.complete, true);
 assert.deepEqual(h.message.usage, h.run.usage); assert.equal(Object.hasOwn(h.message, 'usageLedger'), false);
 const saved = JSON.parse(JSON.stringify(h.run)); assert.deepEqual(Usage.project(saved.usageLedger), h.run.usage);
 assert.equal(Usage.create(h.run, h.message), h.recorder);
});

test('missing packets are unknown and cancellation retains real partial usage', () => {
 const h = fixture(); complete(h, 'known', sample()); complete(h, 'missing');
 h.recorder.attempt({ id: 'stopped', status: 'running' }, route); h.recorder.report(sample(20), { attemptId: 'stopped' });
 h.recorder.attempt({ id: 'stopped', status: 'cancelled' });
 assert.equal(h.run.usage.total, 140); assert.equal(h.run.usage.input, null); assert.equal(h.run.usage.reportedAttempts, 2);
 assert.equal(h.run.usage.attempts, 3); assert.equal(h.run.usage.complete, false); assert.equal(h.run.usage.interruptedAttempts, 1);
 const view = Usage.view(h.message, h.run); assert.equal(view.label, '已报告'); assert.match(view.hint, /2\/3/); assert.equal(view.canEstimate, false);
});

test('a later partial snapshot does not borrow components from an earlier packet', () => {
 const h = fixture(); h.recorder.attempt({ id: 'one', status: 'running' }, route); h.recorder.report(sample(), { attemptId: 'one' });
 h.recorder.report({ input: null, output: null, total: 120 }, { attemptId: 'one' }); h.recorder.attempt({ id: 'one', status: 'completed' });
 assert.deepEqual(h.run.usageLedger.attempts[0].usage, { input: null, output: null, total: 120 }); assert.equal(h.run.usage.input, null);
 assert.equal(Usage.view(h.message, h.run).canEstimate, false);
});

test('reported zero is distinct from absent usage and valid parts can remain partial', () => {
 const h = fixture(); complete(h, 'zero', { input: 0, output: 0, total: 0 });
 assert.equal(h.run.usage.total, 0); assert.equal(h.run.usage.complete, true); assert.equal(h.run.usage.reportedAttempts, 1);
 complete(h, 'parts', { input: 12, output: null, total: null }); assert.equal(h.run.usage.input, 12); assert.equal(h.run.usage.output, null);
 assert.equal(h.run.usage.total, 0); assert.equal(h.run.usage.reportedAttempts, 1); assert.equal(h.run.usage.complete, false);
});

test('unregistered, malformed, late and mismatched parent claims never enter the ledger', () => {
 const h = fixture(); assert.equal(h.recorder.report(sample(), { attemptId: 'model-invented' }), false);
 assert.equal(h.recorder.attempt({ id: 'x\nsecret', status: 'running' }, route), false);
 assert.equal(h.recorder.attempt({ id: 'x'.repeat(257), status: 'running' }, route), false);
 assert.equal(h.recorder.attempt({ id: 'one', status: 'running' }, { ...route, parentId: 'unknown-call' }), false);
 h.run.toolCalls = [{ id: 'not-delegate', type: 'read' }, { id: 'child', type: 'delegate' }];
 assert.equal(h.recorder.attempt({ id: 'one', status: 'running' }, { ...route, parentId: 'not-delegate' }), false);
 assert.equal(h.recorder.attempt({ id: 'one', status: 'running' }, { ...route, parentId: 'child' }), true);
 assert.equal(h.recorder.report(sample(), { attemptId: 'one' }), false);
 assert.equal(h.recorder.report(sample(), { attemptId: 'one' }, { parentId: 'other' }), false);
 assert.equal(h.recorder.report(sample(), { attemptId: 'one' }, { parentId: 'child' }), true);
 h.recorder.attempt({ id: 'one', status: 'completed' }, { parentId: 'child' });
 assert.equal(h.recorder.report(sample(999), { attemptId: 'one' }, { parentId: 'child' }), false);
 assert.equal(h.recorder.attempt({ id: 'one', status: 'running' }, route), false); assert.equal(h.run.usage.total, 110);
});

test('main, child, and history-compaction identities aggregate once with separate purpose', () => {
 const h = fixture(); h.run.toolCalls = [{ id: 'child', type: 'delegate' }];
 complete(h, 'main', sample()); complete(h, 'child-1', sample(20), { ...route, parentId: 'child' });
 complete(h, 'compact', sample(30), { ...route, purpose: 'history-compaction' });
 assert.equal(h.run.usage.total, 180); assert.deepEqual(h.run.usageLedger.attempts.map(a => [a.parentId, a.purpose]), [[null, 'model'], ['child', 'model'], [null, 'history-compaction']]);
 assert.equal(Usage.view(h.message, h.run).canEstimate, true);
});

test('finish prevents old callbacks and does not invent completed usage for dangling attempts', () => {
 const h = fixture(); h.recorder.attempt({ id: 'one', status: 'running' }, route); h.recorder.report(sample(), { attemptId: 'one' });
 h.recorder.finish('completed'); const before = JSON.stringify(h.run);
 assert.equal(h.run.usageLedger.attempts[0].status, 'interrupted'); assert.equal(h.run.usage.complete, false);
 assert.equal(h.recorder.report(sample(200), { attemptId: 'one' }), false); assert.equal(h.recorder.attempt({ id: 'two', status: 'running' }, route), false);
 assert.equal(h.recorder.finish('failed'), false); assert.equal(JSON.stringify(h.run), before);
});

test('rehydrated projection is read-only and cannot accept callbacks from its old runtime', () => {
 const h = fixture(); h.recorder.attempt({ id: 'one', status: 'running' }, route); h.recorder.report(sample(), { attemptId: 'one' });
 const run = JSON.parse(JSON.stringify(h.run)), before = JSON.stringify(run); Usage.view({}, run); assert.equal(JSON.stringify(run), before);
 const restored = Usage.create(run, {}); assert.equal(restored.report(sample(500), { attemptId: 'one' }), false);
});

test('legacy records preserve their value without inferring request count or unknown costs', () => {
 const message = { usage: sample() }, run = { usage: sample() }, before = JSON.stringify([message, run]);
 const view = Usage.view(message, run); assert.equal(view.label, ''); assert.equal(view.usage.total, 110); assert.match(view.hint, /历史记录仅保存最后一次请求/);
 assert.equal(view.canEstimate, false); assert.equal(JSON.stringify([message, run]), before); assert.throws(() => Usage.create(run, message), /Historical/);
});

test('mixed routes and incomplete fields cannot be priced as one exact model total', () => {
 const h = fixture(); complete(h, 'a', sample()); complete(h, 'b', sample(), { provider: 'other', model: 'another' });
 const view = Usage.view(h.message, h.run, { language: 'en' }); assert.equal(view.usage.total, 220); assert.equal(view.label, ''); assert.equal(view.canEstimate, false); assert.match(view.hint, /Multiple model/);
});

test('invalid counts, overflow and duplicate saved attempt IDs do not produce trustworthy totals', () => {
 const h = fixture(); h.recorder.attempt({ id: 'one', status: 'running' }, route);
 for (const bad of [-1, NaN, Infinity, 1.5, '100', false, Number.MAX_SAFE_INTEGER + 1]) assert.equal(h.recorder.report({ total: bad }, { attemptId: 'one' }), false);
 h.recorder.report({ total: Number.MAX_SAFE_INTEGER }, { attemptId: 'one' }); h.recorder.attempt({ id: 'one', status: 'completed' }); complete(h, 'two', { total: 1 });
 assert.equal(h.run.usage.total, null); assert.equal(h.run.usage.complete, false);
 h.run.usageLedger.attempts.push({ ...h.run.usageLedger.attempts[1] }); assert.equal(Usage.project(h.run.usageLedger).invalid, true);
});
