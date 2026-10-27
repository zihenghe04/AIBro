const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('live dictation: partial text, auto stop on silence, cloud fallback (fake microphone and sockets)',{skip:process.platform!=='darwin',timeout:240000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-dictation-live-'));
 try{
  const names=['NativeCredentials','NativeSpeechService','NativePlainHTTPPolicy','NativeSpeechCredentials','NativeSpeechDictationRecorder','NativeQuickRealtimeASRProtocol','NativeQuickRealtimeASRSession','NativeQuickRealtimeASRHandoff','NativeQuickRealtimeASRAudio','NativeSpeechDictation'];
  const binary=path.join(tmp,'checks');
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(x=>path.join(root,'native/Sources/AIBro',x+'.swift')),path.join(__dirname,'native-speech-dictation-live.swift'),'-o',binary],{encoding:'utf8',timeout:150000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const ran=spawnSync(binary,[tmp],{encoding:'utf8',timeout:60000});process.stdout.write(ran.stdout);assert.equal(ran.status,0,ran.stdout+ran.stderr);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
