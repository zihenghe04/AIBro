const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../app/run-failure-diagnostics');
const source = name => fs.readFileSync(require.resolve('../app/' + name), 'utf8');
const json = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
const options = { base: 'https://fixture.invalid/v1', model: 'fixture-model', token: 'synthetic-private-token', input: 'private request text' };
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, TextDecoder, URL, WorkstationCore: require('../app/workstation-core') });
  for (const file of ['run-failure-diagnostics', 'sse-frame-scanner', 'agent-transport', 'run-outcome-presentation']) vm.runInContext(source(file), context);
  return context;
}
const failed = async promise => { try { await promise; assert.fail('expected rejection'); } catch (error) { assert.notEqual(error.code, 'ERR_ASSERTION'); return error; } };
const stream = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });

test('receipt whitelist rejects arbitrary categories and never copies secrets, URLs or raw errors', () => {
  const value = D.normalize({ version: 1, code: 'UPSTREAM_TLS_ERROR', category: 'credentials', httpStatus: 502,
    phase: 'connection', protocol: 'responses', token: 'secret', url: 'https://private.invalid', message: 'body', request: { input: 'private' } });
  assert.deepEqual(value, { version: 1, code: 'UPSTREAM_TLS_ERROR', category: 'tls', httpStatus: 502, phase: 'connection', protocol: 'responses' });
  for (const code of ['__proto__', 'constructor', 'SECRET', { toString() { return 'HTTP_UNAUTHORIZED'; } }]) assert.equal(D.normalize({ version: 1, code }), null);
  assert.equal(D.normalize({ code: 'UPSTREAM_TLS_ERROR' }), null);
  assert.equal(D.capture({ code: 'CANCELLED', diagnostic: value }), null);
  assert.equal(D.capture({ code: 'HTTP', message: 'could be quota or TLS' }), null, 'old HTTP text is insufficient evidence');
});

test('rate limit, explicit quota, output length and unknown service failure remain distinct', () => {
  assert.equal(D.fromHttp(429, { message: 'quota? arbitrary text' }).code, 'RATE_LIMITED');
  assert.equal(D.fromHttp(429, { code: 'insufficient_quota' }).code, 'QUOTA_EXHAUSTED');
  assert.equal(D.fromStream(null, 'max_output_tokens').code, 'OUTPUT_LIMIT');
  assert.equal(D.fromStream({ code: '__proto__' }, 'constructor').code, 'MODEL_STREAM_ERROR');
  assert.equal(D.fromHttp(503, { message: 'busy' }).code, 'UPSTREAM_SERVICE_ERROR');
});

test('historical machine codes can guide recovery without diagnosing old free-text HTTP failures', () => {
  assert.equal(D.forRun({ status: 'failed', errorCode: 'HTTP', error: 'TLS or quota' }), null);
  assert.equal(D.forRun({ status: 'failed', errorCode: 'CREDENTIAL_REENTRY_REQUIRED' }).code, 'CREDENTIAL_REENTRY_REQUIRED');
  assert.equal(D.forRun({ status: 'completed', errorCode: 'MODEL_PROTOCOL_ERROR' }), null);
});

test('invalid tool plans and batches requiring a split have dedicated human guidance without blaming credentials or the network', () => {
  for (const code of ['INVALID_KNOWLEDGE_REQUESTS', 'KNOWLEDGE_BATCH_REQUIRES_SPLIT']) {
    const diagnostic = D.capture({code, message: 'SECRET_NETWORK_API_KEY_TEXT'});
    assert.equal(diagnostic.category, 'tool_plan'); assert.equal(diagnostic.code, code);
    for (const language of ['zh', 'en']) {
      const view = D.present(diagnostic, {language}); assert.equal(view.action, null); assert.equal(view.actionLabel, '');
      assert.doesNotMatch(JSON.stringify(view), /SECRET_|API Key|网络|network|credentials/i);
      assert.match(view.description, language === 'zh' ? /不会自动重试/ : /not retry automatically/);
      assert.match(view.description, language === 'zh' ? /这一批|这一批工具/ : /batch/);
    }
    assert.equal(D.forRun({status: 'failed', errorCode: code}).code, code);
    assert.equal(D.forRun({status: 'cancelled', errorCode: code}), null);
  }
  assert.match(D.present(D.capture({code: 'KNOWLEDGE_BATCH_REQUIRES_SPLIT'})).description, /32 项/);
});

