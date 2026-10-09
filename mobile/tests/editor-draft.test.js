import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryAdapter, putRecord } from '../src/store.js';
import { EDITOR_DRAFT_FORMAT, createEditorDraft, inspectEditorDraft, getEditorDraftWrite, editorDraftAsNew, editorDraftCopy } from '../src/editor-draft.js';
import { editedProject, recordProjectSelection } from '../src/record-project.js';

const note = () => ({ id: 'synthetic_note', title: '原标题', content: '原正文', projectId: 'synthetic_project', workspace: '科研', updatedAt: 1,
  sourceAttachmentIds: ['synthetic_source'], custom: { retained: true } });
const values = () => ({ title: '草稿标题', content: ' 未保存正文\n' });

test('note draft retains the complete baseline and exact input without shared mutable references', () => {
  const base = note(), input = values(), draft = createEditorDraft('note', base, input);
  base.custom.retained = false; input.content = 'changed later';
  const inspected = inspectEditorDraft('note', draft, note());
  assert.equal(inspected.state, 'ready');
  assert.equal(inspected.values.content, ' 未保存正文\n');
  assert.equal(inspected.base.custom.retained, true);
  inspected.base.custom.retained = false; inspected.values.content = 'changed by UI';
  assert.equal(draft.base.custom.retained, true);
  assert.equal(draft.values.content, ' 未保存正文\n');
});

test('a synchronized note edit remains a conflict after closing and reopening the draft', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  const base = note(), draft = createEditorDraft('note', base, values());
  await store.put('notes', base);
  await store.tx(s => { s.drafts['editor:synthetic_note'] = draft; });
  await store.put('notes', { ...base, content: 'Mac 新正文', updatedAt: 2 });
  for (let reopen = 0; reopen < 2; reopen++) {
    const saved = store.state.drafts['editor:synthetic_note'];
    assert.equal(inspectEditorDraft('note', saved, store.get('notes', base.id)).state, 'changed');
    await assert.rejects(store.tx(s => {
      const write = getEditorDraftWrite('note', s.drafts['editor:synthetic_note'], s.records['notes:synthetic_note'].data);
      putRecord(s, 'notes', { ...write.base, ...write.values }, write.base);
    }), { code: 'EDITOR_DRAFT_CHANGED' });
  }
  assert.equal(store.get('notes', base.id).content, 'Mac 新正文');
  assert.deepEqual(store.state.drafts['editor:synthetic_note'], draft);
});

test('transaction-time recheck rejects a remote change after an initially ready UI inspection', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  const base = note(), draft = createEditorDraft('note', base, values());
  await store.put('notes', base);
  assert.equal(inspectEditorDraft('note', draft, store.get('notes', base.id)).canSave, true);
  await store.put('notes', { ...base, projectId: 'other_project', updatedAt: 2 });
  await assert.rejects(store.tx(s => getEditorDraftWrite('note', draft, s.records['notes:synthetic_note'].data)), { code: 'EDITOR_DRAFT_CHANGED' });
  assert.equal(store.get('notes', base.id).projectId, 'other_project');
});

test('explicit Save As New preserves both remote original and source draft', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  const remote = { ...note(), content: 'Mac 新正文', updatedAt: 2 };
  const originalDraft = createEditorDraft('note', note(), values());
  await store.put('notes', remote);
  await store.tx(s => { s.drafts['editor:synthetic_note'] = originalDraft; });
  const newDraft = editorDraftAsNew('note', originalDraft);
  assert.equal(newDraft.base, null);
  await store.tx(s => {
    const write = getEditorDraftWrite('note', newDraft, null);
    putRecord(s, 'notes', { id: 'synthetic_copy', kind: 'note', ...write.values });
  });
  assert.equal(store.get('notes', 'synthetic_copy').content, values().content);
  assert.deepEqual(store.get('notes', remote.id), remote);
  assert.deepEqual(store.state.drafts['editor:synthetic_note'], originalDraft);
});

test('legacy note drafts never acquire the current record as their baseline', () => {
  const legacy = values();
  for (const current of [note(), { ...note(), content: '新版本' }, null]) {
    const review = inspectEditorDraft('note', legacy, current);
    assert.equal(review.state, 'legacy');
    assert.equal(review.canSave, false);
    assert.equal(Object.hasOwn(review, 'base'), false);
    assert.throws(() => getEditorDraftWrite('note', legacy, current), { code: 'EDITOR_DRAFT_LEGACY' });
  }
  assert.deepEqual(editorDraftAsNew('note', legacy), createEditorDraft('note', null, legacy));
});

test('legacy capture strings remain explicit legacy even when empty or editing a new record', () => {
  for (const content of ['', '旧随记\n正文']) {
    const review = inspectEditorDraft('capture', content, null);
    assert.equal(review.state, 'legacy');
    assert.equal(Object.hasOwn(review, 'base'), false);
    assert.deepEqual(editorDraftAsNew('capture', content).values, { content, tags: '', projectId: null });
  }
});

