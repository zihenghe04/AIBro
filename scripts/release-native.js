#!/usr/bin/env node
'use strict';
// Native release: a clean, frozen source checkout + checksum-pinned Python.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {LOCK,command,buildRuntime,download,sha256,treeHash,notices}=require('./release-runtime');
const {verifyPackagedApp}=require('./release-verify');
const {buildDmg}=require('./release-dmg');
const {checkOutput,optionsFrom,validateRuntimePackage}=require('./release-macos');
const {fingerprint}=require('../app/app-assets');
function sourceIdentity(root){
  const git=args=>command('/usr/bin/git',['-c','core.fsmonitor=false','-C',root,...args]);
  if(git(['status','--porcelain','--untracked-files=no']).trim())throw Error('Commit tracked changes before building a release.');
  const files=git(['ls-files','-z']).split('\0').filter(Boolean).sort();
  for(const required of ['native/Sources/AIBro/AIBro.swift','scripts/build-native-app.sh','scripts/release-native.js'])if(!files.includes(required))throw Error('Missing tracked native source: '+required);
  const hash=crypto.createHash('sha256');
  for(const file of files){hash.update(file+'\0');hash.update(fs.readFileSync(path.join(root,file)));hash.update('\0');}
  return {revision:git(['rev-parse','HEAD']).trim(),trackedSourceClean:true,inputsSha256:hash.digest('hex')};
}
async function buildNativeRelease({output,cache=path.join(os.tmpdir(),'ai-bro-release-cache'),root=path.resolve(__dirname,'..')}={}){
  output=checkOutput(output);root=path.resolve(root);const source=sourceIdentity(root),pkg=validateRuntimePackage(root);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const stage=fs.mkdtempSync(path.join(path.dirname(output),'.aibro-native-release-'));
  try{
    const runtime=buildRuntime({output:path.join(stage,'python'),cache});
    const product=path.join(stage,'product'),app=path.join(product,'AI Bro.app');fs.mkdirSync(product);
    command('/bin/sh',[path.join(root,'scripts/build-native-app.sh')],{env:{...process.env,AIBRO_NATIVE_OUT:app,AIBRO_PYTHON_SOURCE:path.join(stage,'python')}});
    const resources=path.join(app,'Contents/Resources'),assets=path.join(resources,'app');
    fs.writeFileSync(path.join(assets,'python-runtime-manifest.json'),JSON.stringify(runtime,null,2)+'\n');
    fs.copyFileSync(path.join(root,'scripts/release-runtime-lock.json'),path.join(resources,'release-runtime-lock.json'));
    fs.writeFileSync(path.join(resources,'THIRD-PARTY-NOTICES.txt'),notices());
    const binary=path.join(app,'Contents/MacOS/AIBroNative');
    if(command('/usr/bin/lipo',['-archs',binary]).trim()!=='arm64')throw Error('Native release must be arm64.');
    const plist=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));
    if(plist.CFBundleShortVersionString!==pkg.version||plist.LSMinimumSystemVersion!=='14.0'||plist.CFBundleExecutable!=='AIBroNative')throw Error('Native bundle metadata mismatch.');
    command('/usr/bin/codesign',['--force','--deep','--sign','-',app]);command('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    if(runtime.treeSha256!==treeHash(path.join(resources,'python')))throw Error('Bundled runtime changed after signing.');
    const verification=await verifyPackagedApp(app);
    const dependencies=path.join(product,'dependency-sources');fs.mkdirSync(dependencies);
    for(const item of LOCK.sources)fs.copyFileSync(download(item,cache),path.join(dependencies,item.filename));
    fs.copyFileSync(path.join(root,'LICENSE'),path.join(product,'LICENSE'));
    fs.writeFileSync(path.join(product,'THIRD-PARTY-NOTICES.txt'),notices());
    fs.copyFileSync(path.join(root,'scripts/release-runtime-lock.json'),path.join(product,'release-runtime-lock.json'));
    const manifest={schemaVersion:2,product:'AI Bro',version:pkg.version,platform:'darwin',arch:'arm64',shell:'SwiftUI + AppKit + WKWebView',minimumMacOS:'14.0',nativeGlassMinimumMacOS:'26.0',signature:'ad-hoc-preview',notarized:false,source,assetFingerprint:fingerprint(assets),appTreeSha256:treeHash(app),runtime,verification};
    fs.writeFileSync(path.join(product,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const zip=`AI-Bro-${pkg.version}-macos-arm64-preview.zip`,dmg=`AI-Bro-${pkg.version}-macos-arm64-preview.dmg`;
    command('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(product,zip)]);
    buildDmg({app,output:path.join(product,dmg),minimumMacOS:'14'});
    if(JSON.stringify(sourceIdentity(root))!==JSON.stringify(source))throw Error('Source changed during release build.');
    const published=[zip,dmg,'LICENSE','release-manifest.json','release-runtime-lock.json','THIRD-PARTY-NOTICES.txt',...LOCK.sources.map(s=>'dependency-sources/'+s.filename)];
    fs.writeFileSync(path.join(product,'SHA256SUMS.txt'),published.map(f=>`${sha256(path.join(product,f))}  ${f}`).join('\n')+'\n');
    fs.renameSync(product,output);return {output,version:pkg.version,manifest};
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
if(require.main===module)buildNativeRelease(optionsFrom(process.argv.slice(2))).then(r=>console.log(JSON.stringify({output:r.output,version:r.version},null,2))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={sourceIdentity,buildNativeRelease};
