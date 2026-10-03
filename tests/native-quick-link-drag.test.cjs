const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process'),{webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function bridge(){
 const state={imports:['a','b','c','d','other'].map((id,i)=>({id,name:'Human '+id,url:'https://example.org/'+id,projectId:'p',workspace:'科研',folderPath:id==='other'?'Other':'Reading',quickLinkOrder:i,content:'Original body '+id})),notes:[],papers:[],tasks:[],links:[],trash:[],attachments:[],agentRuns:[],conversations:[],projects:[{id:'p',name:'Project',workspace:'科研'}],ui:{composerDraft:'Keep this draft'}};
 const ctx={state,storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class{},document:{dispatchEvent(){}},saveDocumentDurably:async()=>true,fetch:()=>{throw Error('No network');}};
 ctx.window={crypto:webcrypto,WorkstationCore:require('../app/workstation-core'),CitationEvidence:require('../app/citation-evidence'),ContentLifecycle:require('../app/content-lifecycle'),PrivateMode:{isOn:()=>false}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'native/Resources/quick-links.js'),'utf8'),ctx);return {state,request:p=>ctx.window.NativeQuickLinks.request(p)};
}
test('E47 real Links store, native grip events, nonce cancellation and durable cross-folder envelope',{skip:process.platform!=='darwin',timeout:180000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-link-drag-'));
 try {
  const b=bridge();fs.writeFileSync(path.join(temp,'bridge.json'),JSON.stringify(await b.request({action:'list'})));
  const binary=path.join(temp,'checks');
  const files=['NativeQuickRecordFocus','NativeQuickLinkIcon','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView'];
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files.map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(__dirname,'native-quick-link-drag.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const result=spawnSync(binary,[temp],{encoding:'utf8',timeout:25000});process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
  const payload=JSON.parse(fs.readFileSync(path.join(temp,'cross-folder.json'),'utf8')),before=JSON.parse(JSON.stringify(b.state));
  const receipt=await b.request(payload);assert.equal(receipt.status,'saved');
  const list=await b.request({action:'list'});assert.deepEqual(Array.from(list.rows.filter(r=>r.folder==='Other'),r=>r.id),['other','b']);
  const changed=b.state.imports.find(r=>r.id==='b'),original=before.imports.find(r=>r.id==='b');
  for(const key of ['id','name','url','content','projectId','workspace'])assert.deepEqual(changed[key],original[key]);
  assert.equal(changed.folderPath,'Other');assert.equal(b.state.ui.composerDraft,'Keep this draft');
  assert.deepEqual(b.state.imports.filter(r=>['a','c','d'].includes(r.id)),before.imports.filter(r=>['a','c','d'].includes(r.id)));
  console.log('PASS actual JS bridge preserves ID/body/manual title/project/draft and source-folder siblings on the Swift cross-folder envelope');
 }finally {fs.rmSync(temp,{recursive:true,force:true})}
});
