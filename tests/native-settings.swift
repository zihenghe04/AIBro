// The runner injects the production Workspace settings/navigation methods below.
// These collaborators have no UI, disk, network, preferences, or user data.
import Foundation
// LOCATION_SCHEMA

@MainActor final class TestWindow {
    var isMiniaturized=false
    var attachedSheet:TestWindow?
    var frontCount=0,deminiaturizeCount=0,focusCount=0
    func deminiaturize(_ sender:Any?){isMiniaturized=false;deminiaturizeCount += 1}
    func makeKeyAndOrderFront(_ sender:Any?){frontCount += 1}
    func makeFirstResponder(_ view:TestWeb){focusCount += 1}
}
@MainActor final class TestApplication {
    var keyWindow=TestWindow(),activations=0
    func activate(ignoringOtherApps:Bool){activations += 1}
}
@MainActor let NSApp=TestApplication()
@MainActor final class TestBrowser {var visible=false;var tabs=["existing"]}
@MainActor final class TestHost {var window:TestWindow?;init(_ window:TestWindow?){self.window=window};func cancelRequestedFocus(){};func requestFocusWhenVisible(){window?.focusCount += 1}}
struct TestSnapshot {var modalOpen:Bool?}
enum TestContentWorld {case page}
@MainActor final class TestWeb {
    var window:TestWindow?=TestWindow()
    var asyncScripts:[String]=[],syncScripts:[String]=[]
    var asyncArguments:[[String:Any]]=[]
    var pending:[CheckedContinuation<Any?,Error>]=[]
    var holdEvaluations=false
    var evaluations:[((Any?,Error?)->Void)]=[]
    func callAsyncJavaScript(_ script:String,arguments:[String:Any],in frame:Any?,contentWorld:TestContentWorld)async throws->Any? {
        asyncScripts.append(script);asyncArguments.append(arguments)
        return try await withCheckedThrowingContinuation {pending.append($0)}
    }
    func evaluateJavaScript(_ script:String,completionHandler:((Any?,Error?)->Void)?){syncScripts.append(script);if holdEvaluations,let completionHandler {evaluations.append(completionHandler)}else{completionHandler?(true,nil)}}
    func finish(_ value:Any){pending.removeFirst().resume(returning:value)}
    func fail(){pending.removeFirst().resume(throwing:CocoaError(.featureUnsupported))}
}
func nativeUI(_ chinese:String,_ english:String)->String{english}
@MainActor final class Workspace {
    var webFocusGeneration=0
    var compactWorkspacePreferred=false,returningFromModal=false,sawModal=false
    var spaceSections:[String:String]=[:],confirmedProjectSections:[String:String]=[:]
    var persistenceCount=0
    func persistConfirmedLocation(){persistenceCount += 1}
    var snapshot:TestSnapshot?
    var ready=true,settingsNavigationPending=false,settingsSelectionPending=false,spaceContent=false
    var settingsNavigationRequest:UUID?
    var selection:String?="chat:original",error:String?
    var pendingNavigation:(view:String,id:String?)?
    var pendingProjectSection:String?,navigationReturnSelection:String?,commandSearchSelection:String?
    var projectNavigationRequest:UUID?
    var navigationReturnSpaceContent=false
    var glassHost:TestHost?
    let web=TestWeb(),browser=TestBrowser()
    // Diagnostics are an observed host side effect; never write production files.
    var navigationDiagnostics:[String]=[]
    func recordQuickNavigation(_ stage:String,reason:String?=nil,error:Error?=nil,accepted:Bool?=nil){navigationDiagnostics.append(stage)}
    // PRODUCTION_METHODS
}

