const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
const navigation=fs.readFileSync(path.join(root,'native/Sources/AIBro/WorkspaceNavigation.swift'),'utf8');
const method=name=>source.match(new RegExp(`    (?:private )?func ${name}\\([^]*?\\n    \\}`))[0];

test('direct native document commands capture origin before cancelling a pending route',()=>{
 const command=source.slice(source.indexOf('@discardableResult func command('),source.indexOf('    private func focusWebContent'));
 assert.match(command,/origin:\[String:Any\]\?=nil/);
 const captured=command.indexOf('let documentOrigin='),cancelled=command.indexOf('cancelPendingWorkspaceNavigation(');
 assert.ok(captured>=0&&captured<cancelled,'a cancellation can change native selection');
 assert.match(command,/\["note","import","task"\]\.contains\(type\) \? \(origin \?\? documentOpenOrigin\(\)\):nil/);
 assert.match(command,/if let documentOrigin \{payload\["origin"\]=documentOrigin\}/);
 assert.match(command,/JSONSerialization\.data\(withJSONObject:payload\)/);
 assert.ok(command.indexOf('if ["note","import","task"].contains(type) {spaceContent=true}')>cancelled,'revealed document stays visible after route cancellation restores selection');
 const agenda=fs.readFileSync(path.join(root,'native/Sources/AIBro/AgendaView.swift'),'utf8');
 const linked=agenda.slice(agenda.indexOf('Button(nativeUI("打开关联资料"'),agenda.indexOf('Button(nativeUI("打开关联资料"')+220);
 assert.match(linked,/model\.reveal\(occurrence\.event\.documentKind,occurrence\.event\.documentID\)/);
 assert.doesNotMatch(linked,/model\.selection=/,'linked agenda source keeps its native location');
});

