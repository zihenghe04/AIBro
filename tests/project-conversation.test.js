const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = source.indexOf('function openConversation(');
const end = source.indexOf('\nfunction sidebarProjectWorkspace(', start);
assert.ok(start >= 0 && end > start, 'Use the real conversation selection and navigation helpers');

function harness() {
  let sequence = 0;
  const elements = new Map();
  const state = {
    projects: [{ id: 'a', name: '同名项目', workspace: '课程' }, { id: 'b', name: '同名项目', workspace: '科研' }],
    conversations: [{ id: 'global', workspace: 'auto', projectId: null, draft: '', messages: [], attachments: [] }],
    currentProjectId: 'a', currentConversationId: 'global'
  };
  const calls = [];
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', open: false, focus() { calls.push(['focus', selector]); },
      close() { this.open = false; calls.push(['close', selector]); },
      click() { this.onclick?.(); }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    state, $, Date, Number, uid: prefix => `${prefix}-${++sequence}`,
    currentConversation: () => state.conversations.find(item => item.id === state.currentConversationId),
    workspaceName: value => ['课程', '科研'].includes(value) ? value : '日常',
    save: () => calls.push(['save']), renderAll: () => calls.push(['render']),
    showView: (view, label) => {
      calls.push(['view', view, label]);
      $('#agentInput').value = state.conversations.find(item => item.id === state.currentConversationId)?.draft || '';
    },
    toast: message => calls.push(['toast', message])
  });
  vm.runInContext(source.slice(start, end), context);
  for (const selector of ['projectChat', 'projectFirstInput']) {
    const handler = source.split('\n').find(line => line.startsWith(`$('#${selector}').onclick =`));
    assert.ok(handler, selector);
    vm.runInContext(handler, context);
  }
  const add = (id, fields = {}) => {
    const conversation = { id, projectId: 'a', workspace: '课程', messages: [], attachments: [], createdAt: 1, updatedAt: 1, ...fields };
    state.conversations.push(conversation);
    return conversation;
  };
  return { state, calls, $, add, continue: context.continueProjectConversation };
}

test('continue opens the latest active conversation in the exact project without copying its content', () => {
  const h = harness();
  h.add('old', { updatedAt: 10 });
  const recent = h.add('recent', { updatedAt: 30, draft: '未发送的问题', messages: [{ id: 'message', text: '已有讨论' }], attachments: ['pdf'] });
  h.add('created-later', { createdAt: 20, updatedAt: 20 });
  const order = h.state.conversations.slice();
  h.$('#agentInput').value = '原对话草稿'; h.$('#previewDialog').open = true;
  h.$('#projectChat').click();
  assert.equal(h.state.currentConversationId, 'recent');
  assert.deepEqual(h.state.conversations, order, 'Selection must not reorder or append canonical records');
  assert.strictEqual(h.state.conversations.find(item => item.id === 'recent'), recent);
  assert.equal(h.state.conversations[0].draft, '原对话草稿');
  assert.equal(h.$('#agentInput').value, '未发送的问题');
  assert.deepEqual(recent.attachments, ['pdf']);
  assert.equal(recent.messages[0].text, '已有讨论');
  assert.equal(h.$('#previewDialog').open, true, 'A persistent reader remains open while the main conversation changes');
  assert.ok(h.calls.some(call => call[0] === 'view' && call[1] === 'agent'));
});

test('archived and deleted conversations cannot outrank a valid older one', () => {
  const h = harness(); h.add('valid', { updatedAt: 2 });
  for (const flag of [{ archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { status: 'archived' }, { status: 'deleted' }]) {
    h.add(`inactive-${h.state.conversations.length}`, { updatedAt: 1000, ...flag });
  }
  h.continue('a');
  assert.equal(h.state.currentConversationId, 'valid');
});

test('same-name projects and result-only associations never become the continued project context', () => {
  const h = harness();
  h.add('other-project', { projectId: 'b', workspace: '科研', updatedAt: 999, messages: [{ results: [{ projectId: 'a' }] }] });
  h.add('result-only', { projectId: null, updatedAt: 1000, messages: [{ results: [{ projectId: 'a' }] }] });
  h.continue('a');
  const created = h.state.conversations.find(item => item.id === h.state.currentConversationId);
  assert.equal(created.projectId, 'a');
  assert.equal(created.workspace, '课程');
  assert.equal(created.messages.length, 0);
  assert.equal(created.attachments.length, 0);
  assert.equal(h.state.conversations.length, 4);
});

test('empty projects create one scoped conversation, and both entry buttons reuse it on repeated clicks', () => {
  const h = harness();
  h.$('#projectFirstInput').click();
  const id = h.state.currentConversationId;
  h.$('#agentInput').value = '项目里的草稿';
  h.$('#projectChat').click(); h.$('#projectFirstInput').click();
  assert.equal(h.state.conversations.length, 2);
  assert.equal(h.state.currentConversationId, id);
  assert.equal(h.state.conversations[1].projectId, 'a');
  assert.equal(h.state.conversations[1].workspace, '课程');
  assert.equal(h.state.conversations[1].draft, '项目里的草稿');
});

test('opening the button after switching projects resolves the current project at click time', () => {
  const h = harness(); h.add('a-chat'); h.add('b-chat', { projectId: 'b', workspace: '科研' });
  h.$('#projectChat').click(); assert.equal(h.state.currentConversationId, 'a-chat');
  h.state.currentProjectId = 'b'; h.$('#projectFirstInput').click();
  assert.equal(h.state.currentConversationId, 'b-chat');
  assert.equal(h.state.conversations.length, 3);
});

test('missing, archived, or deleted projects neither create nor open a conversation', () => {
  for (const flag of [null, { archived: true }, { archivedAt: 1 }, { deleted: true }, { deletedAt: 1 }, { status: 'archived' }, { status: 'deleted' }]) {
    const h = harness(); h.add('must-not-open');
    if (flag) Object.assign(h.state.projects[0], flag); else h.state.currentProjectId = 'missing';
    h.$('#projectChat').click();
    assert.equal(h.state.conversations.length, 2);
    assert.equal(h.state.currentConversationId, 'global');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], 'toast');
    assert.match(h.calls[0][1], /删除或归档/);
  }
});

test('recency uses createdAt when updatedAt is missing or invalid, with deterministic ties', () => {
  const h = harness();
  h.add('old', { updatedAt: 5 });
  h.add('missing-update', { updatedAt: null, createdAt: 20 });
  h.add('bad-update', { updatedAt: 'invalid', createdAt: 30 });
  h.add('same-time', { updatedAt: 30 });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'bad-update');
  h.add('zero-update', { updatedAt: 0, createdAt: 40 });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'zero-update');
  h.add('iso-date', { updatedAt: '2026-09-12T12:00:00Z' });
  h.continue('a'); assert.equal(h.state.currentConversationId, 'iso-date');
});
