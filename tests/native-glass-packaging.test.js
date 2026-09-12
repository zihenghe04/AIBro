'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {copyAssets, fingerprint, readManifest} = require('../app/app-assets');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bro-native-assets-'));
  t.after(() => fs.rmSync(temporary, {recursive:true,force:true}));
  const source=path.join(temporary,'source'), output=path.join(temporary,'output');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'asset-manifest.json'),JSON.stringify({schemaVersion:1,web:['index.html'],runtime:['main.js'],optionalRuntime:['native-glass.node']}));
  fs.writeFileSync(path.join(source,'index.html'),'<main>Fixture</main>');
  fs.writeFileSync(path.join(source,'main.js'),'// synthetic runtime');
  return {source,output};
}

test('optional addon bytes participate in the same source and packaged identity', t => {
  const {source,output}=fixture(t);
  fs.writeFileSync(path.join(source,'native-glass.node'),Buffer.from('synthetic native bytes; never loaded'));
  assert.equal(copyAssets(output,source),4);
  assert.equal(fingerprint(output),fingerprint(source));
  const previous=fingerprint(source);
  fs.appendFileSync(path.join(source,'native-glass.node'),'new build');
  assert.notEqual(fingerprint(source),previous);
  assert.equal(fingerprint(output),previous);
  copyAssets(output,source);
  assert.equal(fingerprint(output),fingerprint(source));
});

test('missing optional addon clears only its stale packaged copy and preserves unrelated files', t => {
  const {source,output}=fixture(t);
  fs.writeFileSync(path.join(source,'native-glass.node'),'synthetic old native build');
  copyAssets(output,source);
  fs.writeFileSync(path.join(output,'unrelated.txt'),'keep me');
  fs.writeFileSync(path.join(output,'unlisted-addon.node'),'keep me too');
  fs.unlinkSync(path.join(source,'native-glass.node'));
  assert.equal(copyAssets(output,source),3);
  assert.equal(fs.existsSync(path.join(output,'native-glass.node')),false);
  assert.equal(fs.readFileSync(path.join(output,'unrelated.txt'),'utf8'),'keep me');
  assert.equal(fs.readFileSync(path.join(output,'unlisted-addon.node'),'utf8'),'keep me too');
  assert.equal(fingerprint(output),fingerprint(source));
  assert.equal(readManifest(output).files.includes('native-glass.node'),false);
});

test('a fallback build works in a clean directory without the optional native addon', t => {
  const {source,output}=fixture(t);
  assert.equal(copyAssets(output,source),3);
  assert.equal(fingerprint(output),fingerprint(source));
  assert.equal(fs.existsSync(path.join(output,'native-glass.node')),false);
});

test('an invalid required resource fails before cleaning the last packaged addon', t => {
  const {source,output}=fixture(t);
  fs.writeFileSync(path.join(source,'native-glass.node'),'last valid build');
  copyAssets(output,source);
  fs.unlinkSync(path.join(source,'native-glass.node'));
  fs.unlinkSync(path.join(source,'main.js'));
  assert.throws(()=>copyAssets(output,source),/Missing application resource/);
  assert.equal(fs.readFileSync(path.join(output,'native-glass.node'),'utf8'),'last valid build');
});

const nativeAddon=path.join(__dirname,'../app','native-glass.node');
test('ad-hoc bundle signing preserves the already signed addon fingerprint', {skip:process.platform!=='darwin'||!fs.existsSync(nativeAddon)}, t => {
  const {source,output}=fixture(t);
  fs.copyFileSync(nativeAddon,path.join(source,'native-glass.node'));
  copyAssets(output,source);
  const before=fingerprint(source);
  const signed=spawnSync('codesign',['--force','--deep','--sign','-',path.join(output,'native-glass.node')],{encoding:'utf8'});
  assert.equal(signed.status,0,signed.stderr);
  assert.equal(fingerprint(output),before,'build must sign the addon before source/package fingerprints are captured');
  assert.equal(fingerprint(source),before,'only the temporary packaged copy may be signed by this test');
});

test('deep signing an app bundle keeps its copied native runtime identity', {skip:process.platform!=='darwin'||!fs.existsSync(nativeAddon)}, t => {
  const {source,output}=fixture(t);
  fs.copyFileSync(nativeAddon,path.join(source,'native-glass.node'));
  const bundle=path.join(output,'Synthetic.app'),contents=path.join(bundle,'Contents'),resources=path.join(contents,'Resources','app');
  fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true});
  // An inert system executable copied to a temporary bundle; never launched.
  fs.copyFileSync('/usr/bin/true',path.join(contents,'MacOS','Synthetic'));
  fs.writeFileSync(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Synthetic</string><key>CFBundleIdentifier</key><string>test.ai-bro.glass</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  copyAssets(resources,source);
  const signed=spawnSync('codesign',['--force','--deep','--sign','-',bundle],{encoding:'utf8'});
  assert.equal(signed.status,0,signed.stderr);
  assert.equal(fingerprint(resources),fingerprint(source));
});
