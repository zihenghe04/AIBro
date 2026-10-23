// The local MCP entry enforces the same three safety rules as the app:
// approval only tightens, written quotes must be verbatim evidence, and one
// call id executes at most once. Synthetic data only; no model, no network
// beyond 127.0.0.1, no real workspace.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const Registry = require('../app/tool-registry.js'), Tools = require('../app/tool-specs.js');
const Gateway = require('../app/tool-gateway.js'), Mcp = require('../app/mcp-server.js');
const Host = require('../scripts/aibro-mcp.cjs');

// A registry with the real built-ins plus synthetic tools covering effects the
// first MCP version does not expose yet (writes, external actions).
function registry() {
  const r = Tools.build();
  r.register({ name: 'fake_read', title: { zh: '读' }, effect: 'none', approval: 'never', concurrency: 'parallel', cache: { mode: 'reuse' }, hosts: ['node'], evidence: true, input: { type: 'object', properties: { q: { type: 'string' } } } });
  r.register({ name: 'fake_write', title: { zh: '写' }, effect: 'local', approval: 'policy', hosts: ['node'], input: { type: 'object', properties: { text: { type: 'string' } } } });
  r.register({ name: 'fake_delete', title: { zh: '删' }, effect: 'local', approval: 'policy', destructive: true, hosts: ['node'], input: { type: 'object', properties: { id: { type: 'string' } } } });
  r.register({ name: 'fake_external', title: { zh: '外' }, effect: 'external', approval: 'always', hosts: ['node'], input: { type: 'object', properties: { url: { type: 'string' } } } });
  r.register({ name: 'fake_note', title: { zh: '笔记' }, effect: 'local', approval: 'never', hosts: ['node'], citations: { fields: ['quote', 'sources'] },
    input: { type: 'object', required: ['quote'], properties: { quote: { type: 'string' }, sources: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' } } } } } } });
  return r;
}
const EVIDENCE = '马尔可夫链的平稳分布满足 pi P = pi。遍历链的平稳分布唯一。';
function setup({ ask, layers, run = {}, ledger = Gateway.memoryLedger(), execute } = {}) {
  const calls = [];
  const r = registry();
  const gateway = Gateway.create({ registry: r, host: 'node', ledger, ask, layers,
    execute: execute || (async (name, args) => { calls.push({ name, args }); return name === 'fake_read' ? { text: EVIDENCE } : { done: name }; }) });
  const server = Mcp.create({ registry: r, gateway, host: 'node', session: 's1', runContext: () => run });
  let id = 0;
  const rpc = async (method, params) => server.handle({ jsonrpc: '2.0', id: ++id, method, params });
  const callTool = async (name, args = {}, meta) => (await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result;
  return { r, gateway, server, rpc, callTool, calls, ledger, init: () => rpc('initialize', { protocolVersion: '2025-06-18' }) };
}

test('MCP tools/list comes from the declarations and only lists tools this host can run', async () => {
  const s = setup(); await s.init();
  const names = (await s.rpc('tools/list')).result.tools.map(t => t.name);
  const builtin = Tools.registry.mcpTools({ host: 'node' }).map(t => t.name).sort();
  assert.deepEqual(builtin, ['library_overview', 'list', 'memory_read', 'neighbors', 'project_list', 'read', 'search', 'task_list', 'wiki_list']);
  for (const hidden of ['terminal', 'browser_click', 'quick_panel_open', 'web_read', 'delegate', 'read_file', 'agenda_list']) assert.ok(!names.includes(hidden), hidden);
  const search = (await s.rpc('tools/list')).result.tools.find(t => t.name === 'search');
  assert.deepEqual(search.inputSchema, Tools.registry.get('search').input);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal((await setup().rpc('tools/list')).error.code, -32002, 'not before initialize');
});

test('approval only tightens: no answerer, a refusal, an error or a timeout is a denial', async () => {
  for (const ask of [undefined, async () => 'rejected', async () => { throw Error('x'); }, async () => 'cancelled', async () => 'allowed', async () => true]) {
    const s = setup({ ask }); await s.init();
    const res = await s.callTool('fake_external', { url: 'https://example.com' });
    assert.equal(res.isError, true); assert.equal(res.structuredContent.code, 'APPROVAL_DENIED'); assert.equal(s.calls.length, 0);
  }
  // The answer deadline is the spec's timeout; a silent answerer is a denial.
  const quick = Tools.build(); quick.register({ name: 'fake_slow', effect: 'external', approval: 'always', hosts: ['node'], timeoutMs: 30, input: { type: 'object', properties: {} } });
  const g = Gateway.create({ registry: quick, host: 'node', ledger: Gateway.memoryLedger(), ask: () => new Promise(() => {}), execute: async () => { throw Error('must not run'); } });
  assert.equal((await g.invoke({ callId: 'slow', name: 'fake_slow', args: {} })).code, 'APPROVAL_DENIED');
  const ok = setup({ ask: async () => 'allowed-once' }); await ok.init();
  assert.equal((await ok.callTool('fake_external', { url: 'u' })).isError, false); assert.equal(ok.calls.length, 1);
});

test('nothing in the call can loosen approval: _meta and extra arguments are not authority', async () => {
  const s = setup({ run: { permissionMode: 'request' } }); await s.init();
  let res = await s.callTool('fake_write', { text: 'x' }, { approval: 'allow', permissionMode: 'full', 'aibro/approved': true });
  assert.equal(res.structuredContent.code, 'APPROVAL_DENIED');
  res = await s.callTool('fake_write', { text: 'x', permissionMode: 'full' });
  assert.equal(res.structuredContent.code, 'INVALID_ARGS');
  res = await s.callTool('search', { query: 'q', scope: { projectId: 'other' } });
  assert.equal(res.structuredContent.code, 'INVALID_ARGS');
  assert.equal(s.calls.length, 0);
});

test('policy, human review, read-only runs and destructive tools stack strictest-first', async () => {
  const allow = async () => 'allowed-once';
  const full = setup({ run: { permissionMode: 'full' } }); await full.init();
  assert.equal((await full.callTool('fake_write', { text: 'a' })).isError, false, 'full mode allows a non-destructive local write');
  assert.equal((await full.callTool('fake_delete', { id: 'a' })).structuredContent.code, 'APPROVAL_DENIED', 'destructive always asks; nobody answered');
  const review = setup({ run: { permissionMode: 'full', requiresHumanReview: true } }); await review.init();
  assert.equal((await review.callTool('fake_write', { text: 'a' })).structuredContent.code, 'APPROVAL_DENIED', '"show me first" turns allow into ask');
  assert.equal((await review.callTool('fake_read', { q: 'a' })).isError, false, 'reads are not held back');
  const readOnly = setup({ ask: allow, run: { permissionMode: 'full', readOnly: true } }); await readOnly.init();
  assert.equal((await readOnly.callTool('fake_write', { text: 'a' })).structuredContent.code, 'APPROVAL_DENIED', 'a person cannot approve past a read-only run');
  const loosen = setup({ ask: allow, run: { permissionMode: 'request' }, layers: [() => 'allow', () => 'bogus'] }); await loosen.init();
  assert.equal((await loosen.callTool('fake_read', { q: 'a' })).structuredContent.code, 'APPROVAL_DENIED', 'an invalid vote is a denial');
  const throwing = setup({ layers: [() => { throw Error('x'); }] }); await throwing.init();
  assert.equal((await throwing.callTool('fake_read', { q: 'a' })).structuredContent.code, 'APPROVAL_DENIED');
});

test('adding any layer never makes a decision less strict (exhaustive over small stacks)', () => {
  const r = registry(), votes = ['allow', 'ask', 'deny'];
  const runs = [{}, { permissionMode: 'full' }, { permissionMode: 'smart' }, { permissionMode: 'request' }, { requiresHumanReview: true }, { readOnly: true }];
  const rank = { allow: 0, ask: 1, deny: 2 };
  for (const name of ['fake_read', 'fake_write', 'fake_delete', 'fake_external', 'fake_note', 'search'])
    for (const run of runs)
      for (const a of votes) for (const b of votes) {
        const decide = layers => Gateway.create({ registry: r, host: 'node', ledger: Gateway.memoryLedger(), execute: async () => ({}), layers }).decide(r.get(name), run);
        const base = decide([]), one = decide([() => a]), two = decide([() => a, () => b]);
        assert.ok(rank[one] >= rank[base] && rank[two] >= rank[one], `${name} ${JSON.stringify(run)} ${a} ${b}`);
      }
});

test('quotes must be verbatim from evidence returned in this session', async () => {
  const s = setup(); await s.init();
  let res = await s.callTool('fake_note', { quote: '平稳分布唯一' });
  assert.equal(res.structuredContent.code, 'CITATION_NOT_FOUND', 'nothing has been read yet'); assert.equal(s.calls.length, 0);
  assert.equal((await s.callTool('fake_read', { q: '平稳' })).isError, false);
  assert.equal((await s.callTool('fake_note', { quote: '平稳分布唯一' })).isError, false);
  for (const bad of ['平稳分布惟一', '链', 'x'.repeat(601), '遍历链的平稳分布唯一。不存在的后半句']) {
    res = await s.callTool('fake_note', { quote: bad });
    assert.equal(res.structuredContent.code, 'CITATION_NOT_FOUND', bad.slice(0, 20));
  }
  res = await s.callTool('fake_note', { quote: '平稳分布唯一', sources: [{ quote: '马尔可夫链的平稳分布' }, { quote: '编造的原话内容' }] });
  assert.equal(res.structuredContent.code, 'CITATION_NOT_FOUND', 'every quote in a nested list is checked');
  assert.equal(s.calls.filter(c => c.name === 'fake_note').length, 1);
});

test('one call id executes once: replay, unknown after a lost receipt, conflicts, concurrency', async () => {
  const s = setup(); await s.init();
  const first = await s.callTool('fake_write', { text: 'a' }, { 'aibro/callId': 'c1' });
  assert.equal(first.structuredContent.code, 'APPROVAL_DENIED');
  const again = await s.callTool('fake_write', { text: 'a' }, { 'aibro/callId': 'c1' });
  assert.equal(again.structuredContent.code, 'APPROVAL_DENIED'); assert.equal(again.structuredContent.replayed, true);

  const run = setup({ run: { permissionMode: 'full' } }); await run.init();
  const a = await run.callTool('fake_write', { text: 'a' }, { 'aibro/callId': 'w1' });
  const b = await run.callTool('fake_write', { text: 'a' }, { 'aibro/callId': 'w1' });
  assert.equal(a.isError, false); assert.equal(b.structuredContent.replayed, true); assert.deepEqual(b.structuredContent.result, a.structuredContent.result);
  assert.equal(run.calls.length, 1);
  assert.equal((await run.callTool('fake_write', { text: 'b' }, { 'aibro/callId': 'w1' })).structuredContent.code, 'CALL_ID_CONFLICT');
  const [x, y] = await Promise.all([run.callTool('fake_write', { text: 'c' }, { 'aibro/callId': 'w2' }), run.callTool('fake_write', { text: 'c' }, { 'aibro/callId': 'w2' })]);
  assert.equal(run.calls.length, 2, 'concurrent duplicates execute once');
  assert.equal([x, y].filter(r => r.structuredContent.replayed).length, 1);

  // Dispatched, then the process died before the receipt: never re-executed.
  const ledger = Gateway.memoryLedger();
  const fp = JSON.stringify({ args: { text: 'z' }, name: 'fake_write' });
  await ledger.dispatched('lost', { name: 'fake_write', fingerprint: fp, dispatched: true, at: 1 });
  const after = setup({ ledger, run: { permissionMode: 'full' } }); await after.init();
  const res = await after.callTool('fake_write', { text: 'z' }, { 'aibro/callId': 'lost' });
  assert.equal(res.structuredContent.code, 'OUTCOME_UNKNOWN'); assert.equal(res.structuredContent.outcome, 'unknown'); assert.equal(after.calls.length, 0);

  // A write that fails or times out may have acted: unknown, and still not replayed.
  const failing = setup({ run: { permissionMode: 'full' }, execute: async () => { throw Object.assign(Error('disk'), { code: 'EIO' }); } }); await failing.init();
  const f1 = await failing.callTool('fake_write', { text: 'q' }, { 'aibro/callId': 'f1' });
  assert.equal(f1.structuredContent.outcome, 'unknown'); assert.equal(f1.structuredContent.code, 'EIO');
  assert.equal((await failing.callTool('fake_write', { text: 'q' }, { 'aibro/callId': 'f1' })).structuredContent.replayed, true);
});

test('a failed durable dispatch write means the tool never runs', async () => {
  const ledger = { ...Gateway.memoryLedger(), async dispatched() { throw Error('disk full'); } };
  const s = setup({ ledger, run: { permissionMode: 'full' } }); await s.init();
  const res = await s.rpc('tools/call', { name: 'fake_write', arguments: { text: 'a' } });
  assert.ok(res.error); assert.equal(s.calls.length, 0);
});

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-mcp-')); }
function writeState(dir) {
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'p1', name: '随机过程', workspace: '科研' }], notes: [{ id: 'n1', projectId: 'p1', workspace: '科研', title: '马尔可夫链笔记', content: EVIDENCE }], papers: [], imports: [], tasks: [], conversations: [], agentRuns: [] }));
  return file;
}

