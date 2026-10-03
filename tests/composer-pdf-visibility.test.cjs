const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'app');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function fixture() {
  const conversation = { id: 'c', workspace: '日常', projectId: 'p', messages: [], draftFileReferences: [{type:'note',id:'n'}] };
  const pdf = {id:'pdf',projectId:'p',workspace:'日常',name:'Fictional.pdf',mimeType:'application/pdf'};
  const state = {imports:[pdf],notes:[{id:'n',workspace:'日常',title:'Fictional note'}],projects:[{id:'p',workspace:'日常',name:'Fictional project'}],conversations:[conversation],agentRuns:[],papers:[],tasks:[],trash:[]};
  const host = {hidden:true}, input = {value:''}, calls = {mount:0,unmount:0};
  let staged = [];
  const ctx = {state, structuredClone, console, currentConversation:()=>conversation,currentAttachments:()=>staged,
    $: s=>s==='#agentInput'?input:s==='#stagedAttachments'?{}:null,
    document:{getElementById:()=>host},save(){},
    HalaskaUI:{componentNames:['PdfReadModeControl'],mount(h,n,props){calls.mount++;calls.props=props},unmount(){calls.unmount++}}};
  ctx.window=ctx;vm.createContext(ctx);
  for(const file of ['citation-evidence.js','conversation-continuity.js','file-context.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
  vm.runInContext(app.slice(app.indexOf('function activeResultRecord('),app.indexOf('function currentResultEntries(')),ctx);
  vm.runInContext(app.slice(app.indexOf('function renderPdfReadMode('),app.indexOf('function renderDashboard(')),ctx);
  return {ctx,host,input,calls,conversation,pdf,state,render:()=>ctx.renderPdfReadMode(),stage:()=>{staged=[pdf]}};
}
test('a project PDF does not add settings to a composer containing only a note reference',()=>{
 const f=fixture(); f.render(); assert.equal(f.host.hidden,true);assert.equal(f.calls.mount,0);
 f.conversation.messages.push({role:'user',attachmentIds:['pdf'],text:'Earlier file'});
 f.render();assert.equal(f.host.hidden,true,'idle composer must not imply sending every historical attachment');
});
test('staged or explicit PDF references expose controls, source removal hides them',()=>{
 const f=fixture();f.stage();f.render();assert.equal(f.host.hidden,false);
 f.render();assert.equal(f.calls.mount,1,'unchanged state must preserve control focus');
 f.pdf.deletedAt=1;f.render();assert.equal(f.host.hidden,true);assert.equal(f.calls.unmount,1);
 const g=fixture();g.conversation.draftFileReferences=[{type:'import',id:'pdf'}];g.render();assert.equal(g.host.hidden,false);
 g.pdf.private=true;g.render();assert.equal(g.host.hidden,true);
});
test('actual continuation and full review make PDF settings visible; new topic hides them',()=>{
 const f=fixture();f.conversation.messages.push({role:'user',attachmentIds:['pdf'],text:'Analyze this file'});
 f.input.value='继续处理前面的材料';f.render();assert.equal(f.host.hidden,false);
 f.input.value='换个话题';f.render();assert.equal(f.host.hidden,true);
 f.input.value='请检查项目所有资料';f.render();assert.equal(f.host.hidden,false);
 f.conversation.carryPendingAttachments=false;f.input.value='继续';f.render();assert.equal(f.host.hidden,true);
});
