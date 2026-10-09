import SwiftUI
import AppKit
import WebKit
import Combine

struct Item: Identifiable, Decodable, Hashable { let id: String; let title: String; let workspace: String }
private struct NativeSnapshotStamp:Decodable {let version:Int;let nonce:String;let sequence:Int;let type:String}
struct Snapshot: Decodable { let comparisonOpen:Bool?; let activityCenterOpen:Bool?;let activityUnread:Int?;let commandSearchOpen:Bool?;let commandSearchNavigationVersion:Int?;let tourOpen:Bool?; let conversationLibrary:[ConversationEntry]?;let conversationFolders:[ConversationFolder]?; let tasks:[ContentRecord]?;let documents:[ContentRecord]?;let modalOpen:Bool?;let taskOpen:Bool?;let taskEntry:[String:String]?;let readingOpen:Bool?;let readerAvailable:Bool?; let projects: [Item]; let conversations: [Item]; let taskCount: Int; let noteCount: Int; let sourceCount: Int; let view: String; let conversationId: String; let busy: Bool; let projectId: String?;let projectSection:String?;let spaceSection:String?;let privateMode:Bool?;let quickWorkbench:NativeQuickWorkbenchSnapshot? }

@MainActor final class Workspace: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    @Published var conversationProjectFilter=""
    @Published var snapshot: Snapshot?
    @Published var selection: String? = "overview"
    @Published var error: String?
    @Published var ready = false
    @Published var spaceContent = false
    @Published var spaceSections:[String:String]=[:]
    private var confirmedProjectSections:[String:String]=[:]
    private var restoringWorkspaceLocation=false
    @Published var compactWorkspacePreferred=false
    let agenda = AgendaStore()
    let agendaAgent = AgendaAgentController()
    let browser = NativeBrowser()
    @Published var agendaSyncConflicts:[AgendaSyncConflict]=[]
    @Published var agendaSyncStatus=""
    var agendaSyncRunning=false
    var agendaSyncTimer:Timer?
    @Published var agendaDraft:AgendaEvent?
    @Published var agendaCreationReview:AgendaCreationReview?
    @Published var agendaLinkedDetail:AgendaOccurrence?
    var returningFromModal = false
    var sawModal = false
    var historyReturnSelection:String?
    var historyWasOpen=false
    var pendingNavigation:(view:String,id:String?)?
    var pendingProjectSection:String?
    var navigationReturnSelection:String?
    var navigationReturnSpaceContent=false
    private var projectNavigationRequest:UUID?
    @Published var commandSearchFollowup=false
    private var lastCommandSearchNavigation=0
    private var commandSearchFollowupOrigin:(view:String,project:String?,conversation:String)?
    private var commandSearchSelection:String?
    @Published private(set) var settingsNavigationPending=false
    private var settingsNavigationRequest:UUID?
    private var settingsSelectionPending=false
    @Published var appearance = "system"
    var glassHost:WebGlassHost?
    private var webFocusGeneration=0
    let web: WKWebView
    var origin: URL?
    let nativeNotificationToken = UUID().uuidString + UUID().uuidString
    var backend: Process?
    var backendLifetime: Pipe?
    var log: FileHandle?
    let root: URL
    let dataDirectory:URL
    let production:Bool
    var desktop:NativeDesktop?
    var sessionLock:Int32 = -1
    private var startupBegan = Date()
    @Published private(set) var startupFailure:String?
    private var startupStage="not_started"
    private var startupStatus="loading"
    private var startupEvents:[[String:Any]]=[]
    private var startupWatchdog:Task<Void,Never>?
    private var snapshotNavigationGeneration=0
    private var snapshotNavigationCommitted=false
    private var snapshotDocumentNonce:String?
    private var snapshotAcceptedSequence=0
    private var snapshotEverReady=false
    private var startupNavigationFailed=false
    private var startupContentTerminated=false
    private var startupNavigation:WKNavigation?
    private var quickNavigationEvents:[[String:Any]]=[]
    override init() {
        production=Bundle.main.object(forInfoDictionaryKey:"AIBroProduction") as? Bool == true
        root = ProcessInfo.processInfo.environment["AIBRO_SOURCE_ROOT"].map{URL(fileURLWithPath:$0)} ?? (production ? Bundle.main.resourceURL! : URL(fileURLWithPath:FileManager.default.currentDirectoryPath))
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] != nil {
            dataDirectory=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-native-qa-"+UUID().uuidString)
        } else if production {
            dataDirectory=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ai-workstation")
        } else {dataDirectory=root.deletingLastPathComponent().appendingPathComponent(".aibro-native-preview.noindex/workspace")}

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // Workspace links participate in the same keyboard traversal as form
        // controls, independently of the user's Safari browsing preferences.
        config.preferences.tabFocusesLinks = true
        // Every new document starts paused until its actual native host is known.
        config.userContentController.addUserScript(WKUserScript(source:"window.__aibroPresentationVisible=false;window.__aibroSurfaceVisible=false;",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        agendaAgent.configure(store:agenda,environment:{[weak self] in
            let snapshot=self?.snapshot
            return AgendaAgentEnvironment(ready:self?.ready == true,privateMode:snapshot?.privateMode != false,
                projects:(snapshot?.projects ?? []).map{AgendaAgentProject(id:$0.id,title:$0.title,workspace:$0.workspace)},
                documents:(snapshot?.documents ?? []).map{AgendaEditingDocument(id:$0.id,title:$0.title,projectID:$0.projectId,kind:$0.kind)},
                conversationIDs:Set((snapshot?.conversationLibrary ?? []).filter{!$0.archived}.map(\.id)),
                documentWorkspaces:Dictionary(grouping:snapshot?.documents ?? [],by:\.id).compactMapValues{$0.count == 1 ? $0.first?.workspace:nil})
        },present:{[weak self] in
            guard let self,self.agendaDraft == nil,self.agendaCreationReview == nil,!self.agenda.hasUnsavedEditorDrafts else{return false}
            return self.ready && self.snapshot?.modalOpen != true
        })
        // Synthetic QA deliberately uses the browser fallback and never touches saved secrets.
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] == nil || ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_DESKTOP"] == "1" {
            let bridge=NativeDesktop(data:dataDirectory,production:production && ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] == nil);desktop=bridge;bridge.workspace=self;bridge.install(config,root:root)
        }
        if let css = try? String(contentsOf:root.appendingPathComponent("native/Resources/workspace.css"),encoding:.utf8),
           let data=try? JSONSerialization.data(withJSONObject:css,options:.fragmentsAllowed) {
            let js="const nativeStyle=document.createElement('style');nativeStyle.textContent="+String(decoding:data,as:UTF8.self)+";document.head.append(nativeStyle);"
            config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))
        }
        appearance=UserDefaults.standard.string(forKey:"NativePreviewAppearance") ?? "system"
        web.navigationDelegate = self; web.uiDelegate = self
        agenda.onOpen = { [weak self] in self?.selection="agenda" }
        agenda.onChanged = { [weak self] in self?.agendaAgent.refreshContext();self?.requestAgendaSync();self?.web.evaluateJavaScript("document.dispatchEvent(new Event('aibro-agenda-changed'))",completionHandler:nil) }
        config.userContentController.add(self, name: "workspace")
        config.userContentController.add(self,name:"glassRegions")
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/conversation-library.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/agenda-sync.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/agenda-ai.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/quick-capture.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/quick-recording-title.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/quick-links.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/quick-workbench.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/glass-regions.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js = try? String(contentsOf: root.appendingPathComponent("native/Resources/bridge.js"), encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
    }
    // The native surface can be visible while WebKit retains another route.
    // Capture only its committed selection, before revealing or cancelling a route.
    func documentOpenOrigin()->[String:Any]? {
        guard let current=projectNavigationRequest != nil ? navigationReturnSelection:selection else{return nil}
        if current.hasPrefix("project:") {
            let id=String(current.dropFirst(8));guard !id.isEmpty else{return nil}
            let saved=confirmedProjectSections[id] ?? "conversations"
            let section=["conversations","knowledge","outputs","tasks","schedule","overview"].contains(saved) ? saved:"conversations"
            return ["view":"project","projectId":id,"section":section]
        }
        if current.hasPrefix("chat:") {
            let id=String(current.dropFirst(5));guard !id.isEmpty else{return nil}
            return ["view":"agent","conversationId":id]
        }
        let view=current == "dashboard" ? "overview":current == "research-projects" ? "research":current
        if ["daily","courses","research"].contains(view) {
            let saved=current == "research-projects" ? "projects":spaceSections[view] ?? "projects"
            return ["view":view,"section":NativeWorkspaceLocation.validSpaceSection(saved,view:view) ? saved:"projects"]
        }
        guard ["overview","conversations","agenda","wiki","captures","history"].contains(view) else{return nil}
        return ["view":view]
    }
    func reveal(_ type:String,_ id:String="") {
        let origin=["note","import","task"].contains(type) ? documentOpenOrigin():nil
        compactWorkspacePreferred=true
        if type != "task" {spaceContent=true}
        if type == "create-task" || type == "create-project-task" { returningFromModal=true;sawModal=false }
        command(type,id,origin:origin)
    }
    func start() async {
        guard backend == nil else { return }
        do {
            let data = dataDirectory
            try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
            startupBegan=Date();recordStartupStatus("loading",stage:"backend_starting");watchStartup()
            if production,sessionLock<0 {
                sessionLock=Darwin.open(data.appendingPathComponent("native-session.lock").path,O_CREAT|O_RDWR,0o600)
                guard sessionLock >= 0,flock(sessionLock,LOCK_EX|LOCK_NB)==0 else{if sessionLock>=0{Darwin.close(sessionLock);sessionLock = -1};throw AgendaError.message("AI Bro 已在运行，请返回现有窗口。")}
            }
            agenda.load(folder:data,qa:ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] != nil && ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_NOTIFICATIONS"] != "1")
            let process = Process()
            // The native application owns one backend and one data directory.
            let bundled = root.appendingPathComponent(production ? "python/bin/python3":"AI Bro.app/Contents/Resources/python/bin/python3")
            process.executableURL = FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = ["-B", root.appendingPathComponent("app/server.py").path]
            var env = ProcessInfo.processInfo.environment
            env["AI_WORKSTATION_DATA_DIR"] = data.path; env["AI_WORKSTATION_ASSET_DIR"] = root.appendingPathComponent("app").path; env["AI_WORKSTATION_PORT"] = "0"
            // Bundled resources are signed; Python caches must not mutate them.
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["AI_WORKSTATION_PARENT_PIPE"] = "1"
            env["AI_WORKSTATION_NOTIFICATION_DIR"] = NativeQuickExternalNotificationLocation.directory.path
            env["AI_WORKSTATION_NATIVE_NOTIFICATION_TOKEN"] = nativeNotificationToken
            process.environment = env
            let lifetime = Pipe(); process.standardInput = lifetime; backendLifetime = lifetime
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            try process.run(); backend = process
            let output = await Task.detached { () -> String in
                let bytes = pipe.fileHandleForReading.availableData
                return String(decoding: bytes, as: UTF8.self)
            }.value
            guard let text = output.components(separatedBy: "http://127.0.0.1:").last?.split(whereSeparator: { !$0.isNumber }).first,
                  let port = Int(text), port > 0, let url = URL(string:"http://127.0.0.1:\(port)/") else { throw CocoaError(.fileReadCorruptFile) }
            origin = url;recordStartupStatus("loading",stage:"backend_port_received");web.load(URLRequest(url: url))
        } catch { self.error = "无法启动 AI Bro：\(error.localizedDescription)";startupFailure=nativeUI("本地工作区未能启动。", "The local workspace could not start.");recordStartupStatus("failed",stage:"backend_failed",error:error);startupWatchdog?.cancel();backend?.terminate();backend = nil }
    }
    // Local diagnostics contain readiness/counts only, never workspace text or credentials.
    private func recordStartupStatus(_ status:String,stage:String?=nil,reason:String?=nil,error:Error?=nil) {
        startupStatus=status
        if let stage {startupStage=stage}
        var event:[String:Any]=["status":status,"stage":startupStage,"elapsedSeconds":Date().timeIntervalSince(startupBegan),"navigationGeneration":snapshotNavigationGeneration]
        if let reason {event["reason"]=reason}
        if let error {event.merge(diagnosticError(error)){_,new in new}}
        startupEvents.append(event);if startupEvents.count>32 {startupEvents.removeFirst(startupEvents.count-32)}
        var value:[String:Any] = ["status":status,"version":Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "preview","updatedAt":Date().timeIntervalSince1970,"elapsedSeconds":Date().timeIntervalSince(startupBegan)]
        value["stage"]=startupStage;value["events"]=startupEvents
        if let snapshot {value["projects"]=snapshot.projects.count;value["tasks"]=snapshot.tasks?.count ?? 0;value["notes"]=snapshot.noteCount;value["sources"]=snapshot.sourceCount;value["conversations"]=snapshot.conversations.count}
        let path=dataDirectory.appendingPathComponent("native-startup-status.json")
        if let bytes=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) {try? bytes.write(to:path,options:.atomic);try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)}
    }
    private func diagnosticError(_ error:Error)->[String:Any] {
        let value=error as NSError
        let category=value.domain==WKErrorDomain ? "webkit":value.domain==NSURLErrorDomain ? "url":value.domain==NSCocoaErrorDomain ? "cocoa":"other"
        return ["errorCategory":category,"errorCode":value.code]
    }
    func recordQuickNavigation(_ stage:String,reason:String?=nil,error:Error?=nil,accepted:Bool?=nil) {
        var value:[String:Any]=["stage":stage,"at":Date().timeIntervalSince1970]
        if let reason {value["reason"]=reason};if let accepted {value["accepted"]=accepted}
        if let error {value.merge(diagnosticError(error)){_,new in new}}
        quickNavigationEvents.append(value);if quickNavigationEvents.count>24 {quickNavigationEvents.removeFirst(quickNavigationEvents.count-24)}
        let path=dataDirectory.appendingPathComponent("native-navigation-status.json")
        if let bytes=try? JSONSerialization.data(withJSONObject:["version":1,"events":quickNavigationEvents],options:[.sortedKeys]) {try? bytes.write(to:path,options:.atomic);try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)}
    }
    private func watchStartup() {
        startupWatchdog?.cancel()
        startupWatchdog=Task { @MainActor [weak self] in
            do {try await Task.sleep(nanoseconds:20_000_000_000)}catch{return}
            guard let self,!self.ready else{return}
            self.startupFailure=nativeUI("工作区尚未连接。可以重试连接，当前内容会保留。", "The workspace has not connected. Retry the connection; current content is retained.")
            self.recordStartupStatus("stalled",reason:"readiness_deadline")
        }
    }
    func retryStartupConnection() {
        guard !ready else{return}
        if backend == nil {startupFailure=nil;Task{await start()};return}
        // A user may retry a failed initial navigation. An existing document
        // is never reloaded automatically or just because an ACK was lost.
        if (startupContentTerminated || (!snapshotEverReady && startupNavigationFailed)),let origin {startupFailure=nil;web.load(URLRequest(url:origin));return}
        web.evaluateJavaScript("window.NativeSnapshotChannel?.retry() === true") { [weak self] value,error in
            guard let self,!self.ready else{return}
            if error == nil,(value as? Bool)==true {self.startupFailure=nil;self.recordStartupStatus("loading",stage:"snapshot_retry");self.watchStartup()}
            else {self.startupFailure=nativeUI("工作区仍未就绪，内容已保留。请稍后重试。", "The workspace is not ready yet. Content is retained; try again shortly.");self.recordStartupStatus("stalled",stage:"snapshot_retry_unavailable",error:error)}
        }
    }
    @discardableResult func command(_ type: String, _ id: String = "", section:String?=nil, origin:[String:Any]?=nil,requestId:String?=nil,quickEntry:Bool=false,runId:String?=nil)->Task<Bool,Never>? {
        guard ready else { return nil }
        if type == "view",!["history","settings"].contains(id) {return command("workspace-view",id == "dashboard" ? "overview":id,section:section,requestId:requestId)}
        // Direct commands (including native actions) need the same origin as reveal.
        let documentOrigin=["note","import","task"].contains(type) ? (origin ?? documentOpenOrigin()):nil
        let routeTypes=["project","conversation","workspace-view","new","new-space-conversation","new-project-conversation","new-research-conversation"]
        let isRoute=routeTypes.contains(type)
        if type != "theme" {
            if !isRoute {cancelPendingWorkspaceNavigation(restoreSelection:type != "view")}
            if ["new","new-space-conversation","new-project-conversation","new-research-conversation"].contains(type) {rememberNavigationOrigin(selection)}
            webFocusGeneration+=1;glassHost?.cancelRequestedFocus();cancelSettingsNavigation();projectNavigationRequest=nil
        }
        let focusGeneration=webFocusGeneration
        let taskSurfaceBefore=(spaceContent,returningFromModal,sawModal)
        let quickCompactBefore=compactWorkspacePreferred
        if type == "task" {returningFromModal=true;sawModal=false}
        if ["note","import","task"].contains(type) {spaceContent=true}
        if isRoute || ["view","note","import","reader"].contains(type) {compactWorkspacePreferred=true}
        if type=="view",id != "history" {pendingNavigation=(id,nil)}
        else if type=="workspace-view" {pendingNavigation=(["overview","conversations","agenda"].contains(id) ? "native-pending":id,nil)}
        else if type=="project" {pendingNavigation=("project",id);pendingProjectSection=section}
        else if type=="conversation" {pendingNavigation=("agent",id)}
        else if ["new","new-space-conversation","new-project-conversation","new-research-conversation"].contains(type) {pendingNavigation=("agent",nil)}
        if isRoute {
            let request=UUID(),returnSelection=navigationReturnSelection,returnSpaceContent=navigationReturnSpaceContent
            projectNavigationRequest=request
            var payload:[String:Any] = ["type":type,"id":id]
            if let section {payload["section"]=section}
            if let requestId {payload["requestId"]=requestId}
            if quickEntry {payload["quickEntry"]=true}
            if let runId {payload["runId"]=runId}
            return Task { @MainActor in
                do {
                    guard projectNavigationRequest == request,webFocusGeneration == focusGeneration else{return false}
                    let result=try await web.callAsyncJavaScript("return await window.NativeShell?.perform(command);",arguments:["command":payload],in:nil,contentWorld:.page)
                    guard projectNavigationRequest == request,webFocusGeneration == focusGeneration else{return false}
                    projectNavigationRequest=nil;pendingNavigation=nil;pendingProjectSection=nil
                    let acknowledgment=result as? [String:Any]
                    let accepted=(acknowledgment?["accepted"] as? Bool) ?? ((result as? Bool) == true)
                    if accepted {
                        if let destination=acknowledgment?["destination"] as? [String:Any] {_ = adoptReportedWorkspaceDestination(destination)}
                        persistConfirmedLocation()
                        return true
                    }
                    if acknowledgment?["supersededByPage"] as? Bool == true,
                       let destination=acknowledgment?["destination"] as? [String:Any],
                       adoptReportedWorkspaceDestination(destination) {persistConfirmedLocation();return false}
                    if let returnSelection {
                        commandSearchSelection=selection == returnSelection ? nil:returnSelection
                        selection=returnSelection;spaceContent=returnSpaceContent
                    }
                } catch {
                    guard projectNavigationRequest == request,webFocusGeneration == focusGeneration else{return false}
                    projectNavigationRequest=nil;pendingNavigation=nil;pendingProjectSection=nil
                    if let returnSelection {commandSearchSelection=selection == returnSelection ? nil:returnSelection;selection=returnSelection;spaceContent=returnSpaceContent}
                    self.error=nativeUI("无法打开该位置，当前文档已保留。请重试。", "This destination could not open. Your current document is retained. Try again.")
                }
                return false
            }
        }
        // Floating document opens need their real acknowledgment. Keep ordinary
        // modal commands' existing lifecycle; never count nil as quick success.
        if ["task","note","import"].contains(type),quickEntry {
            var payload:[String:Any] = ["type":type,"id":id]
            if let documentOrigin {payload["origin"]=documentOrigin}
            if quickEntry {payload["quickEntry"]=true}
            return Task { @MainActor in
                do {
                    guard webFocusGeneration == focusGeneration else{recordQuickNavigation("renderer_cancelled",reason:"generation_changed_before_call");return false}
                    let result=try await web.callAsyncJavaScript("return await window.NativeShell?.performWithDiagnostics(command);",arguments:["command":payload],in:nil,contentWorld:.page)
                    guard webFocusGeneration == focusGeneration else{recordQuickNavigation("renderer_cancelled",reason:"generation_changed_after_call");return false}
                    let receipt=result as? [String:Any]
                    let accepted=(receipt?["accepted"] as? Bool)==true
                    let known=["opened","renderer_rejected","workspace_hydrating","unsupported_command","private_mode","web_modal","access_unavailable","record_ambiguous","record_unavailable","record_private","task_unavailable","task_editor_rejected","renderer_exception"]
                    let reason=receipt?["reason"] as? String ?? "missing_receipt"
                    let declaredKind=receipt?["ackKind"] as? String ?? "object"
                    let ackKind=receipt == nil ? "missing":(["boolean","empty","object","other"].contains(declaredKind) ? declaredKind:"invalid")
                    recordQuickNavigation("renderer_ack_"+ackKind,reason:known.contains(reason) ? reason:"invalid_receipt",accepted:accepted)
                    if let category=receipt?["exceptionCategory"] as? String,["TypeError","ReferenceError","SyntaxError","RangeError","DOMException","AbortError","Error"].contains(category) {recordQuickNavigation("renderer_exception",reason:category)}
                    if accepted {compactWorkspacePreferred=true;return true}
                } catch {
                    recordQuickNavigation("renderer_call_failed",reason:webFocusGeneration==focusGeneration ? "current_generation":"generation_changed",error:error)
                    guard webFocusGeneration == focusGeneration else{return false}
                }
                (spaceContent,returningFromModal,sawModal)=taskSurfaceBefore
                compactWorkspacePreferred=quickCompactBefore
                self.error=nativeUI("内容尚未打开，当前编辑已保留。请重试。", "The item did not open. Your current edit is retained. Try again.")
                return false
            }
        }
        do {
            var payload:[String:Any] = ["type":type,"id":id]
            if let documentOrigin {payload["origin"]=documentOrigin}
            let bytes = try JSONSerialization.data(withJSONObject:payload)
            let json = String(decoding: bytes, as: UTF8.self)
            web.evaluateJavaScript("window.NativeShell?.perform(\(json))") { [weak self] result, error in
                guard let self,self.webFocusGeneration == focusGeneration else{return}
                if error != nil || (result as? Bool) != true {
                    if type == "task" {(self.spaceContent,self.returningFromModal,self.sawModal)=taskSurfaceBefore}
                    self.error = "操作尚未完成，请等待内容就绪后重试。"
                } else if type == "search" {self.focusWebContent()}
            }
        } catch { self.error = error.localizedDescription }
        return nil
    }
    private func focusWebContent(){
        if let glassHost {glassHost.requestFocusWhenVisible()}
        else {web.window?.makeFirstResponder(web)}
    }
    // Settings is a workspace destination, not a second preferences window.
    // The persistent WebView identifies its owner even while a popover is key.
    func openWorkspaceSettings() {
        guard let mainWindow=web.window ?? glassHost?.window else{return}
        guard mainWindow.attachedSheet == nil else{return}
        if mainWindow.isMiniaturized {mainWindow.deminiaturize(nil)}
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        guard ready,snapshot?.modalOpen != true,settingsNavigationRequest == nil else{return}
        let request=UUID(),browserWasVisible=browser.visible
        cancelPendingWorkspaceNavigation(restoreSelection:true)
        settingsNavigationRequest=request;settingsNavigationPending=true
        browser.visible=false
        Task { @MainActor in
            var opened=false
            defer {
                if settingsNavigationRequest == request {
                    settingsNavigationRequest=nil;settingsNavigationPending=false
                    if !opened,browserWasVisible,!browser.tabs.isEmpty {browser.visible=true}
                }
            }
            do {
                guard settingsNavigationRequest == request else{return}
                // Current readers retain their document when settings takes
                // the workspace. Legacy hosts still need the editor leave gate.
                // Routing and request ownership settle in the same JS turn.
                let result=try await web.callAsyncJavaScript("""
                    window.__aibroSettingsRequest = requestID;
                    try {
                        if (document.querySelector('dialog:modal')) return 'cancelled';
                        const reader = window.ReadingPane;
                        const retainsDocuments = typeof reader?.resume === 'function' && typeof reader?.revealWorkspace === 'function';
                        if (!retainsDocuments) {
                            if (typeof beforePreviewLeave !== 'function') throw Error('Workspace is not ready');
                            if (!(await beforePreviewLeave())) return 'cancelled';
                        }
                        if (window.__aibroSettingsRequest !== requestID || document.querySelector('dialog:modal')) return 'cancelled';
                        return window.NativeShell?.perform({type:'view',id:'settings'}) === true ? 'opened' : 'unavailable';
                    } finally {
                        if (window.__aibroSettingsRequest === requestID) delete window.__aibroSettingsRequest;
                    }
                    """,arguments:["requestID":request.uuidString],in:nil,contentWorld:.page)
                guard settingsNavigationRequest == request else{return}
                if result as? String == "cancelled" {return}
                guard result as? String == "opened" else {throw CocoaError(.featureUnsupported)}
                opened=true;pendingNavigation=nil;spaceContent=false;browser.visible=false
                settingsSelectionPending=selection != "settings"
                selection="settings"
                persistConfirmedLocation()
                focusWebContent()
            } catch {
                if settingsNavigationRequest == request {
                    self.error=nativeUI("暂时无法打开设置，请等待工作区就绪后重试。", "Settings could not open. Wait for the workspace to be ready, then try again.")
                }
            }
        }
    }
    private func cancelSettingsNavigation() {
        if settingsNavigationRequest != nil,ready {
            web.evaluateJavaScript("delete window.__aibroSettingsRequest",completionHandler:nil)
        }
        settingsNavigationRequest=nil;settingsNavigationPending=false;settingsSelectionPending=false
    }
    func settingsBrowserVisibilityChanged(_ visible:Bool) {
        if visible {compactWorkspacePreferred=false;webFocusGeneration+=1;glassHost?.cancelRequestedFocus()}
        if visible,settingsNavigationPending {cancelSettingsNavigation()}
    }
    func consumeSettingsSelection(_ value:String?)->Bool {
        guard settingsSelectionPending,value == "settings" else{return false}
        settingsSelectionPending=false;return true
    }
    func draftAgenda(_ id:String) throws {
        guard ready,agendaDraft == nil,let document=snapshot?.documents?.first(where:{$0.id==id && $0.kind=="note"}) else {throw AgendaError.message("来源笔记不可用，或已有日程正在编辑。")}
        var event=AgendaEvent();event.title=document.title;event.documentID=document.id;event.documentKind="note";event.projectID=document.projectId;event.source="随记";event.reminderMinutes=nil
        selection="agenda";agendaDraft=event
    }
    func proposedAgendaEvent(_ proposal:[String:Any]) throws -> AgendaEvent {
        guard ready,let id=proposal["id"] as? String,id.hasPrefix("agenda_"),id.count<200,
              let title=proposal["title"] as? String,title.count<=200,let start=proposal["start"] as? Double,let end=proposal["end"] as? Double,start.isFinite,end.isFinite,
              let timeZone=proposal["timeZone"] as? String else{throw AgendaError.message("日程提案或来源不可用。")}
        let documentID=proposal["documentID"] as? String ?? ""
        let document=snapshot?.documents?.first(where:{$0.id==documentID && $0.kind=="note"})
        let messageSource=proposal["sourceMessageId"] as? String
        guard document != nil || (messageSource?.isEmpty == false && (proposal["conversationId"] as? String)?.isEmpty == false) else {throw AgendaError.message("日程来源不可用。")}
        var event=AgendaEvent();event.id=id;event.title=title;event.start=Date(timeIntervalSince1970:start/1000);event.end=Date(timeIntervalSince1970:end/1000);event.timeZone=timeZone
        event.frequency=proposal["frequency"] as? String ?? "none";event.interval=proposal["interval"] as? Int ?? 1;event.weekdays=proposal["weekdays"] as? [Int] ?? []
        event.count=proposal["count"] as? Int;if let until=proposal["until"] as? Double {event.until=Date(timeIntervalSince1970:until/1000)}
        event.reminderMinutes=proposal["reminderMinutes"] as? Int;event.location=proposal["location"] as? String ?? "";event.details=(proposal["details"] as? String ?? "")+"\n\n来源随记："+(proposal["quote"] as? String ?? "")
        let sourceConversations=(snapshot?.conversationLibrary ?? []).filter{$0.id == proposal["conversationId"] as? String && !$0.archived}
        let conversationProjectID=sourceConversations.count == 1 ? sourceConversations[0].projectId:nil
        event.documentID=documentID;event.documentKind=document == nil ? "":"note"
        event.projectID=try AgendaProposalProject.resolve(proposal,sourceProjectID:document?.projectId,conversationProjectID:conversationProjectID,availableProjectIDs:snapshot?.projects.map(\.id) ?? [])
        event.source=document == nil ? "对话":"随记"
        if document == nil {event.details=(proposal["details"] as? String ?? "")+"\n\n来源消息："+(proposal["quote"] as? String ?? "")}
        if proposal["endEstimated"] as? Bool == true {event.details += "\n结束时间未指定，默认时长1小时，请在保存前确认。"}
        try event.validate();return event
    }
    func reviewAgendaProposal(_ proposal:[String:Any]) throws {
        guard agendaDraft == nil,agendaCreationReview == nil else {throw AgendaError.message("已有日程正在审阅。")}
        let event=try proposedAgendaEvent(proposal)
        if let existing=agenda.events.first(where:{$0.id==event.id}) {
            guard !existing.deleted else{throw AgendaError.message("此日程已取消，原提案不会重新创建。")}
            try openLinkedAgenda(existing.id);return
        }
        agendaDraft=event
    }
    func openLinkedAgenda(_ id:String) throws {
        guard let event=agenda.events.first(where:{$0.id==id && !$0.deleted}) else {throw AgendaError.message("此日程已取消或不可用。")}
        agenda.focusDate=event.start;selection="agenda";agendaLinkedDetail=AgendaOccurrence(event:event,start:event.start,end:event.end)
    }
    func revealInFinder(_ id:String) {
        Task {
            do {
                _ = try await web.callAsyncJavaScript("return await window.FileActions.reveal({type:'import',id});",arguments:["id":id],in:nil,contentWorld:.page)
            } catch {
                let alert=NSAlert();alert.messageText="无法在 Finder 中显示";alert.informativeText="保存的原件可能已不存在或无法访问。请在资料详情中检查原件，必要时重新导入。";alert.alertStyle = .warning
                if let window=web.window {await alert.beginSheetModal(for:window)}
            }
        }
    }
    func setAppearance(_ value:String,force:Bool=false) {
        guard ["system","light","dark"].contains(value),force || appearance != value else { return }
        // Synchronize the fresh WebView once even when the saved value matches.
        // Later identical JS echoes must not enqueue another theme command.
        if appearance != value {
            appearance=value;UserDefaults.standard.set(value,forKey:"NativePreviewAppearance")
        }
        NSApp.appearance=value=="system" ? nil:NSAppearance(named:value=="light" ? .aqua:.darkAqua)
        command("theme",value=="system" ? (NSApp.effectiveAppearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua ? "dark":"light"):value)
    }
    func dismissTransientModelPicker() {
        guard ready else { return }
        // Native dashboards keep WebKit alive but hidden. Dismiss only the
        // composer's transient panel; an in-flight preference save continues.
        web.evaluateJavaScript("window.ConversationModels?.close({restoreFocus:false,force:true})",completionHandler:nil)
    }
    func navigate(_ value: String?) {
        guard let value else { return }
        compactWorkspacePreferred=true
        // Legacy selection bindings are an intent, not a committed location.
        // Keep the original content until its durable route gate succeeds.
        if let origin=navigationReturnSelection,selection != origin {commandSearchSelection=origin;selection=origin}
        if value.hasPrefix("project:") {command("project",String(value.dropFirst(8)))}
        else if value.hasPrefix("chat:") {command("conversation",String(value.dropFirst(5)))}
        else if value == "history" {command("view",value)}
        else if value == "research-projects" {openWorkspace("research",section:"projects")}
        else {openWorkspace(value == "dashboard" ? "overview":value)}
    }
    func publishNativeSpaceNavigation() {
        let view=selection == "wiki" ? "research":(["daily","courses","research"].contains(selection ?? "") ? selection:nil)
        let encoded=view.map{String(decoding:(try? JSONEncoder().encode($0)) ?? Data("null".utf8),as:UTF8.self)} ?? "null"
        web.evaluateJavaScript("window.__aibroSpaceNavigationView=\(encoded);window.dispatchEvent(new Event('aibro-native-space-navigation'));",completionHandler:nil)
    }
    func openWorkspace(_ view:String,section:String?=nil) {
        guard ready else{return}
        rememberNavigationOrigin(selection)
        dismissTransientModelPicker()
        command("workspace-view",view == "dashboard" ? "overview":view,section:section)
    }
    func navigateWorkspace(_ view:String,section:String?=nil,requestId:String?=nil) async -> Bool {
        guard ready else{return false}
        rememberNavigationOrigin(selection)
        dismissTransientModelPicker()
        return await command("workspace-view",view == "dashboard" ? "overview":view,section:section,requestId:requestId)?.value ?? false
    }
    func adoptReportedWorkspaceDestination(_ route:[String:Any])->Bool {
        guard let view=route["view"] as? String else{return false}
        let destination:String
        if view == "project" {
            guard let id=route["projectId"] as? String,!id.isEmpty else{return false}
            destination="project:"+id
            if let section=route["projectSection"] as? String {confirmedProjectSections[id]=section}
        } else if view == "agent" {
            let id=route["conversationId"] as? String ?? ""
            destination=id.isEmpty ? "agent":"chat:"+id
        } else {
            guard ["captures","wiki","dashboard","overview","conversations","agenda","daily","courses","research","trash","settings"].contains(view) else{return false}
            destination=view == "dashboard" ? "overview":view
        }
        commandSearchSelection=selection == destination ? nil:destination
        selection=destination
        if ["daily","courses","research"].contains(view) {
            let section=route["spaceSection"] as? String ?? "projects"
            spaceSections[view]=NativeWorkspaceLocation.validSpaceSection(section,view:view) ? section:"projects"
        }
        spaceContent=["daily","courses","research"].contains(view) && !["projects","overview"].contains(spaceSections[view] ?? "projects")
        return true
    }
    func cancelPendingWorkspaceNavigation(restoreSelection:Bool) {
        guard projectNavigationRequest != nil else{return}
        projectNavigationRequest=nil;pendingNavigation=nil;pendingProjectSection=nil
        web.evaluateJavaScript("window.NativeShell?.cancelNavigation()",completionHandler:nil)
        if restoreSelection,let origin=navigationReturnSelection {
            commandSearchSelection=selection == origin ? nil:origin
            selection=origin;spaceContent=navigationReturnSpaceContent
        }
    }
    func rememberNavigationOrigin(_ value:String?) {
        // Rapid A → B clicks still return to the last committed page when B
        // cannot flush a draft; A may only be an optimistic sidebar selection.
        if projectNavigationRequest == nil || pendingNavigation == nil {
            navigationReturnSelection=value;navigationReturnSpaceContent=spaceContent
        }
    }
    func openProject(_ id:String,section:String?=nil) {
        guard ready else{return}
        rememberNavigationOrigin(selection)
        command("project",id,section:section)
    }
    // Search temporarily reveals WebKit above native dashboards. Only a real
    // activation changes selection; Escape leaves the native location intact.
    private func revealSearchDestination(_ value:Snapshot) {
        compactWorkspacePreferred=true
        cancelPendingWorkspaceNavigation(restoreSelection:false)
        pendingNavigation=nil
        _ = adoptReportedWorkspaceDestination(snapshotDestination(value))
        persistConfirmedLocation()
    }
    func snapshotDestination(_ value:Snapshot)->[String:Any] {
        ["view":value.view,"projectId":value.projectId ?? "","conversationId":value.conversationId,"projectSection":value.projectSection ?? "conversations","spaceSection":value.spaceSection ?? "projects"]
    }
    func persistConfirmedLocation() {
        guard ready,!restoringWorkspaceLocation,projectNavigationRequest == nil,let value=snapshot,value.privateMode != true,
              let location=NativeWorkspaceLocation(selection:selection,projectSection:selection.flatMap{$0.hasPrefix("project:") ? confirmedProjectSections[String($0.dropFirst(8))]:nil} ?? value.projectSection,spaceSections:spaceSections),
              location.available(projects:Set(value.projects.map(\.id)),conversations:Set((value.conversationLibrary ?? []).filter{!$0.archived}.map(\.id))) else{return}
        if let data=try? JSONEncoder().encode(location) {UserDefaults.standard.set(data,forKey:"AIBro.committedLocation."+dataDirectory.standardizedFileURL.path)}
    }
    func restoreCommittedLocation(_ value:Snapshot) {
        let key="AIBro.committedLocation."+dataDirectory.standardizedFileURL.path
        let stored=UserDefaults.standard.data(forKey:key).flatMap{try? JSONDecoder().decode(NativeWorkspaceLocation.self,from:$0)}
        let projects=Set(value.projects.map(\.id)),chats=Set((value.conversationLibrary ?? []).filter{!$0.archived}.map(\.id))
        var location=stored ?? NativeWorkspaceLocation(view:value.view,projectID:value.projectId,conversationID:value.conversationId,section:value.view == "project" ? value.projectSection:value.spaceSection)
        if value.privateMode == true || !location.available(projects:projects,conversations:chats) {location=NativeWorkspaceLocation(view:"overview")}
        restoringWorkspaceLocation=true
        let generation=webFocusGeneration
        Task { @MainActor in
            guard generation==webFocusGeneration else{restoringWorkspaceLocation=false;return}
            let task:Task<Bool,Never>?
            if location.view == "project" {rememberNavigationOrigin(selection);task=command("project",location.projectID ?? "",section:location.section)}
            else if location.view == "agent",let id=location.conversationID,!id.isEmpty {rememberNavigationOrigin(selection);task=command("conversation",id)}
            else {rememberNavigationOrigin(selection);task=command("workspace-view",location.view,section:location.section)}
            let accepted=await task?.value ?? false
            restoringWorkspaceLocation=false
            if accepted {persistConfirmedLocation()}
        }
    }
    func consumeSearchSelection(_ value:String?)->Bool {
        guard let expected=commandSearchSelection else{return false}
        commandSearchSelection=nil;return expected==value
    }
    // Task details and their linked documents share a native entry surface.
    // Closing the modal to read a source is not a return to that surface.
    func reconcileTaskSurface(taskOpen:Bool,modalOpen:Bool,readingOpen:Bool,entry:[String:String]?=nil) {
        if taskOpen {
            // A retained task source can return from another native surface.
            // Use its explicit entry, never the hidden renderer's old route.
            if let entry,let view=entry["view"],!["task","document"].contains(view) {
                let route:[String:Any]=["view":view,"projectId":entry["projectId"] ?? "","conversationId":entry["conversationId"] ?? "","projectSection":entry["section"] ?? "conversations","spaceSection":entry["section"] ?? "projects"]
                _ = adoptReportedWorkspaceDestination(route)
            }
            returningFromModal=true;sawModal=true;spaceContent=true
        }
        guard returningFromModal else{return}
        if modalOpen {sawModal=true}
        else if sawModal {
            if readingOpen {spaceContent=true}
            else {
                returningFromModal=false;sawModal=false
                let view=selection ?? ""
                spaceContent=["daily","courses","research"].contains(view) && !["projects","overview"].contains(spaceSections[view] ?? "projects")
            }
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let origin,message.frameInfo.isMainFrame,message.frameInfo.request.url?.scheme==origin.scheme,message.frameInfo.request.url?.host==origin.host,message.frameInfo.request.url?.port==origin.port else{if message.name=="workspace",!ready{recordStartupStatus("loading",reason:"snapshot_origin_rejected")};return}
        if message.name=="glassRegions" {
            let data=try? JSONSerialization.data(withJSONObject:message.body)
            let regions=data.flatMap{try? JSONDecoder().decode([GlassRegion].self,from:$0)}
            let active=regions.map{glassHost?.apply($0) ?? false} ?? false
            if !active{glassHost?.clear()}
            web.evaluateJavaScript("window.NativeGlassSurface?.acknowledge(\(active ? "true":"false"))",completionHandler:nil)
            return
        }
        receiveWorkspaceSnapshot(message.body)
    }
    private func snapshotFailure(_ reason:String,error:Error?=nil) {
        if !ready {startupFailure=nativeUI("工作区状态尚未同步。可以重试连接，当前内容会保留。", "The workspace state has not synced. Retry the connection; content is retained.")}
        recordStartupStatus(ready ? "degraded":"failed",stage:"snapshot_failed",reason:reason,error:error)
    }
    private func acknowledgeSnapshot(_ stamp:NativeSnapshotStamp) {
        guard let data=try? JSONSerialization.data(withJSONObject:["version":stamp.version,"nonce":stamp.nonce,"sequence":stamp.sequence]),let json=String(data:data,encoding:.utf8) else{return}
        let generation=snapshotNavigationGeneration
        web.evaluateJavaScript("window.NativeSnapshotChannel?.acknowledge(\(json)) === true") { [weak self] accepted,error in
            guard let self,generation==self.snapshotNavigationGeneration else{return}
            if let error {self.recordStartupStatus(self.ready ? "degraded":"loading",stage:"snapshot_ack_delivery_failed",error:error)}
            else if (accepted as? Bool)==true,self.ready,self.startupStage=="snapshot_ack_delivery_failed" {self.recordStartupStatus("ready",stage:"snapshot_ack_restored")}
        }
    }
    private func receiveWorkspaceSnapshot(_ body:Any) {
        guard snapshotNavigationCommitted else{if !ready{recordStartupStatus("loading",reason:"snapshot_before_commit")};return}
        guard let object=body as? [String:Any],let metadata=object["_nativeSnapshot"] as? [String:Any],
              let data=try? JSONSerialization.data(withJSONObject:metadata),
              let stamp=try? JSONDecoder().decode(NativeSnapshotStamp.self,from:data),
              stamp.version==1,UUID(uuidString:stamp.nonce) != nil,stamp.sequence>0,stamp.sequence<=9_007_199_254_740_991,
              ["snapshot","ack-timeout"].contains(stamp.type) else{snapshotFailure("snapshot_protocol_invalid");return}
        let generation=snapshotNavigationGeneration
        let accept={ [weak self] in
            guard let self,generation==self.snapshotNavigationGeneration,self.snapshotNavigationCommitted else{return}
            guard self.snapshotDocumentNonce == nil || self.snapshotDocumentNonce==stamp.nonce else{return}
            self.snapshotDocumentNonce=stamp.nonce
            // A lost ACK must not reapply navigation, sync, notifications or
            // store projections. It receives the same receipt, nothing else.
            if stamp.sequence<=self.snapshotAcceptedSequence {self.acknowledgeSnapshot(stamp);return}
            if stamp.type=="ack-timeout" {self.snapshotFailure("snapshot_ack_timeout");return}
            do {
                let bytes=try JSONSerialization.data(withJSONObject:object)
                let value=try JSONDecoder().decode(Snapshot.self,from:bytes)
                self.snapshotAcceptedSequence=stamp.sequence
                self.applyWorkspaceSnapshot(value)
                self.acknowledgeSnapshot(stamp)
            } catch {self.snapshotFailure(error is DecodingError ? "snapshot_decode_failed":"snapshot_encode_failed",error:error)}
        }
        if let nonce=snapshotDocumentNonce {if nonce==stamp.nonce{accept()};return}
        // Verify the first sender against the *current* document, not a queued
        // message from the previous page at the same localhost origin.
        guard let data=try? JSONSerialization.data(withJSONObject:stamp.nonce,options:.fragmentsAllowed),let json=String(data:data,encoding:.utf8) else{return}
        web.evaluateJavaScript("window.NativeSnapshotChannel?.isCurrent(\(json)) === true") { [weak self] result,error in
            guard let self,generation==self.snapshotNavigationGeneration else{return}
            guard error == nil,(result as? Bool)==true else{if !self.ready{self.recordStartupStatus("loading",reason:"snapshot_document_unconfirmed",error:error)};return}
            accept()
        }
    }
    private func applyWorkspaceSnapshot(_ value:Snapshot) {
        let first = !ready; snapshot = value; ready = true
        if value.privateMode != false {agendaAgent.invalidate()}
        else {agendaAgent.refreshContext()}
        if first {web.evaluateJavaScript("document.dispatchEvent(new Event('aibro-agenda-changed'))",completionHandler:nil)}
        snapshotEverReady=true;startupFailure=nil;startupWatchdog?.cancel()
        if first || startupStatus != "ready" {recordStartupStatus("ready",stage:"snapshot_accepted")}
        if ["daily","courses","research"].contains(value.view),let section=value.spaceSection,NativeWorkspaceLocation.validSpaceSection(section,view:value.view) {spaceSections[value.view]=section}
        let searchVersion=value.commandSearchNavigationVersion ?? 0
        // A reloaded WebView starts a new counter. Its first real activation
        // must route immediately, even after many commands in the old page.
        if searchVersion < lastCommandSearchNavigation {
            lastCommandSearchNavigation=searchVersion
            commandSearchFollowup=false;commandSearchFollowupOrigin=nil
        }
        if searchVersion > lastCommandSearchNavigation {
            lastCommandSearchNavigation=searchVersion
            if value.modalOpen == true {
                commandSearchFollowup=true
                commandSearchFollowupOrigin=(value.view,value.projectId,value.conversationId)
            } else {commandSearchFollowup=false;commandSearchFollowupOrigin=nil;revealSearchDestination(value)}
        } else if commandSearchFollowup,value.modalOpen != true,value.commandSearchOpen != true {
            let moved=commandSearchFollowupOrigin.map{$0.view != value.view || $0.project != value.projectId || $0.conversation != value.conversationId} ?? false
            commandSearchFollowup=false;commandSearchFollowupOrigin=nil
            if moved || value.readingOpen == true {revealSearchDestination(value)}
        }
        agenda.updateTasks(value.tasks ?? [])
        if selection == "history" {
            if value.modalOpen == true {historyWasOpen=true}
            else if historyWasOpen {historyWasOpen=false;selection=historyReturnSelection ?? "overview";historyReturnSelection=nil;pendingNavigation=nil}
        }
        reconcileTaskSurface(taskOpen:value.taskOpen == true,modalOpen:value.modalOpen == true,readingOpen:value.readingOpen == true,entry:projectNavigationRequest == nil ? value.taskEntry:nil)
        if first {
            glassHost?.publishPresentationVisibility(force:true)
            setAppearance(appearance,force:true)
            requestAgendaSync()
            agendaSyncTimer?.invalidate()
            agendaSyncTimer=Timer.scheduledTimer(withTimeInterval:10,repeats:true){[weak self]_ in Task{@MainActor in self?.requestAgendaSync()}}
            restoreCommittedLocation(value)
        }
        // Only an acknowledged command or a committed page route changes
        // native ownership. Initial hydration must not overwrite restoration.
        if !first,!restoringWorkspaceLocation,projectNavigationRequest == nil,
           !["overview","history","agenda","conversations"].contains(selection ?? "") {
            if !(value.readingOpen == true && value.view == selection && ["daily","courses","research"].contains(value.view)) {
                _ = adoptReportedWorkspaceDestination(snapshotDestination(value))
            }
            persistConfirmedLocation()
        }

    }
    func webView(_ webView:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!){
        startupNavigation=navigation
        snapshotNavigationGeneration+=1;snapshotNavigationCommitted=false;snapshotDocumentNonce=nil;snapshotAcceptedSequence=0;startupNavigationFailed=false;startupContentTerminated=false
        glassHost?.beginPresentationNavigation();if !ready{recordStartupStatus("loading",stage:"navigation_started");watchStartup()}
    }
    func webView(_ webView:WKWebView,didCommit navigation:WKNavigation!){guard navigation === startupNavigation else{return};snapshotNavigationCommitted=true;glassHost?.publishPresentationVisibility(force:true);if !ready{recordStartupStatus("loading",stage:"navigation_committed")}}
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){guard navigation === startupNavigation else{return};glassHost?.publishPresentationVisibility(force:true);publishNativeSpaceNavigation();if !ready{recordStartupStatus("loading",stage:"awaiting_workspace_snapshot")}}
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){
        guard navigation === startupNavigation else{return}
        startupNavigationFailed=true;startupWatchdog?.cancel()
        if !ready {startupFailure=nativeUI("工作区页面未能载入。请重试启动。", "The workspace page could not load. Retry startup.")}
        recordStartupStatus(ready ? "degraded":"failed",stage:"navigation_failed",error:error)
    }
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){self.webView(webView,didFail:navigation,withError:error)}
    func webViewWebContentProcessDidTerminate(_ webView:WKWebView){
        startupNavigationFailed=true;startupContentTerminated=true;startupWatchdog?.cancel();snapshotNavigationCommitted=false;ready=false
        startupFailure=nativeUI("工作区页面已停止。重试会重新载入已保存的内容；尚未保存的输入可能无法恢复。", "The workspace page stopped. Retry reloads saved content; unsaved input may not be recoverable.")
        recordStartupStatus("failed",stage:"web_content_terminated")
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == origin?.host && url.port == origin?.port && url.scheme == "http" { decisionHandler(navigationAction.shouldPerformDownload ? .download:.allow) }
        else if url.scheme == "blob" || url.scheme == "about" { decisionHandler(navigationAction.shouldPerformDownload ? .download:.allow) }
        else {
            // Match the document renderer's external-link allowlist. Only an
            // explicit link activation may hand off to the user's default app.
            if navigationAction.navigationType == .linkActivated && ["https","http","mailto","tel"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func selfTest() async {
        guard let destination = ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] else { return }
        do {
            for _ in 0..<200 { if ready { break }; try await Task.sleep(nanoseconds:100_000_000) }
            guard ready else { throw CocoaError(.fileReadUnknown) }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_BROWSER"] == "1" {try await browserQA(destination);return}
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_NOTIFICATIONS"] == "1" {try await reminderQA(destination);return}
            let seed = try String(contentsOf:root.appendingPathComponent("native/Resources/qa-workspace.js"),encoding:.utf8)
            _ = try await web.evaluateJavaScript(seed)
            try await Task.sleep(nanoseconds:800_000_000)
            guard snapshot?.projects.first?.id == "native-qa" else { throw CocoaError(.validationMissingMandatoryProperty) }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_CREATION"] == "1" {try await agendaCreationQA(destination);return}
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_CONTEXT"] == "1" {try await contextQA(destination);return}
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_OVERVIEW"] == "1" {
                let fixture=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-overview.js"),encoding:.utf8)
                _ = try await web.evaluateJavaScript(fixture)
                selection="overview";spaceContent=false
                if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_SURFACE"] == "1" {
                    _ = try await web.evaluateJavaScript("window.WorkstationOnboarding?.close();window.WorkspaceTour?.close();")
                    let tab=NativeBrowserTab(owner:["runId":"surface-qa","conversationId":"surface-qa"],root:root)
                    tab.onChanged={ [weak self] in self?.browser.objectWillChange.send() }
                    browser.tabs=[tab];browser.selectedID=tab.id
                    tab.web.loadHTMLString("<!doctype html><meta charset=utf-8><title>隔离浏览器验收</title><style>body{font:20px system-ui;padding:32px}input{font:inherit}</style><h1>隔离浏览器验收</h1><label>保留网页输入 <input aria-label='保留网页输入'></label>",baseURL:nil)
                    browser.visible=true
                }
                try "READY: synthetic overview".write(toFile:destination,atomically:true,encoding:.utf8)
                return
            }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_TIMELINE"] == "1" {
                selection="project:qa-trip"; spaceContent=false
                if let window=web.window {
                    let application=NSRunningApplication.current
                    let report:[String:Any] = ["bundle":Bundle.main.bundleIdentifier ?? "", "applicationBundle":application.bundleURL?.path ?? "", "localizedName":application.localizedName ?? "", "activationPolicy":application.activationPolicy.rawValue, "finishedLaunching":application.isFinishedLaunching, "windowNumber":window.windowNumber, "windowLevel":window.level.rawValue, "sharingType":window.sharingType.rawValue, "visible":window.isVisible, "onActiveSpace":window.isOnActiveSpace, "alpha":window.alphaValue, "frame":NSStringFromRect(window.frame)]
                    let reportData=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])
                    try reportData.write(to:URL(fileURLWithPath:destination+"-window.json"),options:.atomic)
                }
                try "READY: synthetic timeline".write(toFile:destination,atomically:true,encoding:.utf8)
                return
            }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_PROJECT_LAYOUT"] == "1" {
                selection="project:qa-trip";command("project","qa-trip")
                try await Task.sleep(nanoseconds:400_000_000)
                spaceContent=true
                let script=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-project-layout.js"),encoding:.utf8)
                guard let window=web.window else {throw CocoaError(.validationMissingMandatoryProperty)}
                var reports:[String]=[]
                for width in [1520,1280,1080] {
                    window.setContentSize(NSSize(width:width,height:850))
                    try await Task.sleep(nanoseconds:500_000_000)
                    let result=try await web.callAsyncJavaScript(script,arguments:[:],in:nil,contentWorld:.page)
                    reports.append(String(describing:result))
                    let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-"+String(width)+".png"];try capture.run();capture.waitUntilExit()
                }
                try reports.joined(separator:"\n").write(toFile:destination+"-layout.txt",atomically:true,encoding:.utf8)
                try "PASS".write(toFile:destination,atomically:true,encoding:.utf8)
                if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" {NSApp.terminate(nil)}
                return
            }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_WORKFLOW"] == "1" {
                let workflow=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-workflow.js"),encoding:.utf8)
                let report=try await web.callAsyncJavaScript(workflow,arguments:["referenceDirectory":ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_REFERENCE_DIR"] ?? ""],in:nil,contentWorld:.page)
                try String(describing:report).write(toFile:destination+"-workflow.txt",atomically:true,encoding:.utf8)
                try await wikiLinkQA(destination)
                try await agendaQA(destination)
                try "PASS".write(toFile:destination,atomically:true,encoding:.utf8)
                if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" {NSApp.terminate(nil)}
                return
            }
            // 本轮 Agent 交互改进的原生验收：独立 fixture，与上面的 QA 流程互斥，
            // 不改变任何既有分支的行为。
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HARNESS_UX"] == "1" {
                let nativeDark = NSApp.effectiveAppearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua
                let webLight = try await web.evaluateJavaScript("document.body.classList.contains('light-mode')") as? Bool
                guard webLight == !nativeDark else {
                    throw NSError(domain:"AIBroAppearanceQA",code:1,userInfo:[NSLocalizedDescriptionKey:"Native and web appearance disagree at startup"])
                }
                let fixture=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-harness-ux.js"),encoding:.utf8)
                let report=try await web.callAsyncJavaScript(fixture,arguments:[:],in:nil,contentWorld:.page)
                try String(describing:report).write(toFile:destination+"-harness-ux.txt",atomically:true,encoding:.utf8)
                try "PASS".write(toFile:destination,atomically:true,encoding:.utf8)
                if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" {NSApp.terminate(nil)}
                return
            }
            selection="project:native-qa";command("project","native-qa")
            try await Task.sleep(nanoseconds:400_000_000)
            guard (try await web.evaluateJavaScript("document.body.dataset.view")) as? String == "project" else { throw CocoaError(.validationMissingMandatoryProperty) }
            selection="settings";command("view","settings");try await Task.sleep(nanoseconds:700_000_000)
            guard selection=="settings", (try await web.evaluateJavaScript("document.body.dataset.view")) as? String == "settings" else {throw CocoaError(.validationMissingMandatoryProperty)}
            let choices=try await web.evaluateJavaScript("document.querySelectorAll('#provider + .native-choices [role=radio]').length")
            guard choices as? Int == 2 else {throw CocoaError(.validationMissingMandatoryProperty)}
            let choiceQA=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-choices.js"),encoding:.utf8)
            let choiceReport=try await web.callAsyncJavaScript(choiceQA,arguments:[:],in:nil,contentWorld:.page)
            try String(describing:choiceReport).write(toFile:destination+"-choices.txt",atomically:true,encoding:.utf8)
            if let window=NSApp.windows.first(where:{$0.isVisible && $0.frame.width>800}) {
                window.setContentSize(NSSize(width:1280,height:850));try await Task.sleep(nanoseconds:500_000_000)
                let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-settings.png"];try capture.run();capture.waitUntilExit()
            }
            command("new");selection="agent";try await Task.sleep(nanoseconds:500_000_000)
            guard (try await web.evaluateJavaScript("document.body.dataset.view")) as? String == "agent" else { throw CocoaError(.validationMissingMandatoryProperty) }
            if #available(macOS 26.0,*),!NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency {
                guard glassHost?.materialCount == 1,(try await web.evaluateJavaScript("document.querySelector('#composer').dataset.appkitGlass")) as? String == "composer" else {throw CocoaError(.validationMissingMandatoryProperty)}
                for mode in ["light","dark"] {
                    setAppearance(mode);try await Task.sleep(nanoseconds:500_000_000)
                    if let window=NSApp.windows.first(where:{$0.isVisible && $0.frame.width>800}) {
                        let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-composer-"+mode+".png"];try capture.run();capture.waitUntilExit()
                    }
                }
            }
            if #available(macOS 26.0,*),!NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency {
                command("note","qa-note-trip");try await Task.sleep(nanoseconds:700_000_000)
                guard glassHost?.materialCount == 2,(try await web.evaluateJavaScript("document.querySelector('.reading-toolbar').dataset.appkitGlass")) as? String == "reader" else {throw CocoaError(.validationMissingMandatoryProperty)}
                let readerLayout = try await web.evaluateJavaScript("(() => {const h=document.querySelector('#resize-reader'),r=document.querySelector('.reading-pane');h.focus();return Math.abs(h.getBoundingClientRect().right-r.getBoundingClientRect().left)<1 && getComputedStyle(h).outlineStyle==='none' && getComputedStyle(document.querySelector('#previewTitle')).display==='none';})()")
                let readerGeometry=try await web.evaluateJavaScript("JSON.stringify({handle:document.querySelector('#resize-reader').getBoundingClientRect().toJSON(),reader:document.querySelector('.reading-pane').getBoundingClientRect().toJSON(),outline:getComputedStyle(document.querySelector('#resize-reader')).outlineStyle,title:getComputedStyle(document.querySelector('#previewTitle')).display})")
                try String(describing:readerGeometry).write(toFile:destination+"-reader-geometry.txt",atomically:true,encoding:.utf8)
                guard readerLayout as? Bool == true else {throw CocoaError(.validationMissingMandatoryProperty)}
                command("task","qa-task-0");try await Task.sleep(nanoseconds:700_000_000)
                guard glassHost?.materialCount == 1,(try await web.evaluateJavaScript("document.querySelector('dialog[open][data-appkit-glass]')!==null")) as? Bool == true else {throw CocoaError(.validationMissingMandatoryProperty)}
                for mode in ["light","dark"] {
                    setAppearance(mode);try await Task.sleep(nanoseconds:500_000_000)
                    if let window=NSApp.windows.first(where:{$0.isVisible && $0.frame.width>800}) {
                        let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-modal-"+mode+".png"];try capture.run();capture.waitUntilExit()
                    }
                }
                _ = try await web.evaluateJavaScript("document.querySelectorAll('dialog[open]:not(#previewDialog)').forEach(d=>d.close())")
                try await Task.sleep(nanoseconds:600_000_000)
                guard glassHost?.materialCount == 2 else {throw CocoaError(.validationMissingMandatoryProperty)}
            }
            _ = try await web.callAsyncJavaScript("return await flushWorkspace()", arguments:[:], in:nil, contentWorld:.page)
            command("view","courses");try await Task.sleep(nanoseconds:300_000_000)
            guard (try await web.evaluateJavaScript("document.body.dataset.view")) as? String == "courses" else { throw CocoaError(.validationMissingMandatoryProperty) }
            selection="history";try await Task.sleep(nanoseconds:700_000_000)
            guard snapshot?.modalOpen == true else {throw CocoaError(.validationMissingMandatoryProperty)}
            _ = try await web.evaluateJavaScript("document.querySelector('#runHistoryDialog').close()")
            try await Task.sleep(nanoseconds:800_000_000)
            guard selection != "history" else {throw CocoaError(.validationMissingMandatoryProperty)}
            let denied = try await web.evaluateJavaScript("NativeShell.perform({type:'unknown',id:'x'})")
            guard denied as? Bool == false else { throw CocoaError(.validationMissingMandatoryProperty) }
            web.reload();try await Task.sleep(nanoseconds:1_500_000_000)
            // reload 后页面要重新执行全部脚本，state 才可用。固定 sleep 在脚本数量增加或机器较慢时
            // 会抢在就绪之前查询（表现为 "Can't find variable: state" 的间歇失败），因此改为轮询等待就绪（最多 10 秒）。
            for _ in 0..<100 {
                let alive=(try? await web.evaluateJavaScript("typeof state!=='undefined'&&!!state&&Array.isArray(state.projects)")) as? Bool ?? false
                if alive { break }
                try await Task.sleep(nanoseconds:100_000_000)
            }
            guard (try await web.evaluateJavaScript("state.projects.some(p=>p.id==='native-qa')")) as? Bool == true else { throw CocoaError(.fileReadCorruptFile) }
            selection="overview";try await Task.sleep(nanoseconds:500_000_000)
            if let window = NSApp.windows.first(where:{$0.isVisible && $0.frame.width > 800}) {
                for mode in ["light","dark","narrow"] {
                    setAppearance(mode == "dark" ? "dark":"light")
                    window.setContentSize(NSSize(width:mode == "narrow" ? 950:1280,height:850))
                    try await Task.sleep(nanoseconds:600_000_000)
                    let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-"+mode+".png"];try capture.run();capture.waitUntilExit()
                }
            }
            selection="daily";spaceContent=false;try await Task.sleep(nanoseconds:700_000_000)
            guard snapshot?.tasks?.count == 16, snapshot?.documents?.count == 2 else {throw CocoaError(.validationMissingMandatoryProperty)}
            if let window=NSApp.windows.first(where:{$0.isVisible && $0.frame.width>800}) {
                for mode in ["light","dark","narrow"] {
                    setAppearance(mode == "dark" ? "dark":"light")
                    window.setContentSize(NSSize(width:mode == "narrow" ? 950:1280,height:950))
                    try await Task.sleep(nanoseconds:700_000_000)
                    let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-daily-"+mode+".png"];try capture.run();capture.waitUntilExit()
                }
            }
            try await agendaQA(destination)
            try "Native preview passed: workspace sync, project routing, new conversation, courses navigation, unknown command rejection, save/reload, native composer/reader/modal material and close restoration.\n".write(toFile:destination,atomically:true,encoding:.utf8)
        } catch { try? "FAILED: \(error)".write(toFile:destination,atomically:true,encoding:.utf8) }
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" { NSApp.terminate(nil) }
    }
    func stop() { browser.stopAll();web.configuration.userContentController.removeScriptMessageHandler(forName:"workspace");web.configuration.userContentController.removeScriptMessageHandler(forName:"glassRegions");glassHost?.clear();try? backendLifetime?.fileHandleForWriting.close();backendLifetime=nil }
}
struct WebContent: NSViewRepresentable {
    let model: Workspace
    let surfaceVisible:Bool
    func makeNSView(context: Context) -> WebGlassHost {let host=WebGlassHost(web:model.web);model.glassHost=host;host.setSurfaceVisible(surfaceVisible);return host}
    func updateNSView(_ view: WebGlassHost, context: Context) {view.setSurfaceVisible(surfaceVisible)}
}
// The system owns the glass optics. Content cards deliberately use opaque surfaces.
struct GlassSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), !reduceTransparency {
            content.glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 22))
        } else { content.background(.regularMaterial, in: RoundedRectangle(cornerRadius:22)) }
    }
}
struct MainView: View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model: Workspace
    @ObservedObject var quickEntry: NativeQuickEntryCoordinator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var columns: NavigationSplitViewVisibility = .all
    @State private var conversationTarget:ConversationTarget?
    @State private var expandedProjects:Set<String>=[]
    @State private var archiveOpen=false
    @State private var sidebarFrames:[String:CGRect]=[:]
    @State private var compactBrowserLayout=false
    var body: some View {
        NavigationSplitView(columnVisibility:$columns) {
            VStack(spacing: 0) {
                HStack(spacing:10) {
                    if let icon=NSImage(contentsOf:model.root.appendingPathComponent("app/ai-bro-icon.png")) { Image(nsImage:icon).resizable().frame(width:34,height:34).clipShape(RoundedRectangle(cornerRadius:9)) }
                    VStack(alignment:.leading,spacing:3) { Text("AI Bro").font(.system(size:18,weight:.semibold));Text(nativeUI("知识与行动，在一起", "Knowledge into action")).font(.system(size:10)).foregroundStyle(.secondary) }
                    Spacer()
                }.padding(.horizontal,20).padding(.top,10).padding(.bottom,24)
                Button { model.command("new") } label: {
                    HStack { Image(systemName:"square.and.pencil");Text(nativeUI("新对话", "New chat"));Spacer();Text("⌘ N").font(.caption).foregroundStyle(.secondary) }.padding(.horizontal,14).padding(.vertical,12)
                }.buttonStyle(LiftStyle()).modifier(GlassSurface()).padding(.horizontal,16).padding(.bottom,16).disabled(!model.ready)
                ScrollView {
                    ZStack(alignment:.topLeading) {
                        if let rect=sidebarFrames[sidebarSelection] {
                            SidebarGlassSelection(tint:selectionTint).frame(width:rect.width,height:rect.height)
                                .offset(x:rect.minX,y:rect.minY)
                                .animation(reduceMotion ? nil:.spring(response:0.32,dampingFraction:0.86),value:rect)
                                .allowsHitTesting(false)
                        }
                    VStack(alignment:.leading,spacing:5) {
                        nav(nativeUI("总览", "Overview"),"square.grid.2x2","overview")
                        nav(nativeUI("全部对话", "All chats"),"bubble.left.and.bubble.right","conversations")
                        nav(nativeUI("日程", "Agenda"),"calendar.badge.clock","agenda")
                        nav(nativeUI("随记", "Quick notes"),"note.text","captures")
                        sidebarHeading(nativeUI("空间", "Spaces"))
                        nav(nativeUI("日常", "Daily"),"calendar","daily");nav(nativeUI("课程", "Courses"),"books.vertical","courses");nav(nativeUI("科研", "Research"),"flask","research")
                        if library.contains(where:{$0.isPinned && !$0.archived}) {sidebarHeading(nativeUI("置顶对话", "Pinned chats"));ForEach(library.filter{$0.isPinned && !$0.archived}) {item in conversationRow(item)}}
                        sidebarHeading(nativeUI("项目", "Projects"))
                        ForEach(model.snapshot?.projects ?? []) { item in
                            VStack(alignment:.leading,spacing:3) {
                                HStack(spacing:0) {
                                    Button {withAnimation(reduceMotion ? nil:.easeInOut(duration:0.18)){if expandedProjects.contains(item.id){expandedProjects.remove(item.id)}else{expandedProjects.insert(item.id)}}} label:{Image(systemName:expandedProjects.contains(item.id) ? "chevron.down":"chevron.right").font(.system(size:9)).frame(width:20,height:36)}.buttonStyle(.plain).accessibilityLabel(nativeUI("展开项目会话：", "Expand project chats: ")+item.title)
                                    sidebarButton(item.title,"folder","project:"+item.id,StudioPalette.space(item.workspace))
                                }
                                if expandedProjects.contains(item.id) {
                                    Button {model.command("new-project-conversation",item.id)} label:{Label(nativeUI("新建项目对话", "New project chat"),systemImage:"plus").font(.system(size:11)).padding(9)}.buttonStyle(LiftStyle()).disabled(!model.ready).padding(.leading,24)
                                    ForEach(Array(library.filter{!$0.archived && $0.projectId==item.id}.prefix(5))){chat in conversationRow(chat).padding(.leading,16)}
                                    Button(nativeUI("全部项目会话", "All project chats")){model.openProject(item.id,section:"conversations")}.font(.system(size:10)).buttonStyle(.plain).foregroundStyle(.secondary).padding(.leading,32).padding(.vertical,6)
                                }
                            }
                        }
                        Divider().opacity(0.3).padding(.vertical,10)
                        nav(nativeUI("执行历史", "Run history"),"clock.arrow.circlepath","history");nav(nativeUI("回收站", "Trash"),"trash","trash")
                    }.padding(.horizontal,14).padding(.vertical,8)
                    }.coordinateSpace(name:"native-sidebar")
                        .onPreferenceChange(SidebarBounds.self){if sidebarFrames != $0 {sidebarFrames=$0}}
                }.scrollIndicators(.hidden)
                HStack {
                    Button { model.openWorkspaceSettings() } label: { Label(nativeUI("设置", "Settings"),systemImage:"gearshape") }.buttonStyle(LiftStyle()).disabled(!model.ready || model.snapshot?.modalOpen == true)
                    Spacer()
                    Button { quickEntry.showPanel(screenIntent: .pointerSummon) } label: { Image(systemName:"rectangle.trailinghalf.inset.filled") }
                        .buttonStyle(LiftStyle()).help(nativeUI("灵动岛与快捷入口", "Island & quick entry")).accessibilityLabel(nativeUI("灵动岛与快捷入口", "Island & quick entry"))
                }.padding(20)
            }.navigationSplitViewColumnWidth(min:220,ideal:250,max:330)
        } detail: {
            VStack(spacing:0) {
                if let view=spaceView {SpaceNavigation(model:model,view:view)}
            NativeBrowserWorkspace(browser:model.browser,workspaceOverlay:workspaceOverlay,compactWorkspacePreferred:model.compactWorkspacePreferred,onCompactChange:{compactBrowserLayout=$0}) { workspaceVisible in ZStack {
                WebContent(model:model,surfaceVisible:workspaceVisible && !nativeContent).opacity(nativeContent ? 0 : 1).allowsHitTesting(!nativeContent).accessibilityHidden(nativeContent)
                // Keep the entry view mounted while its task or source is open:
                // calendar mode, filters and scroll remain exactly where left.
                if model.selection == "overview" { Overview(model:model,surfaceVisible:workspaceVisible && !model.spaceContent && !workspaceOverlay).opacity(model.spaceContent || workspaceOverlay ? 0:1).allowsHitTesting(!model.spaceContent && !workspaceOverlay).disabled(model.spaceContent || workspaceOverlay).accessibilityHidden(model.spaceContent || workspaceOverlay) }
                if model.selection == "agenda" { AgendaView(model:model,store:model.agenda).opacity(model.spaceContent || workspaceOverlay ? 0:1).allowsHitTesting(!model.spaceContent && !workspaceOverlay).disabled(model.spaceContent || workspaceOverlay).accessibilityHidden(model.spaceContent || workspaceOverlay) }
                if !workspaceOverlay {
                if model.selection == "conversations",!model.spaceContent {ConversationHub(model:model)}
                if let view=spaceView,let space=spaceName,model.selection != "wiki",!model.spaceContent {
                    if currentSpaceSection == "projects" {SpaceProjects(model:model,view:view,space:space).id(view)}
                    if currentSpaceSection == "overview" {SpaceDashboard(model:model,space:space,projectID:nil).id(space)}
                }
                }
                if !model.ready {
                    VStack(spacing:12) {
                        if let failure=model.startupFailure {Text(failure).multilineTextAlignment(.center).frame(maxWidth:360);Button(nativeUI("重试连接", "Retry connection")){model.retryStartupConnection()}}
                        else {ProgressView(nativeUI("正在启动本地工作区…", "Starting your local workspace…"))}
                    }.padding(24).background(.regularMaterial,in:RoundedRectangle(cornerRadius:16))
                }
            }}}.navigationTitle(title)
            .toolbar {
                if compactBrowserLayout && !model.browser.tabs.isEmpty && (model.compactWorkspacePreferred || !model.browser.visible) { ToolbarItem {Button {model.browser.visible=true} label:{Label(nativeUI("返回浏览器", "Return to browser"),systemImage:"globe")}.help(nativeUI("继续查看已打开的网页", "Continue with your open browser tabs")).disabled(workspaceOverlay)} }
                ToolbarItem {Button {model.command("search")} label:{Label(nativeUI("搜索与命令", "Search and commands"),systemImage:"magnifyingglass")}.help(nativeUI("搜索与命令 ⌘K", "Search and commands ⌘K")).disabled(!model.ready)}
                ToolbarItem {Button {model.command("activity-center")} label:{Label(nativeUI("通知与变化", "Notifications and changes"),systemImage:(model.snapshot?.activityUnread ?? 0)>0 ? "bell.badge":"bell")}.help(nativeUI("通知与变化", "Notifications and changes")).accessibilityValue(String(model.snapshot?.activityUnread ?? 0)).disabled(!model.ready)}
                if !nativeContent && model.snapshot?.readerAvailable == true { ToolbarItem {Button {model.command("reader")} label:{Label(model.snapshot?.readingOpen == true ? nativeUI("收起阅读区", "Hide reading pane"):nativeUI("打开阅读区", "Open reading pane"),systemImage:"sidebar.right")}} }
                ToolbarItem { Button { model.command("new") } label: { Label(nativeUI("新对话", "New chat"),systemImage:"square.and.pencil") }.keyboardShortcut("n").disabled(!model.ready) }
                ToolbarItem { AppearanceControl(model:model) }
                ToolbarItem { Button { model.openWorkspaceSettings() } label: { Label(nativeUI("设置", "Settings"),systemImage:"gearshape") }.disabled(!model.ready || model.snapshot?.modalOpen == true) }
            }
        }.environment(\.locale, NativeL10n.locale).navigationSplitViewStyle(.balanced).tint(.primary).onChange(of:model.selection){old,value in if model.consumeSettingsSelection(value) || model.consumeSearchSelection(value){return};if value == "history"{model.historyReturnSelection=old;model.historyWasOpen=false};model.rememberNavigationOrigin(old);model.spaceContent=false;model.navigate(value)}
        .onChange(of:spaceView){_,_ in model.publishNativeSpaceNavigation()}
        .onAppear{model.publishNativeSpaceNavigation()}
        .onReceive(model.browser.$visible){model.settingsBrowserVisibilityChanged($0)}
        .onChange(of:nativeContent){_,hidden in if hidden {model.dismissTransientModelPicker()}}
        .background(AgendaAgentReviewHost(controller:model.agendaAgent))
        .sheet(item:$model.agendaDraft){event in AgendaEditor(model:model,store:model.agenda,event:event)}
        .sheet(item:$model.agendaCreationReview){review in AgendaCreationReviewView(model:model,store:model.agenda,review:review)}
        .sheet(item:$conversationTarget){target in ConversationManager(model:model,target:target)}
        .sheet(isPresented:$archiveOpen){ConversationArchive(model:model)}
        .alert("AI Bro",isPresented:Binding(get:{model.error != nil},set:{if !$0 {model.error=nil}})){Button(nativeUI("好", "OK"),role:.cancel){model.error=nil}} message:{Text(model.error ?? "")}
        .task { await model.start(); await model.selfTest() }
    }
    var library:[ConversationEntry] {(model.snapshot?.conversationLibrary ?? []).sorted(by:ConversationEntry.ordered)}
    var activeProjectID:String? {
        guard let selection=model.selection else{return nil}
        if selection.hasPrefix("project:"){return String(selection.dropFirst(8))}
        if selection.hasPrefix("chat:"){return library.first{$0.id==String(selection.dropFirst(5))}?.projectId}
        return nil
    }
    var sidebarSelection:String {
        let selection=model.selection ?? ""
        if ["wiki","research-projects"].contains(selection){return "research"}
        if selection.hasPrefix("chat:"),let owner=activeProjectID,!owner.isEmpty {
            let chatID=String(selection.dropFirst(5))
            let pinned=library.contains{$0.id==chatID && $0.isPinned && !$0.archived}
            let visible=expandedProjects.contains(owner) && library.filter{!$0.archived && $0.projectId==owner}.prefix(5).contains{$0.id==chatID}
            if !pinned && !visible{return "project:"+owner}
        }
        return selection
    }
    func conversationRow(_ item:ConversationEntry)->some View {
        HStack(spacing:0) {
            sidebarButton(item.title,item.isPinned ? "pin.fill":"bubble.left","chat:"+item.id,StudioPalette.jade)
            Button{conversationTarget=ConversationTarget(item)}label:{Image(systemName:"ellipsis").frame(width:24,height:28)}.buttonStyle(.plain).foregroundStyle(.secondary).help(nativeUI("管理对话", "Manage chat"))
        }.draggable("aibro-chat:"+item.id).contextMenu {
            Button(item.isPinned ? nativeUI("取消置顶", "Unpin"):nativeUI("置顶对话", "Pin chat")){Task{await model.manageConversation(["kind":"conversation","id":item.id,"action":"pin","pinned":item.isPinned ? "false":"true"])}}
            Button(nativeUI("重命名 / 移动", "Rename / Move")){conversationTarget=ConversationTarget(item)}
            Button(nativeUI("归档", "Archive")){Task{await model.manageConversation(["kind":"conversation","id":item.id,"action":"archive"])}}
            Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){conversationTarget=ConversationTarget(item)}
        }
    }
    var dashboardProject:String? {guard let selection=model.selection,selection.hasPrefix("project:") else{return nil};return String(selection.dropFirst(8))}
    // Project routes use the same web workspace as their chats, so its context and reader stay continuous.
    var spaceView:String? {model.selection == "wiki" ? "research":(["daily","courses","research"].contains(model.selection ?? "") ? model.selection:nil)}
    var spaceName:String? { ["daily":"日常","courses":"课程","research":"科研"][spaceView ?? ""] }
    var currentSpaceSection:String {model.selection == "wiki" ? "wiki":model.spaceSections[spaceView ?? ""] ?? "projects"}
    var workspaceOverlay:Bool {model.settingsNavigationPending || model.snapshot?.modalOpen == true || model.snapshot?.tourOpen == true || model.snapshot?.commandSearchOpen == true || model.snapshot?.activityCenterOpen == true || model.snapshot?.comparisonOpen == true || model.commandSearchFollowup}
    var nativeContent:Bool {if workspaceOverlay {return false};if ["overview","agenda","conversations"].contains(model.selection ?? "") && model.spaceContent {return false};return ["overview","agenda","conversations"].contains(model.selection ?? "") || (spaceName != nil && ["projects","overview"].contains(currentSpaceSection) && !model.spaceContent)}
    var selectionTint:Color {if let space=spaceName{return StudioPalette.space(space)};if let id=activeProjectID,let project=model.snapshot?.projects.first(where:{$0.id==id}){return StudioPalette.space(project.workspace)};return StudioPalette.jade}
    func sidebarHeading(_ title:String)->some View {Text(title).font(.system(size:10,weight:.medium)).foregroundStyle(.tertiary).padding(.horizontal,13).padding(.top,20).padding(.bottom,7)}
    func sidebarButton(_ name:String,_ icon:String,_ tag:String,_ tint:Color)->some View {
        Button {if tag=="conversations"{model.conversationProjectFilter=""};model.compactWorkspacePreferred=true;if tag.hasPrefix("project:"){model.openProject(String(tag.dropFirst(8)))}else if tag.hasPrefix("chat:"){model.rememberNavigationOrigin(model.selection);model.command("conversation",String(tag.dropFirst(5)))}else if tag == "history"{model.selection=tag}else{model.openWorkspace(tag)}} label:{SidebarEntry(title:name,icon:icon,selected:sidebarSelection==tag,tint:tint)}
            .buttonStyle(.plain).accessibilityAddTraits(sidebarSelection==tag ? .isSelected:[])
            .background(GeometryReader{geometry in Color.clear.preference(key:SidebarBounds.self,value:[tag:geometry.frame(in:.named("native-sidebar"))])})
    }
    func nav(_ name:String,_ icon:String,_ tag:String)->some View {sidebarButton(name,icon,tag,StudioPalette.space(name))}
    var title: String { if let value=model.selection,value.hasPrefix("project:") {return model.snapshot?.projects.first{$0.id==String(value.dropFirst(8))}?.title ?? nativeUI("项目", "Projects")};return ["wiki":nativeUI("科研 · 知识库", "Research · Knowledge base"),"research-projects":nativeUI("科研 · 研究项目", "Research · Projects"),"conversations":nativeUI("全部对话", "All chats"),"captures":nativeUI("随记", "Quick notes"),"agenda":nativeUI("日程中心", "Agenda"),"overview":nativeUI("总览", "Overview"),"dashboard":nativeUI("详细仪表板", "Detailed dashboard"),"agent":nativeUI("对话", "Chats"),"daily":nativeUI("日常", "Daily"),"courses":nativeUI("课程", "Courses"),"research":nativeUI("科研", "Research"),"history":nativeUI("执行历史", "Run history"),"trash":nativeUI("回收站", "Trash"),"settings":nativeUI("模型与知识库设置", "Models & knowledge settings")][model.selection ?? ""] ?? nativeUI("对话", "Chats") }
}
struct Overview: View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model: Workspace
    var surfaceVisible=true
    @Environment(\.colorScheme) private var scheme
    var dark:Bool { scheme == .dark }
    var paper:Color { StudioPalette.panel }
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment:.leading,spacing:24) {
                    HStack { Text(nativeUI("你的工作台", "YOUR WORKSPACE")).font(.system(size:11,weight:.medium)).tracking(2).foregroundStyle(.secondary);Spacer();Label(model.snapshot?.busy == true ? nativeUI("正在执行", "Running") : nativeUI("本地已就绪", "Workspace ready"),systemImage:"circle.fill").font(.system(size:10)).foregroundStyle(.secondary) }
                    hero
                    TimelineView(.periodic(from:.now,by:60)) { context in
                        OverviewActions(model:model,now:context.date,compact:geometry.size.width < 950)
                    }
                    Divider().opacity(0.5)
                    HStack(alignment:.top,spacing:28) {
                        VStack(alignment:.leading,spacing:18) {
                            HStack { Text(nativeUI("继续推进", "Pick up where you left off")).font(.system(size:18,weight:.semibold));Spacer() }
                            if model.snapshot?.projects.isEmpty != false {
                                VStack(alignment:.leading,spacing:10) { Image(systemName:"folder.badge.plus").font(.title2);Text(nativeUI("从一个项目开始", "Start with a project")).font(.headline);Text(nativeUI("在对话中描述目标，让资料、笔记与行动有一个共同的归处。", "Describe a goal in chat to bring your sources, notes and next steps together.")).font(.callout).foregroundStyle(.secondary).lineSpacing(5) }.frame(maxWidth:.infinity,alignment:.leading).padding(24).background(paper,in:RoundedRectangle(cornerRadius:18))
                            } else { ForEach((model.snapshot?.projects ?? []).prefix(3)) { item in project(item) } }
                        }.frame(maxWidth:.infinity,alignment:.topLeading)
                        VStack(alignment:.leading,spacing:18) {
                            Text(nativeUI("知识与资料", "Knowledge & sources")).font(.system(size:18,weight:.semibold))
                            Text(nativeUI("\(model.snapshot?.noteCount ?? 0) 篇笔记 · \(model.snapshot?.sourceCount ?? 0) 份原始资料", "\(model.snapshot?.noteCount ?? 0) notes · \(model.snapshot?.sourceCount ?? 0) sources")).font(.system(size:11)).foregroundStyle(.secondary)
                            space(nativeUI("日常", "Daily"),nativeUI("把计划变成下一步行动", "Turn a plan into the next step"),"calendar","daily")
                            space(nativeUI("课程", "Courses"),nativeUI("让每一次学习相互连接", "Connect what you learn"),"books.vertical","courses")
                            space(nativeUI("科研", "Research"),nativeUI("从文献积累到新的发现", "From reading to discovery"),"flask","research")
                        }.frame(width:geometry.size.width < 900 ? 220 : 260,alignment:.topLeading)
                    }
                    HStack { Text(nativeUI("资料有出处 · 知识可编辑 · 行动可追踪", "Linked sources · Editable knowledge · Trackable actions"));Spacer();Text(model.production ? nativeUI("本机工作区", "Local workspace"):nativeUI("独立预览工作区", "Isolated preview workspace")) }.font(.system(size:10)).foregroundStyle(.tertiary).padding(.top,10)
                }.padding(.horizontal,geometry.size.width < 850 ? 30 : 48).padding(.top,22).padding(.bottom,32).frame(maxWidth:1180)
                .frame(maxWidth:.infinity)
            }.background(StudioPalette.canvas)
        }
    }
    var hero:some View { StudioHero(model:model,surfaceVisible:surfaceVisible) }
    func metric(_ title:String,_ value:Int,_ symbol:String)->some View {
        VStack(alignment:.leading,spacing:11) { Label(title,systemImage:symbol).font(.system(size:11)).foregroundStyle(.secondary);Text(value,format:.number).font(.system(size:30,weight:.medium,design:.rounded)).monospacedDigit() }.frame(maxWidth:.infinity,alignment:.leading).padding(.leading,12)
    }
    func project(_ item:Item)->some View {
        Button { model.openProject(item.id) } label: {
            HStack(spacing:14) { Image(systemName:"folder").font(.system(size:20,weight:.light)).frame(width:42,height:46).foregroundStyle(StudioPalette.space(item.workspace)).background(StudioPalette.space(item.workspace).opacity(0.1),in:RoundedRectangle(cornerRadius:12))
                VStack(alignment:.leading,spacing:7) { Text(item.title).font(.system(size:13,weight:.medium)).lineLimit(1);Text(item.workspace.isEmpty ? nativeUI("项目空间", "Project space") : NativeL10n.space(item.workspace)).font(.system(size:10)).foregroundStyle(.secondary) };Spacer();Image(systemName:"chevron.right").font(.system(size:10)).foregroundStyle(.tertiary)
            }.padding(14).background(paper,in:RoundedRectangle(cornerRadius:16))
        }.buttonStyle(LiftStyle()).modifier(HoverLift())
    }
    func space(_ name:String,_ subtitle:String,_ symbol:String,_ id:String)->some View {
        Button {model.selection=id} label:{HStack(spacing:13){Image(systemName:symbol).font(.system(size:18,weight:.light)).foregroundStyle(StudioPalette.space(name)).frame(width:32);VStack(alignment:.leading,spacing:7){Text(name).font(.system(size:13,weight:.medium));Text(subtitle).font(.system(size:10)).foregroundStyle(.secondary)};Spacer()}.padding(.vertical,13)}.buttonStyle(LiftStyle())
    }
}
// Original AI Bro composition; system glass performs optical rendering.
enum StudioPalette {
    // A neutral foundation with separate accent, category and semantic colors.
    private static func adaptive(_ light:UInt32,_ dark:UInt32)->Color {
        Color(nsColor:NSColor(name:nil){appearance in
            let value=appearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua ? dark:light
            return NSColor(srgbRed:CGFloat((value>>16)&255)/255,green:CGFloat((value>>8)&255)/255,blue:CGFloat(value&255)/255,alpha:1)
        })
    }
    static let canvas=adaptive(0xF5FAF8,0x1B1E20)
    static let panel=adaptive(0xFFFFFF,0x25292B)
    static let line=adaptive(0xE1EDE7,0x414A47)
    static let jade=adaptive(0x087F70,0x65D7BB)
    static let amber=adaptive(0xAA7616,0xE7BE59)
    static let sky=adaptive(0x227FA3,0x76CDEB)
    static let iris=adaptive(0x7463C7,0xB9ACF4)
    static let coral=adaptive(0xC25766,0xF39CA3)
    static let neutral=adaptive(0x8BA39A,0x849F91)
    static func space(_ name:String)->Color { ["科研","Research"].contains(name) ? iris : ["课程","Courses"].contains(name) ? sky : jade }
}

