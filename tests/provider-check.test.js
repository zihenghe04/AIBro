const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Check = require('../app/provider-check.js');

// A local fake provider: records what was requested; there is no real network or model request.
function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(done => server.close(done)) })));
}
const direct = (url, headers, signal) => fetch(url, { headers, signal });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('lists models with a bearer token and sends nothing but a GET /models', async () => {
  const fx = await fake((req, res) => json(res, 200, { data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-1' }] }));
  try {
    const result = await Check.run({ base: fx.base, protocol: 'chat', token: 'test-token', request: direct });
    assert.deepEqual([result.ok, result.state, result.models], [true, 'ok', ['m-1', 'm-2']]);
    assert.equal(fx.seen.length, 1);
    assert.deepEqual([fx.seen[0].method, fx.seen[0].url, fx.seen[0].headers.authorization], ['GET', '/v1/models', 'Bearer test-token']);
    assert.ok(!JSON.stringify(result).includes('test-token'));
  } finally { await fx.close(); }
});

test('anthropic protocol uses x-api-key and the v1 models path', async () => {
  const fx = await fake((req, res) => json(res, 200, { data: [{ id: 'c-1' }] }));
  try {
    const result = await Check.run({ base: fx.base.replace('/v1', ''), protocol: 'anthropic', token: 'k', request: direct });
    assert.equal(result.state, 'ok');
    assert.equal(fx.seen[0].url, '/v1/models?limit=1000');
    assert.equal(fx.seen[0].headers['x-api-key'], 'k');
    assert.equal(fx.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(fx.seen[0].headers.authorization, undefined);
  } finally { await fx.close(); }
});

test('auth failure, missing model list, server error and bad payload each get their own state', async () => {
  for (const [status, body, expected] of [[401, { error: 'x' }, 'auth'], [403, {}, 'auth'], [404, {}, 'reachable'], [405, {}, 'reachable'], [500, {}, 'error'], [200, { nope: 1 }, 'error']]) {
    const fx = await fake((req, res) => json(res, status, body));
    try { assert.equal((await Check.run({ base: fx.base, token: 't', request: direct })).state, expected, String(status)); } finally { await fx.close(); }
  }
});

test('an unreachable address and a hang end with a clear state', async () => {
  const gone = await fake((req, res) => json(res, 200, {}));
  const base = gone.base; await gone.close();
  assert.equal((await Check.run({ base, token: 't', request: direct })).state, 'unreachable');
  const slow = await fake(() => { /* never answers */ });
  try {
    const result = await Check.run({ base: slow.base, token: 't', request: direct, timeoutMs: 80 });
    assert.equal(result.state, 'timeout');
  } finally { slow.server.closeAllConnections(); await slow.close(); }
});

test('invalid input never reaches the network', async () => {
  let called = 0;
  const request = async () => { called += 1; };
  assert.equal((await Check.run({ base: '', request })).state, 'invalid');
  assert.equal((await Check.run({ base: 'not a url', request })).state, 'invalid');
  assert.equal(called, 0);
});

const directWith = (url, headers, signal, init = {}) => fetch(url, { headers, signal, ...(init.method ? { method: init.method, body: init.body } : {}) });

test('protocol probe finds a chat-only service and suggests Chat Completions', async () => {
  const chatOnly = await fake((req, res) => {
    if (req.url === '/v1/chat/completions') return json(res, 400, { error: { message: 'model is required' } });
    json(res, 503, { error: { message: 'No enabled endpoints for this request (routing filters)' } });
  });
  try {
    const support = await Check.probeProtocols({ base: chatOnly.base, token: 't', request: directWith });
    assert.deepEqual(support, { responses: false, chat: true });
    assert.equal(Check.suggestProtocol('responses', support), 'chat');
    assert.equal(Check.suggestProtocol('chat', support), '');
    // Only invalid, non-generating bodies are sent.
    assert.ok(chatOnly.seen.every(entry => entry.method === 'POST'));
  } finally { await chatOnly.close(); }
});

test('protocol probe treats 404 as unsupported and unknown failures as undecided', async () => {
  const responsesOnly = await fake((req, res) => json(res, req.url === '/v1/responses' ? 401 : 404, {}));
  try { assert.deepEqual(await Check.probeProtocols({ base: responsesOnly.base, request: directWith }), { responses: true, chat: false }); } finally { await responsesOnly.close(); }
  const broken = await fake((req, res) => json(res, 502, {}));
  try {
    const support = await Check.probeProtocols({ base: broken.base, request: directWith });
    assert.deepEqual(support, { responses: null, chat: null });
    assert.equal(Check.suggestProtocol('responses', support), '');
  } finally { await broken.close(); }
});
