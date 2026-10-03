const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('explicit recording cloud action, real archive commit and async owner/draft protection',{timeout:120000},t=>{
 if(process.platform!=='darwin')return t.skip('macOS frameworks');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recording-cloud-'));
 try {
  const binary=path.join(temp,'checks'),files=['tests/native-recording-cloud-transcription.swift',...['NativeQuickRecordingPlayback','NativeQuickRecordingProjection','NativeQuickRecordingTitle','NativeQuickRecordingBatch','NativeQuickRecordingStore','NativeQuickRealtimeASRHandoff','NativeQuickRealtimeASRProtocol','NativeQuickRealtimeASRSession','NativeQuickRealtimeASRSettings','NativeQuickRealtimeASRAudio','NativeQuickRealtimeASRView','NativeQuickRecordingViews','NativeQuickWidgetContext','NativeSpeechService','NativeSpeechCredentials','NativeSpeechSettingsView','NativeCredentials','AgendaCore'].map(x=>'native/Sources/AIBro/'+x+'.swift')];
  const build=spawnSync('xcrun',['swiftc','-target','arm64-apple-macosx14.0',...files.map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:100000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:15000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