struct SidebarBounds:PreferenceKey {
    static var defaultValue:[String:CGRect]=[:]
    static func reduce(value:inout [String:CGRect],nextValue:()->[String:CGRect]) {value.merge(nextValue(),uniquingKeysWith:{$1})}
}
struct SidebarGlassSelection:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    let tint:Color
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body:some View {
        let shape=RoundedRectangle(cornerRadius:13)
        if reduceTransparency {shape.fill(tint.opacity(0.19))}
        else if #available(macOS 26.0,*) {
            shape.fill(tint.opacity(0.10)).glassEffect(.regular.tint(tint.opacity(0.22)),in:shape)
                .overlay(shape.strokeBorder(.white.opacity(0.24),lineWidth:0.5))
        } else {shape.fill(.regularMaterial).overlay(shape.fill(tint.opacity(0.08)))}
    }
}
struct SidebarEntry:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    let title:String;let icon:String;let selected:Bool;let tint:Color
    @State private var hovering=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body:some View {
        HStack(spacing:10){Image(systemName:icon).accessibilityHidden(true).foregroundStyle(selected ? tint:.secondary).frame(width:21);Text(title).font(.system(size:13,weight:selected ? .semibold:.medium)).lineLimit(1);Spacer(minLength:0)}
            .padding(.vertical,12).padding(.horizontal,12).contentShape(RoundedRectangle(cornerRadius:13))
            .background(RoundedRectangle(cornerRadius:13).fill(.primary.opacity(hovering && !selected ? 0.045:0)))
            .animation(reduceMotion ? nil:.easeOut(duration:0.12),value:hovering).onHover{hovering=$0}
    }
}
/// Local transform/opacity animation only; no parent layout or chart-value animation.
struct RowEntrance:ViewModifier {
    var order:Int=0
    @State private var visible=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content:Content)->some View {
        content.opacity(visible || reduceMotion ? 1:0).offset(y:visible || reduceMotion ? 0:7)
            .task {
                guard !visible else{return}
                if reduceMotion {visible=true;return}
                do {try await Task.sleep(nanoseconds:16_000_000)}catch{return}
                guard !Task.isCancelled else{return}
                withAnimation(.timingCurve(0.2,0.75,0.25,1,duration:0.26).delay(Double(min(order,5))*0.045)){visible=true}
            }
    }
}
struct LiftStyle: ButtonStyle {
    func makeBody(configuration:Configuration)->some View { configuration.label.modifier(ControlFeedback(pressed:configuration.isPressed)) }
}
struct ControlFeedback:ViewModifier {
    let pressed:Bool
    @State private var hovering=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var enabled
    func body(content:Content)->some View {
        content.contentShape(RoundedRectangle(cornerRadius:10))
            .background(RoundedRectangle(cornerRadius:10).fill(.primary.opacity(enabled && hovering ? 0.045:0)))
            .scaleEffect(reduceMotion || !enabled ? 1:pressed ? 0.975:1)
            .brightness(enabled && hovering ? 0.025:0)
            .animation(reduceMotion ? nil:.spring(response:0.24,dampingFraction:0.82),value:pressed)
            .animation(reduceMotion ? nil:.easeOut(duration:0.15),value:hovering).onHover{hovering=$0}
    }
}
struct HoverLift:ViewModifier {
    @State private var hovering=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content:Content)->some View {
        content.offset(y:hovering && !reduceMotion ? -3:0)
            .shadow(color:.black.opacity(hovering ? 0.09:0),radius:hovering ? 14:0,y:6)
            .overlay(RoundedRectangle(cornerRadius:16).strokeBorder(.primary.opacity(hovering ? 0.12:0),lineWidth:1).allowsHitTesting(false))
            .animation(reduceMotion ? nil:.spring(response:0.35,dampingFraction:0.8),value:hovering)
            .onHover{hovering=$0}
    }
}
struct OpticalGlass:ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme
    var radius:CGFloat=24
    func body(content:Content)->some View {
        if reduceTransparency { content.background(scheme == .dark ? Color(white:0.17):.white,in:RoundedRectangle(cornerRadius:radius)) }
        else if #available(macOS 26.0,*) { content.glassEffect(.clear.interactive(),in:RoundedRectangle(cornerRadius:radius)) }
        else { content.background(.regularMaterial,in:RoundedRectangle(cornerRadius:radius)) }
    }
}
struct StudioHero:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    var surfaceVisible=true
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Namespace private var glassNamespace
    @State private var expanded=false
    @State private var appeared=false
    @State private var visible=false
    var dark:Bool {scheme == .dark}
    var body:some View {
        GeometryReader { geometry in
            ZStack {
                TimelineView(.animation(minimumInterval:1.0/20,paused:reduceMotion || !visible || !surfaceVisible || scenePhase != .active)) { timeline in
                    ambient(size:geometry.size,time:reduceMotion ? 0:timeline.date.timeIntervalSinceReferenceDate)
                }.allowsHitTesting(false).accessibilityHidden(true)
                HStack(spacing:20) {
                    VStack(alignment:.leading,spacing:15) {
                        Text("KNOWLEDGE → ACTION").font(.system(size:9,weight:.semibold)).tracking(2.5).foregroundStyle(dark ? Color.white.opacity(0.7):StudioPalette.jade)
                        Text(nativeUI("灵感有了，\n下一步交给 AI Bro。", "An idea in mind.\nA next step with AI Bro.")).font(.system(size:geometry.size.width < 800 ? 28:34,weight:.semibold)).tracking(-0.8).lineSpacing(5)
                        Text(nativeUI("连接你的资料、知识与行动。\n从一个想法，走向一个完成。", "Connect your sources, knowledge and actions.\nTake an idea through to completion."))
                            .font(.system(size:12)).foregroundStyle(.secondary).lineSpacing(5)
                        actions.padding(.top,8)
                    }.frame(maxWidth:.infinity,alignment:.leading)
                    constellation.frame(width:geometry.size.width < 800 ? 260:340,height:240)
                }.padding(30)
                .opacity(appeared ? 1:0).offset(y:appeared || reduceMotion ? 0:12)
            }.background(dark ? Color(red:0.10,green:0.15,blue:0.14):Color(red:0.89,green:0.97,blue:0.94))
            .clipShape(RoundedRectangle(cornerRadius:28))
            .overlay(RoundedRectangle(cornerRadius:28).strokeBorder(.white.opacity(dark ? 0.12:0.65),lineWidth:1).allowsHitTesting(false))
        }.frame(height:320)
        .onAppear {visible=true;withAnimation(reduceMotion ? nil:.easeOut(duration:0.5)){appeared=true}}
        .onDisappear{visible=false}
    }
    func ambient(size:CGSize,time:Double)->some View {
        let phase=time/7
        return ZStack {
            Ellipse().fill(StudioPalette.jade.opacity(dark ? 0.4:0.32)).frame(width:430,height:280).blur(radius:36).offset(x:size.width*0.30+sin(phase)*24,y:-40+cos(phase)*24)
            Ellipse().fill(StudioPalette.sky.opacity(dark ? 0.30:0.24)).frame(width:280,height:260).blur(radius:35).offset(x:size.width*0.15+cos(phase)*30,y:100)
            Ellipse().fill(StudioPalette.iris.opacity(dark ? 0.25:0.16)).frame(width:180,height:160).blur(radius:30).offset(x:size.width*0.45,y:90+sin(phase)*28)
            // Fine geometric contours make refraction visible without duplicating any document text.
            ForEach(0..<5) { i in
                Ellipse().stroke(.white.opacity(dark ? 0.09:0.30),lineWidth:1).frame(width:CGFloat(260+i*42),height:CGFloat(140+i*30))
                    .rotationEffect(.degrees(-30+sin(phase)*4)).offset(x:size.width*0.33,y:8)
            }
        }.frame(width:size.width,height:size.height).clipped()
    }
    var constellation:some View {
        GeometryReader { g in
            ZStack {
                Path { p in p.move(to:CGPoint(x:70,y:53));p.addLine(to:CGPoint(x:g.size.width-72,y:118));p.addLine(to:CGPoint(x:92,y:204));p.addLine(to:CGPoint(x:70,y:53)) }
                    .stroke(.primary.opacity(0.13),style:StrokeStyle(lineWidth:1,dash:[3,5]))
                node("科研","flask",count:projectCount("科研")).position(x:70,y:53)
                node("课程","books.vertical",count:projectCount("课程")).position(x:g.size.width-72,y:118)
                node("日常","calendar",count:projectCount("日常")).position(x:92,y:204)
            }
        }
    }
    func projectCount(_ space:String)->Int {model.snapshot?.projects.filter{$0.workspace == space}.count ?? 0}
    func node(_ name:String,_ symbol:String,count:Int)->some View {
        TimelineView(.periodic(from:.now,by:60)) { context in
            let tasks=OverviewTaskSummary(tasks:model.snapshot?.tasks ?? [],now:context.date).space(name)
            Button {model.selection=name == "科研" ? "research":name == "课程" ? "courses":"daily"} label:{
                HStack(spacing:10) {
                    Image(systemName:symbol).font(.system(size:20,weight:.medium)).foregroundStyle(dark ? .white:StudioPalette.space(name))
                    VStack(alignment:.leading,spacing:4) {
                        Text(NativeL10n.space(name)).font(.system(size:13,weight:.semibold))
                        Text(nativeUI("\(tasks.pending.count) 项待办", "\(tasks.pending.count) to do")).font(.system(size:11,weight:.medium))
                        Text(tasks.overdue.isEmpty ? nativeUI("今天 \(tasks.today.count) · \(count) 个项目", "Today \(tasks.today.count) · \(count) projects"):nativeUI("今天 \(tasks.today.count) · 逾期 \(tasks.overdue.count)", "Today \(tasks.today.count) · \(tasks.overdue.count) overdue"))
                            .font(.system(size:9)).foregroundStyle(tasks.overdue.isEmpty ? .secondary:StudioPalette.coral)
                    }
                }.frame(width:146,height:82).background((dark ? Color.black:Color.white).opacity(0.12),in:RoundedRectangle(cornerRadius:24)).modifier(OpticalGlass())
            }.buttonStyle(LiftStyle()).modifier(HoverLift()).accessibilityLabel(nativeUI("打开\(name)空间，\(tasks.pending.count)项待办，今天\(tasks.today.count)项，逾期\(tasks.overdue.count)项", "Open \(NativeL10n.space(name)), \(tasks.pending.count) pending, \(tasks.today.count) today, \(tasks.overdue.count) overdue"))
        }
    }
    @ViewBuilder var actions:some View {
        if #available(macOS 26.0,*) {
            GlassEffectContainer(spacing:16) { HStack(spacing:10) {
                primaryAction.glassEffect(.regular.interactive(),in:.capsule).glassEffectID("primary",in:glassNamespace)
                Button {withAnimation(reduceMotion ? nil:.spring(response:0.45,dampingFraction:0.78)){expanded.toggle()}} label:{Image(systemName:expanded ? "minus":"plus").font(.system(size:16,weight:.medium)).frame(width:44,height:44)}.buttonStyle(LiftStyle()).glassEffect(.regular.interactive(),in:.circle).glassEffectID("expand",in:glassNamespace).help(nativeUI("展开快捷入口", "Show shortcuts")).accessibilityLabel(nativeUI("展开快捷入口", "Show shortcuts")).accessibilityValue(expanded ? nativeUI("已展开", "Expanded"):nativeUI("已收起", "Collapsed"))
                if expanded { Button {model.openWorkspace("conversations")} label:{Image(systemName:"bubble.left.and.bubble.right").frame(width:44,height:44)}.buttonStyle(LiftStyle()).glassEffect(.regular.interactive(),in:.circle).glassEffectID("conversations",in:glassNamespace).help(nativeUI("全部对话", "All chats")).accessibilityLabel(nativeUI("全部对话", "All chats")) }
            }}
        } else {primaryAction.modifier(GlassSurface())}
    }
    var primaryAction:some View {
        Button {model.command("new")} label:{Label(nativeUI("开始对话", "Start a chat"),systemImage:"sparkle").font(.system(size:12,weight:.semibold)).padding(.horizontal,18).frame(height:44)}.buttonStyle(LiftStyle()).disabled(!model.ready)
    }
}

