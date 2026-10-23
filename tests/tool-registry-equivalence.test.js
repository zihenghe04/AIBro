// The tool registry must reproduce, item for item, the hand-written tables and
// prompt text it replaced. The fixture was extracted from the pre-registry
// revision by scripts/extract-tool-legacy.cjs; old functions run side by side.
const test = require('node:test'), assert = require('node:assert/strict');
const legacy = require('./fixtures/tool-registry-legacy.json');
const Tools = require('../app/tool-specs.js'), Scheduler = require('../app/tool-scheduler.js'), Knowledge = require('../app/knowledge-access.js');
const R = Tools.registry;
const sorted = set => [...set].sort();
const clone = x => JSON.parse(JSON.stringify(x));
const legacyFn = (source, name, extra = '') => Function('clone', `"use strict";${extra}\n${source}\nreturn ${name};`)(clone);
const oldSafeRequest = legacyFn(legacy.functions.safeRequest, 'safeRequest');
const oldRequestKey = legacyFn(legacy.functions.requestKey, 'requestKey', legacy.functions.pageNumber + '\n' + legacy.functions.pdfCursor);
const oldLive = Function('r', `return ${legacy.functions.liveKey};`);

test('classification sets equal the old hard-coded sets', () => {
  assert.deepEqual(sorted(R.readTypes()), sorted(legacy.scheduler.reads));
  assert.deepEqual(sorted(R.parallelTypes()), sorted(legacy.scheduler.reads), 'parallel batches = old reads');
  assert.deepEqual(sorted(R.viewTypes()), sorted(legacy.scheduler.viewOnly));
  assert.deepEqual(sorted(R.chunkableTypes()), sorted(legacy.knowledge.chunkableReads));
  assert.equal(Tools.BATCH_LIMIT, legacy.knowledge.batchLimit);
});

test('ledger labels are unchanged, including types that had none', () => {
  for (const [type, text] of Object.entries(legacy.scheduler.labels)) assert.equal(R.label(type), text, type);
  for (const spec of R.list()) if (!legacy.scheduler.labels[spec.name]) assert.equal(R.label(spec.name), spec.name);
  assert.equal(R.label('made_up_tool'), 'made_up_tool');
});

test('argument whitelist and gates are unchanged (fields and order)', () => {
  assert.deepEqual(R.genericFields(), legacy.scheduler.genericFields);
  for (const [type, fields] of Object.entries(legacy.scheduler.agendaFields)) assert.deepEqual(['type', ...Object.keys(R.get(type).input.properties)].sort(), [...fields].sort());
  assert.deepEqual(['type', ...Object.keys(R.get('quick_panel_open').input.properties)].sort(), [...legacy.scheduler.quickPanelFields].sort());
});

test('evidence cache keys: fields, normalization and live types are unchanged', () => {
  for (const [type, fields] of Object.entries(legacy.knowledge.keyFields)) assert.deepEqual([...R.keyFields(type)].sort(), [...fields].sort(), type);
  for (const spec of R.list()) if (!legacy.knowledge.keyFields[spec.name]) assert.equal(R.keyFields(spec.name), null, spec.name);
  for (const type of [...R.list().map(s => s.name), 'browser_future', 'terminal_x', 'unknown']) assert.equal(R.isLive(type), oldLive({ type }), type);
});

