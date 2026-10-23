/* Production renderer + durable context coordinator + disposable Python store.
 * The model transport is synthetic; every workspace ACK is a real local POST. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'test-results/context-host-20260924'), TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-context-host-')), STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', path.join(TEMP, 'profile'));
const checks = [], failures = [], rendererErrors = [], externalRequests = [], posts = [];
let server, win, origin, syntheticCalls = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const start = Date.now(); while (Date.now() - start < 20000) { if (await fn()) return; await wait(60); } throw Error('Timeout: ' + label); }
function report() { const value = { passed: checks.length, checks, failures, rendererErrors, externalRequests, modelCalls: 0, syntheticTransportCalls: syntheticCalls, statePosts: posts, workspace: TEMP }; fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(value, null, 2)); return value; }
function finish(code) { clearTimeout(watchdog); report(); win?.destroy(); server?.kill('SIGTERM'); app.exit(code); }
const watchdog = setTimeout(() => { failures.push({ error: 'watchdog timeout' }); finish(1); }, 180000);
(async () => {
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); }); origin = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(TEMP, 'server.log'), 'a'); server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT, env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, AI_WORKSTATION_ASSET_DIR: path.join(ROOT, 'app') }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'isolated backend');
  await app.whenReady(); win = new BrowserWindow({ show: false, width: 1240, height: 1040, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.message.startsWith('__CONTEXT_POST ')) posts.push(JSON.parse(event.message.slice(15))); if (event.level === 'error') rendererErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => { const outside = !request.url.startsWith(origin + '/'); if (outside) externalRequests.push(request.url); callback({ cancel: outside }); });
  const evaluate = code => win.webContents.executeJavaScript(code, true).catch(error => { console.error('EVALUATING', code.slice(0, 500)); throw error; });
  const click = selector => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw Error('Missing button: '+${JSON.stringify(selector)});button.click();})()`);
  const settle = async () => { await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()'); await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'all durable saves'); };
  const disk = () => JSON.parse(fs.readFileSync(path.join(STORE, 'workspace.json'), 'utf8'));
  const shot = async name => { await wait(150); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const attachFetch = () => evaluate(`(()=>{window.__contextActualFetch=window.fetch.bind(window);window.__contextSaveMode='';window.__contextSaveHeld=false;window.__contextInjectedFailures=0;window.fetch=async(url,options)=>{const isSave=String(url).includes('/__state')&&options?.method==='POST';if(isSave&&__contextSaveMode){const mode=__contextSaveMode;__contextSaveMode='';if(mode==='hold'){__contextSaveHeld=true;await new Promise(resolve=>window.__contextReleaseSave=resolve);__contextSaveHeld=false;}if(mode==='fail'){__contextInjectedFailures++;throw Error('Synthetic one-request storage outage');}}const response=await __contextActualFetch(url,options);if(isSave)console.log('__CONTEXT_POST '+JSON.stringify({status:response.status,revision:JSON.parse(options.body)._revision}));return response;};})()`);
  const load = async () => { await win.loadURL(origin); await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydration'); await attachFetch(); await settle(); };
  const openContext = async () => { await click('#composerContextWorkbench button'); await until(() => evaluate(`!!document.querySelector('#context-tab-next')`), 'context panel'); await click('#context-tab-next'); };
  const check = async (label, fn) => { await fn(); checks.push(label); console.log('PASS', label); };
  await load();
  await evaluate(`(async()=>{WorkstationOnboarding.close();WorkspaceTour.close();state.ui.onboarding={version:1,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};const now=Date.now();state.projects=[{id:'context-project',name:'上下文隔离项目',workspace:'日常',updatedAt:1}];state.tasks=[];state.links=[];state.papers=[];state.attachments=[];state.trash=[];state.notes=[{id:'context-note',title:'上下文原文',content:'Original exact source text.',workspace:'日常',projectId:'context-project',project:'上下文隔离项目',updatedAt:1},{id:'context-extra',title:'另一份资料',content:'Independent concurrent source.',workspace:'日常',projectId:'context-project',project:'上下文隔离项目',updatedAt:1}];state.imports=[{id:'context-import',name:'上下文附件.txt',originalName:'context.txt',content:'Historical attachment body.',mimeType:'text/plain',size:27,createdAt:1,workspace:'日常',projectId:'context-project',project:'上下文隔离项目'}];state.skills=[{id:'skill_context',name:'当前技能',command:'context-check',instructions:'NEXT_SKILL_INSTRUCTION',description:'Synthetic context verification',enabled:true}];const nr=await FileContext.libraryRef(state,'note','context-note'),ir=await FileContext.libraryRef(state,'import','context-import');window.__initialRefs={nr,ir};state.conversations=[{id:'context-chat',title:'上下文真实保存验收',workspace:'日常',projectId:'context-project',permissionMode:'auto',modelConfig:{provider:'api',model:'next-model',effort:'medium'},skillIds:['skill_context'],draft:'保留手写草稿',attachments:['context-import'],draftAttachmentIds:['context-import'],draftFileReferences:[nr,ir],messages:[{id:'historical-user',role:'user',text:'Earlier request',at:now-2000,attachmentIds:['context-import'],attachments:[{id:'context-import',name:'上下文附件.txt'}],fileReferences:[nr,ir],retryFileReferences:[nr,ir],retryAttachmentIds:['context-import'],skillSnapshot:[{id:'skill_context',name:'历史技能',instructions:'OLD_SKILL_INSTRUCTION'}]},{id:'historical-answer',role:'agent',text:'Earlier completed response.',runId:'historical-run',runStatus:'completed',at:now-1000}],pendingSubmits:[{id:'context-queue',goal:'Keep queued snapshots',attachmentIds:['context-import'],fileReferences:[ir],at:now}]}];state.agentRuns=[{id:'historical-run',conversationId:'context-chat',userMessageId:'historical-user',projectId:'context-project',status:'completed',startedAt:now-2000,finishedAt:now-1000,modelConfig:{provider:'api',model:'historical-model',effort:'low'},permissionMode:'smart',fileReferences:[nr,ir],attachmentIds:[],skillSnapshot:[{id:'skill_context',name:'历史技能',instructions:'OLD_SKILL_INSTRUCTION'}],steps:[]}];state.currentConversationId='context-chat';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};state.settings.skillsEnabled=true;normalizeStateShape(state);state.ui.theme='light';state.ui.inspectorOpen=false;applyUiPreferences();showView('agent','对话');renderAll();})()`);
  await settle(); await openContext(); await settle();
  await check('production context UI separates current model/skills from historical request snapshots', async () => {
    assert.match(await evaluate(`document.querySelector('#context-panel-next').textContent`), /next-model/);
    assert.match(await evaluate(`document.querySelector('#context-panel-next').textContent`), /当前技能/);
    await click('#context-tab-recent'); const recent = await evaluate(`document.querySelector('#context-panel-recent').textContent`); assert.match(recent, /historical-model/); assert.match(recent, /历史技能/);
    await click('#context-tab-next'); assert.equal(await evaluate(`document.querySelector('#contextWorkbench').dataset.halaskaRoot`), 'ContextWorkbenchSurface'); await shot('next-context-light');
  });
  let history;
  await check('clicked removal remains saving until real POST ACK and blocks a racing send', async () => {
    history = await evaluate(`JSON.stringify({messages:currentConversation().messages,run:state.agentRuns[0],queue:currentConversation().pendingSubmits})`);
    await settle(); await evaluate(`window.__contextSaveMode='hold'`); await click('[aria-label="从下次发送移除 上下文附件.txt"]');
    await until(() => evaluate('__contextSaveHeld'), 'held real state POST'); assert.equal(await evaluate('contextSelection.isBusy()'), true);
    assert.match(await evaluate(`document.querySelector('.context-save-feedback').textContent`), /正在保存/);
    const before = await evaluate('state.agentRuns.length'); await evaluate(`sendMessage({goal:'Must not race selection save'})`); assert.equal(await evaluate('state.agentRuns.length'), before);
    assert.ok(disk().conversations.find(c => c.id === 'context-chat').draftAttachmentIds.includes('context-import'));
    await evaluate('__contextReleaseSave()'); await until(() => evaluate('!contextSelection.isBusy()'), 'selection durable ACK');
    assert.ok(posts.length > 0); assert.equal(posts.at(-1).status, 200);
  });
  await check('durable removal excludes continuity and both draft paths while preserving user, run, retry and queue snapshots', async () => {
    await settle(); const c = disk().conversations.find(c => c.id === 'context-chat'); assert.ok(!c.draftAttachmentIds.includes('context-import')); assert.ok(!c.draftFileReferences.some(ref => ref.type === 'import'));
    assert.ok(c.excludedFileReferenceKeys.includes(JSON.stringify(['import', 'context-import'])));
    assert.equal(await evaluate(`JSON.stringify({messages:currentConversation().messages,run:state.agentRuns[0],queue:currentConversation().pendingSubmits})`), history);
    assert.equal(await evaluate(`ConversationContinuity.build(state,currentConversation(),{goal:'继续'}).attachmentIds.includes('context-import')`), false);
  });
  await check('full reload retains removed import and its historical immutable records', async () => {
    await load(); await openContext(); assert.equal(await evaluate(`FileContext.references(currentConversation()).some(ref=>ref.type==='import')`), false);
    assert.equal(await evaluate(`ConversationContinuity.build(state,currentConversation(),{goal:'继续'}).attachmentIds.includes('context-import')`), false);
    assert.equal(await evaluate(`JSON.stringify({messages:currentConversation().messages,run:state.agentRuns[0],queue:currentConversation().pendingSubmits})`), history);
  });
  await check('one failed storage request rolls back removal, preserves concurrent draft/reference/queue edits, and persists recovery', async () => {
    await evaluate(`(async()=>{await contextSelection.mutate({action:'add-reference',conversationId:currentConversation().id,ref:await FileContext.libraryRef(state,'import','context-import')});currentConversation().draftAttachmentIds=['context-import'];renderAll();})()`); await settle();
    await evaluate(`window.__contextSaveMode='hold'`); await click('[aria-label="从下次发送移除 上下文附件.txt"]'); await until(() => evaluate('__contextSaveHeld'), 'failure gate');
    // The intercepted request is failed once before it reaches the real server.
    await evaluate(`(()=>{const old=window.__contextActualFetch;window.__contextActualFetch=(url,opts)=>{window.__contextActualFetch=old;window.__contextInjectedFailures++;return Promise.reject(Error('Synthetic one-request storage outage'));};currentConversation().draft='并发输入仍保留';currentConversation().draftFileReferences.push({type:'note',id:'context-extra',title:'另一份资料',version:'concurrent-version'});currentConversation().pendingSubmits.push({id:'queue-concurrent',goal:'Concurrent queue survives',attachmentIds:[],at:Date.now()});__contextReleaseSave();})()`);
    await until(() => evaluate('!contextSelection.isBusy()'), 'failed save settled');
    assert.match(await evaluate(`document.querySelector('.context-save-feedback').textContent`), /中断|保存|失败/);
    assert.equal(await evaluate('__contextInjectedFailures'), 1); assert.equal(await evaluate('currentConversation().draft'), '并发输入仍保留');
    assert.equal(await evaluate(`currentConversation().draftFileReferences.some(ref=>ref.id==='context-extra')`), true);
    assert.equal(await evaluate(`currentConversation().draftAttachmentIds.includes('context-import')`), true);
    assert.equal(await evaluate(`currentConversation().pendingSubmits.some(item=>item.id==='queue-concurrent')`), true);
    await settle(); const c = disk().conversations.find(c => c.id === 'context-chat'); assert.ok(c.draftAttachmentIds.includes('context-import')); assert.equal(c.draft, '并发输入仍保留');
  });
  await check('clicking refresh after source edit updates only next-message version and survives reload', async () => {
    await evaluate(`state.notes.find(n=>n.id==='context-note').content='Updated exact source text for the next request.';ContextWorkbench.refresh();`);
    await until(() => evaluate(`document.querySelector('#context-panel-next .context-material.is-changed')!==null`), 'changed reference warning');
    const original = await evaluate(`JSON.stringify({message:currentConversation().messages[0],run:state.agentRuns[0],queue:currentConversation().pendingSubmits})`);
    await click('[aria-label="更新引用 上下文原文"]'); await until(() => evaluate('!contextSelection.isBusy()'), 'reference refresh'); await settle();
    assert.equal(await evaluate(`JSON.stringify({message:currentConversation().messages[0],run:state.agentRuns[0],queue:currentConversation().pendingSubmits})`), original);
    assert.equal(await evaluate(`FileContext.references(currentConversation()).find(r=>r.id==='context-note').version===currentConversation().messages[0].fileReferences.find(r=>r.id==='context-note').version`), false);
    await load(); await openContext(); assert.equal(await evaluate(`(async()=>FileContext.references(currentConversation()).find(r=>r.id==='context-note').version===(await FileContext.libraryRef(state,'note','context-note')).version)()`), true);
  });
  await check('an already open source preview is cleared when its source becomes private', async () => {
    await click('[aria-label="预览 上下文原文"]'); await until(() => evaluate(`!!document.querySelector('#previewDialog:not([hidden])')?.textContent.includes('Updated exact source text')`), 'actual source preview');
    await evaluate(`state.notes.find(n=>n.id==='context-note').private=true;renderAll();`);
    assert.equal(await evaluate(`!!document.querySelector('#previewDialog:not([hidden])')?.textContent.includes('Updated exact source text')`), false);
    assert.equal(await evaluate(`document.querySelector('#context-panel-next').textContent.includes('上下文原文')`), false);
    assert.equal(await evaluate(`document.querySelector('#previewDialog').textContent.includes('Updated exact source text')`), false, 'hidden reader DOM must clear private source text');
    }).catch(error => { failures.push({ check: 'source preview privacy reconciliation', error: error.stack }); console.error('FAIL privacy', error); });
  await evaluate(`delete state.notes.find(n=>n.id==='context-note').private;renderAll();ReadingPane.hide();`);
  await check('an import source that becomes private is removed from visible and hidden reader content', async () => {
    await click('[aria-label="预览 上下文附件.txt"]');
    await until(() => evaluate(`state.previewRecord?.id==='context-import'&&document.querySelector('#previewContent').textContent.includes('Historical attachment body.')`), 'import source preview');
    await evaluate(`state.imports.find(item=>item.id==='context-import').private=true;renderAll();`);
    assert.equal(await evaluate(`ReadingPane.isActive('import','context-import')`), false);
    assert.equal(await evaluate(`document.querySelector('#previewDialog').textContent.includes('Historical attachment body.')`), false, 'hidden import reader must clear private extracted text');
    assert.equal(await evaluate(`document.querySelector('#previewDialog').textContent.includes('上下文附件.txt')`), false, 'hidden import reader must clear private title');
  }).catch(error => { failures.push({ check: 'import preview privacy reconciliation', error: error.stack }); console.error('FAIL import privacy', error); });
  await evaluate(`delete state.imports.find(item=>item.id==='context-import').private;renderAll();ReadingPane.hide();`);
  let submittedRun;
  await check('actual sendMessage receives refreshed source and freezes model, skill and selection before synthetic transport completes', async () => {
    // Queued fixtures already passed preservation checks; remove them explicitly
    // so completion cannot dispatch a second unrelated synthetic request.
    await evaluate(`(async()=>{currentConversation().pendingSubmits=[];currentConversation().draftAttachmentIds=[];FileContext.remove(currentConversation(),{type:'import',id:'context-import'});FileContext.remove(currentConversation(),{type:'note',id:'context-extra'});currentConversation().modelConfig={provider:'api',model:'submitted-model',effort:'medium'};currentConversation().skillIds=['skill_context'];ConversationModels.resolve=async config=>config;getApiConnection=async()=>({base:'https://fixture.invalid/v1',token:'isolated-test-placeholder'});window.__contextCalls=[];AgentTransport.requestPlan=options=>{__contextCalls.push({model:options.model,effort:options.effort,input:options.input});return new Promise(resolve=>window.__contextFinishModel=()=>resolve(JSON.stringify({workspace:'日常',message:'已使用本轮明确来源回答。',actions:[]})));};renderAll();})()`); await settle();
    await evaluate(`void sendMessage({goal:'根据明确引用的笔记简要回答，不创建任何内容。'});`);
    await until(() => evaluate('!!window.__contextFinishModel'), 'synthetic transport received actual host input');
    syntheticCalls = await evaluate('__contextCalls.length'); assert.equal(syntheticCalls, 1);
    const request = await evaluate('__contextCalls[0]'); assert.equal(request.model, 'submitted-model'); assert.match(JSON.stringify(request.input), /Updated exact source text/); assert.match(JSON.stringify(request.input), /NEXT_SKILL_INSTRUCTION/);
    submittedRun = await evaluate('state.agentRuns.at(-1).id');
    await evaluate(`currentConversation().modelConfig={provider:'api',model:'next-after-submit',effort:'high'};currentConversation().skillIds=[];state.skills[0].instructions='MODIFIED_AFTER_SUBMIT';ContextWorkbench.refresh();`);
    await click('#context-tab-next'); assert.match(await evaluate(`document.querySelector('#context-panel-next').textContent`), /next-after-submit/);
    await click('#context-tab-recent'); assert.match(await evaluate(`document.querySelector('#context-panel-recent').textContent`), /submitted-model/); assert.match(await evaluate(`document.querySelector('#context-panel-recent').textContent`), /当前技能/);
    assert.equal(await evaluate(`state.agentRuns.at(-1).skillSnapshot[0].instructions`), 'NEXT_SKILL_INSTRUCTION');
    await evaluate('__contextFinishModel()'); await until(() => evaluate('!sendMessage.busy'), 'real host completion');
    assert.equal(await evaluate(`state.agentRuns.find(r=>r.id===${JSON.stringify(submittedRun)}).status`), 'completed', await evaluate('state.agentRuns.at(-1).error||""')); await settle(); await shot('latest-request-frozen');
  });
  await check('saved completed request retains its model, skills, exact supplied evidence and selected references after full reload', async () => {
    await load(); await openContext(); await click('#context-tab-recent');
    const run = await evaluate(`state.agentRuns.find(r=>r.id===${JSON.stringify(submittedRun)})`); assert.equal(run.modelConfig.model, 'submitted-model'); assert.deepEqual(run.skillIds, ['skill_context']); assert.equal(run.fileReferences.length, 1); assert.equal(run.fileReferences[0].id, 'context-note');
    const recent = await evaluate('ContextWorkbench.recentRequest(state,currentConversation())'); assert.ok(recent.sources.some(source => JSON.stringify(source).includes('Updated exact source text')), 'request must retain actual supplied source text');
    assert.match(await evaluate(`document.querySelector('#context-panel-recent').textContent`), /submitted-model/);
    await click('#context-tab-next'); assert.match(await evaluate(`document.querySelector('#context-panel-next').textContent`), /next-after-submit/);
  });
  await check('context tabs preserve keyboard navigation and bounded ordinary-width dark layout', async () => {
    win.setSize(1180, 1000); await evaluate(`state.ui.theme='dark';applyUiPreferences();document.querySelector('#context-tab-next').focus();document.querySelector('#context-tab-next').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
    assert.equal(await evaluate(`document.activeElement.id`), 'context-tab-recent'); assert.equal(await evaluate(`document.querySelector('#context-tab-recent').getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(`document.querySelector('#contextWorkbench').scrollWidth<=document.querySelector('#contextWorkbench').clientWidth+1`), true); await shot('context-dark-keyboard');
  });
  assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []); assert.ok(posts.every(event => event.status === 200));
  console.log(JSON.stringify(report(), null, 2)); finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ error: error.stack }); console.error(error); finish(1); });
