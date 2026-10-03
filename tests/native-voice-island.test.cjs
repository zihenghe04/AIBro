const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('voice is an ordinary section with one expanded accessibility tree',()=>{
 const s=fs.readFileSync(path.join(root,'native/Sources/AIBro/NativeQuickEntry.swift'),'utf8');
 assert.doesNotMatch(s,/voiceExpandedContent|auxiliaryContent|workspaceExpandedSize|forVoice\(/);
 assert.match(s,/case \.voice:\s*if let content = coordinator\.voiceContent/);
 assert.match(s,/expandedContent\s*\.frame[\s\S]*?\.disabled\(!coordinator\.presentation\.contentVisible\)\s*\.allowsHitTesting\(coordinator\.presentation\.contentVisible\)\s*\.accessibilityElement\(children: coordinator\.presentation\.contentVisible \? \.contain : \.ignore\)/);
 const voiceBranch=s.slice(s.indexOf('case .voice:',s.indexOf('private var expandedContent')),s.indexOf('case .runs:',s.indexOf('private var expandedContent')));
 assert.doesNotMatch(voiceBranch,/onAppear|onDisappear|onChange|start\(|cancel\(/);
});
test('actual Entry methods route voice through workbench tabs and restore transient placement',{skip:process.platform!=='darwin',timeout:45000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-voice-workbench-'));
 try{
  const s=fs.readFileSync(path.join(root,'native/Sources/AIBro/NativeQuickEntry.swift'),'utf8');
  const names=['showVoice','showPanel','openPanel','select','dismissVoice','showWorkspaceFromVoice','escape','dismiss','dismissContent','finishTransition','resolvedGeometry','updateGeometry','repositionWindows','isShowing'];
  const methods=names.map(name=>{
   const start=s.search(new RegExp('^    (?:@discardableResult )?(?:private )?func '+name+'\\(', 'm'));assert(start>=0,name);
   const end=s.indexOf('\n    }',start)+6;assert(end>start,name);
   return s.slice(start,end).replace('private func','func').replaceAll('NSScreen','FixtureScreen');
  }).join('\n');
  const start=s.indexOf('    var availableSections:'),end=s.indexOf('    var homeModules:',start);assert(start>0&&end>start);
  const template=fs.readFileSync(path.join(__dirname,'native-voice-workbench.swift'),'utf8');
  fs.writeFileSync(path.join(tmp,'Host.swift'),template.replace('// PRODUCTION_MEMBERS',s.slice(start,end)+methods));
  const bin=path.join(tmp,'checks');
  const result=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',...['NativeQuickPresentation','NativeQuickPanelPreferences'].map(n=>path.join(root,'native/Sources/AIBro',n+'.swift')),path.join(tmp,'Host.swift'),'-o',bin],{encoding:'utf8',timeout:35000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const run=spawnSync(bin,[],{encoding:'utf8',timeout:5000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
