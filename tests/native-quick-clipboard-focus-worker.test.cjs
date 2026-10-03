const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('clipboard opening captures focus off the main actor without replacing the original input', {skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-focus-worker-'));
 try {
  const bin=path.join(dir,'checks');
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',path.join(root,'native/Sources/AIBro/NativeQuickClipboardPasteBack.swift'),path.join(__dirname,'native-quick-clipboard-focus-worker.swift'),'-o',bin],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(bin,[],{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
