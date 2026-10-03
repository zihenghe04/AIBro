const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('production record focus waits for mounted ACK and preserves current scope and drafts in all four modules',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-record-focus-'));
 try{
  const sources=['NativeQuickRecordFocus','NativeTaskInboxParser','NativeTaskInbox','NativeQuickWorkbench','NativeQuickTaskLifecycle','NativeQuickTaskDeadlinePresets','NativeQuickCaptureStore','NativeQuickCaptureLibraryStore','NativeQuickLinkSitePolicy','NativeQuickLinksStore','AgendaCore','AgendaSync','AgendaEditing','AgendaStore','NativeQuickAgendaStore'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift'));
  const binary=path.join(temp,'checks');const compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,path.join(__dirname,'native-quick-record-focus.swift'),'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[path.join(temp,'fixture')],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS: all record focus gates/);console.log(result.stdout.trim());
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
