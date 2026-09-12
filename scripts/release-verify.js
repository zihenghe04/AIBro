#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {selectPythonRuntime}=require('../app/python-runtime');
const {fingerprint}=require('../app/app-assets');
const {command,verifyRuntime,treeHash}=require('./release-runtime');

function get(origin,route){return new Promise((resolve,reject)=>{
  const request=http.get(origin+route,response=>{const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){request.destroy(Error('Release probe response too large.'));return;}chunks.push(chunk);});response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));response.on('error',reject);});
  request.setTimeout(10000,()=>request.destroy(Error('Release HTTP probe timed out.')));request.on('error',reject);
});}
async function stop(child){if(child.exitCode!==null||child.signalCode)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(timer);}}
async function verifyPackagedApp(appPath){
  const resources=path.join(path.resolve(appPath),'Contents','Resources'),assets=path.join(resources,'app'),runtime=path.join(resources,'python');
  const marker=JSON.parse(fs.readFileSync(path.join(assets,'python-runtime-manifest.json'),'utf8'));
  if(marker.treeSha256!==treeHash(runtime))throw Error('Bundled runtime integrity mismatch.');
  const metadata=JSON.parse(fs.readFileSync(path.join(runtime,'runtime.json'),'utf8'));
  if(JSON.stringify(marker)!==JSON.stringify(metadata))throw Error('Runtime identity marker mismatch.');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ai-bro-release-probe-'));let child;
  try{
    const emptyPath=path.join(temporary,'empty-path');fs.mkdirSync(emptyPath);
    const env={...process.env,PATH:emptyPath,HOME:temporary,TMPDIR:temporary};
    for(const key of Object.keys(env))if(key.startsWith('AI_WORKSTATION_')||key.startsWith('CODEX_'))delete env[key];
    const python=selectPythonRuntime({resourcesPath:resources,assetDir:assets,env});
    if(!python.bundled)throw Error('Release did not select its bundled Python.');
    const data=path.join(temporary,'data'),files=path.join(data,'files');fs.mkdirSync(files,{recursive:true});
    const raw=path.join(files,'release-qa');
    command(python.command,[...python.args,'-c','import fitz,sys\ndoc=fitz.open()\nfor i in range(2):\n page=doc.new_page();page.insert_text((40,40),"Release fixture page %s"%(i+1))\ndoc.save(sys.argv[1])',raw],{env:python.env});
    fs.writeFileSync(raw+'.meta.json',JSON.stringify({name:'release-fixture.pdf',mimeType:'application/pdf',size:fs.statSync(raw).size}));
    child=spawn(python.command,[...python.args,path.join(assets,'server.py')],{cwd:assets,env:{...python.env,AI_WORKSTATION_DATA_DIR:data,AI_WORKSTATION_PORT:'0',AI_WORKSTATION_ASSET_DIR:assets},stdio:['ignore','pipe','pipe']});
    const origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>finish(Error('Bundled server did not become ready.')),15000);const finish=(error,value)=>{clearTimeout(timer);child.stdout.off('data',receive);error?reject(error):resolve(value);};const receive=chunk=>{output+=chunk.toString();const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)finish(null,match[0]);if(output.length>65536)finish(Error('Unexpected bundled server startup output.'));};child.stdout.on('data',receive);child.once('error',error=>finish(error));child.once('exit',code=>finish(Error('Bundled server exited before readiness: '+code)));child.stderr.on('data',()=>{});});
    const health=await get(origin,'/__health');if(health.status!==200||JSON.parse(health.body).assetFingerprint!==fingerprint(assets))throw Error('Packaged JS/Python asset fingerprints differ.');
    const info=await get(origin,'/__files/release-qa/preview-info');if(info.status!==200||JSON.parse(info.body).pageCount!==2)throw Error('Bundled PDF page inspection failed.');
    for(const [format,signature] of [['png',Buffer.from([137,80,78,71])],['jpeg',Buffer.from([255,216])]]){const image=await get(origin,'/__files/release-qa/preview?page=2&scale=0.5&format='+format);if(image.status!==200||image.headers['content-type']!=='image/'+format||!image.body.subarray(0,signature.length).equals(signature))throw Error('Bundled PDF '+format+' rendering failed.');}
    const original=await get(origin,'/__files/release-qa');if(original.status!==200||!original.body.equals(fs.readFileSync(raw)))throw Error('Bundled original-file route changed bytes.');
    for(const route of ['/python-runtime.js','/python-runtime-manifest.json','/../python/runtime.json','/python/bin/python3.12'])if((await get(origin,route)).status!==404)throw Error('Private runtime became HTTP-accessible.');
    return {bundledPython:true,systemPythonOnPath:false,pdfPages:2,pdfFormats:['png','jpeg'],originalBytesPreserved:true,privateRuntimeNotServed:true,assetFingerprint:fingerprint(assets),runtime:verifyRuntime(runtime)};
  }finally{if(child)await stop(child);fs.rmSync(temporary,{recursive:true,force:true});}
}
if(require.main===module){if(!process.argv[2]){console.error('Usage: node scripts/release-verify.js /path/to/AI Bro.app');process.exitCode=1;}else verifyPackagedApp(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={verifyPackagedApp,get};
