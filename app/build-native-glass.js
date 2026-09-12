#!/usr/bin/env node
// Builds our own small Node-API addon; never downloads or runs dependency code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function headerDirectory(options = {}) {
  const env = options.env || process.env, home = options.home || os.homedir();
  const candidates = [env.NODE_INCLUDE_DIR, path.resolve(path.dirname(process.execPath),'../include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'];
  for (const parent of [path.join(home,'Library/Caches/node-gyp'),path.join(home,'.cache/node-gyp'),path.join(home,'.node-gyp')]) {
    try { for (const version of fs.readdirSync(parent).sort().reverse()) candidates.push(path.join(parent,version,'include/node')); } catch (_) {}
  }
  const selected = candidates.filter(Boolean).find(candidate => ['node_api.h','js_native_api.h','js_native_api_types.h'].every(file => fs.existsSync(path.join(candidate,file))));
  if (!selected) throw Error('Node-API headers are missing. Set NODE_INCLUDE_DIR to the directory containing node_api.h.');
  return selected;
}
function build(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return { supported:false,reason:'platform' };
  const arch = options.arch || process.arch;
  if (!['arm64','x64'].includes(arch)) throw Error('Native glass supports macOS arm64 and x64.');
  const sdkResult = spawnSync('xcrun',['--show-sdk-path'],{encoding:'utf8'});
  if (sdkResult.status !== 0) throw Error('Apple Command Line Tools with macOS SDK 26 or later are required.');
  const sdk = sdkResult.stdout.trim();
  const header = path.join(sdk,'System/Library/Frameworks/AppKit.framework/Headers/NSGlassEffectView.h');
  if (!fs.existsSync(header)) throw Error('NSGlassEffectView requires macOS SDK 26 or later.');
  const destination = path.resolve(options.output || path.join(__dirname,'native-glass.node'));
  const include = headerDirectory(options);
  // Keep the final basename: codesign derives its default identifier from it.
  const buildDirectory=fs.mkdtempSync(path.join(path.dirname(destination),'.native-glass-build-'));
  const temporary = path.join(buildDirectory,path.basename(destination));
  const args = ['clang++','-std=c++17','-fobjc-arc','-fblocks','-dynamiclib','-Wl,-install_name,@rpath/native-glass.node','-undefined','dynamic_lookup','-mmacosx-version-min=11.0','-arch',arch==='x64'?'x86_64':'arm64','-isysroot',sdk,'-I',include,'-DNAPI_VERSION=8','-DNODE_GYP_MODULE_NAME=ai_bro_native_glass','-framework','AppKit','-framework','Foundation',path.join(__dirname,'native-glass.mm'),'-o',temporary];
  try {
    const compiled=spawnSync('xcrun',args,{encoding:'utf8'});
    if (compiled.status !== 0) throw Error(`Native glass compilation failed.\n${compiled.stderr || compiled.error?.message || ''}`);
    // Bundle signing must not change the addon bytes after the shared asset
    // fingerprint is computed. Normalize its ad-hoc signature before copying.
    const signed=spawnSync('codesign',['--force','--sign','-',temporary],{encoding:'utf8'});
    if (signed.status !== 0) throw Error(`Native glass signing failed.\n${signed.stderr || signed.error?.message || ''}`);
    fs.renameSync(temporary,destination);
  } finally { fs.rmSync(buildDirectory,{recursive:true,force:true}); }
  return {supported:true,arch,output:destination};
}
if (require.main === module) {
  const optional = process.argv.includes('--optional');
  try {
    const result=build();
    if (!result.supported) try { fs.unlinkSync(path.join(__dirname,'native-glass.node')); } catch (_) {}
    console.log(result.supported?`Built native glass (${result.arch}).`:'Native glass is optional on this platform.');
  } catch(error) {
    // Never package a stale or wrong-architecture addon after a failed build.
    try { fs.unlinkSync(path.join(__dirname,'native-glass.node')); } catch (_) {}
    console.error(error.message);
    if (optional) console.warn('Using the browser glass fallback. Run npm run native:build to diagnose native setup.');
    else process.exitCode=1;
  }
}
module.exports={headerDirectory,build};