// Deterministic generator of model-like requests: valid, partial, wrong-typed
// and authority-smuggling fields over every known and some unknown types.
function* requests() {
  const types = [...R.list().map(s => s.name), 'browser_future', 'unknown_tool', 'delete_note'];
  const values = [undefined, 0, 1, 7, -1, 2.5, '3', '', ' q ', 'abc', null, true, ['a'], { x: 1 }, 'x'.repeat(40), '😀'.repeat(20), 20000, 100];
  const fields = [...new Set([...legacy.scheduler.genericFields, 'from', 'to', 'limit', 'eventId', 'expectedVersion', 'section', 'recordId', 'permissionMode', 'scope', 'browserPermission', 'projectId'])].filter(f => f !== 'type');
  let seed = 7; const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (const type of types) {
    yield { type };
    for (let i = 0; i < 160; i++) {
      const request = { type };
      const count = rand(5);
      for (let k = 0; k < count; k++) { const value = values[rand(values.length)]; if (value !== undefined) request[fields[rand(fields.length)]] = value; }
      yield request;
    }
  }
  yield { type: 'quick_panel_open', section: 'home' };
  yield { type: 'quick_panel_open', section: 'tasks', recordType: 'task', recordId: 't1' };
  yield { type: 'quick_panel_open', section: 'tasks', recordType: 'task' };
  yield { type: 'quick_panel_open', section: 'x'.repeat(33) };
  yield { type: 'quick_panel_open', section: 'home', recordType: '', recordId: '' };
  yield { type: 'agenda_list', query: 'a', from: 1, to: 2, limit: 5, offset: 0 };
  yield { type: 'agenda_read', eventId: 'e', scope: 'all' };
}
const outcome = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message, code: error.code }; } };

test('safeRequest gives the same copy or the same refusal as before', () => {
  let n = 0;
  for (const request of requests()) { n++; assert.deepEqual(outcome(() => Scheduler.safeRequest(clone(request))), outcome(() => oldSafeRequest(clone(request))), JSON.stringify(request)); }
  // Same key order in the persisted copy, not only the same members.
  const full = Object.fromEntries(legacy.scheduler.genericFields.slice().reverse().map(k => [k, k === 'type' ? 'read' : 1]));
  assert.deepEqual(Object.keys(Scheduler.safeRequest(full)), Object.keys(oldSafeRequest(full)));
  assert.ok(n > 4000);
});

test('requestKey gives the same key or the same failure as before', () => {
  for (const request of requests()) {
    const now = outcome(() => Knowledge.requestKey(clone(request))), before = outcome(() => oldRequestKey(clone(request)));
    assert.equal('error' in now, 'error' in before, JSON.stringify(request));
    if (!('error' in now)) assert.equal(now.value, before.value, JSON.stringify(request));
  }
});

test('tool protocol text rendered from specs is byte-identical', () => {
  const t = Tools.text;
  assert.equal(t.batchRule() + '\n', legacy.text.contextBatch);
  assert.equal(t.readCatalog() + '\n', legacy.text.contextCatalog);
  assert.equal(t.rules('quick_panel_open'), legacy.text.quickPanel);
  assert.equal('\n' + t.batchRule(), legacy.text.appBatch);
  assert.equal(t.knowledgeRule(), legacy.text.appKnowledge);
  assert.equal(t.rules('terminal'), legacy.text.appTerminal);
  assert.equal(t.rules('delegate'), legacy.text.appDelegate);
});

test('AgentContext still renders the same opening protocol and quick panel text', () => {
  const AgentContext = require('../app/agent-context.js');
  globalThis.workstationDesktop = { quickPanel: { request() {} } };
  try {
    const ctx = AgentContext.create({ fullInstruction: '', now: 'n', timeZone: 'z', userMessageId: 'm', hasQuickPanel: true });
    const text = ctx.instructions();
    assert.ok(text.includes('\n' + legacy.text.contextBatch + legacy.text.contextCatalog));
    assert.equal(ctx.capability('quick_panel').instructions, legacy.text.quickPanel);
  } finally { delete globalThis.workstationDesktop; }
});

test('app.js no longer carries the tool paragraphs as literals', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app/app.js'), 'utf8');
  for (const key of ['appKnowledge', 'appTerminal', 'appDelegate']) assert.ok(!source.includes(legacy.text[key].slice(1, 60)), key);
  for (const call of ["KnowledgeAccess.toolText.knowledgeRule()", "KnowledgeAccess.toolText.rules('terminal')", "KnowledgeAccess.toolText.rules('delegate')", "'\\n'+KnowledgeAccess.toolText.batchRule()"]) assert.ok(source.includes(call), call);
});