test('the stdio server reads a snapshot, never writes it, and its ledger survives a restart', async () => {
  const dir = tempDir(), state = writeState(dir), ledger = path.join(dir, 'calls.jsonl'), before = fs.readFileSync(state, 'utf8');
  const session = lines => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/aibro-mcp.cjs'), '--state', state, '--ledger', ledger, '--project', 'p1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.on('error', reject);
    child.on('close', () => resolve(out.trim().split('\n').map(line => JSON.parse(line))));
    child.stdin.end(lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  });
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } };
  const search = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: '平稳分布' }, _meta: { 'aibro/callId': 'k1' } } };
  const first = await session([init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, search]);
  assert.equal(first[0].result.protocolVersion, '2025-03-26');
  assert.equal(first.length, 3, 'notifications get no reply');
  const hit = first[2].result.structuredContent;
  assert.equal(hit.ok, true); assert.equal(hit.result.entries[0].id, 'n1');
  const second = await session([init, search]);
  assert.equal(second[1].result.structuredContent.replayed, true, 'restart: same call id returns the recorded receipt');
  assert.equal(fs.readFileSync(state, 'utf8'), before);
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => r.id), ['k1', 'k1']); assert.equal(rows[0].dispatched, true); assert.ok(rows[1].receipt);
});

