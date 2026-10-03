const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {spawnSync}=require('node:child_process');
test('clipboard copy preserves a newer clipboard and suppresses revoked errors', {skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-copy-owner-'));
 try {
  const bin=path.join(temp,'checks');
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...['NativeQuickClipboard','NativeQuickClipboardArchive'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(__dirname,'native-quick-clipboard-copy-ownership.swift'),'-o',bin],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const run=spawnSync(bin,[temp],{encoding:'utf8',timeout:15000}); assert.equal(run.status,0,run.stdout+run.stderr); console.log(run.stdout.trim());
 } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
