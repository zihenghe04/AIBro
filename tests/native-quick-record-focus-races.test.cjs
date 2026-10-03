const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('production capture read and final native receipt preserve changes made during async hops',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-record-focus-races-'));
 try{
  const names=['NativeQuickRecordFocus','NativeQuickPanelAgent','NativeQuickCaptureStore','NativeQuickCaptureLibraryStore'];
  const binary=path.join(temp,'checks'),compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(__dirname,'native-quick-record-focus-races.swift'),'-o',binary],{encoding:'utf8',timeout:60000});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[path.join(temp,'fixture')],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS: both production async race regressions/);console.log(result.stdout.trim());
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
