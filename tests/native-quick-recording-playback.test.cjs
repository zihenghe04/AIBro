const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('production recording playback lifecycle and actual Store/SwiftUI compile with synthetic players',{timeout:90000},t=>{
 if(process.platform!=='darwin')return t.skip('macOS frameworks');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recording-playback-'));
 try {
  const binary=path.join(temp,'checks'),files=['tests/native-quick-recording-playback.swift',...['NativeQuickRecordingPlayback','NativeQuickRecordingProjection','NativeQuickRecordingTitle','NativeQuickRecordingBatch','NativeQuickRecordingStore','NativeSpeechService','NativeSpeechCredentials','NativeSpeechSettingsView','NativeCredentials','AgendaCore','NativeQuickRealtimeASRHandoff','NativeQuickRealtimeASRProtocol','NativeQuickRealtimeASRSession','NativeQuickRealtimeASRSettings','NativeQuickRealtimeASRAudio','NativeQuickRealtimeASRView','NativeQuickRecordingViews','NativeQuickWidgetContext'].map(x=>'native/Sources/AIBro/'+x+'.swift')];
  const build=spawnSync('xcrun',['swiftc','-target','arm64-apple-macosx14.0',...files.map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:75000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
