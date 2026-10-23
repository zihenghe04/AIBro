const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
const navigation=fs.readFileSync(path.join(root,'native/Sources/AIBro/WorkspaceNavigation.swift'),'utf8');
const method=name=>source.match(new RegExp(`    (?:private )?func ${name}\\([^]*?\\n    \\}`))[0];

test('workspace navigation RPC sends structured destination to the origin-validated native handler',async()=>{
 const calls=[];class Storage{setItem(){}removeItem(){}}
 const env={Storage,localStorage:new Storage(),window:{webkit:{messageHandlers:{desktop:{postMessage:body=>{calls.push(body);return Promise.resolve(true)}}}}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'native/Resources/desktop.js'),'utf8'),env);
 assert.equal(await env.window.workstationDesktop.navigateWorkspace({view:'research',section:'papers'}),true);
 assert.equal(calls[0].command,'navigate-workspace');assert.equal(calls[0].destination.view,'research');assert.equal(calls[0].destination.section,'papers');
 const desktop=fs.readFileSync(path.join(root,'native/Sources/AIBro/NativeDesktop.swift'),'utf8');
 const validation=desktop.indexOf('message.frameInfo.isMainFrame'),rpc=desktop.indexOf('command=="navigate-workspace"');
 assert.ok(validation>=0&&validation<rpc);
 assert.match(desktop.slice(validation,rpc),/url\.scheme=="http",url\.host==origin\.host,url\.port==origin\.port/);
 for(const view of ['overview','conversations','daily','courses','research','wiki','captures','dashboard','trash','agent'])assert.ok(desktop.slice(rpc,desktop.indexOf('if command=="browser"',rpc)).includes(`"${view}"`));
 assert.match(method('navigateWorkspace'),/view == "dashboard" \? "overview":view/);
});

test('native space panels yield hit testing and accessibility ownership to a revealed reader',()=>{
 assert.match(source,/if let view=spaceView,let space=spaceName,model\.selection != "wiki",!model\.spaceContent/);
 assert.match(source,/currentSpaceSection\) && !model\.spaceContent/);
 assert.match(source,/value\.readingOpen == true && value\.view == selection/);
 assert.match(source,/didFinish navigation:WKNavigation!\)\{[^\n]*publishNativeSpaceNavigation\(\)/);
 assert.match(source,/\.onChange\(of:spaceView\)\{_,_ in model\.publishNativeSpaceNavigation\(\)\}/);
});