struct AppearanceChoices:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var options:[(String,String,String)] {[("system",nativeUI("跟随系统", "System"),"desktopcomputer"),("light",nativeUI("浅色", "Light"),"sun.max"),("dark",nativeUI("深色", "Dark"),"moon.stars")]}
    var body:some View {
        HStack(spacing:10){ForEach(options,id:\.0){key,title,icon in
            Button{withAnimation(reduceMotion ? nil:.easeInOut(duration:0.2)){model.setAppearance(key)}} label:{
                VStack(spacing:12){Image(systemName:icon).font(.system(size:23,weight:.light)).frame(height:29).foregroundStyle(model.appearance==key ? StudioPalette.jade:.secondary);Text(title).font(.system(size:11,weight:.medium));Image(systemName:model.appearance==key ? "checkmark.circle.fill":"circle").font(.system(size:12)).foregroundStyle(model.appearance==key ? StudioPalette.jade:.secondary.opacity(0.45))}
                    .frame(maxWidth:.infinity).padding(.vertical,17)
            }.buttonStyle(LiftStyle()).modifier(GlassSurface()).overlay(RoundedRectangle(cornerRadius:22).strokeBorder(StudioPalette.jade.opacity(model.appearance==key ? 0.55:0),lineWidth:1).allowsHitTesting(false)).accessibilityLabel(title).accessibilityValue(model.appearance==key ? nativeUI("已选择", "Selected"):nativeUI("未选择", "Not selected"))
        }}
    }
}
struct AppearanceControl:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @State private var opened=false
    var body:some View {Button{opened.toggle()}label:{Label(nativeUI("外观", "Appearance"),systemImage:"circle.lefthalf.filled")}.help(nativeUI("切换外观", "Change appearance")).popover(isPresented:$opened,arrowEdge:.top){VStack(alignment:.leading,spacing:16){Text(nativeUI("外观", "Appearance")).font(.system(size:16,weight:.semibold));AppearanceChoices(model:model);Text(nativeUI("选择适合当前环境的明暗层次", "Choose an appearance that feels right for your environment.")).font(.system(size:10)).foregroundStyle(.secondary)}.padding(22).frame(width:350)}}
}
// Keep quit ownership independent of JS completion order. A late acknowledgement
// after a timeout, cancellation, or a subsequent Cmd-Q cannot terminate the app.
struct NativeDraftQuitGate {
    enum Phase:Equatable { case idle, checking(UUID), decision(UUID), approved }
    private(set) var phase:Phase = .idle
    mutating func begin()->UUID? {
        guard phase == .idle else{return nil}
        let token=UUID();phase = .checking(token);return token
    }
    mutating func acknowledge(_ token:UUID,success:Bool)->Bool {
        guard phase == .checking(token) else{return false}
        phase = success ? .approved:.decision(token);return true
    }
    mutating func decide(_ token:UUID,exit:Bool)->Bool {
        guard phase == .decision(token) else{return false}
        phase = exit ? .approved:.idle;return true
    }
}

