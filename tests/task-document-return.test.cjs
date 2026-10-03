'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const DocumentOrigin = require('../app/document-origin');
const CitationEvidence = require('../app/citation-evidence');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const cut = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const plain = x => JSON.parse(JSON.stringify(x));
function harness() {
  const nodes = new Map(), dependencies = [], calls = [];
  const document = { body: { dataset: { view: 'project' } }, activeElement: null,
    createElement: tag => node('', tag), querySelectorAll: selector => selector.endsWith(':checked') ? dependencies.filter(n => n.checked) : dependencies };
  function node(id, tag = 'input', value = '') {
    const n = { id, tagName: tag, value, dataset: {}, scrollTop: 0, listeners: {}, children: [],
      append(x) { this.children.push(x); if (x.id) nodes.set(x.id, x); }, replaceChildren() { this.children = []; nodes.delete('taskDeliverableRef'); },
      focus() { document.activeElement = this; }, setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); },
      showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(type, fn) { this.listeners[type] = fn; },
      fire(type, event = {}) { return this.listeners[type]?.(event); } };
    if (id) nodes.set(id, n); return n;
  }
  for (const id of ['taskDialog', 'taskForm', 'taskDialogBody', 'runHistoryDialog', 'saveTask']) node(id);
  const state = { projects: [{ id: 'p', name: 'P', workspace: '科研' }, { id: 'q', name: 'Q', workspace: '课程' }], notes: [{ id: 'n', projectId: 'p', title: 'N' }],
    tasks: [{ id: 'a', title: 'saved A', description: 'saved description', projectId: 'p', workspace: '科研', status: 'todo', priority: 'medium', checklist: [], deliverable: { kind: 'text', mustInclude: 'saved keyword' } }, { id: 'b', title: 'saved B', projectId: 'q', workspace: '课程', checklist: [] }],
    conversations: [], currentProjectId: 'p', ui: { projectTab: 'tasks' } };
  const $ = selector => nodes.get(selector.replace(/^#/, ''));
  const window = { DocumentOrigin, CitationEvidence, TaskWorkflow: require('../app/task-workflow'), PrivateMode: { isOn: () => false }, TaskDeliverable: { normalize: x => x || null, validate: () => ({ ok: true }) } };
  const c = vm.createContext({ state, document, window, DocumentOrigin, TaskDeliverable: window.TaskDeliverable, $, toast: text => calls.push(['toast', text]), Option: function(text, value) { return { text, value }; },
    saveDocumentDurably: async () => { calls.push(['save']); return true; }, save: () => calls.push(['save']), renderAll: () => {}, taskDueValue: () => null, workspaceName: x => x, visibleProject: () => true });
  vm.runInContext(cut('const taskEditorContexts =', 'function taskSources('), c);
  vm.runInContext(cut('function openTask(', '// 产出要求编辑器'), c);
  vm.runInContext(cut('function renderDeliverableEditor(', '\nfunction toggleTaskStatus('), c);
  vm.runInContext(cut('function restorePreviewTask(', "\n$('#previewOrganize')"), c);
  vm.runInContext(cut("// TaskDetailSurface owns form submit", "\n$('#previewDelete')"), c);
  // The fixture only models the real renderTaskDialog's DOM replacement. Its
  // production field, routing, parking, restore, cancel and save functions run.
  c.renderTaskDialog = task => {
    calls.push(['render', task.id]);
    for (const id of vm.runInContext('taskEditorFields', c)) { if (id !== 'taskDeliverableRef') node(id); }
    node('taskDeliverableValue', 'span');
    $('#taskTitleInput').value = task.title; $('#taskDescriptionInput').value = task.description || '';
    $('#taskStatusInput').value = task.status || 'todo'; $('#taskPriorityInput').value = task.priority || 'medium';
    $('#taskWorkflowInput').value = window.TaskWorkflow.category(task) || '';
    $('#taskWorkspaceInput').value = task.workspace; $('#taskProjectInput').value = task.projectId || ''; $('#taskReminderInput').value = 'inherit';
    dependencies.splice(0, dependencies.length, { dataset: { dependencyId: 'dep' }, checked: false });
    c.renderDeliverableEditor(task);
  };
  const park = () => { c.parkTaskEditor(); $('#taskDialog').close(); };
  return { c, state, $, node, document, window, dependencies, calls, park, context: id => vm.runInContext(`taskEditorContexts.get(${JSON.stringify(id)})`, c) };
}

test('native task entry is captured separately from the hidden renderer and is route-only', () => {
  const h = harness(); assert.equal(h.c.openTask('a', { origin: { view: 'agenda', title: 'do not retain' } }), true);
  assert.deepEqual(plain(h.c.taskDocumentOrigin()), { view: 'task', id: 'a', entry: { view: 'agenda' } });
  assert.equal(JSON.stringify(h.state).includes('do not retain'), false);
  assert.equal(h.c.openTask('a', { origin: { view: 'project', projectId: 'missing', section: 'tasks' } }), false);
});
test('same-task return keeps unsaved deliverable, planning, dependencies, scroll, focus and text selection', () => {
  const h = harness(); h.c.openTask('a', { origin: { view: 'overview' } });
  Object.assign(h.$('#taskTitleInput'), { value: 'unsaved A' }); h.$('#taskDeliverableRef').value = 'unsaved keyword';
  h.$('#taskWorkspaceInput').value = '课程'; h.$('#taskProjectInput').value = 'q'; h.$('#taskStartInput').value = '2026-10-02'; h.dependencies[0].checked = true;
  h.$('#taskDescriptionInput').value = 'unsaved description'; h.$('#taskDescriptionInput').focus(); h.$('#taskDescriptionInput').setSelectionRange(2, 8, 'backward');
  h.$('#taskDialogBody').scrollTop = 140; h.$('#taskDialog').scrollTop = 20; h.park();
  h.state.tasks = JSON.parse(JSON.stringify(h.state.tasks)); assert.equal(h.c.restorePreviewTask('a'), true);
  assert.equal(h.$('#taskTitleInput').value, 'unsaved A'); assert.equal(h.$('#taskDeliverableRef').value, 'unsaved keyword');
  assert.equal(h.$('#taskWorkspaceInput').value, '课程'); assert.equal(h.$('#taskProjectInput').value, 'q'); assert.equal(h.$('#taskStartInput').value, '2026-10-02'); assert.equal(h.dependencies[0].checked, true);
  assert.equal(h.document.activeElement.id, 'taskDescriptionInput'); assert.equal(h.document.activeElement.selectionStart, 2); assert.equal(h.document.activeElement.selectionEnd, 8); assert.equal(h.document.activeElement.selectionDirection, 'backward');
  assert.equal(h.$('#taskDialogBody').scrollTop, 140); assert.equal(h.$('#taskDialog').scrollTop, 20);
  assert.equal(h.state.tasks[0].title, 'saved A'); assert.equal(h.calls.some(x => x[0] === 'save'), false);
});
test('two parked task forms never borrow fields or entry and changing deliverable kinds restores its value control', () => {
  const h = harness(); h.c.openTask('a', { origin: { view: 'overview' } }); h.$('#taskTitleInput').value = 'draft A'; h.park();
  h.c.openTask('b', { origin: { view: 'agenda' } }); h.$('#taskTitleInput').value = 'draft B'; h.$('#taskDeliverableKind').value = 'text'; h.c.renderDeliverableEditor(h.state.tasks[1]); h.$('#taskDeliverableRef').value = 'draft B keyword'; h.park();
  h.c.restorePreviewTask('a'); assert.equal(h.$('#taskTitleInput').value, 'draft A'); assert.equal(h.c.taskDocumentOrigin().entry.view, 'overview'); h.park();
  h.c.restorePreviewTask('b'); assert.equal(h.$('#taskTitleInput').value, 'draft B'); assert.equal(h.$('#taskDeliverableRef').value, 'draft B keyword'); assert.equal(h.c.taskDocumentOrigin().entry.view, 'agenda');
  assert.equal(JSON.stringify(h.state).includes('draft A'), false); assert.equal(JSON.stringify(h.state).includes('draft B'), false);
});
test('explicit form cancel and Escape discard parked inputs, while saving clears them after committing', async () => {
  for (const via of ['cancel', 'escape', 'save']) {
    const h = harness(); h.c.openTask('a'); h.$('#taskTitleInput').value = 'draft A'; h.park(); h.c.restorePreviewTask('a');
    if (via === 'cancel') h.$('#taskDialog').fire('submit', { submitter: { value: 'cancel' } });
    if (via === 'escape') h.$('#taskDialog').fire('cancel');
    if (via === 'save') await h.c.saveTaskDetails();
    h.$('#taskDialog').close(); assert.equal(h.context('a'), undefined);
    h.c.restorePreviewTask('a'); assert.equal(h.$('#taskTitleInput').value, via === 'save' ? 'draft A' : 'saved A');
  }
});
test('deleted, duplicate, private and owner-revoked tasks cannot resurrect their parked fields', () => {
  for (const mutate of [h => { h.state.tasks = []; }, h => { h.state.tasks.push({ ...h.state.tasks[0] }); }, h => { h.state.tasks[0].private = true; }, h => { h.state.projects[0].archived = true; }]) {
    const h = harness(); h.c.openTask('a'); h.$('#taskTitleInput').value = 'draft A'; h.park(); mutate(h);
    assert.equal(h.c.restorePreviewTask('a'), false); assert.equal(h.context('a'), undefined); assert.equal(h.$('#taskDialog').open, false);
  }
});
test('revoked entry refuses restore without deleting still-available task draft; lifecycle rebuild retains all fields', () => {
  const h = harness(); h.c.openTask('a', { origin: { view: 'project', projectId: 'q', section: 'tasks' } }); h.$('#taskTitleInput').value = 'draft A'; h.$('#taskDeliverableRef').value = 'draft criterion';
  h.c.rebuildTaskEditor(h.state.tasks[0]); assert.equal(h.$('#taskDeliverableRef').value, 'draft criterion'); h.park(); h.state.projects[1].archived = true;
  assert.equal(h.c.restorePreviewTask('a'), false); assert.equal(h.context('a').draft.fields.taskTitleInput, 'draft A'); assert.equal(h.$('#taskDialog').open, false);
});


test('task save waits for durable ACK, blocks Escape/cancel and clears draft only afterwards', async () => {
  const h=harness(); h.c.openTask('a'); h.$('#taskTitleInput').value='new title';
  let ack; h.c.saveDocumentDurably=()=>new Promise(resolve=>ack=resolve);
  const pending=h.c.saveTaskDetails(); assert.equal(h.$('#taskDialog').open,true); assert.ok(h.context('a'));
  let blocked=0; h.$('#taskDialog').fire('cancel',{preventDefault(){blocked++;}}); h.$('#taskDialog').fire('submit',{submitter:{value:'cancel'},preventDefault(){blocked++;}});
  assert.equal(blocked,2); assert.equal(await h.c.saveTaskDetails(),false);
  ack(true); assert.equal(await pending,true); assert.equal(h.$('#taskDialog').open,false); assert.equal(h.context('a'),undefined);
});
test('false receipt rolls back mutation while preserving user input and later retry succeeds', async () => {
  const h=harness();h.c.openTask('a');h.$('#taskTitleInput').value='unsaved title';h.c.saveDocumentDurably=async()=>false;
  assert.equal(await h.c.saveTaskDetails(),false);assert.equal(h.state.tasks[0].title,'saved A');assert.equal(h.$('#taskTitleInput').value,'unsaved title');assert.equal(h.$('#taskDialog').open,true);assert.ok(h.context('a'));
  h.c.saveDocumentDurably=async()=>true;assert.equal(await h.c.saveTaskDetails(),true);assert.equal(h.state.tasks[0].title,'unsaved title');
});
test('task editor rejects a changed saved version without publishing any candidate properties', async () => {
  const h=harness();h.c.openTask('a');h.$('#taskTitleInput').value='mine';h.state.tasks[0].description='external';
  assert.equal(await h.c.saveTaskDetails(),false);assert.equal(h.state.tasks[0].title,'saved A');assert.equal(h.state.tasks[0].description,'external');assert.equal(h.$('#taskTitleInput').value,'mine');assert.equal(h.calls.some(x=>x[0]==='save'),false);
});
test('failed save cannot overwrite concurrent task edits and completed candidates must pass deliverable validation', async () => {
  const h=harness();h.c.openTask('a');h.$('#taskTitleInput').value='mine';let fail;h.c.saveDocumentDurably=()=>new Promise(resolve=>fail=resolve);
  const pending=h.c.saveTaskDetails();h.state.tasks[0].description='concurrent description';fail(false);await pending;assert.equal(h.state.tasks[0].description,'concurrent description');
  const v=harness();v.c.openTask('a');v.$('#taskStatusInput').value='done';v.$('#taskTitleInput').value='changed';v.window.TaskDeliverable.validate=()=>({ok:false});v.window.TaskDeliverable.message=()=> 'Missing deliverable';
  assert.equal(await v.c.saveTaskDetails(),false);assert.equal(v.state.tasks[0].status,'todo');assert.equal(v.state.tasks[0].title,'saved A');assert.equal(v.$('#taskDialog').open,true);
});


test('in-place concurrent object edit cannot be rolled back or claimed as the submitted save', async () => {
 for(const receipt of [false,true]) {
  const h=harness();h.c.openTask('a');h.$('#taskDeliverableRef').value='local criterion';let ack;h.c.saveDocumentDurably=()=>new Promise(resolve=>ack=resolve);
  const pending=h.c.saveTaskDetails();h.state.tasks[0].deliverable.mustInclude='external criterion';ack(receipt);assert.equal(await pending,false);
  assert.equal(h.state.tasks[0].deliverable.mustInclude,'external criterion');assert.equal(h.$('#taskDialog').open,true);assert.ok(h.context('a'));
 }
});
test('task dirty detection protects current and parked drafts but does not block pristine forms', () => {
 const h=harness();h.c.openTask('a');assert.equal(h.c.taskEditorHasDrafts(),false);h.$('#taskTitleInput').value='draft';assert.equal(h.c.taskEditorHasDrafts(),true);h.park();assert.equal(h.c.taskEditorHasDrafts(),true);h.c.clearTaskEditorContext('a');assert.equal(h.c.taskEditorHasDrafts(),false);
});

function ownedSurface(h, extra = {}) {
  const mounts = [], opens = [], requests = [];
  h.state.imports ||= [];
  h.c.projectForTask = task => h.c.state.projects.find(item => item.id === task.projectId);
  h.c.taskSources = () => ({ materials: extra.materials || [], knowledge: extra.knowledge || [] });
  h.c.taskDueFields = value => ({ date: value || '', time: '' });
  h.c.openNote = (...args) => opens.push(['note', ...args]);
  h.c.openImport = (...args) => opens.push(['import', ...args]);
  h.c.deleteTask = id => opens.push(['delete', id]);
  if (extra.notifications) h.window.workstationDesktop = { agendaNotifications: () => new Promise(resolve => requests.push(resolve)) };
  const HalaskaUI = { mount(host, name, props) {
    assert.equal(name, 'TaskDetailSurface');
    let draft = plain(props.initial);
    const sync = () => { for (const [id, value] of Object.entries(draft.fields)) h.node(id).value = value; };
    sync();
    const handle = { capture: () => plain(draft), restore(next) { draft = { ...draft, ...plain(next), fields: { ...draft.fields, ...plain(next.fields || {}) } }; sync(); }, requestCancel() { opens.push(['request-cancel']); } };
    const island = { updates: [], unmount() { this.detached = true; }, update(next) { this.updates.push(next); } };
    props.onReady(handle); mounts.push({ props, handle, island }); return island;
  } };
  h.window.HalaskaUI = HalaskaUI; h.c.HalaskaUI = HalaskaUI;
  vm.runInContext(cut('function renderTaskDialog(', '\nfunction openTask('), h.c);
  return { mounts, opens, requests, latest: () => mounts.at(-1) };
}

test('owned Kit checklist draft changes neither task nor disk before the common save', async () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');
  ui.latest().handle.restore({ checklist:[{text:'Draft checklist',done:true,extra:'retained'}] });
  assert.deepEqual(plain(h.state.tasks[0].checklist),[]);assert.equal(h.calls.some(x=>x[0]==='save'),false);assert.equal(h.c.taskEditorHasDrafts(),true);
  h.c.saveDocumentDurably=async()=>false;assert.equal(await h.c.saveTaskDetails(),false);assert.deepEqual(plain(h.state.tasks[0].checklist),[]);
  assert.equal(ui.latest().handle.capture().checklist[0].text,'Draft checklist');assert.equal(h.$('#taskDialog').open,true);
  h.c.saveDocumentDurably=async()=>true;assert.equal(await h.c.saveTaskDetails(),true);
  assert.deepEqual(plain(h.state.tasks[0].checklist),[{text:'Draft checklist',done:true,extra:'retained'}]);
});

