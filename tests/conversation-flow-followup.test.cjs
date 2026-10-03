'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Flow = require('../app/conversation-flow.js'), Branches = require('../app/conversation-branches.js');
const Evidence = require('../app/citation-evidence.js');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
function fixture() {
  const answer = { id: 'a1', role: 'agent', text: 'Recorded final answer', runId: 'run-1',
    steps: [{ text: 'Recorded stage', status: 'done' }], activities: [], usage: { total: 12 } };
  const conversation = { id: 'original', workspace: '科研', title: 'Fictional branch test', messages: [
    { id: 'u1', role: 'user', text: 'First request' }, answer,
    { id: 'u2', role: 'user', text: 'Second request', attachmentIds: ['paper'] },
  ] };
  const run = { id: 'run-1', conversationId: conversation.id, status: 'completed',
    toolCalls: [{ id: 'read-1', type: 'read', status: 'completed', request: { id: 'paper' }, result: { text: 'Recorded tool result' } }] };
  const state = { conversations: [conversation], agentRuns: [run],
    imports: [{ id: 'paper', name: 'Fictional paper', content: 'Recorded source excerpt' }], notes: [], projects: [] };
  const captured = Evidence.capture(run, { type: 'import', id: 'paper', title: 'Fictional paper', excerpt: 'Recorded source excerpt' }, state);
  answer.text += ` [[cite:${captured.sourceId}]]`;
  const flow = Flow.create(answer);
  flow.activity({ id: 'reason-1', kind: 'summary', text: 'Prior recorded reasoning', status: 'completed' });
  flow.response('attempt-1', 'Prior intermediate reply', { status: 'completed' });
  flow.tool(run.toolCalls[0]); flow.response('attempt-2', answer.text, { status: 'completed' });
  const sends = [], calls = { save: 0 }, original = JSON.stringify([conversation, run]); let current = conversation;
  const { document } = parseHTML('<html><body></body></html>');
  const context = { state, window: {}, document, Date, console, uid: () => 'new-conversation',
    conversationPathSaving: () => false, currentConversation: () => current,
    save() { calls.save++; }, toast() {}, openConversation(id) { current = state.conversations.find(c => c.id === id); },
    sendMessage: async options => sends.push(options), WorkstationI18n: { getLanguage: () => 'zh' } };
  context.window = context; context.CitationEvidence = Evidence; context.ConversationFlow = Flow;
  vm.createContext(context);
  vm.runInContext(extract('function branchConversationFrom(', '\n\n// 会话内分支'), context);
  vm.runInContext(extract('async function editUserMessageAndResend(', '\nfunction openMessageEditor('), context);
  for (const file of ['agent-progress.js', 'conversation-process.js']) vm.runInContext(fs.readFileSync(require.resolve('../app/' + file), 'utf8'), context);
  return { context, document, answer, conversation, run, state, sends, calls, original, captured };
}
for (const mode of ['branch', 'edit-resend']) test(`${mode} copies final content and citation origin without the old process or tool ledger`, async () => {
  const f = fixture();
  const branch = mode === 'branch' ? f.context.branchConversationFrom('a1') : await f.context.editUserMessageAndResend('u2', 'Edited request');
  const copy = branch.messages.find(message => message.id === 'a1');
  assert.equal(copy.text, f.answer.text);
  for (const key of ['runId', 'pendingRunId', 'retryRunId', 'steps', 'activities', 'conversationFlow', 'usage']) assert.equal(copy[key], undefined, key);
  assert.equal(copy.citationOrigin.runId, f.run.id);
  assert.equal(Evidence.sourcesFor(copy, null, f.state)[0].sourceId, f.captured.sourceId);
  assert.equal(JSON.stringify([f.conversation, f.run]), f.original, 'original flow, ledger and source message are untouched');
  const wrapper = f.document.createElement('article');
  wrapper.innerHTML = f.context.AgentProgress.markup(copy);
  const body = f.document.createElement('div'); body.className = 'message-body'; body.textContent = copy.text; wrapper.append(body);
  f.context.ConversationProcess.compose(wrapper, copy, {});
  assert.equal(wrapper.querySelector('.agent-progress'), null);
  assert.equal(wrapper.querySelector('.conversation-flow-missing-tool'), null);
  assert.equal(wrapper.textContent, f.answer.text);
  if (mode === 'edit-resend') {
    assert.deepEqual(Array.from(branch.draftAttachmentIds), ['paper']);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].goal, 'Edited request'); assert.equal(f.sends[0].conversationId, branch.id);
  } else assert.equal(f.sends.length, 0);
});

test('same-conversation path switching retains the original flow and exact tool linkage through serialization', () => {
  const f = fixture(), fork = Branches.fork(f.conversation, 'a1', 'saved-original', 10);
  assert.equal(fork.error, undefined);
  let current = { ...f.conversation, messages: fork.keep, branches: [fork.branch], activeBranch: fork.activeBranch };
  current.messages.push({ id: 'u3', role: 'user', text: 'A separate continuation' });
  current = JSON.parse(JSON.stringify(current));
  const switched = Branches.switchTo(current, 'saved-original', 20);
  assert.equal(switched.error, undefined);
  const answer = switched.messages.find(message => message.id === 'a1');
  assert.deepEqual(answer.conversationFlow, f.answer.conversationFlow); assert.equal(answer.runId, f.run.id);
  assert.equal(Flow.entries(answer, f.run).find(item => item.kind === 'tool').call, f.run.toolCalls[0]);
  assert.equal(JSON.stringify([f.conversation, f.run]), f.original);
});
