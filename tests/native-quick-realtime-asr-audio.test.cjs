const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('single-source audio pipeline preserves local M4A independently of bounded PCM delivery',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-audio-pcm-'));
 try {
  const bin=path.join(dir,'checks');const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',path.join(root,'native/Sources/AIBro/NativeQuickRealtimeASRAudio.swift'),path.join(__dirname,'native-quick-realtime-asr-audio.swift'),'-o',bin],{encoding:'utf8',timeout:60000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(bin,[dir],{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
