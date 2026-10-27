const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('QuickTools follows AIBRO_NATIVE_DATA_DIR and is unchanged in production',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-qt-loc-'));
 try {
  const binary=path.join(temp,'checks');
  const source=['native/Sources/AIBro/NativeQuickToolsLocation.swift','tests/native-quicktools-location.swift'];
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...source.map(file=>path.join(root,file)),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/quicktools location checks/);
  const app=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
  assert.match(app,/quickLocalDirectory:URL \{\s*NativeQuickToolsLocation\.directory\(/,'every QuickTools store goes through the helper');
  assert.ok(!/appendingPathComponent\("Library\/Application Support",isDirectory:true\)\s*\n\s*\.appendingPathComponent\(Bundle\.main\.bundleIdentifier/.test(app),'no second hard-coded production path');
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
