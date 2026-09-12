'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PYTHON_SERIES = '3.12';

function selectPythonRuntime({resourcesPath, assetDir, env=process.env, platform=process.platform, arch=process.arch, fsApi=fs} = {}) {
  const next = {...env, PYTHONUNBUFFERED:'1'};
  if (typeof env.AI_WORKSTATION_PYTHON === 'string' && env.AI_WORKSTATION_PYTHON.trim()) {
    return {command:env.AI_WORKSTATION_PYTHON.trim(), args:[], env:next, bundled:false};
  }
  const roots=[resourcesPath].filter(Boolean).map(directory=>path.join(directory,'python'));
  const directory=roots.find(candidate=>fsApi.existsSync(candidate));
  if (!directory) {
    if (assetDir&&fsApi.existsSync(path.join(assetDir,'python-runtime-manifest.json'))) throw new Error('内置 Python 运行环境缺失，请重新安装 AI Bro。');
    return {command:'python3',args:[],env:next,bundled:false};
  }
  const fail=()=>{throw new Error('内置 Python 运行环境不完整或不兼容，请重新安装对应平台的 AI Bro。');};
  let metadata;
  try { metadata=JSON.parse(fsApi.readFileSync(path.join(directory,'runtime.json'),'utf8')); } catch (_) { return fail(); }
  if (platform!=='darwin'||arch!=='arm64'||metadata.schemaVersion!==1||metadata.platform!=='darwin'||metadata.arch!=='arm64'||metadata.pythonSeries!==PYTHON_SERIES) return fail();
  const executable=path.join(directory,'bin','python'+PYTHON_SERIES);
  const certificates=path.join(directory,'lib','python'+PYTHON_SERIES,'site-packages','certifi','cacert.pem');
  try {
    const realRoot=fsApi.realpathSync(directory);
    for(const filename of [executable,certificates]) {
      if(!fsApi.statSync(filename).isFile()||!fsApi.realpathSync(filename).startsWith(realRoot+path.sep)) return fail();
    }
    fsApi.accessSync(executable,fs.constants.X_OK);
  } catch (_) { return fail(); }
  // A downloaded App must not load unrelated developer packages or write pyc
  // files into its signed bundle. Explicit TLS trust overrides remain usable.
  for(const key of ['PYTHONHOME','PYTHONPATH','PYTHONSTARTUP','PYTHONUSERBASE','PYTHONEXECUTABLE','__PYVENV_LAUNCHER__'])delete next[key];
  Object.assign(next,{PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',SSL_CERT_FILE:next.SSL_CERT_FILE||certificates});
  return {command:executable,args:['-s','-B'],env:next,bundled:true};
}
module.exports={selectPythonRuntime,PYTHON_SERIES};
