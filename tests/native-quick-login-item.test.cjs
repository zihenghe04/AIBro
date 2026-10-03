const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

test('launch at login follows OS state without implicit registration', {skip:process.platform!=='darwin',timeout:120000},()=>{
  const root=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-login-item-'));
  try {
    const binary=path.join(temp,'test');
    const result=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',
      path.join(root,'native/Sources/AIBro/NativeQuickLoginItem.swift'),path.join(__dirname,'native-quick-login-item.swift'),'-o',binary],{encoding:'utf8',timeout:90000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stdout+run.stderr);
    assert.match(run.stdout,/PASS:/);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