test('knowledge diagnostics preserve only fixed codes, counts and bounded zero-based indices', () => {
  const error = {code: 'INVALID_KNOWLEDGE_REQUESTS', message: 'SECRET_MESSAGE', request: {apiKey: 'SECRET_REQUEST'}, knowledgeDiagnostic: {
    version: 1, code: 'INVALID_KNOWLEDGE_REQUESTS', requestCount: 40, batchLimit: 999, invalidCount: 2, invalidIndices: [0, 39],
    nonReadOnlyCount: 1, nonReadOnlyIndices: [4], title: 'SECRET_TITLE', rawPlan: {requests: ['SECRET_PLAN']}, apiKey: 'SECRET_KEY', url: 'https://SECRET_HOST', invalidContainer: false,
  }};
  const before = JSON.stringify(error), receipt = D.captureKnowledge(error);
  assert.deepEqual(receipt, {version: 1, code: error.code, requestCount: 40, batchLimit: 32, invalidCount: 2, invalidIndices: [0, 39], nonReadOnlyCount: 1, nonReadOnlyIndices: [4]});
  assert.equal(JSON.stringify(error), before); assert.doesNotMatch(JSON.stringify(receipt), /SECRET_|999|invalidContainer/);
  assert.deepEqual(D.captureKnowledge({knowledgeDiagnostic: JSON.parse(JSON.stringify(receipt))}), receipt);
  receipt.invalidIndices.push(2); assert.deepEqual(error.knowledgeDiagnostic.invalidIndices, [0, 39]);
});

test('knowledge diagnostic sanitization rejects unknown codes and invalid counts without deriving facts from error prose', () => {
  const base = {version: 1, code: 'INVALID_KNOWLEDGE_REQUESTS', requestCount: 5, batchLimit: 32};
  for (const value of [undefined, null, false, {}, {code: base.code}, {...base, version: 2}, {...base, code: '__proto__'}, {...base, code: 'UPSTREAM_CONNECTION_ERROR'}, ...['5', true, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(requestCount => ({...base, requestCount}))]) assert.equal(D.captureKnowledge({knowledgeDiagnostic: value}), null);
  for (const code of ['CANCELLED', 'REPEATED_TOOL', 'HTTP_UNAUTHORIZED']) assert.equal(D.captureKnowledge({code, knowledgeDiagnostic: base}), null);
  assert.equal(D.captureKnowledge({code: base.code, message: 'There are 5 invalid requests'}), null);
  assert.equal(D.captureKnowledge({knowledgeDiagnostic: {...base, code: 'KNOWLEDGE_BATCH_REQUIRES_SPLIT', requestCount: 32}}), null);
  const bounded = D.captureKnowledge({knowledgeDiagnostic: {...base, requestCount: 80, invalidCount: 80, invalidIndices: Array.from({length: 80}, (_, index) => index)}});
  assert.equal(bounded.invalidIndices.length, 32); assert.equal(bounded.invalidIndices.at(-1), 31);
  const safe = D.captureKnowledge({knowledgeDiagnostic: {...base, invalidCount: -2, invalidIndices: [-1, '0', 0, 0, 1.1, NaN, 4, 5, Number.MAX_SAFE_INTEGER + 1], nonReadOnlyCount: 0, nonReadOnlyIndices: [2]}});
  assert.deepEqual(safe.invalidIndices, [0, 4]); assert.equal(safe.invalidCount, undefined); assert.equal(safe.nonReadOnlyCount, 0); assert.equal(safe.nonReadOnlyIndices, undefined);
});

test('a malformed request container records an unknown request count instead of inventing zero', () => {
  const receipt = D.captureKnowledge({code: 'INVALID_KNOWLEDGE_REQUESTS', knowledgeDiagnostic: {version: 1, code: 'INVALID_KNOWLEDGE_REQUESTS', requestCount: null, batchLimit: 32, invalidContainer: true, invalidCount: 1, invalidIndices: []}});
  assert.deepEqual(receipt, {version: 1, code: 'INVALID_KNOWLEDGE_REQUESTS', requestCount: null, batchLimit: 32, invalidCount: 1, invalidIndices: []});
  assert.equal(D.forRun({status: 'failed', knowledgeDiagnostic: receipt}).code, receipt.code);
  assert.equal(D.captureKnowledge({knowledgeDiagnostic: {...receipt, code: 'KNOWLEDGE_BATCH_REQUIRES_SPLIT'}}), null);
});

test('tool-plan presentation retains partial answers and earlier side effects without initiating retry', () => {
  let calls = 0; const h = harness(async () => { calls++; assert.fail('diagnosis must not request a model'); });
  for (const code of ['INVALID_KNOWLEDGE_REQUESTS', 'KNOWLEDGE_BATCH_REQUIRES_SPLIT']) {
    const outcome = h.RunOutcomePresentation.present({role: 'agent', text: '先前已完成的公开分析。', retryRunId: 'r'}, {id: 'r', status: 'failed', errorCode: code, commands: [{startedAt: 1}], knowledgeDiagnostic: {version: 1, code, requestCount: 40, batchLimit: 32}});
    assert.equal(outcome.answerText, '先前已完成的公开分析。'); assert.match(outcome.hint, /终端命令/); assert.match(outcome.noticeDescription, /这一批/);
    assert.notEqual(outcome.recoveryAction, 'settings'); assert.ok(outcome.diagnosticDetails.some(item => item.value === code));
  }
  assert.equal(calls, 0);
});

for (const [status, body, code] of [
  [401, {}, 'HTTP_UNAUTHORIZED'], [403, {}, 'HTTP_FORBIDDEN'], [429, {}, 'RATE_LIMITED'],
  [429, { code: 'insufficient_quota' }, 'QUOTA_EXHAUSTED'], [500, {}, 'UPSTREAM_SERVICE_ERROR'],
  [503, { message: 'temporarily overloaded' }, 'UPSTREAM_SERVICE_ERROR'],
  [404, { code: 'model_not_found', message: "The model does not exist" }, 'MODEL_NOT_AVAILABLE'],
  [502, { code: 'UPSTREAM_TLS_ERROR', phase: 'connection' }, 'UPSTREAM_TLS_ERROR'],
]) test(`transport persists safe ${code} evidence for HTTP ${status} without speculative retry`, async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return json(status, { message: 'echo synthetic-private-token private request text https://private.invalid?key=secret', ...body }); });
  const error = await failed(h.AgentTransport.requestPlan(options));
  assert.equal(calls, 1); assert.equal(error.diagnostic.code, code); assert.equal(error.diagnostic.httpStatus, status);
  assert.equal(error.diagnostic.protocol, 'responses'); assert.doesNotMatch(error.message, /synthetic-private|private request|private\.invalid|key=secret/);
  const saved = JSON.parse(JSON.stringify(error.diagnostic));
  assert.equal(D.normalize(saved).code, code);
  const outcome = h.RunOutcomePresentation.present({ role: 'agent', text: '保留已生成的分析。', retryRunId: 'r' }, { id: 'r', status: 'failed', error: error.message, errorDiagnostic: saved, commands: [{ startedAt: 1 }] });
  assert.equal(outcome.answerText, '保留已生成的分析。'); assert.match(outcome.hint, /终端命令/); assert.ok(outcome.diagnosticDetails.some(row => row.value === String(status)));
});

