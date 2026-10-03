const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('mirror exact first frame, local preferences, camera fallback and privacy lifecycle',{skip:process.platform!=='darwin',timeout:90000},()=>{
 // Keep the isolated fixture below this checkout: Foundation canonicalizes
 // macOS temporary paths through /var, which this archive correctly rejects.
 const tmp=fs.mkdtempSync(path.join(fs.realpathSync(root),'.mirror-check-'));
 try {
  const files=['NativeQuickMirrorCamera.swift','NativeQuickMirrorPreferences.swift','NativeQuickMirrorStore.swift','NativeQuickMirrorView.swift','NativeQuickWidgetContext.swift'].map(p=>path.join(root,'native/Sources/AIBro',p));
  const binary=path.join(tmp,'checks');
  const compile=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',...files,path.join(root,'tests/native-quick-mirror.swift'),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=spawnSync(binary,[tmp],{encoding:'utf8',timeout:20000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