struct Failure:Error,CustomStringConvertible {let description:String}
@MainActor func check(_ condition:@autoclosure()->Bool,_ message:String)throws{if !condition(){throw Failure(description:message)}}
@MainActor func until(_ condition:()->Bool)async throws{
    for _ in 0..<2000 {if condition(){return};await Task.yield()}
    throw Failure(description:"Async native settings transition did not settle")
}
@MainActor func finishRoute(_ model:Workspace,_ destination:[String:Any]) async throws {
    try await until{model.web.pending.count==1}
    model.web.finish(["accepted":true,"supersededByPage":false,"destination":destination])
    try await until{model.projectNavigationRequest==nil}
}
@MainActor func lastCommand(_ model:Workspace)throws->[String:Any] {
    let prefix="window.NativeShell?.perform("
    guard let script=model.web.syncScripts.last(where:{$0.hasPrefix(prefix)}),
          let payload=try JSONSerialization.jsonObject(with:Data(script.dropFirst(prefix.count).dropLast().utf8)) as? [String:Any] else {
        throw Failure(description:"No serialized native command")
    }
    return payload
}
@main struct SettingsTests {
    @MainActor static func main()async throws {
        var passed=0
        do {
            let model=Workspace(),main=model.web.window!,other=NSApp.keyWindow
            main.isMiniaturized=true;model.openWorkspaceSettings()
            try await until{model.web.pending.count==1}
            try check(main.frontCount==1 && main.deminiaturizeCount==1 && other.frontCount==0,"Must target the WebView owner, not a key popover")
            try check(model.selection=="chat:original","Do not select settings before editor consent")
            model.web.finish("opened");try await until{!model.settingsNavigationPending}
            try check(model.selection=="settings" && main.focusCount==1,"ACK should reveal and focus workspace settings")
            try check(model.consumeSettingsSelection("settings") && !model.consumeSettingsSelection("settings"),"Consume successful selection exactly once")
            try check(model.web.syncScripts.isEmpty,"Settings must not call command twice")
            passed += 1
        }
        do {
            let model=Workspace();model.spaceContent=true;model.browser.visible=true;model.openWorkspaceSettings()
            try await until{model.web.pending.count==1};try check(!model.browser.visible,"Reveal compact workspace for draft confirmation")
            model.web.finish("cancelled");try await until{!model.settingsNavigationPending}
            try check(model.selection=="chat:original" && model.spaceContent && model.browser.visible,"Cancellation restores original native location and browser")
            try check(model.web.asyncScripts.count==1 && model.error==nil,"Cancellation is not an error or route")
            passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();model.openWorkspaceSettings()
            try await until{model.web.pending.count==1};try check(model.web.asyncScripts.count==1,"Repeated settings cannot create duplicate leave prompts")
            model.web.finish("unavailable")
            try await until{!model.settingsNavigationPending}
            try check(model.error != nil && model.selection=="chat:original" && model.pendingNavigation==nil,"False ACK must not report successful selection")
            passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();try await until{model.web.pending.count==1};model.web.fail()
            try await until{!model.settingsNavigationPending}
            try check(model.error != nil && model.selection=="chat:original","Editor failure keeps route and releases retry gate")
            model.openWorkspaceSettings();try await until{model.web.pending.count==1};model.web.finish("cancelled")
            try await until{!model.settingsNavigationPending};passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.openWorkspace("overview");model.web.finish("opened")
            try await finishRoute(model,["view":"overview"])
            try check(!model.settingsNavigationPending && model.web.asyncScripts.count==2 && model.selection=="overview","New native destination defeats old leave continuation")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="agent";model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.command("new");model.web.finish("opened");try await finishRoute(model,["view":"agent"])
            try check(model.web.asyncScripts.count==2 && model.selection=="agent" && !model.settingsNavigationPending,"Same-selection new-chat command must defeat pending settings")
            passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.command("theme","dark");try check(model.settingsNavigationPending,"Theme echo must not cancel draft consent")
            model.web.finish("opened")
            try await until{!model.settingsNavigationPending};try check(model.selection=="settings","Theme changes preserve settings navigation")
            passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.openWorkspace("captures");model.web.finish("opened")
            try await finishRoute(model,["view":"captures"])
            try check(model.selection=="captures" && !model.settingsNavigationPending,"A late settings ACK cannot override a newer route")
            passed += 1
        }
        do {
            let model=Workspace();model.ready=false;model.openWorkspaceSettings();try check(!model.settingsNavigationPending,"Unready workspace cannot route")
            model.ready=true;model.snapshot=TestSnapshot(modalOpen:true);model.openWorkspaceSettings();try check(!model.settingsNavigationPending,"Web modal must remain in control")
            model.snapshot=nil;model.web.window?.attachedSheet=TestWindow();model.openWorkspaceSettings();try check(!model.settingsNavigationPending,"Native sheet must remain in control")
            try check(model.web.asyncScripts.isEmpty,"Blocked entry must not run editor hooks")
            passed += 1
        }
        do {
            let model=Workspace();model.web.window=nil;let owner=TestWindow();model.glassHost=TestHost(owner);model.openWorkspaceSettings()
            try await until{model.web.pending.count==1};model.web.finish("cancelled");try await until{!model.settingsNavigationPending}
            try check(owner.frontCount==1,"Fallback must remain the known WebGlassHost owner")
            passed += 1
        }
        do {
            let model=Workspace();model.browser.visible=true;model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.browser.tabs=[];model.web.finish("cancelled");try await until{!model.settingsNavigationPending}
            try check(!model.browser.visible,"Cancellation cannot resurrect an empty closed browser")
            passed += 1
        }
        do {
            let model=Workspace();model.openWorkspaceSettings();try await until{model.web.pending.count==1}
            model.browser.visible=true;model.settingsBrowserVisibilityChanged(true);model.web.finish("opened")
            for _ in 0..<50 {await Task.yield()}
            try check(!model.settingsNavigationPending && model.selection=="chat:original" && model.browser.visible,"New browser takeover invalidates hidden draft prompt")
            try check(model.web.syncScripts.contains("delete window.__aibroSettingsRequest"),"Native cancellation must reach the live JS request")
            passed += 1
        }
        do {
            let model=Workspace();model.web.window=nil;model.openWorkspaceSettings()
            try check(!model.settingsNavigationPending && model.web.asyncScripts.isEmpty,"An unattached workspace cannot navigate invisibly")
            passed += 1
        }
        do {
            let model=Workspace();model.web.holdEvaluations=true
            model.command("search");let old=model.web.evaluations.removeFirst()
            model.navigate("overview");old(true,nil)
            try check(model.web.window!.focusCount==0,"Late search completion cannot focus a newer native destination")
            try await finishRoute(model,["view":"overview"])
            passed += 1
        }
        do {
            let model=Workspace();model.glassHost=TestHost(model.web.window);model.web.holdEvaluations=true
            model.command("search");model.web.evaluations.removeFirst()(true,nil)
            try check(model.web.window!.focusCount==1,"Explicit current search delegates focus to the retained native host")
            passed += 1
        }
        do {
            let model=Workspace();model.browser.visible=true
            model.command("search");try check(!model.compactWorkspacePreferred,"Opening search alone must not replace compact browser intent")
            model.navigate("overview");try check(model.compactWorkspacePreferred && model.browser.visible,"Native destination must reveal workspace without closing browser")
            model.settingsBrowserVisibilityChanged(true);try check(!model.compactWorkspacePreferred,"Explicit browser return clears compact workspace preference")
            model.command("new");try check(model.compactWorkspacePreferred,"Same-route new conversation reveals compact workspace")
            try await finishRoute(model,["view":"agent","conversationId":"new"])
            passed += 1
        }
        do {
            let model=Workspace();model.spaceContent=true
            model.openProject("project:2026:notes",section:"knowledge")
            try await until{model.web.pending.count==1}
            let command=model.web.asyncArguments[0]["command"] as? [String:String]
            try check(command?["id"]=="project:2026:notes" && command?["section"]=="knowledge","ID punctuation must stay separate from the requested project section")
            try check(model.selection=="chat:original" && model.pendingProjectSection=="knowledge","Original location stays visible until the project section is confirmed")
            model.web.finish(["accepted":true,"destination":["view":"project","projectId":"project:2026:notes","projectSection":"knowledge"]]);try await until{model.projectNavigationRequest==nil}
            try check(model.error==nil && model.selection=="project:project:2026:notes","Successful async route must preserve the selected project")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="daily";model.spaceContent=true
            model.openProject("blocked");try await until{model.web.pending.count==1};model.web.finish(false)
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="daily" && model.spaceContent && model.pendingNavigation==nil && model.error==nil,"Cancelled draft flush restores original route and retained space without error")
            try check(model.commandSearchSelection==nil,"Unchanged original location needs no duplicate route")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.openWorkspace("overview");model.web.finish(false)
            try await finishRoute(model,["view":"overview"])
            try check(model.selection=="overview" && model.pendingNavigation==nil && model.error==nil,"Stale cancellation cannot undo a newer native-only route")
            try check((model.web.asyncArguments.last?["command"] as? [String:String])?["type"]=="workspace-view","Native-only route must use the shared guarded bridge intent")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("first");try await until{model.web.pending.count==1}
            model.openProject("second",section:"outputs");try await until{model.web.pending.count==2}
            model.web.finish(false);for _ in 0..<50 {await Task.yield()}
            try check(model.selection=="chat:original" && model.projectNavigationRequest != nil,"Earlier false ACK cannot interrupt the newer pending project")
            model.web.finish(["accepted":true,"destination":["view":"project","projectId":"second"]]);try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="project:second" && model.error==nil,"Second route remains selected after its ACK")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("failure");try await until{model.web.pending.count==1};model.web.fail()
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="chat:original" && model.error != nil && model.pendingNavigation==nil,"A failed project guard must restore the original route and release pending navigation")
            passed += 1
        }
        do {
            let model=Workspace();model.navigationReturnSelection=model.selection;model.selection="chat:next";model.command("conversation","next")
            try await until{model.web.pending.count==1};model.command("theme","dark");model.web.finish(false)
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="chat:original" && model.error==nil,"Conversation draft cancellation uses the same async guard and survives a theme echo")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("not-dispatched")
            model.openWorkspace("overview")
            try await finishRoute(model,["view":"overview"])
            try check(model.web.asyncScripts.count==1 && model.selection=="overview","A newer native-only intent before Task dispatch must prevent the old project command from starting")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.openWorkspaceSettings();try await until{model.web.pending.count==2}
            model.web.finish(false);for _ in 0..<50 {await Task.yield()}
            try check(model.settingsNavigationPending && model.error==nil,"Older project false ACK must not cancel current settings")
            model.web.finish("opened");try await until{!model.settingsNavigationPending}
            try check(model.selection=="settings" && model.error==nil,"New settings destination supersedes a waiting project guard")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("first");try await until{model.web.pending.count==1}
            model.openProject("second");try await until{model.web.pending.count==2}
            model.web.finish(false);for _ in 0..<50 {await Task.yield()};model.web.finish(false)
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="chat:original" && model.pendingNavigation==nil,"When both rapid project entries fail, return to the committed route, not the never-opened first project")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.command("search");model.web.finish(false);for _ in 0..<50 {await Task.yield()}
            try check(model.selection=="chat:original" && model.pendingNavigation==nil && model.error==nil,"Search must not leave a cancelled optimistic project selected")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.openWorkspaceSettings();try await until{model.web.pending.count==2}
            model.web.finish(false);for _ in 0..<50 {await Task.yield()};model.web.finish("cancelled")
            try await until{!model.settingsNavigationPending}
            try check(model.selection=="chat:original" && model.pendingNavigation==nil && model.error==nil,"Cancelling settings after superseding a pending project returns to the committed chat")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.web.finish(["accepted":false,"supersededByPage":true,"destination":["view":"project","projectId":"actual:page","projectSection":"knowledge"]])
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="project:actual:page" && model.commandSearchSelection=="project:actual:page" && model.pendingNavigation==nil,"Superseding in-page project is authoritative and must not roll back or re-dispatch its guard")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="overview";model.openProject("waiting");try await until{model.web.pending.count==1}
            model.web.finish(["accepted":false,"supersededByPage":true,"destination":["view":"courses","conversationId":"ignored","spaceSection":"knowledge"]])
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="courses" && model.spaceContent,"Superseding in-page workspace content must remain visible above its native dashboard")
            passed += 1
        }
        do {
            let model=Workspace();model.openProject("waiting");try await until{model.web.pending.count==1}
            model.web.finish(["accepted":false,"supersededByPage":false,"destination":["view":"daily"]])
            try await until{model.projectNavigationRequest==nil}
            try check(model.selection=="chat:original" && model.error==nil,"An ordinary false ACK still restores its original native location")
            try check(!model.adoptReportedWorkspaceDestination(["view":"unknown"]) && !model.adoptReportedWorkspaceDestination(["view":"project","projectId":""]),"Reported routes must satisfy the native route allowlist")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="overview"
            model.command("note","other-project-note")
            let payload=try lastCommand(model)
            try check(payload["type"] as? String == "note" && payload["id"] as? String == "other-project-note","Direct document command preserves target")
            try check((payload["origin"] as? [String:String]) == ["view":"overview"] && model.spaceContent,"Direct note command serializes visible native origin and reveals its content")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="project:confirmed";model.confirmedProjectSections["confirmed"]="outputs"
            model.openProject("waiting");try await until{model.web.pending.count==1}
            model.selection="project:optimistic"
            model.command("import","source")
            let payload=try lastCommand(model)
            try check((payload["origin"] as? [String:String]) == ["view":"project","projectId":"confirmed","section":"outputs"],"Direct import snapshots committed origin before pending route cancellation")
            try check(model.selection=="project:confirmed" && model.spaceContent && model.projectNavigationRequest==nil,"Cancellation restores identity while preserving revealed document visibility")
            model.web.finish(false);for _ in 0..<50 {await Task.yield()}
            try check(model.selection=="project:confirmed" && model.spaceContent,"Late cancelled route cannot conceal the document")
            passed += 1
        }
        do {
            let model=Workspace();model.selection="agenda";model.web.holdEvaluations=true
            model.command("task","rejected")
            try check(model.spaceContent && model.returningFromModal,"Task command reveals its pending modal")
            model.web.evaluations.removeFirst()(false,nil)
            try check(!model.spaceContent && !model.returningFromModal && model.error != nil && model.selection=="agenda","Rejected task restores original native surface")
            model.error=nil;model.command("task","late")
            let late=model.web.evaluations.removeFirst();model.command("note","newer")
            late(false,nil)
            try check(model.spaceContent && model.error==nil,"Stale task rejection cannot hide a newer document")
            passed += 1
        }
        do {
            let model=Workspace();let task=Task {await model.navigateWorkspace("agenda",requestId:"task-return-1")}
            try await until{model.web.pending.count==1}
            let payload=model.web.asyncArguments.last?["command"] as? [String:Any]
            try check(payload?["requestId"] as? String == "task-return-1","Native workspace return forwards the request identity unchanged")
            model.web.finish(["accepted":true,"destination":["view":"agenda"]])
            let accepted=await task.value;try check(accepted && model.selection=="agenda","Request identity does not change ACK semantics")
            passed += 1
        }
        print("PASS: \(passed) native settings navigation scenarios; production Swift methods, no windows or user data")
    }
}
