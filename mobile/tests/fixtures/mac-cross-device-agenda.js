// Executed only by the existing AIBRO_NATIVE_QA_HARNESS_UX branch in a staged
// resource directory. The preparer substitutes the public synthetic config.
// This fixture never writes an agenda note, agenda.json, or any database.
const config = /* AIBRO_CROSS_DEVICE_CONFIG */ null;
const check = (value, message) => { if (!value) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { fixture: 'cross-device-agenda-v1', passed: false, checks: [] };
const phase = value => {
  evidence.stage = value;
  document.body.dataset.qaCrossDeviceStage = value;
  window.__crossDeviceAgendaQA = evidence;
};
async function until(label, operation, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; }
    catch (error) { last = error.message; }
    await delay(300);
  }
  throw Error('[' + evidence.stage + '] ' + label + (last ? ': ' + last : ''));
}
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
check(config?.fixture === 'aibro-cross-device-native-v1', 'Missing prepared synthetic fixture');
check(new URL(config.base).hostname === '127.0.0.1' && new URL(config.base).protocol === 'http:', 'Loopback only');
check(config.username === 'cross-device-qa' && config.password === 'public-cross-device-fixture-only', 'Synthetic credentials only');
check(window.workstationDesktop?.nativeWorkspacePersistence === true, 'Real native desktop bridge required');
check(state.projects.some(item => item.id === 'native-qa'), 'Existing isolated native QA seed required');
check(!state.notes.some(item => item.id === config.noteId), 'The phone note must arrive through sync, not seeding');
phase('settle-initial-guides');
// Closing an unopened Tour does not cancel its queued automatic start. Finish
// the onboarding first, then await the public Tour lifecycle before closing it;
// otherwise the Tour can navigate to agent and queue a save during connect().
await window.WorkstationOnboarding?.open();
window.WorkstationOnboarding?.close('skipped', { restoreFocus: false });
check(await window.WorkspaceTour?.start() === true, '[settle-initial-guides] Workspace tour did not open');
window.WorkspaceTour.close('skipped', { restoreFocus: false });
check(!window.WorkstationOnboarding?.isOpen() && !window.WorkspaceTour.isOpen(), '[settle-initial-guides] A guide is still open');
phase('save-settings-route');
showView('settings');
window.SettingsWorkspace?.reveal('sync');
// Unlike flushWorkspace(), this waits for the submitted edit version's durable
// receipt and throws on a failed save. Do not bypass the product busy guards.
try { check(await saveDocumentDurably() === true, 'Missing durable save receipt'); }
catch (error) { throw Error('[save-settings-route] ' + error.message); }
await until('Cloud connection guards become idle after the guide and route saves', () => {
  if (serverConflict || serverSaveFailure) throw Error(serverSaveFailure || 'Workspace save conflict');
  return !cloudConnectionBusy() && !window.WorkspaceTour.isOpen()
    && !window.WorkstationOnboarding?.isOpen() && document.body.dataset.view === 'settings';
}, 10000);
evidence.checks.push('initial guides closed through public APIs and settings route durably saved before connecting');
phase('connect-real-cloud');
const controls = { cloudServerUrl: config.base, cloudUsername: config.username,
  cloudPassword: config.password, cloudDeviceName: 'Synthetic native Mac agenda QA' };
