const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), {spawnSync}=require('node:child_process');
test('file shelf row drag is prepared as a complete batch before any NSURL writer', {skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'), dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-shelf-drag-'));
 try {
  const bin=path.join(dir,'checks');
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...['NativeQuickFileShelf','NativeQuickFileShelfView','NativeQuickFileShelfPreview'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(__dirname,'native-quick-file-shelf-drag.swift'),'-o',bin],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const run=spawnSync(bin,[dir],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
