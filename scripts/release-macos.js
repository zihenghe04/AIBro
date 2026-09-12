#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {copyAssets,fingerprint,validateAssets}=require('../app/app-assets');
const {LOCK,buildRuntime,download,command,sha256,treeHash,notices}=require('./release-runtime');
const {verifyPackagedApp}=require('./release-verify');
const {buildDmg}=require('./release-dmg');
const ROOT=path.resolve(__dirname,'..');
function requiredSourceInputs(root) {
  const manifest=validateAssets(path.join(root,'app')),generated=new Set(['native-glass.node','python-runtime-manifest.json']);
  const assets=manifest.files.filter(file=>!(manifest.optionalRuntime||[]).includes(file)||!generated.has(file)).map(file=>'app/'+file);
  return [...new Set([...assets,'scripts/build-electron-app.sh','app/ai-bro-icon.icns','app/package.json','LICENSE','package.json','package-lock.json','requirements.txt',
    'scripts/release-macos.js','scripts/release-dmg.js','scripts/release-runtime.js','scripts/release-verify.js','scripts/release-runtime-lock.json'])].sort();
}
function validateRuntimePackage(root) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'app/package.json'),'utf8'));
  for(const field of ['name','productName','version','license'])if(runtime[field]!==pkg[field])throw Error(`Runtime package ${field} differs from the root package.json. Update both before building.`);
  if(runtime.main!=='electron-main.js'||runtime.private!==true)throw Error('Invalid Electron runtime package metadata.');
  if(pkg.license!=='AGPL-3.0-only')throw Error('Release license must be AGPL-3.0-only.');
  if(fs.readFileSync(path.join(root,'LICENSE'),'utf8')!==fs.readFileSync(path.join(root,'app/LICENSE'),'utf8'))throw Error('Packaged LICENSE differs from the source LICENSE.');
  return pkg;
}
function hasGitCheckout(root) {
  for(let directory=root;;directory=path.dirname(directory)) {
    if(fs.existsSync(path.join(directory,'.git')))return true;
    if(path.dirname(directory)===directory)return false;
  }
}
function sourceGit(root,args) {
  // Do not allow an inherited GIT_DIR/work-tree override to identify a
  // different checkout, or run a configured filesystem-monitor helper.
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  Object.assign(env,{GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'});
  return command('/usr/bin/git',['-c','core.fsmonitor=false','-C',root,...args],{env});
}
function sourceIdentity(root) {
  root=path.resolve(root);const inputs=requiredSourceInputs(root),digest=crypto.createHash('sha256');
  for(const file of inputs) {
    const filename=path.join(root,file);
    if(!fs.existsSync(filename)||!fs.lstatSync(filename).isFile())throw Error(`Required release source must be a regular file: ${file}`);
    digest.update(file+'\0');digest.update(fs.readFileSync(filename));digest.update('\0');
  }
  const inputsSha256=digest.digest('hex');
  if(!hasGitCheckout(root))return {revision:null,trackedSourceClean:null,inputsSha256};
  const revision=sourceGit(root,['rev-parse','--verify','HEAD']).trim();
  const changes=sourceGit(root,['status','--porcelain','--untracked-files=no']).trim();
  if(changes)throw Error('Release source has uncommitted tracked changes. Commit the release source before building.');
  const tracked=new Set(sourceGit(root,['ls-files','--cached','-z','--',...inputs]).split('\0').filter(Boolean));
  const missing=inputs.filter(file=>!tracked.has(file));
  if(missing.length)throw Error('Required release sources are not tracked. Add and commit before building: '+missing.join(', '));
  return {revision,trackedSourceClean:true,inputsSha256};
}
function verifySourceIdentity(root,before) {
  const after=sourceIdentity(root);
  if(after.revision!==before.revision||after.trackedSourceClean!==before.trackedSourceClean||after.inputsSha256!==before.inputsSha256)throw Error('Release source changed during the build. Commit and freeze the source, then build again.');
  return before;
}
function checkOutput(output,{platform=process.platform,arch=process.arch}={}){
  if(platform!=='darwin'||arch!=='arm64')throw Error('Release packaging currently supports macOS arm64 only.');
  if(!output)throw Error('--output is required and must name a new directory.');
  const target=path.resolve(output);if(fs.existsSync(target))throw Error('Release output already exists; no files were replaced.');return target;
}
function electronRuntime(root){
  const source=path.resolve(process.env.ELECTRON_APP||path.join(root,'node_modules/electron/dist/Electron.app'));
  const expected=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).devDependencies.electron;
  if(!/^\d+\.\d+\.\d+$/.test(expected))throw Error('Electron must have an exact pinned release version.');
  const plist=path.join(source,'Contents/Info.plist');
  if(command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',plist]).trim()!==expected)throw Error('Installed Electron differs from the pinned package version. Run npm ci first.');
  const arches=command('/usr/bin/lipo',['-archs',path.join(source,'Contents/MacOS/Electron')]).trim();if(arches!=='arm64')throw Error('Release Electron must be arm64, not an Intel or universal build.');
  return {source,version:expected,minimumMacOS:command('/usr/libexec/PlistBuddy',['-c','Print :LSMinimumSystemVersion',plist]).trim()};
}
async function buildRelease({output,cache=path.join(os.tmpdir(),'ai-bro-release-cache'),root=ROOT}={}){
  output=checkOutput(output);cache=path.resolve(cache);root=path.resolve(root);const sourceBefore=sourceIdentity(root),electron=electronRuntime(root),pkg=validateRuntimePackage(root);
  fs.mkdirSync(path.dirname(output),{recursive:true});const stage=fs.mkdtempSync(path.join(path.dirname(output),'.ai-bro-release-'));
  try{
    const source=path.join(stage,'source'),product=path.join(stage,'product');fs.mkdirSync(product);
    copyAssets(source,path.join(root,'app'));
    fs.copyFileSync(path.join(root,'scripts/build-electron-app.sh'),path.join(source,'build-electron-app.sh'));
    fs.copyFileSync(path.join(root,'app/ai-bro-icon.icns'),path.join(source,'ai-bro-icon.icns'));
    // Build only our isolated source copy; the developer's native addon and
    // running application bundle must never be replaced by a release command.
    const app=path.join(product,'AI Bro.app');
    console.log(command('/bin/sh',[path.join(source,'build-electron-app.sh')],{env:{...process.env,ELECTRON_APP:electron.source,AI_WORKSTATION_OUT_APP:app}}).trim());
    const resources=path.join(app,'Contents/Resources'),assets=path.join(resources,'app');
    const runtime=buildRuntime({output:path.join(resources,'python'),cache});
    fs.writeFileSync(path.join(assets,'python-runtime-manifest.json'),JSON.stringify(runtime,null,2)+'\n');
    fs.copyFileSync(path.join(__dirname,'release-runtime-lock.json'),path.join(resources,'release-runtime-lock.json'));
    fs.writeFileSync(path.join(resources,'THIRD-PARTY-NOTICES.txt'),notices());
    const assetHash=fingerprint(assets);command('/usr/bin/codesign',['--force','--deep','--sign','-',app]);command('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    if(assetHash!==fingerprint(assets)||runtime.treeSha256!==treeHash(path.join(resources,'python')))throw Error('Final signing changed an already fingerprinted runtime.');
    const verification=await verifyPackagedApp(app);
    const dependencies=path.join(product,'dependency-sources');fs.mkdirSync(dependencies);for(const artifact of LOCK.sources)fs.copyFileSync(download(artifact,cache),path.join(dependencies,artifact.filename));
    fs.copyFileSync(path.join(root,'LICENSE'),path.join(product,'LICENSE'));
    fs.writeFileSync(path.join(product,'THIRD-PARTY-NOTICES.txt'),notices());fs.copyFileSync(path.join(__dirname,'release-runtime-lock.json'),path.join(product,'release-runtime-lock.json'));
    const manifest={schemaVersion:1,product:'AI Bro',version:pkg.version,platform:'darwin',arch:'arm64',minimumMacOS:electron.minimumMacOS,electron:electron.version,signature:'ad-hoc-preview',notarized:false,source:sourceBefore,assetFingerprint:assetHash,nativeGlass:fs.existsSync(path.join(assets,'native-glass.node')),runtime,verification};
    fs.writeFileSync(path.join(product,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const zipName=`AI-Bro-${pkg.version}-macos-arm64-preview.zip`;command('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(product,zipName)]);
    const dmgName=`AI-Bro-${pkg.version}-macos-arm64-preview.dmg`;buildDmg({app,output:path.join(product,dmgName)});
    const published=[zipName,dmgName,'LICENSE','release-manifest.json','release-runtime-lock.json','THIRD-PARTY-NOTICES.txt',...LOCK.sources.map(item=>'dependency-sources/'+item.filename)];
    fs.writeFileSync(path.join(product,'SHA256SUMS.txt'),published.map(file=>`${sha256(path.join(product,file))}  ${file}`).join('\n')+'\n');
    verifySourceIdentity(root,sourceBefore);
    fs.renameSync(product,output);return {output,archive:path.join(output,zipName),manifest};
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
function optionsFrom(argv){const result={};for(let i=0;i<argv.length;i+=2){if(!['--output','--cache'].includes(argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Usage: node scripts/release-macos.js --output NEW_DIRECTORY [--cache CACHE_DIRECTORY]');result[argv[i].slice(2)]=argv[i+1];}return result;}
if(require.main===module)buildRelease(optionsFrom(process.argv.slice(2))).then(result=>console.log(JSON.stringify({output:result.output,archive:result.archive,version:result.manifest.version,signature:result.manifest.signature},null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={validateRuntimePackage,checkOutput,electronRuntime,buildRelease,optionsFrom,requiredSourceInputs,sourceIdentity,verifySourceIdentity};
