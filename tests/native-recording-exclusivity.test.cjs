const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');

test('optimized production realtime partial and stop commits obey exclusivity and retain failed writes',{timeout:180000},t=>{
  if(process.platform!=='darwin')return t.skip('macOS native frameworks');
  const root=path.resolve(__dirname,'..'),source=path.join(root,'native/Sources/AIBro');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-recording-exclusivity-'));
  const evidence=process.env.AIBRO_RECORDING_EXCLUSIVITY_EVIDENCE;
  const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  try{
    const store=fs.readFileSync(path.join(source,'NativeQuickRecordingStore.swift'),'utf8');
    const marker='        session.onChange = {[weak self] snapshot in';
    const start=store.indexOf(marker),end=store.indexOf('        let handoff=',start);
    assert.ok(start>=0&&end>start,'exact production onChange closure found');
    // Same-file test extensions can seed private state without altering any
    // production method body or shipping a test hook in the application.
    const handler=store.slice(start,end);
    fs.writeFileSync(path.join(temp,'NativeQuickRecordingStore.swift'),store+`
extension NativeQuickRecordingStore {
    func qaBindSyntheticRealtime(id:String,audio:NativeQuickRealtimeASRAudio,session:NativeQuickRealtimeASRSession) {
        recordingID=id;realtimeID=UUID();realtimeAudio=audio;realtimeSession=session;phase = .recording
    }
    func qaInvalidateRealtimeToken(){realtimeID=UUID()}
    func qaInstallProductionRealtimeHandler() {
        guard let id=recordingID,let token=realtimeID,let owner=archive?.directory,let session=realtimeSession else {preconditionFailure("synthetic setup missing")}
${handler}
    }
}
`);
    for(const [name,extension] of [
      ['NativeQuickRealtimeASRAudio',`extension NativeQuickRealtimeASRAudio {func qaAttachSyntheticPipeline(_ value:NativeQuickRealtimeASRAudioPipeline){pipeline=value}}`],
      ['NativeQuickRealtimeASRSession',`extension NativeQuickRealtimeASRSession {func qaSetReceivedSnapshot(_ value:NativeQuickASRSnapshot){snapshot=value}}`],
    ])fs.writeFileSync(path.join(temp,name+'.swift'),fs.readFileSync(path.join(source,name+'.swift'),'utf8')+'\n'+extension+'\n');
    const binary=path.join(temp,'recording-exclusivity');
    const names=['AgendaCore','NativeCredentials','NativeQuickRecordingBatch','NativeQuickRecordingTitle','NativeQuickRecordingPlayback','NativeSpeechService','NativePlainHTTPPolicy','NativeSpeechCredentials','NativeQuickRealtimeASRProtocol','NativeQuickRealtimeASRSettings','NativeQuickRealtimeASRHandoff'];
    const files=[path.join(root,'tests/native-recording-exclusivity.swift'),...names.map(name=>path.join(source,name+'.swift')),
      ...['NativeQuickRecordingStore','NativeQuickRealtimeASRAudio','NativeQuickRealtimeASRSession'].map(name=>path.join(temp,name+'.swift'))];
    const build=spawnSync('xcrun',['swiftc','-O','-enforce-exclusivity=checked','-swift-version','5','-parse-as-library','-target','arm64-apple-macosx14.0',...files,'-o',binary],{encoding:'utf8',timeout:100000,maxBuffer:8*1024*1024});
    const report={format:'aibro.recording-exclusivity.v1',optimized:true,exclusivity:'checked',sourceSHA256:sha(store),productionMethodBodiesUnchanged:true,syntheticPCM:true,noMicrophone:true,noNetwork:true,build:{status:build.status,signal:build.signal},runs:[]};
    if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'build.log'),build.stdout+build.stderr);}
    assert.equal(build.status,0,build.stdout+build.stderr);
    const modes=(process.env.AIBRO_RECORDING_EXCLUSIVITY_MODES||'stop,partial,partial-revoke,stop-revoke,stop-write-failure').split(',');
    for(const mode of modes){
      assert.ok(['stop','partial','partial-revoke','stop-revoke','stop-write-failure'].includes(mode));
      const run=spawnSync(binary,[mode,path.join(temp,mode)],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
      report.runs.push({mode,status:run.status,signal:run.signal,exclusivityViolation:/Simultaneous accesses|Fatal access conflict|AccessSet/.test(run.stderr)});
      if(evidence)fs.writeFileSync(path.join(evidence,mode+'.log'),run.stdout+run.stderr);
      process.stdout.write(run.stdout);if(run.status!==0)process.stderr.write(run.stderr.slice(0,4000));
    }
    if(evidence)fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
    assert.ok(report.runs.every(run=>run.status===0),JSON.stringify(report.runs));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
