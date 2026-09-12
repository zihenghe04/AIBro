const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const R=require('../scripts/release-runtime'),P=require('../scripts/release-macos');
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-runtime-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function tar(entries){return Buffer.concat([...entries.flatMap(e=>{const h=Buffer.alloc(512);h.write(e.name,0,100);h.write('0000755\0',100,8);const data=Buffer.from(e.data||'');h.write(data.length.toString(8).padStart(11,'0')+'\0',124,12);h.fill(32,148,156);h.write(e.type||'0',156,1);if(e.link)h.write(e.link,157,100);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return [h,data,Buffer.alloc((512-data.length%512)%512)];}),Buffer.alloc(1024)]);}
test('runtime inputs have exact HTTPS checksums and PDF source matches pinned requirement',()=>{for(const item of [R.LOCK.python,R.LOCK.pythonLicenses,...R.LOCK.wheels,...R.LOCK.sources])assert.doesNotThrow(()=>R.validateArtifact(item));assert.ok(fs.readFileSync(path.join(__dirname,'../requirements.txt'),'utf8').includes('PyMuPDF=='+R.LOCK.wheels.find(x=>x.name==='PyMuPDF').version));assert.equal(R.LOCK.sources.find(x=>x.name==='MuPDF').version,'1.26.10');assert.match(R.notices(),/AGPL/);});
test('archive extraction preserves safe links and rejects traversal before writing',t=>{const root=temp(t),archive=path.join(root,'python.tar.gz'),out=path.join(root,'out');fs.writeFileSync(archive,zlib.gzipSync(tar([{name:'python/bin/python3.12',data:'fixture'},{name:'python/bin/python3',type:'2',link:'python3.12'}])));R.unpackPython(archive,out);assert.equal(fs.readFileSync(path.join(out,'bin/python3'),'utf8'),'fixture');for(const entry of [{name:'python/../../outside',data:'bad'},{name:'python/bin/link',type:'2',link:'../../../outside'},{name:'python/hard',type:'1',link:'elsewhere'}]){fs.writeFileSync(archive,zlib.gzipSync(tar([entry])));assert.throws(()=>R.unpackPython(archive,path.join(root,'bad')));}assert.equal(fs.existsSync(path.join(root,'bad')),false);assert.equal(fs.existsSync(path.join(root,'outside')),false);});
test('archive checksum and duplicate paths fail instead of replacing files',t=>{const root=temp(t),archive=path.join(root,'x.gz');const corrupted=tar([{name:'python/file',data:'ok'}]);corrupted[0]^=1;assert.throws(()=>R.tarEntries(corrupted,()=>{}),/checksum/);fs.writeFileSync(archive,zlib.gzipSync(tar([{name:'python/file',data:'a'},{name:'python/file',data:'b'}])));assert.throws(()=>R.unpackPython(archive,path.join(root,'out')),/Duplicate/);assert.equal(fs.existsSync(path.join(root,'out')),false);});
test('cached digest mismatch is rejected without downloading or altering prior cache',t=>{const root=temp(t),bytes=Buffer.from('good'),artifact={filename:'fixture.tar.gz',url:'https://example.invalid/fixture.tar.gz',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};fs.writeFileSync(path.join(root,artifact.filename),'bad!');assert.throws(()=>R.download(artifact,root),/checksum mismatch/);assert.equal(fs.readFileSync(path.join(root,artifact.filename),'utf8'),'bad!');fs.writeFileSync(path.join(root,artifact.filename),bytes);assert.equal(R.download(artifact,root),path.join(root,artifact.filename));});
test('content tree hash survives relocation and detects file or link changes',t=>{const root=temp(t),first=path.join(root,'a'),second=path.join(root,'b');fs.mkdirSync(first);fs.writeFileSync(path.join(first,'file'),'fixture');fs.symlinkSync('file',path.join(first,'link'));fs.writeFileSync(path.join(first,'runtime.json'),'ignored circular metadata');const hash=R.treeHash(first);fs.renameSync(first,second);assert.equal(R.treeHash(second),hash);fs.writeFileSync(path.join(second,'file'),'changed');assert.notEqual(R.treeHash(second),hash);});
test('release output is new-only and platform labels cannot silently claim arm64',t=>{const root=temp(t);assert.throws(()=>P.checkOutput(root,{platform:'darwin',arch:'arm64'}),/already exists/);assert.throws(()=>P.checkOutput(path.join(root,'new'),{platform:'darwin',arch:'x64'}),/arm64 only/);assert.equal(P.checkOutput(path.join(root,'new'),{platform:'darwin',arch:'arm64'}),path.join(root,'new'));assert.throws(()=>P.optionsFrom(['--output','--cache']),/Usage/);assert.deepEqual(P.optionsFrom(['--output','new','--cache','cache']),{output:'new',cache:'cache'});});
test('runtime construction refuses existing output before downloading or deleting',t=>{const root=temp(t);fs.writeFileSync(path.join(root,'retained'),'unchanged');assert.throws(()=>R.buildRuntime({output:root,platform:'darwin',arch:'arm64'}),/already exists/);assert.equal(fs.readFileSync(path.join(root,'retained'),'utf8'),'unchanged');});