test('capture draft preserves raw tags and ownership and rejects changes to unshown fields', () => {
  const base = { ...note(), kind: '随记', tags: ['旧标签'] };
  const input = { content: ' 想法 ', tags: ' 甲，乙 ', projectId: 'chosen_project' };
  const draft = createEditorDraft('capture', base, input);
  assert.deepEqual(getEditorDraftWrite('capture', draft, base), { base, values: input });
  const remote = { ...base, sourceAttachmentIds: ['synthetic_new_source'] };
  assert.equal(inspectEditorDraft('capture', draft, remote).state, 'changed');
  assert.deepEqual(editorDraftAsNew('capture', draft).values, input);
});

test('capture drafts retain bounded legacy project options without authorizing a new alias assignment', () => {
  const base = { ...note(), projectId: null, project: '同名项目 / 合成', kind: '随记' };
  const projects = ['one', 'two'].map(id => ({ id, name: base.project, workspace: base.workspace }));
  const projectId = recordProjectSelection(base, projects);
  assert.equal(projectId, 'legacy:' + encodeURIComponent(base.project));
  const draft = createEditorDraft('capture', base, { content: '保留的随记', tags: '', projectId });
  const reopened = inspectEditorDraft('capture', JSON.parse(JSON.stringify(draft)), base);
  assert.equal(reopened.state, 'ready');
  assert.equal(reopened.values.projectId, projectId);
  assert.deepEqual(editedProject(base, reopened.values.projectId, projects), {});
  assert.throws(() => editedProject(null, editorDraftAsNew('capture', draft).values.projectId, projects), /项目/);
  for (const invalid of ['legacy:', 'legacy:%', 'legacy:%20', 'legacy:未编码', 'legacy:' + 'a'.repeat(11994)])
    assert.throws(() => createEditorDraft('capture', base, { content: '', tags: '', projectId: invalid }), { code: 'EDITOR_DRAFT_INVALID' });
  assert.equal(createEditorDraft('capture', base, { content: '', tags: '', projectId: 'legacy:' + 'a'.repeat(11993) }).values.projectId.length, 12000);
});

test('new base null is distinct from a missing base, and cannot overwrite an existing record', () => {
  const fresh = createEditorDraft('note', null, values());
  assert.equal(inspectEditorDraft('note', fresh, null).state, 'ready');
  assert.equal(inspectEditorDraft('note', fresh, note()).reason, 'new-record-already-exists');
  assert.throws(() => createEditorDraft('note', undefined, values()), { code: 'EDITOR_DRAFT_INVALID' });
  const missing = { format: EDITOR_DRAFT_FORMAT, kind: 'note', values: values() };
  assert.equal(inspectEditorDraft('note', missing, null).state, 'invalid');
  assert.throws(() => editorDraftAsNew('note', missing), { code: 'EDITOR_DRAFT_INVALID' });
});

test('deleted or different record identities cannot accept an existing draft', () => {
  const draft = createEditorDraft('note', note(), values());
  assert.equal(inspectEditorDraft('note', draft, null).reason, 'record-removed');
  assert.equal(inspectEditorDraft('note', draft, { ...note(), id: 'different' }).reason, 'record-identity-changed');
});

test('malformed, mismatched and unknown envelopes are not treated as legacy drafts', () => {
  const good = createEditorDraft('note', note(), values());
  for (const raw of [{ ...good, kind: 'capture' }, { ...good, format: 'future-format' }, { ...good, base: [] },
    { ...good, values: { ...values(), content: 42 } }, { title: 'title', content: 'text', extra: 'unknown' }, []]) {
    assert.equal(inspectEditorDraft('note', raw, note()).state, 'invalid');
    assert.throws(() => getEditorDraftWrite('note', raw, note()), { code: 'EDITOR_DRAFT_INVALID' });
  }
});

test('no draft is not a writable new draft and current object is not exposed by reference', () => {
  const current = note();
  for (const raw of [undefined, null]) {
    const review = inspectEditorDraft('note', raw, current);
    assert.equal(review.state, 'none');
    assert.equal(review.canSave, false);
    assert.equal(Object.hasOwn(review, 'base'), false);
    review.current.content = 'UI mutation';
    assert.equal(current.content, '原正文');
  }
});

test('Store.list decorations do not create false conflicts or enter the expected CAS record', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('notes', note());
  const fromList = store.list('notes')[0];
  const draft = createEditorDraft('note', fromList, values());
  assert.deepEqual(draft.base, note());
  const write = getEditorDraftWrite('note', draft, store.get('notes', note().id));
  await store.put('notes', { ...write.base, ...write.values }, write.base);
  assert.equal(store.get('notes', note().id).content, values().content);
  assert.equal(Object.hasOwn(draft.base, '_key'), false);
  const decorated = { ...draft, base: { ...draft.base, _key: 'notes:synthetic_note', _conflict: true } };
  assert.equal(inspectEditorDraft('note', decorated, { ...note(), _key: 'other-view', _conflict: false }).state, 'ready');
});

