const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process'),{webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function bridge(){
 const state={imports:[['a','docs.example.com','Reading','p'],['b','news.example.com','Reading','p'],['other-project','docs.example.com','Elsewhere','p2'],['tenant','alice.github.io','Personal','p']].map(([id,host,folderPath,projectId])=>({id,name:'Manual '+id,url:'https://'+host+'/saved',projectId,workspace:'科研',folderPath,content:'Keep original content '+id})),notes:[],papers:[],tasks:[],links:[],trash:[],attachments:[],agentRuns:[],conversations:[],projects:['p','p2'].map(id=>({id,name:'Fictional '+id,workspace:'科研'})),ui:{composerDraft:'Unrelated original draft'}};
 const ctx={state,storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class{},document:{dispatchEvent(){}},saveDocumentDurably:async()=>true,fetch:()=>{throw Error('No network');}};
 ctx.window={crypto:webcrypto,WorkstationCore:require('../app/workstation-core'),CitationEvidence:require('../app/citation-evidence'),ContentLifecycle:require('../app/content-lifecycle'),PrivateMode:{isOn:()=>false}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'native/Resources/quick-links.js'),'utf8'),ctx);return {state,request:p=>ctx.window.NativeQuickLinks.request(p)};
}
test('same-site policy, real Links Store/View and explicit existing-folder add',{skip:process.platform!=='darwin',timeout:120000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-link-site-'));
 try {
  const b=bridge();fs.writeFileSync(path.join(temp,'bridge.json'),JSON.stringify(await b.request({action:'list'})));
  const binary=path.join(temp,'checks'),files=['NativeQuickRecordFocus','NativeQuickLinkIcon','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView'];
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files.map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(__dirname,'native-quick-link-site.swift'),'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const result=spawnSync(binary,[temp],{encoding:'utf8',timeout:15000});process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
  const payload=JSON.parse(fs.readFileSync(path.join(temp,'add.json'),'utf8')),before=JSON.parse(JSON.stringify(b.state));
  const saved=await b.request(payload);assert.equal(saved.status,'saved');assert.equal(saved.requestId,payload.requestId);
  const added=b.state.imports.find(r=>r.id===payload.requestId);assert.equal(added.folderPath,'Reading');assert.equal(added.projectId,'p');assert.equal(added.name,'Keep manual title');
  assert.deepEqual(b.state.imports.filter(r=>r.id!==payload.requestId),before.imports);assert.equal(b.state.ui.composerDraft,before.ui.composerDraft);
  assert.equal((await b.request(payload)).duplicate,false);assert.equal(b.state.imports.length,before.imports.length+1);
  console.log('PASS actual production bridge adds to explicitly accepted folder, retains all originals and replays the same request once');
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
