import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter, putRecord } from '../src/store.js';
import { createConversationContext, conversationContextStatus, conversationContextOptions, selectConversationContext } from '../src/conversation-context.js';

async function fixture(projectId = null) {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('projects', { id: 'p', name: '合成项目' });
  await store.put('notes', { id: 'n', kind: 'note', title: '合成笔记', content: '正文不能进入候选投影', updatedAt: 2 });
  await store.put('imports', { id: 'i', title: '合成原件', content: '已提取文字', updatedAt: 1 });
  const c = { id: 'c', projectId, mobileContext: createConversationContext(['notes:n', 'imports:i'], { kind: 'notes', id: 'n' }) };
  await store.put('conversations', c);
  return { store, c };
}

test('deleted references never present all knowledge, including after production Store reload', async () => {
  const { store, c } = await fixture();
  await store.remove('notes', 'n'); await store.remove('imports', 'i');
  const reopened = await new Store(store.adapter).load(), before = structuredClone(reopened.state);
  const view = conversationContextStatus(reopened, c);
  assert.equal(view.state, 'unavailable'); assert.equal(view.canSend, false);
  assert.equal(view.label, '2 项引用待处理'); assert.equal(view.resetLabel, '改用全部知识');
  assert.deepEqual(view.keys, []); assert.equal(view.source, null);
  assert.deepEqual(reopened.state, before);
});

test('fresh synchronized conversation references replace an old caller snapshot without broadening on partial loss', async () => {
  const { store, c } = await fixture('p');
  await store.put('conversations', { ...c, mobileContext: createConversationContext(['imports:i']) });
  const fresh = conversationContextStatus(store, c);
  assert.deepEqual(fresh.keys, ['imports:i']); assert.equal(fresh.label, '1 项引用');
  await store.put('conversations', c);
  await store.remove('imports', 'i');
  const partial = conversationContextStatus(store, c);
  assert.equal(partial.state, 'partial'); assert.equal(partial.label, '1 项引用待处理');
  assert.equal(partial.canSend, false); assert.deepEqual(partial.keys, ['notes:n']);
  assert.equal(partial.resetLabel, '改用项目知识');
});

test('invalid envelope and conflicted or removed conversation keep send blocked', async () => {
  const { store, c } = await fixture();
  await store.put('conversations', { ...c, mobileContext: { version: 9, keys: [], source: null } });
  assert.equal(conversationContextStatus(store, c).state, 'invalid');
  assert.equal(conversationContextStatus(store, c).canSend, false);
  await store.put('conversations', { ...c, mobileContext: createConversationContext([]) });
  await store.tx(s => { s.records['conversations:c'].conflict = { version: 3, data: c, deleted: false }; });
  assert.equal(conversationContextStatus(store, c).canSend, false);
  await store.remove('conversations', 'c');
  assert.equal(conversationContextStatus(store, c).canSend, false);
});

test('picker only exposes readable candidates, rejects private owners, and keeps explicit cross-project records', async () => {
  const { store } = await fixture();
  await store.put('notes', { id: 'cross', title: '明确跨项目', projectId: 'p', content: '明确选择的原文' });
  await store.put('notes', { id: 'private', title: '隐藏标题', private: true });
  await store.put('notes', { id: 'event', kind: '日程', content: '{}' });
  await store.put('notes', { id: 'conflict', title: '冲突标题' });
  await store.tx(s => { s.records['notes:conflict'].conflict = { version: 1, data: {}, deleted: false }; });
  await store.put('imports', { id: 'waiting', content: '   ', title: '待提取' });
  assert.deepEqual(conversationContextOptions(store).map(x => x.key).sort(), ['imports:i', 'notes:cross', 'notes:n']);
  assert.equal(JSON.stringify(conversationContextOptions(store)).includes('正文不能'), false);
  await store.put('projects', { id: 'p', private: true });
  assert.deepEqual(conversationContextOptions(store).map(x => x.key), ['notes:n', 'imports:i']);
});

test('clear requires explicit scope action even when every original reference is valid; available source survives', async () => {
  const { store, c } = await fixture('p');
  assert.throws(() => selectConversationContext(store, c, []), { code: 'CONVERSATION_CONTEXT_SCOPE_CONFIRMATION_REQUIRED' });
  const result = selectConversationContext(store, c, [], { useKnowledgeScope: true });
  assert.deepEqual(result, createConversationContext([], { kind: 'notes', id: 'n' }));
  assert.throws(() => selectConversationContext(store, c, ['notes:n'], { useKnowledgeScope: true }));
  assert.throws(() => selectConversationContext(store, c, [], { useKnowledgeScope: 'yes' }));
  await store.put('conversations', { ...c, mobileContext: result });
  assert.equal(conversationContextStatus(store, c).state, 'scope');
  assert.equal(conversationContextStatus(store, c).label, '项目知识');
});

test('all-lost context can explicitly recover to knowledge, with no mutation until owner commits', async () => {
  const { store, c } = await fixture();
  await store.remove('notes', 'n'); await store.remove('imports', 'i');
  const before = structuredClone(store.state);
  const result = selectConversationContext(store, c, [], { useKnowledgeScope: true });
  assert.deepEqual(result, createConversationContext([])); assert.deepEqual(store.state, before);
  await store.put('conversations', { ...c, mobileContext: result }, c);
  const reopened = await new Store(store.adapter).load();
  assert.equal(conversationContextStatus(reopened, c).canSend, true);
});

test('candidate becoming private after picker opens rejects entire owner transaction and preserves draft/scope', async () => {
  const { store, c } = await fixture();
  const selected = conversationContextOptions(store).map(x => x.key);
  await store.tx(s => { s.drafts['chat:c'] = '仍须保留的输入'; });
  await store.put('notes', { ...store.get('notes', 'n'), private: true });
  const before = structuredClone(store.state);
  await assert.rejects(store.tx(s => {
    const current = s.records['conversations:c'].data;
    const mobileContext = selectConversationContext(s, current, selected);
    putRecord(s, 'conversations', { ...current, mobileContext }, current);
  }), { code: 'CONVERSATION_CONTEXT_UNAVAILABLE' });
  assert.deepEqual(store.state, before); assert.equal(store.get('conversations', c.id).mobileContext.keys.length, 2);
});

test('selection enforces kinds/identities/50 limit and source derives from current record', async () => {
  const { store, c } = await fixture();
  for (const keys of [['tasks:x'], ['notes:../x'], Array.from({ length: 51 }, () => 'notes:n')])
    assert.throws(() => selectConversationContext(store, c, keys), { code: 'CONVERSATION_CONTEXT_INVALID' });
  assert.deepEqual(selectConversationContext(store, c, ['notes:n', 'notes:n']).keys, ['notes:n']);
  await store.put('conversations', { ...c, mobileContext: createConversationContext(['notes:n'], null) });
  assert.equal(selectConversationContext(store, c, ['notes:n']).source, null);
});