test('legacy copies without source records have explicit kind and workspace defaults', () => {
  const capture = editorDraftCopy('capture', ' 旧随记\n原始正文 ', null, { id: 'capture_copy', now: 123 });
  assert.deepEqual(capture, { id: 'capture_copy', kind: '随记', workspace: '日常', title: '旧随记（草稿副本）',
    content: ' 旧随记\n原始正文 ', createdAt: 123, updatedAt: 123, userEdited: true, userEditedAt: 123,
    tags: [], projectId: null, project: null });
  const legacy = values(), original = structuredClone(legacy);
  const copiedNote = editorDraftCopy('note', legacy, null, { id: 'note_copy', now: 123 });
  assert.equal(copiedNote.kind, 'note');
  assert.equal(copiedNote.workspace, '科研');
  assert.equal(copiedNote.title, '草稿标题（草稿副本）');
  assert.equal(copiedNote.content, legacy.content);
  assert.deepEqual(legacy, original);
});

test('copies of archived or deleted sources remain visible without changing original or draft', async () => {
  const store = await new Store(new MemoryAdapter()).load();
  const source = { ...note(), kind: '科研笔记', archived: true, archivedAt: 4, deleted: true, deletedAt: 5, status: 'archived' };
  const raw = values(), before = structuredClone(source);
  await store.put('notes', source);
  await store.tx(state => { state.drafts['editor:' + source.id] = raw; });
  const copy = editorDraftCopy('note', raw, store.get('notes', source.id), { id: 'active_copy', now: 10 });
  await store.put('notes', copy);
  assert.equal(store.list('notes').filter(record => !record.archived && !record.deletedAt).some(record => record.id === copy.id), true);
  for (const field of ['archived', 'archivedAt', 'deleted', 'deletedAt', 'status']) assert.equal(Object.hasOwn(copy, field), false);
  assert.equal(copy.kind, '科研笔记');
  assert.equal(copy.workspace, '科研');
  assert.deepEqual(copy.sourceAttachmentIds, source.sourceAttachmentIds);
  assert.deepEqual(copy.custom, source.custom);
  assert.deepEqual(store.get('notes', source.id), before);
  assert.deepEqual(store.state.drafts['editor:' + source.id], raw);
  copy.custom.retained = false;
  assert.equal(source.custom.retained, true);
});

test('a changed draft copies its real baseline metadata, while a new null baseline stays independent', () => {
  const base = { ...note(), kind: 'note', status: 'reviewing', revisionHistory: [{ content: '更早正文' }] };
  const raw = createEditorDraft('note', base, values());
  const current = { ...base, projectId: 'remote_project', workspace: '课程', custom: { retained: false } };
  const copy = editorDraftCopy('note', raw, current, { id: 'baseline_copy', now: 20 });
  assert.equal(copy.projectId, base.projectId);
  assert.equal(copy.workspace, base.workspace);
  assert.equal(copy.status, 'reviewing');
  assert.deepEqual(copy.revisionHistory, base.revisionHistory);
  assert.deepEqual(copy.custom, base.custom);
  copy.revisionHistory[0].content = '仅修改副本';
  assert.equal(raw.base.revisionHistory[0].content, '更早正文');
  const fresh = editorDraftCopy('note', createEditorDraft('note', null, values()), current, { id: 'fresh_copy', now: 20 });
  assert.equal(fresh.workspace, '科研');
  assert.equal(Object.hasOwn(fresh, 'projectId'), false);
  assert.equal(Object.hasOwn(fresh, 'custom'), false);
});

test('capture copies preserve retained aliases but validate explicit project changes and normalized tags', () => {
  const base = { ...note(), kind: '随记', projectId: null, project: '同名合成项目' };
  const projects = ['one', 'two'].map(id => ({ id, name: base.project, workspace: '科研' }));
  const raw = createEditorDraft('capture', base, { content: '草稿正文', tags: ' 甲，乙, , 丙 ', projectId: recordProjectSelection(base, projects) });
  const copy = editorDraftCopy('capture', raw, base, { id: 'capture_alias_copy', projects });
  assert.equal(copy.projectId, null);
  assert.equal(copy.project, base.project);
  assert.deepEqual(copy.tags, ['甲', '乙', '丙']);
  const selected = createEditorDraft('capture', base, { ...raw.values, projectId: 'new_project' });
  assert.throws(() => editorDraftCopy('capture', selected, base, { id: 'invalid_project_copy', projects }), /项目/);
  const changed = editorDraftCopy('capture', selected, base, { id: 'selected_copy', projects: [...projects, { id: 'new_project', name: '课程项目', workspace: '课程' }] });
  assert.equal(changed.projectId, 'new_project');
  assert.equal(changed.project, '课程项目');
  assert.equal(changed.workspace, '课程');
});

test('copy construction rejects invalid drafts and reuse of either source identity', () => {
  const base = note(), current = { ...base, id: 'other_source' }, raw = createEditorDraft('note', base, values());
  for (const id of [base.id, current.id, '', 'invalid:id'])
    assert.throws(() => editorDraftCopy('note', raw, current, { id }), { code: 'EDITOR_DRAFT_INVALID' });
  for (const invalid of [undefined, null, { format: 'unknown' }])
    assert.throws(() => editorDraftCopy('note', invalid, base, { id: 'valid_copy' }), { code: 'EDITOR_DRAFT_INVALID' });
});