test('owned restore updates React adapter fields, checklist and disclosure state together across document return', () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');
  ui.latest().handle.restore({fields:{taskTitleInput:'Kit draft',taskDeliverableKind:'text',taskDeliverableRef:'changed ref'},checklist:[{text:'One',done:false}],groups:{properties:true,sources:true,completion:true}});
  h.$('#taskDescriptionInput').focus();h.$('#taskDescriptionInput').setSelectionRange(1,4,'forward');h.$('#taskDialog').scrollTop=180;h.park();
  h.state.tasks=plain(h.state.tasks);assert.equal(h.c.restorePreviewTask('a'),true);
  const draft=ui.latest().handle.capture();assert.equal(draft.fields.taskTitleInput,'Kit draft');assert.equal(h.$('#taskTitleInput').value,'Kit draft');assert.equal(draft.fields.taskDeliverableRef,'changed ref');assert.equal(draft.checklist[0].text,'One');assert.equal(draft.groups.sources,true);
  assert.equal(h.document.activeElement.id,'taskDescriptionInput');assert.equal(h.document.activeElement.selectionStart,1);assert.equal(h.$('#taskDialog').scrollTop,180);
  assert.equal(h.state.tasks[0].checklist.length,0);assert.equal(h.calls.some(x=>x[0]==='save'),false);
});

