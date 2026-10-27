import Foundation
import AppKit
import WebKit
import Combine

struct BrowserFailure: LocalizedError {
    let code: String
    let message: String
    var details: [String:Any] = [:]
    var errorDescription: String? { message }
}

@MainActor final class NativeBrowserTab: NSObject, ObservableObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id = UUID().uuidString
    let sessionID = UUID().uuidString
    let runID: String
    let conversationID: String
    let projectID: String
    let asksPermission: Bool
    let web: WKWebView
    let contentWorld = WKContentWorld.world(name:"AI Bro Browser Adapter")
    @Published var title = "网页"
    @Published var address = ""
    @Published var status = "ready"
    @Published var notice = ""
    @Published var pendingTitle = ""
    @Published var pendingDetail = ""
    @Published var paused = false
    @Published var snapshotID = ""
    private(set) var epoch = 0
    private var allowedOrigins = Set<String>()
    private var approve: ((Bool) -> Void)?
    // An approval question waits at most 10 minutes, then counts as a refusal.
    static let approvalTimeout:UInt64=600_000_000_000
    private var approvalGeneration=0
    private var approvalTimedOut=false
    private var pageWaiters: [UUID:CheckedContinuation<Void,Error>] = [:]
    private var handoffWaiters: [UUID:CheckedContinuation<Void,Error>] = [:]
    private var operationBusy = false
    private var cancelled = false
    private var closed = false
    private var adapter: String
    var forbiddenOrigin = ""
    var onChanged: (() -> Void)?

    init(owner:[String:Any],root:URL) {
        runID=owner["browserOwner"] as? String ?? owner["runId"] as? String ?? "manual"
        conversationID=owner["conversationId"] as? String ?? ""
        projectID=owner["projectId"] as? String ?? ""
        // Set only by the trusted workspace host when a task creates its tab.
        // Per-action requests and web content cannot widen this policy later.
        asksPermission=owner["browserPermission"] as? String == "ask"
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.tabFocusesLinks = true
        config.preferences.javaScriptCanOpenWindowsAutomatically=false
        web=WKWebView(frame:.zero,configuration:config)
        adapter=(try? String(contentsOf:root.appendingPathComponent("native/Resources/browser-dom.js"),encoding:.utf8)) ?? ""
        super.init()
        web.navigationDelegate=self;web.uiDelegate=self
        // No desktop/workspace handlers, preference injection, filesystem bridge or credentials.
        config.userContentController.addUserScript(WKUserScript(source:adapter,injectionTime:.atDocumentEnd,forMainFrameOnly:true,in:contentWorld))
        web.allowsBackForwardNavigationGestures=true
    }
    static func origin(_ url:URL) -> String { "\(url.scheme?.lowercased() ?? "")://\(url.host?.lowercased() ?? ""):\(url.port ?? (url.scheme == "https" ? 443:80))" }
    func checkedURL(_ raw:String) throws -> URL {
        guard let url=URL(string:raw),["http","https"].contains(url.scheme?.lowercased() ?? ""),url.host != nil,url.user == nil,url.password == nil else {throw BrowserFailure(code:"INVALID_URL",message:"只支持不含账号信息的 http/https 网页地址")}
        let workspace=URL(string:forbiddenOrigin)
        guard Self.origin(url) != forbiddenOrigin, url.port != workspace?.port else {throw BrowserFailure(code:"WORKSPACE_ORIGIN",message:"浏览器工具不能操作 AI Bro 的本机数据服务")}
        return url
    }
    func userNavigate(_ raw:String) {
        do {
            guard !cancelled && !closed else {throw BrowserFailure(code:"CANCELLED",message:"请新建网页标签；此任务已停止")}
            let url=try checkedURL(raw);allowedOrigins.insert(Self.origin(url));snapshotID="";address=url.absoluteString;status="loading";web.load(URLRequest(url:url))
        }catch{notice=error.localizedDescription}
    }
    func blockWorkspaceResources() async throws {
        guard let url=URL(string:forbiddenOrigin),let port=url.port else{return}
        // A remote page cannot use its own subresources to reach AI Bro's
        // loopback state/files endpoints, even without a main-frame navigation.
        let rule:[[String:Any]]=[["trigger":["url-filter":"^https?://[^/]+:"+String(port)+"/"],"action":["type":"block"]]]
        let json=String(decoding:try JSONSerialization.data(withJSONObject:rule),as:UTF8.self)
        let compiled=try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"AI-Bro-Workspace-"+String(port),encodedContentRuleList:json)
        if let compiled {web.configuration.userContentController.add(compiled)}
    }
    func check(_ request:[String:Any]) throws {
        guard !closed else {throw BrowserFailure(code:"TAB_CLOSED",message:"网页标签已关闭")}
        guard !cancelled else {throw BrowserFailure(code:"CANCELLED",message:"浏览器任务已停止")}
        guard (request["browserOwner"] as? String ?? request["runId"] as? String) == runID,request["conversationId"] as? String ?? "" == conversationID,request["projectId"] as? String ?? "" == projectID else {throw BrowserFailure(code:"WRONG_OWNER",message:"此网页不属于当前任务")}
    }
    func payload(_ extra:[String:Any]=[:]) -> [String:Any] {
        var result:[String:Any] = ["sessionId":sessionID,"tabId":id,"url":web.url?.absoluteString ?? address,"title":web.title ?? title,"status":closed ? "closed":cancelled ? "cancelled":paused ? "paused":status,"snapshotId":snapshotID,"browserOnly":true,"approvalPolicy":asksPermission ? "ask":"auto"]
        result.merge(extra){_,new in new};return result
    }
    private func changed() {onChanged?()}
    func decide(_ allow:Bool) {
        let callback=approve;approve=nil;pendingTitle="";pendingDetail=""
        callback?(allow);changed()
    }
    private func armApprovalTimeout() {
        approvalGeneration+=1;let generation=approvalGeneration
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds:Self.approvalTimeout)
            guard let self,self.approve != nil,self.approvalGeneration == generation else {return}
            self.approvalTimedOut=true;self.notice="等待你的允许超过 10 分钟，已按拒绝处理。";self.decide(false);self.approvalTimedOut=false
        }
    }
    private func approval(title:String,detail:String) async throws {
        guard asksPermission else {return}
        guard approve == nil else {throw BrowserFailure(code:"BUSY",message:"先处理当前浏览器审批")}
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
            pendingTitle=title;pendingDetail=detail;status="awaiting-approval"
            approve={ [weak self] yes in
                guard let self else {continuation.resume(throwing:BrowserFailure(code:"CANCELLED",message:"浏览器已结束"));return}
                self.status=self.closed ? "closed":self.cancelled ? "cancelled":self.paused ? "paused":"ready"
                if yes && !self.cancelled && !self.closed {continuation.resume()}
                else {continuation.resume(throwing:BrowserFailure(code:self.cancelled ? "CANCELLED":self.approvalTimedOut ? "APPROVAL_TIMEOUT":"DENIED",message:self.cancelled ? "浏览器任务已停止":self.approvalTimedOut ? "等待允许超过 10 分钟，已按拒绝处理":"已拒绝此浏览器操作"))}
            };armApprovalTimeout();changed()
        }
    }
    private func finishPage(_ error:Error? = nil) {
        let waiters=pageWaiters;pageWaiters.removeAll()
        for waiter in waiters.values {if let error {waiter.resume(throwing:error)}else{waiter.resume()}}
    }
    private func waitForPage() async throws {
        if !web.isLoading && status != "loading" && status != "awaiting-approval" {return}
        let key=UUID()
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
            pageWaiters[key]=continuation
            // 45 s of loading; time spent awaiting approval or with the user in control does not count.
            Task { @MainActor [weak self] in
                var loading:UInt64=0
                while loading < 45_000_000_000 {
                    try? await Task.sleep(nanoseconds:500_000_000)
                    guard let self,self.pageWaiters[key] != nil else {return}
                    if self.status != "awaiting-approval" && !self.paused {loading+=500_000_000}
                }
                if let waiter=self?.pageWaiters.removeValue(forKey:key) { waiter.resume(throwing:BrowserFailure(code:"NAVIGATION_TIMEOUT",message:"网页尚未加载完成，可查看页面后重试")) }
            }
        }
    }
    private func dom(_ expression:String,arguments:[String:Any]=[:]) async throws -> [String:Any] {
        do {
            return try await web.callAsyncJavaScript(expression,arguments:arguments,in:nil,contentWorld:contentWorld) as? [String:Any] ?? [:]
        } catch {throw BrowserFailure(code:"PAGE_ACTION_FAILED",message:error.localizedDescription)}
    }
    func request(_ request:[String:Any]) async throws -> [String:Any] {
        let action=request["action"] as? String ?? "status"
        if action == "cancel" {try checkOwner(request);stop();return payload()}
        if action == "close" {try checkOwner(request);stop(close:true);return payload()}
        try check(request)
        if action == "status" {return payload()}
        if action == "resume" {resume();return payload()}
        if action == "takeover" {
            takeOver()
            if request["waitForResume"] as? Bool == true {
                let key=UUID()
                try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in handoffWaiters[key]=continuation }
            }
            try check(request);return payload()
        }
        guard !paused else {throw BrowserFailure(code:"HUMAN_TAKEOVER",message:"用户正在操作网页；点击“完成，继续”后 AI 才可继续")}
        guard !operationBusy else {throw BrowserFailure(code:"BUSY",message:"已有浏览器操作正在等待完成")}
        operationBusy=true;defer {operationBusy=false;changed()}
        switch action {
        case "navigate", "open":
            if action == "open",(request["url"] as? String ?? "").isEmpty {return payload()}
            let url=try checkedURL(request["url"] as? String ?? "")
            // The workspace's site permission (browser plugin) already asked about this site.
            if request["siteApproved"] as? Bool == true {allowedOrigins.insert(Self.origin(url))}
            if !allowedOrigins.contains(Self.origin(url)) {
                try await approval(title:"允许此任务打开网站？",detail:url.absoluteString)
                try check(request);allowedOrigins.insert(Self.origin(url))
            }
            address=url.absoluteString;status="loading";snapshotID="";web.load(URLRequest(url:url));try await waitForPage();try check(request)
            return payload()
        case "back":
            guard web.canGoBack else {return payload(["notice":"没有上一页"])}
            status="loading";web.goBack();try await waitForPage();try check(request);return payload()
        case "reload":
            status="loading";web.reload();try await waitForPage();try check(request);return payload()
        case "snapshot":
            try await waitForPage();try check(request)
            guard web.url != nil else {throw BrowserFailure(code:"NO_PAGE",message:"请先打开网页")}
            let capturedEpoch=epoch,token=UUID().uuidString
            let value=try await dom("return globalThis.__aibroBrowserDOM.snapshot(token)",arguments:["token":token])
            try check(request);guard epoch == capturedEpoch else {throw BrowserFailure(code:"PAGE_CHANGED",message:"页面正在跳转，请重新查看")}
            snapshotID=token
            var result=value
            if request["screenshot"] as? Bool == true {
                guard web.window != nil,web.bounds.width > 10,web.bounds.height > 10 else {throw BrowserFailure(code:"NOT_VISIBLE",message:"请显示网页标签后再截图")}
                let config=WKSnapshotConfiguration();config.rect=web.bounds;config.snapshotWidth=NSNumber(value:min(1440,web.bounds.width))
                let shot=try await web.takeSnapshot(configuration:config)
                try check(request);guard epoch == capturedEpoch else {throw BrowserFailure(code:"PAGE_CHANGED",message:"截图期间页面改变，请重新查看")}
                guard let tiff=shot.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let bytes=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.8]) else {throw BrowserFailure(code:"SCREENSHOT_FAILED",message:"未获得真实页面截图")}
                result["imageDataUrl"]="data:image/jpeg;base64,"+bytes.base64EncodedString();result["imageWidth"]=bitmap.pixelsWide;result["imageHeight"]=bitmap.pixelsHigh
            }
            return payload(result)
        case "click", "type":
            guard request["snapshotId"] as? String == snapshotID,!snapshotID.isEmpty else {throw BrowserFailure(code:"STALE_SNAPSHOT",message:"页面观察已失效，请重新查看")}
            guard let ref=request["ref"] as? String,!ref.isEmpty else {throw BrowserFailure(code:"INVALID_REF",message:"需要最新页面返回的元素引用")}
            if action == "type" {guard let text=request["text"] as? String,text.count <= 12000 else {throw BrowserFailure(code:"INVALID_TEXT",message:"输入文本不得超过 12000 字符")}}
            let inspected=try await dom("return globalThis.__aibroBrowserDOM.inspect(request)",arguments:["request":request])
            guard inspected["sensitive"] as? Bool != true else {throw BrowserFailure(code:"HUMAN_REQUIRED",message:"密码由你在网页中填写，请使用人工接管")}
            let summary=(inspected["name"] as? String ?? ref)
            try await approval(title:action == "type" ? "允许填写网页？":"允许点击网页？",detail:action == "type" ? summary+"\n"+(request["text"] as? String ?? ""):summary)
            try check(request);guard !paused else {throw BrowserFailure(code:"HUMAN_TAKEOVER",message:"用户正在操作网页")}
            let result=try await dom("return globalThis.__aibroBrowserDOM.act(request)",arguments:["request":request]);snapshotID="";return payload(result)
        case "scroll":
            guard request["snapshotId"] as? String == snapshotID,!snapshotID.isEmpty else {throw BrowserFailure(code:"STALE_SNAPSHOT",message:"滚动前请先查看当前页面")}
            let x=(request["x"] as? NSNumber)?.doubleValue ?? 0,y=(request["y"] as? NSNumber)?.doubleValue ?? 0
            guard x.isFinite,y.isFinite,abs(x)<=4000,abs(y)<=4000 else {throw BrowserFailure(code:"INVALID_SCROLL",message:"滚动距离不得超过 4000 像素")}
            let result=try await dom("return globalThis.__aibroBrowserDOM.scroll(request)",arguments:["request":["x":x,"y":y]]);snapshotID="";return payload(result)
        default: throw BrowserFailure(code:"UNKNOWN_ACTION",message:"不支持此浏览器操作")
        }
    }
    func checkOwner(_ request:[String:Any]) throws {
        guard (request["browserOwner"] as? String ?? request["runId"] as? String) == runID,request["conversationId"] as? String ?? "" == conversationID,request["projectId"] as? String ?? "" == projectID else {throw BrowserFailure(code:"WRONG_OWNER",message:"此网页不属于当前任务")}
    }
    func takeOver() {paused=true;status="paused";snapshotID="";if approve != nil {decide(false)};notice="你正在操作此网页。完成后点击继续，AI 会重新读取页面。";changed()}
    func resume() {guard !cancelled && !closed else{return};paused=false;status="ready";snapshotID="";notice="";let waiters=handoffWaiters;handoffWaiters.removeAll();waiters.values.forEach{$0.resume()};changed()}
    func stop(close:Bool=false) {
        cancelled=true;closed=close;paused=false;status=close ? "closed":"cancelled";epoch+=1;snapshotID="";web.stopLoading()
        if approve != nil {decide(false)}
        let error=BrowserFailure(code:"CANCELLED",message:"浏览器任务已停止")
        finishPage(error);let waiters=handoffWaiters;handoffWaiters.removeAll();waiters.values.forEach{$0.resume(throwing:error)};notice="任务已停止；已发生的网页操作不会撤销。";changed()
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        guard let url=navigationAction.request.url else {decisionHandler(.cancel);return}
        if url.absoluteString == "about:blank" {decisionHandler(.allow);return}
        guard !cancelled && !closed,(try? checkedURL(url.absoluteString)) != nil,!navigationAction.shouldPerformDownload else {decisionHandler(.cancel);finishPage(BrowserFailure(code:"NAVIGATION_BLOCKED",message:"已阻止不支持的地址或自动下载"));return}
        // Subframes cannot carry the workspace bridge. Only request-approval mode
        // interrupts top-level navigation; automatic runs can follow links and redirects.
        guard navigationAction.targetFrame?.isMainFrame != false else {decisionHandler(.allow);return}
        let key=Self.origin(url)
        if !asksPermission || allowedOrigins.contains(key) {allowedOrigins.insert(key);decisionHandler(.allow);return}
        guard approve == nil else {decisionHandler(.cancel);return}
        pendingTitle="允许跳转到此网站？";pendingDetail=url.absoluteString;status="awaiting-approval"
        approve={ [weak self] yes in
            guard let self else {decisionHandler(.cancel);return}
            if yes && !self.cancelled {self.allowedOrigins.insert(key);self.status="loading";decisionHandler(.allow)}
            else {self.status=self.closed ? "closed":self.cancelled ? "cancelled":self.paused ? "paused":"ready";decisionHandler(.cancel);self.finishPage(BrowserFailure(code:self.approvalTimedOut ? "APPROVAL_TIMEOUT":"NAVIGATION_DENIED",message:self.approvalTimedOut ? "等待允许超过 10 分钟，已按拒绝处理":"网站跳转未获允许"))}
        };armApprovalTimeout();changed()
    }
    func webView(_ webView:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!) {epoch+=1;snapshotID="";status="loading";changed()}
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {title=webView.title ?? "网页";address=webView.url?.absoluteString ?? address;status=paused ? "paused":"ready";finishPage();changed()}
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error) {notice=error.localizedDescription;status="failed";finishPage(error);changed()}
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) {self.webView(webView,didFail:navigation,withError:error)}
    func webViewWebContentProcessDidTerminate(_ webView:WKWebView) {stop();notice="网页进程已结束，请新建浏览器任务。"}
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? {notice="网页请求打开新窗口；请在地址栏打开目标页面。";return nil}
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){notice=String(message.prefix(1000));completionHandler()}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){notice="页面确认需要人工处理："+String(message.prefix(500));completionHandler(false)}
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){notice="页面输入对话框需要人工处理："+String(prompt.prefix(500));completionHandler(nil)}
}

