// Loaded only by the installed Mac native QA branch with isolated resources.
// All target changes go through the product context controller or editor form.
// This is native WKWebView integration; it does not claim pointer-driven UI QA.
const config = /* AIBRO_CROSS_DEVICE_CONTEXT_CONFIG */ null;
const check = (value, message) => { if (!value) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { fixture: 'aibro-cross-device-context-v1', passed: false, checks: [], edits: [] };
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
function phase(value) {
  evidence.stage = value; document.body.dataset.qaCrossDeviceContextStage = value;
  window.__crossDeviceContextQA = evidence;
}
async function until(label, operation, timeout = 90000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; }
    catch (error) { last = error.message; }
    await delay(300);
  }
  throw Error('[' + evidence.stage + '] ' + label + (last ? ': ' + last : ''));
}
const note = id => state.notes.find(item => item.id === id);
const conversation = () => state.conversations.find(item => item.id === config.conversationId);
const keys = () => FileContext.references(conversation()).map(ref => `${ref.type === 'note' ? 'notes' : ref.type === 'import' ? 'imports' : ref.type}:${ref.id}`);
const backend = async () => {
  const response = await fetch('/__state', { cache: 'no-store' });
  check(response.ok, 'Actual local backend snapshot unavailable'); return response.json();
};
check(config?.fixture === 'aibro-cross-device-context-v1', 'Missing synthetic context config');
const endpoint = new URL(config.base);
check(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port, 'Loopback server required');
check(config.username === 'cross-device-qa' && config.password === 'public-cross-device-fixture-only', 'Synthetic account required');
check(config.sourceNoteId === 'qa045-context-source' && config.replacementNoteId === 'qa045-context-replacement', 'Exact synthetic note identities required');
check(window.workstationDesktop?.nativeWorkspacePersistence === true, 'Actual native persistence bridge required');
check(state.projects.some(item => item.id === 'native-qa'), 'UUID native QA workspace seed required');
check(!note(config.sourceNoteId) && !note(config.replacementNoteId) && !conversation(), 'Targets must arrive only through the real sync server');
check(typeof contextSelection?.mutate === 'function', 'Production ContextSelection controller unavailable');
evidence.conversationId = config.conversationId;
evidence.nativeWorkspacePersistence = true;
evidence.interactionScope = { navigation: 'production openConversation/openPreview', selection: 'same contextSelection.mutate handler used by UI controls',
  noteEditing: config.editMode === 'manual' ? 'operator edits the real NoteEditor modal and submits its form' : 'DOM input events and requestSubmit on the real production NoteEditor modal',
  excluded: ['pointer-driven navigation acceptance', 'production workspace', 'direct state/SQL target writes', 'real model request'] };

phase('settle-initial-guides');
await window.WorkstationOnboarding?.open();
window.WorkstationOnboarding?.close('skipped', { restoreFocus: false });
check(await window.WorkspaceTour?.start() === true, 'Workspace tour did not open');
window.WorkspaceTour.close('skipped', { restoreFocus: false });
showView('settings'); window.SettingsWorkspace?.reveal('sync');
check(await saveDocumentDurably() === true, 'Initial route has no durable save receipt');
await until('Initial guide and save guards settle', () => !cloudConnectionBusy()
  && !window.WorkspaceTour.isOpen() && !window.WorkstationOnboarding?.isOpen(), 15000);

phase('connect-real-cloud');
for (const [id, value] of Object.entries({ cloudServerUrl: config.base, cloudUsername: config.username,
  cloudPassword: config.password, cloudDeviceName: 'Synthetic native Mac context QA' })) {
  const input = document.getElementById(id); check(input, 'Missing connection field: ' + id);
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
}
const consent = document.getElementById('cloudMergeConfirmed'); check(consent, 'Merge consent missing');
consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true }));
const cloud = window.CloudSyncUI.init();
check(await cloud.connect() === true, 'Actual connection handler refused: ' + (document.getElementById('cloudSyncMessage')?.textContent || ''));
check(cloud.getStatus().connected === true, 'No authenticated synthetic cloud session');
await until('Phone conversation and both notes arrive', async () => {
  await cloud.refresh(); return conversation() && note(config.sourceNoteId) && note(config.replacementNoteId);
});
check(same(conversation().mobileContext, config.originalContext), 'Incoming phone context differs');
for (const id of [config.sourceNoteId, config.replacementNoteId]) check(note(id).content === config.originalNotes[id], 'Incoming body differs: ' + id);
check(!conversation().draft, 'A phone-local unsent draft must not be imported onto Mac');

phase('open-phone-conversation-and-read-A');
openConversation(config.conversationId);
check(state.currentConversationId === config.conversationId && document.body.dataset.view === 'agent', 'Original conversation did not open through normal navigation');
check(same(keys(), ['notes:' + config.sourceNoteId]), 'Mac next-turn selection is not exactly A');
const original = await FileContext.prepare(state, FileContext.references(conversation()));
check(original.initial.length === 1 && original.initial[0].text === config.originalNotes[config.sourceNoteId], 'Production reference preparation did not read actual A body');
evidence.checks.push('real cloud received exact phone records; normal conversation navigation and production FileContext.prepare read only A');

