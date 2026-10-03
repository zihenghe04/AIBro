const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
test('inline file shelf preview preserves selection and rejects obsolete or replaced originals', {skip:process.platform !== 'darwin', timeout:180000}, () => {
  const root=path.resolve(__dirname,'..'), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-shelf-preview-'));
  try {
    const output=path.join(temporary,'checks');
    const sources=['NativeQuickFileShelf.swift','NativeQuickFileShelfView.swift','NativeQuickFileShelfPreview.swift'].map(name=>path.join(root,'native/Sources/AIBro',name));
    const compile=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,path.join(__dirname,'native-quick-file-shelf-preview.swift'),'-o',output],{encoding:'utf8',timeout:120000});
    assert.equal(compile.status,0,compile.stdout+compile.stderr);
    const run=spawnSync(output,[temporary],{encoding:'utf8',timeout:40000});
    assert.equal(run.status,0,run.stdout+run.stderr);
    assert.match(run.stdout,/PASS: \d+ file shelf preview checks/);
    process.stdout.write(run.stdout);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});
