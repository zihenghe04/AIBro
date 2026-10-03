const installConversationPathHost = require('./helpers/conversation-path-host.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ModelChain = require('../app/model-chain.js');
const Canvas = require('../app/canvas-edit.js');
const Feedback = require('../app/answer-feedback.js');

// Exercise the shipping host adapters, together with the real policy/core
// modules. Only I/O, DOM and transport are substituted; no model is contacted.
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Host function boundary exists: ${start}`);
  return source.slice(from, to);
}
const generationHost = section('async function generateNoteSelection(', '\nasync function stageAnswerFeedbackDraft(');
const feedbackHost = section('async function stageAnswerFeedbackDraft(', '\nwindow.AnswerFeedback?.init(');
const modelHost = section('function resolveRunModel(', '\n// 用户主动停止');
const captureHost = section('function captureApiConnection(', '\n// 接口协议偏好');
const connectionHost = section('async function getApiConnection(', '\nfunction renderSettings(');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));

function generationFixture(options = {}) {
  const state = {
    currentConversationId: 'unrelated',
    notes: [{ id: 'note', title: 'Document', content: 'Document body', workspace: '科研', projectId: 'document-project' }],
    projects: [
      { id: 'document-project', workspace: '科研', modelConfig: { provider: 'api', model: 'document-model', effort: 'high' } },
      { id: 'chat-project', workspace: '课程', modelConfig: { provider: 'api', model: 'wrong-project-model' } },
    ],
    conversations: [{ id: 'unrelated', projectId: 'chat-project', modelConfig: { provider: 'api', model: 'wrong-chat-model' }, messages: [{ text: 'PRIVATE_UNRELATED_TRANSCRIPT' }] }],
    settings: { workspaceModelConfig: { 科研: { provider: 'api', model: 'workspace-model' } } },
  };
  const fields = new Map(Object.entries({ '#apiBase': 'https://fixture.example.invalid/v1', '#apiKey': 'synthetic-canvas-token', '#model': 'default-model', '#apiProtocol': 'responses' }).map(([id, value]) => [id, { value }]));
  const calls = { configurations: [], credentials: [], requests: [], deltas: [] };
  const models = { resolve: async config => { calls.configurations.push(copy(config)); return options.resolve ? options.resolve(config) : config; } };
  const context = vm.createContext({
    state, window: { ConversationModels: models }, ConversationModels: models, ModelChain,
    DOMException, URL, AbortController,
    $: id => fields.get(id), localStorage: { getItem: () => null }, apiCredentialState: null, apiSettingsDirty: false,
    workspaceName: value => value || '日常', defaultModelConfiguration: () => ({ provider: 'api', model: fields.get('#model').value }),
    apiOrigin: value => { try { return new URL(value).origin; } catch (_) { return ''; } },
    AgentTransport: { requestPlan: async request => { calls.requests.push(request); return options.transport ? options.transport(request) : 'Rewritten paragraph'; } },
  });
  vm.runInContext(modelHost + '\n' + captureHost + '\n' + connectionHost + '\n' + generationHost, context);
  const realConnection = context.getApiConnection;
  context.getApiConnection = captured => { calls.credentials.push(copy(captured)); return options.credentials ? options.credentials(captured) : realConnection(captured); };
  const request = { noteId: 'note', title: 'Selected document', instruction: 'Make this precise', selection: { text: 'Only this selection', start: 10, end: 29 }, context: { before: 'Nearby before', after: 'Nearby after' }, onDelta: value => calls.deltas.push(value) };
  return { context, state, fields, calls, request, generate: input => context.generateNoteSelection(input || request) };
}

test('Canvas host resolves the document project, never the unrelated active conversation', async () => {
  const f = generationFixture();
  assert.equal(await f.generate(), 'Rewritten paragraph');
  assert.equal(f.calls.configurations[0].model, 'document-model');
  assert.equal(f.calls.configurations[0].source, 'project');
  assert.equal(f.calls.requests[0].effort, 'high');
  const input = JSON.stringify(f.calls.requests[0].input);
  assert.equal(input.includes('PRIVATE_UNRELATED_TRANSCRIPT'), false);
  assert.equal(input.includes('Document body'), false, 'No full note or conversation is appended by the host');
  assert.equal(f.calls.requests[0].webSearch, false);
  assert.deepEqual(Array.from(f.calls.requests[0].input, item => item.role), ['developer', 'user']);
});

test('Canvas uses the note workspace and then global fallback when project configuration is absent', async () => {
  const f = generationFixture();
  delete f.state.projects[0].modelConfig;
  await f.generate();
  assert.equal(f.calls.requests[0].model, 'workspace-model');
  f.state.notes[0].projectId = null;
  f.state.settings.workspaceModelConfig = {};
  await f.generate();
  assert.equal(f.calls.requests[1].model, 'default-model');
});

test('Canvas captures API address and temporary credentials before awaiting model resolution', async () => {
  const model = deferred(), f = generationFixture({ resolve: () => model.promise });
  const pending = f.generate();
  f.fields.get('#apiBase').value = 'https://other.example.invalid/v1';
  f.fields.get('#apiKey').value = 'synthetic-unrelated-token';
  f.fields.get('#model').value = 'other-default';
  f.state.projects[0].modelConfig.model = 'later-project-model';
  model.resolve(f.calls.configurations[0]);
  await pending;
  assert.equal(f.calls.requests[0].base, 'https://fixture.example.invalid/v1');
  assert.equal(f.calls.requests[0].token, 'synthetic-canvas-token');
  assert.equal(f.calls.requests[0].model, 'document-model');
});

test('account-backed Canvas requests do not read or forward API credentials', async () => {
  const f = generationFixture();
  f.state.projects[0].modelConfig = { provider: 'openai-auth', model: 'account-model' };
  await f.generate();
  assert.equal(f.calls.credentials.length, 0);
  assert.equal(f.calls.requests[0].provider, 'openai-auth');
  assert.equal(f.calls.requests[0].token, undefined);
  assert.equal(f.calls.requests[0].base, undefined);
});

test('Canvas freezes the selected API protocol along with the connection while the model is resolving', async () => {
  const model = deferred(), f = generationFixture({ resolve: () => model.promise });
  const pending = f.generate();
  f.fields.get('#apiProtocol').value = 'chat';
  model.resolve(f.calls.configurations[0]);
  await pending;
  assert.equal(f.calls.credentials[0].protocol, 'responses');
  assert.equal(f.calls.requests[0].protocol, 'responses', 'A later settings change must not choose the endpoint for this captured connection');
});

test('missing/archived notes and deleted projects are rejected without transport', async () => {
  for (const mutate of [f => { f.state.notes = []; }, f => { f.state.notes[0].archived = true; }, f => { f.state.notes[0].deletedAt = 1; }, f => { f.state.projects[0].deletedAt = 1; }]) {
    const f = generationFixture(); mutate(f);
    await assert.rejects(f.generate(), /笔记|项目/);
    assert.equal(f.calls.requests.length, 0);
  }
});

test('missing API credentials or an empty model stop before sending document content', async () => {
  for (const credentials of [{ base: '', token: 'synthetic' }, { base: 'https://fixture.example.invalid', token: '' }]) {
    const f = generationFixture({ credentials: async () => credentials });
    await assert.rejects(f.generate(), /配置模型/);
    assert.equal(f.calls.requests.length, 0);
  }
  const f = generationFixture({ resolve: async () => ({ provider: 'api', model: '' }) });
  await assert.rejects(f.generate(), /配置模型/);
  assert.equal(f.calls.requests.length, 0);
});

test('Canvas cancellation before model resolution, after model resolution and after credentials prevents transport', async () => {
  const immediate = generationFixture(), first = new AbortController(); first.abort();
  await assert.rejects(immediate.generate({ ...immediate.request, signal: first.signal }), { name: 'AbortError' });
  assert.equal(immediate.calls.configurations.length, 0);
  for (const boundary of ['model', 'credentials']) {
    const gate = deferred(), aborter = new AbortController();
    const f = generationFixture(boundary === 'model' ? { resolve: () => gate.promise } : { credentials: () => gate.promise });
    const pending = f.generate({ ...f.request, signal: aborter.signal });
    await tick(); aborter.abort();
    gate.resolve(boundary === 'model' ? { provider: 'api', model: 'document-model' } : { base: 'https://fixture.example.invalid', token: 'synthetic' });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.calls.requests.length, 0);
    if (boundary === 'model') assert.equal(f.calls.credentials.length, 0);
  }
});

test('Canvas ignores late transport deltas and completion after cancellation', async () => {
  const gate = deferred(), aborter = new AbortController(), f = generationFixture({ transport: () => gate.promise });
  const pending = f.generate({ ...f.request, signal: aborter.signal });
  await tick();
  const outbound = f.calls.requests[0];
  assert.equal(outbound.signal, aborter.signal);
  outbound.onDelta('Early');
  aborter.abort(); outbound.onDelta('Early and late'); gate.resolve('Late complete text');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.calls.deltas, ['Early']);
});

test('empty and non-text Canvas responses are errors, with no document mutation', async () => {
  for (const output of ['', ' \n ', null, { text: 'Not the transport contract' }]) {
    const f = generationFixture({ transport: async () => output }), original = copy(f.state);
    await assert.rejects(f.generate(), /没有返回/);
    assert.deepEqual(f.state, original);
  }
});

test('Canvas host uses English availability, configuration, cancellation and empty-output errors', async () => {
  const unavailable = generationFixture(); unavailable.context.window.WorkstationI18n = { getLanguage: () => 'en' }; unavailable.state.notes = [];
  await assert.rejects(unavailable.generate(), /note or its project is unavailable/);
  const missing = generationFixture({ credentials: async () => ({}) }); missing.context.window.WorkstationI18n = { getLanguage: () => 'en' };
  await assert.rejects(missing.generate(), /Configure a model service/);
  const empty = generationFixture({ transport: async () => '' }); empty.context.window.WorkstationI18n = { getLanguage: () => 'en' };
  await assert.rejects(empty.generate(), /did not return a replacement/);
  const stopped = generationFixture(), aborter = new AbortController(); stopped.context.window.WorkstationI18n = { getLanguage: () => 'en' }; aborter.abort();
  await assert.rejects(stopped.generate({ ...stopped.request, signal: aborter.signal }), { name: 'AbortError', message: 'Rewrite stopped' });
});

test('real Canvas session sends only its selected range and at most 1600 nearby characters per side', async () => {
  const content = 'UNRELATED_PREFIX' + 'a'.repeat(4000) + '选中的段落' + 'b'.repeat(4000) + 'UNRELATED_SUFFIX';
  const start = content.indexOf('选中的段落'), f = generationFixture();
  const document = { id: 'note', title: 'Large note', content, version: 'v1', baseVersion: 'v1' };
  const editor = Canvas.createSession({ read: () => document, generate: request => f.generate(request), writeDraft: () => { throw Error('Generation must not apply a proposal'); } });
  editor.open({ start, end: start + '选中的段落'.length }); editor.instruction('更简洁');
  assert.equal(await editor.generate(), true);
  const text = f.calls.requests[0].input[1].content;
  const data = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(data.selection, '选中的段落');
  assert.equal(data.before.length, 1600); assert.equal(data.after.length, 1600);
  assert.equal(text.includes('UNRELATED_PREFIX'), false); assert.equal(text.includes('UNRELATED_SUFFIX'), false);
  assert.equal(document.content, content);
  assert.equal(editor.snapshot().status, 'ready');
});

test('actual Canvas and host render cumulative transport text once, without a false output-size abort', async () => {
  const snapshots = [], full = '文'.repeat(2000);
  const f = generationFixture({ transport: async request => {
    for (let i = 1; i <= 100; i++) request.onDelta(full.slice(0, i * 20));
    return full;
  } });
  const editor = Canvas.createSession({ read: () => ({ id: 'note', title: 'Note', content: 'original', version: 'v1', baseVersion: 'v1' }), generate: request => f.generate(request), onChange: value => { if (value?.status === 'generating') snapshots.push(value.output); } });
  editor.open({ start: 0, end: 8 }); editor.instruction('Rewrite');
  assert.equal(await editor.generate(), true, 'A 2k-character completion must not overflow the 64k limit');
  assert.equal(editor.snapshot().status, 'ready'); assert.equal(editor.snapshot().output, full);
  assert.ok(snapshots.every(value => value.length <= full.length), 'Intermediate text must not concatenate cumulative frames');
});

function feedbackFixture(options = {}) {
  const state = { currentConversationId: 'chat-a', conversations: [
    { id: 'chat-a', messages: [{ id: 'answer-a', role: 'agent', text: 'Answer A' }], draft: '' },
    { id: 'chat-b', messages: [{ id: 'answer-b', role: 'agent', text: 'Answer B' }], draft: '' },
  ] };
  const calls = { saves: [], render: 0, mode: 0, timers: [], sends: 0 };
  const input = { value: '', style: { height: '' }, scrollHeight: 230, dispatchEvent() { throw Error('Do not fire the normal input debounce from feedback'); } };
  const context = vm.createContext({
    state, $: id => id === '#agentInput' ? input : null, draftSaveTimer: 41,
    clearTimeout: id => calls.timers.push(id), renderComposerQueue: () => calls.render++, window: { ModeHint: { render: () => calls.mode++ } },
    saveDocumentDurably: async () => { calls.saves.push(copy(state)); return options.save ? options.save() : true; },
    sendMessage: () => { calls.sends++; throw Error('Feedback staging cannot send'); },
  });
  installConversationPathHost(context);
  vm.runInContext(feedbackHost, context);
  return { state, input, context, calls, stage: values => context.stageAnswerFeedbackDraft({ conversationId: 'chat-a', text: 'Suggested correction', ...values }), get conversation() { return state.conversations.find(item => item.id === 'chat-a'); } };
}

test('feedback stages and durably saves into its active conversation without input events or model sends', async () => {
  const f = feedbackFixture();
  assert.equal(await f.stage(), true);
  assert.equal(f.conversation.draft, 'Suggested correction'); assert.equal(f.input.value, 'Suggested correction');
  assert.equal(f.input.style.height, '180px'); assert.deepEqual(f.calls.timers, [41]); assert.equal(f.context.draftSaveTimer, null);
  assert.equal(f.calls.saves.length, 1); assert.equal(f.calls.saves[0].conversations[0].draft, 'Suggested correction');
  assert.equal(f.state.conversations[1].draft, ''); assert.equal(f.calls.sends, 0);
  assert.equal(f.context.stageAnswerFeedbackDraft.busy, false);
});

test('feedback refuses wrong conversations, unavailable targets, existing DOM or stored drafts', async () => {
  for (const mutate of [f => { f.state.currentConversationId = 'chat-b'; }, f => { f.conversation.archivedAt = 1; }, f => { f.conversation.deleted = true; }, f => { f.conversation.status = 'deleted'; }, f => { f.input.value = 'Later input'; }, f => { f.conversation.draft = 'Saved draft'; }, f => { f.input.value = ' '; }]) {
    const f = feedbackFixture(); mutate(f); const before = copy(f.state), input = f.input.value;
    await assert.rejects(f.stage()); assert.deepEqual(f.state, before); assert.equal(f.input.value, input);
    assert.equal(f.calls.saves.length, 0); assert.equal(f.calls.sends, 0);
  }
});

test('feedback rejects reentrant staging and waits for durable save before reporting success', async () => {
  const gate = deferred(), f = feedbackFixture({ save: () => gate.promise });
  let settled = false; const pending = f.stage().then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false); assert.equal(f.context.stageAnswerFeedbackDraft.busy, true);
  await assert.rejects(f.stage(), /正在准备/); gate.resolve(true);
  assert.equal(await pending, true); assert.equal(f.calls.saves.length, 1);
});

test('feedback save failure rolls back only its owned draft, including an originally absent field', async () => {
  for (const missing of [false, true]) for (const failure of ['reject', 'false']) {
    const gate = deferred(), f = feedbackFixture({ save: () => gate.promise }); if (missing) delete f.conversation.draft;
    const pending = f.stage(); failure === 'reject' ? gate.reject(Error('Disk offline')) : gate.resolve(false);
    await assert.rejects(pending); assert.equal(f.input.value, '');
    assert.equal(Object.hasOwn(f.conversation, 'draft'), !missing); if (!missing) assert.equal(f.conversation.draft, '');
    assert.equal(f.context.stageAnswerFeedbackDraft.busy, false); assert.equal(f.calls.sends, 0);
  }
});

test('feedback rollback preserves typing, transcript changes, and adopted state while saving', async () => {
  const gate = deferred(), f = feedbackFixture({ save: () => gate.promise });
  const pending = f.stage();
  f.state.conversations = copy(f.state.conversations); // The server adopted a replacement object graph.
  f.conversation.draft = 'Typed meanwhile'; f.input.value = 'Typed meanwhile';
  f.conversation.messages.push({ id: 'newer', role: 'user', text: 'Keep this' });
  gate.reject(Error('Disk offline')); await assert.rejects(pending);
  assert.equal(f.conversation.draft, 'Typed meanwhile'); assert.equal(f.input.value, 'Typed meanwhile');
  assert.equal(f.conversation.messages.length, 2);
});

test('feedback rollback reaches an adopted snapshot but cannot change another conversation composer', async () => {
  const gate = deferred(), f = feedbackFixture({ save: () => gate.promise });
  const pending = f.stage(); f.state.conversations = copy(f.state.conversations);
  f.state.currentConversationId = 'chat-b'; f.input.value = 'Suggested correction'; f.state.conversations[1].draft = 'Suggested correction';
  gate.reject(Error('Disk offline')); await assert.rejects(pending);
  assert.equal(f.conversation.draft, ''); assert.equal(f.state.conversations[1].draft, 'Suggested correction');
  assert.equal(f.input.value, 'Suggested correction', 'Even identical text in another active composer is not owned by the failed save');
});

test('successful feedback staging keeps subsequent typing and never navigates a switched conversation', async () => {
  const gate = deferred(), f = feedbackFixture({ save: () => gate.promise });
  const pending = f.stage(); f.conversation.draft += '\nAdditional instruction';
  f.state.currentConversationId = 'chat-b'; f.input.value = 'Other chat draft'; f.state.conversations[1].draft = f.input.value;
  gate.resolve(true); assert.equal(await pending, true);
  assert.equal(f.state.currentConversationId, 'chat-b'); assert.equal(f.input.value, 'Other chat draft');
  assert.equal(f.conversation.draft, 'Suggested correction\nAdditional instruction'); assert.equal(f.calls.sends, 0);
});

test('feedback target deletion during saving never recreates its conversation', async () => {
  for (const succeeds of [true, false]) {
    const gate = deferred(), f = feedbackFixture({ save: () => gate.promise }), pending = f.stage();
    f.state.conversations = f.state.conversations.filter(item => item.id !== 'chat-a');
    gate.resolve(succeeds); await assert.rejects(pending);
    assert.equal(f.state.conversations.some(item => item.id === 'chat-a'), false); assert.equal(f.calls.sends, 0);
  }
});

test('feedback archive during saving rejects completion and restores only its own draft', async () => {
  const gate = deferred(), f = feedbackFixture({ save: () => gate.promise }), pending = f.stage();
  f.conversation.archivedAt = 123; gate.resolve(true);
  await assert.rejects(pending, /对话已不可用/);
  assert.equal(f.conversation.archivedAt, 123); assert.equal(f.conversation.draft, ''); assert.equal(f.input.value, '');
});

test('empty feedback continuation is inert and does not consume pending normal draft saving', async () => {
  const f = feedbackFixture();
  assert.equal(await f.stage({ text: ' \n ' }), false);
  assert.equal(f.context.draftSaveTimer, 41); assert.deepEqual(f.calls.timers, []);
  assert.equal(f.calls.saves.length, 0); assert.equal(f.input.value, '');
});

test('feedback host exposes English target, occupied-draft and failed-save messages without translating user content', async () => {
  const wrong = feedbackFixture(); wrong.context.window.WorkstationI18n = { getLanguage: () => 'en' }; wrong.state.currentConversationId = 'chat-b';
  await assert.rejects(wrong.stage(), /Return to the conversation/);
  const occupied = feedbackFixture(); occupied.context.window.WorkstationI18n = { getLanguage: () => 'en' }; occupied.input.value = '不要改动我的原文';
  await assert.rejects(occupied.stage(), /composer already has a draft/); assert.equal(occupied.input.value, '不要改动我的原文');
  const failed = feedbackFixture({ save: async () => false }); failed.context.window.WorkstationI18n = { getLanguage: () => 'en' };
  await assert.rejects(failed.stage(), /feedback draft was not saved/); assert.equal(failed.input.value, '');
  const successful = feedbackFixture(); successful.context.window.WorkstationI18n = { getLanguage: () => 'en' };
  assert.equal(await successful.stage({ text: '请保留中文原稿' }), true); assert.equal(successful.input.value, '请保留中文原稿');
});

test('all supported private conversation flags stage only in memory and cancel the generic save timer', async () => {
  for (const flag of ['ephemeral', 'incognito', 'private']) {
    const f = feedbackFixture({ save: () => { throw Error('Private suggestion must not save'); } }); f.conversation[flag] = true;
    assert.equal(await f.stage({ text: 'PRIVATE_FEEDBACK_DRAFT' }), true);
    assert.equal(f.calls.saves.length, 0); assert.equal(f.context.draftSaveTimer, null); assert.deepEqual(f.calls.timers, [41]);
    assert.equal(f.conversation.draft, 'PRIVATE_FEEDBACK_DRAFT'); assert.equal(f.input.value, 'PRIVATE_FEEDBACK_DRAFT'); assert.equal(f.calls.sends, 0);
  }
});

test('real feedback controller enforces answer ownership before entering the host staging adapter', async () => {
  const f = feedbackFixture(), api = Feedback.createController({ getConversation: id => f.state.conversations.find(item => item.id === id), save: async () => true, stageDraft: input => f.context.stageAnswerFeedbackDraft(input) });
  await api.commit('chat-a', 'answer-a', { rating: 'unhelpful', comment: 'Use the correct date' });
  await assert.rejects(api.stage('chat-a', 'answer-b'), { code: 'FEEDBACK_GONE' }); assert.equal(f.calls.saves.length, 0);
  await api.stage('chat-a', 'answer-a');
  assert.match(f.conversation.draft, /Answer A/); assert.match(f.conversation.draft, /Use the correct date/);
  assert.doesNotMatch(f.conversation.draft, /Answer B/); assert.equal(f.calls.saves.length, 1); assert.equal(f.calls.sends, 0);
});
