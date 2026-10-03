const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
// Drive the existing native-quick-agenda.swift regressions with their complete
// production dependency list, including A04's actual focus implementation.
test('quick agenda existing store regression compiles with production focus and view dependencies',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-quick-agenda-store-'));
 try{
  const names=['NativeL10n','NativeQuickRecordFocus','AgendaCore','AgendaSync','AgendaEditing','AgendaStore','NativeQuickAgendaStore','NativeQuickAgendaView'];
  const fixture=path.join(temp,'existing-agenda-checks.swift');
  // The old standalone fixture supplied only nativeUI. Use real NativeL10n
  // now that the actual View also participates in this compile target.
  fs.writeFileSync(fixture,fs.readFileSync(path.join(__dirname,'native-quick-agenda.swift'),'utf8').replace(/^func nativeUI\(_ zh:String,_ en:String\)->String \{en\}\n/m,''));
  const binary=path.join(temp,'checks'),compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),fixture,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/quick agenda checks passed/);console.log(result.stdout.trim());
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
