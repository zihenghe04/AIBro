'use strict';
// 原生外观「跟随系统」：网页每次刷新偏好都会回报主题，回声不能把「跟随系统」改成固定浅色/深色。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const main=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/AIBro.swift'),'utf8');
const desktop=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/NativeDesktop.swift'),'utf8');

test('web theme echoes never overwrite the native 跟随系统 choice',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const policy=main.match(/struct NativeAppearancePolicy \{[^]*?\n\}/)?.[0];
 assert.ok(policy,'the production policy is compiled, not a JavaScript copy');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-appearance-'));
 try {
  const script=path.join(directory,'main.swift'),binary=path.join(directory,'policy');
  fs.writeFileSync(script,`import Foundation\n${policy}\nvar rows:[String]=[]\nfor saved in ["system","light","dark"] { for requested in ["light","dark","system"] { for dark in [false,true] { for synced in [false,true] {\n rows.append("\\(saved) \\(requested) \\(dark) \\(synced) \\(NativeAppearancePolicy.acceptsWebRequest(saved:saved,requested:requested,systemDark:dark,synced:synced))")\n}}}}\nprint(rows.joined(separator:"\\n"))\n`);
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5',script,'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const accepted=new Set(result.stdout.trim().split('\n').filter(row=>row.endsWith(' true')).map(row=>row.replace(/ true$/,'')));
  // Before the first native→web sync, the page's stored default must not win.
  for (const row of accepted) assert.ok(row.endsWith(' true'),`unsynced request accepted: ${row}`);
  assert.deepEqual([...accepted].sort(),[
   'dark light false true','dark light true true',
   'light dark false true','light dark true true',
   'system dark false true','system light true true'
  ].sort(),'only a visible change after sync is a user choice; echoes of the current look are ignored');
 } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test('the bridge routes page theme reports through the echo policy and follows system changes',()=>{
 assert.match(desktop,/command=="appearance",let value=body\["value"\] as\? String \{workspace\?\.webRequestedAppearance\(value\)\}/);
 assert.match(main,/setAppearance\(appearance,force:true\);appearanceSynced=true/);
 assert.match(main,/observe\(\\\.effectiveAppearance[^]*?appearance == "system"[^]*?command\("theme"/);
});

test('an isolated data directory never writes the shared appearance key; startup reads per-directory, then shared, then system',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const policy=main.match(/struct NativeAppearancePolicy \{[^]*?\n\}/)?.[0];
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-appearance-keys-'));
 try {
  const script=path.join(directory,'main.swift'),binary=path.join(directory,'policy');
  fs.writeFileSync(script,`import Foundation\n${policy}\nlet d="/Users/x/Library/Application Support/ai-workstation"\nprint(NativeAppearancePolicy.writesGlobal(dataPath:d,defaultPath:d))\nprint(NativeAppearancePolicy.writesGlobal(dataPath:"/tmp/aibro-try2",defaultPath:d))\nprint(NativeAppearancePolicy.resolved(perDirectory:"dark",global:"light"))\nprint(NativeAppearancePolicy.resolved(perDirectory:nil,global:"light"))\nprint(NativeAppearancePolicy.resolved(perDirectory:"bogus",global:"dark"))\nprint(NativeAppearancePolicy.resolved(perDirectory:nil,global:nil))\nprint(NativeAppearancePolicy.resolved(perDirectory:nil,global:"bogus"))\n`);
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5',script,'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});
  assert.deepEqual(result.stdout.trim().split('\n'),['true','false','dark','light','dark','system','system']);
 } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
