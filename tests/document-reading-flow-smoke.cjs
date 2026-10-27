/* Production renderer + real temporary persistence; no user store or model calls.
 * Run serially: ./node_modules/.bin/electron tests/document-reading-flow-smoke.cjs
 * This is a renderer aid. Native WKWebView acceptance is a separate release gate.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results/document-reading-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-document-reading-'));
const STORE = path.join(TEMP, 'store');
fs.mkdirSync(STORE); fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(TEMP, 'profile'));
let server, win, origin, ending = false;
const checks = [], failures = [], rendererErrors = [], blockedRequests = [], modelRequests = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 18000) { if (await fn()) return; await wait(40); }
  throw Error('Timed out: ' + label);
}
async function shot(name) {
  if (!win || win.isDestroyed()) return;
  fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function check(label, fn) {
  try { await fn(); checks.push(label); console.log('PASS', label); }
  catch (error) {
    failures.push({ label, error: error.stack }); console.error('FAIL', label, error.message);
    await shot('failure-' + failures.length);
  }
}
const click = selector => evaluate(`(()=>{const control=document.querySelector(${JSON.stringify(selector)});if(!control)throw Error('Missing control: '+${JSON.stringify(selector)});if(control.disabled)throw Error('Disabled control: '+${JSON.stringify(selector)});control.click();})()`);
const button = (label, host = 'body') => evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(host)});const control=[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}&&!node.disabled);if(!control)throw Error('Missing enabled button: '+${JSON.stringify(label)});control.click();})()`);
async function settle() {
  await evaluate('saveDocumentDurably()'); await evaluate('flushWorkspace()');
  await until(() => evaluate('!serverSaveInFlight&&!serverSaveQueued&&!state._pendingLocalSave&&!serverConflict'), 'durable store settled');
}
async function storeSnapshot() {
  return evaluate('(async()=>{const response=await fetch("/__state",{cache:"no-store"});if(!response.ok)throw Error("State read failed");return response.json();})()');
}
const watchdog = setTimeout(() => { failures.push({ label: 'watchdog' }); void finish(1); }, 240000);
app.on('window-all-closed', () => {});
async function finish(code) {
  if (ending) return; ending = true; clearTimeout(watchdog);
  win?.destroy();
  if (server) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(1000)]); }
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ passed: checks.length, checks, failures, rendererErrors,
    modelCalls: modelRequests.length, modelRequests, blockedRequests, userWorkspaceLoaded: false,
    clipboardVerification: 'Actual Halaska button and exact navigator.clipboard.writeText payload; native clipboard was not changed',
    temporaryStoreRemoved: !fs.existsSync(TEMP), nativeAcceptance: 'separate gate' }, null, 2));
  app.exit(code);
}
(async () => {
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
  server = spawn('python3', [path.join(ROOT, 'app/server.py')], { cwd: ROOT,
    env: { ...process.env, AI_WORKSTATION_PORT: String(port), AI_WORKSTATION_DATA_DIR: STORE, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', log, log] });
  await until(() => new Promise(resolve => http.get(origin + '/__health', response => { response.resume(); resolve(response.statusCode === 200); }).on('error', () => resolve(false))), 'server');
  fs.mkdirSync(path.join(TEMP,'project')); fs.writeFileSync(path.join(TEMP,'project','local.md'),fs.readFileSync(path.join(ROOT,'tests/fixtures/document-reading-fixture.md'),'utf8').replace('IMAGE_REFERENCE','fixture.png'));
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1500, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    const local = request.url.startsWith(origin + '/');
    const model = local && /\/(?:__proxy|__api|__llm|__models|__codex\/respond)(?:[/?]|$)/.test(new URL(request.url).pathname);
    if (!local) blockedRequests.push(request.url); if (model) modelRequests.push(request.url);
    callback({ cancel: !local || model });
  });
  win.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error('RENDERER', event.message); } });
  await win.loadURL(origin);
  await until(() => evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'), 'hydrate');
  await evaluate(fs.readFileSync(path.join(ROOT, 'tests/fixtures/document-reading-fixture-client.js'), 'utf8'));
  await until(() => evaluate('window.__documentReadingFixtureReady'), 'fixture ready'); await settle();



  const noteHost = '.note-document-preview', localHost = '.local-document-preview';
  let expectedNote, expectedWiki, expectedLocal, localRef;
  const toMode = async label => {
    await until(()=>evaluate(`[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`),'enabled mode '+label);
    await evaluate(`(()=>{const c=[...document.querySelectorAll('.document-toolbar-kit [role=radio]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});c.click();})()`);
    await until(()=>evaluate(label==='源码' ? '!!document.querySelector(".cm-content[contenteditable=true]")' : '!!document.querySelector(".note-document-preview [data-document-markdown],.local-document-preview [data-document-markdown]")'),'mode '+label);
  };
  const openNote = async id => {
    await evaluate(`openPreview('note',${JSON.stringify(id)})`);
    await until(()=>evaluate(`NoteEditor.inlineActive(${JSON.stringify(id)})&&!!document.querySelector('.document-toolbar-kit [role=radio]:not([disabled])')`),'open '+id);
    await toMode('阅读');
  };
  const openOutline = async host => {
    const selector = host==='local' ? '.local-document-outline' : '.note-document-outline';
    if (!await evaluate(`document.querySelector(${JSON.stringify(selector)})?.open`)) await button('大纲','.document-toolbar-kit');
    await until(()=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.open&&document.querySelectorAll(${JSON.stringify(selector+' .note-document-outline-link')}).length>0`),'outline open');
    return selector;
  };
  const articleInfo = host => evaluate(`(()=>{const h=document.querySelector(${JSON.stringify(host)}),a=h?.querySelector('[data-document-markdown]');if(!a)throw Error('Document AST renderer missing');return {headings:[...a.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(n=>({text:n.textContent,id:n.id,start:Number(n.dataset.documentSourceStart)})),properties:!!a.querySelector('details.document-frontmatter'),propertiesOpen:!!a.querySelector('details.document-frontmatter')?.open,nested:a.querySelectorAll('ul ul ul').length,tasks:a.querySelectorAll('input[type=checkbox]').length,quoteList:!!a.querySelector('blockquote ol'),matrix:!!a.querySelector('.katex .mtable'),katex:a.querySelectorAll('.katex').length,katexErrors:a.querySelectorAll('.katex-error').length,table:!!a.querySelector('table'),footnote:!!a.querySelector('.document-footnote-reference a'),image:a.querySelector('img')?.naturalWidth||0,link:a.querySelector('a[href="https://commonmark.org/help/"]')?.getAttribute('target')};})()`);
  await check('ordinary and Wiki image fixtures use real durable managed imports before reader rendering',async()=>{
    await openNote('reading-wiki');
    await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const c=canvas.getContext('2d');c.fillStyle='#5aafa0';c.fillRect(0,0,96,64);c.fillStyle='#18372d';c.fillRect(12,12,72,40);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));window.__readingImageBytes=[...new Uint8Array(await blob.arrayBuffer())];for(const id of ['reading-note','reading-wiki']){const image=await DocumentImages.uploadNote(id,new File([blob],'阅读示意.png',{type:'image/png'}));state.notes.find(n=>n.id===id).content=state.notes.find(n=>n.id===id).content.replace('IMAGE_REFERENCE',image.url);await saveDocumentDurably();}})()`);
    await settle();
    fs.writeFileSync(path.join(TEMP,'project','fixture.png'),Buffer.from(await evaluate('__readingImageBytes')));
    expectedNote=await evaluate('state.notes.find(n=>n.id==="reading-note").content');
    expectedWiki=await evaluate('state.notes.find(n=>n.id==="reading-wiki").content');
    expectedLocal=fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8');
    const persisted=await storeSnapshot();assert.equal(persisted.imports.filter(i=>i.importOrigin?.kind==='document-image'&&i.blobHash).length,2);
    await openNote('reading-note');
    await evaluate(`document.querySelector('${noteHost} img')?.scrollIntoView({block:'center'})`);
    await until(()=>evaluate(`document.querySelector('${noteHost} img')?.naturalWidth===96`),'reference image loaded');
  });
  await check('ordinary reader renders folded frontmatter, nested lists, reference images and matrix math from the real parser',async()=>{
    const info=await articleInfo(noteHost);
    assert.equal(info.properties,true);assert.equal(info.propertiesOpen,false);assert.equal(info.headings.length,7);
    assert.deepEqual(info.headings.map(h=>h.text),['文档阅读一致性','嵌套结构','数学公式','代码与原文','研究结论','重复标题','重复标题']);
    assert.equal(new Set(info.headings.map(h=>h.id)).size,7);assert.ok(info.nested>0);assert.equal(info.tasks,2);
    assert.ok(info.quoteList&&info.matrix&&info.table&&info.footnote);assert.equal(info.katexErrors,0);assert.ok(info.katex>=2);assert.equal(info.image,96);assert.equal(info.link,'_blank');
    await evaluate(`document.querySelector('${noteHost} [data-document-markdown]')?.scrollIntoView({block:'start'})`);await shot('note-reading-light');
  });
  async function anchors(host,label){
    const before=await evaluate('location.href');
    const forward=await evaluate(`(()=>{const a=document.querySelector(${JSON.stringify(host+' .document-footnote-reference a')});a.click();return {target:a.dataset.documentAnchor,focus:document.activeElement.id,url:location.href};})()`);
    assert.equal(forward.focus,forward.target);assert.equal(forward.url,before);
    const back=await evaluate(`(()=>{const a=document.querySelector(${JSON.stringify(host+' .document-footnote-backlinks a')});a.click();const target=document.getElementById(a.dataset.documentAnchor);return {target:a.dataset.documentAnchor,focus:document.activeElement.id,tabIndex:target.tabIndex,url:location.href};})()`);
    assert.equal(back.focus,back.target);assert.equal(back.tabIndex,0);assert.equal(back.url,before);
    const heading=await evaluate(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(host+' a.document-anchor-link')})].find(a=>a.textContent==='跳到研究结论');a.click();return {focus:document.activeElement.textContent,id:document.activeElement.id,target:a.dataset.documentAnchor,url:location.href};})()`);
    assert.equal(heading.focus,'研究结论');assert.equal(heading.id,heading.target);assert.equal(heading.url,before);
    await shot(label+'-anchors');
  }
  await check('ordinary footnote forward/back and heading anchors keep the URL, focus the exact target and retain link tab order',()=>anchors(noteHost,'note'));
  await check('real Halaska code button sends exact original code to clipboard without copying its language label',async()=>{
    await evaluate(`(()=>{window.__readingCopied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__readingCopied.push(text);}}});document.querySelector('${noteHost} code[data-language=python]').scrollIntoView({block:'center'});})()`);
    await until(()=>evaluate(`!!document.querySelector('${noteHost} code[data-language=python]')?.parentElement.previousElementSibling?.querySelector('[data-halaska-root=Button] button')`),'real mounted Kit copy button');
    await evaluate(`document.querySelector('${noteHost} code[data-language=python]').parentElement.previousElementSibling.querySelector('button').click()`);
    await until(()=>evaluate('__readingCopied.length===1'),'clipboard callback');
    assert.equal(await evaluate('__readingCopied[0]'),'def greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("AI Bro"))'.replaceAll('\\n','\n'));
    assert.equal(await evaluate(`document.querySelector('${noteHost} code[data-language=python]').parentElement.previousElementSibling.querySelector('button').textContent.trim()`),'已复制');
    await shot('note-kit-copy');
  });
  async function outlineFlow(host,body,local=false){
    const container=await openOutline(local?'local':'note');
    const model=await evaluate(`DocumentMarkdown.headings(${JSON.stringify(body)})`);
    const rendered=await articleInfo(host);
    assert.deepEqual(rendered.headings.map(h=>({text:h.text,start:h.start})),model.map(h=>({text:h.text,start:h.start})));
    const labels=await evaluate(`[...document.querySelectorAll(${JSON.stringify(container+' .note-document-outline-link')})].map(n=>n.textContent)`);
    assert.deepEqual(labels,model.map(h=>h.text));
    const index=model.findIndex(h=>h.text==='研究结论'),heading=model[index];
    await evaluate(`document.querySelectorAll(${JSON.stringify(container+' .note-document-outline-link')})[${index}].click()`);
    await until(()=>evaluate(`(()=>{const target=[...document.querySelectorAll(${JSON.stringify(host+' h2')})].find(h=>Number(h.dataset.documentSourceStart)===${heading.start});const box=target?.getBoundingClientRect();return box&&box.top>=-5&&box.top<innerHeight;})()`),'read outline target visible');
    await toMode('源码');await openOutline(local?'local':'note');
    await evaluate(`document.querySelectorAll(${JSON.stringify(container+' .note-document-outline-link')})[${index}].click()`);
    const capture=local?'ProjectFiles.capturePosition()':'NoteEditor.capturePosition()';
    await until(()=>evaluate(`${capture}?.selection?.start===${heading.start}&&${capture}?.selection?.end===${heading.end}`),'exact source heading selection');
    const current=await evaluate(local?'ProjectFiles.currentContent().content':'NoteEditor.currentContent().content');assert.equal(current,body);
    assert.equal(body.slice(heading.start,heading.end),'研究结论\n--------'.replaceAll('\\n','\n'));
    await toMode('阅读');
  }
  await check('ordinary AST outline matches rendered headings and selects exact setext source range without mutating text',()=>outlineFlow(noteHost,expectedNote));
  await check('Wiki reading uses the same structural renderer and persistent reference image',async()=>{
    await openNote('reading-wiki');await evaluate(`document.querySelector('${noteHost} img')?.scrollIntoView({block:'center'})`);
    await until(()=>evaluate(`document.querySelector('${noteHost} img')?.naturalWidth===96`),'wiki reference image');
    const info=await articleInfo(noteHost);assert.equal(info.headings.length,7);assert.ok(info.matrix&&info.footnote);assert.equal(info.propertiesOpen,false);
    assert.equal(await evaluate('NoteEditor.currentContent().content'),expectedWiki);
  });
  await check('real renderer reload preserves approved note/Wiki Markdown byte-for-byte and reopens the reader',async()=>{
    await settle();await win.reload();await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'reload hydrated');
    await openNote('reading-note');assert.equal(await evaluate('NoteEditor.currentContent().content'),expectedNote);
    const persisted=await storeSnapshot();assert.equal(persisted.notes.find(n=>n.id==='reading-note').content,expectedNote);assert.equal(persisted.notes.find(n=>n.id==='reading-wiki').content,expectedWiki);
    assert.equal((await articleInfo(noteHost)).headings.length,7);
  });
  await check('local Markdown reader resolves the safe reference image and uses identical document structures',async()=>{
    const candidate=await evaluate(`(async()=>{const r=await fetch('/__local/roots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:${JSON.stringify(path.join(TEMP,'project'))}})});const data=await r.json();if(!r.ok)throw Error(data.error);return data.candidate;})()`);
    await evaluate(`state.projects.find(p=>p.id==='reading-project').localFolder=${JSON.stringify(candidate)};saveDocumentDurably()`);
    localRef={projectId:'reading-project',candidateId:candidate.id,path:'local.md'};
    await evaluate(`openPreview('local-file',ProjectFiles.localId(${JSON.stringify(localRef)}))`);await until(()=>evaluate('!!ProjectFiles.currentContent()'),'local open');await toMode('阅读');
    await evaluate(`document.querySelector('${localHost} img')?.scrollIntoView({block:'center'})`);await until(()=>evaluate(`document.querySelector('${localHost} img')?.naturalWidth===96`),'local ref image');
    const info=await articleInfo(localHost);assert.equal(info.headings.length,7);assert.equal(info.propertiesOpen,false);assert.ok(info.matrix&&info.quoteList&&info.nested&&info.footnote);assert.equal(info.katexErrors,0);
    assert.equal(fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8'),expectedLocal);
  });
  await check('local footnotes and chapter links preserve the active document and keyboard focus',()=>anchors(localHost,'local'));
  await check('local outline uses actual AST headings in read and source modes without changing the file',async()=>{
    await outlineFlow(localHost,expectedLocal,true);assert.equal(fs.readFileSync(path.join(TEMP,'project','local.md'),'utf8'),expectedLocal);
    await shot('local-reading-outline');
  });
  await check('narrow dark reduced-motion reader keeps controls and table/math inside the document width',async()=>{
    win.setSize(820,900);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate(`state.ui.theme='dark';applyUiPreferences();document.querySelector('${localHost} [data-document-markdown]')?.scrollIntoView({block:'start'})`);
    await wait(100);assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),true);
    assert.equal(await evaluate(`(()=>{const a=document.querySelector('${localHost} [data-document-markdown]');return a.scrollWidth<=a.clientWidth+2;})()`),true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${localHost} [data-document-markdown]')).scrollBehavior`),'auto');
    assert.equal(await evaluate('[...document.querySelectorAll(".document-toolbar-kit [role=radio]")].find(n=>n.textContent.trim()==="阅读").disabled'),false);
    await shot('local-reading-narrow-dark');win.webContents.debugger.detach();
  });
  assert.deepEqual(modelRequests,[]);await finish(failures.length||rendererErrors.length?1:0);
})().catch(async error=>{failures.push({label:'fatal',error:error.stack});console.error(error);await shot('fatal');await finish(1);});
