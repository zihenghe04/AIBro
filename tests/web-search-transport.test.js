const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(fetch) {
  const context = vm.createContext({ fetch, URL, AbortController, setTimeout, clearTimeout, TextDecoder, WorkstationCore: require('../app/workstation-core') });
  vm.runInContext(fs.readFileSync(require.resolve('../app/agent-transport'), 'utf8'), context);
  return context.AgentTransport;
}
const stream = events => new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const done = { type: 'response.completed', response: { output_text: '{"message":"ok","actions":[]}' } };
test('web search is opt-in per request and does not persist into a later polishing request', async () => {
  const requests = [];
  const transport = harness(async (url, options) => { requests.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return stream([done]); });
  await transport.requestPlan({ provider: 'openai-auth', input: 'Find public source', webSearch: true, token: 'PRIVATE' });
  assert.equal(requests[0].body.webSearch, true); assert.equal(requests[0].headers.Authorization, undefined); assert.equal(requests[0].body.tools, undefined);
  await transport.requestPlan({ provider: 'openai-auth', input: 'Polish this draft only' });
  assert.equal(requests[1].body.webSearch, undefined); assert.equal(requests[1].body.tools, undefined);
  await transport.requestPlan({ base: 'https://api.openai.com/v1', model: 'supported-model', input: 'Search', webSearch: true });
  assert.deepEqual(requests[2].body.tools, [{ type: 'web_search', external_web_access: true }]); assert.deepEqual(requests[2].body.include, ['web_search_call.action.sources']);
  await transport.requestPlan({ base: 'https://api.openai.com/v1', input: 'Polish' });
  assert.equal(requests[3].body.tools, undefined); assert.equal(requests[3].body.include, undefined);
});
test('unknown compatible API gateways cannot silently advertise hosted search and bools are strict', async () => {
  let calls = 0; const transport = harness(async () => { calls++; return stream([done]); });
  for (const base of ['https://example.invalid/v1', 'http://api.openai.com/v1', 'https://api.openai.com.evil.invalid/v1', 'https://u:p@api.openai.com/v1']) await assert.rejects(transport.requestPlan({ base, input: 'Search', webSearch: true }), error => error.code === 'WEB_SEARCH_UNSUPPORTED');
  for (const webSearch of ['true', 1, null, {}]) await assert.rejects(transport.requestPlan({ provider: 'openai-auth', input: 'Search', webSearch }), error => error.code === 'INVALID_WEB_SEARCH');
  assert.equal(calls, 0);
});
test('real search lifecycle and whitelisted source annotations reach callbacks without changing structured output', async () => {
  const activities = [], batches = [];
  const annotation = { type: 'url_citation', url: 'https://example.invalid/source', title: 'Actual cited page', start_index: 2, end_index: 8, private: 'DO_NOT_EXPOSE' };
  const transport = harness(async () => stream([
    { type: 'response.web_search_call.in_progress', item_id: 'search-1' },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'search-1', status: 'completed', action: { sources: [{ url: annotation.url, title: 'Consulted page', payload: 'DO_NOT_EXPOSE' }] } } },
    { type: 'response.output_text.annotation.added', annotation },
    { type: 'response.web_sources', sources: [{ url: 'javascript:alert(1)' }, { url: 'file:///secret' }, { url: 'https://name:secret@example.invalid/' }, { url: 'https://example.invalid/second', title: 'Observed account search', type: 'web_source', secret: 'DO_NOT_EXPOSE' }] },
    { type: 'response.output_text.delta', delta: '{"message":"ok","actions":[]}' }, done
  ]));
  const output = await transport.requestPlan({ provider: 'openai-auth', input: 'Search', webSearch: true, onActivity: item => activities.push(item), onSources: sources => batches.push(JSON.parse(JSON.stringify(sources))) });
  assert.equal(output, '{"message":"ok","actions":[]}');
  assert.deepEqual(activities.map(item => [item.name, item.status]), [['网页搜索', 'running'], ['网页搜索', 'completed']]);
  assert.deepEqual(batches.at(-1), [{ url: annotation.url, title: 'Actual cited page', type: 'url_citation', start_index: 2, end_index: 8 }, { url: 'https://example.invalid/second', title: 'Observed account search', type: 'web_source' }]);
  assert.ok(!JSON.stringify(batches).includes('DO_NOT_EXPOSE'));
});
test('non-streamed final URL citations are retained and tool errors are never reported as successful search', async () => {
  let received;
  const transport = harness(async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://example.invalid/read', title: 'Source' }] }] }, { type: 'web_search_call', id: 'failed-web', status: 'failed' }] }), { headers: { 'content-type': 'application/json' } }));
  const activities = []; assert.equal(await transport.requestPlan({ provider: 'openai-auth', input: 'Search', onSources: sources => received = sources, onActivity: item => activities.push(item) }), 'Answer');
  assert.equal(received[0].url, 'https://example.invalid/read'); assert.equal(activities[0].status, 'failed');
});