test('saving includes a pending checklist input once and retains it after a failed receipt', async () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');
  ui.latest().handle.restore({fields:{newChecklistItem:'  Still being entered  '},checklist:[{text:'Existing step',done:true}]});
  h.c.saveDocumentDurably=async()=>false;
  assert.equal(await h.c.saveTaskDetails(),false);
  assert.deepEqual(plain(h.state.tasks[0].checklist),[]);
  assert.equal(ui.latest().handle.capture().fields.newChecklistItem,'  Still being entered  ');
  assert.equal(ui.latest().handle.capture().checklist.length,1);
  h.c.saveDocumentDurably=async()=>true;
  assert.equal(await h.c.saveTaskDetails(),true);
  assert.deepEqual(plain(h.state.tasks[0].checklist),[{text:'Existing step',done:true},{text:'Still being entered',done:false}]);
});

test('checklist version conflicts block save before mutation and do not replace external steps', async () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');ui.latest().handle.restore({checklist:[{text:'Local',done:false}]});
  h.state.tasks[0].checklist=[{text:'External',done:true}];assert.equal(await h.c.saveTaskDetails(),false);
  assert.equal(h.state.tasks[0].checklist[0].text,'External');assert.equal(ui.latest().handle.capture().checklist[0].text,'Local');assert.equal(h.calls.some(x=>x[0]==='save'),false);
});

