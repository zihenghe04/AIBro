const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm'),{webcrypto,createHash}=require('node:crypto');
const CaptureNotes=require('../app/capture-notes.js'),CitationEvidence=require('../app/citation-evidence.js');
test('native title candidate lifecycle and exact draft/save recovery', {skip:process.platform!=='darwin',timeout:120000},async()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-capture-title-'));
 try {
  const sources=['NativeQuickRecordFocus.swift','NativeQuickCaptureStore.swift','NativeQuickCaptureLibraryStore.swift','NativeQuickCaptureMarkup.swift','NativeQuickCaptureScrollView.swift','NativeQuickCaptureTextEditor.swift','NativeQuickCaptureLibraryView.swift'].map(file=>path.join('native/Sources/AIBro',file));
  const binary=path.join(temporary,'title-tests');
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...sources,'tests/native-quick-capture-title.swift','-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const raw={id:'capture-1',kind:'随记',title:'Study notes',titleSource:'content',content:'Study notes\nSynthetic samples.',tags:['fixture'],createdAt:1,updatedAt:10,sourceAttachmentIds:[]};
  const canonical=JSON.stringify(raw,Object.keys(raw).sort());
  const recordVersion='sha256:'+createHash('sha256').update(canonical).digest('hex');
  const result=spawnSync(binary,[path.join(temporary,'fixtures'),recordVersion],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  for(const line of result.stdout.trim().split('\n')) {
   if(!line.startsWith('INTEROP ')){process.stdout.write(line+'\n');continue;}
   const {scenario,source,payload}=JSON.parse(line.slice(8));
   const state={notes:[{...raw,titleSource:source}],ui:{},projects:[],imports:[],tasks:[],links:[],trash:[]};
   const context={state,storageHydrated:true,serverConflict:false,purgeTrash:{},TextEncoder,
    window:{crypto:webcrypto,PrivateMode:{isOn:()=>false},CaptureNotes,CitationEvidence},
    document:{body:{dataset:{view:'project'}},dispatchEvent(){}},CustomEvent:class{},saveDocumentDurably:async()=>true};
   vm.runInNewContext(fs.readFileSync('native/Resources/quick-capture.js','utf8'),context);
   const reply=await context.window.NativeQuickCapture.library(payload);
   assert.equal(reply.status,'saved',scenario+': '+JSON.stringify(reply));
   assert.equal(state.notes[0].titleSource,scenario==='adopt-manual'?'user':scenario==='content-body'?'content':'model',scenario);
   assert.equal(state.notes[0].title,scenario==='adopt-manual'?'Human final choice':scenario==='adopt-body'?'Synthetic sample comparison':scenario==='content-body'?'Changed first line':'Study notes',scenario);
   process.stdout.write('PASS native payload → production JS save: '+scenario+'\n');
  }
 } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
