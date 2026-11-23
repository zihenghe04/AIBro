const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native dictate trigger key tracking and preferences',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-dictate-trigger-'));
 try {
  const binary=path.join(temp,'checks');
  const source=['native/Sources/AIBro/NativeQuickShortcut.swift','native/Sources/AIBro/NativeSpeechShortcut.swift','native/Sources/AIBro/NativeDictateTrigger.swift','native/Sources/AIBro/NativeDictateLog.swift','native/Sources/AIBro/NativeSettingsRegistry.swift','native/Sources/AIBro/NativeSettingsVoiceBinding.swift','tests/native-dictate-trigger.swift'];
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...source.map(file=>path.join(root,file)),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});process.stdout.write(run.stdout);
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/dictate trigger checks: \d+; no global monitors installed/);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
