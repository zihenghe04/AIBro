const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native optional automatic metadata: real Store/View, durable ordering and visibility leases',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-links-auto-'));
 try {
 const binary=path.join(temp,'checks'),names=['NativeQuickRecordFocus','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView','NativeQuickLinkIcon'];
 const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...names.map(n=>path.join(root,'native/Sources/AIBro/'+n+'.swift')),path.join(__dirname,'native-quick-links-auto-metadata.swift'),'-o',binary],{encoding:'utf8',timeout:70000});assert.equal(build.status,0,build.stdout+build.stderr);
 const run=spawnSync(binary,[path.join(temp,'fixtures')],{encoding:'utf8',timeout:10000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