test('actual location persistence and restoration use confirmed, scoped, valid metadata',{skip:process.platform!=='darwin',timeout:60000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-location-unit-'));
 try{
  const schema='struct NativeWorkspaceLocation:'+navigation.split('struct NativeWorkspaceLocation:')[1].split('\nstruct SpaceNavigation:')[0];
  const methods=['persistConfirmedLocation','restoreCommittedLocation'].map(method).join('\n');
  const swift=`import Foundation
${schema}
struct Project {let id:String}
struct Conversation {let id:String;var archived=false}
struct Snapshot {var privateMode:Bool?=false;var projects=[Project(id:"p")];var conversationLibrary:[Conversation]?=[Conversation(id:"c")];var view="agent";var projectId:String?;var conversationId="c";var projectSection:String?;var spaceSection:String?}
@MainActor final class UserDefaults {static let standard=UserDefaults();var stored:[String:Data]=[:];func set(_ data:Data,forKey key:String){stored[key]=data};func data(forKey key:String)->Data?{stored[key]}}
@MainActor final class Workspace {
 var ready=true,restoringWorkspaceLocation=false,spaceContent=false
 var projectNavigationRequest:UUID?
 var snapshot:Snapshot?=Snapshot()
 var selection:String?="chat:c"
 var spaceSections:[String:String]=[:],confirmedProjectSections:[String:String]=[:]
 var dataDirectory=URL(fileURLWithPath:"/fixture/one")
 var webFocusGeneration=0,accepted=true
 var commands:[(String,String,String?)]=[]
 func rememberNavigationOrigin(_ value:String?){}
 var tourChecks=0
 @discardableResult func adoptTourDestination(_ value:Snapshot)->Bool {tourChecks+=1;return false}
 func command(_ type:String,_ id:String,section:String?=nil)->Task<Bool,Never>? {
  commands.append((type,id,section))
  return Task {if self.accepted {self.selection=type == "project" ? "project:"+id:type == "conversation" ? "chat:"+id:id;if let section {self.spaceSections[id]=section}}
   return self.accepted}
 }
${methods}
}
struct Failure:Error {let message:String}
@MainActor func check(_ condition:Bool,_ message:String)throws{if !condition {throw Failure(message:message)}}
@MainActor func settled(_ model:Workspace)async throws{for _ in 0..<1000 {if !model.restoringWorkspaceLocation{return};await Task.yield()};throw Failure(message:"restore did not settle")}
@main struct LocationTests {
 @MainActor static func main()async throws {
  let key="AIBro.committedLocation./fixture/one",other="AIBro.committedLocation./fixture/two"
  let model=Workspace();model.persistConfirmedLocation()
  let saved=UserDefaults.standard.data(forKey:key)!
  try check(try JSONDecoder().decode(NativeWorkspaceLocation.self,from:saved)==NativeWorkspaceLocation(view:"agent",conversationID:"c"),"committed chat metadata")
  model.selection="project:p";model.projectNavigationRequest=UUID();model.persistConfirmedLocation();try check(UserDefaults.standard.data(forKey:key)==saved,"pending location must not persist")
  model.projectNavigationRequest=nil;model.snapshot?.privateMode=true;model.persistConfirmedLocation();try check(UserDefaults.standard.data(forKey:key)==saved,"private navigation must not persist")
  model.snapshot?.privateMode=false;model.selection="chat:private-or-deleted";model.persistConfirmedLocation();try check(UserDefaults.standard.data(forKey:key)==saved,"unavailable chat must not persist")
  model.selection="project:p";model.confirmedProjectSections["p"]="outputs";model.persistConfirmedLocation()
  let project=try JSONDecoder().decode(NativeWorkspaceLocation.self,from:UserDefaults.standard.data(forKey:key)!);try check(project.section=="outputs" && project.projectID=="p","ACK section is authoritative")
  model.dataDirectory=URL(fileURLWithPath:"/fixture/two");model.selection="research";model.spaceSections["research"]="tasks";model.persistConfirmedLocation()
  let second=UserDefaults.standard.data(forKey:other)!;try check(second != UserDefaults.standard.data(forKey:key),"data directory isolates persisted location")
  model.restoreCommittedLocation(model.snapshot!);try await settled(model);try check(model.commands.last!.0=="workspace-view" && model.commands.last!.1=="research" && model.commands.last!.2=="tasks","restart restores exact space section")
  let settings=try JSONEncoder().encode(NativeWorkspaceLocation(view:"settings"));UserDefaults.standard.set(settings,forKey:other);model.restoreCommittedLocation(model.snapshot!);try await settled(model);try check(model.commands.last!.1=="settings","settings uses guarded restoration")
  UserDefaults.standard.set(try JSONEncoder().encode(NativeWorkspaceLocation(view:"project",projectID:"gone")),forKey:other);model.restoreCommittedLocation(model.snapshot!);try await settled(model);try check(model.commands.last!.1=="overview","unavailable target falls back")
  UserDefaults.standard.set(second,forKey:other);model.accepted=false;model.selection="overview";model.restoreCommittedLocation(model.snapshot!);try await settled(model);try check(UserDefaults.standard.data(forKey:other)==second,"failed restore cannot replace last committed location")
  let before=model.commands.count;model.restoreCommittedLocation(model.snapshot!);model.webFocusGeneration+=1;try await settled(model);try check(model.commands.count==before,"user action supersedes queued startup restore")
  try check(model.tourChecks>0,"restore re-checks a tour page opened meanwhile")
  try check(NativeWorkspaceLocation.tourDestination(selection:"overview",reportedView:"settings",tourOpen:true)=="settings","onboarding over overview names settings")
  try check(NativeWorkspaceLocation.tourDestination(selection:"conversations",reportedView:"agent",tourOpen:true)=="agent","tour over the chat hub names the chat page")
  try check(NativeWorkspaceLocation.tourDestination(selection:"overview",reportedView:"dashboard",tourOpen:true)==nil,"dashboard is the overview")
  try check(NativeWorkspaceLocation.tourDestination(selection:"overview",reportedView:"settings",tourOpen:false)==nil,"hidden web routes never take over a native page")
  try check(NativeWorkspaceLocation.tourDestination(selection:"settings",reportedView:"agent",tourOpen:true)==nil,"web pages already follow reports")
  try check(!NativeWorkspaceLocation(view:"daily",section:"papers").available(projects:[],conversations:[]),"space invalid section rejected")
  try check(NativeWorkspaceLocation(view:"research",section:"papers").available(projects:[],conversations:[]),"research papers retained")
  try check(NativeWorkspaceLocation(view:"dashboard").view=="overview","legacy dashboard is one native overview")
  let metadata=String(decoding:second,as:UTF8.self);try check(!metadata.contains("title") && !metadata.contains("content") && !metadata.contains("password"),"only route metadata is retained")
  print("PASS: 20 committed location checks")
 }
}
`;
  const file=path.join(dir,'Location.swift'),binary=path.join(dir,'location');fs.writeFileSync(file,swift);
  const build=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',file,'-o',binary],{encoding:'utf8',timeout:30000});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS: 20 committed location checks/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('first launch: onboarding over a native dashboard moves the sidebar to the page it shows',()=>{
 // Restoration re-checks after it settles; later snapshots adopt while a tour is open.
 assert.match(method('restoreCommittedLocation'),/if accepted \{persistConfirmedLocation\(\)\}\n\s*\/\/[^\n]*\n\s*if let current=snapshot \{_ = adoptTourDestination\(current\)\}/);
 assert.match(source,/persistConfirmedLocation\(\)\n        \} else if !first \{_ = adoptTourDestination\(value\)\}/);
 assert.match(method('adoptTourDestination'),/NativeWorkspaceLocation\.tourDestination\(selection:selection,reportedView:value\.view,tourOpen:value\.tourOpen == true\)/);
 assert.doesNotMatch(method('adoptTourDestination'),/persistConfirmedLocation/);
});
