const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('native dictation actual state and isolated audio lifecycle',{skip:process.platform!=='darwin',timeout:150000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-dictation-'));
 try{
  const names=['NativeCredentials','NativeSpeechService','NativeSpeechCredentials','NativeSpeechDictationRecorder','NativeSpeechDictation'];
  const binary=path.join(tmp,'checks');const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(x=>path.join(root,'native/Sources/AIBro',x+'.swift')),path.join(__dirname,'native-speech-dictation.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(built.status,0,built.stdout+built.stderr);if(built.stderr)process.stdout.write(built.stderr);
  const ran=spawnSync(binary,[tmp],{encoding:'utf8',timeout:20000});process.stdout.write(ran.stdout);assert.equal(ran.status,0,ran.stdout+ran.stderr);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