// SwiftUI keeps its window delegate. Forward its other callbacks rather than
// replacing document/window lifecycle behavior with an unrelated delegate.
@MainActor final class NativeDraftQuitWindowDelegate:NSObject,NSWindowDelegate {
    weak var owner:Delegate?
    weak var previous:NSWindowDelegate?
    weak var window:NSWindow?
    init(owner:Delegate,window:NSWindow){self.owner=owner;self.window=window;self.previous=window.delegate;super.init()}
    func windowShouldClose(_ sender:NSWindow)->Bool {
        if owner?.interceptLastWindowClose(sender) == true{return false}
        return previous?.windowShouldClose?(sender) ?? true
    }
    override func responds(to selector:Selector!)->Bool {super.responds(to:selector) || previous?.responds(to:selector) == true}
    override func forwardingTarget(for selector:Selector!)->Any? {
        if previous?.responds(to:selector) == true{return previous}
        return super.forwardingTarget(for:selector)
    }
}
@MainActor struct NativeDraftQuitWindow:NSViewRepresentable {
    let delegate:Delegate
    final class View:NSView {
        weak var owner:Delegate?
        override func viewDidMoveToWindow(){super.viewDidMoveToWindow();if let window{owner?.observeWorkspaceWindow(window)}}
    }
    func makeNSView(context:Context)->View {let view=View();view.owner=delegate;return view}
    func updateNSView(_ view:View,context:Context){view.owner=delegate;if let window=view.window{delegate.observeWorkspaceWindow(window)}}
}

