const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('native presentation protocol admits only paired selectors, genuine IDs and presentation result states',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-quick-agent-'));
 try{
  const source=fs.readFileSync(path.join(root,'native/Sources/AIBro/NativeQuickPanelAgent.swift'),'utf8');
  const program=path.join(temp,'Checks.swift'),binary=path.join(temp,'checks');
  fs.writeFileSync(program,source+`
@main struct Checks {
 static func main() {
  let token=UUID().uuidString
  let owner:[String:Any]=["runId":"r","conversationId":"c","projectId":NSNull(),"workspace":"日常","userMessageId":"m","toolCallId":"tool"]
  func envelope(_ request:[String:Any])->[String:Any] { ["token":token,"request":request] }
  let base:[String:Any]=["section":"tasks","owner":owner]
  let valid=NativeQuickPanelOpenRequest(envelope(base))!
  precondition(valid.section == .tasks && valid.owner.runID == "r" && valid.owner.projectID == nil)
  precondition(Set(NativeQuickPanelOpenRequest.Section.allCases.map(\\.rawValue)) == Set(["home","tasks","capture","runs","agenda","links"]))
  for section in NativeQuickPanelOpenRequest.Section.allCases {
   var request=base;request["section"]=section.rawValue
   precondition(NativeQuickPanelOpenRequest(envelope(request))?.section == section)
  }
  for section in ["clipboard","recordings","vault","mirror","settings","other"] {
   var request=base;request["section"]=section
   precondition(NativeQuickPanelOpenRequest(envelope(request)) == nil)
  }
  for key in ["runId","conversationId","workspace","userMessageId","toolCallId"] {
   for bad:Any in ["",42,"line\\nbreak",String(repeating:"x",count:2049),NSNull()] {
    var invalidOwner=owner;invalidOwner[key]=bad
    var request=base;request["owner"]=invalidOwner
    precondition(NativeQuickPanelOpenRequest(envelope(request)) == nil)
   }
  }
  var invalidOwner=owner;invalidOwner["projectId"]=""
  var request=base;request["owner"]=invalidOwner
  precondition(NativeQuickPanelOpenRequest(envelope(request)) == nil)
  request=base;request["recordId"]="task-real"
  precondition(NativeQuickPanelOpenRequest(envelope(request)) == nil)
  request["recordType"]="task"
  precondition(NativeQuickPanelOpenRequest(envelope(request))?.recordID == "task-real")
  request["startRecording"]=true
  precondition(NativeQuickPanelOpenRequest(envelope(request)) == nil)
  var invalidEnvelope=envelope(base);invalidEnvelope["token"]="forged"
  precondition(NativeQuickPanelOpenRequest(invalidEnvelope) == nil)
  invalidEnvelope=envelope(base);invalidEnvelope["authorized"]=true
  precondition(NativeQuickPanelOpenRequest(invalidEnvelope) == nil)
  let opened=NativeQuickPanelOpenResult.opened(section:.agenda).payload
  precondition(opened["status"] as? String == "opened" && opened["section"] as? String == "agenda" && opened["opened"] as? Bool == true && opened["saved"] == nil)
  let links=NativeQuickPanelOpenResult.opened(section:.links).payload
  precondition(links["section"] as? String == "links" && links["opened"] as? Bool == true && Set(links.keys) == Set(["type","status","opened","section"]))
  let positioned=NativeQuickPanelOpenResult.positioned(section:.capture,recordType:"note",recordID:"synthetic-note").payload
  precondition(positioned["positioned"] as? Bool == true && positioned["recordId"] as? String == "synthetic-note" && positioned["recordType"] as? String == "note" && positioned["saved"] == nil)
  for result in [NativeQuickPanelOpenResult.deferred(reason:"editing"),.denied(reason:"private"),.unsupported(reason:"record_selection_unavailable")] {
   precondition(result.payload["opened"] as? Bool == false && result.payload["saved"] == nil)
  }
  print("PASS: native request parsing and truthful presentation receipts")
 }
}
`);
  const compile=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',program,'-o',binary],{encoding:'utf8',timeout:60000});assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS: native request parsing/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
