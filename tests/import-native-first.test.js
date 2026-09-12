const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('async function importMaterials(');
assert.ok(start >= 0, 'import handler must exist');
const fn = source.slice(start, source.indexOf('\n// Native macOS builds', start));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const response = (data = {}, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const event = { preventDefault() {} };
function harness(files = [{ name: 'lesson.pdf', type: 'application/pdf', size: 10000000 }], options = {}) {
  let count = 0; const elements = new Map(); const parsing = deferred(); const uploading = options.upload || null;
  const c = {
    AbortController,
    state: { projects: [], imports: [], attachments: [], trash: [], conversations: [ { id:'a',title:'原对话',attachments:[] }, { id:'b',title:'另一对话',attachments:[] } ],currentConversationId:'a' },
    $: id => { if (!elements.has(id)) elements.set(id, { files: [], value:'', textContent:'', disabled:false, close(){this.closed=true;} }); return elements.get(id); },
    uid: prefix => `${prefix}-${++count}`,
    currentConversation: () => c.state.conversations.find(x => x.id === c.state.currentConversationId),
    workspaceName: value => ['日常','课程','科研'].includes(value) ? value : '日常',
    calls: [], saves: 0, renders: 0, cache: [],
    save: () => { c.saves++; }, renderAll: () => { c.renders++; },
    renderFileSelection() {}, showView: () => { c.navigated=true; }, toast: value => { c.message=value; },
    setTimeout: () => 1, clearTimeout() {},
    fileStorePut: async (id,blob) => { c.cache.push({id,blob}); if(options.cacheFails) throw Error('browser cache unavailable'); if(options.cacheStalls) return new Promise(()=>{}); },
    fetch: (url,init) => { c.calls.push({url,init}); return url === '/__parse' ? parsing.promise : uploading ? uploading.promise : Promise.resolve(options.uploadError ? response({error:'磁盘空间不足'}, false) : response()); },
  };
  c.$('#fileInput').files = files;
  vm.createContext(c); c.importMaterials = vm.runInContext(`(${fn})`, c);
  c.finish = async (value={content:'第一页课程内容',pages:[{page:1,text:'第一页课程内容'}],parser:'local'}) => { const jobs = [...(c.importMaterials.indexJobs?.values() || [])]; parsing.resolve(response(value)); await Promise.all(jobs); };
  c.failIndex = async () => { const jobs=[...c.importMaterials.indexJobs.values()]; parsing.reject(Error('解析器不可用')); await Promise.all(jobs); };
  return c;
}

test('PDF original is durable and attached before background parsing completes; no inline binary duplication', async () => {
  const file={name:'course.PDF',type:'',size:10103672,arrayBuffer(){throw Error('No eager base64 conversion');}};
  const c=harness([file]); await c.importMaterials(event);
  assert.equal(c.state.imports.length,1);const item=c.state.imports[0];
  assert.equal(item.mimeType,'application/pdf');assert.equal(item.fileStored,true);assert.equal(item.dataUrl,null);
  assert.equal(item.content,'');assert.equal(item.indexStatus,'pending');assert.equal(item.status,'original-only');
  assert.equal(c.calls[0].url,`/__files/${item.id}`);assert.equal(c.calls[0].init.body,file);
  assert.equal(c.calls[1].url,'/__parse');assert.equal(c.importMaterials.busy,false);assert.equal(c.$('#importDialog').closed,true);
  assert.deepEqual([...c.state.conversations[0].attachments],[item.id]);
  await c.finish(); assert.equal(c.state.imports[0].content,'第一页课程内容');assert.equal(c.state.imports[0].indexStatus,'ready');assert.equal(c.importMaterials.indexJobs.size,0);
});

test('images skip text parsing and a blocked/failed preview cache never prevents importing the saved original', async () => {
  for (const options of [{cacheStalls:true},{cacheFails:true}]) {
    const c=harness([{name:'figure.PNG',type:'',size:99}],options);await c.importMaterials(event);
    assert.equal(c.calls.length,1);assert.equal(c.state.imports[0].mimeType,'image/png');assert.equal(c.state.imports[0].fileStored,true);
    assert.equal(c.state.imports[0].parser,'原件就绪');assert.equal(c.importMaterials.indexJobs.size,0);
  }
});

test('direct file drop imports only dropped files without consuming the file-picker or URL draft', async () => {
  const c=harness([{name:'picker.pdf',type:'application/pdf',size:55}]);
  c.$('#urlInput').value='https://example.com/unsent';c.$('#fileInput').value='existing-file-selection';
  const file={name:'dropped.png',type:'image/png',size:25};
  await c.importMaterials(event,{files:[file]});
  assert.equal(c.state.imports.length,1);assert.equal(c.state.imports[0].name,'dropped.png');
  assert.equal(c.calls[0].init.body,file);assert.equal(c.$('#urlInput').value,'https://example.com/unsent');
  assert.equal(c.$('#fileInput').value,'existing-file-selection');assert.equal(c.$('#importDialog').closed,undefined);
  assert.equal(c.$('#attachmentUploadStatus').hidden,true);
});

test('direct upload errors remain visible in the conversation without opening a modal', async () => {
  const c=harness([],{uploadError:true});await c.importMaterials(event,{files:[{name:'drop.png',type:'image/png',size:25}]});
  assert.equal(c.state.imports.length,0);assert.equal(c.$('#attachmentUploadStatus').hidden,false);
  assert.match(c.$('#attachmentUploadStatus').textContent,/磁盘空间不足/);
  assert.equal(c.$('#importDialog').closed,undefined);
});

test('project-bound imports inherit the original project even after switching to another conversation', async () => {
  const upload=deferred();const c=harness([],{upload});
  c.state.projects=[{id:'course',name:'智能控制',workspace:'课程'},{id:'research',name:'机器人',workspace:'科研'}];
  Object.assign(c.state.conversations[0],{projectId:'course',workspace:'课程'});
  Object.assign(c.state.conversations[1],{projectId:'research',workspace:'科研'});
  const pending=c.importMaterials(event,{files:[{name:'lecture.png',type:'image/png',size:20}]});
  c.state.currentConversationId='b'; upload.resolve(response());await pending;
  assert.equal(c.state.imports[0].projectId,'course');assert.equal(c.state.imports[0].workspace,'课程');
  assert.equal(c.state.conversations[1].attachments.length,0);
});

test('failed original upload does not report success, attach metadata, or begin parsing', async () => {
  const c=harness(undefined,{uploadError:true});await c.importMaterials(event);
  assert.equal(c.state.imports.length,0);assert.equal(c.state.conversations[0].attachments.length,0);assert.equal(c.cache.length,0);
  assert.equal(c.calls.length,1);assert.match(c.$('#importProgress').textContent,/磁盘空间不足/);assert.equal(c.message,undefined);assert.equal(c.importMaterials.busy,false);
});

test('background index updates latest record by id, preserving rename, project, folder and tags after state replacement', async () => {
  const c=harness();await c.importMaterials(event);const id=c.state.imports[0].id;
  c.state=JSON.parse(JSON.stringify(c.state));c.state.projects.push({id:'course',workspace:'课程'});
  Object.assign(c.state.imports[0],{name:'第一讲.pdf',projectId:'course',workspace:'课程',folderPath:'讲义/第一周',tags:['人工标签']});
  await c.finish({name:'wrong-name.pdf',id:'wrong-id',content:'indexed',pages:[{page:47,text:'实践'}],parser:'local'});
  const item=c.state.imports[0];assert.equal(item.id,id);assert.equal(item.name,'第一讲.pdf');assert.equal(item.projectId,'course');assert.equal(item.folderPath,'讲义/第一周');assert.deepEqual([...item.tags],['人工标签']);assert.equal(item.content,'indexed');
});

test('background parser never resurrects deleted attachments or mutates their trash snapshots', async () => {
  const c=harness();await c.importMaterials(event);const deleted=JSON.parse(JSON.stringify(c.state.imports[0]));c.state.trash=[{data:{imports:[deleted]}}];c.state.imports=[];
  const saves=c.saves;await c.finish();assert.equal(c.state.imports.length,0);assert.equal(c.saves,saves);assert.equal(deleted.content,'');
});

test('archiving the attachment or its project while parsing leaves the archived record unchanged', async () => {
  for(const kind of ['attachment','project']) {
    const c=harness();await c.importMaterials(event);
    if(kind==='attachment')c.state.imports[0].archived=true;
    else { c.state.imports[0].projectId='p';c.state.projects.push({id:'p',archived:true}); }
    const before=JSON.stringify(c.state.imports[0]);const saves=c.saves;await c.finish();assert.equal(JSON.stringify(c.state.imports[0]),before);assert.equal(c.saves,saves);
  }
});

test('an intervening content edit or replacement parsing generation cannot be overwritten', async () => {
  for (const patch of [{content:'人工更正内容'}, {indexingToken:'new-generation'}]) {
    const c=harness();await c.importMaterials(event);Object.assign(c.state.imports[0],patch);
    const before=JSON.stringify(c.state.imports[0]);await c.finish();assert.equal(JSON.stringify(c.state.imports[0]),before);
  }
});

test('switching conversations during upload never changes attachment owner; double click is ignored', async () => {
  const upload=deferred();const c=harness(undefined,{upload});const first=c.importMaterials(event);
  c.state.currentConversationId='b';await c.importMaterials(event);assert.equal(c.calls.length,1);
  upload.resolve(response());await first;
  assert.equal(c.state.conversations[0].attachments.length,1);assert.equal(c.state.conversations[1].attachments.length,0);assert.equal(c.state.attachments[0].conversationId,'a');assert.equal(c.navigated,undefined);assert.match(c.message,/原对话/);await c.finish();
});

test('deletion or archiving during original upload does not attach to another conversation', async () => {
  for (const archive of [false,true]) {
    const upload=deferred();const c=harness(undefined,{upload});const first=c.importMaterials(event);
    if(archive)c.state.conversations[0].archived=true;else c.state.conversations.shift();c.state.currentConversationId='b';
    upload.resolve(response());await first;assert.equal(c.state.imports.length,0);assert.equal(c.calls.length,1);assert.match(c.$('#importProgress').textContent,/已被删除或归档/);
  }
});

test('failed or unavailable text indexes preserve a usable original and never turn upload into a failed import', async () => {
  const c=harness();await c.importMaterials(event);await c.failIndex();const item=c.state.imports[0];
  assert.equal(item.fileStored,true);assert.equal(item.status,'original-only');assert.equal(item.indexStatus,'failed');assert.match(item.error,/原件仍可预览/);assert.equal(c.importMaterials.indexJobs.size,0);
  const scanned=harness();await scanned.importMaterials(event);await scanned.finish({content:'',pages:[],warning:'扫描版 PDF'});
  assert.equal(scanned.state.imports[0].indexStatus,'unavailable');assert.equal(scanned.state.imports[0].fileStored,true);
});

test('a partially failed batch keeps successful imports exactly once and clearly identifies only failed files', async () => {
  const c=harness([{name:'first.png',type:'image/png',size:3},{name:'second.png',type:'image/png',size:4}]);
  const fetch=c.fetch;let uploads=0;c.fetch=(url,init)=> ++uploads===2 ? Promise.resolve(response({error:'disk error'},false)) : fetch(url,init);
  await c.importMaterials(event);assert.equal(c.state.imports.length,1);assert.equal(c.state.imports[0].name,'first.png');assert.equal(c.state.conversations[0].attachments.length,1);
  assert.match(c.$('#importProgress').textContent,/second.png/);assert.match(c.message,/已添加 1 份资料，1 份未添加/);assert.equal(c.$('#fileInput').value,'');
});

test('direct project drop durably saves a pending-analysis source without touching conversations or drafts', async () => {
  const c=harness([]);
  c.state.projects=[{id:'course',name:'智能控制',workspace:'课程'}];
  c.state.conversations[0].draft='我的未发送草稿';
  c.state.conversations[0].draftAttachmentIds=['existing'];
  const before=JSON.stringify(c.state.conversations);
  c.currentConversation=()=>{throw Error('project import must not read/create currentConversation');};
  await c.importMaterials(event,{files:[{name:'course.pdf',type:'application/pdf',size:32}],projectId:'course'});
  const item=c.state.imports[0];
  assert.equal(item.projectId,'course');assert.equal(item.workspace,'课程');assert.equal(item.importOrigin,'project');
  assert.equal(item.analysis.status,'pending');assert.equal(item.fileStored,true);
  assert.equal(c.state.attachments.length,0);assert.equal(JSON.stringify(c.state.conversations),before);assert.equal(c.navigated,undefined);
  assert.match(c.message,/待 AI 分析/);
  await c.finish();assert.equal(item.indexStatus,'ready');assert.equal(item.analysis.status,'pending','indexing is not AI analysis');
});

test('project deletion during upload does not attach source to a different project or conversation',async()=>{
  const upload=deferred();const c=harness([],{upload});
  c.state.projects=[{id:'course',name:'智能控制',workspace:'课程'},{id:'other',name:'论文',workspace:'科研'}];
  const pending=c.importMaterials(event,{files:[{name:'source.png',type:'image/png',size:12}],projectId:'course'});
  c.state.projects.shift();c.state.currentProjectId='other';upload.resolve(response());await pending;
  assert.equal(c.state.imports.length,0);assert.equal(c.state.attachments.length,0);
  assert.match(c.$('#projectUploadStatus').textContent,/原项目已被删除或归档/);
});

test('project import with missing target is rejected before any upload and cannot silently become a chat import',async()=>{
  const c=harness([]);await c.importMaterials(event,{files:[{name:'source.png',type:'image/png',size:12}],projectId:null});
  assert.equal(c.calls.length,0);assert.equal(c.state.imports.length,0);assert.match(c.message,/目标项目/);
});