test('recognized route mismatch still falls back once; final failing attempt owns status/protocol', async () => {
  const calls = [];
  const h = harness(async url => { calls.push(url); return calls.length === 1 ? json(503, { message: 'No enabled endpoints are available after routing filters' }) : json(401, { message: 'echo synthetic-private-token' }); });
  const error = await failed(h.AgentTransport.requestPlan(options));
  assert.equal(calls.length, 2); assert.match(decodeURIComponent(calls[1]), /chat\/completions$/);
  assert.equal(error.status, 401); assert.equal(error.diagnostic.code, 'HTTP_UNAUTHORIZED');
  assert.equal(error.diagnostic.protocol, 'chat'); assert.equal(error.diagnostic.fallbackAttempted, true);
  assert.ok(D.present(error.diagnostic).details.some(row => /已尝试 Chat/.test(row.value)));
  assert.doesNotMatch(JSON.stringify(error), /synthetic-private-token/);
});

test('received generation prevents a protocol fallback even with route-like error text', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'No enabled endpoints are available after routing filters' }, output_text: 'partial' }), { status: 503 }); });
  const error = await failed(h.AgentTransport.requestPlan(options));
  assert.equal(calls, 1); assert.equal(error.diagnostic.code, 'UPSTREAM_SERVICE_ERROR');
});

test('SSE interruption retains deltas and is never reported as completion or empty execution', async () => {
  const h = harness(async () => stream([{ type: 'response.output_text.delta', delta: '已读部分内容' }, { type: 'error', error: { code: 'UPSTREAM_STREAM_INTERRUPTED', phase: 'stream', message: 'echo synthetic-private-token' } }]));
  const deltas = []; const error = await failed(h.AgentTransport.requestPlan({ ...options, onDelta: text => deltas.push(text) }));
  assert.deepEqual(deltas, ['已读部分内容']); assert.equal(error.diagnostic.code, 'UPSTREAM_STREAM_INTERRUPTED');
  assert.equal(error.diagnostic.phase, 'stream'); assert.doesNotMatch(error.message, /未执行任何|本次未执行|synthetic-private/);
});

