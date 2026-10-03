const test = require('node:test');
const assert = require('node:assert/strict');
global.AgentProgress = require('../app/agent-progress');
const Conversation = require('../app/halaska-conversation');
global.RunCheckpoint = require('../app/run-checkpoint');
const savedReceipt = () => ({ version: 1, phase: 'committed', actionCount: 1, results: [{ type: 'note', id: 'saved-note', operation: 'created' }] });

test('saved summary requires an applied result in a valid committed receipt and a settled successful run', () => {
  for (const status of ['completed', 'completed-local', 'done']) {
    const props = Conversation.summaryProps({role:'agent'}, { status, executionReceipt: savedReceipt() });
    assert.equal(props.label, '结果已保存');
  }
  for (const receipt of [undefined, {...savedReceipt(),phase:'applied'}, {...savedReceipt(),phase:'prepared'}, {...savedReceipt(),version:2}]) {
    assert.notEqual(Conversation.summaryProps({role:'agent'}, { status:'completed', executionReceipt:receipt }).label, '结果已保存');
  }
  for (const status of ['running', 'failed', 'cancelled', 'awaiting-save', 'awaiting-approval']) {
    assert.notEqual(Conversation.summaryProps({role:'agent'}, { status, executionReceipt:savedReceipt() }).label, '结果已保存');
  }
  assert.notEqual(Conversation.summaryProps({role:'agent',live:true}, { status:'completed', executionReceipt:savedReceipt() }).label, '结果已保存');
});

test('saved direct answers and clarification replies remain completed without claiming an artifact', () => {
  for (const answer of ['这是一段普通回答。', '找不到笔记 noteId，请提供要整理的笔记。']) {
    const run = { status: 'completed', executionReceipt: { version: 1, phase: 'committed', actionCount: 0, results: [], answer },
      memoryNoteIds: ['automatic-project-diary'], toolCalls: [{ name: 'search_workspace', status: 'completed' }] };
    const message = { role: 'agent', text: answer, results: [{ type: 'note', id: 'message-chip', operation: 'created' }], clarify: { questions: [{ id: 'note' }] } };
    const before = JSON.stringify({ run, message });
    assert.equal(Conversation.summaryProps(message, run).label, '已完成');
    assert.equal(JSON.stringify({ run, message }), before, 'presentation never rewrites the run or clarification');
  }
});

test('matched records, pending drafts and proposals do not imply saved results', () => {
  for (const result of [{ type: 'note', id: 'existing', operation: 'matched' }, { type: 'note', id: 'draft', operation: 'drafted' },
    { type: 'schedule-proposal', id: 'proposal', operation: 'created' }]) {
    const run = { status: 'completed', executionReceipt: { ...savedReceipt(), results: [result] },
      localFileEdits: [{ id: 'edit', status: 'pending' }], scheduleProposal: { status: 'pending' } };
    assert.equal(Conversation.summaryProps({ role: 'agent' }, run).label, '已完成');
  }
  global.WorkstationI18n = { getLanguage: () => 'en' };
  try {
    assert.equal(Conversation.summaryProps({}, { status: 'completed', executionReceipt: { version: 1, phase: 'committed' } }).label, 'Completed');
    assert.equal(Conversation.summaryProps({}, { status: 'completed', executionReceipt: savedReceipt() }).label, 'Results saved');
  } finally { delete global.WorkstationI18n; }
});

test('lifecycle summary uses actual phase, latest public content and measured timestamps', () => {
  const message = { role: 'agent', live: true, at: 1000, activities: [
    { id: 'summary', kind: 'summary', text: '第一段\n完整公开摘要', status: 'completed', at: 1000 },
    { id: 'tool', kind: 'tool', name: '读取项目文件', text: '/notes/plan.md', status: 'running', at: 2000 },
  ] };
  const props = Conversation.summaryProps(message, { status: 'running', startedAt: 1000 });
  assert.equal(props.status, 'running'); assert.equal(props.phase, 'tool');
  assert.equal(props.detail, '读取项目文件'); assert.equal(props.count, '2 项活动');
  assert.equal(message.activities[0].text, '第一段\n完整公开摘要');
});

test('unknown history does not become completed and explicit failed/cancelled/approval states remain truthful', () => {
  for (const [status, label] of [['failed', '执行失败'], ['cancelled', '已停止'], ['awaiting-approval', '等待审批'], ['rejected', '已拒绝']]) {
    const props = Conversation.summaryProps({ role: 'agent', at: 2000 }, { status, startedAt: 2000, finishedAt: 62000 });
    assert.equal(props.label, label); assert.equal(props.detail, ''); assert.equal(props.elapsed, '1 分 0 秒');
  }
  const old = Conversation.summaryProps({ role: 'agent' });
  assert.equal(old.status, 'unknown'); assert.equal(old.label, '执行记录'); assert.equal(old.elapsed, '');
});

test('full last-line summary is retained rather than clipped at an arbitrary character count', () => {
  const line = '一段公开过程说明'.repeat(400);
  const props = Conversation.summaryProps({ live: true, activities: [{ id: 'one', kind: 'summary', text: '前文\n' + line, status: 'running' }] });
  assert.equal(props.detail, line); assert.equal(props.phase, 'thinking');
});

test('language selection uses current app locale and no event means waiting rather than fabricated activity', () => {
  global.WorkstationI18n = { getLanguage: () => 'en' };
  const props = Conversation.summaryProps({ live: true, activities: [] });
  assert.equal(props.label, 'Waiting'); assert.equal(props.count, '0 activities'); assert.equal(props.detail, '');
  delete global.WorkstationI18n;
});

test('continuous summaries count real flow entries once and prefer the current response over a stale reasoning phase', () => {
  global.ConversationFlow = require('../app/conversation-flow');
  global.ConversationProcess = require('../app/conversation-process');
  try {
    const message = { live: true, text: 'Answer surface', phase: 'reasoning', steps: [{ text: 'Old fixed stage' }] };
    const flow = ConversationFlow.create(message);
    flow.activity({ id: 'reason-1', attemptId: 'a1', kind: 'summary', text: 'Actual reasoning', status: 'completed' });
    const call = { id: 'call-1', type: 'read', status: 'completed', request: {} };
    flow.tool(call); flow.response('a2', 'Latest real response');
    const props = Conversation.summaryProps(message, { status: 'running', phase: 'reasoning', toolCalls: [call] });
    assert.equal(props.phase, 'writing'); assert.equal(props.count, '3 项过程'); assert.equal(props.detail, 'Latest real response');
    const reasoning = Conversation.activityProps({ kind: 'reasoning', text: 'Full text\nLatest line', status: 'running' }, message);
    assert.equal(reasoning.title, '模型思考'); assert.equal(reasoning.detail, 'Latest line');
  } finally { delete global.ConversationFlow; delete global.ConversationProcess; }
});
