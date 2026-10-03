const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('retention is reviewed, atomically applied and exactly undone without capture or private-state side effects',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-clipboard-retention-'));
 try{
  const binary=path.join(dir,'checks'),sources=['NativeQuickClipboard','NativeQuickClipboardArchive','NativeQuickClipboardView','NativeQuickClipboardPasteBack'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift'));
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,path.join(__dirname,'native-quick-clipboard-retention.swift'),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const run=spawnSync(binary,[dir],{encoding:'utf8',timeout:25000});assert.equal(run.status,0,run.stdout+run.stderr);
  assert.match(run.stdout,/PASS: \d+ retention checks/);console.log(run.stdout.trim());
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
