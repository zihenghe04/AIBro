import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter } from '../src/store.js';
import { createAgentTools } from '../src/agent-tools.js';
import { createConversationContext, restoreConversationContext, MAX_CONVERSATION_CONTEXT_KEYS } from '../src/conversation-context.js';

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('projects', { id: 'p', name: '合成当前项目', workspace: '科研' });
  await store.put('projects', { id: 'other', name: '合成其他项目', workspace: '课程' });
  await store.put('conversations', { id: 'origin', title: '合成来源会话', projectId: 'p' });
  await store.put('notes', { id: 'source', kind: 'note', title: '合成来源资料', content: '不应进入上下文字段的正文', projectId: 'p' });
  await store.put('notes', { id: 'cross', kind: 'note', title: '跨项目明确引用', content: '仅因明确引用而允许读取', projectId: 'other' });
  await store.put('notes', { id: 'unselected', kind: 'note', title: '未引用资料', content: '未选择内容', projectId: 'other' });
  await store.put('imports', { id: 'file', title: '合成文本文件', content: '保留正文在记录中', projectId: 'p' });
  const conversation = { id: 'discussion', title: '合成资料讨论', projectId: 'p',
    mobileContext: createConversationContext(['notes:source', 'imports:file', 'notes:cross'], { kind: 'notes', id: 'source', conversationId: 'origin' }) };
  await store.put('conversations', conversation);
  return { store, conversation };
}

test('context construction stores only bounded unique identities and copies caller input', () => {
  const refs = ['notes:source', 'notes:source', 'imports:file'], source = { kind: 'notes', id: 'source', conversationId: 'origin' };
  const result = createConversationContext(refs, source);
  refs.push('notes:later'); source.id = 'changed';
  assert.deepEqual(result, { version: 1, keys: ['notes:source', 'imports:file'], source: { kind: 'notes', id: 'source', conversationId: 'origin' } });
  assert.equal(JSON.stringify(result).includes('content'), false);
  assert.equal(createConversationContext(Array.from({ length: MAX_CONVERSATION_CONTEXT_KEYS }, (_, i) => 'notes:n' + i)).keys.length, 50);
});

test('invalid kinds, identifiers, unknown fields and excessive contexts are rejected', () => {
  for (const refs of [null, 'notes:x', ['tasks:x'], ['agenda:x'], ['notes:a:b'], ['notes:'], ['notes:' + 'a'.repeat(201)], ['notes:x', 1], Array.from({ length: 51 }, (_, i) => 'notes:n' + i)])
    assert.throws(() => createConversationContext(refs), { code: 'CONVERSATION_CONTEXT_INVALID' });
  for (const source of [{ kind: 'imports', id: 'x' }, { kind: 'notes', id: '../x' }, { kind: 'notes', id: 'x', conversationId: null },
    { kind: 'notes', id: 'x', content: '正文不得持久化在引用字段' }])
    assert.throws(() => createConversationContext([], source), { code: 'CONVERSATION_CONTEXT_INVALID' });
});

test('production Store record reload preserves references and source without relying on a UI Map', async () => {
  const { store, conversation } = await fixture();
  const reopened = await new Store(store.adapter).load();
  assert.deepEqual(reopened.get('conversations', conversation.id), conversation);
  const restored = restoreConversationContext(reopened, reopened.get('conversations', conversation.id));
  assert.deepEqual(restored, { keys: ['notes:source', 'imports:file', 'notes:cross'],
    source: { kind: 'notes', id: 'source', conversationId: 'origin' }, unavailableCount: 0 });
  restored.keys.push('notes:unselected'); restored.source.id = 'other';
  assert.deepEqual(reopened.get('conversations', conversation.id), conversation);
});

test('explicit cross-project references retain existing Agent read scope without adding siblings', async () => {
  const { store, conversation } = await fixture(), { keys } = restoreConversationContext(store, conversation);
  const tools = createAgentTools({ store, conversationID: conversation.id, projectID: 'p', contextKeys: keys });
  assert.ok(tools.initial('').some(source => source.id === 'cross'));
  const rejected = await tools.execute('knowledge_read', { kind: 'notes', id: 'unselected' });
  assert.ok(rejected.error);
  assert.equal(keys.includes('notes:unselected'), false);
});

