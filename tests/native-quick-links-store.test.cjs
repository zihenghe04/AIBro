const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root=path.resolve(__dirname,'..');

test('native link editor persists input and exact retries without a second source database', {skip:process.platform!=='darwin',timeout:180000},async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-quick-links-store-'));
  try {
    const production=name=>{ const file=path.join(root,'native/Sources/AIBro',name+'.swift'); const source=fs.existsSync(file)?file:file+'.pending'; const target=path.join(temp,name+'.swift'); fs.copyFileSync(source,target); return target; };
    const store=production('NativeQuickLinksStore'), view=production('NativeQuickLinksView'), binary=path.join(temp,'links-tests');
    const compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',production('NativeQuickRecordFocus'),production('NativeQuickLinkIcon'),production('NativeQuickLinkDrag'),production('NativeQuickLinkSitePolicy'),store,view,path.join(__dirname,'native-quick-links-store.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    for(const scenario of ['folder-draft-restart','folder-create-exact-ack','folder-wrong-ack-retains','folder-lost-ack-restart','folder-rename-retains-collapse','folder-edit-preserves-link-draft','folder-drop-to-empty','layout-restart-and-search','layout-owner-isolation','layout-corrupt-preserved','layout-save-failure-isolated','offline-draft-restart','envelope-before-request','lost-ack-restart','wrong-ack-retains','wrong-record-ack','stale-version-retains','disk-failure-no-request','disk-failure-after-ack','private-during-read','private-during-save','owner-rebind','query-generation','corrupt-file-readonly','delete-keeps-pending-before-ack','open-revalidates','fetch-journal-and-status','fetch-failed-clears-envelope','fetch-lost-ack-restart','fetch-wrong-status-retains','fetch-preserves-unsent-edit']) {
      await t.test(scenario,()=>{
        const result=spawnSync(binary,[scenario,path.join(temp,scenario)],{encoding:'utf8',timeout:15000});
        assert.equal(result.status,0,result.stdout+result.stderr); assert.match(result.stdout,/PASS:/);
      });
    }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