phase('change-reference-through-production-controller');
const oldReference = FileContext.references(conversation())[0];
await contextSelection.mutate({ action: 'remove-reference', conversationId: config.conversationId, ref: oldReference });
const selectedB = await FileContext.libraryRef(state, 'note', config.replacementNoteId);
await contextSelection.mutate({ action: 'add-reference', conversationId: config.conversationId, ref: selectedB });
check(same(keys(), config.expectedContextKeys), 'Next-turn selection is not exactly B');
check(same(conversation().mobileContext.source, config.originalContext.source), 'Changing selection lost original return source A');
const selectionSnapshot = await backend();
check(same(selectionSnapshot.conversations.find(item => item.id === config.conversationId)?.mobileContext,
  { version: 1, keys: config.expectedContextKeys, source: config.originalContext.source }), 'Actual backend did not durably save the selection');
evidence.checks.push('same production context controller removed A and added B; real backend saved identity-only keys while retaining source A');

async function editInRealForm(id) {
  phase('edit-' + id);
  const before = structuredClone(note(id));
  await openPreview('note', id);
  check(state.previewRecord?.type === 'note' && state.previewRecord.id === id, 'Normal reader did not open exact note');
  check(window.NoteEditor.open(id) === true, 'Production note editor refused the synthetic note');
  const dialog = document.getElementById('noteEditorDialog'), form = dialog?.querySelector('form');
  const body = document.getElementById('noteEditorContent'), title = document.getElementById('noteEditorTitle');
  check(dialog?.open && form && body && title && body.value === before.content && title.value === before.title, 'Actual editor fields do not contain the expected saved note');
  await until('Editor draft recovery is ready for input and save', () => !body.disabled && !title.disabled && dialog.getAttribute('aria-busy') !== 'true', 15000);
  if (config.editMode === 'dom') {
    body.focus(); body.value = config.expectedMacNotes[id];
    body.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  }
  await until('Save exact instructed body in the displayed production editor', () => !dialog.open && note(id)?.content === config.expectedMacNotes[id], config.editTimeoutMs);
  const after = note(id);
  check(after.id === before.id && after.title === before.title && after.projectId === before.projectId
    && after.workspace === before.workspace && after.kind === before.kind, 'Body editing changed note identity or ownership');
  check(after.userEdited === true && Number(after.updatedAt) > Number(before.updatedAt || 0), 'Real edit metadata did not advance');
  check((after.revisionHistory || []).some(revision => revision.content === before.content), 'Editor did not preserve the previous body in revision history');
  const saved = (await backend()).notes.find(item => item.id === id);
  check(saved?.content === after.content && saved.updatedAt === after.updatedAt, 'Actual local backend did not retain edited body');
  evidence.edits.push({ id, editor: 'NoteEditorDialog', event: config.editMode === 'dom' ? 'input + form.requestSubmit' : 'manual operator form submit',
    oldBodySha256: await FileContext.digest(before.content), newBodySha256: await FileContext.digest(after.content),
    priorVersionRetained: true, durableBackendVerified: true });
  // Close through the actual reader lifecycle. Never force an unsaved editor.
  for (const tab of [...(window.ReadingPane?.snapshot?.()?.tabs || [])])
    check(await window.ReadingPane.close(tab.key) !== false, 'Reader close refused after saved edit');
  openConversation(config.conversationId);
  check(await saveDocumentDurably() === true, 'Post-edit navigation did not save');
}
await editInRealForm(config.sourceNoteId);
await editInRealForm(config.replacementNoteId);

phase('refresh-changed-B-through-production-controller');
let staleError = '';
try { await FileContext.prepare(state, FileContext.references(conversation())); }
catch (error) { staleError = error.message; }
check(/已修改/.test(staleError), 'Editing B must invalidate its previous selected content version');
await contextSelection.mutate({ action: 'refresh-reference', conversationId: config.conversationId,
  ref: FileContext.references(conversation())[0] });
const finalPrepared = await FileContext.prepare(state, FileContext.references(conversation()));
check(finalPrepared.initial.length === 1 && finalPrepared.snapshots[0].id === config.replacementNoteId
  && finalPrepared.initial[0].text === config.expectedMacNotes[config.replacementNoteId], 'Explicit refresh did not prepare exactly the new B content');
check(same(conversation().mobileContext.source, config.originalContext.source), 'Source A identity changed during note editing');
evidence.checks.push('both bodies changed using real editor forms and durable backend; stale B version rejected until explicit controller refresh; subsequent prepare reads only updated B');

phase('upload-one-mac-sync-request');
showView('settings'); window.SettingsWorkspace?.reveal('sync');
check(await saveDocumentDurably() === true, 'Final route not durable');
await until('Post-editor product sync guards become idle', () => !cloudConnectionBusy(), 15000);
check(await cloud.sync() === true, 'One normal sync request was refused');
await until('One normal sync request completes with zero pending records', async () => {
  await cloud.refresh(); const status = cloud.getStatus();
  return status.connected && !status.syncing && !status.error && status.pending === 0;
});
const persisted = await backend();
const finalConversation = persisted.conversations.find(item => item.id === config.conversationId);
check(same(finalConversation.mobileContext, { version: 1, keys: config.expectedContextKeys, source: config.originalContext.source }), 'Final persisted context differs');
for (const id of [config.sourceNoteId, config.replacementNoteId])
  check(persisted.notes.find(item => item.id === id)?.content === config.expectedMacNotes[id], 'Final persisted note differs: ' + id);
evidence.context = finalConversation.mobileContext;
evidence.sync = { manualRequests: 1, connected: true, pending: 0, cloudVersionsVerifiedSeparatelyBy: 'inspect-cross-device-context.py --after-mac' };
evidence.checks.push('one normal sync request completed; subsequent polling only refreshed status; exact backend context and note bodies retained');
evidence.passed = true; phase('completed');
return JSON.stringify(evidence);
