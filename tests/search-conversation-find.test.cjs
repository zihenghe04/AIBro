'use strict';
// ⌘K 按消息正文找到对话后，打开时直接在对话内查找该词；按标题命中或打开失败时不打开查找栏。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('async function openGlobalSearchResult(');
const end = source.indexOf('\nasync function openSearchResult(', start);
assert.ok(start >= 0 && end > start);
const normalizeLine = source.split('\n').find(line => line.startsWith('const normalize = value =>'));

function fixture({ opens = true } = {}) {
  const conversation = { id: 'c1', title: '周报', messages: [{ id: 'm1', role: 'agent', text: '结论：Transformer 的注意力头数量影响很小。' }] };
  const state = { conversations: [conversation], currentConversationId: null };
  const finds = [];
  const context = { state, storageHydrated: true, serverConflict: false, previewOpenIntent: 0, showView: { navigationVersion: 1 },
    window: { PrivateMode: { isOn: () => false }, FindInConversation: { open: text => finds.push(text) } },
    $: () => null, currentConversation: () => state.conversations.find(item => item.id === state.currentConversationId),
    searchEntities: query => state.conversations.filter(item => `${item.title} ${item.messages.map(m => m.text).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
      .map(item => ({ type: 'conversation', id: item.id, title: item.title })),
    openSearchResult: async value => { if (!opens) return false; state.currentConversationId = value.split(':')[1]; return true; } };
  vm.createContext(context); vm.runInContext(`${normalizeLine}\n${source.slice(start, end)}`, context);
  return { context, finds };
}

test('a body match opens the conversation with find on the searched words', async () => {
  const h = fixture();
  assert.equal(await h.context.openGlobalSearchResult('conversation:c1', { query: ' transformer ' }), true);
  assert.deepEqual(h.finds, ['transformer']);
});

test('a title match, a failed open or an empty query leave the conversation without a find bar', async () => {
  const titled = fixture(); await titled.context.openGlobalSearchResult('conversation:c1', { query: '周报' }); assert.deepEqual(titled.finds, []);
  const failed = fixture({ opens: false }); await failed.context.openGlobalSearchResult('conversation:c1', { query: 'Transformer' }); assert.deepEqual(failed.finds, []);
});