test('clean incomplete stream and invalid JSON produce explicit safe protocol diagnostics', async () => {
  for (const [response, code] of [[stream([{ type: 'response.output_text.delta', delta: 'partial' }]), 'STREAM_INCOMPLETE'], [new Response('{private request text', { headers: { 'content-type': 'application/json' } }), 'INVALID_RESPONSE']]) {
    const error = await failed(harness(async () => response).AgentTransport.requestPlan(options));
    assert.equal(error.diagnostic.code, code); assert.doesNotMatch(error.message, /private request/);
  }
});

test('non-stream incomplete response records response phase and explicit output-limit cause', async () => {
  const h = harness(async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), { headers: { 'content-type': 'application/json' } }));
  const error = await failed(h.AgentTransport.requestPlan(options));
  assert.equal(error.diagnostic.code, 'OUTPUT_LIMIT'); assert.equal(error.diagnostic.phase, 'response');
});

test('Chat length truncation is an output limit rather than an account quota diagnosis', async () => {
  const h = harness(async () => stream([{ choices: [{ index: 0, delta: { content: 'partial' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }]));
  const error = await failed(h.AgentTransport.requestPlan({ ...options, protocol: 'chat' }));
  assert.equal(error.diagnostic.code, 'OUTPUT_LIMIT'); assert.equal(error.diagnostic.protocol, 'chat');
});

test('fetch rejection is safely diagnosed while user cancellation stays cancellation', async () => {
  const h = harness(async () => { throw new TypeError('Failed to fetch synthetic-private-token'); });
  const error = await failed(h.AgentTransport.requestPlan(options));
  assert.equal(error.diagnostic.code, 'UPSTREAM_CONNECTION_ERROR'); assert.doesNotMatch(error.message, /synthetic-private/);
  const controller = new AbortController(); let start;
  const started = new Promise(resolve => start = resolve);
  const waiting = harness(async () => { start(); return new Promise(() => {}); });
  const pending = waiting.AgentTransport.requestPlan({ ...options, signal: controller.signal }); await started; controller.abort();
  const stopped = await failed(pending); assert.equal(stopped.code, 'CANCELLED'); assert.equal(stopped.diagnostic, undefined);
});

test('the production catch stores only a normalized receipt and clears it for cancelled runs', () => {
  const app = source('app');
  const begin = app.indexOf('    const errorDiagnostic = window.RunFailureDiagnostics?.capture(error);');
  const end = app.indexOf("    if (run.status === 'failed') window.AlertSound", begin);
  assert.ok(begin > 0 && end > begin);
  for (const status of ['failed', 'cancelled']) {
    const run = { status, errorDiagnostic: { stale: true } };
    vm.runInNewContext(app.slice(begin, end), { run, error: { code: 'HTTP', status: 401, token: 'secret' }, window: { RunFailureDiagnostics: D } });
    assert.equal(run.errorDiagnostic?.code, status === 'failed' ? 'HTTP_UNAUTHORIZED' : undefined);
    assert.doesNotMatch(JSON.stringify(run), /secret|stale/);
  }
});

test('production recovery route accepts verified historical protocol failures without rewriting their stored status', () => {
  const app = source('app'), begin = app.indexOf('function openRunFailureRecovery('), end = app.indexOf('function retryAttachmentIdsFor(', begin);
  const h = harness(async () => { throw Error('must not request'); });
  const run = { id: 'old-protocol', status: 'completed', conversationId: 'c' };
  const message = { id: 'm', role: 'agent', runId: run.id, text: '<｜DSML｜calls>' };
  const state = { currentConversationId: 'c', agentRuns: [run], conversations: [{ id: 'c', messages: [message] }] }, routes = [];
  const control = { getClientRects: () => [1], scrollIntoView() { routes.push('scroll'); }, focus() { routes.push('focus'); } };
  const env = { state, document: { getElementById: () => control }, showView: view => routes.push(view), openConversation: () => assert.fail('same conversation'), window: { SettingsShell: { open: category => routes.push(category) }, RunFailureDiagnostics: D, WorkstationCore: require('../app/workstation-core'), AgentTransport: h.AgentTransport } };
  vm.createContext(env); vm.runInContext(app.slice(begin, end), env);
  assert.equal(env.openRunFailureRecovery(run.id, 'settings'), true); assert.deepEqual(routes, ['settings', 'models', 'scroll', 'focus']); assert.equal(run.status, 'completed');
  message.text = '真实回答。'; assert.equal(env.openRunFailureRecovery(run.id, 'settings'), false);
  message.text = '<｜DSML｜calls>'; run.status = 'cancelled'; assert.equal(env.openRunFailureRecovery(run.id, 'settings'), false);
});
