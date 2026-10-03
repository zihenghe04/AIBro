const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
test('local file shelf keeps originals, bookmarks, batch selection, privacy and transactional undo', {skip:process.platform !== 'darwin',timeout:180000}, () => {
  const root=path.resolve(__dirname,'..'), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-file-shelf-'));
  try {
    const output=path.join(temporary,'checks');
    const compile=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',
      path.join(root,'native/Sources/AIBro/NativeQuickFileShelf.swift'),path.join(root,'native/Sources/AIBro/NativeQuickFileShelfView.swift'),
      path.join(root,'native/Sources/AIBro/NativeQuickFileShelfPreview.swift'),
      path.join(__dirname,'native-quick-file-shelf.swift'),'-o',output],{encoding:'utf8',timeout:120000});
    assert.equal(compile.status,0,compile.stdout+compile.stderr);
    const run=spawnSync(output,[temporary],{encoding:'utf8',timeout:40000});
    assert.equal(run.status,0,run.stdout+run.stderr); assert.match(run.stdout,/PASS: \d+ file shelf checks/);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});