test('failed checklist save cannot roll back in-place concurrent changes', async () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');ui.latest().handle.restore({checklist:[{text:'Local',done:false}]});let ack;h.c.saveDocumentDurably=()=>new Promise(resolve=>ack=resolve);
  const pending=h.c.saveTaskDetails();h.state.tasks[0].checklist[0].text='External';ack(false);assert.equal(await pending,false);assert.equal(h.state.tasks[0].checklist[0].text,'External');assert.equal(ui.latest().handle.capture().checklist[0].text,'Local');
});

test('replaced island callbacks and late notification answers cannot act on a newer form with the same task and intent', async () => {
  const h=harness(),ui=ownedSurface(h,{notifications:true});h.c.openTask('a');const old=ui.latest();
  h.c.rebuildTaskEditor(h.state.tasks[0]);const latest=ui.latest();assert.equal(old.island.detached,true);
  old.props.onSave();old.props.onDelete();old.props.onOpen('note','n',{});old.props.onCancel();assert.equal(ui.opens.length,0);assert.equal(h.$('#taskDialog').open,true);assert.equal(h.calls.some(x=>x[0]==='save'),false);
  ui.requests[0]({status:'old'});await Promise.resolve();await Promise.resolve();assert.equal(latest.island.updates.some(x=>x.notificationStatus==='old'),false);
  ui.requests[1]({status:'new'});await Promise.resolve();await Promise.resolve();assert.equal(latest.island.updates.at(-1).notificationStatus,'new');
});

