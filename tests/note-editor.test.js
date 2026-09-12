const test = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../note-editor.js');
const fixture = () => ({ projects: [{ id: 'p', name: '智能控制' }], imports: [{ id: 'a', name: 'lecture.pdf' }], notes: [{ id: 'n', title: '课后笔记', content: '原文 **摘要**', projectId: 'p', workspace: '课程', sourceAttachmentIds: ['a'], createdAt: 1, updatedAt: 2 }] });
const edit = (state, changes) => Object.assign(Editor.begin(state, 'n'), changes);

test('manual edits retain provenance and immutable prior versions', () => {
  const state = fixture();
  const change = Editor.prepare(state, edit(state, { title: '修订后的笔记', content: '我的理解' }), 10);
  assert.equal(state.notes[0].content, '原文 **摘要**', 'preflight must not mutate');
  Object.assign(change.note, change.after);
  const note = state.notes[0];
  assert.equal(note.userEdited, true); assert.equal(note.userEditedAt, 10);
  assert.deepEqual(note.sourceAttachmentIds, ['a']); assert.equal(note.projectId, 'p');
  assert.deepEqual(note.revisionHistory, [{ title: '课后笔记', content: '原文 **摘要**', updatedAt: 2, savedAt: 10, userEdited: false }]);
  const next = Editor.prepare(state, edit(state, { content: '下一次理解' }), 11);
  next.after.revisionHistory[0].content = 'attempted mutation';
  assert.equal(note.revisionHistory[0].content, '原文 **摘要**');
});

test('the revision limit retains the twenty most recent previous versions without changing the current one', () => {
  const state = fixture();
  for (let index = 0; index < 26; index++) {
    const change = Editor.prepare(state, edit(state, { content: `revision-${index}` }), index + 10);
    Object.assign(change.note, change.after);
  }
  assert.equal(state.notes[0].content, 'revision-25');
  assert.equal(state.notes[0].revisionHistory.length, 20);
  assert.equal(state.notes[0].revisionHistory[0].content, 'revision-5');
  assert.equal(state.notes[0].revisionHistory.at(-1).content, 'revision-24');
});

test('archived/deleted notes and projects block stale edits, and content conflicts do not rely on timestamps', () => {
  const mutations = [
    state => { state.notes = []; }, state => { state.notes[0].archived = true; }, state => { state.notes[0].deletedAt = 3; },
    state => { state.projects = []; }, state => { state.projects[0].archived = true; }, state => { state.projects[0].deletedAt = 3; },
    state => { state.notes[0].content = '外部更新'; }, state => { state.notes[0].projectId = null; },
    state => { state.notes[0].sourceAttachmentIds = []; }, state => { state.notes[0].updatedAt = 100; }
  ];
  for (const mutate of mutations) {
    const state = fixture(); const session = edit(state, { content: 'stale edit' }); mutate(state);
    const before = JSON.stringify(state);
    assert.throws(() => Editor.prepare(state, session), /删除|归档|其他操作修改/);
    assert.equal(JSON.stringify(state), before);
  }
});

test('blank titles cannot save, while unchanged content creates no revision', () => {
  const state = fixture();
  assert.throws(() => Editor.prepare(state, edit(state, { title: '  ' })), /标题/);
  assert.equal(Editor.prepare(state, Editor.begin(state, 'n')).changed, false);
  assert.equal(state.notes[0].revisionHistory, undefined);
});

function harness(options = {}) {
  const elements = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.open = false; this.hidden = false; this.value = ''; elements.push(this); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type, attrs = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...attrs }; for (const callback of this.listeners[type] || []) await callback(event); return event; }
    querySelector(tag) { return this.children.find(child => child.tagName === tag); }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
    focus() { doc.activeElement = this; }
  }
  const doc = { createElement: tag => new Element(tag), body: new Element('body'), activeElement: null };
  const state = options.state || fixture(); let saves = 0, renders = 0; const savedIds = [], toasts = [];
  const api = Editor.createController({ getState: () => state, save: () => { saves++; return options.save?.(); }, renderAll: () => { renders++; }, onSaved: id => savedIds.push(id), toast: message => toasts.push(message) }, { document: doc });
  api.open('n');
  const el = id => elements.find(element => element.id === id);
  return { api, state, doc, elements, el, savedIds, toasts,
    get saves() { return saves; }, get renders() { return renders; },
    input: async (id, value) => { const input = el(id); input.value = value; await input.fire('input'); },
    escape: async () => { const dialog = el('noteEditorDialog'); const event = await dialog.fire('cancel'); if (!event.defaultPrevented) dialog.close(); return event; }
  };
}

