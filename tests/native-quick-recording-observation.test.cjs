const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('recording visibility publishes delayed host changes to the actual Combine observer',{timeout:60000},t=>{
 if(process.platform!=='darwin')return t.skip('macOS frameworks');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recording-observation-'));
 try {
  const binary=path.join(temp,'checks'),files=['tests/native-quick-recording-observation.swift','native/Sources/AIBro/NativeQuickRecordingTitle.swift','native/Sources/AIBro/NativeQuickRecordingBatch.swift','native/Sources/AIBro/NativeQuickRecordingStore.swift','native/Sources/AIBro/NativeSpeechService.swift','native/Sources/AIBro/NativeSpeechCredentials.swift','native/Sources/AIBro/NativeSpeechSettingsView.swift','native/Sources/AIBro/NativeCredentials.swift','native/Sources/AIBro/AgendaCore.swift','native/Sources/AIBro/NativeQuickRecordingPlayback.swift','native/Sources/AIBro/NativeQuickRealtimeASRHandoff.swift','native/Sources/AIBro/NativeQuickRealtimeASRProtocol.swift','native/Sources/AIBro/NativeQuickRealtimeASRSession.swift','native/Sources/AIBro/NativeQuickRealtimeASRSettings.swift','native/Sources/AIBro/NativeQuickRealtimeASRAudio.swift'];
  const build=spawnSync('xcrun',['swiftc','-target','arm64-apple-macosx14.0',...files.map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:45000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[path.join(temp,'fixtures')],{encoding:'utf8',timeout:5000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
