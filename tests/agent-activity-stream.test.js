const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../agent-transport'), 'utf8');
const encode = value => new TextEncoder().encode(value);
async function run(events, options = {}) {
  const activities = [], phases = [], deltas = [];
  const payload = options.json ? JSON.stringify(events) : [...events,{type:'response.completed'}].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const ctx = vm.createContext({ AbortController, TextDecoder, WorkstationCore: require('../workstation-core'), fetch: async () => new Response(new ReadableStream({ start(controller) {
    const bytes = encode(payload);
    if (options.fragmented) for (let index = 0; index < bytes.length; index += 5) controller.enqueue(bytes.slice(index, index + 5));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': options.json ? 'application/json' : 'text/event-stream' } }) });
  vm.runInContext(source, ctx);
  const output = await ctx.AgentTransport.requestPlan({ base: 'https://example.invalid/v1', input: 'fixture', onActivity: value => activities.push(JSON.parse(JSON.stringify(value))), onPhase: (...value) => phases.push(value), onDelta: value => deltas.push(value) });
  return { output, activities, phases, deltas, latest: id => activities.filter(item => item.id === id).at(-1) };
}
const answer = { type: 'response.output_text.delta', item_id: 'answer', delta: '{"actions":[]}' };

test('public summary deltas and authoritative snapshots update one activity without duplicate text', async () => {
  const h = await run([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r', summary_index: 0, delta: '正在核对' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r', summary_index: 0, delta: '课件图表。' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r', summary_index: 0, text: '正在核对课件图表。' },
    { type: 'response.reasoning_summary_part.done', item_id: 'r', summary_index: 1, part: { type: 'summary_text', text: '接着检查公式。' } },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: '正在核对课件图表。' }, { type: 'summary_text', text: '接着检查公式。' }], content: [{ type: 'reasoning_text', text: 'PRIVATE RAW' }], encrypted_content: 'PRIVATE ENCRYPTED' } }, answer
  ], { fragmented: true });
  assert.equal(h.output, answer.delta);
  assert.deepEqual(h.latest('summary:r:0'), { id: 'summary:r:0', kind: 'summary', name: '公开摘要', status: 'completed', text: '正在核对课件图表。' });
  assert.equal(h.latest('summary:r:1').text, '接着检查公式。');
  assert.equal(h.activities.length, 4, 'Repeated completed snapshots must not create duplicate rows or updates');
  assert.match(h.phases.filter(item => item[1]).at(-1)[1], /^正在核对课件图表。\n\n接着检查公式。$/);
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE/);
});

test('Codex commentary and Responses commentary are visible progress, not final JSON', async () => {
  const h = await run([
    { type: 'response.reasoning_summary_text.delta', item_id: 'codex-comment', source: 'commentary', delta: '先查看原件。' },
    { type: 'response.reasoning_summary_text.done', item_id: 'codex-comment', source: 'commentary', text: '先查看原件。' },
    { type: 'response.output_item.added', item: { type: 'message', id: 'api-comment', phase: 'commentary', content: [] } },
    { type: 'response.output_text.delta', item_id: 'api-comment', delta: '已经读到第 3 页。' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'api-comment', phase: 'commentary', content: [{ type: 'output_text', text: '已经读到第 3 页。' }] } },
    answer, { type: 'response.output_text.done', item_id: 'answer', text: answer.delta }
  ]);
  assert.equal(h.output, answer.delta); assert.deepEqual(h.deltas, [answer.delta]);
  assert.equal(h.latest('commentary:codex-comment:0').text, '先查看原件。');
  assert.equal(h.latest('commentary:api-comment:0').status, 'completed');
});

test('raw reasoning, encrypted data, unknown summaries and tool argument/output deltas are never forwarded', async () => {
  const h = await run([
    { type: 'response.reasoning_text.delta', delta: 'PRIVATE RAW' },
    { type: 'response.reasoning_text.done', text: 'PRIVATE RAW' },
    { type: 'response.reasoning_encrypted.delta', delta: 'PRIVATE ENCRYPTED' },
    { type: 'response.function_call_arguments.delta', delta: 'PRIVATE ARGUMENTS' },
    { type: 'response.shell_call_output_content.delta', delta: 'PRIVATE COMMAND OUTPUT' },
    { type: 'arbitrary.summary', summary: { text: 'PRIVATE UNRECOGNIZED' } },
    { type: 'response.in_progress', progress: true, text: 'PRIVATE HEARTBEAT' },
    { type: 'response.reasoning_summary_part.done', part: { type: 'reasoning_text', text: 'PRIVATE MISLABEL' } }, answer
  ]);
  assert.equal(h.output, answer.delta); assert.equal(h.activities.length, 0);
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE/);
});

