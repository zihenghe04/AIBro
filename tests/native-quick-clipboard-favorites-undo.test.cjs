const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {spawnSync}=require('node:child_process');
test('clipboard favorites and precise delete/clear undo persist within protected budgets', {skip:process.platform!=='darwin',timeout:90000},()=>{
  const root=path.resolve(__dirname,'..'), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-clipboard-favorites-undo-'));
  try {
    const binary=path.join(temporary,'checks');
    const sources=['NativeQuickClipboard','NativeQuickClipboardArchive','NativeQuickClipboardView','NativeQuickClipboardPasteBack'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift'));
    const compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,path.join(__dirname,'native-quick-clipboard-favorites-undo.swift'),'-o',binary],{encoding:'utf8',timeout:60000});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    const run=spawnSync(binary,[temporary],{encoding:'utf8',timeout:25000});
    assert.equal(run.status,0,run.stdout+run.stderr); assert.match(run.stdout,/PASS: \d+ new favorites\/undo checks/); console.log(run.stdout.trim());
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});
