const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const noop = () => {};
function harness(extra = {}, kind = 'project') {
  const state = {
    projects: [{ id: 'course', name: '智能控制', workspace: '课程' }, { id: 'research', name: '智能控制', workspace: '科研' }],
    conversations: [{ id: 'course-chat', projectId: 'course', workspace: '课程', attachments: [] }, { id: 'research-chat', projectId: 'research', project: '智能控制', workspace: '科研', attachments: [] }],
    tasks: [], notes: [], papers: [], imports: [], attachments: [], agentRuns: [], links: [], trash: [],
    currentConversationId: 'research-chat', ...extra
  };
  const context = vm.createContext({ state, manageTarget: { kind, id: kind === 'project' ? 'course' : 'course-chat' },
    window: { confirm: () => true }, uid: () => 'generated-chat', save: noop, renderAll: noop, showView: noop,
    ensureConversation: noop, repairRelationships: noop, normalizeStateShape: noop, purgeTrash: { pendingId: null }, $: () => ({ close: noop }), $$: () => []
  });
  const helper = source.indexOf('function projectDeletionMembership(');
  const start = helper >= 0 ? helper : source.indexOf('function deleteManagedItem(');
  const end = source.indexOf('function renderConversation(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const restoreStart = source.indexOf('function restoreTrash(');
  vm.runInContext(source.slice(restoreStart, source.indexOf('async function purgeTrash(', restoreStart)), context);
  return { state, remove: context.deleteManagedItem, restore: () => context.restoreTrash(0) };
}
const ids = list => Array.from(list, item => item.id).sort();

test('deleting a same-name course project cannot remove any explicitly research-owned content', () => {
  const owned = id => ({ id, projectId: 'research', project: '智能控制', workspace: '科研' });
  const fixture = harness({ tasks: [owned('task')], notes: [owned('note')], imports: [owned('pdf')], papers: [owned('paper')] });
  fixture.state.conversations[1].attachments.push('pdf');
  const otherConversation = fixture.state.conversations[1];
  fixture.remove();
  assert.deepEqual(ids(fixture.state.projects), ['research']);
  assert.ok(fixture.state.conversations.includes(otherConversation));
  for (const [collection, id] of [['tasks','task'],['notes','note'],['imports','pdf'],['papers','paper']]) assert.deepEqual(ids(fixture.state[collection]), [id]);
  for (const collection of ['tasks','notes','imports','papers']) assert.equal(fixture.state.trash[0].data[collection].length, 0);
});

test('explicit project ID takes precedence over stale name and workspace, including duplicate names in one space', () => {
  const { state, remove } = harness({
    projects: [{ id:'course', name:'智能控制', workspace:'课程' }, { id:'other-course', name:'智能控制', workspace:'课程' }],
    tasks: [{ id:'keep', projectId:'other-course', project:'智能控制', workspace:'课程' }, { id:'remove', projectId:'course', project:'outdated name', workspace:'科研' }]
  });
  remove();
  assert.deepEqual(ids(state.tasks), ['keep']);
  assert.deepEqual(ids(state.trash[0].data.tasks), ['remove']);
});

test('legacy names are used only for a unique project with an explicit matching workspace', () => {
  const tasks = [
    { id:'matched-legacy', project:'智能控制', workspace:'课程' },
    { id:'other-space', project:'智能控制', workspace:'科研' },
    { id:'no-workspace', project:'智能控制' },
    { id:'unknown-id', projectId:'unknown', project:'智能控制', workspace:'课程' }
  ];
  const first = harness({ tasks: structuredClone(tasks) }); first.remove();
  assert.deepEqual(ids(first.state.tasks), ['no-workspace','other-space','unknown-id']);
  assert.deepEqual(ids(first.state.trash[0].data.tasks), ['matched-legacy']);
  const ambiguous = harness({ tasks: structuredClone(tasks) });
  ambiguous.state.projects.push({ id:'old-course', name:'智能控制', workspace:'课程', archived:true });
  ambiguous.remove();
  assert.deepEqual(ids(ambiguous.state.tasks), tasks.map(item=>item.id).sort());
});

test('conversation sources and run provenance do not override content moved to another project', () => {
  const { state, remove } = harness({
    imports: [{ id:'own-pdf', projectId:'course' }, { id:'moved-pdf', projectId:'research' }, { id:'loose-pdf' }, { id:'shared-pdf' }],
    attachments: ['own-pdf','moved-pdf','loose-pdf','shared-pdf'].map(id => ({ id, conversationId:'course-chat' })),
    agentRuns: [{ id:'run', conversationId:'course-chat', projectId:'course' }],
    tasks: [{ id:'moved-task', projectId:'research', sourceConversationId:'course-chat', agentRunId:'run', sourceAttachmentIds:['moved-pdf'] }, { id:'own-task', agentRunId:'run' }],
    notes: [{ id:'moved-note', projectId:'research', agentRunId:'run' }, { id:'own-note', agentRunId:'run' }]
  });
  state.conversations[0].attachments = ['own-pdf','moved-pdf','loose-pdf','shared-pdf'];
  state.conversations[1].attachments = ['moved-pdf','shared-pdf'];
  remove();
  assert.deepEqual(ids(state.imports), ['moved-pdf','shared-pdf']);
  assert.deepEqual(ids(state.attachments), ['moved-pdf','shared-pdf']);
  assert.deepEqual(Array.from(state.conversations[0].attachments), ['moved-pdf','shared-pdf']);
  assert.deepEqual(ids(state.tasks), ['moved-task']);
  assert.deepEqual(ids(state.notes), ['moved-note']);
  assert.deepEqual(ids(state.trash[0].data.tasks), ['own-task']);
  assert.deepEqual(ids(state.trash[0].data.notes), ['own-note']);
  assert.deepEqual(ids(state.trash[0].data.imports), ['loose-pdf','own-pdf']);
});

for (const kind of ['project','conversation']) test(`deleting a ${kind} removes its owned paper links and restoring restores the exact paper/link records`, () => {
  const paper = { id:'paper', title:'Persisted paper', projectId:kind === 'project' ? 'course' : null, sourceConversationId:'course-chat', sourceAttachmentIds:[] };
  const paperLink = { id:'paper-link', sourceId:'paper', targetId:'retained-note' };
  const otherLink = { id:'keep-link', sourceId:'retained-note', targetId:'other-note' };
  const { state, remove, restore } = harness({ papers:[paper], notes:[{ id:'retained-note',projectId:'research' }, { id:'other-note',projectId:'research' }], links:[paperLink,otherLink] }, kind);
  remove();
  assert.deepEqual(ids(state.papers), []);
  assert.deepEqual(ids(state.links), ['keep-link']);
  assert.deepEqual(ids(state.trash[0].data.links), ['paper-link']);
  restore();
  assert.equal(state.papers[0], paper);
  assert.deepEqual(ids(state.links), ['keep-link','paper-link']);
  assert.equal(state.links.find(item=>item.id==='paper-link'), paperLink);
  assert.equal(state.trash.length, 0);
});

test('deleting an interaction preserves filed results, original files and source links in both original and moved projects', () => {
  const owned = (id, projectId) => ({ id, projectId, sourceConversationId:'course-chat', agentRunId:'run', sourceAttachmentIds:['filed-pdf'] });
  const link = { id:'source-link', sourceId:'retained-note', targetId:'filed-pdf' };
  const { state, remove, restore } = harness({
    tasks:[owned('original-task','course'),owned('moved-task','research')],
    notes:[owned('retained-note','course'),owned('moved-note','research')],
    papers:[owned('retained-paper','research')],
    imports:[{ id:'filed-pdf', projectId:'research' }],
    attachments:[{ id:'filed-pdf',conversationId:'course-chat' }],
    agentRuns:[{ id:'run',conversationId:'course-chat' }], links:[link]
  }, 'conversation');
  state.projects[1].archived = true;
  state.conversations[0].attachments = ['filed-pdf'];
  const before = JSON.stringify([state.tasks,state.notes,state.papers,state.imports,state.attachments,state.links]);
  remove();
  assert.equal(JSON.stringify([state.tasks,state.notes,state.papers,state.imports,state.attachments,state.links]), before);
  assert.equal(state.agentRuns.length, 0);
  assert.deepEqual(ids(state.conversations), ['research-chat']);
  for (const key of ['tasks','notes','papers','imports','attachments','links']) assert.equal(state.trash[0].data[key].length, 0);
  restore();
  assert.equal(JSON.stringify([state.tasks,state.notes,state.papers,state.imports,state.attachments,state.links]), before);
  assert.equal(state.agentRuns.length, 1);
  assert.deepEqual(ids(state.conversations), ['course-chat','research-chat']);
});

test('conversation deletion cleans only unassigned exclusive content and preserves originals still used by durable knowledge', () => {
  const loose = id => ({ id, sourceConversationId:'course-chat',agentRunId:'run',sourceAttachmentIds:['exclusive-pdf'] });
  const { state, remove, restore } = harness({
    tasks:[loose('loose-task')], notes:[loose('loose-note'), {id:'durable-note',projectId:'research',sourceAttachmentIds:['cited-pdf']}],
    papers:[loose('loose-paper')],
    imports:['exclusive-pdf','shared-pdf','cited-pdf'].map(id=>({id})),
    attachments:['exclusive-pdf','shared-pdf','cited-pdf'].map(id=>({id,conversationId:'course-chat'})),
    agentRuns:[{id:'run',conversationId:'course-chat'}],
    links:[{id:'exclusive-link',sourceId:'loose-note',targetId:'exclusive-pdf'},{id:'retained-link',sourceId:'durable-note',targetId:'cited-pdf'}]
  }, 'conversation');
  state.conversations[0].attachments = ['exclusive-pdf','shared-pdf','cited-pdf'];
  state.conversations[1].attachments = ['shared-pdf'];
  remove();
  assert.deepEqual(ids(state.tasks), []);
  assert.deepEqual(ids(state.notes), ['durable-note']);
  assert.deepEqual(ids(state.papers), []);
  assert.deepEqual(ids(state.imports), ['cited-pdf','shared-pdf']);
  assert.deepEqual(ids(state.attachments), ['cited-pdf','shared-pdf']);
  assert.deepEqual(ids(state.links), ['retained-link']);
  assert.deepEqual(ids(state.trash[0].data.imports), ['exclusive-pdf']);
  restore();
  assert.deepEqual(ids(state.tasks), ['loose-task']);
  assert.deepEqual(ids(state.notes), ['durable-note','loose-note']);
  assert.deepEqual(ids(state.papers), ['loose-paper']);
  assert.deepEqual(ids(state.imports), ['cited-pdf','exclusive-pdf','shared-pdf']);
  assert.deepEqual(ids(state.links), ['exclusive-link','retained-link']);
});

function sharedProjectSource() {
  const file = { id:'shared-original', name:'原始研究.pdf', originalName:'source.pdf', projectId:'course', project:'智能控制', workspace:'课程', folderPath:'原始资料', updatedAt:100, content:'PDF text retained for preview' };
  const fixture = harness({
    imports:[file,{id:'exclusive-original',projectId:'course'}],
    attachments:[{id:file.id,conversationId:'course-chat'},{id:'exclusive-original',conversationId:'course-chat'}],
    notes:[{id:'research-note',projectId:'research',sourceAttachmentIds:[file.id]},{id:'course-note',projectId:'course',sourceAttachmentIds:[file.id]}],
    papers:[{id:'research-paper',projectId:'research',sourceAttachmentIds:[file.id]}],
    links:[{id:'owner-link',sourceId:'course',targetId:file.id,relation:'contains'},{id:'research-source-link',sourceId:file.id,targetId:'research-note',relation:'source'},{id:'course-source-link',sourceId:file.id,targetId:'course-note',relation:'source'}]
  });
  fixture.state.conversations[0].attachments=[file.id,'exclusive-original'];
  fixture.state.conversations[1].attachments=[file.id];
  return {...fixture,file};
}

test('project deletion detaches referenced originals instead of breaking other project citations, and restoration restores their untouched ownership', () => {
  const {state,file,remove,restore}=sharedProjectSource();
  const before=JSON.stringify(file);
  remove();
  assert.equal(state.imports.find(item=>item.id===file.id),file);
  assert.equal(file.projectId,null);assert.equal(file.project,null);
  assert.equal(file.content,'PDF text retained for preview');
  assert.deepEqual(ids(state.imports),['shared-original']);
  assert.deepEqual(ids(state.attachments),['shared-original']);
  assert.deepEqual(ids(state.links),['research-source-link']);
  assert.deepEqual(ids(state.trash[0].data.imports),['exclusive-original']);
  assert.deepEqual(Array.from(state.notes[0].sourceAttachmentIds),[file.id]);
  // The restoration metadata must survive the same JSON round trip as the
  // persisted workspace, without retaining a second copy of the PDF/text.
  state.trash=JSON.parse(JSON.stringify(state.trash));
  restore();
  assert.equal(JSON.stringify(file),before);
  assert.deepEqual(ids(state.imports),['exclusive-original','shared-original']);
  assert.deepEqual(ids(state.links),['course-source-link','owner-link','research-source-link']);
});

test('restoring a deleted project cannot claim a shared original that the user subsequently moved elsewhere', () => {
  const {state,file,remove,restore}=sharedProjectSource();remove();
  state.projects.push({id:'third',name:'新的研究',workspace:'科研'});
  Object.assign(file,{projectId:'third',project:'新的研究',workspace:'科研',folderPath:'论文原件',updatedAt:Date.now()+1});
  state.links.push({id:'new-owner-link',sourceId:'third',targetId:file.id,relation:'contains'});
  const afterManualMove=JSON.stringify(file);
  restore();
  assert.equal(JSON.stringify(file),afterManualMove);
  assert.equal(state.imports.filter(item=>item.id===file.id).length,1);
  assert.deepEqual(ids(state.links),['course-source-link','new-owner-link','research-source-link']);
});

test('an edited or re-cleared shared original stays unassigned when its metadata version no longer matches the detached snapshot', () => {
  for(const change of ['rename','reassign-and-clear']) {
    const {state,file,remove,restore}=sharedProjectSource();remove();
    if(change==='rename') file.name='用户重新命名.pdf';
    file.updatedAt=Number(file.updatedAt)+1;
    file.projectId=null;file.project=null;
    const edited=JSON.stringify(file);
    restore();
    assert.equal(JSON.stringify(file),edited);
    assert.equal(file.projectId,null);
    assert.ok(!state.links.some(link=>link.id==='owner-link'));
    assert.ok(state.links.some(link=>link.id==='research-source-link'));
  }
});

test('a retained project reference or source link is sufficient to preserve an original even without note sourceAttachmentIds', () => {
  const {state,remove}=harness({imports:[{id:'by-project',projectId:'course'},{id:'by-link',projectId:'course'}],links:[{id:'reference',sourceId:'research',targetId:'by-link',relation:'source'}]});
  state.projects.find(item=>item.id==='research').sourceAttachmentIds=['by-project'];
  remove();
  assert.deepEqual(ids(state.imports),['by-link','by-project']);
  assert.ok(state.imports.every(item=>item.projectId===null));
  assert.deepEqual(ids(state.links),['reference']);
});

test('restoring a project does not resurrect a subsequently deleted shared source or create dangling restored links', () => {
  const {state,file,remove,restore}=sharedProjectSource();remove();
  state.imports=state.imports.filter(item=>item.id!==file.id);
  state.links=state.links.filter(link=>link.sourceId!==file.id && link.targetId!==file.id);
  restore();
  assert.ok(!state.imports.some(item=>item.id===file.id));
  assert.ok(!state.links.some(link=>link.sourceId===file.id || link.targetId===file.id));
});

test('shared-source recovery metadata is small and cannot overwrite the original file content', () => {
  const {state,file,remove,restore}=sharedProjectSource();remove();
  const move=state.trash[0].data.sharedImportMoves[0];
  assert.equal(move.id,file.id);
  assert.equal(move.before.content,undefined);
  assert.equal(move.after.content,undefined);
  move.before.content='corrupt metadata must not replace source';
  state.trash[0].data.sharedImportMoves.push(null);
  restore();
  assert.equal(file.content,'PDF text retained for preview');
  assert.equal(file.projectId,'course');
});
