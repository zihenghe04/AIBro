const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('independent HTTP speech configuration, audio, transport and credential lifecycles',{skip:process.platform!=='darwin',timeout:150000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-speech-service-'));
 try{
  const binary=path.join(tmp,'checks');const files=['NativeCredentials','NativeSpeechService','NativeSpeechCredentials'].map(x=>path.join(root,'native/Sources/AIBro',x+'.swift'));
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files,path.join(__dirname,'native-speech-service.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(built.status,0,built.stdout+built.stderr);if(built.stderr)process.stdout.write(built.stderr);
  const ran=spawnSync(binary,[tmp],{encoding:'utf8',timeout:20000});process.stdout.write(ran.stdout);assert.equal(ran.status,0,ran.stdout+ran.stderr);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
