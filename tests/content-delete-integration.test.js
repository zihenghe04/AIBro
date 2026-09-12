const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Lifecycle = require('../content-lifecycle');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const bundle = (id, key, item) => ({ id, type: 'content', title: item.title || item.name || id, deletedAt: 1, data: { [key]: [item] } });
function initial(extra = {}) {
  return { _revision: 4, projects: [], conversations: [], tasks: [], notes: [], papers: [], imports: [], attachments: [], agentRuns: [], links: [], trash: [], lastResults: [], ui: {}, ...extra };
}
function functionSource(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Extract actual app function ${name}`);
  const next = source.slice(match.index).search(/\n(?:async )?function /);
  return source.slice(match.index, next < 0 ? undefined : match.index + next);
}
function harness(extra = {}, options = {}) {
  const calls = [], notices = [], elements = new Map(); let serial = 0;
  const trashUI = {
    render: () => calls.push({ kind: 'trash-render' }),
    clearSelection: () => calls.push({ kind: 'clear-selection' }),
    confirmDelete: async (entries, settings) => {
      calls.push({ kind: 'confirm', ids: Array.from(entries, entry => entry.id), options: settings });
      return typeof options.confirm === 'function' ? options.confirm(entries, settings) : options.confirm !== false;
    },
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, open: false, hidden: false, innerHTML: '', value: '', dataset: {}, close() { this.open = false; }, classList: { toggle() {}, contains() { return false; } } });
    return elements.get(id);
  };
  const context = vm.createContext({
    state: initial(extra), ContentLifecycle: Lifecycle, Lifecycle, Core: {}, Research: {}, WorkstationTrash: trashUI, serverConflict: false,
    trashPurgeInFlight: new Set(), purgingTrashIds: new Set(), purgeInFlight: new Set(),
    uid: prefix => `${prefix}-test-${++serial}`, esc: value => String(value ?? ''), uiIcon: () => '',
    $: selector => element(selector), $$: () => [], document: { body: { dataset: { view: 'trash' } } },
    toast: message => notices.push(String(message)), window: { ContentLifecycle: Lifecycle, WorkstationTrash: trashUI,
      flushWorkspace: async () => options.flush ? options.flush() : true },
    flushWorkspace: async () => { calls.push({ kind: 'flush' }); return options.flush ? options.flush() : true; },
    save: () => calls.push({ kind: 'save' }), renderAll: () => calls.push({ kind: 'render' }),
    showSyncConflict: () => calls.push({ kind: 'conflict' }), persistServerSnapshot: () => calls.push({ kind: 'persist' }),
    repairRelationships() {}, normalizeStateShape(value) { if (value) this.state = value; return value; },
    fileStoreDelete: async id => calls.push({ kind: 'legacy-file-delete', id }), fileDb: async () => options.fileDb ? options.fileDb() : null,
    fetch: async (url, init) => { calls.push({ kind: 'fetch', url, init }); return options.fetch ? options.fetch(url, init) : response({ ok: true, purgedIds: JSON.parse(init.body).ids, revision: 5, removedImportIds: [], retainedImportIds: [], retainedVault: false }); },
    previewRequestVersion: 0, pdfPreviewVersion: 0, pdfPreviewAbort: null,
  });
  const names = ['commitContentState', 'ensureTrashIds', 'resolveTrashEntry', 'trashEntryFor', 'trashEntry', 'sharedImportSnapshot', 'renderTrash', 'restoreTrash', 'purgeTrash'];
  const available = names.filter(name => new RegExp(`(?:async )?function ${name}\\(`).test(source));
  vm.runInContext(available.map(functionSource).join('\n'), context);
  return { c: context, calls, notices, elements };
}

test('recovery by stable bundle ID still restores the chosen content after another bundle changes array positions', () => {
  const h = harness({ trash: [bundle('first', 'tasks', { id: 'task-one', title: 'One' }), bundle('second', 'notes', { id: 'note-two', title: 'Two' })] });
  h.c.restoreTrash(0); // Existing callers using a numeric reference remain supported.
  assert.deepEqual(Array.from(h.c.state.tasks, item => item.id), ['task-one']);
  h.c.restoreTrash('second');
  assert.deepEqual(Array.from(h.c.state.notes, item => item.id), ['note-two']);
  assert.equal(h.c.state.trash.length, 0);
});

test('restoration does not overwrite a live record and keeps only unresolved content in the same bundle', () => {
  const entry = bundle('mixed', 'tasks', { id: 'task', title: 'Older copy' });
  entry.data.notes = [{ id: 'note', title: 'Independent note', content: 'Research record' }];
  const h = harness({ tasks: [{ id: 'task', title: 'User edited current copy' }], trash: [entry] });
  h.c.restoreTrash('mixed');
  assert.equal(h.c.state.tasks[0].title, 'User edited current copy');
  assert.equal(h.c.state.notes[0].content, 'Research record');
  assert.equal(h.c.state.trash[0].id, 'mixed');
  assert.equal(h.c.state.trash[0].data.tasks[0].title, 'Older copy');
  assert.equal(h.c.state.trash[0].data.notes.length, 0);
});

test('restoring an absent stable bundle ID is a no-op rather than a fallback to another item', () => {
  const h = harness({ trash: [bundle('real', 'tasks', { id: 'task', title: 'Keep in trash' })] });
  const before = JSON.stringify(h.c.state);
  h.c.restoreTrash('already-restored');
  assert.equal(JSON.stringify(h.c.state), before);
});

test('permanent deletion cannot contact the server before outstanding workspace changes are saved', async () => {
  const h = harness({ trash: [bundle('chosen', 'imports', { id: 'pdf', name: 'Source.pdf' })] }, { flush: async () => false });
  await h.c.purgeTrash('chosen');
  assert.equal(h.calls.filter(call => call.kind === 'fetch').length, 0);
  assert.equal(h.c.state.trash[0].id, 'chosen');
});

test('cancelling async confirmation does not save, flush or issue a deletion request', async () => {
  const confirming = deferred(), h = harness({trash:[bundle('chosen','tasks',{id:'task',title:'Keep'})]}, {confirm:()=>confirming.promise});
  const before = JSON.stringify(h.c.state), pending = h.c.purgeTrash(['chosen'], {empty:true});
  await drain();assert.equal(h.c.purgeTrash.confirming,true);assert.equal(h.calls.filter(call=>['save','flush','fetch'].includes(call.kind)).length,0);
  h.c.restoreTrash('chosen');await h.c.purgeTrash(['chosen']);assert.equal(h.calls.filter(call=>call.kind==='confirm').length,1,'Pending confirmation blocks reentry');
  confirming.resolve(false);await pending;assert.equal(JSON.stringify(h.c.state),before);assert.equal(h.c.purgeTrash.confirming,false);
  assert.equal(h.calls.filter(call=>['save','flush','fetch','clear-selection'].includes(call.kind)).length,0);
});

test('empty and oversized selections never open confirmation or start persistence', async () => {
  const entries = Array.from({length:2001},(_,index)=>bundle('bin-'+index,'tasks',{id:'task-'+index}));
  const h = harness({trash:entries});await h.c.purgeTrash([]);await h.c.purgeTrash(entries.map(entry=>entry.id));
  assert.equal(h.calls.some(call=>['confirm','save','flush','fetch'].includes(call.kind)),false);
});

test('three-item batch confirms and sends one exact ID scope, then clears selection once', async () => {
  const h = harness({trash:['one','two','three','keep'].map(id=>bundle(id,'tasks',{id:'task-'+id}))});
  await h.c.purgeTrash(['three','one','two'],{bulk:true});
  const requests = h.calls.filter(call=>call.kind==='fetch');assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0].init.body),{ids:['three','one','two'],revision:4});
  assert.deepEqual(Array.from(h.c.state.trash,entry=>entry.id),['keep']);assert.equal(h.calls.filter(call=>call.kind==='clear-selection').length,1);
});

for (const failure of ['network', 409, 500]) test(`permanent deletion retains the recovery bundle after ${failure} failure`, async () => {
  const h = harness({ trash: [bundle('chosen', 'imports', { id: 'pdf', name: 'Source.pdf' })] }, {
    fetch: async () => { if (failure === 'network') throw new Error('Network unavailable'); return response({ error: 'Deletion did not commit' }, failure); }
  });
  await h.c.purgeTrash('chosen');
  assert.equal(h.calls.filter(call => call.kind === 'fetch').length, 1);
  assert.equal(h.c.state.trash[0].id, 'chosen');
  assert.equal(h.c.state._revision, 4);
  assert.equal(h.calls.filter(call => call.kind === 'legacy-file-delete').length, 0);
});

test('pending permanent deletion is single-flight and recovery of that same bundle is blocked', async () => {
  const wait = deferred();
  const h = harness({ trash: [bundle('chosen', 'imports', { id: 'pdf', name: 'Source.pdf' })] }, { fetch: () => wait.promise });
  const first = h.c.purgeTrash('chosen'); await drain();
  const repeated = h.c.purgeTrash('chosen');
  h.c.restoreTrash('chosen');
  await drain();
  assert.equal(h.calls.filter(call => call.kind === 'fetch').length, 1);
  assert.equal(h.c.state.imports.length, 0, 'An original must not be restored while its bytes are being removed');
  wait.resolve(response({ ok: true, purgedIds: ['chosen'], revision: 5, removedImportIds: ['pdf'], retainedImportIds: [], retainedVault: false }));
  await Promise.all([first, repeated]);
  assert.equal(h.c.state.trash.length, 0);
});

test('permanent deletion captures the target ID before waiting and preserves other edits and shared files', async () => {
  const wait = deferred();
  const h = harness({ imports: [{ id: 'shared-pdf', name: 'Retained original.pdf' }], trash: [
    bundle('older', 'tasks', { id: 'old-task', title: 'Older bundle' }),
    bundle('chosen', 'imports', { id: 'shared-pdf', name: 'Old original.pdf' })
  ] }, { fetch: () => wait.promise });
  const pending = h.c.purgeTrash(1); await drain();
  h.c.restoreTrash('older');
  assert.equal(h.c.state.trash.some(entry=>entry.id==='older'),true,'Row restoration is disabled for the whole in-flight operation');
  // Other application work can still update content while the network is
  // pending; exercise that path independently of the disabled restore button.
  h.c.commitContentState(Lifecycle.restore(h.c.state,'older').state);
  h.c.state.tasks.push({ id: 'new-task', title: 'Edit made while waiting' });
  h.c.state.trash.push(bundle('newer', 'notes', { id: 'later-note', title: 'Added while waiting' }));
  wait.resolve(response({ ok: true, purgedIds: ['chosen'], revision: 5, removedImportIds: [], retainedImportIds: ['shared-pdf'], retainedVault: true }));
  await pending;
  assert.deepEqual(Array.from(h.c.state.trash, item => item.id), ['newer']);
  assert.deepEqual(Array.from(h.c.state.tasks, item => item.id), ['old-task', 'new-task']);
  assert.equal(h.c.state.imports[0].id, 'shared-pdf');
  assert.equal(h.calls.filter(call => call.kind === 'legacy-file-delete').length, 0, 'Frontend must not override server reference protection');
  assert.equal(h.c.state._revision, 5);
});

test('an incomplete successful HTTP response cannot remove a bundle without a committed revision', async () => {
  for (const revision of [undefined, null, 'invalid', 3, 4]) {
    const h = harness({ trash: [bundle('chosen', 'tasks', { id: 'task', title: 'Retain until commit is verified' })] }, {
      fetch: async () => response({ ok: true, purgedIds: ['chosen'], revision, removedImportIds: [] })
    });
    await h.c.purgeTrash('chosen');
    assert.equal(h.c.state.trash.length, 1, `Invalid revision ${revision} must not count as a verified commit`);
    assert.equal(h.c.state._revision, 4);
  }
});

test('a successful response with a missing, partial or wrong purged scope is not accepted locally', async () => {
  for (const purgedIds of [undefined, ['one'], ['one','one'], ['one','wrong']]) {
    const h=harness({trash:[bundle('one','tasks',{id:'a'}),bundle('two','tasks',{id:'b'})]}, {
      fetch:async()=>response({ok:true,purgedIds,revision:5,removedImportIds:[]})
    });
    await h.c.purgeTrash(['one','two']);assert.equal(h.c.state.trash.length,2);assert.equal(h.c.state._revision,4);assert.equal(h.c.serverConflict,true);
    assert.equal(h.calls.filter(call=>call.kind==='clear-selection').length,0);
  }
});

test('local cache failure after a confirmed server commit does not pretend the original is still recoverable', async () => {
  let requestFinished = false;
  const h = harness({ trash: [bundle('chosen', 'imports', { id: 'pdf', name: 'Original.pdf' })] }, {
    fetch: async () => { requestFinished = true; return response({ ok: true, purgedIds: ['chosen'], revision: 5, removedImportIds: ['pdf'], retainedImportIds: [] }); },
    fileDb: async () => { throw new Error('IndexedDB unavailable'); }
  });
  await h.c.purgeTrash('chosen');
  assert.equal(requestFinished, true);
  assert.equal(h.c.state.trash.length, 0);
  assert.equal(h.c.state._revision, 5);
  assert.ok(h.calls.filter(call => call.kind === 'save').length >= 2, 'Confirmed state must be persisted despite cache cleanup failure');
  assert.doesNotMatch(h.notices.join('\n'), /回收记录已保留/);
});

test('cache cleanup is limited to confirmed unused blobs and never invokes external filesystem deletion', async () => {
  const deletedCacheIds = [];
  const db = { transaction() {
    const tx = { objectStore: () => ({ delete(id) { deletedCacheIds.push(id); queueMicrotask(() => tx.oncomplete?.()); } }) };
    return tx;
  } };
  const h = harness({ imports: [{ id: 'live', name: 'Referenced.pdf' }], trash: [
    { id: 'chosen', type: 'content', data: { imports: [{ id: 'orphan' }, { id: 'live' }, { id: 'other-trash' }] } },
    bundle('retained', 'imports', { id: 'other-trash', name: 'Other recoverable original.pdf' })
  ] }, {
    fetch: async () => response({ ok: true, purgedIds: ['chosen'], revision: 5, removedImportIds: ['orphan', 'live', 'other-trash'], retainedImportIds: [] }),
    fileDb: async () => db
  });
  await h.c.purgeTrash('chosen');
  assert.deepEqual(deletedCacheIds, ['orphan']);
  assert.equal(h.calls.filter(call => call.kind === 'legacy-file-delete').length, 0);
  assert.equal(h.c.state.imports[0].id, 'live');
  assert.equal(h.c.state.trash[0].id, 'retained');
});

test('content removal cancels the selected preview but preserves live conversation and execution objects', () => {
  const conversation = { id: 'chat', attachments: ['pdf'], messages: [], draft: 'Unsaved conversation draft' };
  const run = { id: 'run', conversationId: 'chat', status: 'running' };
  const h = harness({ imports: [{ id: 'pdf', name: 'Original.pdf' }], conversations: [conversation], agentRuns: [run], previewRecord: { type: 'import', id: 'pdf' } });
  h.c.$('#previewDialog').open = true;
  let aborts = 0; h.c.pdfPreviewAbort = { abort() { aborts++; } };
  const outcome = Lifecycle.remove(h.c.state, [{ type: 'import', id: 'pdf' }], {}, { uid: () => 'removed-source' });
  h.c.commitContentState(outcome.state);
  assert.equal(h.c.state.conversations[0], conversation);
  assert.equal(h.c.state.agentRuns[0], run);
  assert.equal(conversation.draft, 'Unsaved conversation draft');
  assert.deepEqual(Array.from(conversation.attachments), []);
  assert.equal(h.c.$('#previewDialog').open, false);
  assert.equal(h.c.state.previewRecord, null);
  assert.equal(h.c.previewRequestVersion, 1); assert.equal(h.c.pdfPreviewVersion, 1);
  assert.equal(aborts, 1);
});

test('deleting a task source refreshes the open detail dialog without discarding any unsaved input', () => {
  const task = { id: 'task', title: 'Saved task title', description: 'Saved description', status: 'todo', priority: 'medium', dueAt: '2026-10-02', projectId: 'original-project', sourceAttachmentIds: ['source'], checklist: [] };
  const originalTask = clone(task);
  const h = harness({ tasks: [task], imports: [{ id: 'source', name: 'Appointment.pdf' }], openTaskId: 'task' });
  h.c.$('#taskDialog').open = true;
  const draft = {
    taskTitleInput: '尚未保存的新标题', taskDescriptionInput: '第一行说明\n第二行补充',
    taskStatusInput: 'blocked', taskPriorityInput: 'high', taskDueInput: '2026-11-12',
    taskTimeInput: '14:35', taskProjectInput: 'new-project', newChecklistItem: '尚未添加的检查项',
  };
  for (const [id, value] of Object.entries(draft)) h.c.$(`#${id}`).value = value;
  const oldInputs = Object.fromEntries(Object.keys(draft).map(id => [id, h.c.$(`#${id}`)]));
  let refreshes = 0;
  h.c.renderTaskDialog = currentTask => {
    refreshes++;
    assert.equal(currentTask.id, 'task');
    // Real renderTaskDialog replaces the input elements, initially populating
    // them from stored values. Exercise that replacement, not the old nodes.
    for (const id of Object.keys(draft)) h.elements.set(`#${id}`, { ...oldInputs[id], value: `stored-default:${id}` });
    h.c.$('#taskSourceRows').innerHTML = h.c.state.imports.filter(item => currentTask.sourceAttachmentIds.includes(item.id)).map(item => item.id).join(',');
  };
  const outcome = Lifecycle.remove(h.c.state, [{ type: 'import', id: 'source' }], {}, { uid: () => 'deleted-source' });
  h.c.commitContentState(outcome.state);
  assert.equal(refreshes, 1);
  assert.equal(h.c.$('#taskDialog').open, true);
  for (const [id, value] of Object.entries(draft)) {
    assert.notEqual(h.c.$(`#${id}`), oldInputs[id]);
    assert.equal(h.c.$(`#${id}`).value, value, `${id} must retain its unsaved value after source refresh`);
  }
  assert.equal(h.c.$('#taskSourceRows').innerHTML, '');
  assert.deepEqual(clone(h.c.state.tasks[0]), originalTask, 'Preserving form drafts must not silently save them into the task');
  assert.equal(h.c.state.trash[0].data.imports[0].id, 'source');
});

