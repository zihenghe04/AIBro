const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const Core=require('../app/workstation-core.js'),CitationEvidence=require('../app/citation-evidence.js'),ContentLifecycle=require('../app/content-lifecycle.js');
const bridge=fs.readFileSync(path.join(root,'native/Resources/quick-links.js'),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
function host(fail=false){
 const state={imports:['a','b','c','d','other','child'].map((id,index)=>({id,name:id,url:'https://example.org/'+id,projectId:'p',workspace:'科研',folderPath:id==='other'?'Other':id==='child'?'Reading/Subfolder':'Reading',quickLinkOrder:index,content:'Fictional saved original '+id})),notes:[],papers:[],tasks:[],links:[],trash:[],attachments:[],agentRuns:[],conversations:[],projects:[{id:'p',name:'Project',workspace:'科研'}],ui:{composerDraft:'Preserve this unrelated draft'}};
 let saves=0;
 const context={state,storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class{},document:{dispatchEvent(){}},saveDocumentDurably:async()=>{saves++;return !fail;},fetch:()=>{throw Error('No network');}};
 context.window={crypto:webcrypto,WorkstationCore:Core,CitationEvidence,ContentLifecycle,PrivateMode:{isOn:()=>false}};
 vm.runInNewContext(bridge,context);
 return {state,get saves(){return saves;},setFailure:value=>{fail=value;},request:value=>context.window.NativeQuickLinks.request(value)};
}
test('native folder order actions use durable versions and cancel stale focus', {skip:process.platform!=='darwin',timeout:180000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-link-order-'));
 try{
  const actual=host();fs.writeFileSync(path.join(temp,'bridge-list.json'),JSON.stringify((await actual.request({action:'list'})).rows));
  const production=name=>path.join(root,'native/Sources/AIBro',name+'.swift');
  const binary=path.join(temp,'order-checks');
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...['NativeQuickRecordFocus','NativeQuickLinkIcon','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView'].map(production),path.join(__dirname,'native-quick-link-order-actions.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(binary,[temp],{encoding:'utf8',timeout:20000});
  process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
  const payload=JSON.parse(fs.readFileSync(path.join(temp,'swift-order-payload.json'),'utf8'));
  const originals=copy(actual.state.imports),reply=await actual.request(payload);
  assert.equal(reply.status,'saved');assert.equal(actual.saves,1);
  assert.deepEqual(copy((await actual.request({action:'list'})).rows.filter(row=>row.folder==='Reading').map(row=>row.id)),['a','c','d','b']);
  assert.deepEqual(copy(actual.state.imports.filter(row=>['other','child'].includes(row.id))),originals.filter(row=>['other','child'].includes(row.id)));
  assert.equal(actual.state.ui.composerDraft,'Preserve this unrelated draft');
  console.log('PASS Swift-generated order envelope persists through the actual JS bridge without touching other folders or draft');
  const failed=host(true);
  assert.equal((await failed.request(payload)).reason,'storage_failed');assert.equal(failed.saves,1);
  const uncertain=copy(failed.state.imports);assert.ok(failed.state.ui.nativeQuickLinkReceipts[payload.requestId]);
  failed.setFailure(false);assert.equal((await failed.request(payload)).status,'saved');assert.equal(failed.saves,2);assert.deepEqual(copy(failed.state.imports),uncertain);
  console.log('PASS actual bridge unconfirmed save retains one receipt and retry only confirms the same native operation');
  const stale=host();stale.state.imports.find(row=>row.id==='c').name='Changed while menu was open';const beforeStale=copy(stale.state.imports);
  assert.equal((await stale.request(payload)).reason,'changed');assert.equal(stale.saves,0);assert.deepEqual(copy(stale.state.imports),beforeStale);
  console.log('PASS actual bridge rejects the entire native reorder when one member changed');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
