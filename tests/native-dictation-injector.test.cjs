const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native dictation injector strategy, secure refusal and clipboard restore',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-dictation-injector-'));
 try {
  const binary=path.join(temp,'checks');
  const source=['native/Sources/AIBro/NativeDictationInjector.swift','tests/native-dictation-injector.swift'];
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...source.map(file=>path.join(root,file)),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});process.stdout.write(run.stdout);
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/dictation injector checks: \d+; no events posted/);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