test('all native global surfaces yield visual, pointer and accessibility ownership to a revealed document',()=>{
 const getter=source.match(/    var nativeContent:Bool \{[^\n]+/)[0];
 const predicate=getter.slice(getter.indexOf('{')+1,-1);
 // This source assertion covers actual SwiftUI mount conditions; the native
 // build checks their types and app acceptance checks their window behavior.
 assert.ok(source.includes('if model.selection == "conversations",!model.spaceContent'));
 const agenda=source.match(/if model.selection == "agenda" \{ AgendaView[^\n]+/)[0];
 assert.match(agenda,/\.opacity\(model\.spaceContent \|\| workspaceOverlay \? 0:1\)/);
 assert.match(agenda,/\.allowsHitTesting\(!model\.spaceContent && !workspaceOverlay\)/);
 assert.match(agenda,/\.accessibilityHidden\(model\.spaceContent \|\| workspaceOverlay\)/);
 assert.match(predicate,/\["today","overview","agenda","conversations"\]\.contains\(model\.selection \?\? ""\) && model\.spaceContent \{return false\}/);
 assert.match(source,/WebContent\(model:model,surfaceVisible:workspaceVisible && !nativeContent\)\.opacity\(nativeContent \? 0 : 1\)\.allowsHitTesting\(!nativeContent\)\.accessibilityHidden\(nativeContent\)/);
});

test('actual native origin and reveal methods use committed selection, never hidden WebKit state',{skip:process.platform!=='darwin',timeout:60000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-document-origin-unit-'));
 try{
  const schema='struct NativeWorkspaceLocation:'+navigation.split('struct NativeWorkspaceLocation:')[1].split('\nstruct SpaceNavigation:')[0];
  const swift=`import Foundation
${schema}
struct Snapshot {var view="project";var projectId="hidden-project";var projectSection="tasks";var conversationId="hidden-chat"}
@MainActor final class Workspace {
 var selection:String?="overview",navigationReturnSelection:String?,commandSearchSelection:String?
 var projectNavigationRequest:UUID?
 var snapshot:Snapshot?=Snapshot()
 var confirmedProjectSections:[String:String]=[:],spaceSections:[String:String]=[:]
 var spaceContent=false,compactWorkspacePreferred=false,returningFromModal=false,sawModal=false
 var commands:[[String:Any]]=[]
 func command(_ type:String,_ id:String="",origin:[String:Any]?=nil) {
  if type == "task" {spaceContent=true;returningFromModal=true;sawModal=false}
  var payload:[String:Any]=["type":type,"id":id,"revealed":spaceContent]
  if let origin {payload["origin"]=origin};commands.append(payload)
 }
${method('documentOpenOrigin')}
${method('reveal')}
${method('reconcileTaskSurface')}
${method('adoptReportedWorkspaceDestination')}
}
struct Failure:Error {let message:String}
@MainActor func check(_ condition:Bool,_ message:String)throws {if !condition {throw Failure(message:message)}}
@MainActor func expect(_ model:Workspace,_ value:[String:String],_ message:String)throws {try check((model.documentOpenOrigin() as? [String:String])==value,message)}
@main struct OriginTests {
 @MainActor static func main() throws {
  let model=Workspace()
  try expect(model,["view":"overview"],"visible overview wins over hidden project")
  model.reveal("note","noteB")
  try check((model.commands.last?["origin"] as? [String:String])==["view":"overview"],"reveal forwards overview")
  try check(model.spaceContent && (model.commands.last?["revealed"] as? Bool)==true,"reveal still displays reader")
  model.selection="project:A";model.confirmedProjectSections["A"]="outputs"
  try expect(model,["view":"project","projectId":"A","section":"outputs"],"native confirmed project section wins")
  model.selection="project:B"
  try expect(model,["view":"project","projectId":"B","section":"conversations"],"new project never borrows hidden section")
  model.projectNavigationRequest=UUID();model.navigationReturnSelection="project:A"
  try expect(model,["view":"project","projectId":"A","section":"outputs"],"pending selection is not a committed origin")
  model.reveal("import","sourceB")
  try check((model.commands.last?["origin"] as? [String:String])?["projectId"]=="A","pending reveal retains committed project")
  model.navigationReturnSelection=nil
  try check(model.documentOpenOrigin()==nil,"unavailable pending origin never uses optimistic destination")
  model.projectNavigationRequest=nil;model.selection="chat:C"
  try expect(model,["view":"agent","conversationId":"C"],"chat identity comes from native selection")
  for view in ["daily","courses","research"] {
   model.selection=view;model.spaceSections[view]="knowledge"
   try expect(model,["view":view,"section":"knowledge"],"native space section")
  }
  model.selection="daily";model.spaceSections["daily"]="papers"
  try expect(model,["view":"daily","section":"projects"],"invalid space section falls back locally")
  model.selection="research";model.spaceSections["research"]="papers"
  try expect(model,["view":"research","section":"papers"],"research papers is valid")
  for view in ["overview","conversations","agenda","wiki","captures","history"] {model.selection=view;try expect(model,["view":view],"standalone route identity")}
  model.selection="dashboard";try expect(model,["view":"overview"],"legacy overview alias")
  model.selection="research-projects";try expect(model,["view":"research","section":"projects"],"legacy research alias")
  for selection in ["project:","chat:","unknown"] {model.selection=selection;try check(model.documentOpenOrigin()==nil,"invalid identity is absent")}
  model.selection=nil;try check(model.documentOpenOrigin()==nil,"absent selection is absent")
  model.selection="overview";model.reveal("task","taskA")
  try check((model.commands.last?["origin"] as? [String:String])==["view":"overview"] && model.returningFromModal,"task receives the visible native entry")
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false)
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:true)
  try check(model.spaceContent && model.returningFromModal && model.sawModal,"task source remains visible after its modal closes")
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false)
  try check(model.spaceContent,"returned task keeps ownership")
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:false)
  try check(!model.spaceContent && !model.returningFromModal,"explicit task dismissal reveals original overview")
  model.selection="agenda"
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false)
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:true)
  try check(model.selection=="agenda" && model.spaceContent,"agenda identity survives source reading")
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:false)
  try check(model.selection=="agenda" && !model.spaceContent,"reader collapse returns to same agenda")
  model.selection="research";model.spaceSections["research"]="tasks"
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false)
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:false)
  try check(model.spaceContent,"task close preserves WebKit-owned space section")
  model.selection="agenda"
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false,entry:["view":"project","projectId":"A","section":"tasks"])
  try check(model.selection=="project:A" && model.confirmedProjectSections["A"]=="tasks" && model.spaceContent,"retained task returns to its own project, not the unrelated agenda")
  model.reconcileTaskSurface(taskOpen:false,modalOpen:false,readingOpen:false)
  try check(model.selection=="project:A","task close keeps its own project")
  model.selection="overview"
  model.reconcileTaskSurface(taskOpen:true,modalOpen:true,readingOpen:false,entry:["view":"agent","conversationId":"C"])
  try check(model.selection=="chat:C","task conversation entry is explicit, not hidden renderer state")
  print("PASS: actual native document origin and reveal")
 }
}
`;
  const file=path.join(dir,'Origin.swift'),binary=path.join(dir,'origin');fs.writeFileSync(file,swift);
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',file,'-o',binary],{encoding:'utf8',timeout:30000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS: actual native document origin and reveal/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
