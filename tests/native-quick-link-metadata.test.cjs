const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native metadata bridge ACK, draft, restart, privacy and real offline PNG decode',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-link-metadata-'));try{
 const names=['NativeQuickRecordFocus','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView','NativeQuickLinkIcon'];const output=path.join(temp,'checks');
 const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(n=>path.join(root,'native/Sources/AIBro/'+n+'.swift')),path.join(__dirname,'native-quick-link-metadata.swift'),'-o',output],{encoding:'utf8',timeout:70000});assert.equal(build.status,0,build.stdout+build.stderr);
 const run=spawnSync(output,[path.join(temp,'fixtures')],{encoding:'utf8',timeout:15000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