test('restoration filters current deletion, archive, conflict and private flags without mutating the saved selection', async () => {
  const { store, conversation } = await fixture();
  const flags = [{ deleted: true }, { archived: true }, { archivedAt: 12 }, { deletedAt: 12 }, { private: true },
    { hidden: true }, { ephemeral: true }, { incognito: true }, { status: 'archived' }, { status: 'deleted' }];
  const original = store.get('notes', 'cross');
  for (const flag of flags) {
    await store.put('notes', { ...original, ...flag });
    const restored = restoreConversationContext(store, conversation);
    assert.deepEqual(restored.keys, ['notes:source', 'imports:file'], JSON.stringify(flag));
    assert.equal(restored.unavailableCount, 1);
  }
  await store.put('notes', original);
  await store.tx(state => { state.records['notes:cross'].conflict = { version: 3, data: original, deleted: false }; });
  assert.equal(restoreConversationContext(store, conversation).unavailableCount, 1);
  await store.tx(state => { delete state.records['notes:cross'].conflict; state.records['notes:cross'].deleted = true; });
  assert.equal(restoreConversationContext(store, conversation).unavailableCount, 1);
  assert.deepEqual(store.get('conversations', conversation.id), conversation);
});

test('inaccessible project and source-conversation owners do not expose an otherwise live record', async () => {
  const { store, conversation } = await fixture();
  await store.put('projects', { ...store.get('projects', 'other'), private: true });
  assert.equal(restoreConversationContext(store, conversation).keys.includes('notes:cross'), false);
  await store.put('notes', { ...store.get('notes', 'source'), sourceConversationId: 'origin' });
  await store.put('conversations', { ...store.get('conversations', 'origin'), archived: true });
  const restored = restoreConversationContext(store, conversation);
  assert.deepEqual(restored.keys, ['imports:file']);
  assert.equal(restored.source, null);
  assert.equal(restored.unavailableCount, 2);
});

test('an unavailable source disables return; only a missing origin conversation leaves the note route available', async () => {
  const { store, conversation } = await fixture();
  await store.remove('conversations', 'origin');
  assert.deepEqual(restoreConversationContext(store, conversation).source, { kind: 'notes', id: 'source' });
  await store.put('notes', { ...store.get('notes', 'source'), kind: '日程' });
  assert.equal(restoreConversationContext(store, conversation).source, null);
  await store.remove('notes', 'source');
  const restored = restoreConversationContext(store, conversation);
  assert.equal(restored.source, null);
  assert.equal(restored.unavailableCount, 1);
  assert.equal(store.get('notes', 'source'), null);
});

test('missing metadata stays compatible but malformed metadata never silently becomes unrestricted', async () => {
  const { store, conversation } = await fixture();
  assert.deepEqual(restoreConversationContext(store, { id: 'legacy' }), { keys: [], source: null, unavailableCount: 0 });
  for (const mobileContext of [null, { version: 2, keys: [], source: null }, { version: 1, keys: ['tasks:x'], source: null },
    { version: 1, keys: [], source: { kind: 'notes', id: 'x', text: 'unexpected' } }, { version: 1, keys: [], source: null, body: 'unexpected' }]) {
    const restored = restoreConversationContext(store, { ...conversation, mobileContext });
    assert.deepEqual(restored.keys, []);
    assert.equal(restored.source, null);
    assert.ok(restored.unavailableCount >= 1);
  }
});

test('a conflicted current conversation returns no usable context and all-lost references remain explicit', async () => {
  const { store, conversation } = await fixture();
  await store.tx(state => { state.records['conversations:discussion'].conflict = { version: 1, data: conversation, deleted: false }; });
  assert.deepEqual(restoreConversationContext(store, conversation), { keys: [], source: null, unavailableCount: 3 });
  const absent = { id: 'absent', mobileContext: createConversationContext(['notes:missing', 'imports:missing']) };
  assert.deepEqual(restoreConversationContext(store, absent), { keys: [], source: null, unavailableCount: 2 });
});