function git(root,...args){
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
 Object.assign(env,{GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_NOSYSTEM:'1'});
 const result=require('node:child_process').spawnSync('/usr/bin/git',['-C',root,'-c','user.name=Release Fixture','-c','user.email=release@example.invalid','-c','commit.gpgsign=false',...args],{env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
function sourceFixture(t,{repository=true,untracked}={}){
 const root=temp(t),manifest={schemaVersion:1,web:['index.html'],runtime:['runtime.js','package.json'],optionalRuntime:['native-glass.node','python-runtime-manifest.json']};
 fs.mkdirSync(path.join(root,'app'));
 fs.writeFileSync(path.join(root,'app/asset-manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(root,'app/index.html'),'<!doctype html><title>Synthetic release</title>');fs.writeFileSync(path.join(root,'app/runtime.js'),'module.exports = "fixture";');
 fs.mkdirSync(path.join(root,'scripts'));for(const file of ['LICENSE','scripts/build-electron-app.sh','app/ai-bro-icon.icns','package-lock.json','requirements.txt','scripts/release-macos.js','scripts/release-runtime.js','scripts/release-verify.js','scripts/release-runtime-lock.json'])fs.writeFileSync(path.join(root,file),'synthetic '+file);
 fs.copyFileSync(path.join(root,'LICENSE'),path.join(root,'app/LICENSE'));
 const pkg={name:'ai-bro',productName:'AI Bro',version:'0.6.3',license:'AGPL-3.0-only',private:true,main:'electron-main.js'};
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({...pkg,main:'app/electron-main.js'}));fs.writeFileSync(path.join(root,'app/package.json'),JSON.stringify(pkg));
 fs.writeFileSync(path.join(root,'.gitignore'),'native-glass.node\npython-runtime-manifest.json\n');
 if(repository){git(root,'init','--quiet','--template=');git(root,'add','--','.gitignore',...P.requiredSourceInputs(root).filter(file=>file!==untracked));git(root,'commit','--quiet','-m','Synthetic release inputs');}
 return root;
}
test('clean committed release inputs keep the original commit identity; generated optional files are excluded',t=>{
 const root=sourceFixture(t),before=P.sourceIdentity(root);assert.equal(before.revision,git(root,'rev-parse','HEAD'));assert.equal(before.trackedSourceClean,true);assert.match(before.inputsSha256,/^[a-f0-9]{64}$/);
 fs.writeFileSync(path.join(root,'app/native-glass.node'),'regenerated native fixture');fs.writeFileSync(path.join(root,'app/python-runtime-manifest.json'),'generated marker');fs.writeFileSync(path.join(root,'unrelated-untracked.txt'),'never packaged');
 assert.deepEqual(P.verifySourceIdentity(root,before),before);assert.ok(!P.requiredSourceInputs(root).includes('app/native-glass.node'));
});
test('uncommitted and staged changes refuse release before output or runtime work',async t=>{
 const root=sourceFixture(t),output=path.join(root,'new-output');fs.appendFileSync(path.join(root,'app/runtime.js'),'\nchanged');assert.throws(()=>P.sourceIdentity(root),/uncommitted.*Commit/);
 if(process.platform==='darwin'&&process.arch==='arm64')await assert.rejects(P.buildRelease({root,output}),/uncommitted/);assert.equal(fs.existsSync(output),false);
 git(root,'add','app/runtime.js');assert.throws(()=>P.sourceIdentity(root),/uncommitted/);
});
test('a required runtime, icon, build script, or dependency lock cannot remain outside the commit',t=>{
 for(const untracked of ['app/runtime.js','app/ai-bro-icon.icns','scripts/build-electron-app.sh','package.json','app/package.json','scripts/release-runtime-lock.json','package-lock.json']){
  const root=sourceFixture(t,{untracked});assert.equal(git(root,'status','--porcelain','--untracked-files=no'),'');
  assert.throws(()=>P.sourceIdentity(root),error=>/not tracked.*commit/.test(error.message)&&error.message.includes(untracked));
 }
});
test('post-build verification rejects both a changed commit and newly dirty tracked source',t=>{
 const root=sourceFixture(t),before=P.sourceIdentity(root);git(root,'commit','--quiet','--allow-empty','-m','Later commit with the same files');assert.throws(()=>P.verifySourceIdentity(root,before),/changed during the build/);
 const current=P.sourceIdentity(root);fs.appendFileSync(path.join(root,'app/index.html'),'changed');assert.throws(()=>P.verifySourceIdentity(root,current),/uncommitted/);
});
test('an extracted source archive has an explicit null revision and remains content-checked',t=>{
 const root=sourceFixture(t,{repository:false}),before=P.sourceIdentity(root);assert.equal(before.revision,null);assert.equal(before.trackedSourceClean,null);assert.deepEqual(P.verifySourceIdentity(root,before),before);
 fs.appendFileSync(path.join(root,'scripts/release-runtime-lock.json'),'changed');assert.throws(()=>P.verifySourceIdentity(root,before),/changed during the build/);
});
test('required source links are refused rather than packing files outside the source archive',t=>{
 const root=sourceFixture(t,{repository:false}),file=path.join(root,'app/ai-bro-icon.icns');fs.renameSync(file,path.join(root,'outside-icon'));fs.symlinkSync('../outside-icon',file);assert.throws(()=>P.sourceIdentity(root),/regular file/);
});

test('release refuses mismatched runtime metadata while allowing the repository main entry',t=>{
 const root=sourceFixture(t,{repository:false});assert.equal(P.validateRuntimePackage(root).main,'app/electron-main.js');
 const filename=path.join(root,'app/package.json'),pkg=JSON.parse(fs.readFileSync(filename,'utf8'));
 for(const field of ['name','productName','version','license']){fs.writeFileSync(filename,JSON.stringify({...pkg,[field]:'mismatch'}));assert.throws(()=>P.validateRuntimePackage(root),/differs from the root/);}
 fs.writeFileSync(filename,JSON.stringify({...pkg,main:'app/electron-main.js'}));assert.throws(()=>P.validateRuntimePackage(root),/Invalid Electron/);
});

test('release rejects a missing or divergent packaged license',t=>{
 const root=sourceFixture(t,{repository:false});
 fs.writeFileSync(path.join(root,'app/LICENSE'),'different terms');
 assert.throws(()=>P.validateRuntimePackage(root),/Packaged LICENSE differs/);
 fs.unlinkSync(path.join(root,'app/LICENSE'));
 assert.throws(()=>P.validateRuntimePackage(root),/ENOENT/);
});
