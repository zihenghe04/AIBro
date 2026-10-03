'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const AgentContext = require('../app/agent-context'), AgentRouting = require('../app/agent-routing');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('    const buildRequestInput ='), end = source.indexOf('    const recoverInput=', start);
assert.ok(start > 0 && end > start);
const choice = source.split('\n').find(line => line.includes('const requestInput = route.compact ?'));
assert.ok(choice);
const factory = new Function('AgentContext', 'AgentRouting', 'onDemand', `
  const run={workspace:'科研',projectId:'p',userMessageId:'u',requestedAt:1791043200000},conversation={messages:[]};
  const window={AgentQueue:{injectionText:()=> 'QUEUE_CONTEXT'}};
  const instruction='FULL_RULES',context='FULL_CONTEXT',demandContext='DEMAND_CONTEXT';
  const projectMemoryContext=()=> 'CONFIRMED_MEMORY';
  let knowledgeEvidence='TOOL_EVIDENCE',knowledgeBlocks=[],citationManifest='CITATION_MANIFEST';
  const delivery={blocks:[]};
  const agentContext=onDemand?AgentContext.create({fullInstruction:instruction,workspace:run.workspace,projectId:run.projectId}):null;
  ${source.slice(start, end)}
  return {input:buildRequestInput,select:(route,goal)=>{${choice};return requestInput;},delivery,run};
`);
const marker = '工具阶段（含 knowledgeRequests）仍只返回一个 JSON 对象';
for (const onDemand of [false, true]) test(`actual ${onDemand ? 'on-demand' : 'full'} builder keeps optional public commentary separate from internal summaries`, () => {
  const h = factory(AgentContext, AgentRouting, onDemand), text = h.input('REPAIR_ADVICE');
  assert.equal(text.split(marker).length - 1, 1);
  assert.match(text, /可选填顶层 message/); assert.match(text, /第一个字段/);
  assert.match(text, /没有新增信息时可省略/); assert.match(text, /不要求每轮或每次工具调用都写/);
  assert.match(text, /workingSummary 仅供内部证据衔接，不对用户显示/);
  assert.match(text, /请求尚未返回真实回执时不得声称已读取、已执行、已保存或任务完成/);
  assert.ok(text.indexOf(marker) > text.indexOf('REPAIR_ADVICE'), 'same contract follows repair and evidence additions');
  assert.ok(text.includes(onDemand ? 'DEMAND_CONTEXT' : 'FULL_CONTEXT'));
  for (const item of ['CONFIRMED_MEMORY','TOOL_EVIDENCE','CITATION_MANIFEST','QUEUE_CONTEXT']) assert.ok(text.includes(item));
  h.delivery.blocks.push({ type: 'input_image', image_url: 'fixture:no-network' });
  const blocks = h.input('', [{ type: 'input_text', text: 'EXTRA_ATTACHMENT_CONTEXT' }]);
  assert.equal(blocks[0].content[0].text.split(marker).length - 1, 1);
  assert.equal(blocks[0].content[1].image_url, 'fixture:no-network');
  assert.equal(blocks[0].content[2].text, 'EXTRA_ATTACHMENT_CONTEXT');
});
test('actual host compact selection keeps its existing restricted protocol and escalation uses the common builder', () => {
  const h = factory(AgentContext, AgentRouting, true), route = { compact: true, mode: 'task-status', task: { id: 't', title: 'Fixture' }, status: 'done' };
  const compact = h.select(route, '将 Fixture 标为完成');
  assert.equal(compact, AgentRouting.prompt(route, { goal: '将 Fixture 标为完成', workspace: h.run.workspace, projectId: h.run.projectId,
    now: new Date(h.run.requestedAt).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, userMessageId: h.run.userMessageId }));
  assert.ok(!compact.includes(marker)); assert.match(compact, /needsFullContext/);
  assert.ok(h.select({ ...route, compact: false }, '核对资料').includes(marker));
});
