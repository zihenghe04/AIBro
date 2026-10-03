'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AttachmentAnalysis = require('../app/attachment-analysis');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const code = source.slice(source.indexOf('function analyzeImports('), source.indexOf('function recordMatchesSpace('));

function fixture(imports) {
  const old = { id: 'old', draft: 'Keep this unfinished draft', attachments: ['unrelated'], draftAttachmentIds: ['unrelated'] };
  const state = { imports, projects: [{ id: 'project', name: 'Course', workspace: '课程' }], conversations: [old] }, calls = [];
  let current = old;
  const input = { value: old.draft, focus() { calls.push('focus'); } };
  const context = vm.createContext({ state, window: { AttachmentAnalysis, ReadingPane: { revealWorkspace() { calls.push('reveal'); } } }, sendMessage: { busy: false },
    visibleImport: item => !!item && !item.deleted && !item.archived, visibleProject: item => !!item && !item.archived,
    toast: message => calls.push(['toast', message]), $: () => input,
    newConversation(workspace, projectId) { calls.push(['new', workspace, projectId]); current = { id: 'new' }; state.conversations.push(current); },
    currentConversation: () => current, save: () => calls.push('save'), renderAll: () => calls.push('render') });
  vm.runInContext(code, context);
  return { state, old, calls, input, context, analyze: ids => context.analyzeImports(ids) };
}
const bookmark = () => ({ id: 'bookmark', parser: 'bookmark', url: 'https://example.org/source', fileStored: false, content: '', pages: [], name: 'Saved reference', projectId: 'project' });
const webpage = () => ({ id: 'webpage', parser: 'html', url: 'https://example.org/article', content: 'Downloaded source text', name: 'Read article', projectId: 'project' });

test('direct or mixed bookmark analysis refuses before changing drafts, routes or current attachments', () => {
  for (const selection of [['bookmark'], ['webpage', 'bookmark']]) {
    const h = fixture([bookmark(), webpage()]), before = structuredClone(h.state);
    assert.equal(h.analyze(selection), false); assert.deepEqual(h.state, before); assert.equal(h.input.value, h.old.draft);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'toast'); assert.match(h.calls[0][1], /导入网页/);
  }
});

test('fetched pages still create a source-attached analysis draft without sending or replacing the old draft', () => {
  const h = fixture([webpage()]), before = structuredClone(h.old);
  assert.equal(h.analyze(['webpage']), true); assert.equal(h.state.conversations.length, 2); assert.deepEqual(h.old, before);
  const created = h.state.conversations[1]; assert.deepEqual(Array.from(created.attachments), ['webpage']); assert.deepEqual(Array.from(created.draftAttachmentIds), ['webpage']);
  assert.match(created.draft, /请分析这 1 份资料/); assert.equal(h.input.value, created.draft); assert.ok(h.calls.includes('save')); assert.ok(h.calls.includes('focus'));
  assert.equal(h.context.sendMessage.busy, false);
});
