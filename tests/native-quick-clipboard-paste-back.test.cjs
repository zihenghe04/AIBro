const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {spawnSync}=require('node:child_process');
test('explicit clipboard paste-back is leased to its original application and focus', {skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'), dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-paste-back-'));
 try {
  const bin=path.join(dir,'checks');
  const sources=['NativeQuickClipboard','NativeQuickClipboardArchive','NativeQuickClipboardPasteBack','NativeQuickClipboardView'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift'));
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,path.join(__dirname,'native-quick-clipboard-paste-back.swift'),'-o',bin],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(bin,[dir],{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
