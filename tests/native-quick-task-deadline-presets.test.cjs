const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('production deadline shortcuts preserve manual drafts and exact durable retry fields', {skip:process.platform!=='darwin',timeout:180000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-deadline-presets-'));
 try {
  const base=path.resolve(__dirname,'../native/Sources/AIBro');
  const files=['NativeQuickRecordFocus.swift','NativeTaskInboxParser.swift','NativeTaskInbox.swift','NativeQuickTaskDeadlinePresets.swift','NativeQuickWorkbench.swift','NativeQuickTaskLifecycle.swift','NativeQuickTaskEditor.swift'];
  const binary=path.join(dir,'deadline-presets');
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files.map(f=>path.join(base,f)),path.join(__dirname,'native-quick-task-deadline-presets.swift'),'-o',binary],{encoding:'utf8',timeout:140000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const result=spawnSync(binary,[path.join(dir,'fixture')],{encoding:'utf8',timeout:15000});
  process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
