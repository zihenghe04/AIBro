import SwiftUI
import AppKit
import WebKit

struct Item: Identifiable, Decodable, Hashable { let id: String; let title: String; let workspace: String }
struct Snapshot: Decodable { let conversationLibrary:[ConversationEntry]?;let conversationFolders:[ConversationFolder]?; let tasks:[ContentRecord]?;let documents:[ContentRecord]?;let modalOpen:Bool?;let readingOpen:Bool?;let readerAvailable:Bool?; let projects: [Item]; let conversations: [Item]; let taskCount: Int; let noteCount: Int; let sourceCount: Int; let view: String; let conversationId: String; let busy: Bool; let projectId: String? }

@MainActor final class Workspace: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    @Published var conversationProjectFilter=""
    @Published var snapshot: Snapshot?
    @Published var selection: String? = "overview"
    @Published var error: String?
    @Published var ready = false
    @Published var spaceContent = false
    let agenda = AgendaStore()
    @Published var agendaSyncConflicts:[AgendaSyncConflict]=[]
    @Published var agendaSyncStatus=""
    var agendaSyncRunning=false
    var agendaSyncTimer:Timer?
    @Published var agendaDraft:AgendaEvent?
    @Published var agendaLinkedDetail:AgendaOccurrence?
    var returningFromModal = false
    var sawModal = false
    var historyReturnSelection:String?
    var historyWasOpen=false
    var pendingNavigation:(view:String,id:String?)?
    @Published var appearance = "system"
    var glassHost:WebGlassHost?
    let web: WKWebView
    var origin: URL?
    var backend: Process?
    var backendLifetime: Pipe?
    var log: FileHandle?
    let root: URL
    let dataDirectory:URL
    let production:Bool
    var desktop:NativeDesktop?
    var sessionLock:Int32 = -1
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
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
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
        agenda.onChanged = { [weak self] in self?.requestAgendaSync();self?.web.evaluateJavaScript("document.dispatchEvent(new Event('aibro-agenda-changed'))",completionHandler:nil) }
        config.userContentController.add(self, name: "workspace")
        config.userContentController.add(self,name:"glassRegions")
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/conversation-library.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/agenda-sync.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/agenda-ai.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js=try? String(contentsOf:root.appendingPathComponent("native/Resources/glass-regions.js"),encoding:.utf8){config.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentEnd,forMainFrameOnly:true))}
        if let js = try? String(contentsOf: root.appendingPathComponent("native/Resources/bridge.js"), encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
    }
    func reveal(_ type:String,_ id:String="") {
        spaceContent=true
        if type == "task" || type == "create-task" || type == "create-project-task" { returningFromModal=true;sawModal=false }
        command(type,id)
    }
    func start() async {
        guard backend == nil else { return }
        do {
            let data = dataDirectory
            try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
            if production {
                sessionLock=Darwin.open(data.appendingPathComponent("native-session.lock").path,O_CREAT|O_RDWR,0o600)
                guard sessionLock >= 0,flock(sessionLock,LOCK_EX|LOCK_NB)==0 else{throw AgendaError.message("AI Bro 已在运行，请返回现有窗口。")}
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
            origin = url; web.load(URLRequest(url: url))
        } catch { self.error = "无法启动 AI Bro：\(error.localizedDescription)"; backend?.terminate(); backend = nil }
    }
    func command(_ type: String, _ id: String = "") {
        guard ready else { return }
        if type=="view",id != "history" {pendingNavigation=(id,nil)}
        else if type=="project" {pendingNavigation=("project",id)}
        else if type=="conversation" {pendingNavigation=("agent",id)}
        else if ["new","new-project-conversation","new-research-conversation"].contains(type) {pendingNavigation=("agent",nil);selection="agent"}
        do {
            let bytes = try JSONSerialization.data(withJSONObject: ["type":type,"id":id])
            let json = String(decoding: bytes, as: UTF8.self)
            web.evaluateJavaScript("window.NativeShell?.perform(\(json))") { [weak self] result, error in
                if error != nil || (result as? Bool) != true { self?.error = "操作尚未完成，请等待内容就绪后重试。" }
            }
        } catch { self.error = error.localizedDescription }
    }
    func draftAgenda(_ id:String) throws {
        guard ready,agendaDraft == nil,let document=snapshot?.documents?.first(where:{$0.id==id && $0.kind=="note"}) else {throw AgendaError.message("来源笔记不可用，或已有日程正在编辑。")}
        var event=AgendaEvent();event.title=document.title;event.documentID=document.id;event.documentKind="note";event.projectID=document.projectId;event.source="随记";event.reminderMinutes=nil
        selection="agenda";agendaDraft=event
    }
    func reviewAgendaProposal(_ proposal:[String:Any]) throws {
        guard ready,agendaDraft == nil,let id=proposal["id"] as? String,id.hasPrefix("agenda_"),id.count<200,
              let title=proposal["title"] as? String,title.count<=200,let start=proposal["start"] as? Double,let end=proposal["end"] as? Double,start.isFinite,end.isFinite,
              let timeZone=proposal["timeZone"] as? String else{throw AgendaError.message("日程提案或来源不可用。")}
        let documentID=proposal["documentID"] as? String ?? ""
        let document=snapshot?.documents?.first(where:{$0.id==documentID && $0.kind=="note"})
        let messageSource=proposal["sourceMessageId"] as? String
        guard document != nil || (messageSource?.isEmpty == false && (proposal["conversationId"] as? String)?.isEmpty == false) else {throw AgendaError.message("日程来源不可用。")}
        if let existing=agenda.events.first(where:{$0.id==id}) {
            guard !existing.deleted else{throw AgendaError.message("此日程已取消，原提案不会自动重新创建。")}
            try openLinkedAgenda(id);return
        }
        var event=AgendaEvent();event.id=id;event.title=title;event.start=Date(timeIntervalSince1970:start/1000);event.end=Date(timeIntervalSince1970:end/1000);event.timeZone=timeZone
        event.frequency=proposal["frequency"] as? String ?? "none";event.interval=proposal["interval"] as? Int ?? 1;event.weekdays=proposal["weekdays"] as? [Int] ?? []
        event.count=proposal["count"] as? Int;if let until=proposal["until"] as? Double {event.until=Date(timeIntervalSince1970:until/1000)}
        event.reminderMinutes=proposal["reminderMinutes"] as? Int;event.location=proposal["location"] as? String ?? "";event.details=(proposal["details"] as? String ?? "")+"\n\n来源随记："+(proposal["quote"] as? String ?? "")
        event.documentID=documentID;event.documentKind=document == nil ? "":"note";event.projectID=document?.projectId ?? "";event.source=document == nil ? "对话":"随记"
        if document == nil {event.details=(proposal["details"] as? String ?? "")+"\n\n来源消息："+(proposal["quote"] as? String ?? "")}
        if proposal["endEstimated"] as? Bool == true {event.details += "\n结束时间未指定，默认时长1小时，请在保存前确认。"}
        try event.validate();selection="agenda";agendaDraft=event
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
    func setAppearance(_ value:String) {
        guard ["system","light","dark"].contains(value) else { return }
        guard appearance != value else{return}
        appearance=value;UserDefaults.standard.set(value,forKey:"NativePreviewAppearance")
        NSApp.appearance=value=="system" ? nil:NSAppearance(named:value=="light" ? .aqua:.darkAqua)
        command("theme",value=="system" ? (NSApp.effectiveAppearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua ? "dark":"light"):value)
    }
    func navigate(_ value: String?) {
        guard let value else { return }
        if ["overview","agenda","conversations","research-projects"].contains(value) { return }
        if value.hasPrefix("project:") { command("project",String(value.dropFirst(8))) }
        else if value.hasPrefix("chat:") { command("conversation",String(value.dropFirst(5))) }
        else { command("view",value) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,message.frameInfo.request.url?.host==origin?.host,message.frameInfo.request.url?.port==origin?.port else{return}
        if message.name=="glassRegions" {
            let data=try? JSONSerialization.data(withJSONObject:message.body)
            let regions=data.flatMap{try? JSONDecoder().decode([GlassRegion].self,from:$0)}
            let active=regions.map{glassHost?.apply($0) ?? false} ?? false
            if !active{glassHost?.clear()}
            web.evaluateJavaScript("window.NativeGlassSurface?.acknowledge(\(active ? "true":"false"))",completionHandler:nil)
            return
        }
        guard let data=try? JSONSerialization.data(withJSONObject:message.body),let value=try? JSONDecoder().decode(Snapshot.self,from:data) else{return}
        let first = !ready; snapshot = value; ready = true
        agenda.updateTasks(value.tasks ?? [])
        if selection == "history" {
            if value.modalOpen == true {historyWasOpen=true}
            else if historyWasOpen {historyWasOpen=false;selection=historyReturnSelection ?? "overview";historyReturnSelection=nil;pendingNavigation=nil}
        }
        if returningFromModal {
            if value.modalOpen == true { sawModal=true }
            else if sawModal { returningFromModal=false;sawModal=false;spaceContent=false }
        }
        if first {
            setAppearance(appearance)
            requestAgendaSync()
            agendaSyncTimer=Timer.scheduledTimer(withTimeInterval:10,repeats:true){[weak self]_ in Task{@MainActor in self?.requestAgendaSync()}}
        }
        let navigationReady = pendingNavigation.map { target in value.view == target.view && (target.id == nil || (target.view == "project" ? value.projectId : value.conversationId) == target.id) } ?? true
        if navigationReady {pendingNavigation=nil}
        if navigationReady && !["overview","history","agenda","conversations","research-projects"].contains(selection ?? "") {
            if value.view == "project", let id=value.projectId { selection="project:"+id }
            else if value.view == "agent" && !value.conversationId.isEmpty { selection="chat:"+value.conversationId }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == origin?.host && url.port == origin?.port && url.scheme == "http" { decisionHandler(navigationAction.shouldPerformDownload ? .download:.allow) }
        else if url.scheme == "blob" || url.scheme == "about" { decisionHandler(navigationAction.shouldPerformDownload ? .download:.allow) }
        else { if navigationAction.navigationType == .linkActivated && ["https","http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
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
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_NOTIFICATIONS"] == "1" {try await reminderQA(destination);return}
            let seed = try String(contentsOf:root.appendingPathComponent("native/Resources/qa-workspace.js"),encoding:.utf8)
            _ = try await web.evaluateJavaScript(seed)
            try await Task.sleep(nanoseconds:800_000_000)
            guard snapshot?.projects.first?.id == "native-qa" else { throw CocoaError(.validationMissingMandatoryProperty) }
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_CONTEXT"] == "1" {try await contextQA(destination);return}
            if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_OVERVIEW"] == "1" {
                let fixture=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-overview.js"),encoding:.utf8)
                _ = try await web.evaluateJavaScript(fixture)
                selection="overview";spaceContent=false
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
    func stop() { web.configuration.userContentController.removeScriptMessageHandler(forName:"workspace");web.configuration.userContentController.removeScriptMessageHandler(forName:"glassRegions");glassHost?.clear();try? backendLifetime?.fileHandleForWriting.close();backendLifetime=nil }
}
struct WebContent: NSViewRepresentable {
    let model: Workspace
    func makeNSView(context: Context) -> WebGlassHost {let host=WebGlassHost(web:model.web);model.glassHost=host;return host}
    func updateNSView(_ view: WebGlassHost, context: Context) {}
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
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var columns: NavigationSplitViewVisibility = .all
    @State private var conversationTarget:ConversationTarget?
    @State private var expandedProjects:Set<String>=[]
    @State private var archiveOpen=false
    @State private var sidebarFrames:[String:CGRect]=[:]
    var body: some View {
        NavigationSplitView(columnVisibility:$columns) {
            VStack(spacing: 0) {
                HStack(spacing:10) {
                    if let icon=NSImage(contentsOf:model.root.appendingPathComponent("app/ai-bro-icon.png")) { Image(nsImage:icon).resizable().frame(width:34,height:34).clipShape(RoundedRectangle(cornerRadius:9)) }
                    VStack(alignment:.leading,spacing:3) { Text("AI Bro").font(.system(size:18,weight:.semibold));Text(nativeUI("知识与行动，在一起", "Knowledge into action")).font(.system(size:10)).foregroundStyle(.secondary) }
                    Spacer()
                }.padding(.horizontal,20).padding(.top,10).padding(.bottom,24)
                Button { model.command("new");model.selection="agent" } label: {
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
                        nav(nativeUI("对话", "Chats"),"bubble.left.and.bubble.right","conversations")
                        nav(nativeUI("日程", "Agenda"),"calendar.badge.clock","agenda")
                        nav(nativeUI("随记", "Quick notes"),"note.text","captures")
                        sidebarHeading(nativeUI("空间", "Spaces"))
                        nav(nativeUI("日常", "Daily"),"calendar","daily");nav(nativeUI("课程", "Courses"),"books.vertical","courses");nav(nativeUI("科研", "Research"),"flask","research")
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
                                    Button(nativeUI("全部项目会话", "All project chats")){model.selection="conversations";model.conversationProjectFilter=item.id}.font(.system(size:10)).buttonStyle(.plain).foregroundStyle(.secondary).padding(.leading,32).padding(.vertical,6)
                                }
                            }
                        }
                        Divider().opacity(0.3).padding(.vertical,10)
                        nav(nativeUI("执行历史", "Run history"),"clock.arrow.circlepath","history");nav(nativeUI("回收站", "Trash"),"trash","trash")
                    }.padding(.horizontal,14).padding(.vertical,8)
                    }.coordinateSpace(name:"native-sidebar")
                        .onPreferenceChange(SidebarBounds.self){if sidebarFrames != $0 {sidebarFrames=$0}}
                }.scrollIndicators(.hidden)
                HStack { Button { openSettings() } label: { Label(nativeUI("设置", "Settings"),systemImage:"gearshape") }.buttonStyle(LiftStyle());Spacer();Text(model.production ? nativeUI("本机工作区", "Local workspace"):nativeUI("本地预览", "Local preview")).font(.caption2).foregroundStyle(.tertiary) }.padding(20)
            }.navigationSplitViewColumnWidth(min:220,ideal:250,max:330)
        } detail: {
            VStack(spacing:0) {
                if ["research","research-projects","wiki"].contains(model.selection ?? ""){ResearchNavigation(model:model)}
            ZStack {
                WebContent(model:model).opacity(nativeContent ? 0 : 1).allowsHitTesting(!nativeContent)
                if model.selection == "overview" { Overview(model:model).opacity(model.spaceContent ? 0:1).allowsHitTesting(!model.spaceContent) }
                if model.selection == "agenda" { AgendaView(model:model,store:model.agenda) }
                if model.selection == "conversations" {ConversationHub(model:model)}
                if model.selection == "research-projects" {ResearchProjects(model:model)}
                if let space=spaceName, !model.spaceContent { SpaceDashboard(model:model,space:space,projectID:dashboardProject).id(space+(dashboardProject ?? "")) }
                if !model.ready { ProgressView(nativeUI("正在启动本地工作区…", "Starting your local workspace…")).padding(24).background(.regularMaterial,in:RoundedRectangle(cornerRadius:16)) }
            }}.navigationTitle(title)
            .toolbar {
                if spaceName != nil && model.spaceContent { ToolbarItem { Button {model.spaceContent=false} label:{Label(nativeUI("空间总览", "Space overview"),systemImage:"chart.pie")} } }
                if !nativeContent && model.snapshot?.readerAvailable == true { ToolbarItem {Button {model.command("reader")} label:{Label(model.snapshot?.readingOpen == true ? nativeUI("收起阅读区", "Hide reading pane"):nativeUI("打开阅读区", "Open reading pane"),systemImage:"sidebar.right")}} }
                ToolbarItem { Button { model.command("new");model.selection="agent" } label: { Label(nativeUI("新对话", "New chat"),systemImage:"square.and.pencil") }.keyboardShortcut("n").disabled(!model.ready) }
                ToolbarItem { AppearanceControl(model:model) }
                ToolbarItem { Button { openSettings() } label: { Label(nativeUI("设置", "Settings"),systemImage:"gearshape") } }
            }
        }.environment(\.locale, NativeL10n.locale).navigationSplitViewStyle(.balanced).tint(.primary).onChange(of:model.selection){old,value in if value == "history"{model.historyReturnSelection=old;model.historyWasOpen=false};model.spaceContent=false;model.navigate(value)}
        .sheet(item:$conversationTarget){target in ConversationManager(model:model,target:target)}
        .sheet(isPresented:$archiveOpen){ConversationArchive(model:model)}
        .alert("AI Bro",isPresented:Binding(get:{model.error != nil},set:{if !$0 {model.error=nil}})){Button(nativeUI("好", "OK"),role:.cancel){model.error=nil}} message:{Text(model.error ?? "")}
        .task { await model.start(); await model.selfTest() }
    }
    var library:[ConversationEntry] {(model.snapshot?.conversationLibrary ?? []).sorted{($0.updatedAt ?? 0)>($1.updatedAt ?? 0)}}
    var sidebarSelection:String { ["wiki","research-projects"].contains(model.selection ?? "") ? "research":model.selection ?? ""}
    func conversationRow(_ item:ConversationEntry)->some View {
        HStack(spacing:0) {
            sidebarButton(item.title,"bubble.left","chat:"+item.id,StudioPalette.jade)
            Button{conversationTarget=ConversationTarget(item)}label:{Image(systemName:"ellipsis").frame(width:24,height:28)}.buttonStyle(.plain).foregroundStyle(.secondary).help(nativeUI("管理对话", "Manage chat"))
        }.draggable("aibro-chat:"+item.id).contextMenu {
            Button(nativeUI("重命名 / 移动", "Rename / Move")){conversationTarget=ConversationTarget(item)}
            Button(nativeUI("归档", "Archive")){Task{await model.manageConversation(["kind":"conversation","id":item.id,"action":"archive"])}}
            Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){conversationTarget=ConversationTarget(item)}
        }
    }
    var dashboardProject:String? {guard let selection=model.selection,selection.hasPrefix("project:") else{return nil};return String(selection.dropFirst(8))}
    var spaceName:String? {if let id=dashboardProject{return model.snapshot?.projects.first(where:{$0.id==id})?.workspace};return ["daily":"日常","courses":"课程","research":"科研"][model.selection ?? ""] }
    var nativeContent:Bool { if model.selection == "overview" && model.spaceContent {return false};return ["overview","agenda","conversations","research-projects"].contains(model.selection ?? "") || (spaceName != nil && !model.spaceContent) }
    var selectionTint:Color {if let space=spaceName{return StudioPalette.space(space)};return StudioPalette.jade}
    func sidebarHeading(_ title:String)->some View {Text(title).font(.system(size:10,weight:.medium)).foregroundStyle(.tertiary).padding(.horizontal,13).padding(.top,20).padding(.bottom,7)}
    func sidebarButton(_ name:String,_ icon:String,_ tag:String,_ tint:Color)->some View {
        Button {if tag=="conversations"{model.conversationProjectFilter=""};model.selection=tag} label:{SidebarEntry(title:name,icon:icon,selected:sidebarSelection==tag,tint:tint)}
            .buttonStyle(.plain).accessibilityAddTraits(sidebarSelection==tag ? .isSelected:[])
            .background(GeometryReader{geometry in Color.clear.preference(key:SidebarBounds.self,value:[tag:geometry.frame(in:.named("native-sidebar"))])})
    }
    func nav(_ name:String,_ icon:String,_ tag:String)->some View {sidebarButton(name,icon,tag,StudioPalette.space(name))}
    var title: String { if let value=model.selection,value.hasPrefix("project:") {return model.snapshot?.projects.first{$0.id==String(value.dropFirst(8))}?.title ?? nativeUI("项目", "Projects")};return ["wiki":nativeUI("科研 · 知识库", "Research · Knowledge base"),"research-projects":nativeUI("科研 · 研究项目", "Research · Projects"),"conversations":nativeUI("全部对话", "All chats"),"captures":nativeUI("随记", "Quick notes"),"agenda":nativeUI("日程中心", "Agenda"),"overview":nativeUI("总览", "Overview"),"dashboard":nativeUI("详细仪表板", "Detailed dashboard"),"agent":nativeUI("对话", "Chats"),"daily":nativeUI("日常", "Daily"),"courses":nativeUI("课程", "Courses"),"research":nativeUI("科研", "Research"),"history":nativeUI("执行历史", "Run history"),"trash":nativeUI("回收站", "Trash"),"settings":nativeUI("模型与知识库设置", "Models & knowledge settings")][model.selection ?? ""] ?? nativeUI("对话", "Chats") }
}
struct Overview: View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model: Workspace
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
                            HStack { Text(nativeUI("继续推进", "Pick up where you left off")).font(.system(size:18,weight:.semibold));Spacer();Button {model.selection="dashboard"} label:{Image(systemName:"arrow.up.right")}.buttonStyle(LiftStyle()).help(nativeUI("查看详细仪表板", "Open detailed dashboard")) }
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
    var hero:some View { StudioHero(model:model) }
    func metric(_ title:String,_ value:Int,_ symbol:String)->some View {
        VStack(alignment:.leading,spacing:11) { Label(title,systemImage:symbol).font(.system(size:11)).foregroundStyle(.secondary);Text(value,format:.number).font(.system(size:30,weight:.medium,design:.rounded)).monospacedDigit() }.frame(maxWidth:.infinity,alignment:.leading).padding(.leading,12)
    }
    func project(_ item:Item)->some View {
        Button { model.selection="project:"+item.id } label: {
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
                TimelineView(.animation(minimumInterval:1.0/20,paused:reduceMotion || !visible || scenePhase != .active)) { timeline in
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
                if expanded { Button {model.selection="dashboard"} label:{Image(systemName:"chart.bar.xaxis").frame(width:44,height:44)}.buttonStyle(LiftStyle()).glassEffect(.regular.interactive(),in:.circle).glassEffectID("dashboard",in:glassNamespace).help(nativeUI("详细仪表板", "Detailed dashboard")).accessibilityLabel(nativeUI("详细仪表板", "Detailed dashboard")) }
            }}
        } else {primaryAction.modifier(GlassSurface())}
    }
    var primaryAction:some View {
        Button {model.command("new");model.selection="agent"} label:{Label(nativeUI("开始对话", "Start a chat"),systemImage:"sparkle").font(.system(size:12,weight:.semibold)).padding(.horizontal,18).frame(height:44)}.buttonStyle(LiftStyle()).disabled(!model.ready)
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
struct Preferences:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    var body:some View {Form{Section(nativeUI("外观", "Appearance")){AppearanceChoices(model:model)}
    Section(nativeUI("模型与资料", "Models & sources")){Text(nativeUI("现有模型、检索和资料设置暂时由兼容界面承接。", "Manage models, retrieval and sources in workspace settings.")).foregroundStyle(.secondary);Button(nativeUI("打开模型与知识库设置", "Open models & knowledge settings")){model.selection="settings";model.command("view","settings");NSApp.keyWindow?.close()}}
    Section(nativeUI("原生界面", "Native interface")){LabeledContent(nativeUI("界面", "Interface"),value:"SwiftUI / AppKit + WKWebView");Text(model.production ? nativeUI("使用本机已有知识库。SwiftUI 承载导航与日程，对话和文档通过兼容界面提供。", "Uses your existing local knowledge base. Navigation and agenda use SwiftUI; chats and documents use the embedded workspace."):nativeUI("此预览使用独立工作区；不会覆盖现有资料。", "This preview uses an isolated workspace and preserves your existing data.")).foregroundStyle(.secondary)}}.environment(\.locale, NativeL10n.locale).formStyle(.grouped).frame(width:540,height:440)}
}
@MainActor final class Delegate:NSObject,NSApplicationDelegate {var model:Workspace?;func applicationDidFinishLaunching(_ notification:Notification){NSApp.setActivationPolicy(.regular);NSApp.activate(ignoringOtherApps:true)};func applicationWillTerminate(_ notification:Notification){model?.stop()};func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}}
@main struct AIBroApp:App {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @NSApplicationDelegateAdaptor(Delegate.self) var delegate
    @StateObject private var model=Workspace()
    var body:some Scene {WindowGroup("AI Bro"){MainView(model:model).frame(minWidth:950,minHeight:650).onAppear{delegate.model=model}}.defaultSize(width:1280,height:850).windowToolbarStyle(.unified).commands{CommandGroup(replacing:.newItem){Button(nativeUI("新对话", "New chat")){model.command("new");model.selection="agent"}.keyboardShortcut("n").disabled(!model.ready)}}
    Settings{Preferences(model:model)} }

}