test('owned Escape invokes discard request instead of clearing a dirty form immediately', () => {
  const h=harness(),ui=ownedSurface(h);h.c.openTask('a');ui.latest().handle.restore({checklist:[{text:'Unsaved',done:false}]});let prevented=0;
  h.$('#taskDialog').fire('cancel',{preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(ui.opens.at(-1)[0],'request-cancel');assert.ok(h.context('a'));assert.equal(h.$('#taskDialog').open,true);assert.equal(h.state.tasks[0].checklist.length,0);
});

test('owned source and destination props omit duplicate, private and revoked records', () => {
  const h=harness();h.state.notes.push({id:'secret',private:true,title:'Secret title'}, {id:'dup',title:'D1'},{id:'dup',title:'D2'});
  h.state.projects.push({id:'private-project',name:'Private owner',private:true,workspace:'科研'}, {id:'archived-project',name:'Archived owner',archived:true}, {id:'duplicate-project',name:'Duplicate one'}, {id:'duplicate-project',name:'Duplicate two'});
  const ui=ownedSurface(h,{knowledge:h.state.notes});h.c.openTask('a');
  assert.deepEqual(Array.from(ui.latest().props.knowledge,item=>item.id),['n']);assert.equal(ui.latest().props.projects.some(item=>item.id==='private-project'),false);assert.equal(ui.latest().props.deliverables.note.some(item=>item.id==='dup'),false);
  assert.deepEqual(Array.from(ui.latest().props.projects,item=>item.id),['p','q']);
});
