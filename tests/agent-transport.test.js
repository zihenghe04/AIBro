(async () => {
const assert = require('node:assert/strict');
globalThis.WorkstationCore = require('../app/workstation-core.js');
require('../app/agent-transport.js');

const events = [
  { type: 'response.reasoning_summary_text.delta', delta: '检查项目' },
  { type: 'response.output_text.delta', delta: '{"message":"' },
  { type: 'response.output_text.delta', delta: '已"}' },
  { type: 'response.completed' }
].map(event => `data: ${JSON.stringify(event)}\n\n`);
globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { events.forEach(event => controller.enqueue(new TextEncoder().encode(event))); controller.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const deltas = []; const phases = [];
const result = await globalThis.AgentTransport.requestPlan({ base: 'https://example.test/v1', model: 'demo', token: 'secret', input: 'hello', onDelta: value => deltas.push(value), onPhase: phase => phases.push(phase) });
assert.equal(result, '{"message":"已"}');
assert.deepEqual(deltas, ['{"message":"', '{"message":"已"}']);
assert.ok(phases.includes('reasoning') && phases.includes('output'));
console.log('agent transport tests passed');

})().catch(error => { console.error(error); process.exit(1); });
