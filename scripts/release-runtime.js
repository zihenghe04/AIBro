#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const LOCK=require('./release-runtime-lock.json');
const {PYTHON_SERIES}=require('../app/python-runtime');
const MAX_UNPACKED=768*1024*1024;
const sha256=filename=>crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function command(file,args,options={}){
  const result=spawnSync(file,args,{encoding:'utf8',maxBuffer:8*1024*1024,...options});
  if(result.status!==0)throw new Error(`${path.basename(file)} failed: ${result.stderr||result.error?.message||result.status}`);
  return result.stdout;
}
function validateArtifact(item){
  const url=new URL(item.url);
  if(url.protocol!=='https:'||url.username||url.password||!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(item.filename)||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.size)||item.size<=0)throw Error('Invalid pinned release artifact.');
}
function download(item,cache){
  validateArtifact(item);fs.mkdirSync(cache,{recursive:true});const filename=path.join(cache,item.filename);
  if(fs.existsSync(filename)){
    if(!fs.lstatSync(filename).isFile()||fs.statSync(filename).size!==item.size||sha256(filename)!==item.sha256)throw Error(`Cached checksum mismatch: ${item.filename}. Remove that cache file and retry.`);
    return filename;
  }
  const temporary=path.join(cache,'.download-'+crypto.randomUUID());
  try{
    console.log(`Downloading pinned ${item.filename}`);
    command('/usr/bin/curl',['--fail','--location','--retry','3','--connect-timeout','20','--max-time','600','--proto','=https','--proto-redir','=https','--silent','--show-error','--output',temporary,item.url]);
    if(fs.statSync(temporary).size!==item.size||sha256(temporary)!==item.sha256)throw Error(`Downloaded checksum mismatch: ${item.filename}`);
    fs.renameSync(temporary,filename);return filename;
  }finally{fs.rmSync(temporary,{force:true});}
}
function safeRelative(value){
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||value.startsWith('/')||value.split('/').some(part=>part==='..'||part==='.')||/^[A-Za-z]:/.test(value))throw Error('Unsafe archive path.');
  return value.replace(/\/+$/,'');
}
function paxFields(data){
  const result={};let offset=0;
  while(offset<data.length){const space=data.indexOf(32,offset),length=Number(data.subarray(offset,space).toString());if(space<0||!Number.isSafeInteger(length)||length<=space-offset+1||offset+length>data.length)throw Error('Invalid tar metadata.');const record=data.subarray(space+1,offset+length-1).toString(),equals=record.indexOf('=');if(equals>=0)result[record.slice(0,equals)]=record.slice(equals+1);offset+=length;}
  return result;
}
function tarEntries(buffer,visit){
  if(buffer.length>MAX_UNPACKED)throw Error('Runtime archive is too large.');
  let offset=0,pax={},globalPax={},longName='',longLink='',count=0;
  const field=(header,start,length)=>header.subarray(start,start+length).toString().split('\0')[0];
  while(offset+512<=buffer.length){
    const h=buffer.subarray(offset,offset+512);if(h.every(byte=>byte===0))break;
    const expected=parseInt(field(h,148,8).trim(),8);let checksum=0;for(let n=0;n<512;n++)checksum+=n>=148&&n<156?32:h[n];if(checksum!==expected)throw Error('Invalid tar checksum.');
    const size=parseInt(field(h,124,12).trim()||'0',8),type=field(h,156,1)||'0';
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>buffer.length)throw Error('Invalid tar size.');
    const data=buffer.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
    if(type==='x'){pax=paxFields(data);continue;}if(type==='g'){globalPax={...globalPax,...paxFields(data)};continue;}
    if(type==='L'){longName=data.toString().replace(/\0.*$/s,'').trimEnd();continue;}if(type==='K'){longLink=data.toString().replace(/\0.*$/s,'').trimEnd();continue;}
    const metadata={...globalPax,...pax},prefix=field(h,345,155),name=metadata.path||longName||[prefix,field(h,0,100)].filter(Boolean).join('/'),link=metadata.linkpath||longLink||field(h,157,100);
    if(++count>30000)throw Error('Too many runtime archive entries.');
    visit({name:safeRelative(name),link,type,mode:parseInt(field(h,100,8).trim()||'644',8)&0o777,data});pax={};longName='';longLink='';
  }
}
function unpackPython(archive,destination){
  const entries=[];tarEntries(zlib.gunzipSync(fs.readFileSync(archive),{maxOutputLength:MAX_UNPACKED}),entry=>{
    if(entry.name==='python'&&entry.type==='5')return;
    if(!entry.name.startsWith('python/'))throw Error('Unexpected Python archive prefix.');
    entry.name=safeRelative(entry.name.slice(7));
    if(!['0','5','2'].includes(entry.type))throw Error('Unsupported runtime archive entry.');
    if(entry.type==='2'&&(path.isAbsolute(entry.link)||!path.resolve(destination,path.dirname(entry.name),entry.link).startsWith(path.resolve(destination)+path.sep)))throw Error('Runtime link leaves its directory.');
    entries.push(entry);
  });
  const seen=new Set();for(const entry of entries){if(seen.has(entry.name))throw Error('Duplicate runtime path.');seen.add(entry.name);}
  fs.mkdirSync(destination,{recursive:true});
  // Links are created last, so no archive member can write through a symlink.
  for(const entry of entries.filter(e=>e.type!=='2')){
    const target=path.join(destination,entry.name);fs.mkdirSync(path.dirname(target),{recursive:true});
    if(entry.type==='5')fs.mkdirSync(target,{recursive:true});else fs.writeFileSync(target,entry.data,{mode:entry.mode||0o644,flag:'wx'});
  }
  for(const entry of entries.filter(e=>e.type==='2')){const target=path.join(destination,entry.name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.symlinkSync(entry.link,target);}
}
function filesUnder(directory){
  const files=[];function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(folder,item.name);if(item.isDirectory())walk(filename);else if(item.isFile()||item.isSymbolicLink())files.push(filename);else throw Error('Unexpected runtime file type.');}}walk(directory);return files;
}
function isMachO(filename){
  if(!fs.lstatSync(filename).isFile())return false;
  const descriptor=fs.openSync(filename,'r'),bytes=Buffer.alloc(4);try{if(fs.readSync(descriptor,bytes,0,4,0)!==4)return false;}finally{fs.closeSync(descriptor);}
  return ['feedfacf','cffaedfe','feedface','cefaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(bytes.toString('hex'));
}
function signRuntime(directory){
  let signed=0;
  for(const filename of filesUnder(directory).filter(isMachO)){
    const libraries=command('/usr/bin/otool',['-L',filename]);
    const installId=command('/usr/bin/otool',['-D',filename]).split('\n')[1]?.trim();
    if(libraries.split('\n').slice(1).some(line=>line.trim().split(' (')[0]!==installId&&/^\s+\/(?:Users|opt|usr\/local|private)\//.test(line)))throw Error(`Runtime contains a non-portable library dependency in ${path.basename(filename)}.`);
    command('/usr/bin/codesign',['--force','--sign','-',filename]);signed++;
  }
  if(!signed)throw Error('No native Python executable was found.');return signed;
}
function treeHash(directory){
  const hash=crypto.createHash('sha256');
  for(const filename of filesUnder(directory)){const relative=path.relative(directory,filename).split(path.sep).join('/');if(relative==='runtime.json')continue;hash.update(relative+'\0');hash.update(fs.lstatSync(filename).isSymbolicLink()?'link:'+fs.readlinkSync(filename):fs.readFileSync(filename));hash.update('\0');}
  return hash.digest('hex');
}
function cleanPythonEnv(directory,env=process.env){
  const result={...env,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',SSL_CERT_FILE:path.join(directory,'lib','python'+PYTHON_SERIES,'site-packages','certifi','cacert.pem')};
  for(const key of ['PYTHONHOME','PYTHONPATH','PYTHONSTARTUP','PYTHONUSERBASE','PYTHONEXECUTABLE','__PYVENV_LAUNCHER__'])delete result[key];return result;
}
function verifyRuntime(directory){
  const python=path.join(directory,'bin','python'+PYTHON_SERIES),env=cleanPythonEnv(directory);
  const program='import sys,json,sqlite3,hashlib,ssl,fitz,certifi\nassert sys.version_info[:2]==(3,12)\nassert hasattr(hashlib,"scrypt")\nassert fitz.VersionBind=="'+LOCK.wheels[0].version+'"\nassert ssl.create_default_context().get_ca_certs()\ndoc=fitz.open();page=doc.new_page();page.insert_text((40,40),"Bundled runtime PDF")\nraw=doc.tobytes();source=fitz.open(stream=raw,filetype="pdf");assert "Bundled runtime PDF" in source[0].get_text()\npix=source[0].get_pixmap();assert pix.tobytes("png").startswith(b"\\x89PNG");assert pix.tobytes("jpeg").startswith(b"\\xff\\xd8")\nprint(json.dumps({"python":sys.version.split()[0],"pymupdf":fitz.VersionBind,"sqlite":sqlite3.sqlite_version,"openssl":ssl.OPENSSL_VERSION,"pdf":True,"caCertificates":len(ssl.create_default_context().get_ca_certs())}))';
  return JSON.parse(command(python,['-s','-B','-c',program],{env}));
}
function copyPythonLicenses(archive,destination){
  if(typeof zlib.zstdDecompressSync!=='function')throw Error('Release builds require Node.js 22.15 or newer for pinned Python license extraction.');
  let metadata,count=0;const licenses=path.join(destination,'licenses','python-build-standalone');fs.mkdirSync(licenses,{recursive:true});
  tarEntries(zlib.zstdDecompressSync(fs.readFileSync(archive),{maxOutputLength:MAX_UNPACKED}),entry=>{
    if(entry.name==='python/PYTHON.json'){metadata=JSON.parse(entry.data.toString());fs.writeFileSync(path.join(licenses,'PYTHON.json'),entry.data);}
    if(entry.type==='0'&&/^python\/licenses\//.test(entry.name)){const target=path.join(licenses,entry.name.slice('python/licenses/'.length));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.data);count++;}
  });
  if(!metadata||metadata.python_version!==LOCK.python.version||!count)throw Error('Pinned Python dependency licenses are missing.');return {count,minimumMacOS:metadata.apple_sdk_deployment_target};
}
function notices(){
  return ['AI Bro bundled runtime — third-party notices','',`CPython ${LOCK.python.version}: Python Software Foundation license.`,`${LOCK.python.upstream}`, 'Python and linked dependency license texts: python/lib/python3.12/LICENSE.txt and python/licenses/python-build-standalone/.','',...LOCK.wheels.map(w=>`${w.name} ${w.version}: ${w.license}. Upstream archive: ${w.url}\nSHA256: ${w.sha256}`),'','PyMuPDF and MuPDF are dual-licensed under the GNU AGPL v3 or a commercial Artifex agreement. Retaining these notices alone does not replace corresponding-source obligations. Distributors must supply the applicable corresponding source or hold appropriate commercial rights. This build does not change the AI Bro source license.','PyMuPDF license text is preserved in its installed .dist-info/COPYING; certifi includes its MPL-2.0 license.','Corresponding PyMuPDF/MuPDF source archives are listed with exact hashes in release-runtime-lock.json.',''].join('\n');
}
function buildRuntime({output,cache=path.join(os.tmpdir(),'ai-bro-release-cache'),platform=process.platform,arch=process.arch}={}){
  if(platform!=='darwin'||arch!=='arm64')throw Error('This release runtime targets macOS arm64 only.');
  if(!output)throw Error('--output is required.');output=path.resolve(output);cache=path.resolve(cache);
  if(fs.existsSync(output))throw Error('Runtime output already exists; choose a new directory.');
  fs.mkdirSync(path.dirname(output),{recursive:true});const stage=fs.mkdtempSync(path.join(path.dirname(output),'.python-runtime-'));
  try{
    const pythonArchive=download(LOCK.python,cache);unpackPython(pythonArchive,path.join(stage,'python'));
    const directory=path.join(stage,'python'),wheels=LOCK.wheels.map(w=>download(w,cache));
    const install='import pathlib,sys,zipfile,stat\nroot=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)\nfor filename in sys.argv[2:]:\n with zipfile.ZipFile(filename) as z:\n  for item in z.infolist():\n   p=pathlib.PurePosixPath(item.filename)\n   if p.is_absolute() or ".." in p.parts or "\\\\" in item.filename or stat.S_ISLNK(item.external_attr>>16):raise ValueError("Unsafe wheel entry")\n   target=root.joinpath(*p.parts)\n   if item.is_dir():target.mkdir(parents=True,exist_ok=True)\n   else:\n    target.parent.mkdir(parents=True,exist_ok=True)\n    if target.exists():raise ValueError("Duplicate wheel path")\n    target.write_bytes(z.read(item))\n';
    command(path.join(directory,'bin','python'+PYTHON_SERIES),['-s','-B','-c',install,path.join(directory,'lib','python'+PYTHON_SERIES,'site-packages'),...wheels],{env:cleanPythonEnv(directory)});
    const licenseInfo=copyPythonLicenses(download(LOCK.pythonLicenses,cache),directory);
    fs.writeFileSync(path.join(directory,'THIRD-PARTY-NOTICES.txt'),notices());
    const signedFiles=signRuntime(directory),probe=verifyRuntime(directory);
    const manifest={schemaVersion:1,platform:'darwin',arch:'arm64',pythonSeries:PYTHON_SERIES,python:LOCK.python,wheels:LOCK.wheels,sources:LOCK.sources,pythonLicenses:LOCK.pythonLicenses,minimumMacOS:licenseInfo.minimumMacOS,licenseFiles:licenseInfo.count,signedFiles,signature:'ad-hoc-preview',treeSha256:treeHash(directory),probe};
    fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify(manifest,null,2)+'\n');fs.renameSync(directory,output);return manifest;
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
function optionsFrom(argv){const result={};for(let i=0;i<argv.length;i+=2){if(!['--output','--cache','--verify'].includes(argv[i])||!argv[i+1])throw Error('Usage: node scripts/release-runtime.js --output NEW_DIRECTORY [--cache CACHE_DIRECTORY], or --verify RUNTIME_DIRECTORY');result[argv[i].slice(2)]=argv[i+1];}return result;}
if(require.main===module){try{const opts=optionsFrom(process.argv.slice(2));console.log(JSON.stringify(opts.verify?verifyRuntime(path.resolve(opts.verify)):buildRuntime(opts),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={LOCK,sha256,command,download,validateArtifact,safeRelative,tarEntries,unpackPython,filesUnder,isMachO,signRuntime,treeHash,cleanPythonEnv,verifyRuntime,notices,buildRuntime,optionsFrom};