test('cancel and native Escape preserve only a session draft, and reopen restores it', async () => {
  const h = harness(); const before = JSON.stringify(h.state);
  await h.input('noteEditorContent', '保留我的草稿'); await h.escape();
  assert.equal(h.saves, 0); assert.equal(JSON.stringify(h.state), before);
  assert.equal(h.el('noteEditorDialog').open, false);
  h.api.open('n'); assert.equal(h.el('noteEditorContent').value, '保留我的草稿');
  assert.equal(h.el('noteEditorSources').textContent.includes('lecture.pdf'), true);
  h.api.close(); assert.equal(h.saves, 0); assert.equal(JSON.stringify(h.state), before);
});

test('save updates once, produces a revision, and notifies the host with the saved ID', async () => {
  const h = harness(); await h.input('noteEditorTitle', '人工修订标题'); await h.input('noteEditorContent', '新的 **正文**');
  assert.equal(await h.api.save(), true);
  assert.equal(h.saves, 1); assert.equal(h.renders, 1); assert.deepEqual(h.savedIds, ['n']);
  assert.equal(h.state.notes[0].content, '新的 **正文**'); assert.equal(h.state.notes[0].revisionHistory[0].content, '原文 **摘要**');
  assert.equal(h.api.getDraft('n'), null); assert.equal(h.el('noteEditorDialog').open, false);
});

test('an externally modified note is not overwritten and its stale draft survives loading the latest version', async () => {
  const h = harness(); await h.input('noteEditorContent', '我的未保存草稿');
  h.state.notes[0].content = '另一窗口的新版本';
  assert.equal(await h.api.save(), false); assert.equal(h.saves, 0);
  assert.equal(h.state.notes[0].content, '另一窗口的新版本');
  assert.match(h.el('noteEditorStatus').textContent, /未覆盖/);
  await h.elements.find(element => element.textContent === '载入最新版本').fire('click');
  assert.equal(h.el('noteEditorContent').value, '另一窗口的新版本');
  h.api.close(); h.api.open('n'); assert.equal(h.el('noteEditorContent').value, '我的未保存草稿');
});

test('rejected persistence rolls back only this edit and retains the draft', async () => {
  const h = harness({ save: () => Promise.reject(new Error('磁盘已满')) });
  await h.input('noteEditorContent', '需要重试'); assert.equal(await h.api.save(), false);
  assert.equal(h.state.notes[0].content, '原文 **摘要**'); assert.equal(h.state.notes[0].revisionHistory, undefined);
  assert.equal(h.el('noteEditorDialog').open, true); assert.equal(h.api.getDraft('n').content, '需要重试');
  assert.match(h.el('noteEditorStatus').textContent, /磁盘已满/); assert.equal(h.renders, 0);
});

test('save-in-flight is single flight, cannot be cancelled, and rollback does not replace a newer external update', async () => {
  let reject; const pending = new Promise((_, no) => { reject = no; });
  const h = harness({ save: () => pending }); await h.input('noteEditorContent', 'pending'); const saving = h.api.save();
  await h.api.save(); assert.equal(h.saves, 1); assert.equal((await h.escape()).defaultPrevented, true);
  h.state.notes[0].content = 'external after save'; reject(new Error('network')); await saving;
  assert.equal(h.state.notes[0].content, 'external after save');
});

test('AI draft is read-only until explicitly placed and saved, with the original manual text retained in history', async () => {
  const state = fixture(); state.notes[0].userEdited = true;
  state.notes[0].aiDraft = { title: 'AI建议标题', content: 'AI 增量草稿', createdAt: 5, sourceAttachmentIds: ['a'] };
  const h = harness({ state }); const before = JSON.stringify(state);
  await h.elements.find(element => element.textContent === '放入编辑器').fire('click');
  assert.equal(h.el('noteEditorContent').value, 'AI 增量草稿'); assert.equal(JSON.stringify(state), before); assert.equal(h.saves, 0);
  await h.escape(); assert.equal(JSON.stringify(state), before);
  h.api.open('n'); await h.input('noteEditorContent', 'AI 增量草稿 + 人工核对');
  assert.equal(await h.api.save(), true);
  assert.equal(state.notes[0].content, 'AI 增量草稿 + 人工核对'); assert.equal(Object.hasOwn(state.notes[0], 'aiDraft'), false);
  assert.equal(state.notes[0].revisionHistory.at(-1).content, '原文 **摘要**');
});

test('manual save without applying AI draft preserves it, and a newer AI proposal blocks stale application', async () => {
  const state = fixture(); const proposal = { content: 'AI proposal', createdAt: 5 }; state.notes[0].aiDraft = proposal;
  const h = harness({ state }); await h.input('noteEditorContent', 'only human text'); await h.api.save();
  assert.deepEqual(state.notes[0].aiDraft, proposal);
  h.api.open('n'); await h.elements.find(element => element.textContent === '放入编辑器').fire('click');
  state.notes[0].aiDraft = { content: 'newer AI proposal', createdAt: 6 };
  assert.equal(await h.api.save(), false); assert.equal(state.notes[0].content, 'only human text');
  assert.equal(state.notes[0].aiDraft.content, 'newer AI proposal');
});
