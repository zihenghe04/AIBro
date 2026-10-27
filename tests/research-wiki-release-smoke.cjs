/* Release gate: actual product controllers + temporary SQLite persistence.
 * ONLY model transport/configuration is synthetic. No real model, SSH, user store,
 * or external network. This renderer aid does not claim native WKWebView QA.
 * Run serially, with root approval: ./node_modules/.bin/electron tests/research-wiki-release-smoke.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/research-wiki-release-20261001');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-wiki-release-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
const PROJECT = 'wiki-release-project', NOTE = 'wiki-release-existing', SOURCE = 'wiki-release-evidence';
const ORIGINAL_CHAT = 'wiki-release-original', ORIGINAL_MESSAGE = 'wiki-release-old-question';
const TITLE = '持续检索是否改善长期记忆';
const ORIGINAL_MARKER = '原记录：只有一次观察，尚不能判断因果。';
const EVIDENCE_MARKER = '合成研究记录：对照组遗忘一次，检索组也遗漏一次；没有统计结论。';
const ADOPTED_MARKER = '新增结论：两个条件都发生遗漏，当前证据不足以证明持续检索更优。';
const EDITED_QUESTION = '结合研究记录，更新既有科研 Wiki“持续检索是否改善长期记忆”，保留原问题与未验证边界，先让我审阅。';
const FOLLOWUP_QUESTION = '基于刚刚已保存的 Wiki 结论，下一步实验应该控制哪些变量？只回答，不修改资料。';
let win, server, origin, finishing = false, branchId, updateRunId, failedRunId, followupId, originalBody, originalConversation;
const checks = [], failures = [], rendererErrors = [], blockedRequests = [], screenshots = [], requests = [];
const report = { startedAt: new Date().toISOString(), syntheticModel: true, realModelCalls: 0, nativeAcceptance: false,
  userWorkspaceLoaded: false, localCloudStatusReads: 0, localSSHMetadataReads: 0, checks, failures, rendererErrors, blockedRequests, screenshots, requests };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await wait(45); }
  const run = await evaluate('state.agentRuns?.at(-1)&&({status:state.agentRuns.at(-1).status,error:state.agentRuns.at(-1).error,validationErrors:state.agentRuns.at(-1).validationErrors})').catch(() => null);
  throw Error('Timed out: ' + label + ' ' + JSON.stringify(run));
}
const paint = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
async function click(selector) {
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`);
  await paint();
  const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(n.disabled||r.width<1||r.height<1||x<0||x>=innerWidth||y<0||y>=innerHeight||!(n===hit||n.contains(hit)))throw Error('Control not visibly hittable: '+${JSON.stringify(selector)}+' '+JSON.stringify({x,y,hit:hit?.className}));return{x,y}})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await paint();
}
async function input(selector, value) {
  await click(selector);
  await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const p=n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function shot(name) { await paint(); const file = name + '.png'; fs.writeFileSync(path.join(OUT, file), (await win.webContents.capturePage()).toPNG()); screenshots.push(file); }
async function check(label, fn) {
  try { await fn(); checks.push(label); console.log('PASS', label); }
  catch (error) { failures.push({ label, error: error.stack }); await shot('failure').catch(() => {}); throw error; }
}
async function settleStore() {
  await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()');
  await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'durable save');
}
const disk = () => evaluate(`(async()=>{const r=await fetch('/__state',{cache:'no-store'});if(!r.ok)throw Error('State read failed');return r.json()})()`);
const note = () => evaluate(`state.notes.find(n=>n.id===${JSON.stringify(NOTE)})`);
const originalMessages = () => evaluate(`state.conversations.find(c=>c.id===${JSON.stringify(ORIGINAL_CHAT)}).messages`);
async function installSyntheticTransport() {
  await evaluate(`document.querySelector('#apiBase').value='https://synthetic.invalid/v1';document.querySelector('#apiKey').value='SYNTHETIC_NOT_A_SECRET';document.querySelector('#model').value='synthetic-wiki-model';
    ConversationModels.resolve=async config=>({...config,provider:'api',model:'synthetic-wiki-model'});
    window.__wikiRequests=[];window.__wikiPending=null;
    AgentTransport.requestPlan=options=>{__wikiRequests.push({model:options.model,input:options.input});return new Promise((resolve,reject)=>{__wikiPending={resolve,reject};options.signal?.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic request cancelled'),{code:'CANCELLED'})),{once:true})})};true`);
}
async function pendingAfter(count) { await until(() => evaluate(`__wikiRequests.length>${count}&&!!__wikiPending`), 'synthetic model request'); return evaluate('__wikiRequests.at(-1)'); }
function requestText(request) { return typeof request.input === 'string' ? request.input : JSON.stringify(request.input); }
async function reply(payload, next = false) {
  const count = await evaluate('__wikiRequests.length');
  await evaluate(`(()=>{const p=__wikiPending;if(!p)throw Error('No pending model request');__wikiPending=null;p.resolve(${JSON.stringify(JSON.stringify(payload))});return true})()`);
  if (next) return pendingAfter(count);
  await until(() => evaluate('!sendMessage.busy&&!sendMessage.preparingWiki&&!sendMessage.preflight'), 'run finished');
  return evaluate('state.agentRuns.at(-1)');
}
async function finish(code) {
  if (finishing) return; finishing = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) {
    report.finalRuns = await evaluate('state.agentRuns.map(r=>({id:r.id,status:r.status,conversationId:r.conversationId,results:r.results,knowledgeReads:r.knowledgeReads,error:r.error}))').catch(() => []);
    try { win.destroy(); } catch (_) {}
  }
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = once(server, 'exit').catch(() => {}); server.kill('SIGTERM'); await Promise.race([ended, wait(1000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([ended, wait(500)]); }
  }
  report.serverStopped = !server || server.exitCode !== null || server.signalCode !== null;
  fs.rmSync(TEMP, { recursive: true, force: true }); report.temporaryDataRemoved = !fs.existsSync(TEMP);
  report.finishedAt = new Date().toISOString(); report.passed = checks.length; report.success = code === 0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(code);
}
const watchdog = setTimeout(() => { failures.push({ label: 'watchdog', error: 'Exceeded 150 seconds' }); void finish(1); }, 150000);
app.on('window-all-closed', () => {});

(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
  server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT,
    env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(origin + '/__health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false))), 'isolated service');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    const url = new URL(request.url);
    // The product reads this local status during startup; it neither connects
    // a server nor starts synchronization. All cloud mutations stay blocked.
    const statusRead = url.origin === origin && request.method === 'GET' && (['/__cloud/status', '/__cloud/ssh', '/__auth/status'].includes(url.pathname) || (url.pathname === '/__auth/models' && url.searchParams.has('cacheonly')));
    if (statusRead && url.pathname === '/__cloud/status') report.localCloudStatusReads++;
    if (statusRead && url.pathname === '/__cloud/ssh') report.localSSHMetadataReads++;
    const blocked = url.origin !== origin || !statusRead && /^\/__(?:proxy|codex|auth|cloud|models|api|llm|terminal|browser)(?:\/|$)/.test(url.pathname);
    if (blocked) blockedRequests.push(request.url); callback({ cancel: blocked });
  });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  await win.loadURL(origin);
  await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydration');
  // Synthetic fixture construction uses the production Markdown schema. It is
  // not a claimed Agent execution; all later mutations use the visible UI.
  const fixture = {
    projects: [{ id: PROJECT, name: '持续检索研究 · 合成验收', workspace: '科研', createdAt: 1700000000000 }, { id: 'wiki-release-other-project', name: '另一研究', workspace: '科研', createdAt: 1700000000000 }],
    notes: [{ id: NOTE, title: TITLE, kind: '科研 Wiki/idea', workspace: '科研', projectId: PROJECT, createdAt: 1700000000000, updatedAt: 1700000000000, sourceNoteIds: [SOURCE], sourceAttachmentIds: [], content: '' },
      { id: SOURCE, title: '原始对照记录', kind: '笔记', workspace: '科研', projectId: PROJECT, content: EVIDENCE_MARKER, createdAt: 1700000000000, updatedAt: 1700000000000 },
      { id: 'wiki-release-foreign', title: '隔离条目', kind: '笔记', workspace: '科研', projectId: 'wiki-release-other-project', content: 'FOREIGN_WIKI_BODY_MUST_NOT_LEAK', createdAt: 1700000000000, updatedAt: 1700000000000 }],
    conversations: [{ id: ORIGINAL_CHAT, title: '原始研究问题 · 合成验收', projectId: PROJECT, workspace: '科研', permissionMode: 'smart', modelConfig: { provider: 'api', model: 'synthetic-wiki-model', effort: 'medium' },
      messages: [{ id: ORIGINAL_MESSAGE, role: 'user', text: '持续检索能否改善长期记忆？', at: 1700000000000 }, { id: 'wiki-release-old-answer', role: 'assistant', text: '原有答复：需要对照实验。', at: 1700000000100 }, { id: 'wiki-release-later-question', role: 'user', text: 'FUTURE_MESSAGE_MUST_NOT_ENTER_BRANCH', at: 1700000000200 }],
      attachments: [], draftAttachmentIds: [], draft: '', createdAt: 1700000000000, updatedAt: 1700000000200 }],
    currentConversationId: ORIGINAL_CHAT, currentProjectId: PROJECT, agentRuns: [], tasks: [], papers: [], imports: [], attachments: [], links: [], trash: []
  };
  await evaluate(`WorkstationOnboarding.close();WorkspaceTour?.close();Object.assign(state,${JSON.stringify(fixture)});state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.notes[0].content=ResearchWiki.markdown('idea',${JSON.stringify(TITLE)},{question:'持续检索能否改善长期记忆？',observations:${JSON.stringify(ORIGINAL_MARKER)},hypothesis:'未验证。'});normalizeStateShape(state);repairRelationships();state.ui.theme='light';state.ui.inspectorOpen=false;state.settings.permissions={日常:'auto',课程:'auto',科研:'auto'};state.ui.workspaceTour={completed:true};applyUiPreferences();showView('agent','对话');renderAll();saveDocumentDurably()`);
  await settleStore(); await installSyntheticTransport();
  originalBody = (await note()).content; originalConversation = await originalMessages();

  await check('editing an older question creates a branch; a synthetic transport failure changes no Wiki body', async () => {
    // Edit lives in the message's overflow menu (MessageActionBar); open it as a user would.
    await click(`details.message-actions-overflow:has([data-edit-message="${ORIGINAL_MESSAGE}"]) > summary`);
    await click(`[data-edit-message="${ORIGINAL_MESSAGE}"]`); await input('.message-edit textarea', EDITED_QUESTION); await click('.message-edit button[type=submit]');
    const first = await pendingAfter(0); requests.push({ phase: 'edited-request', input: first.input });
    assert.doesNotMatch(requestText(first), /FUTURE_MESSAGE_MUST_NOT_ENTER_BRANCH/);
    branchId = await evaluate('currentConversation().id'); assert.notEqual(branchId, ORIGINAL_CHAT);
    assert.equal(await evaluate('currentConversation().branchedFrom.messageId'), ORIGINAL_MESSAGE);
    assert.deepEqual(await originalMessages(), originalConversation);
    await evaluate(`(()=>{const p=__wikiPending;__wikiPending=null;p.reject(Error('合成暂时连接失败，仅用于重试验收'));return true})()`);
    await until(() => evaluate('!sendMessage.busy'), 'synthetic failure settled');
    const failed = await evaluate('state.agentRuns.at(-1)'); failedRunId = failed.id; assert.equal(failed.status, 'failed');
    assert.equal((await note()).content, originalBody); assert.equal((await note()).aiDraft, undefined);
  });

  await check('visible retry performs real complete source reads and produces one draft for the existing Wiki ID', async () => {
    const count = await evaluate('__wikiRequests.length'); await click(`[data-retry-run="${failedRunId}"]`); await pendingAfter(count);
    const next = await reply({ workspace: '科研', knowledgeRequests: [{ type: 'capabilities', name: 'research' }, { type: 'read', recordType: 'note', id: NOTE, offset: 0 }, { type: 'read', recordType: 'note', id: SOURCE, offset: 0 }], workingSummary: '合成测试：读取当前条目及证据。', actions: [] }, true);
    const text = requestText(next); requests.push({ phase: 'actual-read-results', input: next.input });
    assert.ok(text.includes(ORIGINAL_MARKER)); assert.ok(text.includes(EVIDENCE_MARKER)); assert.doesNotMatch(text, /FOREIGN_WIKI_BODY_MUST_NOT_LEAK/);
    const current = await note();
    const sections = await evaluate(`Object.fromEntries(Object.keys(ResearchWiki.fields('idea')).map(key=>[key,'未记录。']))`);
    Object.assign(sections, { question: '持续检索能否改善长期记忆？', observations: ORIGINAL_MARKER + '\n\n' + EVIDENCE_MARKER,
      hypothesis: '未验证。', inferences: ADOPTED_MARKER, contradictions: '合成记录不能外推到真实实验。', validation: '控制相同材料、时长与提示，扩大样本。', nextSteps: '预先定义遗漏的判断规则。' });
    let run = await reply({ workspace: '科研', message: '合成测试：研究记录支持保留不确定性。已提出既有条目的修改草稿，等待审阅。', actions: [{ type: 'upsert_wiki', wikiType: 'idea', noteId: NOTE, title: TITLE, projectId: PROJECT, baseUpdatedAt: current.updatedAt, sections, sourceNoteIds: [SOURCE], sourceAttachmentIds: [] }] });
    updateRunId = run.id;
    // The edited question asks for an update and says "先让我审阅", so the current-turn
    // review intent (docs/CURRENT_TURN_APPROVAL_INTENT_20261002.md) holds the plan for
    // the user's approval. Nothing is drafted before that; approve it through the card.
    assert.equal(run.status, 'awaiting-approval', JSON.stringify(run.validationErrors || run.error));
    assert.deepEqual(run.approvalIntent?.rules, ['zh-human-review-write']); assert.equal((await note()).aiDraft, undefined);
    const approveButton = `([...document.querySelectorAll('.plan-review button')].find(b=>b.textContent.startsWith('批准 ')&&b.textContent.endsWith(' 步')))`;
    await until(() => evaluate(`!!${approveButton}&&!${approveButton}.disabled`), 'plan review ready');
    await evaluate(`${approveButton}.dataset.qaApprove='';true`); await click('[data-qa-approve]');
    await until(() => evaluate(`state.agentRuns.find(r=>r.id===${JSON.stringify(updateRunId)})?.status==='completed'`), 'approved update');
    run = await evaluate(`state.agentRuns.find(r=>r.id===${JSON.stringify(updateRunId)})`); assert.equal(run.mode, 'ai');
    assert.ok(run.knowledgeReads.some(read => read.id === NOTE)); assert.ok(run.knowledgeReads.some(read => read.id === SOURCE));
    assert.ok(run.results.some(result => result.type === 'note' && result.id === NOTE && result.operation === 'drafted'));
    assert.equal((await note()).content, originalBody); assert.match((await note()).aiDraft.content, /新增结论：/);
    assert.equal(await evaluate(`state.notes.filter(n=>n.title===${JSON.stringify(TITLE)}).length`), 1);
    await settleStore(); const persisted = (await disk()).notes.find(n => n.id === NOTE); assert.equal(persisted.content, originalBody); assert.ok(persisted.aiDraft);
    await shot('wiki-draft-result');
  });

  await check('the actual result opens the exact diff and adoption saves one body while preserving the old revision', async () => {
    // Pending drafts use the primary “审阅草稿” file entry. The secondary
    // “审阅修改” action is only present after the current body can be opened.
    await click('[data-halaska-root="ReviewChangeCard"] button[aria-label^="审阅草稿："]');
    await until(() => evaluate(`ReadingPane.isActive('review',${JSON.stringify(updateRunId)})&&!!document.querySelector('[data-draft-review-action=adopt]')`), 'real review');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#previewDialog>.reader-document-frame>.dialog-actions')).display`), 'none', 'the empty document footer must not cover review controls');
    assert.equal(await evaluate(`document.querySelector('[data-review-file][aria-pressed=true]')?.dataset.reviewFile`), NOTE);
    assert.ok((await evaluate(`document.querySelector('.file-review-content').textContent`)).includes(ADOPTED_MARKER));
    await shot('wiki-proposal-review'); await click('[data-draft-review-action=adopt]');
    await until(async () => !(await note()).aiDraft, 'adopted'); await settleStore();
    const adopted = (await disk()).notes.find(n => n.id === NOTE);
    assert.ok(adopted.content.includes(ADOPTED_MARKER)); assert.equal(adopted.revisionHistory.at(-1).content, originalBody);
    assert.equal(adopted.aiDraftHistory.at(-1).action, 'adopt'); assert.equal(adopted.provenance.output.variant, 'body');
    assert.equal(adopted.provenance.origin.conversationId, branchId);
    assert.equal(adopted.provenance.origin.runId, updateRunId);
    assert.equal(await evaluate(`ProjectOutputs.build({state,projectId:${JSON.stringify(PROJECT)}}).items.filter(row=>row.id===${JSON.stringify(NOTE)}).length`), 1);
    await shot('wiki-adopted');
  });

  await check('cold renderer reload preserves the adopted body, old question and immutable proposal snapshot', async () => {
    await settleStore(); await win.loadURL(origin); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'cold reload');
    assert.ok((await note()).content.includes(ADOPTED_MARKER)); assert.equal((await note()).aiDraft, undefined);
    assert.deepEqual(await originalMessages(), originalConversation);
    const snapshot = await evaluate(`state.agentRuns.find(r=>r.id===${JSON.stringify(updateRunId)}).fileChanges.find(c=>c.id===${JSON.stringify(NOTE)})`);
    assert.equal(snapshot.before.content, originalBody); assert.ok(snapshot.after.aiDraft.content.includes(ADOPTED_MARKER));
    assert.equal(await evaluate(`state.agentRuns.filter(r=>r.id===${JSON.stringify(failedRunId)}&&r.status==='failed').length`), 1);
    await installSyntheticTransport();
  });

  await check('Wiki Continue with AI stages the saved entry and source, and a new request actually receives the adopted body', async () => {
    await evaluate(`ReadingPane.hide();showView('wiki','科研 Wiki');ResearchWikiUI.render()`);
    await click(`[data-wiki-note="${NOTE}"] [data-wiki-card-action=continue]`);
    await until(() => evaluate(`currentConversation().id!==${JSON.stringify(branchId)}&&currentConversation().id!==${JSON.stringify(ORIGINAL_CHAT)}`), 'new research conversation');
    followupId = await evaluate('currentConversation().id'); assert.equal(await evaluate('currentConversation().projectId'), PROJECT);
    const staged = await evaluate('currentConversation().draftFileReferences');
    assert.ok(staged.some(ref => ref.id === NOTE)); assert.ok(staged.some(ref => ref.id === SOURCE));
    await input('#agentInput', FOLLOWUP_QUESTION); await click('#agentSend');
    const first = await pendingAfter(0); requests.push({ phase: 'followup-initial', input: first.input });
    // Explicitly ask the same production read tool as a real research model;
    // staging/catalogue visibility alone is not accepted as evidence of use.
    const next = await reply({ workspace: '科研', knowledgeRequests: [{ type: 'read', recordType: 'note', id: NOTE, offset: 0 }, { type: 'read', recordType: 'note', id: SOURCE, offset: 0 }], workingSummary: '合成测试：读取用户刚才保存的正式研究结论。', actions: [] }, true);
    const text = requestText(next); requests.push({ phase: 'followup-actual-read-results', input: next.input });
    assert.ok(text.includes(ADOPTED_MARKER), 'follow-up must receive adopted current body'); assert.ok(text.includes(EVIDENCE_MARKER));
    assert.doesNotMatch(text, /FOREIGN_WIKI_BODY_MUST_NOT_LEAK|FUTURE_MESSAGE_MUST_NOT_ENTER_BRANCH/);
    const before = (await note()).content;
    const run = await reply({ workspace: '科研', message: '合成测试答复：已保存条目说明两个条件都发生遗漏。下一步控制材料、时长、提示与遗漏判定规则；目前不能宣称检索更优。', actions: [] });
    assert.equal(run.status, 'completed'); assert.ok(run.knowledgeReads.some(read => read.id === NOTE)); assert.equal((await note()).content, before); assert.equal((await note()).aiDraft, undefined);
    assert.ok(await evaluate(`currentConversation().messages.some(m=>m.role!=='user'&&m.text.includes('下一步控制材料'))`));
    await settleStore(); await shot('wiki-saved-followup');
  });

  await check('no duplicate Wiki, unrelated mutation, external request or renderer error occurs', async () => {
    const persisted = await disk(); assert.equal(persisted.notes.filter(n => n.title === TITLE).length, 1);
    assert.equal(persisted.notes.find(n => n.id === SOURCE).content, EVIDENCE_MARKER);
    assert.equal(persisted.notes.find(n => n.id === 'wiki-release-foreign').content, 'FOREIGN_WIKI_BODY_MUST_NOT_LEAK');
    assert.deepEqual(await originalMessages(), originalConversation); assert.deepEqual(rendererErrors, []); assert.deepEqual(blockedRequests, []);
    report.identities = { originalConversation: ORIGINAL_CHAT, editedBranch: branchId, failedRun: failedRunId, updateRun: updateRunId, followupConversation: followupId, wiki: NOTE };
  });
  await finish(0);
})().catch(error => { if (!failures.length) failures.push({ label: 'setup/runtime', error: error.stack }); console.error(error.stack); void finish(1); });