test('observed tools expose only bounded names and lifecycle, while function requests stay pending', async () => {
  const h = await run([
    { type: 'response.tool_activity', id: 'codex-tool', name: 'pdf.read', status: 'running', text: 'MCP 工具', arguments: 'PRIVATE ARG', result: 'PRIVATE RESULT' },
    { type: 'response.tool_activity', id: 'codex-tool', name: 'pdf.read', status: 'completed', text: 'MCP 工具', output: 'PRIVATE OUTPUT' },
    { type: 'response.output_item.added', item: { id: 'search', type: 'web_search_call', status: 'in_progress', action: { query: 'PRIVATE QUERY' } } },
    { type: 'response.web_search_call.completed', item_id: 'search' },
    { type: 'response.web_search_call.in_progress', item_id: 'search' },
    { type: 'response.output_item.added', item: { id: 'named-mcp', type: 'mcp_call', name: 'read_pdf', status: 'in_progress' } },
    { type: 'response.mcp_call.completed', item_id: 'named-mcp' },
    { type: 'response.output_item.done', item: { id: 'call', type: 'function_call', name: 'read_document', status: 'completed', arguments: 'PRIVATE PARAMS' } },
    { type: 'response.output_item.done', item: { id: 'failed', type: 'mcp_call', name: 'bad', status: 'failed', error: { message: 'PRIVATE ERROR' }, output: 'PRIVATE OUTPUT' } },
    { type: 'response.tool_activity', id: 'bad-name', name: 'PRIVATE '.repeat(100), status: 'running', text: 'PRIVATE DESCRIPTION' }, answer
  ]);
  assert.deepEqual(h.activities.filter(item => item.id === 'tool:codex-tool').map(item => item.status), ['running', 'completed']);
  assert.equal(h.latest('tool:codex-tool').name, 'pdf.read');
  assert.equal(h.latest('tool:search').status, 'completed');
  assert.equal(h.latest('tool:named-mcp').name, 'read_pdf');
  assert.equal(h.latest('tool:named-mcp').status, 'completed');
  assert.equal(h.latest('tool:call').status, 'pending');
  assert.match(h.latest('tool:call').text, /等待宿主执行/);
  assert.equal(h.latest('tool:failed').status, 'failed');
  assert.equal(h.latest('tool:bad-name').name, '工具调用');
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE/);
  assert.equal(h.output, answer.delta);
});

test('completed JSON Responses retain public summaries and exclude reasoning content from final answer', async () => {
  const h = await run({ output: [
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: '已核对来源。' }], content: [{ type: 'text', text: 'PRIVATE RAW' }], encrypted_content: 'PRIVATE ENCRYPTED' },
    { type: 'message', id: 'comment', phase: 'commentary', content: [{ type: 'output_text', text: '正在整理结果。' }] },
    { type: 'message', id: 'final', phase: 'final_answer', content: [{ type: 'output_text', text: answer.delta }] }
  ] }, { json: true });
  assert.equal(h.output, answer.delta);
  assert.equal(h.latest('summary:r:0').text, '已核对来源。');
  assert.equal(h.latest('commentary:comment:0').text, '正在整理结果。');
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE/);
});

test('activity history and per-item text are bounded without imposing generation timeouts', async () => {
  const events = [{ type: 'response.reasoning_summary_text.delta', item_id: 'long', delta: '可'.repeat(9000) }];
  for (let i = 0; i < 110; i++) events.push({ type: 'response.reasoning_summary_text.delta', item_id: `r-${i}`, delta: '新摘要' });
  const h = await run([...events, answer]);
  assert.equal(h.latest('summary:long:0').text.length, 4000);
  assert.equal(h.activities.length, 100);
  assert.equal(h.output, answer.delta);
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval)\s*\(/);
});