@MainActor final class NativeBrowser: ObservableObject {
    @Published var tabs:[NativeBrowserTab]=[]
    @Published var selectedID:String?
    @Published var visible=false
    private var cancelledOwners=Set<String>()
    private func ownerKey(_ request:[String:Any])->String {String(describing:request["runId"] ?? "manual")+"/"+String(describing:request["conversationId"] ?? "")}
    func request(_ request:[String:Any],root:URL,workspaceOrigin:URL?) async throws -> [String:Any] {
        let action=request["action"] as? String ?? "status"
        if action == "status",request["tabId"] == nil {return ["available":true,"backend":"native-webkit","browserOnly":true,"tabs":tabs.map{$0.payload()},"status":"ready"]}
        if action == "cancel",request["tabId"] == nil {
            cancelledOwners.insert(ownerKey(request))
            let owned=tabs.filter{$0.runID == (request["browserOwner"] as? String ?? request["runId"] as? String) && $0.conversationID == (request["conversationId"] as? String ?? "") && $0.projectID == (request["projectId"] as? String ?? "")}
            owned.forEach{$0.stop()};return ["status":"cancelled","cancelledTabs":owned.count]
        }
        let tab:NativeBrowserTab
        if action == "open",request["tabId"] == nil {
            guard !cancelledOwners.contains(ownerKey(request)) else {throw BrowserFailure(code:"CANCELLED",message:"浏览器任务已停止")}
            guard tabs.count < 6 else {throw BrowserFailure(code:"TAB_LIMIT",message:"最多保留 6 个网页标签，请先关闭不用的标签")}
            let next=NativeBrowserTab(owner:request,root:root);next.forbiddenOrigin=workspaceOrigin.map(NativeBrowserTab.origin) ?? ""
            if let url=request["url"] as? String,!url.isEmpty {_ = try next.checkedURL(url)}
            try await next.blockWorkspaceResources()
            guard !cancelledOwners.contains(ownerKey(request)) else {throw BrowserFailure(code:"CANCELLED",message:"浏览器任务已停止")}
            next.onChanged={ [weak self] in self?.objectWillChange.send() };tabs.append(next);selectedID=next.id;visible=true;tab=next
        } else {
            guard let id=request["tabId"] as? String,let existing=tabs.first(where:{$0.id==id}),request["sessionId"] as? String == existing.sessionID else {throw BrowserFailure(code:"UNKNOWN_TAB",message:"网页标签不存在或不属于当前浏览器会话")};tab=existing
        }
        try tab.checkOwner(request)
        if action == "open" || action == "takeover" {selectedID=tab.id;visible=true}
        if action == "snapshot",request["screenshot"] as? Bool == true,(!visible || selectedID != tab.id || tab.web.isHiddenOrHasHiddenAncestor || tab.web.window == nil) {throw BrowserFailure(code:"NOT_VISIBLE",message:"请在浏览器面板显示此任务的网页后再截图")}
        let result:[String:Any]
        do {result=try await tab.request(request)}
        catch {var failure=(error as? BrowserFailure) ?? BrowserFailure(code:"BROWSER_ERROR",message:error.localizedDescription);failure.details=tab.payload();throw failure}
        if action == "close" {tabs.removeAll{$0.id==tab.id};if selectedID==tab.id {selectedID=tabs.last?.id};if tabs.isEmpty {visible=false}}
        return result
    }
    func close(_ tab:NativeBrowserTab) {tab.stop(close:true);tabs.removeAll{$0.id==tab.id};if selectedID==tab.id{selectedID=tabs.last?.id};if tabs.isEmpty{visible=false}}
    func stopAll(){tabs.forEach{$0.stop()}}
}
