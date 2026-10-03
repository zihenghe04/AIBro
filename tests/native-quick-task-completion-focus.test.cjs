const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('task completion preserves record focus only while its keyboard interaction lease survives',{skip:process.platform!=='darwin',timeout:180000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-task-completion-focus-'));
 try{
  const base=path.resolve(__dirname,'../native/Sources/AIBro');
  const files=['NativeQuickRecordFocus.swift','NativeTaskInboxParser.swift','NativeTaskInbox.swift','NativeQuickTaskDeadlinePresets.swift', 'NativeQuickWorkbench.swift','NativeQuickTaskLifecycle.swift','NativeQuickTaskDeadline.swift','NativeQuickTaskEditor.swift','NativeQuickTaskMotion.swift','NativeQuickTaskListView.swift'];
  const bin=path.join(dir,'focus');const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5','-target','arm64-apple-macosx14.0',...files.map(f=>path.join(base,f)),path.join(__dirname,'native-quick-task-completion-focus.swift'),'-o',bin],{encoding:'utf8',timeout:150000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(bin,[path.join(dir,'fixtures')],{encoding:'utf8',timeout:15000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr+JSON.stringify({signal:run.signal,error:run.error}));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