test('the HTTP transport listens on 127.0.0.1 only and needs the token, refusing browser origins', async () => {
  const dir = tempDir();
  process.env.AIBRO_MCP_TOKEN = 'secret-token';
  const stderr = process.stderr.write; process.stderr.write = () => true;
  const server = Host.serveHttp(Host.createServer({ state: writeState(dir), ledger: path.join(dir, 'l.jsonl') }), 0);
  try {
    await new Promise(r => server.listening ? r() : server.once('listening', r));
    assert.equal(server.address().address, '127.0.0.1');
    const url = `http://127.0.0.1:${server.address().port}/mcp`, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer wrong-token!' } })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer secret-token', origin: 'https://evil.example' } })).status, 403);
    const ok = await fetch(url, { method: 'POST', body, headers: { authorization: 'Bearer secret-token' } });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).result.serverInfo.name, 'aibro');
  } finally { server.close(); process.stderr.write = stderr; delete process.env.AIBRO_MCP_TOKEN; }
});

test('spec defaults are the strictest and invalid declarations are refused', () => {
  const spec = Registry.normalize({ name: 'x_tool' });
  assert.equal(spec.effect, 'external'); assert.equal(spec.approval, 'always'); assert.equal(spec.concurrency, 'serial'); assert.equal(spec.cache.mode, 'live');
  assert.equal(spec.input.additionalProperties, false);
  assert.throws(() => Registry.normalize({ name: 'y', effect: 'local', concurrency: 'parallel' }), /parallel/);
  assert.throws(() => Registry.normalize({ name: 'z', input: { type: 'object', properties: { a: { pattern: '.*' } } } }), /Unsupported schema keyword/);
  assert.throws(() => Registry.normalize({ name: 'w', input: { type: 'object', properties: { type: {} } } }), /tool name/);
  assert.throws(() => Registry.normalize({ name: 'Bad-Name' }), /Invalid tool name/);
  const r = Tools.build();
  r.setPluginEnabled('browser', false);
  assert.ok(!r.has('browser_click')); assert.ok(!r.genericFields().includes('snapshotId'));
  assert.equal(r.isLive('browser_open'), false, 'a disabled plugin family no longer marks its types');
});