test('ordinary edits remain local while purge is in flight, then save once against the purge revision', { timeout: 2000 }, async () => {
  const waiting = deferred(), started = deferred(), snapshots = [];
  let snapshotCount = 0;
  const h = harness({ trash: [bundle('chosen', 'imports', { id: 'pdf', name: 'Original.pdf' })] }, {
    fetch: async (url, init) => {
      if (url === '/__state') {
        snapshots.push(JSON.parse(init.body)); snapshotCount++;
        return response({ ok: true, revision: snapshotCount === 1 ? 5 : 7 });
      }
      assert.equal(url, '/__trash/purge');
      assert.equal(JSON.parse(init.body).revision, 5);
      assert.deepEqual(JSON.parse(init.body).ids, ['chosen']);
      started.resolve();
      return waiting.promise;
    }
  });
  const stored = new Map(), timers = new Map(); let timerId = 0;
  Object.assign(h.c, {
    STORAGE_KEY: 'test-workspace', storageHydrated: true, initializingUI: false,
    localEditVersion: 0, serverSaveInFlight: false, serverSaveQueued: false, serverSaveTimer: null,
    ensureConversation() {},
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    flushWorkspace: async () => { h.c.persistServerSnapshot(); await drain(); },
  });
  const start = source.indexOf('function persistServerSnapshot('), end = source.indexOf('\nwindow.flushWorkspace', start);
  assert.ok(start >= 0 && end > start, 'Exercise actual save scheduler and actual purge together');
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.actualSave = save;`, h.c);
  const pending = h.c.purgeTrash('chosen'); await started.promise;
  assert.equal(snapshots.length, 1, 'Initial flush saves the starting revision before purge begins');
  assert.ok(h.calls.some(call => call.url === '/__trash/purge'), `Purge request should be waiting: ${h.notices.join(' | ')}`);
  h.c.state.notes.push({ id: 'during-purge', title: 'New note written while deleting', content: 'Must survive' });
  h.c.actualSave();
  h.c.persistServerSnapshot(); await drain();
  assert.equal(snapshots.length, 1, 'The ordinary save timer must not race the in-flight purge with the old revision');
  assert.equal(JSON.parse(stored.get('test-workspace')).notes[0].content, 'Must survive', 'Local durability continues while network writes pause');
  waiting.resolve(response({ ok: true, purgedIds: ['chosen'], revision: 6, removedImportIds: ['pdf'], retainedImportIds: [] }));
  await pending; await drain();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]._revision, 6);
  assert.equal(snapshots[1].notes[0].id, 'during-purge');
  assert.equal(snapshots[1].trash.length, 0);
  assert.equal(h.c.state._revision, 7); assert.equal(h.c.serverConflict, false);
  assert.equal(h.calls.some(call => call.kind === 'conflict'), false);
});