// Identify the native editor windows without changing AppKit's default modal
// protection. Only an approved quit may permit these sheets to terminate.
@MainActor struct NativeDraftQuitSheet:NSViewRepresentable {
    final class View:NSView {
        private struct WindowReference {weak var window:NSWindow?}
        private static var editors:[ObjectIdentifier:WindowReference]=[:]
        override func viewDidMoveToWindow(){
            super.viewDidMoveToWindow()
            if let window{Self.editors[ObjectIdentifier(self)]=WindowReference(window:window)}
            else{unregister()}
        }
        func unregister(){Self.editors.removeValue(forKey:ObjectIdentifier(self))}
        static func allowApprovedTermination(){
            for editor in editors.values.compactMap({$0.window}) {
                var window:NSWindow?=editor
                while let current=window {
                    current.preventsApplicationTerminationWhenModal=false
                    window=current.sheetParent?.sheetParent != nil ? current.sheetParent:nil
                }
            }
        }
    }
    func makeNSView(context:Context)->View {View()}
    func updateNSView(_ view:View,context:Context){}
    static func dismantleNSView(_ view:View,coordinator:()){view.unregister()}
}

@MainActor final class Delegate:NSObject,NSApplicationDelegate {
    var model:Workspace? { didSet { if oldValue !== model { configureQuickEntry() } } }
    let quickEntry=NativeQuickEntryCoordinator()
    private let quickMedia=NativeQuickMediaStore()
    private let speechShortcut=NativeSpeechShortcutStore()
    private var speechDictation:NativeSpeechDictation?
    private var voiceCommand:NativeVoiceCommandCoordinator?
    private let quickUtilities=NativeQuickUtilitiesStore()
    private let quickAgenda=NativeQuickAgendaStore()
    private let quickLoginItem=NativeQuickLoginItemStore()
    // These utilities never live in the synchronized knowledge workspace.
    private static var quickLocalDirectory:URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support",isDirectory:true)
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.ai-workstation.studio",isDirectory:true)
            .appendingPathComponent("QuickTools",isDirectory:true)
    }
    private let quickClipboard=NativeQuickClipboardStore(directory:Delegate.quickLocalDirectory.appendingPathComponent("Clipboard",isDirectory:true))
    private let quickClipboardPasteBack=NativeQuickClipboardPasteBack()
    private let quickFileShelf=NativeQuickFileShelfStore(directory:Delegate.quickLocalDirectory.appendingPathComponent("FileShelf",isDirectory:true))
    private let quickVault=NativeQuickVaultStore()
    private var quickNotificationSources:NativeQuickNotificationSources?
    private var quickNotificationPanel:NativeQuickNotificationPanel?
    private var quickTaskReminders:NativeQuickTaskReminderStore?
    private var quickExternalNotifications:NativeQuickExternalNotificationStore?
    private var quickRecorderHosts=Set<String>()
    private var quickEntrySubscriptions=Set<AnyCancellable>()
    private var draftQuit=NativeDraftQuitGate()
    private var draftQuitTimeout:DispatchWorkItem?
    private var draftQuitTask:Task<Void,Never>?
    private var draftQuitAlert:NSAlert?
    private var draftQuitQuickCaptureBlocked=false
    private var draftQuitQuickCommandsBlocked=false
    private var draftQuitQuickTasksBlocked=false
    private var draftQuitQuickAgendaBlocked=false
    private var draftQuitQuickLinksBlocked=false
    private var draftQuitQuickRecordingsBlocked=false
    private var draftQuitQuickVaultBlocked=false
    private weak var draftQuitWindow:NSWindow?
    private var workspaceWindows:[ObjectIdentifier:NativeDraftQuitWindowDelegate]=[:]
    private func configureQuickEntry(){
        voiceCommand?.invalidate();voiceCommand=nil;quickEntry.updateVoiceStatus(nil)
        speechDictation?.shutdown();speechDictation=nil;speechShortcut.setActive(false)
        quickEntrySubscriptions.removeAll()
        quickExternalNotifications?.shutdown();quickExternalNotifications=nil
        quickTaskReminders?.shutdown();quickTaskReminders=nil
        quickNotificationPanel?.stop();quickNotificationPanel=nil
        quickNotificationSources?.accept(nil);quickNotificationSources=nil
        quickUtilities.onCommittedCompletion=nil
        quickEntry.captureLibrary.setAvailable(false)
        quickEntry.links.setAvailable(false)
        quickClipboard.setAvailable(false)
        quickClipboardPasteBack.setAvailable(false)
        quickClipboardPasteBack.onFeedback=nil
        quickFileShelf.setAvailable(false)
        quickVault.setAvailable(false)
        quickMedia.recordings.setAvailable(false)
        quickMedia.windows.setAvailable(false)
        quickMedia.mirror.setAvailable(false)
        quickEntry.canReceiveFiles = { false }
        quickEntry.receiveFiles = { _ in false }
        quickEntry.configure(onAction:{[weak self] action in self?.performQuickAction(action)},onQuit:{[weak self] in self?.requestQuit()})
        quickClipboardPasteBack.configure(isPresented:{[weak quickEntry] in quickEntry?.isShowing(.clipboard) == true},collapse:{[weak quickEntry] in await quickEntry?.collapseForClipboardPaste() == true})
        quickEntry.onClipboardPasteSessionBegan = {[weak self] in self?.quickClipboardPasteBack.beginSession()}
        quickEntry.onClipboardPasteSessionEnded = {[weak self] in self?.quickClipboardPasteBack.endSession()}
        guard let model else{return}
        model.desktop?.quickEntrySettings = {[weak self,weak model] request in
            guard let self,let model,self.model === model,self.draftQuit.phase == .idle else{return ["status":"error","reason":"unavailable"]}
            switch request {
            case .state: break
            case .enabled(let enabled): self.quickEntry.setEnabled(enabled)
            case .mode(let value):
                guard let mode=NativeQuickEntryCoordinator.Mode(rawValue:value),mode != .off else{return ["status":"error","reason":"invalid_request"]}
                self.quickEntry.mode=mode
            case .open:
                self.quickEntry.showPanel(section:.settings)
                guard self.quickEntry.isShowing(.settings) else{return ["status":"error","reason":"unavailable"]}
            }
            return ["status":"ok","mode":self.quickEntry.mode.rawValue,"isEnabled":self.quickEntry.isEnabled,"preferredEnabledMode":self.quickEntry.preferredEnabledMode.rawValue]
        }
        model.desktop?.openQuickPanel = {[weak self,weak model] request,verify in
            guard let self,let model,self.model === model,model.ready,self.draftQuit.phase == .idle else{return .deferred(reason:"workspace_unavailable")}
            guard model.snapshot?.privateMode == false else{return .denied(reason:"private_workspace")}
            guard let section=NativeQuickPanelSection(rawValue:request.section.rawValue),
                  self.quickEntry.visibleSections.contains(section) else{return .unsupported(reason:"section_unavailable")}
            // This request runs inside the Agent itself. Global run-busy is not
            // a navigation veto; only user-owned editors and active devices are.
            let canPresent = { [weak self,weak model] in
              guard let self,let model,self.model === model,model.ready,self.draftQuit.phase == .idle,
                  model.snapshot?.privateMode == false,self.quickEntry.visibleSections.contains(section),
                  model.web.window?.attachedSheet == nil,
                  !NSApp.windows.contains(where:{$0.isVisible && $0 is NSSavePanel}),
                  model.snapshot?.modalOpen != true,!model.agenda.hasUnsavedEditorDrafts,
                  !self.quickAgenda.hasEditor,!self.quickAgenda.saving,
                  !self.quickEntry.workbench.hasTaskEditor,
                  !self.quickEntry.workbench.hasUnsavedTaskCreationFields,
                  !self.quickEntry.workbench.creating,self.quickEntry.workbench.busyTaskIDs.isEmpty,
                  self.quickEntry.taskDraft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                  !self.quickEntry.capture.saving,self.quickEntry.capture.pending == nil,
                  !self.quickEntry.captureLibrary.hasUnsettledEditor,
                  !self.quickEntry.captureLibrary.editing,
                  !self.quickEntry.links.hasUnsettledEditor,
                  !self.quickEntry.links.editing,
                  self.quickEntry.capture.savedID != nil || self.quickEntry.capture.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                  !self.quickUtilities.isEditingCommand,!self.quickMedia.recordings.isActive,
                  !self.quickMedia.recordings.hasEditor,!self.quickMedia.recordings.hasUnsavedTranscriptDrafts,
                  !self.quickVault.hasEditor,!self.quickVault.busy,
                  !self.quickMedia.mirror.active,!self.quickMedia.mirror.starting else{return false}
              if let editor=NSApp.keyWindow?.firstResponder as? NSTextView,
                 editor.hasMarkedText() || editor.isEditable && !editor.string.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {return false}
              return true
            }
            guard canPresent() else{return .deferred(reason:"user_edit_in_progress")}
            let show = { [weak self] in self?.quickEntry.showPanel(section:section) }
            let isPresented = { [weak self] in self?.quickEntry.isShowing(section) == true && self?.quickEntry.presentation.contentVisible == true }
            guard let id=request.recordID,let kind=request.recordType else {
                self.quickEntry.showPanel(section:section)
                return await NativeQuickPanelOpenResult.opened(section:request.section).confirmed(verify:verify,isPresented:{canPresent() && self.quickEntry.isShowing(section)})
            }
            let positioned:Bool
            var targetStillPresented:()->Bool = {false}
            switch (request.section,kind) {
            case (.tasks,"task"):
                guard await verify(),canPresent() else{return .deferred(reason:"authorization_or_editor_changed")}
                targetStillPresented={self.quickEntry.workbench.recordFocus.isStillPresented(id:id)}
                positioned=await self.quickEntry.workbench.focusTask(id:id,show:{show()},canPresent:canPresent,isPresented:isPresented)
            case (.capture,"note"):
                guard await self.quickEntry.captureLibrary.prepareRecordFocus(id:id,canPresent:canPresent) else{return .deferred(reason:"record_unavailable_or_draft")}
                guard await verify(),canPresent() else{return .deferred(reason:"authorization_or_editor_changed")}
                targetStillPresented={self.quickEntry.captureLibrary.recordFocus.isStillPresented(id:id)}
                positioned=await self.quickEntry.captureLibrary.focusRecord(id:id,show:{self.quickEntry.selectCaptureLibrary(true);show()},canPresent:canPresent,isPresented:isPresented)
            case (.links,"import"):
                guard await self.quickEntry.links.prepareRecordFocus(id:id) else{return .deferred(reason:"record_unavailable_or_draft")}
                guard await verify(),canPresent() else{return .deferred(reason:"authorization_or_editor_changed")}
                targetStillPresented={self.quickEntry.links.recordFocus.isStillPresented(id:id)}
                positioned=await self.quickEntry.links.focusRecord(id:id,show:{show()},canPresent:canPresent,isPresented:isPresented)
            case (.agenda,"event"):
                guard let event=self.quickAgenda.eventForFocus(id:id),let text=request.authorizedUserText else{return .denied(reason:"record_unavailable")}
                let plain=text.replacingOccurrences(of:"```[\\s\\S]*?(?:```|$)|~~~[\\s\\S]*?(?:~~~|$)|(?m)^\\s*>.*$",with:"",options:.regularExpression)
                let identified=id.count>=4 && plain.contains(id)
                let named=event.title.count>=2 && plain.contains(event.title) && model.agenda.events.filter({!$0.deleted && $0.title==event.title}).count==1
                guard identified || named else{return .denied(reason:"explicit_record_required")}
                let owner=request.owner
                let scopeAllowed = { [weak self,weak model] in
                    guard let self,let model,self.quickAgenda.eventForFocus(id:id)==event else{return false}
                    if let project=owner.projectID {return event.projectID==project}
                    if event.projectID.isEmpty {return ["日常","auto"].contains(owner.workspace)}
                    return model.snapshot?.projects.contains(where:{$0.id==event.projectID && (owner.workspace=="auto" || $0.workspace==owner.workspace)}) == true
                }
                guard scopeAllowed() else{return .denied(reason:"record_outside_scope")}
                guard await verify(),canPresent(),scopeAllowed() else{return .deferred(reason:"authorization_or_editor_changed")}
                positioned=await self.quickAgenda.focusEvent(id:id,show:{show()},canPresent:{canPresent() && scopeAllowed()},isPresented:isPresented)
                if let occurrenceID=self.quickAgenda.recordFocus.highlightedID {targetStillPresented={self.quickAgenda.recordFocus.isStillPresented(id:occurrenceID)}}
            default:return .unsupported(reason:"record_type_unavailable")
            }
            guard positioned else{return .deferred(reason:"record_not_visible")}
            return await NativeQuickPanelOpenResult.positioned(section:request.section,recordType:kind,recordID:id).confirmed(verify:verify,isPresented:{canPresent() && isPresented() && targetStillPresented()})
        }
        configureQuickNotifications(model)
        quickEntry.registerSettingsSection(id:"login-item",content:{[quickLoginItem] in AnyView(NativeQuickLoginItemView(store:quickLoginItem))})
        quickMedia.configure(directory:model.dataDirectory)
        // ASR settings use their own local encrypted record, outside workspace
        // sync. Configuration only reads metadata; recording remains explicit.
        try? FileManager.default.createDirectory(at:Self.quickLocalDirectory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        quickMedia.mirror.configure(directory:Self.quickLocalDirectory.appendingPathComponent("Mirror",isDirectory:true))
        quickMedia.recordings.configureRealtime(owner:model.dataDirectory,access:NativeQuickASRCredentialAdapter.access(
            directory:Self.quickLocalDirectory.appendingPathComponent("ASR",isDirectory:true),
            service:(Bundle.main.bundleIdentifier ?? "app.ai-workstation.studio") + ".quick-asr"))
        quickMedia.recordings.configureSpeech(owner:model.dataDirectory,access:NativeSpeechCredentialAdapter.access(
            directory:Self.quickLocalDirectory.appendingPathComponent("Speech",isDirectory:true),
            service:(Bundle.main.bundleIdentifier ?? "app.ai-workstation.studio") + ".speech"))
        configureSpeechEntry(model)
        quickVault.configure(directory:Self.quickLocalDirectory.appendingPathComponent("Vault",isDirectory:true),
            identity:(Bundle.main.bundleIdentifier ?? "app.ai-workstation.studio") + ".quick-vault")
        quickUtilities.configure(directory:model.dataDirectory)
        quickAgenda.configure(agenda:model.agenda,context:{[weak self,weak model] in
            let snapshot=model?.snapshot
            return NativeQuickAgendaContext(
                ready:model != nil && self?.model === model && model?.ready == true && snapshot != nil,
                privateMode:snapshot?.privateMode ?? true,
                projects:(snapshot?.projects ?? []).map{AgendaEditingProject(id:$0.id,title:$0.title)},
                documents:(snapshot?.documents ?? []).map{AgendaEditingDocument(id:$0.id,title:$0.title,projectID:$0.projectId,kind:$0.kind)},
                taskIDs:Set((snapshot?.tasks ?? []).map(\.id)),projectID:snapshot?.projectId)
        },openTask:{[weak self] id in await self?.openQuickWorkbenchItem(id,run:false) ?? false},openAgenda:{[weak self] date in
            guard let self,let model=self.model,self.canOpenQuickWorkbenchItem(model) else{return}
            model.agenda.focusDate=date;model.openWorkspace("agenda")
            self.quickEntry.dismiss(returnFocus:false);self.restoreWorkspaceWindow()
        })
        quickEntry.registerModule(.agenda,content:{[quickAgenda,weak quickEntry] in AnyView(NativeQuickAgendaView(store:quickAgenda,onFocus:{quickEntry?.activateInput()}))})
        quickEntry.registerModule(.links,content:{[weak quickEntry] in
            guard let quickEntry else{return AnyView(EmptyView())}
            return AnyView(NativeQuickLinksView(store:quickEntry.links,onFocus:{[weak quickEntry] in quickEntry?.activateInput()}))
        },onVisibilityChange:{[weak quickEntry] visible in
            guard let quickEntry else{return}
            quickEntry.links.setVisible(visible)
            if visible {Task{@MainActor [weak quickEntry] in await quickEntry?.links.refresh()}}
            else {_ = quickEntry.links.flushDraft()}
        })
        quickEntry.registerModule(.recordings,content:{[quickMedia,weak quickEntry] in AnyView(NativeQuickRecordingLibrary(store:quickMedia.recordings,onFocus:{quickEntry?.activateInput()},canFocus:{quickEntry?.isShowing(.recordings)==true && quickEntry?.presentation.contentVisible==true}))},onVisibilityChange:{[weak self] in self?.setQuickRecorderHost("recordings",visible:$0)})
        quickEntry.registerModule(.vault,content:{[quickVault,weak quickEntry] in
            AnyView(NativeQuickVaultView(store:quickVault,onFocus:{quickEntry?.activateInput()},
                canFocus:{quickEntry?.isShowing(.vault)==true && quickEntry?.presentation.contentVisible==true}))
        },onVisibilityChange:{[quickVault] in quickVault.setVisible($0)})
        quickEntry.registerModule(.clipboard,content:{[quickClipboard,quickClipboardPasteBack,weak quickEntry] in
            AnyView(NativeQuickClipboardView(store:quickClipboard,pasteBack:quickClipboardPasteBack,onFocus:{quickEntry?.activateInput()}))
        },onVisibilityChange:{[quickClipboard] in quickClipboard.setVisible($0)})
        quickEntry.registerModule(.shelf,content:{[quickFileShelf,weak quickEntry] in
            AnyView(NativeQuickFileShelfView(store:quickFileShelf,onFocus:{quickEntry?.activateInput()}))
        },onVisibilityChange:{[quickFileShelf] in quickFileShelf.setVisible($0)})
        quickEntry.canReceiveFiles = {[weak self] in self?.quickFileShelf.canReceiveDrop == true}
        quickEntry.receiveFiles = {[weak self] providers in self?.quickFileShelf.acceptProviders(providers) ?? false}
        quickEntry.registerHomeModule(id:"recorder",title:nativeUI("快速录音", "Quick recording"),symbol:"waveform",content:{[quickMedia,weak quickEntry] in AnyView(NativeQuickRecorderCard(store:quickMedia.recordings,onFocus:{quickEntry?.activateInput()},canFocus:{quickEntry?.isShowing(.home)==true && quickEntry?.presentation.contentVisible==true}))},onVisibilityChange:{[weak self] in self?.setQuickRecorderHost("home",visible:$0)},canHide:{[quickMedia] in !quickMedia.recordings.isActive})
        quickEntry.registerHomeModule(id:"mirror",title:nativeUI("镜子", "Mirror"),symbol:"camera",content:{[quickMedia] in AnyView(NativeQuickMirrorCard(store:quickMedia.mirror))},onVisibilityChange:{[quickMedia] in quickMedia.mirror.setVisible($0)})
        quickEntry.registerHomeModule(id:"windows",title:nativeUI("当前窗口", "Windows"),symbol:"macwindow",content:{[quickMedia] in AnyView(NativeQuickWindowsCard(store:quickMedia.windows))},onVisibilityChange:{[quickMedia] in quickMedia.windows.setVisible($0)},onActivityChange:{[quickMedia] in quickMedia.windows.setActivity($0)})
        quickEntry.registerHomeModule(id:"music",title:nativeUI("音乐", "Music"),symbol:"music.note",content:{[quickMedia] in AnyView(NativeQuickMusicCard(store:quickMedia.music))},onVisibilityChange:{[quickMedia] in quickMedia.music.setVisible($0)})
        quickEntry.registerHomeModule(id:"pomodoro",title:nativeUI("番茄钟", "Focus timer"),symbol:"timer",content:{[quickUtilities] in AnyView(NativeQuickPomodoroView(store:quickUtilities))},onVisibilityChange:{[quickUtilities] in quickUtilities.setVisible($0)})
        quickEntry.registerHomeModule(id:"commands",title:nativeUI("常用指令", "Prompts"),symbol:"text.bubble",content:{[quickUtilities] in AnyView(NativeQuickCommandsView(store:quickUtilities))})
        quickEntry.configureCapture(directory:model.dataDirectory,save:{[weak model] payload in
            guard let model else{throw NativeQuickCaptureError.unavailable}
            return try await model.saveQuickCapture(payload)
        })
        quickEntry.captureLibrary.configure(directory:model.dataDirectory,request:{[weak self,weak model] payload in
            guard let self,let model,self.model === model,model.ready,self.draftQuit.phase == .idle else{return ["status":"deferred","reason":"unavailable"]}
            return try await model.quickCaptureLibraryRequest(payload)
        },open:{[weak self] type,id in await self?.openQuickCaptureItem(type:type,id:id) ?? false})
        quickMedia.recordings.configureTitleRequest { [weak self,weak model] payload in
            guard let self,let model,self.model === model,model.ready else{return ["status":"deferred","reason":"unavailable"]}
            // Closing the panel cancels its request before the quit gate settles.
            // Cancellation remains valid while new generation is prohibited.
            guard payload["action"] as? String == "cancel" || self.draftQuit.phase == .idle else{return ["status":"deferred","reason":"unavailable"]}
            return try await model.quickRecordingTitleRequest(payload)
        }
        quickEntry.links.configure(directory:model.dataDirectory,request:{[weak self,weak model] payload in
            guard let self,let model,self.model === model,model.ready,self.draftQuit.phase == .idle else{return ["status":"deferred","reason":"unavailable"]}
            return try await model.quickLinksRequest(payload)
        },openSource:{[weak self] id in await self?.openQuickCaptureItem(type:"import",id:id) ?? false},openURL:{url in NSWorkspace.shared.open(url)})
        quickEntry.workbench.configure(directory:model.dataDirectory,command:{[weak self,weak model] payload in
            guard let self,let model,self.model === model,model.ready,self.draftQuit.phase == .idle else{return ["status":"deferred","reason":"unavailable"]}
            let result=try await model.web.callAsyncJavaScript("""
            if (!window.NativeQuickWorkbench?.command) return {status:'deferred',reason:'unavailable'};
            return await window.NativeQuickWorkbench.command(payload);
            """,arguments:["payload":payload],in:nil,contentWorld:.page)
            guard let receipt=result as? [String:Any] else{throw NativeQuickCaptureError.unconfirmed}
            return receipt
        },openTask:{[weak self] id in await self?.openQuickWorkbenchItem(id,run:false) ?? false},openRun:{[weak self] id in await self?.openQuickWorkbenchItem(id,run:true) ?? false})
        model.$snapshot.combineLatest(model.$ready).sink{[weak self,weak model] snapshot,ready in
            self?.quickEntry.update(busy:snapshot?.busy ?? false,unread:snapshot?.activityUnread ?? 0,ready:ready)
            self?.quickEntry.workbench.accept(ready ? snapshot?.quickWorkbench:nil)
            self?.quickEntry.captureLibrary.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickEntry.links.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickClipboard.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickClipboardPasteBack.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickFileShelf.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickVault.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickMedia.recordings.setAvailable(ready && snapshot?.privateMode == false && snapshot?.quickWorkbench?.status == "ready")
            let voiceAvailable=ready && snapshot?.privateMode == false && snapshot?.quickWorkbench?.status == "ready"
            self?.speechDictation?.setAvailable(voiceAvailable)
            if !voiceAvailable {self?.voiceCommand?.invalidate()}
            self?.quickMedia.windows.setAvailable(ready && snapshot?.privateMode == false)
            self?.quickMedia.mirror.setAvailable(ready && snapshot?.privateMode == false)
            // @Published emits before Workspace.snapshot stores the new value.
            // Refresh the closure-backed calendar context after that assignment.
            DispatchQueue.main.async{[weak self,weak model] in
                guard let self,let model,self.model === model else{return}
                self.quickAgenda.refreshContext()
                self.acceptQuickNotificationSnapshot()
                self.acceptVoiceExecutionSnapshot()
            }
        }.store(in:&quickEntrySubscriptions)
        // Disabling the last background entry must never strand a hidden workspace.
        quickEntry.$mode.dropFirst().removeDuplicates().sink{[weak self] mode in
            if mode == .off {self?.restoreWorkspaceWindow()}
            DispatchQueue.main.async{[weak self] in
                self?.acceptQuickNotificationSnapshot()
                // Read after @Published willSet has committed the coordinator value.
                self?.model?.web.evaluateJavaScript("window.dispatchEvent(new Event('aibro-quick-entry-change'))",completionHandler:nil)
            }
        }.store(in:&quickEntrySubscriptions)
    }
    func invokeVoiceCommand(){voiceCommand?.invoke()}
    private func configureSpeechEntry(_ model:Workspace){
        let dictation=NativeSpeechDictation(settings:quickMedia.recordings.speechSettings,
            directory:Self.quickLocalDirectory.appendingPathComponent("Dictation",isDirectory:true),
            canCapture:{[weak self,weak model] _ in
                guard let self,let model,self.model === model,self.draftQuit.phase == .idle else{return false}
                return model.voiceWorkspaceAvailable && self.quickMedia.recordings.phase == .idle
                    && self.quickMedia.recordings.transcribingID == nil && !self.quickMedia.recordings.hasEditor
            })
        speechDictation=dictation;model.desktop?.speechDictation=dictation
        let owner=model.dataDirectory,origin=model.origin
        let voice=NativeVoiceCommandCoordinator(dictation:dictation,verify:{[weak self,weak model] in
            guard let self,let model,self.model === model,self.draftQuit.phase == .idle else{return false}
            return model.dataDirectory==owner && (origin == nil || model.origin==origin) && model.voiceWorkspaceAvailable
        },submit:{[weak self,weak model] id,text in
            guard let self,let model,self.model === model,self.draftQuit.phase == .idle else{return ["status":"deferred","requestId":id,"reason":"unavailable"]}
            return await model.submitVoiceInstruction(requestID:id,text:text)
        })
        voiceCommand=voice
        voice.autoSubmitProvider={ [weak speechShortcut] in speechShortcut?.autoSubmit == true }
        voice.onPresent={ [weak self,weak voice] in
            guard let self else{return}
            self.updateVoiceIslandStatus()
            if !self.quickEntry.showVoice() {voice?.cancel()}
        }
        voice.onDismiss={ [weak quickEntry] in quickEntry?.dismissVoice() }
        voice.onAccepted={ [weak self] _ in self?.acceptVoiceExecutionSnapshot() }
        voice.onOpenConversation={ [weak self,weak model,weak voice] id in
            guard let receipt=voice?.execution,receipt.conversationID==id else{return}
            Task { @MainActor in
                guard let self,let model,self.model === model,self.draftQuit.phase == .idle,
                      self.voiceCommand === voice,voice?.execution?.requestID==receipt.requestID,
                      model.voiceWorkspaceAvailable,
                      let navigation=model.command("conversation",id,quickEntry:true),await navigation.value,
                      self.model === model,self.draftQuit.phase == .idle,model.voiceWorkspaceAvailable,
                      self.voiceCommand === voice,voice?.execution?.requestID==receipt.requestID else{return}
                self.quickEntry.dismissVoice(returnFocus:false);self.restoreWorkspaceWindow()
            }
        }
        speechShortcut.onInvoke={ [weak voice,weak speechShortcut] in
            if speechShortcut?.mode == .hold {voice?.beginHold()}else{voice?.invoke()}
        }
        speechShortcut.onRelease={ [weak voice] in voice?.endHold() }
        speechShortcut.$mode.dropFirst().removeDuplicates().sink{[weak voice] _ in
            voice?.cancelHeldCapture()
        }.store(in:&quickEntrySubscriptions)
        speechShortcut.$shortcut.dropFirst().removeDuplicates().sink{[weak voice] _ in
            voice?.cancelHeldCapture()
        }.store(in:&quickEntrySubscriptions)
        speechShortcut.$active.dropFirst().removeDuplicates().sink{[weak voice] active in
            if !active {voice?.cancelHeldCapture()}
        }.store(in:&quickEntrySubscriptions)
        speechShortcut.setActive(true)
        quickEntry.registerSettingsSection(id:"voice-shortcut",content:{[speechShortcut] in AnyView(NativeSpeechShortcutView(store:speechShortcut))})
        let openSettings:() async -> Bool = { [weak self,weak model] in
            guard let self,let model,self.model === model,model.voiceWorkspaceAvailable,
                  self.quickMedia.recordings.phase == .idle,!self.quickMedia.recordings.hasEditor,
                  self.quickMedia.recordings.transcribingID == nil else{return false}
            self.voiceCommand?.invalidate();self.quickEntry.showPanel(section:.recordings)
            // The recording module becomes visible after the island expands.
            // Wait only for that explicit presentation; never begin a settings
            // draft under an unmounted/hidden recording owner.
            for _ in 0..<40 {
                guard !Task.isCancelled,self.model === model,model.voiceWorkspaceAvailable,self.quickEntry.isShowing(.recordings) else{return false}
                self.quickMedia.recordings.beginSpeechSettings()
                if self.quickMedia.recordings.speechSettingsDraft != nil {return true}
                do {try await Task.sleep(nanoseconds:50_000_000)}catch{return false}
            }
            return false
        }
        model.desktop?.openSpeechSettings=openSettings
        quickEntry.configureVoice(content:{[voice,dictation,speechShortcut,weak self] in
            AnyView(NativeVoiceCommandView(coordinator:voice,dictation:dictation,speechSettings:dictation.settings,shortcut:speechShortcut,
                settings:{Task{_ = await openSettings()}},stop:{[weak self,weak voice] id in
                    guard let self,voice?.execution?.runID==id else{return false}
                    return await self.quickEntry.workbench.cancelRun(id:id)
                }))
        },onEscape:{[weak voice] in voice?.cancel()},onHide:{[weak voice] in voice?.cancel()})
        voice.objectWillChange.receive(on:RunLoop.main).sink{[weak self] _ in
            self?.updateVoiceIslandStatus()
            // Closing during submission suppresses onAccepted's reveal hook,
            // but its durable receipt still needs the latest run projection.
            // That snapshot may already have arrived before the send ACK.
            if self?.voiceCommand?.execution?.status == "submitted" {self?.acceptVoiceExecutionSnapshot()}
        }.store(in:&quickEntrySubscriptions)
        quickMedia.recordings.$phase.dropFirst().sink{[weak dictation] phase in
            if phase != .idle {dictation?.invalidate()}
        }.store(in:&quickEntrySubscriptions)
    }
    private func updateVoiceIslandStatus(){
        guard let voice=voiceCommand,voice.phase != .idle || voice.execution != nil else{
            quickEntry.updateVoiceStatus(nil);return
        }
        quickEntry.updateVoiceStatus(.init(title:voice.presentationTitle,symbol:voice.presentationSymbol,isProcessing:voice.presentationBusy))
    }
    private func acceptVoiceExecutionSnapshot(){
        guard let voice=voiceCommand,let receipt=voice.execution,let model,model.voiceWorkspaceAvailable,
              let workbench=model.snapshot?.quickWorkbench,workbench.status == "ready" else{return}
        let matches=workbench.runs.filter{item in
            item.voiceRequestId==receipt.requestID && item.conversationId==receipt.conversationID
                && (receipt.runID == nil || item.id==receipt.runID)
                && (receipt.userMessageID == nil || item.userMessageId==receipt.userMessageID)
        }
        guard matches.count==1,let item=matches.first else{
            // The durable send acknowledgement may precede the next published
            // workbench projection. Wait for its first matching run snapshot.
            if receipt.status == "submitted" {return}
            voice.acceptExecution(runID:receipt.runID,voiceRequestID:receipt.requestID,conversationID:receipt.conversationID,
                userMessageID:receipt.userMessageID,status:"unavailable",notificationReady:false,summary:"");return
        }
        voice.acceptExecution(runID:item.id,voiceRequestID:receipt.requestID,conversationID:receipt.conversationID,
            userMessageID:item.userMessageId,status:item.status ?? "processing",notificationReady:item.notificationReady == true,
            summary:item.resultSummary ?? "")
    }
    private func configureQuickNotifications(_ model:Workspace){
        let ownerID=model.dataDirectory.standardizedFileURL.path
        let queue=NativeQuickNotificationQueue(ownerID:ownerID)
        let sources=NativeQuickNotificationSources(queue:queue)
        quickNotificationSources=sources
        quickClipboardPasteBack.onFeedback = {[weak self,weak model,weak sources] message in
            guard let self,let model,let sources,self.model === model,
                  model.ready,model.snapshot?.privateMode == false,
                  model.snapshot?.quickWorkbench?.status == "ready",
                  self.quickClipboard.available,self.quickEntry.mode != .off else{return}
            _ = sources.acceptClipboardFeedback(id:UUID(),message:message,ownerID:ownerID)
        }
        let notificationTransport=NativeQuickExternalNotificationTransport()
        let external=NativeQuickExternalNotificationStore(ownerID:ownerID,queue:queue,
            endpointFile:NativeQuickExternalNotificationLocation.directory.appendingPathComponent("endpoint.json"),
            hookFile:model.root.appendingPathComponent("app/external-notification-hook.cjs"),
            request:{[weak model] path,body in
                guard let model else{throw NativeQuickExternalNotificationError.unavailable}
                return try await notificationTransport.request(origin:model.origin,token:model.nativeNotificationToken,path:path,body:body)
            })
        quickExternalNotifications=external
        external.onEventsInvalidated = {[weak self] in self?.quickNotificationPanel?.reconcileHistory()}
        quickEntry.registerSettingsSection(id:"external-notifications",content:{[weak self,external] in
            AnyView(NativeQuickExternalNotificationSettingsView(store:external,entryDisabled:self?.quickEntry.mode == .off))
        })
        let reminders=NativeQuickTaskReminderStore(directory:Delegate.quickLocalDirectory.appendingPathComponent("TaskReminders",isDirectory:true),ownerID:ownerID,sources:sources)
        quickTaskReminders=reminders
        reminders.onEventsInvalidated = {[weak self] in self?.quickNotificationPanel?.reconcileHistory()}
        quickEntry.registerSettingsSection(id:"task-reminders",content:{[weak self,reminders] in
            AnyView(NativeQuickTaskReminderSettingsView(store:reminders,unavailableReason:self?.quickEntry.mode == .off
                ? nativeUI("请先在上方选择常驻入口，提醒才能显示。", "Choose a persistent entry above so reminders can appear.") : nil))
        })
        sources.onQueueFull = {[weak self,weak model] in
            guard let self,let model,self.model === model,model.snapshot?.privateMode == false else{return}
            // A full visual queue does not erase the run or claim delivery.
            NSApp.requestUserAttention(.informationalRequest)
        }
        quickNotificationPanel=NativeQuickNotificationPanel(queue:queue,open:{[weak self,weak model] destination in
            guard let self,let model,self.model === model else{return false}
            return await self.openQuickNotification(destination,model:model)
        },onOccupiedRegionChanged:{[weak quickEntry] region in quickEntry?.setNotificationOccupiedRegion(region)})
        quickUtilities.onCommittedCompletion = {[weak self,weak model,weak sources] event in
            guard let self,let model,self.model === model,
                  event.directory.standardizedFileURL == model.dataDirectory.standardizedFileURL else{return false}
            // Privacy suppresses delivery without falling back to an attention
            // request. No title/identity is queued for later replay.
            if model.snapshot?.privateMode == true {return true}
            guard self.quickEntry.mode != .off else{return false}
            return sources?.acceptPomodoro(runID:event.runID,phase:event.phase.rawValue,duration:event.duration,
                completedAt:event.completedAt,ownerID:ownerID) ?? false
        }
        quickEntry.objectWillChange.receive(on:RunLoop.main).sink{[weak self] _ in
            self?.refreshQuickNotificationPresentation()
        }.store(in:&quickEntrySubscriptions)
    }
    private func acceptQuickNotificationSnapshot(){
        guard let model,let sources=quickNotificationSources else{return}
        let snapshot=model.snapshot
        let available=model.ready && snapshot?.privateMode == false && quickEntry.mode != .off && snapshot?.quickWorkbench?.version == 1 && snapshot?.quickWorkbench?.status == "ready"
        sources.accept(available ? snapshot?.quickWorkbench?.runs.map{.init(id:$0.id,title:$0.title,status:$0.status,
            finishedAt:$0.finishedAt,notificationReady:$0.notificationReady == true)}:nil)
        quickTaskReminders?.accept(tasks:available ? snapshot?.quickWorkbench?.tasks:nil,
            disabledTaskIDs:Set(snapshot?.tasks?.filter{$0.reminderDisabled == true}.map(\.id) ?? []))
        quickExternalNotifications?.updateContext(ready:model.ready,available:available)
        if !available {quickNotificationPanel?.closeHistory()}
        else {quickNotificationPanel?.reconcileHistory()}
        refreshQuickNotificationPresentation()
    }
    private func refreshQuickNotificationPresentation(){
        guard let panel=quickNotificationPanel else{return}
        guard let screen=quickEntry.notificationScreen else{panel.updateContext(nil);return}
        panel.updateContext(.init(screen:screen,
            allowed:quickNotificationSources?.available == true && quickEntry.mode != .off && draftQuit.phase == .idle,
            protectedFrame:quickEntry.notificationProtectedFrame,reducedMotion:quickEntry.reduceMotion))
    }
    private func openQuickNotification(_ destination:NativeQuickNotificationEvent.Destination,model:Workspace) async -> Bool {
        guard canOpenQuickWorkbenchItem(model),model.snapshot?.privateMode == false,
              !quickAgenda.hasEditor,!quickAgenda.saving,
              !quickEntry.workbench.hasTaskEditor,!quickEntry.workbench.hasUnsavedTaskCreationFields,
              !quickEntry.workbench.creating,quickEntry.workbench.busyTaskIDs.isEmpty,
              !quickEntry.capture.saving,quickEntry.capture.pending == nil,
              !quickEntry.captureLibrary.hasUnsettledEditor,!quickEntry.links.hasUnsettledEditor,
              !quickUtilities.isEditingCommand,!quickMedia.recordings.isActive,
              !quickMedia.recordings.hasEditor,!quickMedia.recordings.hasUnsavedTranscriptDrafts,
              !quickVault.hasEditor,!quickVault.busy,
              !quickMedia.mirror.active,!quickMedia.mirror.starting,
              quickEntry.flushCaptureDraft() else{return false}
        switch destination {
        case .run(let id): return await openQuickWorkbenchItem(id,run:true)
        case .task(let id):
            guard let reminders=quickTaskReminders,let token=reminders.navigationToken(taskID:id),quickEntry.visibleSections.contains(.tasks) else{return false}
            let valid = {[weak self,weak model,weak reminders] in
                guard let self,let model,let reminders else{return false}
                return self.model === model && self.canOpenQuickWorkbenchItem(model) && reminders.canOpen(token)
            }
            let opened=await quickEntry.workbench.focusTask(id:id,show:{[weak quickEntry] in quickEntry?.showPanel(section:.tasks)},
                canPresent:valid,isPresented:{[weak quickEntry] in quickEntry?.isShowing(.tasks) == true && quickEntry?.presentation.contentVisible == true})
            return opened && valid()
        case .pomodoro(let id):
            guard quickUtilities.ready,quickUtilities.currentPomodoroRunID == id else{return false}
            let opened=await quickEntry.showHomeModule("pomodoro")
            return opened && self.model === model && model.snapshot?.privateMode == false && quickUtilities.currentPomodoroRunID == id
        case .clipboard(let id):
            guard let sources=quickNotificationSources else{return false}
            let ownerID=model.dataDirectory.standardizedFileURL.path
            let valid = {[weak self,weak model,weak sources] in
                guard let self,let model,let sources else{return false}
                return self.model === model && self.canOpenQuickWorkbenchItem(model)
                    && model.snapshot?.privateMode == false && self.quickClipboard.available
                    && self.quickEntry.mode != .off && self.quickEntry.visibleSections.contains(.clipboard)
                    && sources.hasClipboardFeedback(id:id,ownerID:ownerID)
            }
            guard valid() else{return false}
            quickEntry.showPanel(section:.clipboard)
            return valid() && quickEntry.isShowing(.clipboard)
        case .history(let ids): return quickNotificationPanel?.showHistory(ids) ?? false
        case .external(let id): return quickNotificationPanel?.showHistory([id]) ?? false
        case .agenda: return false
        }
    }
    private func setQuickRecorderHost(_ key:String,visible:Bool){
        if visible {quickRecorderHosts.insert(key)}else{quickRecorderHosts.remove(key)}
        // Home and library share the same recorder. Merge a tab transition's
        // disappearance/appearance before releasing the recording device.
        DispatchQueue.main.async{[weak self] in
            guard let self else{return}
            self.quickMedia.recordings.setVisible(!self.quickRecorderHosts.isEmpty)
        }
    }
    @discardableResult private func restoreWorkspaceWindow()->NSWindow? {
        guard let window=model?.web.window ?? workspaceWindows.values.compactMap({$0.window}).first else{return nil}
        NSApp.unhide(nil)
        if window.isMiniaturized {window.deminiaturize(nil)}
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        if let sheet=window.attachedSheet {sheet.makeKeyAndOrderFront(nil)}
        return window
    }
    private func canOpenQuickWorkbenchItem(_ model:Workspace,diagnose:Bool=false)->Bool {
        func blocked(_ reason:String)->Bool {if diagnose{model.recordQuickNavigation("native_guard",reason:reason)};return false}
        guard self.model === model else{return blocked("workspace_changed")}
        guard model.ready else{return blocked("workspace_not_ready")}
        guard draftQuit.phase == .idle else{return blocked("quit_in_progress")}
        guard !NSApp.windows.contains(where:{$0.isVisible && $0 is NSSavePanel}) else{return blocked("save_panel")}
        guard let window=model.web.window ?? workspaceWindows.values.compactMap({$0.window}).first else{return blocked("window_unavailable")}
        guard window.attachedSheet == nil else{return blocked("native_sheet")}
        guard !model.agenda.hasUnsavedEditorDrafts else{return blocked("agenda_draft")}
        guard model.snapshot?.modalOpen != true else{return blocked("web_modal")}
        guard model.snapshot?.privateMode != true else{return blocked("private_mode")}
        return true
    }
    private func openQuickWorkbenchItem(_ id:String,run:Bool) async -> Bool {
        guard let model else{return false}
        model.recordQuickNavigation("requested",reason:run ? "run":"task")
        guard canOpenQuickWorkbenchItem(model,diagnose:true) else{return false}
        var destination=id
        if run {
            do {
                let result=try await model.web.callAsyncJavaScript("return window.NativeShell?.quickRunConversation(id) || '';",arguments:["id":id],in:nil,contentWorld:.page)
                guard let conversation=result as? String,!conversation.isEmpty else{model.recordQuickNavigation("run_lookup",reason:"conversation_unavailable");return false}
                guard canOpenQuickWorkbenchItem(model,diagnose:true) else{return false}
                destination=conversation
            } catch {model.recordQuickNavigation("run_lookup_failed",error:error);return false}
        }
        // The bridge revalidates the run-to-conversation association and live
        // modal/privacy state, including after the document's draft flush.
        guard let navigation=model.command(run ? "conversation":"task",destination,quickEntry:true,runId:run ? id:nil) else{model.recordQuickNavigation("command_unavailable");return false}
        guard await navigation.value else{model.recordQuickNavigation("command_rejected");return false}
        guard self.model === model,draftQuit.phase == .idle else{model.recordQuickNavigation("command_cancelled",reason:"workspace_or_quit_changed");return false}
        quickEntry.dismiss(returnFocus:false)
        let restored=restoreWorkspaceWindow() != nil
        model.recordQuickNavigation("window_restore",accepted:restored);return restored
    }
    private func openQuickCaptureItem(type:String,id:String) async -> Bool {
        guard ["note","import","task"].contains(type),let model,canOpenQuickWorkbenchItem(model),
              let navigation=model.command(type,id,quickEntry:true),await navigation.value,
              self.model === model,draftQuit.phase == .idle else{return false}
        quickEntry.dismiss(returnFocus:false)
        return restoreWorkspaceWindow() != nil
    }
    private func performQuickAction(_ action:NativeQuickAction){
        quickEntry.dismiss(returnFocus:false)
        let window=restoreWorkspaceWindow()
        guard let model,action != .resume else{return}
        // Quick entry shares the main window's draft and modal ownership. It
        // never starts a second route behind an unresolved native editor sheet.
        guard model.ready,draftQuit.phase == .idle,window?.attachedSheet == nil,
              !model.agenda.hasUnsavedEditorDrafts,model.snapshot?.modalOpen != true else{return}
        switch action {
        case .resume: break
        case .newChat:
            if let project=model.snapshot?.projectId,!project.isEmpty,
               model.selection?.hasPrefix("project:") == true || model.selection?.hasPrefix("chat:") == true {
                model.command("new-project-conversation",project)
            }else{model.command("new")}
        case .quickNotes: model.openWorkspace("captures")
        case .search: model.command("search")
        case .agenda: model.openWorkspace("agenda")
        case .activity: model.command("activity-center")
        case .settings: model.openWorkspaceSettings()
        }
    }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool {
        let workspaceVisible=workspaceWindows.values.contains{$0.window?.isVisible == true && $0.window?.isMiniaturized != true}
        if !workspaceVisible {restoreWorkspaceWindow()}
        return true
    }
    func applicationDidFinishLaunching(_ notification:Notification){NSApp.setActivationPolicy(.regular);NSApp.activate(ignoringOtherApps:true)}
    func observeWorkspaceWindow(_ window:NSWindow){
        workspaceWindows=workspaceWindows.filter{$0.value.window != nil}
        let key=ObjectIdentifier(window)
        if let existing=workspaceWindows[key],window.delegate === existing{return}
        let proxy=NativeDraftQuitWindowDelegate(owner:self,window:window)
        workspaceWindows[key]=proxy;window.delegate=proxy
    }
    func interceptLastWindowClose(_ window:NSWindow)->Bool {
        guard draftQuit.phase != .approved else{return false}
        let others=workspaceWindows.values.compactMap{$0.window}.filter{$0 !== window && $0.isVisible}
        guard others.isEmpty else{return false}
        if quickEntry.keepRunning {
            // Keep the same Workspace/WebView alive, including parked and
            // unsaved drafts. Cmd-Q still uses the original checked quit path.
            guard draftQuit.phase == .idle,window.attachedSheet == nil,
                  model?.agenda.hasUnsavedEditorDrafts != true else{
                (window.attachedSheet ?? window).makeKeyAndOrderFront(nil);return true
            }
            window.orderOut(nil)
            return true
        }
        draftQuitWindow=window;requestQuit();return true
    }
    // Run the entire draft check before asking AppKit to begin termination.
    // In particular, SwiftUI must not dismantle an agenda sheet while the user
    // is still deciding whether to keep editing its in-memory form.
    func requestQuit(){
        voiceCommand?.invalidate();speechDictation?.invalidate()
        quickEntry.dismiss(returnFocus:false)
        if draftQuit.phase == .approved{terminateApproved();return}
        guard let token=draftQuit.begin() else{draftQuitAlert?.window.makeKeyAndOrderFront(nil);return}
        draftQuitWindow=model?.web.window ?? workspaceWindows.values.compactMap{$0.window}.first(where:{$0.isVisible})
        let captureSaved=quickEntry.flushCaptureDraft()
        let commandsSaved=quickUtilities.flushPendingDraft()
        let linksSaved=quickEntry.links.flushForQuit()
        let recordingsSaved=quickMedia.recordings.flushForQuit()
        let vaultSaved=quickVault.flushForQuit()
        draftQuitQuickCaptureBlocked = !captureSaved
        draftQuitQuickCommandsBlocked = !commandsSaved
        draftQuitQuickTasksBlocked = quickEntry.workbench.hasUnsavedTaskEditorDraft
            || !quickEntry.taskDraft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
            || quickEntry.workbench.hasUnsavedTaskCreationFields
            || quickEntry.workbench.creating || !quickEntry.workbench.busyTaskIDs.isEmpty
        draftQuitQuickAgendaBlocked = quickAgenda.hasUnsavedEditorDraft || quickAgenda.saving
        draftQuitQuickLinksBlocked = !linksSaved
        draftQuitQuickRecordingsBlocked = !recordingsSaved
        draftQuitQuickVaultBlocked = !vaultSaved
        guard captureSaved && commandsSaved && linksSaved && recordingsSaved && vaultSaved && !draftQuitQuickTasksBlocked && !draftQuitQuickAgendaBlocked else{completeDraftQuit(token,success:false);return}
        guard let model else{completeDraftQuit(token,success:true);return}
        guard model.web.url != nil || model.agenda.hasUnsavedEditorDrafts else{completeDraftQuit(token,success:true);return}
        let timeout=DispatchWorkItem{[weak self] in self?.completeDraftQuit(token,success:false)}
        draftQuitTimeout=timeout;DispatchQueue.main.asyncAfter(deadline:.now()+8,execute:timeout)
        draftQuitTask=Task{@MainActor [weak self,weak model] in
            guard let model else{self?.completeDraftQuit(token,success:false);return}
            guard !model.agenda.hasUnsavedEditorDrafts else{self?.completeDraftQuit(token,success:false);return}
            do {
                let result=try await model.web.callAsyncJavaScript("""
                if (typeof window.flushLocalDrafts !== 'function') return true;
                return (await window.flushLocalDrafts()) === true;
                """,arguments:[:],in:nil,contentWorld:.page)
                self?.completeDraftQuit(token,success:(result as? Bool) == true && !model.agenda.hasUnsavedEditorDrafts)
            } catch {self?.completeDraftQuit(token,success:false)}
        }
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        if draftQuit.phase == .approved{return .terminateNow}
        // Dock/system termination also fails closed. Leave its transaction
        // before presenting a draft decision; no terminateLater modal loop.
        DispatchQueue.main.async{[weak self] in self?.requestQuit()}
        return .terminateCancel
    }
    private func terminateApproved(){
        // A sheet completion callback may run before AppKit removes its alert.
        // Wait until it has unwound before entering the approved transaction.
        DispatchQueue.main.async{[weak self] in
            guard self?.draftQuit.phase == .approved else{return}
            NativeDraftQuitSheet.View.allowApprovedTermination()
            NSApp.terminate(nil)
        }
    }
    private func completeDraftQuit(_ token:UUID,success:Bool){
        guard draftQuit.acknowledge(token,success:success) else{return}
        draftQuitTimeout?.cancel();draftQuitTimeout=nil;draftQuitTask=nil
        if success{terminateApproved();return}
        // A menu-bar quit may start while another application owns focus.
        restoreWorkspaceWindow()
        let alert=NSAlert();draftQuitAlert=alert;alert.alertStyle = .warning
        alert.messageText=nativeUI("还有修改尚未确认保存", "Changes have not been confirmed saved")
        alert.informativeText=nativeUI("AI Bro 尚未确认当前修改已保存到本机。请返回编辑，保存修改或等待保存完成后再退出；仍然退出可能丢失未保存的内容。", "AI Bro has not confirmed that your current changes are saved on this device. Return to editing to save them or wait for saving to finish before quitting. Quitting anyway may lose unsaved content.")
        alert.addButton(withTitle:nativeUI("返回编辑", "Return to editing"))
        alert.addButton(withTitle:nativeUI("仍然退出", "Quit anyway"))
        alert.buttons.first?.keyEquivalent="\r";alert.buttons.last?.keyEquivalent=""
        // The editor remains outside a termination transaction while this
        // ordinary child sheet asks whether to return or explicitly discard.
        let presentingWindow:NSWindow? = {
            guard var window=draftQuitWindow else{return nil}
            while let sheet=window.attachedSheet {window=sheet}
            return window
        }()
        let decision:(NSApplication.ModalResponse)->Void = {[weak self,weak presentingWindow] response in
            guard let self,self.draftQuit.decide(token,exit:response == .alertSecondButtonReturn) else{return}
            self.draftQuitAlert=nil
            if response != .alertSecondButtonReturn {
                let reopenCapture=self.draftQuitQuickCaptureBlocked
                let reopenCommands=self.draftQuitQuickCommandsBlocked
                let reopenTasks=self.draftQuitQuickTasksBlocked
                let reopenAgenda=self.draftQuitQuickAgendaBlocked
                let reopenLinks=self.draftQuitQuickLinksBlocked
                let reopenRecordings=self.draftQuitQuickRecordingsBlocked
                let reopenVault=self.draftQuitQuickVaultBlocked
                self.draftQuitQuickCaptureBlocked=false
                self.draftQuitQuickCommandsBlocked=false
                self.draftQuitQuickTasksBlocked=false
                self.draftQuitQuickAgendaBlocked=false
                self.draftQuitQuickLinksBlocked=false
                self.draftQuitQuickRecordingsBlocked=false
                self.draftQuitQuickVaultBlocked=false
                if let window=presentingWindow ?? self.draftQuitWindow {
                    if window.isMiniaturized{window.deminiaturize(nil)}
                    // Let AppKit end the alert's sheet session first, then
                    // return focus to the still-mounted agenda editor.
                    DispatchQueue.main.async {
                        if reopenCapture {self.quickEntry.showCapture()}
                        else if reopenCommands {
                            self.quickEntry.setHomeModule("commands",visible:true)
                            self.quickEntry.showPanel(section:.home)
                        } else if reopenTasks {self.quickEntry.showPanel(section:.tasks)}
                        else if reopenAgenda {self.quickEntry.showPanel(section:.agenda)}
                        else if reopenLinks {self.quickEntry.showPanel(section:.links)}
                        else if reopenRecordings {self.quickEntry.showPanel(section:.recordings)}
                        else if reopenVault {self.quickEntry.showPanel(section:.vault)}
                        else {window.makeKeyAndOrderFront(nil)}
                    }
                }
                NSApp.activate(ignoringOtherApps:true)
            }else{self.terminateApproved()}
        }
        if let window=presentingWindow {
            if window.isMiniaturized{window.deminiaturize(nil)};window.makeKeyAndOrderFront(nil)
            alert.beginSheetModal(for:window,completionHandler:decision)
        }else{decision(alert.runModal())}
    }
    func applicationWillTerminate(_ notification:Notification){voiceCommand?.invalidate();speechDictation?.shutdown();speechShortcut.setActive(false);quickExternalNotifications?.shutdown();quickTaskReminders?.shutdown();quickNotificationPanel?.stop();quickNotificationSources?.accept(nil);quickUtilities.onCommittedCompletion=nil;quickClipboard.shutdown();quickClipboardPasteBack.shutdown();quickVault.shutdown();quickFileShelf.setAvailable(false);quickMedia.shutdown();quickUtilities.setVisible(false);quickEntry.stop();quickEntrySubscriptions.removeAll();draftQuitTimeout?.cancel();draftQuitTask?.cancel();model?.stop()}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{!quickEntry.keepRunning}
}
@main struct AIBroApp:App {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @NSApplicationDelegateAdaptor(Delegate.self) var delegate
    @StateObject private var model=Workspace()
    var body:some Scene {WindowGroup("AI Bro"){MainView(model:model,quickEntry:delegate.quickEntry).background(NativeDraftQuitWindow(delegate:delegate)).frame(minWidth:950,minHeight:650).onAppear{delegate.model=model}}.defaultSize(width:1280,height:850).windowToolbarStyle(.unified).commands{CommandGroup(replacing:.appTermination){Button(nativeUI("退出 AI Bro", "Quit AI Bro")){delegate.requestQuit()}.keyboardShortcut("q",modifiers:.command)};CommandGroup(replacing:.appSettings){Button(nativeUI("设置…", "Settings…")){model.openWorkspaceSettings()}.keyboardShortcut(",",modifiers:.command).disabled(!model.ready || model.snapshot?.modalOpen == true);Button(nativeUI("打开灵动岛 / 快捷工作台…", "Open island / quick panel…")){delegate.quickEntry.showPanel(screenIntent: .pointerSummon)};Button(nativeUI("灵动岛设置…", "Island settings…")){delegate.quickEntry.showPanel(section:.settings,screenIntent: .pointerSummon)};Button(nativeUI("语音指令…", "Voice command…")){delegate.invokeVoiceCommand()}};CommandGroup(replacing:.newItem){Button(nativeUI("新对话", "New chat")){model.command("new")}.keyboardShortcut("n").disabled(!model.ready)};CommandGroup(after:.textEditing){Button(nativeUI("搜索与命令", "Search and commands")){model.command("search")}.keyboardShortcut("k",modifiers:.command).disabled(!model.ready)}}
    }

}
