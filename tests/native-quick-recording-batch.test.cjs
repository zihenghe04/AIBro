const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
test('R05 actual recording archive, store, native view compile and synthetic batch recovery',{timeout:90000},t=>{
 if(process.platform!=='darwin')return t.skip('macOS native frameworks');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recording-batch-'));
 try{
  const binary=path.join(temp,'batch-tests');
  const files=['tests/native-quick-recording-batch.swift','native/Sources/AIBro/NativeQuickRecordingBatch.swift','native/Sources/AIBro/NativeQuickRecordingTitle.swift','native/Sources/AIBro/NativeQuickRecordingStore.swift','native/Sources/AIBro/NativeSpeechService.swift','native/Sources/AIBro/NativeSpeechCredentials.swift','native/Sources/AIBro/NativeSpeechSettingsView.swift','native/Sources/AIBro/NativeCredentials.swift','native/Sources/AIBro/AgendaCore.swift','native/Sources/AIBro/NativeQuickRecordingPlayback.swift','native/Sources/AIBro/NativeQuickRealtimeASRHandoff.swift','native/Sources/AIBro/NativeQuickRealtimeASRProtocol.swift','native/Sources/AIBro/NativeQuickRealtimeASRSession.swift','native/Sources/AIBro/NativeQuickRealtimeASRSettings.swift','native/Sources/AIBro/NativeQuickRealtimeASRAudio.swift','native/Sources/AIBro/NativeQuickRealtimeASRView.swift','native/Sources/AIBro/NativeQuickRecordingProjection.swift','native/Sources/AIBro/NativeQuickRecordingViews.swift','native/Sources/AIBro/NativeQuickWidgetContext.swift'];
  const build=spawnSync('xcrun',['swiftc','-target','arm64-apple-macosx14.0',...files.map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:70000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[path.join(temp,'fixtures')],{encoding:'utf8',timeout:15000});
  process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
