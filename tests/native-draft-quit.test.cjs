const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const swift=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
const gate=swift.slice(swift.indexOf('struct NativeDraftQuitGate {'),swift.indexOf('// SwiftUI keeps its window delegate.'));
const native=swift.slice(swift.indexOf('// SwiftUI keeps its window delegate.'),swift.indexOf('@main struct AIBroApp:App'));
const quitRequest=native.slice(native.indexOf('func requestQuit()'),native.indexOf('func applicationShouldTerminate(_'));
const script=quitRequest.match(/callAsyncJavaScript\("""\n([^]*?)\n\s*"""/)[1];
assert.match(script,/window\.flushLocalDrafts/);
const run=window=>vm.runInNewContext(`(async()=>{${script}})()`,{window});

test('native quit waits for actual local draft acknowledgement without publishing notes',async()=>{
 let finish,calls=0,settled=false;
 const pending=run({flushLocalDrafts:()=>{calls++;return new Promise(resolve=>finish=resolve)}}).then(value=>{settled=true;return value});
 await Promise.resolve();assert.equal(calls,1);assert.equal(settled,false);
 finish(true);assert.equal(await pending,true);
 assert.doesNotMatch(script,/saveDocument|beforeLeave|CoreAgent|fetch|NoteEditor\.save/);
});

test('quit bridge treats only boolean true as success, preserves missing-hook compatibility, and propagates errors',async()=>{
 assert.equal(await run({}),true);
 for(const value of [false,undefined,null,0,1,'true',{},[]])assert.equal(await run({flushLocalDrafts:async()=>value}),false);
 await assert.rejects(run({flushLocalDrafts:async()=>{throw Error('disk full')}}),/disk full/);
});

test('native lifecycle keeps backend running until approval and routes last-window close through the same gate',()=>{
 assert.match(native,/guard let token=draftQuit\.begin\(\) else\{draftQuitAlert\?\.window\.makeKeyAndOrderFront\(nil\);return\}/);
 assert.match(native,/asyncAfter\(deadline:\.now\(\)\+8,execute:timeout\)/);
 assert.match(native,/catch \{self\?\.completeDraftQuit\(token,success:false\)\}/);
 assert.match(native,/guard draftQuit\.acknowledge\(token,success:success\) else\{return\}/);
 const completion=native.slice(native.indexOf('private func completeDraftQuit'),native.indexOf('func applicationWillTerminate'));
 assert.doesNotMatch(completion,/\.stop\(|\.terminate\(|\.close\(/);
 assert.match(completion,/if success\{terminateApproved\(\);return\}/);
 assert.match(completion,/response == \.alertSecondButtonReturn/);
 assert.match(completion,/alert\.addButton\(withTitle:nativeUI\("返回编辑"/);
 assert.match(completion,/alert\.buttons\.first\?\.keyEquivalent="\\r"/);
 assert.match(native,/applicationWillTerminate[^\n]+model\?\.stop\(\)/);
 assert.match(native,/if owner\?\.interceptLastWindowClose\(sender\) == true\{return false\}/);
 assert.match(native,/previous\?\.windowShouldClose\?\(sender\) \?\? true/);
 assert.match(native,/guard others\.isEmpty else\{return false\}/);
 assert.match(native,/draftQuitWindow=window;requestQuit\(\);return true/);
 assert.match(swift,/MainView\(model:model,quickEntry:delegate\.quickEntry\)\.background\(NativeDraftQuitWindow\(delegate:delegate\)\)/);
 assert.match(swift,/AIBRO_NATIVE_QA_HOLD[^\n]+NSApp\.terminate\(nil\)/);
});

test('agenda sheets hand termination to the draft gate and keep the editor mounted while the decision is shown',()=>{
 const agenda=fs.readFileSync(path.join(root,'native/Sources/AIBro/AgendaView.swift'),'utf8');
 const editor=agenda.slice(agenda.indexOf('struct AgendaEditor:View'),agenda.indexOf('struct AgendaDetail:View'));
 assert.match(editor,/\.background\(NativeDraftQuitSheet\(\)\)/);
 assert.match(editor,/\.interactiveDismissDisabled\(dirty \|\| saving\)/);
 assert.match(editor,/store\.setEditorDraft\(session,dirty:dirty\)/);
 const sheet=native.slice(native.indexOf('@MainActor struct NativeDraftQuitSheet'),native.indexOf('@MainActor final class Delegate:'));
 const lifecycle=sheet.slice(sheet.indexOf('override func viewDidMoveToWindow'),sheet.indexOf('static func allowApprovedTermination'));
 assert.doesNotMatch(lifecycle,/preventsApplicationTerminationWhenModal|NotificationCenter|async/);
 assert.match(sheet,/static func allowApprovedTermination/);
 assert.match(sheet,/current\.preventsApplicationTerminationWhenModal=false/);
 assert.match(sheet,/dismantleNSView[^\n]+unregister\(\)/);
 const request=native.slice(native.indexOf('func requestQuit()'),native.indexOf('func applicationShouldTerminate(_'));
 assert.doesNotMatch(request,/NSApp\.terminate|\.reply\(|allowApprovedTermination/);
 const external=native.slice(native.indexOf('func applicationShouldTerminate(_'),native.indexOf('private func terminateApproved()'));
 assert.match(external,/if draftQuit\.phase == \.approved\{return \.terminateNow\}/);
 assert.match(external,/return \.terminateCancel/);
 assert.doesNotMatch(external,/return \.terminateLater/);
 const approved=native.slice(native.indexOf('private func terminateApproved()'),native.indexOf('private func completeDraftQuit'));
 assert.match(approved,/guard self\?\.draftQuit\.phase == \.approved else\{return\}/);
 assert.match(approved,/NativeDraftQuitSheet\.View\.allowApprovedTermination\(\)[\s\S]+NSApp\.terminate\(nil\)/);
 assert.match(swift,/CommandGroup\(replacing:\.appTermination\)\{Button[^\n]+delegate\.requestQuit\(\)\}\.keyboardShortcut\("q",modifiers:\.command\)/);
 const completion=native.slice(native.indexOf('private func completeDraftQuit'),native.indexOf('func applicationWillTerminate'));
 assert.match(completion,/while let sheet=window\.attachedSheet \{window=sheet\}/);
 assert.match(completion,/if let window=presentingWindow \{/);
 assert.match(completion,/if let window=presentingWindow \?\? self\.draftQuitWindow/);
 assert.match(completion,/alert\.beginSheetModal\(for:window,completionHandler:decision\)/);
 assert.doesNotMatch(completion,/endSheet\(|endEditorDraft|dismiss\(|removeFromSuperview|\.save\(|alertStyle = \.critical/);
});

test('production quit state machine handles repeated Cmd-Q, failure, timeout, return, explicit exit and stale acknowledgements',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-native-draft-quit-'));
 try{
  const source=path.join(temp,'Gate.swift'),binary=path.join(temp,'gate');
  fs.writeFileSync(source,`import Foundation\n${gate}\n
var gate=NativeDraftQuitGate()
let first=gate.begin()!
precondition(gate.begin() == nil)
precondition(!gate.acknowledge(UUID(),success:true))
precondition(gate.acknowledge(first,success:false))
precondition(gate.phase == .decision(first))
precondition(gate.begin() == nil)
precondition(!gate.acknowledge(first,success:true))
precondition(!gate.decide(UUID(),exit:true))
precondition(gate.decide(first,exit:false))
precondition(gate.phase == .idle)
let second=gate.begin()!
precondition(second != first)
precondition(!gate.acknowledge(first,success:true))
precondition(!gate.decide(first,exit:true))
precondition(gate.acknowledge(second,success:true))
precondition(gate.phase == .approved)
precondition(!gate.acknowledge(second,success:false))
precondition(gate.begin() == nil)
var forced=NativeDraftQuitGate()
let token=forced.begin()!
precondition(forced.acknowledge(token,success:false))
precondition(forced.decide(token,exit:true))
precondition(forced.phase == .approved)
precondition(!forced.decide(token,exit:false))
print("PASS: native draft quit lifecycle")
`);
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5',source,'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS: native draft quit lifecycle/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('production AppKit quit and window forwarding methods typecheck against native APIs',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-native-draft-quit-api-'));
 try{
  const source=path.join(temp,'Quit.swift');
  const windowTypes=native.slice(0,native.indexOf('@MainActor final class Delegate:'));
  const quitState=native.slice(native.indexOf('private var draftQuit='),native.indexOf('private func configureQuickEntry()'));
  const quitMethods=native.slice(native.indexOf('func observeWorkspaceWindow('),native.indexOf('func applicationWillTerminate('));
  const lastWindowPolicy=native.match(/func applicationShouldTerminateAfterLastWindowClosed[^\n]+/)[0];
  assert.match(quitState,/private var workspaceWindows:/);
  assert.match(quitMethods,/func requestQuit\(\)[\s\S]+private func completeDraftQuit/);
  // Typecheck the exact production quit/window implementations, not unrelated
  // coordinator setup. Only their module-facing dependencies are test doubles.
  fs.writeFileSync(source,`import Foundation
import AppKit
import WebKit
import SwiftUI
import Combine
func nativeUI(_ zh:String,_ en:String)->String{zh}
@MainActor final class AgendaStore{var hasUnsavedEditorDrafts=false}
@MainActor final class Workspace:NSObject {
 let web=WKWebView();let agenda=AgendaStore()
}
@MainActor final class QuitDraftDependency {
 var hasUnsavedEditorDraft=false,saving=false
 var hasUnsavedTaskEditorDraft=false,hasUnsavedTaskCreationFields=false,creating=false
 var busyTaskIDs=Set<String>()
 func flushForQuit()->Bool{true}
 func flushPendingDraft()->Bool{true}
 func invalidate(){}
}
@MainActor final class QuitMediaDependency {let recordings=QuitDraftDependency()}
@MainActor final class NativeQuickEntryCoordinator {
 enum Section {case home,tasks,agenda,links,recordings,vault}
 var keepRunning=false,taskDraft=""
 let links=QuitDraftDependency(),workbench=QuitDraftDependency()
 func flushCaptureDraft()->Bool{true}
 func dismiss(returnFocus:Bool){}
 func showCapture(){}
 func setHomeModule(_ id:String,visible:Bool){}
 func showPanel(section:Section){}
}
${gate}
${windowTypes}
@MainActor final class Delegate:NSObject,NSApplicationDelegate {
 var model:Workspace?
 let quickEntry=NativeQuickEntryCoordinator()
 let quickUtilities=QuitDraftDependency(),quickAgenda=QuitDraftDependency(),quickVault=QuitDraftDependency()
 let quickMedia=QuitMediaDependency()
 var voiceCommand:QuitDraftDependency?,speechDictation:QuitDraftDependency?
 ${quitState}
 func restoreWorkspaceWindow(){}
 ${quitMethods}
 ${lastWindowPolicy}
}

@MainActor struct QuitCommands:Commands{let delegate:Delegate;var body:some Commands{${swift.match(/CommandGroup\(replacing:\.appTermination\)\{Button[^]*?\};(?=CommandGroup\(replacing:\.appSettings\))/)[0].slice(0,-1)}}}`);
  const result=spawnSync('xcrun',['swiftc','-swift-version','5','-typecheck',source],{encoding:'utf8',timeout:90000});
  assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
