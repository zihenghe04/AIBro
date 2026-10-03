const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const installRunCheckpointHost = require('./helpers/run-checkpoint-host.cjs');
const Core = require('../app/workstation-core');
const KnowledgeAccess = require('../app/knowledge-access');
const AttachmentContext = require('../app/attachment-context');
const AttachmentDelivery = require('../app/attachment-delivery');
const AttachmentAnalysis = require('../app/attachment-analysis');
const ApprovalIntent = require('../app/approval-intent');
const TaskWorkflow = require('../app/task-workflow');
const RunOutcomePresentation = require('../app/run-outcome-presentation');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Host lifecycle extraction boundaries exist: ${start}`);
  return source.slice(from, to);
}
const requestSource = section('async function requestAgentPlan(', '\nasync function sendMessage(');
const finalizeSource = section('    const finalizePlan = async output => {', '\n    if (window.KnowledgeAccess)');
const assertActiveSource = section('function assertRunActive(', '\nlet activeRunController');
const inspectContext = vm.createContext({WorkstationCore: Core});
vm.runInContext(fs.readFileSync(require.resolve('../app/sse-frame-scanner'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../app/agent-transport.js'), 'utf8'), inspectContext);
const Transport = inspectContext.AgentTransport;
const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_page">\n<｜｜DSML｜｜ parameter name="id" string="true">fixture-pdf</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const plan = value => JSON.stringify(value);
const readPlan = requests => plan({knowledgeRequests: requests, actions: []});
const page = number => ({type: 'read_page', recordType: 'import', id: 'fixture-pdf', page: number});
const answer = text => plan({message: text, actions: []});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};

// Execute the real host request/validation closures, not a replacement plan
// loop. Only external model responses and read-only tool I/O are fixtures.
function harness(responses, options = {}) {
  const controller = new AbortController();
  const conversation = {id: 'conversation', projectId: 'project', workspace: '日常', messages: []};
  const run = {id: 'run', conversationId: conversation.id, projectId: 'project', workspace: '日常', status: 'running', pendingActions: [], results: []};
  const state = {projects: [{id: 'project', name: 'Fixture', workspace: '日常'}], conversations: [conversation], agentRuns: [run], notes: [], tasks: [], papers: [], imports: [], links: [], trash: []};
  const calls = [], stages = [], reads = [], batches = [], notifications = [], checkpoints = [], mapped = [], accepted = [];
  let knowledgeEvidence = '', knowledgeBlocks = [];
  const buildRequestInput = (extra = '') => [{role: 'user', content: [{type: 'input_text', text: '整理已有资料。' + extra + knowledgeEvidence}, ...knowledgeBlocks]}];
  const transport = {requestPlan: async request => {
    calls.push(request);
    assert.equal(request.requirePlanProtocol, true, 'Every host request retains strict plan protocol');
    assert.equal(request.model, 'fixture-model');
    assert.equal(request.effort, 'medium');
    assert.equal(request.signal, controller.signal);
    const next = responses[calls.length - 1];
    assert.notEqual(next, undefined, 'The host must not make an unplanned extra model request');
    if (typeof next === 'function') return next(request, calls.length);
    if (Object.prototype.toString.call(next) === '[object Error]') throw next;
    return next;
  }};
  const context = vm.createContext({
    Core, state, run, conversation, window: {}, AgentTransport: transport,
    activeRunController: controller, provider: 'api', base: 'https://fixture.invalid/v1',
    model: 'fixture-model', effort: 'medium', token: 'fixture-token', fileContext: {},
    // This extracted closure has no ProjectMemory host; model memory/recovery
    // behavior is exercised with the real host in project-memory-host.test.cjs.
    buildRequestInput, projectMemoryContext: () => '', recoverInput: async () => null, onDelta() {}, onActivity() {}, onSources() {}, onUsage() {}, onReception() {}, onAttempt() {},
    setPhase: phase => stages.push(phase), stage: text => stages.push(text), workspaceName: value => value,
    uid: prefix => prefix + '-fixture',
  });
  vm.runInContext(assertActiveSource + requestSource + '\nlet rawOutput = "", payload;\n' + finalizeSource + `
    globalThis.finalizeActual = finalizePlan;
    globalThis.getPayload = () => payload;
    globalThis.performRequest = () => requestAgentPlan({provider, base, model, effort, token,
      input: buildRequestInput(), signal: activeRunController.signal, onPhase: setPhase}, run);
  `, context);
  const execute = async request => {
    reads.push(structuredClone(request));
    if (options.execute) return options.execute(request);
    return {id: request.id, type: 'import', page: request.page, originalRead: true,
      text: `PAGE_${request.page}_EVIDENCE`, blocks: [{type: 'input_image', image_url: `data:image/png;base64,fixture-${request.page}`}]};
  };
  async function continueActual(initial) {
    return KnowledgeAccess.continuePlan(initial, {
      signal: controller.signal, parsePlan: Core.parsePlan,
      validate: () => context.assertRunActive(run), prepareFinal: options.prepareFinal,
      execute,
      batch: async requests => {batches.push(structuredClone(requests)); return Promise.all(requests.map(execute));},
      finalize: async output => {
        const repaired = await context.finalizeActual(output);
        if (repaired == null) accepted.push(structuredClone(context.getPayload()));
        return repaired;
      },
      onResult: (request, result) => notifications.push(structuredClone({request, result})),
      onCheckpoint: checkpoint => {checkpoints.push(structuredClone(checkpoint)); run.contextCheckpoint = checkpoint;},
      mapRetained: entries => {mapped.push(structuredClone(entries)); return entries;},
      ask: async (extra, blocks) => {
        knowledgeEvidence = extra; knowledgeBlocks = blocks;
        return context.performRequest();
      },
    });
  }
  return {state, run, conversation, controller, context, calls, stages, reads, batches, notifications, checkpoints, mapped, accepted,
    continue: continueActual,
    start: async () => continueActual(await context.performRequest()),
    request: () => context.performRequest(),
  };
}

test('a malformed final repaired into knowledgeRequests is read before a real answer is accepted', async () => {
  const h = harness([readPlan([page(4)]), answer('第 4 页介绍统计语言模型的条件概率分解。')]);
  const result = await h.continue('{"message":');
  assert.equal(h.calls.length, 2);
  assert.equal(h.run.formatRepairCount, 1);
  assert.match(h.run.validationErrors[0], /不完整/);
  assert.deepEqual(h.reads, [page(4)]);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].message, JSON.parse(result).message);
  assert.match(JSON.stringify(h.calls[1].input), /PAGE_4_EVIDENCE/);
  assert.equal(h.state.notes.length, 0, 'Reading and validating a reply does not save invented artifacts');
});

test('repair resumes the same read loop with images, citations view, ledger and default-equivalent request cache', async () => {
  const duplicate = {page: '1', id: 'fixture-pdf', recordType: 'import', type: 'read_page'};
  const h = harness(['{"message":', readPlan([duplicate, page(2)]), answer('根据第 1、2 页，材料从概述进入语言模型。')]);
  await h.continue(readPlan([page(1)]));
  assert.deepEqual(h.reads, [page(1), page(2)], 'Repair must not re-execute the already read page');
  assert.deepEqual(h.batches.map(batch => batch.length), [1, 1]);
  assert.equal(h.notifications.length, 2, 'A cached page does not add fake tool activity');
  assert.deepEqual(h.checkpoints.map(checkpoint => checkpoint.round), [1, 2]);
  assert.deepEqual(h.checkpoints.at(-1).ledger.map(entry => [entry.page, entry.readOrder, entry.evidenceIncluded]), [[1, 1, true], [2, 2, true]]);
  assert.equal(h.mapped.at(-1).length, 2, 'Both exact retained source views remain available to citation capture');
  for (const entry of h.mapped.at(-1)) assert.equal(entry.imagesIncluded, true);
  const finalContent = h.calls.at(-1).input[0].content;
  assert.deepEqual(finalContent.filter(block => block.type === 'input_image').map(block => block.image_url), ['data:image/png;base64,fixture-1', 'data:image/png;base64,fixture-2']);
  assert.match(finalContent[0].text, /PAGE_1_EVIDENCE/);
  assert.match(finalContent[0].text, /PAGE_2_EVIDENCE/);
  assert.match(h.calls[1].input[0].content[0].text, /PAGE_1_EVIDENCE/, 'The repair request itself retains the evidence already read');
});

test('repair cannot reset the repeated-read guard or invent a completed result', async () => {
  const repeated = readPlan([page(1)]);
  const h = harness(['{', repeated, repeated]);
  await assert.rejects(h.continue(repeated), {code: 'KNOWLEDGE_STALLED'});
  assert.equal(h.reads.length, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.accepted.length, 0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.run.contextCheckpoint.ledger.length, 1);
});

test('a repaired plan still loads missing capability constraints before final validation', async () => {
  let capabilityLoaded = false;
  const action = {type: 'create_knowledge_item', title: '材料摘要', content: '实际内容', workspace: '日常', projectId: 'project', sourceAttachmentIds: []};
  const final = plan({message: '', actions: [action]});
  const h = harness([final, final], {
    prepareFinal: value => value.actions?.length && !capabilityLoaded ? {knowledgeRequests: [{type: 'capabilities', name: 'knowledge'}]} : null,
    execute: async () => {capabilityLoaded = true; return {type: 'capabilities', name: 'knowledge', content: 'Reviewed action constraints'};},
  });
  await h.continue('{}');
  assert.deepEqual(h.reads, [{type: 'capabilities', name: 'knowledge'}]);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.run.pendingActions.length, 1);
  assert.equal(h.state.notes.length, 0, 'The host validation is a dry run; approval/execution remains downstream');
});

test('two empty final plans fail after one repair and never accept the old fake completion', async () => {
  const h = harness([answer('已完成整理。')]);
  await assert.rejects(h.continue('{"workingSummary":"已阅读全部资料","actions":[]}'), {code: 'EMPTY_AGENT_RESULT'});
  assert.equal(h.calls.length, 1);
  assert.equal(h.accepted.length, 0);
  assert.equal(h.run.formatRepairCount, 1);
  assert.deepEqual(h.run.pendingActions, []);
  assert.deepEqual(h.run.results, []);
});

test('a useful text answer and an explicit inability explanation remain valid without saved artifacts', async () => {
  for (const text of ['第 4 页讲解 n 元语言模型，核心是假设当前词只依赖最近若干词。', '资料没有提供该实验的结果，因此目前无法给出所要求的实验对比。']) {
    const h = harness([]);
    assert.equal(await h.continue(answer(text)), answer(text));
    assert.equal(h.accepted.length, 1);
    assert.equal(h.calls.length, 0);
  }
});

test('one DSML transport failure is repaired using the same input and then routed through ordinary read tools', async () => {
  const protocolFailure = Transport.protocolError(dsml);
  const h = harness([protocolFailure, readPlan([page(5)]), answer('第 5 页给出了模型估计方法。')]);
  await h.start();
  assert.equal(h.calls.length, 3);
  assert.equal(h.run.protocolRepair.code, 'MODEL_PROTOCOL_ERROR');
  assert.equal(h.run.formatRepairCount, 1);
  assert.deepEqual(h.reads, [page(5)]);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.calls[1].input.length, h.calls[0].input.length + 1);
  assert.equal(h.calls[1].input[0], h.calls[0].input[0], 'Protocol repair keeps the already constructed user/attachment input');
  assert.match(h.calls[1].input.at(-1).content[0].text, /knowledgeRequests/);
  assert.ok(!JSON.stringify(h.calls[1].input).includes(dsml), 'The private tool body is not replayed as executable instructions');
});

test('repeated DSML fails after one repair with no read or completion', async () => {
  const h = harness([Transport.protocolError(dsml), Transport.protocolError(dsml)]);
  await assert.rejects(h.start(), {code: 'MODEL_PROTOCOL_ERROR'});
  assert.equal(h.calls.length, 2);
  assert.equal(h.reads.length, 0);
  assert.equal(h.accepted.length, 0);
});

test('protocol and structural failures share one run-wide repair budget in both directions', async () => {
  const afterProtocol = harness([Transport.protocolError(dsml), '{}']);
  await assert.rejects(afterProtocol.start(), {code: 'EMPTY_AGENT_RESULT'});
  assert.equal(afterProtocol.calls.length, 2);
  assert.equal(afterProtocol.accepted.length, 0);
  const afterStructure = harness([Transport.protocolError(dsml)]);
  await assert.rejects(afterStructure.continue('{}'), {code: 'MODEL_PROTOCOL_ERROR'});
  assert.equal(afterStructure.calls.length, 1);
  assert.equal(afterStructure.accepted.length, 0);
});

test('cancellation during a protocol failure does not issue a repair request', async () => {
  const h = harness([async () => {h.controller.abort(); throw Transport.protocolError(dsml);}]);
  await assert.rejects(h.request(), {code: 'MODEL_PROTOCOL_ERROR'});
  assert.equal(h.calls.length, 1);
  assert.equal(h.run.formatRepairCount, undefined);
  assert.equal(h.reads.length, 0);
});

test('a late successful repair after cancellation cannot read or validate the proposed final output', async () => {
  const requested = deferred(), lateReply = deferred();
  const h = harness([async () => {requested.resolve(); return lateReply.promise;}]);
  const pending = h.continue('{}');
  await requested.promise;
  h.controller.abort();
  lateReply.resolve(readPlan([page(8)]));
  await assert.rejects(pending, {code: 'CANCELLED'});
  assert.equal(h.calls.length, 1);
  assert.equal(h.reads.length, 0);
  assert.equal(h.accepted.length, 0);
});

test('revoked run scope rejects before structural repair, preserving the original cancellation boundary', async () => {
  const h = harness([]);
  h.conversation.archived = true;
  await assert.rejects(h.continue('{}'), {code: 'CANCELLED'});
  assert.equal(h.calls.length, 0);
  assert.equal(h.run.formatRepairCount, undefined);
});

test('historical false completion is presented as an issue without rewriting saved messages, ledger, or run state', () => {
  const completed = Object.freeze({id: 'run-old', status: 'completed', pendingActions: Object.freeze([]), results: Object.freeze([]), validationErrors: Object.freeze(['模型返回的操作计划不完整']), contextCheckpoint: Object.freeze({round: 12})});
  const empty = Object.freeze({role: 'agent', id: 'message-old', runId: completed.id, text: '已完成整理。'});
  const leaked = Object.freeze({...empty, text: dsml});
  const before = JSON.stringify({completed, empty, leaked});
  assert.equal(Core.responseIssue(empty, completed, null).code, 'EMPTY_AGENT_RESULT');
  assert.equal(Core.responseIssue(leaked, completed, Transport.inspectProtocolOutput(leaked.text)).code, 'MODEL_PROTOCOL_ERROR');
  assert.equal(JSON.stringify({completed, empty, leaked}), before);
  assert.equal(completed.status, 'completed', 'Historical failure is derived for rendering; persistence is not silently edited');
});

test('ordinary user quotations, live replies, failures, saved artifacts and substantive historical answers are not relabeled', () => {
  const completed = {status: 'completed', pendingActions: [], results: [], validationErrors: ['old validation issue']};
  const empty = {role: 'agent', text: '已完成整理。'};
  assert.equal(Core.responseIssue({...empty, role: 'user', text: dsml}, completed, Transport.inspectProtocolOutput(dsml)), null);
  assert.equal(Core.responseIssue({...empty, live: true}, completed, {kind: 'dsml'}), null);
  assert.equal(Core.responseIssue(empty, {...completed, status: 'failed'}, {kind: 'dsml'}), null);
  assert.equal(Core.responseIssue(empty, {...completed, results: [{type: 'note', id: 'saved'}]}, null), null);
  assert.equal(Core.responseIssue({...empty, text: '内容摘要：本讲介绍统计语言模型。'}, completed, null), null);
  assert.equal(Core.responseIssue({role: 'agent', text: '以下是 DSML 示例：\n```text\n' + dsml + '\n```'}, completed, Transport.inspectProtocolOutput('以下是 DSML 示例：\n```text\n' + dsml + '\n```')), null);
});

// These end-to-end host cases exercise the actual settlement/catch path too:
// a valid-looking recovery must not leave run.status or the message as done.
function sendHarness(responses) {
  const nodes = new Map(), calls = [], toasts = [];
  let serial = 0, commits = 0;
  const element = key => {
    if (!nodes.has(key)) nodes.set(key, {value: '', textContent: '', disabled: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: {add() {}, remove() {}}, setAttribute() {}, querySelector() {return null;}, appendChild() {}, firstElementChild: {}});
    return nodes.get(key);
  };
  const state = {projects: [{id: 'project', name: 'Fixture', workspace: '日常'}], tasks: [], notes: [{id: 'source-note', title: '材料', content: 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST', projectId: 'project', workspace: '日常'}],
    papers: [], imports: [], links: [], trash: [], agentRuns: [], conversations: [{id: 'conversation', title: 'Fixture', workspace: '日常', projectId: 'project', messages: [], attachments: []}],
    currentConversationId: 'conversation', settings: {permissions: {'日常': 'auto'}}};
  const models = {configuration: () => ({provider: 'api', model: 'fixture-model', effort: 'medium'}), resolve: async value => value};
  const context = vm.createContext({structuredClone, state, Core, KnowledgeAccess, AttachmentContext, AttachmentDelivery, AttachmentAnalysis,
    $: element, window: {ConversationModels: models, AttachmentAnalysis, ApprovalIntent, TaskWorkflow, KnowledgeAccess, RunOutcomePresentation, AgentTransport: Transport}, ConversationModels: models,
    localStorage: {getItem: () => ''}, document: {createElement: () => element('holder')}, AbortController, URL, setTimeout, clearTimeout,
    uid: prefix => prefix + '-' + ++serial, workspaceName: value => value || '日常', classifyWorkspace: () => '日常', currentConversation: () => state.conversations.find(item => item.id === state.currentConversationId),
    currentAttachments: () => [], projectIsActive: id => state.projects.some(project => project.id === id && !project.archived),
    defaultModelConfiguration: () => ({provider: 'api', model: 'fixture-model', effort: 'medium'}), normalizeStateShape() {}, save() {}, renderAll() {}, renderConversation() {}, renderMessage() {}, renderRunStatus() {}, toast: message => toasts.push(String(message)),
    visiblePaper: () => true, visibleNote: () => true, actionSummary: () => '待批准的动作', addRunStep: (run, text, status) => run.steps.push({text, status}),
    AgentTransport: {requestPlan: async request => {
      calls.push(request); assert.equal(request.requirePlanProtocol, true);
      const response = responses[calls.length - 1]; assert.notEqual(response, undefined);
      if (typeof response === 'function') return response(request);
      if (Object.prototype.toString.call(response) === '[object Error]') throw response;
      return response;
    }}, activeRunController: null, liveRenderTimer: null,
  });
  element('#agentInput').value = '阅读资料并展示实际总结'; element('#apiBase').value = 'https://fixture.invalid/v1'; element('#apiKey').value = 'fixture-key';
  vm.runInContext([
    section('function activeResultRecord(', '\nfunction conversationProjectIds('),
    section('function dedupeResultEntries(', '\nfunction groupedEntities('),
    section('function commitAttachmentAnalysis(', '\nfunction executeActions('),
    section('function executeActions(', '\nfunction fallbackWorkflow('),
    section('function actionsNeedApproval(', '\nfunction actionSummary('),
    assertActiveSource, section('function apiOrigin(', '\nfunction renderSettings('), requestSource,
    section('async function sendMessage(', '\n\nfunction formatBytes('),
  ].join('\n'), context);
  const checkpoint = installRunCheckpointHost(context);
  const executeActions = context.executeActions;
  context.executeActions = (...args) => {commits++; return executeActions(...args);};
  return {state, calls, toasts, context, checkpoint, send: options => context.sendMessage(options), get commits() {return commits;}, get run() {return state.agentRuns[0];}, get reply() {return state.conversations[0].messages.at(-1);}};
}

test('actual send freezes PDF mode before async preparation; subsequent composer changes do not alter the run', async () => {
  const h = sendHarness([answer('The source states that saved output must retain its origin.')]);
  const conversation = h.state.conversations[0]; conversation.pdfReadMode = 'text';
  h.context.ConversationModels.resolve = async config => { conversation.pdfReadMode = 'original'; return config; };
  await h.send();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.run.pdfReadMode, 'text');
  assert.equal(conversation.messages[0].pdfReadMode, 'text');
  assert.equal(conversation.pdfReadMode, 'original');
  assert.equal(h.run.attachmentDelivery.pdfReadMode, 'text');
});

test('actual send reads an explicitly named course from daily scope, including an original /plan request', async () => {
  for (const prefix of ['', '/plan ']) {
    const h=sendHarness([readPlan([{type:'read',recordType:'note',id:'course-note'}]), answer('依据课程第一讲原文，建议在观察记录后补充验证问题。')]);
    h.state.projects.push({id:'course',name:'交互设计方法',workspace:'课程'});
    h.state.notes.push({id:'course-note',title:'第一讲',content:'ACTUAL_CROSS_SPACE_SOURCE',projectId:'course',workspace:'课程'});
    h.context.window.ContextRetrieval=h.context.ContextRetrieval=require('../app/context-retrieval');
    h.context.window.ModeHint=require('../app/mode-hint');
    h.context.$('#agentInput').value=prefix+'请读取课程项目“交互设计方法”中的第一讲。';
    await h.send();
    assert.equal(h.run.status,'completed');
    assert.ok(h.run.noteContextIds.includes('course-note'));
    assert.match(JSON.stringify(h.calls[1].input),/ACTUAL_CROSS_SPACE_SOURCE/);
    assert.ok(h.run.steps.some(step=>step.text==='回复已保存'));
    assert.ok(!h.run.steps.some(step=>step.text==='结果已确认保存'));
    assert.ok(!Object.hasOwn(h.run,'readProjects'));
  }
});

test('actual send cancels when its explicitly authorized target becomes private before tools run', async () => {
  const h=sendHarness([()=>{h.state.projects[1].private=true;return readPlan([{type:'read',id:'course-note'}]);}]);
  h.state.projects.push({id:'course',name:'交互设计方法',workspace:'课程'});
  h.state.notes.push({id:'course-note',title:'第一讲',content:'PRIVATE_AFTER_DISPATCH',projectId:'course',workspace:'课程'});
  h.context.window.ContextRetrieval=h.context.ContextRetrieval=require('../app/context-retrieval');
  h.context.$('#agentInput').value='请读取课程项目“交互设计方法”中的第一讲。';
  await h.send();
  assert.notEqual(h.run.status,'completed');assert.equal(h.calls.length,1);
  assert.ok(!h.run.noteContextIds.includes('course-note'));
  assert.match(h.run.error,/明确指定的项目已变化或不可访问/);
});

for (const boundary of ['wiki', 'draft-command']) test(`actual foreground send retains both drafts when navigation happens during ${boundary} preparation`, async () => {
  const h = sendHarness([]), original = h.state.conversations[0], gate = deferred(), entered = deferred();
  original.pdfReadMode = 'text'; original.draft = '原会话尚未发送的请求'; original.draftAttachmentIds = ['original-file'];
  const other = {id:'other-conversation', title:'Other', workspace:'日常', projectId:'project', pdfReadMode:'original', messages:[], draft:'另一会话尚未发送的请求', draftAttachmentIds:['other-file']};
  h.state.conversations.push(other);
  const input = h.context.$('#agentInput'); input.value = original.draft;
  const wait = async () => { entered.resolve(); await gate.promise; return false; };
  if (boundary === 'wiki') { h.state._wikiEnabled = true; h.context.refreshWikiVault = wait; }
  else { h.context.window.DraftReview = {}; h.context.handleDraftCommand = wait; }
  const before = structuredClone(h.state.conversations), pending = h.send();
  await entered.promise;
  h.state.currentConversationId = other.id; input.value = other.draft;
  gate.resolve(); await pending;
  assert.deepEqual(h.state.conversations, before, 'Neither conversation message, draft, attachment or PDF mode is consumed');
  assert.equal(input.value, other.draft); assert.equal(h.state.agentRuns.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.context.sendMessage.preflight, null); assert.match(h.toasts.join(' '), /已切换对话/);
});

test('explicit background sends retain their original conversation and PDF mode across foreground navigation', async () => {
  const h = sendHarness([answer('后台读取已提供资料，保留原会话的 PDF 读取方式。')]), original = h.state.conversations[0];
  original.pdfReadMode = 'text';
  const other = {id:'other-conversation', title:'Other', workspace:'日常', projectId:'project', pdfReadMode:'original', messages:[], draft:'另一会话草稿'};
  h.state.conversations.push(other); h.state._wikiEnabled = true;
  h.context.refreshWikiVault = async () => { h.state.currentConversationId = other.id; h.context.$('#agentInput').value = other.draft; };
  await h.send({background:true, conversationId:original.id, goal:'后台整理指定资料'});
  assert.equal(h.run.status, 'completed', h.run.error); assert.equal(h.run.conversationId, original.id); assert.equal(h.run.pdfReadMode, 'text');
  assert.equal(other.messages.length, 0); assert.equal(h.context.$('#agentInput').value, other.draft);
});

test('actual retry retains the original PDF mode unless this retry explicitly changes it', async () => {
  const h = sendHarness([Object.assign(Error('fixture unavailable'), {code:'NETWORK_ERROR'}), answer('Text-only follow-up retains the original source boundaries.')]);
  const conversation = h.state.conversations[0]; conversation.pdfReadMode = 'text';
  await h.send(); assert.equal(h.run.status, 'failed');
  conversation.pdfReadMode = 'original';
  await h.send({retry:true, conversationId:conversation.id, userMessageId:h.run.userMessageId, goal:h.run.goal, attachmentIds:[]});
  assert.equal(h.state.agentRuns.at(-1).status, 'completed');
  assert.equal(h.state.agentRuns.at(-1).pdfReadMode, 'text');
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1);
});

test('explicit retry preserves its original turn while the user navigates to another conversation during preparation', async () => {
  const h = sendHarness([Object.assign(Error('fixture unavailable'), {code:'NETWORK_ERROR'}), answer('本轮重试保留原请求和 PDF 文字读取方式。')]);
  const conversation = h.state.conversations[0]; conversation.pdfReadMode = 'text';
  await h.send(); assert.equal(h.run.status, 'failed');
  const other = {id:'retry-other', title:'Other', workspace:'日常', projectId:'project', pdfReadMode:'original', messages:[], draft:'保留我的草稿'};
  h.state.conversations.push(other); h.state._wikiEnabled = true;
  h.context.refreshWikiVault = async () => { h.state.currentConversationId = other.id; h.context.$('#agentInput').value = other.draft; };
  await h.send({retry:true, conversationId:conversation.id, userMessageId:h.run.userMessageId, goal:h.run.goal, attachmentIds:[]});
  const retry = h.state.agentRuns.at(-1);
  assert.equal(retry.status, 'completed', retry.error); assert.equal(retry.conversationId, conversation.id); assert.equal(retry.pdfReadMode, 'text');
  assert.equal(other.messages.length, 0); assert.equal(h.context.$('#agentInput').value, other.draft);
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1);
});

test('invalid PDF mode cannot consume a draft or start model execution', async () => {
  const h = sendHarness([]);
  await h.send({pdfReadMode:'automatic'});
  assert.equal(h.state.agentRuns.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.state.conversations[0].messages.length, 0);
  assert.match(h.toasts.join(' '), /PDF/);
});

test('actual sendMessage completes only after repaired read requests return evidence and a substantive final message', async () => {
  const h = sendHarness(['{"message":', readPlan([{type: 'read', id: 'source-note'}]), answer('材料明确记录了 SOURCE_EVIDENCE_FOR_ACTUAL_HOST，以上为本次实际整理结果。')]);
  await h.send();
  assert.equal(h.run.status, 'completed', h.run.error);
  assert.equal(h.calls.length, 3);
  assert.equal(h.run.knowledgeReads.length, 1);
  assert.equal(h.run.contextCheckpoint.ledger.length, 1);
  assert.equal(h.reply.runStatus, 'completed');
  assert.match(h.reply.text, /本次实际整理结果/);
  assert.match(JSON.stringify(h.calls[2].input), /SOURCE_EVIDENCE_FOR_ACTUAL_HOST/);
  assert.equal(h.state.notes.length, 1, 'The original source note is untouched');
});

test('actual sendMessage records EMPTY_AGENT_RESULT as failed and never commits or marks an empty reply completed', async () => {
  const h = sendHarness(['{}', answer('已完成整理。')]);
  await h.send();
  assert.equal(h.run.status, 'failed', h.run.error);
  assert.equal(h.run.errorCode, 'EMPTY_AGENT_RESULT');
  assert.equal(h.reply.runStatus, 'failed');
  assert.equal(h.reply.retryRunId, h.run.id);
  assert.equal(h.reply.text, '', 'No fake result or duplicate generated error in the answer');
  assert.match(h.run.error, /没有返回可查看的回答或产出/);
  assert.match(RunOutcomePresentation.present(h.reply, h.run).noticeDescription, /没有返回可查看的回答或产出/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.commits, 0);
  assert.equal(h.state.notes.length, 1);
});

const analysisNotePlan = (content, type = 'create_knowledge_item', extra = {}) => plan({
  message: '已完成整理。', actions: [{type, title: '材料分析', workspace: '日常', projectId: 'project', sourceAttachmentIds: [], ...(content === undefined ? {} : {content}), ...extra}],
});

test('actual analysis completion rejects empty and placeholder notes before checkpoint or any mutation', async t => {
  for (const type of ['create_knowledge_item', 'create_note']) for (const content of [undefined, '', ' \n\t', '# 材料分析', '# 材料分析\n\n待补充', '<!-- analysis pending -->', '---\ntitle: 材料分析\n---\n', '+++\ntitle = "材料分析"\n+++\n', '已完成整理。']) {
    await t.test(`${type}: ${JSON.stringify(content)}`, async () => {
      const response = analysisNotePlan(content, type), h = sendHarness([response, response]);
      h.context.$('#agentInput').value = '整理这份资料并保存分析笔记';
      const before = structuredClone(h.state.notes);
      await h.send();
      assert.equal(h.run.status, 'failed', h.run.error);
      assert.equal(h.run.errorCode, 'INCOMPLETE_ANALYSIS_RESULT');
      assert.equal(h.calls.length, 2, 'One existing plan repair is allowed');
      assert.equal(h.commits, 0); assert.equal(h.checkpoint.snapshots.length, 0);
      assert.deepEqual(h.state.notes, before);
      assert.equal(h.reply.text, '', 'A rejected completion claim is not retained as a successful partial answer');
    });
  }
});

test('actual invalid analysis note rejects the whole mixed plan before a valid sibling or task is saved', async () => {
  const response = plan({message: '已完成资料整理，笔记已保存。', actions: [
    {type: 'create_task', title: '后续阅读', workspace: '日常', projectId: 'project'},
    {type: 'create_note', title: '有效分析', content: '统计语言模型用上下文的条件概率估计下一个词。', workspace: '日常', projectId: 'project'},
    {type: 'create_note', title: '遗漏的一份资料', content: '# 待整理\n\nTODO', workspace: '日常', projectId: 'project'},
  ]});
  const h = sendHarness([response, response]);
  h.context.$('#agentInput').value = '整理资料并保存每份分析笔记';
  await h.send();
  assert.equal(h.run.errorCode, 'INCOMPLETE_ANALYSIS_RESULT');
  assert.equal(h.commits, 0); assert.equal(h.checkpoint.snapshots.length, 0);
  assert.equal(h.state.notes.length, 1); assert.equal(h.state.tasks.length, 0);
  assert.equal(h.reply.text, '');
});

test('actual analysis completion cannot count an unchanged matched note or pending draft as a newly saved analysis', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'drafted' : 'matched', async () => {
    const response = analysisNotePlan(pending ? '不同的新分析正文，仍然需要用户审阅。' : 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST', 'create_note', {title: '材料'});
    const h = sendHarness([response, response]);
    h.context.$('#agentInput').value = '整理资料并保存分析笔记';
    if (pending) h.state.notes[0].userEdited = true;
    const before = structuredClone(h.state.notes);
    await h.send();
    assert.equal(h.run.errorCode, 'INCOMPLETE_ANALYSIS_RESULT');
    assert.equal(h.commits, 0); assert.deepEqual(h.state.notes, before);
  });
});

test('actual substantive analysis repair saves only the repaired body, while explicit blank-note creation remains allowed', async () => {
  const good = analysisNotePlan('统计语言模型用上下文的条件概率估计下一个词，平滑处理解决未见组合。');
  const h = sendHarness([analysisNotePlan(''), good]);
  h.context.$('#agentInput').value = '整理资料并保存分析笔记';
  await h.send();
  assert.equal(h.run.status, 'completed', h.run.error);
  assert.equal(h.commits, 1); assert.equal(h.state.notes.length, 2);
  assert.match(h.state.notes[1].content, /条件概率/);
  assert.equal(h.checkpoint.snapshots.filter(snapshot => snapshot.agentRuns[0].executionReceipt.phase === 'prepared').length, 1);

  const blank = sendHarness([analysisNotePlan('')]);
  blank.context.$('#agentInput').value = '创建一个空白分析笔记，正文留空，稍后我自己填写';
  await blank.send();
  assert.equal(blank.run.status, 'completed', blank.run.error);
  assert.equal(blank.state.notes.at(-1).content, '');
});

test('actual material question needs no saved note, while a useful answer cannot smuggle an empty note into storage', async () => {
  const text = '根据资料，统计语言模型以条件概率分解句子概率。平滑处理为未见词组保留概率质量。';
  const question = sendHarness([answer('已完成整理。\n\n' + text)]);
  question.context.$('#agentInput').value = '整理一下资料中的关键概念，在对话回答即可';
  await question.send();
  assert.equal(question.run.status, 'completed', question.run.error);
  assert.equal(question.state.notes.length, 1);

  const empty = JSON.parse(analysisNotePlan('')); empty.message = text;
  const h = sendHarness([plan(empty), plan(empty)]);
  h.context.$('#agentInput').value = '整理资料并保存分析笔记';
  await h.send();
  assert.equal(h.run.errorCode, 'INCOMPLETE_ANALYSIS_RESULT');
  assert.equal(h.state.notes.length, 1); assert.equal(h.commits, 0);
  assert.equal(h.reply.text, text, 'The actual partial answer remains useful despite its rejected note proposal');
});

test('actual useful matched and review drafts retain their distinct result operations, and blank templates stay valid', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'explicit pending review' : 'explicit retained note', async () => {
    const value = JSON.parse(analysisNotePlan(pending ? '新的研究分析表明，语言模型依赖上下文条件概率。' : 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST', 'create_note', {title: '材料'}));
    value.message = pending ? '已完成整理，修改作为待审阅草稿，请审阅后保存。' : '已完成整理，保留已有分析笔记，本轮未修改正文。';
    const h = sendHarness([plan(value)]);
    h.context.$('#agentInput').value = '整理资料并保存分析笔记';
    if (pending) h.state.notes[0].userEdited = true;
    await h.send();
    assert.equal(h.run.status, 'completed', h.run.error);
    assert.equal(h.run.results.find(row => row.type === 'note').operation, pending ? 'drafted' : 'matched');
    assert.equal(h.state.notes[0].content, 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST');
  });
  const template = sendHarness([analysisNotePlan('# 概述\n\n## 分析\n\n<!-- 稍后填写 -->')]);
  template.context.$('#agentInput').value = '新建一个资料分析模板，只保留标题，正文留空';
  await template.send();
  assert.equal(template.run.status, 'completed', template.run.error);
  assert.equal(template.state.notes.length, 2);
});

test('actual paper analysis cannot count generated metadata and source links as a body, but real section text is saved', async () => {
  const paper = text => plan({workspace: '科研', message: '已完成分析。', actions: [{type: 'upsert_paper', title: '论文分析夹具', workspace: '科研', projectId: null, sourceAttachmentIds: ['source-pdf'], structured: {methods: {text, citations: [], verified: false}}}]});
  const h = sendHarness([paper('待补充'), paper('方法将句子的联合概率分解为逐词的条件概率，并使用有限上下文进行估计。')]);
  h.context.$('#agentInput').value = '分析论文资料并保存分析笔记';
  h.state.imports.push({id: 'source-pdf', name: '材料.pdf', workspace: '科研', content: '原始材料正文', analysis: {status: 'pending'}});
  await h.send();
  assert.equal(h.run.status, 'completed', h.run.error);
  assert.equal(h.calls.length, 2); assert.equal(h.commits, 1);
  assert.match(h.state.papers[0].structured.methods.text, /条件概率/);
  assert.match(h.state.notes.find(note => note.paperId).content, /条件概率/);
});

test('actual template creation with requested analysis content does not bypass integrity checks', async () => {
  for (const goal of ['新建分析报告模板并根据附件填充正文', '创建空白分析报告，再根据资料填入分析内容', 'Create a blank analysis note and populate it from the material']) {
    const empty = analysisNotePlan('# 分析报告\n\n待补充'), h = sendHarness([empty, empty]);
    h.context.$('#agentInput').value = goal;
    await h.send();
    assert.equal(h.run.errorCode, 'INCOMPLETE_ANALYSIS_RESULT', goal);
    assert.equal(h.commits, 0); assert.equal(h.state.notes.length, 1);
  }
});

test('actual English analysis keeps meaningful existing and pending-review results without claiming a new saved body', async () => {
  for (const pending of [false, true]) {
    const value = JSON.parse(analysisNotePlan(pending ? 'The analysis models sentence probability as a product of conditional word probabilities.' : 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST', 'create_note', {title: '材料'}));
    value.message = pending ? 'Analysis complete; the draft awaits review and is not saved.' : 'Analysis complete; retained the existing note without changes.';
    const h = sendHarness([plan(value)]);
    h.context.$('#agentInput').value = 'Analyze the source material and save an analysis note';
    if (pending) h.state.notes[0].userEdited = true;
    await h.send();
    assert.equal(h.run.status, 'completed', h.run.error);
    assert.equal(h.run.results.find(row => row.type === 'note').operation, pending ? 'drafted' : 'matched');
    assert.equal(h.state.notes[0].content, 'SOURCE_EVIDENCE_FOR_ACTUAL_HOST');
  }
});

test('actual sendMessage treats repeated DSML as failed with no tool execution or private protocol in its reply', async () => {
  const h = sendHarness([Transport.protocolError(dsml), Transport.protocolError(dsml)]);
  await h.send();
  assert.equal(h.run.status, 'failed', h.run.error);
  assert.equal(h.run.errorCode, 'MODEL_PROTOCOL_ERROR', h.run.error);
  assert.equal(h.reply.runStatus, 'failed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.commits, 0);
  assert.equal(h.run.knowledgeReads?.length || 0, 0);
  assert.ok(!h.reply.text.includes('<｜｜DSML｜｜'));
});


test('actual streaming cancellation preserves received public answer separately from the error and commits no actions', async () => {
  const partial = '已核对的内容：统计语言模型使用条件概率分解。\n下一节';
  const h = sendHarness([request => {
    request.onDelta(JSON.stringify({message: partial, actions: []}).slice(0, -16));
    request.onDelta('{"message":' + JSON.stringify(partial).slice(0, -1));
    const stopped = new Error('已停止本次执行'); stopped.code = 'CANCELLED'; throw stopped;
  }]);
  await h.send();
  assert.equal(h.run.status, 'cancelled'); assert.equal(h.reply.text, partial);
  assert.equal(h.reply.planPreview, false); assert.equal(h.commits, 0);
  const notice = RunOutcomePresentation.present(h.reply, h.run);
  assert.equal(notice.answerText, partial); assert.equal(notice.noticeDescription, '');
  assert.equal(notice.noticeTitle, '本次执行已停止');
});

test('actual streaming failure cannot publish nested internal message fields as a partial answer', async () => {
  const h = sendHarness([request => {
    request.onDelta('{"knowledgeRequests":[{"message":"INTERNAL_TOOL_PARAMETER","type":"read"');
    const stopped = new Error('已停止本次执行'); stopped.code = 'CANCELLED'; throw stopped;
  }]);
  await h.send();
  assert.equal(h.run.status, 'cancelled'); assert.equal(h.reply.text, '');
  assert.equal(h.commits, 0); assert.equal(h.reply.retryRunId, h.run.id);
});

const durableTaskPlan = () => plan({workspace: '日常', message: '已创建可查看的整理任务。', actions: [{type: 'create_task', title: 'Durable fixture task', projectId: 'project', workspace: '日常', sourceAttachmentIds: []}]});

test('actual automatic host saves the plan before effects and waits for the applied snapshot acknowledgement', async () => {
  const prepared = deferred(), applied = deferred(), releasePrepared = deferred(), releaseApplied = deferred();
  const h = sendHarness([durableTaskPlan()]);
  h.checkpoint.setPersist(snapshot => {
    if (snapshot.agentRuns[0].executionReceipt.phase === 'prepared') { prepared.resolve(); return releasePrepared.promise; }
    applied.resolve(); return releaseApplied.promise;
  });
  const sending = h.send();
  await Promise.race([prepared.promise, sending.then(() => assert.fail('Send stopped before prepared checkpoint: ' + h.run.error))]);
  assert.equal(h.commits, 0); assert.equal(h.state.tasks.length, 0);
  assert.equal(h.checkpoint.snapshots[0].agentRuns[0].executionReceipt.actions[0].title, 'Durable fixture task');
  releasePrepared.resolve(true);
  await Promise.race([applied.promise, sending.then(() => assert.fail('Send stopped before applied checkpoint: ' + h.run.error))]);
  assert.equal(h.commits, 1); assert.equal(h.state.tasks.length, 1);
  assert.equal(h.run.status, 'awaiting-save'); assert.notEqual(h.reply.runStatus, 'completed');
  const snapshot = h.checkpoint.snapshots[1];
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.agentRuns[0].executionReceipt.phase, 'applied');
  assert.deepEqual(snapshot.agentRuns[0].results, snapshot.agentRuns[0].executionReceipt.results);
  releaseApplied.resolve(true); await sending;
  assert.equal(h.run.status, 'completed'); assert.equal(h.run.executionReceipt.phase, 'committed');
  assert.equal(h.reply.pendingRunId, null); assert.equal(h.calls.length, 1); assert.equal(h.commits, 1);
});

test('actual automatic host keeps a failed preparation save effect-free and explicit continuation uses the saved plan', async () => {
  const h = sendHarness([durableTaskPlan()]);
  h.checkpoint.setPersist(() => { throw new Error('fixture preparation storage failure'); });
  await h.send();
  assert.equal(h.run.status, 'interrupted'); assert.equal(h.run.executionReceipt.phase, 'prepared');
  assert.equal(h.commits, 0); assert.equal(h.state.tasks.length, 0); assert.equal(h.reply.retryRunId, undefined);
  assert.match(h.toasts.at(-1), /preparation storage failure/);
  h.checkpoint.setPersist(() => true);
  await h.context.runCheckpoints().continue(h.run.id);
  assert.equal(h.run.status, 'completed'); assert.equal(h.state.tasks.length, 1);
  assert.equal(h.commits, 1); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.checkpoint.snapshots.map(snapshot => snapshot.agentRuns[0].executionReceipt.phase), ['prepared', 'prepared', 'applied']);
});

test('actual automatic host retries only persistence after effects were applied and never repeats the model or Core commit', async () => {
  const h = sendHarness([durableTaskPlan()]);
  h.checkpoint.setPersist(snapshot => {
    if (snapshot.agentRuns[0].executionReceipt.phase === 'applied') throw new Error('fixture applied acknowledgement lost');
    return true;
  });
  await h.send();
  assert.equal(h.run.status, 'awaiting-save'); assert.equal(h.run.executionReceipt.phase, 'applied');
  assert.equal(h.state.tasks.length, 1); assert.equal(h.commits, 1); assert.equal(h.reply.retryRunId, undefined);
  const taskId = h.state.tasks[0].id;
  h.checkpoint.setPersist(() => true);
  await h.context.runCheckpoints().save(h.run.id);
  assert.equal(h.run.status, 'completed'); assert.equal(h.reply.runStatus, 'completed');
  assert.equal(h.state.tasks.length, 1); assert.equal(h.state.tasks[0].id, taskId);
  assert.equal(h.commits, 1); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.checkpoint.snapshots.map(snapshot => snapshot.agentRuns[0].executionReceipt.phase), ['prepared', 'applied', 'applied']);
});


// Public stream callbacks are fixture I/O; sendMessage, tool execution ordering,
// safe JSON projection and checkpoint persistence below are production code.
function enableConversationFlow(h) {
  for (const [name, file] of [['ConversationFlow','conversation-flow'],['ToolScheduler','tool-scheduler'],['ResearchDelegation','research-delegation']])
    h.context[name] = h.context.window[name] = require('../app/' + file);
}
function flowReply(id, value, reasoning) {
  return request => {
    request.onAttempt?.({id, status:'running'});
    if (reasoning) request.onActivity?.({id:'reasoning:' + id,attemptId:id,kind:'summary',text:reasoning,status:'running'});
    const output=JSON.stringify(value);
    request.onDelta?.(output.slice(0,Math.floor(output.length/2)), '', {attemptId:id});
    request.onDelta?.(output, '', {attemptId:id});
    request.onAttempt?.({id,status:'completed'});
    return output;
  };
}

test('actual conversation flow retains intermediate answer and tool receipt before final answer, saved once per segment', async()=>{
  const first='我先读取这份材料，再核对正文。',final='原文指出：SOURCE_EVIDENCE_FOR_ACTUAL_HOST。';
  const h=sendHarness([
    flowReply('round-1',{message:first,knowledgeRequests:[{type:'read',recordType:'note',id:'source-note'}],actions:[]},'先核对提供资料。'),
    flowReply('round-2',{message:final,actions:[]},'结合刚才读取的内容回答。')
  ]);enableConversationFlow(h);await h.send();
  assert.equal(h.run.status,'completed',h.run.error);
  const items=h.reply.conversationFlow.items;
  assert.deepEqual(Array.from(items,item=>item.kind),['reasoning','response','tool','reasoning','response']);
  assert.deepEqual(Array.from(items,item=>item.seq),[1,2,3,4,5]);
  assert.equal(items[1].text,first);assert.equal(items[2].callId,h.run.toolCalls[0].id);
  assert.equal(items[2].result,undefined,'Flow never duplicates authoritative tool output');
  assert.equal(h.run.toolCalls[0].result.text,'SOURCE_EVIDENCE_FOR_ACTUAL_HOST');
  assert.equal(h.reply.text,final);
  const entries=h.context.ConversationFlow.entries(h.reply,h.run);
  assert.equal(entries.filter(item=>item.kind==='response').length,1,'Final answer remains in the existing answer body only');
  assert.equal(entries[2].call,h.run.toolCalls[0]);
  assert.ok(h.checkpoint.snapshots.some(snapshot=>snapshot.conversations[0].messages.at(-1).conversationFlow?.items.some(item=>item.kind==='tool')),'Tool checkpoint persists conversation sequence with its receipt');
});

test('actual conversation flow never records nested plan fields as a visible response on cancellation',async()=>{
  const h=sendHarness([request=>{
    request.onAttempt({id:'cancel-round',status:'running'});
    request.onActivity({id:'cancel-reasoning',attemptId:'cancel-round',kind:'summary',text:'已收到的模型摘要。',status:'running'});
    request.onDelta('{"knowledgeRequests":[{"message":"INTERNAL_ONLY","type":"read"','',{attemptId:'cancel-round'});
    request.onAttempt({id:'cancel-round',status:'cancelled'});
    throw Object.assign(Error('已停止本次执行'),{code:'CANCELLED'});
  }]);enableConversationFlow(h);await h.send();
  assert.equal(h.run.status,'cancelled');assert.equal(h.reply.text,'');
  assert.equal(h.reply.conversationFlow.items.length,1);assert.equal(h.reply.conversationFlow.items[0].status,'cancelled');
  assert.ok(!JSON.stringify(h.reply.conversationFlow).includes('INTERNAL_ONLY'));
});

test('actual delegated conversation flow keeps child reasoning and response under host assigned parent identity',async()=>{
  const h=sendHarness([
    flowReply('main-1',{knowledgeRequests:[{type:'delegate',title:'核对资料',task:'读取 source-note 原文并回答其内容'}],actions:[]}),
    flowReply('child-1',{knowledgeRequests:[{type:'read',recordType:'note',id:'source-note'}],actions:[]},'读取该资料以核对。'),
    flowReply('child-2',{message:'source-note 的原文是 SOURCE_EVIDENCE_FOR_ACTUAL_HOST。',actions:[]}),
    flowReply('main-2',{message:'研究子任务返回了 source-note 的原文依据。',actions:[]})
  ]);enableConversationFlow(h);await h.send();
  assert.equal(h.run.status,'completed',h.run.error);
  const child=h.run.delegations[0],items=h.reply.conversationFlow.items;
  const childItems=items.filter(item=>item.parentId===child.id);
  assert.ok(childItems.some(item=>item.kind==='reasoning'&&item.text==='读取该资料以核对。'));
  assert.ok(childItems.some(item=>item.kind==='response'&&item.text.includes('SOURCE_EVIDENCE')));
  assert.ok(childItems.some(item=>item.kind==='tool'));
  assert.equal(h.run.delegations.length,1);assert.ok(h.run.toolCalls.every(call=>['delegate','read'].includes(call.type)));
});

for (const onDemand of [false,true]) test(`actual ${onDemand?'on-demand':'full'} host accepts optional tool-phase prose but never exposes workingSummary`,async()=>{
  const interim='我先核对资料正文中的具体依据。',final='原文内容是 SOURCE_EVIDENCE_FOR_ACTUAL_HOST。';
  const h=sendHarness([
    flowReply('public-tool-round',{message:interim,knowledgeRequests:[{type:'read',recordType:'note',id:'source-note'}],workingSummary:'INTERNAL_SUMMARY_ONLY',actions:[]}),
    flowReply('public-final-round',{message:final,actions:[]})
  ]);enableConversationFlow(h);
  const businessBefore=JSON.stringify([h.state.notes,h.state.tasks,h.state.papers,h.state.imports]);
  if(onDemand) h.context.window.AgentContext=h.context.AgentContext=require('../app/agent-context');
  await h.send();assert.equal(h.run.status,'completed',h.run.error);
  for(const request of h.calls)assert.match(JSON.stringify(request.input),/可选填顶层 message/);
  const entries=h.context.ConversationFlow.entries(h.reply,h.run);
  assert.deepEqual(Array.from(entries,item=>item.kind),['response','tool']);
  assert.equal(entries[0].text,interim);assert.equal(entries[1].call,h.run.toolCalls[0]);
  assert.equal(entries[1].call.result.text,'SOURCE_EVIDENCE_FOR_ACTUAL_HOST');
  assert.doesNotMatch(JSON.stringify(h.reply.conversationFlow),/INTERNAL_SUMMARY_ONLY/);
  assert.equal(h.reply.text,final);
  assert.equal(JSON.stringify([h.state.notes,h.state.tasks,h.state.papers,h.state.imports]),businessBefore,'public commentary cannot turn a read into a write');
});

test('actual host does not synthesize tool-phase prose when optional message is absent',async()=>{
  const h=sendHarness([
    flowReply('silent-tool-round',{knowledgeRequests:[{type:'read',recordType:'note',id:'source-note'}],workingSummary:'INTERNAL_SILENT_SUMMARY',actions:[]}),
    flowReply('silent-final-round',{message:'原文内容是 SOURCE_EVIDENCE_FOR_ACTUAL_HOST。',actions:[]})
  ]);enableConversationFlow(h);await h.send();assert.equal(h.run.status,'completed',h.run.error);
  assert.deepEqual(Array.from(h.reply.conversationFlow.items,item=>item.kind),['tool','response']);
  assert.deepEqual(Array.from(h.context.ConversationFlow.entries(h.reply,h.run),item=>item.kind),['tool']);
  assert.doesNotMatch(JSON.stringify(h.reply.conversationFlow),/INTERNAL_SILENT_SUMMARY|正在生成|已完成/);
});

test('actual host retains only received top-level public prose if a tool envelope is interrupted before execution',async()=>{
  const publicText='接下来需要核对原文中的日期。';
  const h=sendHarness([request=>{
    request.onAttempt({id:'interrupted-public',status:'running'});
    request.onDelta('{"message":'+JSON.stringify(publicText).slice(0,-1),'',{attemptId:'interrupted-public'});
    request.onDelta('{"message":'+JSON.stringify(publicText)+',"workingSummary":"INTERNAL_CANCELLED_SUMMARY","knowledgeRequests":[{"type":"read","message":"NESTED_PRIVATE_VALUE"','',{attemptId:'interrupted-public'});
    request.onAttempt({id:'interrupted-public',status:'cancelled'});
    throw Object.assign(Error('已停止本次执行'),{code:'CANCELLED'});
  }]);enableConversationFlow(h);await h.send();assert.equal(h.run.status,'cancelled');
  assert.equal(h.reply.text,publicText);assert.equal((h.run.toolCalls||[]).length,0);assert.equal(h.commits,0);
  assert.deepEqual(Array.from(h.reply.conversationFlow.items,item=>[item.kind,item.text,item.status]),[['response',publicText,'cancelled']]);
  assert.doesNotMatch(JSON.stringify(h.reply.conversationFlow),/INTERNAL_CANCELLED_SUMMARY|NESTED_PRIVATE_VALUE/);
});
