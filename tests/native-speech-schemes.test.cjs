const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('named speech schemes, atomic storage, active export and explicit synthetic connection test',{skip:process.platform!=='darwin',timeout:150000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-speech-schemes-'));
 try {
  const binary=path.join(temp,'checks');
  const files=['NativeCredentials','NativeSpeechService','NativePlainHTTPPolicy','NativeSpeechCredentials'].map(name=>path.join(root,'native/Sources/AIBro',name+'.swift'));
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files,path.join(__dirname,'native-speech-schemes.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const ran=spawnSync(binary,[temp],{encoding:'utf8',timeout:20000});process.stdout.write(ran.stdout);assert.equal(ran.status,0,ran.stdout+ran.stderr);
 } finally {fs.rmSync(temp,{recursive:true,force:true})}
});