for (const [id, value] of Object.entries(controls)) {
  const input = document.getElementById(id);
  check(input, 'Missing real cloud connection field: ' + id);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const consent = document.getElementById('cloudMergeConfirmed');
check(consent, 'Missing merge consent');
consent.checked = true;
consent.dispatchEvent(new Event('change', { bubbles: true }));
// Await the same public handler registered on this real form, so a refused
// connection is reported here instead of timing out later waiting for a note.
const cloud = window.CloudSyncUI.init();
check(await cloud.connect() === true, '[connect-real-cloud] ' + (document.getElementById('cloudSyncMessage')?.textContent || 'Cloud form refused the connection'));
check(cloud.getStatus().connected === true, '[connect-real-cloud] Connection handler returned without an authenticated cloud session');
phase('receive-phone-operation-group');
await until('Mac receives the real cloud note', async () => {
  await window.CloudSyncUI.refresh(); // Product revision adoption, including busy/draft guards.
  return state.notes.find(item => item.id === config.noteId);
});
const received = state.notes.find(item => item.id === config.noteId);
const incoming = JSON.parse(received.content);
check(received.kind === '日程' && incoming.format === 'aibro.agenda.v1', 'Real agenda wire note received');
for (const field of ['title', 'start', 'end', 'timeZone', 'allDay', 'reminderMinutes'])
  check(same(incoming[field], config.originalEvent[field]), 'Incoming phone field differs: ' + field);
const conversation = state.conversations.find(item => item.id === config.conversationId);
const answer = conversation?.messages?.find(item => item.id === config.messageLocalId);
check(answer?.pendingPlan?.id === config.planId && answer.pendingPlan.status === 'applied', 'Applied receipt arrived with its exact conversation');
check(answer.pendingPlan.syncGroupId === config.groupId, 'Original operation group identity survived Mac projection');
check(answer.pendingPlan.receipts.some(item => item.id === config.noteId), 'Exact phone target receipt survived');
evidence.checks.push('phone note, applied plan and receipt adopted by the actual Mac renderer');

// A synthetic read-only Agent owner permits the existing native agenda-read RPC.
// The target note/receipt and the later mutation are never manufactured here.
const userMessage = conversation.messages.find(item => item.role === 'user' && typeof item.text === 'string');
check(userMessage, 'Phone user message has the desktop text alias');
const run = { id: 'qa-cross-device-agenda-observer', status: 'completed',
  conversationId: conversation.id, userMessageId: userMessage.id,
  projectId: conversation.projectId || null, contextWorkspace: conversation.workspace || 'auto',
  recordAssignmentScope: { projectId: conversation.projectId || null,
    workspace: conversation.workspace || 'auto', readProjects: [] }, steps: [], startedAt: Date.now() };
check(!state.agentRuns.some(item => item.id === run.id), 'Fresh read-only observer');
state.agentRuns.push(run);
check(await saveDocumentDurably() === true, 'Observer context saved through the real backend');
renderAll();
const context = window.AgendaAccess.contextFor(run);
const eventId = 'mobile:' + config.noteId;
const read = () => window.workstationDesktop.agendaRead({ eventId }, context);
phase('wait-native-agenda-adapter');
const first = await until('Actual AgendaStore receives the mobile note', async () => {
  const result = await read();
  return result?.status === 'ready' && result.authority === 'native-agenda' ? result.event : false;
});
for (const field of ['title', 'start', 'end', 'timeZone', 'allDay', 'reminderMinutes'])
  check(same(first[field], config.originalEvent[field]), 'Native AgendaStore field differs: ' + field);
evidence.before = first;
evidence.noteId = config.noteId;
evidence.groupId = config.groupId;
evidence.checks.push('agendaRead returned the exact event from the actual native AgendaStore');
await window.workstationDesktop.agendaOpen(eventId);
phase('await-user-edit-in-native-detail');
// The operator uses the opened SwiftUI detail: Edit series -> change title -> Save.
// This loop reads the real in-memory store; it cannot perform the mutation.
const edited = await until('Save the instructed title using the actual native agenda editor', async () => {
  const result = await read();
  return result?.status === 'ready' && result.authority === 'native-agenda'
    && result.event.title === config.expectedTitle ? result.event : false;
}, config.editTimeoutMs || 300000);
check(edited.version !== first.version, 'Native event version changed');
for (const field of ['eventId', 'start', 'end', 'timeZone', 'allDay', 'reminderMinutes', 'recurrence', 'excluded', 'completed'])
  check(same(edited[field], first[field]), 'Native title edit altered unrelated event data: ' + field);
evidence.after = edited;
evidence.checks.push('actual native AgendaStore reports the saved title and a new version; unrelated event fields preserved');
phase('wait-native-writeback');
await until('NativeAgendaSync durably writes the same workspace note', () => {
  const note = state.notes.find(item => item.id === config.noteId);
  return note?.title === config.expectedTitle && JSON.parse(note.content).title === config.expectedTitle
    && !state._pendingLocalSave && !serverSaveInFlight;
});
// If the SwiftUI detail remains open, the same product busy rules apply. Close it
// after Save; never force adoption over an editor draft.
phase('upload-mac-revision');
const controller = window.CloudSyncUI.init(); // Existing controller; its real flush/busy guards remain active.
check(await controller.sync() === true, '[upload-mac-revision] Normal cloud sync request was refused');
await until('Normal cloud sync accepts the native edit', async () => {
  // Starting sync again on each poll keeps observing a newly running job and
  // also queues needless flush snapshots. Poll the one accepted request only.
  await controller.refresh();
  const status = controller.getStatus();
  return status.connected && !status.syncing && !status.error && status.pending === 0;
});
const persisted = await (await fetch('/__state', { cache: 'no-store' })).json();
const finalNote = persisted.notes.find(item => item.id === config.noteId);
check(finalNote?.title === config.expectedTitle && JSON.parse(finalNote.content).title === config.expectedTitle, 'Real Mac backend persisted the adapter writeback');
evidence.checks.push('normal cloud sync sent the native edit and the real local backend retained the same note ID');
evidence.scope = 'actual Mac WKWebView, CloudSync and native AgendaStore; operator edits the real SwiftUI editor; no target database writes or fabricated remote peer';
evidence.passed = true;
phase('completed');
return evidence;
