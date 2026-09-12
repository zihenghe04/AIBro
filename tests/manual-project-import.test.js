const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const declaration = prefix => source.split('\n').find(line => line.startsWith(prefix));
const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const noop = () => {};
function element(value = '') { return { value, disabled: false, textContent: '', files: [], close: noop, focus: noop }; }
function baseContext() {
  let n = 0; const elements = new Map();
  const context = {
    state: { projects: [{id:'existing-visa',name:'美国签证准备',workspace:'日常'}],imports:[],notes:[],tasks:[],attachments:[],conversations:[] },
    $: selector => { if (!elements.has(selector)) elements.set(selector,element()); return elements.get(selector); },
    uid: prefix => `${prefix}-test-${++n}`, workspaceName: value => ['课程','科研'].includes(value) ? value : '日常',
    visibleProject: p => !p.archived, Core: {}, save: noop, renderAll: noop, openProject: id => { context.openedProject=id; },
    findProject: () => { throw new Error('Manual operations must never call fuzzy project matching'); }
  };
  vm.createContext(context);
  vm.runInContext(`${declaration('const normalize =') }\n${declaration('const findExactProject =')}`,context);
  return context;
}
test('manual creation honors a distinct visa project name instead of merging the old project', () => {
  const c=baseContext();
  vm.runInContext(declaration('function createProjectFromDialog('),c);
  c.$('#newProjectNameInput').value='签证新实验项目 2026';c.$('#newProjectWorkspaceInput').value='日常';
  c.createProjectFromDialog({preventDefault:noop});
  assert.equal(c.state.projects.length,2);assert.notEqual(c.openedProject,'existing-visa');
  assert.equal(c.state.projects.find(p=>p.id===c.openedProject).name,'签证新实验项目 2026');
  const added=c.openedProject;c.createProjectFromDialog({preventDefault:noop});
  assert.equal(c.state.projects.length,2,'the exact same name still reuses its project');assert.equal(c.openedProject,added);
});
test('new-project assignment uses exact names and moves derived content with the source', () => {
  const c=baseContext();c.assignImportId='attachment';
  c.state.imports.push({id:'attachment',projectId:null});c.state.tasks.push({id:'task',projectId:null,sourceAttachmentIds:['attachment']});c.state.notes.push({id:'note',projectId:null,sourceAttachmentIds:['attachment']});
  vm.runInContext(body('function assignImportFromDialog(', '\nfunction renderResults('),c);
  c.$('#assignWorkspaceInput').value='日常';c.$('#assignNewProjectInput').value='签证新实验项目 归档';c.$('#assignFolderInput').value='原始资料';
  c.assignImportFromDialog({preventDefault:noop});
  assert.equal(c.state.projects.length,2);assert.notEqual(c.openedProject,'existing-visa');
  assert.equal(c.state.projects.find(p=>p.id===c.openedProject).name,'签证新实验项目 归档');
  for (const item of [c.state.imports[0],c.state.tasks[0],c.state.notes[0]]) assert.equal(item.projectId,c.openedProject);
});
function importContext() {
  const c=baseContext();
  c.state.conversations=[{id:'first',title:'原对话',attachments:[]},{id:'second',title:'另一对话',attachments:[]}];c.state.currentConversationId='first';
  c.currentConversation=()=>c.state.conversations.find(x=>x.id===c.state.currentConversationId);
  c.$('#fileInput').files=[{name:'materials.txt',type:'application/octet-stream',size:14}];
  c.renderFileSelection=noop;c.showView=()=>{c.showViewCalls++};c.showViewCalls=0;c.toast=message=>{c.lastToast=message};c.fileStorePut=async()=>{};
  c.calls=[];let finish;
  c.fetch=(url)=>{c.calls.push(url);return url==='/__parse'?new Promise(resolve=>{finish=resolve}):Promise.resolve({ok:true});};
  c.finishParse=()=>finish({ok:true,json:async()=>({id:'imported',content:'准备材料',parser:'text'})});
  c.importMaterials=vm.runInContext(`(${body('async function importMaterials(', '\n// Native macOS builds')})`,c);
  return c;
}
test('double import click while parsing starts one import and never reparents after switching conversation', async () => {
  const c=importContext();const event={preventDefault:noop};
  const first=c.importMaterials(event);assert.equal(c.importMaterials.busy,true);assert.equal(c.$('#startImport').disabled,true);
  await c.importMaterials(event);assert.equal(c.calls.filter(x=>x==='/__parse').length,1);
  c.state.currentConversationId='second';c.finishParse();await first;
  assert.equal(c.state.imports.length,1);assert.deepEqual([...c.state.conversations[0].attachments],['imported']);assert.deepEqual([...c.state.conversations[1].attachments],[]);
  assert.equal(c.state.attachments[0].conversationId,'first');assert.equal(c.showViewCalls,0,'background import must not navigate away from the current conversation');
  assert.match(c.lastToast,/原对话/);assert.equal(c.importMaterials.busy,false);assert.equal(c.$('#startImport').disabled,false);
});
test('deleting the original conversation during parsing does not attach the file to another conversation', async () => {
  const c=importContext();const pending=c.importMaterials({preventDefault:noop});
  c.state.conversations=c.state.conversations.filter(x=>x.id!=='first');c.state.currentConversationId='second';c.finishParse();await pending;
  assert.equal(c.state.imports.length,0);assert.equal(c.state.conversations[0].attachments.length,0);assert.match(c.$('#importProgress').textContent,/原对话已被删除/);
  assert.equal(c.importMaterials.busy,false);assert.equal(c.$('#startImport').disabled,false);
});
