const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('V01/V02 real encrypted vault, owner/private/draft guards and sensitive copy expiry',{timeout:90000},t=>{
 if(process.platform!=='darwin')return t.skip('macOS native frameworks');const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-vault-'));
 try{const binary=path.join(temp,'checks'),sources=['tests/native-quick-vault.swift',...['NativeQuickVaultArchive','NativeQuickVaultWorker','NativeQuickVaultPasteboard','NativeQuickVaultStore','NativeQuickVaultView','NativeQuickClipboard','NativeQuickClipboardArchive'].map(n=>'native/Sources/AIBro/'+n+'.swift')];
 const build=spawnSync('xcrun',['swiftc','-target','arm64-apple-macosx14.0',...sources.map(f=>path.join(root,f)),'-o',binary],{encoding:'utf8',timeout:70000});assert.equal(build.status,0,build.stdout+build.stderr);
 const result=spawnSync(binary,[path.join(temp,'fixtures')],{encoding:'utf8',timeout:15000});process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
