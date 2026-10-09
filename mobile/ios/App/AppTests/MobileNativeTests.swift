import XCTest
import Security
import PDFKit
import UIKit
@testable import App

final class MobileNativeTests: XCTestCase {
    func testPrivateNetworkRoutingAndSafeDiagnostics() {
        for raw in ["https://sync.example.ts.net", "https://SYNC.EXAMPLE.TS.NET.", "http://127.0.0.1:18787", "http://[::1]:18787"] {
            XCTAssertTrue(MobileBridge.usesPrivateRoute(URL(string: raw)!))
        }
        for raw in ["https://sync.example.com", "https://fake-ts.net", "https://sync.ts.net.attacker.test"] {
            XCTAssertFalse(MobileBridge.usesPrivateRoute(URL(string: raw)!))
        }
        XCTAssertEqual(MobileBridge.networkConfiguration(privateRoute: true).connectionProxyDictionary?.count, 0)
        XCTAssertNil(MobileBridge.networkConfiguration(privateRoute: false).connectionProxyDictionary)
        let error = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [NSLocalizedDescriptionKey: "private-token-must-not-leak"])
        XCTAssertTrue(MobileBridge.networkError(error).contains("-1200"))
        XCTAssertFalse(MobileBridge.networkError(error).contains("private-token"))
    }
    func testPrivateHTTPSHealthWhenConfigured() async throws {
        guard let raw = ProcessInfo.processInfo.environment["AIBRO_TEST_SYNC_URL"], let url = URL(string: raw) else { throw XCTSkip("Provide AIBRO_TEST_SYNC_URL for private-network acceptance") }
        XCTAssertTrue(MobileBridge.usesPrivateRoute(url))
        let session = URLSession(configuration: MobileBridge.networkConfiguration(privateRoute: true))
        defer { session.invalidateAndCancel() }
        let (data,response) = try await session.data(from: url.appendingPathComponent("v1/health"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual((try JSONSerialization.jsonObject(with:data) as? [String:Int])?["protocol"], 1)
    }
    func testSQLiteReopensAndRejectsBrokenReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = WorkspaceDatabase(directory: directory)
        let content = "{\"schema\":1,\"records\":{},\"cursor\":12,\"fixture\":\"保存后重开\"}"
        try database.save(content)
        XCTAssertEqual(try WorkspaceDatabase(directory: directory).load(), content)
        XCTAssertThrowsError(try database.save("invalid-json"))
        XCTAssertEqual(try database.load(), content)
    }
    func testAppGroupIsAvailableToRunningApp() throws {
        let directory = try XCTUnwrap(FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile"))
        let file = directory.appendingPathComponent("native-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let value = Data("分享扩展与小组件共享容器".utf8)
        try value.write(to: file, options: .atomic)
        XCTAssertEqual(try Data(contentsOf: file), value)
    }
    func testKeychainRoundtripUsesOnlyIsolatedFixture() throws {
        let account = UUID().uuidString
        let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"app.aibro.mobile.native-test", kSecAttrAccount as String:account]
        defer { SecItemDelete(query as CFDictionary) }
        var add = query
        add[kSecValueData as String] = Data("synthetic-session-only".utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
        var get = query; get[kSecReturnData as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(get as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(String(data: try XCTUnwrap(result as? Data), encoding: .utf8), "synthetic-session-only")
    }
    @MainActor func testPDFKitReadsGeneratedDocument() throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x:0,y:0,width:400,height:300))
        let data = renderer.pdfData { context in
            context.beginPage()
            ("AI Bro native PDF fixture" as NSString).draw(at: CGPoint(x:20,y:30), withAttributes:[.font:UIFont.systemFont(ofSize:16)])
        }
        let document = try XCTUnwrap(PDFDocument(data:data))
        XCTAssertTrue(document.string?.contains("native PDF fixture") == true)
    }
}

// Native WebKit acceptance of the bundled product DOM. This uses an ephemeral
// WKWebView + loopback static resources, never the host App's workspace/Keychain.
// It deliberately does not claim physical taps or Capacitor adapter acceptance.
import WebKit
import Network

// This observer listens to UIKit. Tests must never post synthetic keyboard
// notifications: that would not establish Capacitor's real resize behavior.
@MainActor private final class NativeKeyboardEvents047: NSObject {
    var shown: [CGRect] = []
    var hidden = 0
    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(didShow(_:)), name: UIResponder.keyboardDidShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didHide(_:)), name: UIResponder.keyboardDidHideNotification, object: nil)
    }
    @objc private func didShow(_ notification: Notification) {
        if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect { shown.append(frame) }
    }
    @objc private func didHide(_ notification: Notification) { hidden += 1 }
    func close() { NotificationCenter.default.removeObserver(self) }
}

extension MobileNativeTests {
    // Opt in only on a fresh, dedicated QA Simulator. Uses the actual App host,
    // packaged assets, MobileBridge/SQLite and Capacitor Keyboard plugin. No
    // replacement WebView, private focus APIs, CSS injection or posted events.
    @MainActor func testActualCapacitorKeyboardResizesAndRestoresComposers() async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_TEST_FRESH_KEYBOARD"] == "1" else {
            throw XCTSkip("Requires AIBRO_TEST_FRESH_KEYBOARD=1 and a fresh dedicated QA Simulator")
        }
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let database = WorkspaceDatabase(directory: directory)
        if let raw = try database.load() {
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
            guard (state["records"] as? [String: Any])?.isEmpty == true,
                  (state["drafts"] as? [String: Any])?.isEmpty == true,
                  (state["settings"] as? [String: Any])?.isEmpty == true,
                  state["binding"] == nil || state["binding"] is NSNull else {
                throw XCTSkip("Nonempty workspace preserved; use a fresh dedicated QA Simulator")
            }
        }
        let configURL = try XCTUnwrap(Bundle.main.url(forResource: "capacitor.config", withExtension: "json"))
        let config = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: Any])
        let plugins = try XCTUnwrap(config["plugins"] as? [String: Any])
        XCTAssertEqual((plugins["Keyboard"] as? [String: Any])?["resize"] as? String, "native")
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }.first { $0.isKeyWindow && $0.rootViewController is AIBroViewController })
        let controller = try XCTUnwrap(window.rootViewController as? AIBroViewController)
        let web = try XCTUnwrap(controller.webView)
        let events = NativeKeyboardEvents047()
        defer { web.endEditing(true); events.close() }
        var stage = "host ready", report: [[String: Any]] = []
        func phase(_ value: String) { stage = value; print("AIBRO_KEYBOARD047 phase: \(value)") }
        func js(_ source: String) async throws -> Any? {
            try await web.callAsyncJavaScript(source, arguments: [:], in: nil, contentWorld: .page)
        }
        func until(_ label: String, seconds: TimeInterval = 15, _ condition: () async throws -> Bool) async throws {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline {
                if try await condition() { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw NSError(domain: "ActualKeyboard047", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out at " + label])
        }
        func snapshot(_ name: String) async throws {
            let image: UIImage = try await withCheckedThrowingContinuation { continuation in
                web.takeSnapshot(with: nil) { image, error in
                    if let image { continuation.resume(returning: image) }
                    else { continuation.resume(throwing: error ?? NSError(domain: "snapshot", code: 1)) }
                }
            }
            let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        do {
            phase("host ready")
            _ = try await js("window.__keyboard047Errors=[];addEventListener('error',e=>window.__keyboard047Errors.push(String(e.message)));addEventListener('unhandledrejection',e=>window.__keyboard047Errors.push(String(e.reason?.message||e.reason)));return true;")
            try await until(stage, seconds: 60) { try await js("return location.protocol==='capacitor:' && window.Capacitor?.getPlatform()==='ios' && !!document.querySelector('#home-chat-text');") as? Bool == true }
            let fullHostHeight = web.frame.height
            for kind in ["home", "chat", "task", "event"] {
                let selector = ["home": "#home-chat-text", "chat": "#chat-text", "task": "#task-form [name=description]", "event": "#event-form [name=details]"][kind]!
                let form = ["home": "#home-chat-form", "chat": "#chat-form", "task": "#task-form", "event": "#event-form"][kind]!
                let isRecordForm = kind == "task" || kind == "event"
                if kind == "chat" {
                    phase("open actual empty conversation")
                    _ = try await js("document.querySelector('nav [data-tab=chat]').click(); return true;")
                    try await until(stage) { try await js("return !!document.querySelector('[data-action=new-chat]');") as? Bool == true }
                    _ = try await js("document.querySelector('[data-action=new-chat]').click(); return true;")
                    try await until(stage) { try await js("return !!document.querySelector('#chat-text');") as? Bool == true }
                }
                if isRecordForm {
                    phase(kind + " open actual new form")
                    _ = try await js("document.querySelector('nav [data-tab=today]').click();return true;")
                    try await until(stage) { try await js("return !!document.querySelector('.mobile-planner__modes button');") as? Bool == true }
                    let mode = kind == "task" ? "待办" : "日程"
                    _ = try await js("[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.startsWith('\(mode)')).click();return true;")
                    let label = kind == "task" ? "新建待办" : "新建日程"
                    try await until(stage) { try await js("return !!document.querySelector('.mobile-planner button[aria-label=\(label)]');") as? Bool == true }
                    _ = try await js("document.querySelector('.mobile-planner button[aria-label=\(label)]').click();return true;")
                    try await until(stage) { try await js("return !!document.querySelector('\(selector)');") as? Bool == true }
                    // New dialogs may autofocus their title. End that first
                    // responder before measuring this textarea's show/hide cycle.
                    web.endEditing(true)
                    try await until(kind + " unfocused form") {
                        guard abs(web.frame.height - fullHostHeight) <= 1 else { return false }
                        return try await js("return !document.body.classList.contains('keyboard-open');") as? Bool == true
                    }
                }
                let before = web.frame.height, shownBefore = events.shown.count, hiddenBefore = events.hidden
                let draft = "iOS 047 合成键盘草稿🙂 " + kind
                let encoded = String(data: try JSONSerialization.data(withJSONObject: draft, options: .fragmentsAllowed), encoding: .utf8)!
                phase(kind + " real keyboard show")
                // Modern WKWebView permits focus from native evaluateJavaScript.
                // If UIKit emits no show event, fail the gate instead of faking it.
                _ = try await web.evaluateJavaScript("(()=>{const t=document.querySelector('\(selector)');window.__keyboard047Input=t;t.value=\(encoded);t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.setSelectionRange(3,7);return true;})()")
                try await until(stage) {
                    events.shown.count > shownBefore && events.shown.last!.height > 120 && web.frame.height < before - 120
                }
                phase(kind + " resized DOM")
                let composerVisible = """
                      const t=document.querySelector('\(selector)'),f=document.querySelector('\(form)').getBoundingClientRect(),v=visualViewport;
                      return document.body.classList.contains('keyboard-open') && getComputedStyle(document.querySelector('nav')).display==='none'
                        && t===window.__keyboard047Input && t===document.activeElement && t.selectionStart===3 && t.selectionEnd===7
                        && Math.abs((v?.scale||1)-1)<0.01 && f.left>=0 && f.right<=innerWidth+1 && f.top>=-1 && f.bottom<=(v?.height||innerHeight)+(v?.offsetTop||0)+1;
                      """
                let recordVisible = """
                  const t=document.querySelector('\(selector)'),r=t.getBoundingClientRect(),s=document.querySelector('#sheet').getBoundingClientRect(),h=document.querySelector('#sheet .sheet-head').getBoundingClientRect(),v=visualViewport;
                  const top=Math.max(r.top,s.top,h.bottom,v?.offsetTop||0),bottom=Math.min(r.bottom,s.bottom,(v?.offsetTop||0)+(v?.height||innerHeight));
                  const style=getComputedStyle(t),line=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
                  const firstLine=r.top+(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.paddingTop)||0)+line/2-t.scrollTop;
                  const x=r.left+Math.min(32,r.width/2),points=[top+8,(top+bottom)/2,bottom-8,firstLine];
                  const footer=document.querySelector('.task-actions-root')?.getBoundingClientRect();
                  const footerOverlap=footer?Math.max(0,Math.min(bottom,footer.bottom)-Math.max(top,footer.top)):0;
                  window.__keyboard047FormBounds={textarea:{top:r.top,bottom:r.bottom,height:r.height},visible:{top,bottom,height:bottom-top},firstLine,footerOverlap,viewport:{height:v?.height||innerHeight,offset:v?.offsetTop||0},hit:points.map(y=>document.elementFromPoint(x,y)===t)};
                  return document.body.classList.contains('keyboard-open')&&t===document.activeElement&&t===window.__keyboard047Input
                    &&Math.abs((v?.scale||1)-1)<0.01&&r.left>=0&&r.right<=innerWidth+1&&t.selectionStart===3&&t.selectionEnd===7&&bottom-top>=Math.min(64,r.height)&&firstLine>=top&&firstLine<=bottom
                    &&footerOverlap<=1&&points.every(y=>document.elementFromPoint(x,y)===t);
                  """
                try await until(stage) {
                    guard abs(web.scrollView.zoomScale - 1) < 0.01 else { return false }
                    return try await js(isRecordForm ? recordVisible : composerVisible) as? Bool == true
                }
                let metrics = try await js("const r=document.querySelector('\(form)').getBoundingClientRect();return {innerHeight,innerWidth,visualHeight:visualViewport.height,visualScale:visualViewport.scale,inset:getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),formTop:r.top,formBottom:r.bottom};") as? [String: Any] ?? [:]
                var item: [String: Any] = ["kind": kind, "beforeHeight": before, "resizedHeight": web.frame.height, "keyboardHeight": events.shown.last!.height, "nativeZoomScale": web.scrollView.zoomScale, "metrics": metrics]
                if isRecordForm { item["inputVisibility"] = try await js("return window.__keyboard047FormBounds;") }
                report.append(item)
                try await snapshot("iOS-047-actual-capacitor-" + kind + "-keyboard")
                phase(kind + " real keyboard hide")
                web.endEditing(true)
                try await until(stage) {
                    events.hidden > hiddenBefore && abs(web.frame.height - before) <= 1 && abs(web.scrollView.zoomScale - 1) < 0.01
                }
                try await until(kind + " navigation restored") {
                    try await js("return !document.body.classList.contains('keyboard-open') && Math.abs(visualViewport.scale-1)<0.01 && getComputedStyle(document.querySelector('nav')).display!=='none' && document.querySelector('\(selector)').value===\(encoded);") as? Bool == true
                }
                if isRecordForm {
                    // Saving is a reachable scroll destination, not an overlay
                    // that must occupy the same short viewport as the input.
                    phase(kind + " save remains reachable after keyboard hide")
                    let saveGeometry = """
                    const b=document.querySelector('\(form) button[type=submit]'),s=document.querySelector('#sheet'),f=document.querySelector('.task-actions-root'),v=visualViewport;
                    const rect=e=>e?Object.fromEntries(['top','bottom','left','right','height','width'].map(k=>[k,e.getBoundingClientRect()[k]])):null;
                    const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                    return {button:rect(b),disabled:b.disabled,pointerEvents:getComputedStyle(b).pointerEvents,footer:rect(f),footerPosition:f?getComputedStyle(f).position:null,
                      sheet:{...rect(s),scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight},viewport:{height:v?.height,width:v?.width,scale:v?.scale,offset:v?.offsetTop,innerHeight,innerWidth,scrollY},hit:hit?.outerHTML?.slice(0,400),passed:r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1&&Math.abs((v?.scale||1)-1)<0.01&&b.contains(hit)};
                    """
                    var saveChecks: [[String: Any]] = []
                    saveChecks.append(["phase":"before-scroll", "geometry":try await js(saveGeometry) ?? [:]])
                    _ = try await js("const b=document.querySelector('\(form) button[type=submit]');b.scrollIntoView({block:'center'});return true;")
                    saveChecks.append(["phase":"after-center", "geometry":try await js(saveGeometry) ?? [:]])
                    _ = try await js("await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
                    let afterFrames = try await js(saveGeometry) as? [String: Any] ?? [:]
                    saveChecks.append(["phase":"after-two-frames", "geometry":afterFrames])
                    if afterFrames["passed"] as? Bool != true {
                        // A sticky footer is not a reliable scrollIntoView target.
                        // Scroll the actual user-scrollable sheet to its end.
                        _ = try await js("const s=document.querySelector('#sheet');s.scrollTop=s.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
                    }
                    saveChecks.append(["phase":"after-sheet-end", "geometry":try await js(saveGeometry) ?? [:]])
                    let geometryData = try JSONSerialization.data(withJSONObject:saveChecks,options:[.sortedKeys,.prettyPrinted])
                    let geometryAttachment = XCTAttachment(data:geometryData,uniformTypeIdentifier:"public.json")
                    geometryAttachment.name="iOS-047-"+kind+"-save-scroll-geometry";geometryAttachment.lifetime = .keepAlways;add(geometryAttachment)
                    try await snapshot("iOS-047-actual-capacitor-"+kind+"-keyboard-hidden-save")
                    try await until(stage) {
                        (try await js(saveGeometry) as? [String: Any])?["passed"] as? Bool == true
                    }
                    _ = try await js("document.querySelector('#sheet [data-action=close]').click();return true;")
                    try await until(kind + " close retains draft") { try await js("return !document.querySelector('#sheet').open;") as? Bool == true }
                }
                phase(kind + " durable draft")
                try await until(stage) {
                    guard let raw = try database.load(), let state = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                          let drafts = state["drafts"] as? [String: Any] else { return false }
                    if isRecordForm {
                        let raw = drafts["form:" + kind + ":new"] as? [String: Any]
                        let values = raw?["values"] as? [String: Any]
                        return values?[kind == "task" ? "description" : "details"] as? String == draft
                    }
                    return drafts.contains { key, value in key.hasPrefix(kind == "home" ? "home:" : "chat:") && value as? String == draft }
                }
            }
            let data = try JSONSerialization.data(withJSONObject: ["passed": true, "host": "AIBroViewController", "resize": "native", "checks": report], options: [.sortedKeys, .prettyPrinted])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "iOS-047-actual-keyboard-report"; attachment.lifetime = .keepAlways; add(attachment)
        } catch {
            let bounds = (try? await js("return JSON.stringify(window.__keyboard047FormBounds||null);")) as? String ?? "unavailable"
            let page = (try? await js("return JSON.stringify({url:location.href,ready:document.readyState,platform:window.Capacitor?.getPlatform?.(),native:window.Capacitor?.isNativePlatform?.(),app:document.querySelector('#app')?.innerText?.slice(0,500),errors:window.__keyboard047Errors,scripts:[...document.scripts].map(s=>({src:s.src,type:s.type}))});")) as? String ?? "unavailable"
            let diagnostic = "Stage: \(stage)\n\(error.localizedDescription)\nUIKit show events: \(events.shown.count), hide events: \(events.hidden), WebView height: \(web.frame.height)\nInput bounds: \(bounds)\nPage: \(page)\nNative URL: \(web.url?.absoluteString ?? "nil")"
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "iOS-047-actual-keyboard-failure"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail(diagnostic)
        }
    }
}

private final class NativeUIFixtureServer {
    private let root: URL
    private let queue = DispatchQueue(label: "app.aibro.tests.loopback")
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    init(root: URL) { self.root = root }
    func start() async throws -> URL {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            self.read(connection, received: Data())
        }
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            listener.stateUpdateHandler = { state in
                guard !finished else { return }
                switch state {
                case .ready:
                    finished = true
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")!)
                case .failed(let error): finished = true; continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }
    private func read(_ connection: NWConnection, received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var request = received; request.append(data ?? Data())
            guard request.count <= 16384, error == nil else { connection.cancel(); return }
            guard let head = String(data: request, encoding: .utf8), head.contains("\r\n\r\n") else {
                if !complete { self.read(connection, received: request) } else { connection.cancel() }
                return
            }
            let parts = head.components(separatedBy: "\r\n")[0].split(separator: " ")
            guard parts.count >= 2, parts[0] == "GET" else { connection.cancel(); return }
            let raw = String(parts[1]).components(separatedBy: "?")[0].removingPercentEncoding ?? ""
            let relative = raw == "/" ? "index.html" : String(raw.dropFirst())
            let file = self.root.appendingPathComponent(relative).standardizedFileURL
            let allowed = file.path.hasPrefix(self.root.standardizedFileURL.path + "/")
            let bytes = raw == "/__fixture_seed" ? Data("<!doctype html><title>isolated iOS fixture</title>".utf8) : allowed ? (try? Data(contentsOf: file)) : nil
            let mime = ["html":"text/html", "js":"text/javascript", "css":"text/css", "json":"application/json", "webmanifest":"application/manifest+json", "png":"image/png", "svg":"image/svg+xml", "woff2":"font/woff2"][file.pathExtension] ?? "application/octet-stream"
            let body = bytes ?? Data("Not found".utf8)
            let header = "HTTP/1.1 \(bytes == nil ? "404 Not Found" : "200 OK")\r\nContent-Type: \(raw == "/__fixture_seed" ? "text/html" : mime)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
    func stop() { queue.sync { listener?.stateUpdateHandler = nil; listener?.newConnectionHandler = nil; listener?.cancel(); connections.forEach { $0.cancel() }; connections.removeAll() } }
}

@MainActor private final class NativeUIFixture {
    let web: WKWebView
    let window: UIWindow
    let server: NativeUIFixtureServer
    var origin: URL!
    private weak var previousWindow: UIWindow?
    private let traceEnabled: Bool
    private var scriptNumber = 0
    private(set) var stage = "initializing fixture"
    init(responses: Bool = false, providerScript: String? = nil) throws {
        let script = providerScript ?? (responses ? Self.responsesFixtureScript : nil)
        traceEnabled = script != nil
        let root = try XCTUnwrap(Bundle.main.resourceURL?.appendingPathComponent("public"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path))
        server = NativeUIFixtureServer(root: root)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if let script {
            config.userContentController.addUserScript(WKUserScript(source: script,
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController.addUserScript(WKUserScript(source: #"""
          (() => {
            const RealDate = Date, stamp = new RealDate(2030, 0, 7, 12).getTime();
            class FixedDate extends RealDate { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return stamp; } }
            window.Date = FixedDate;
            window.__fixtureErrors = [];
            window.__fixtureDocument = String(Math.random());
            addEventListener('error', e => window.__fixtureErrors.push(String(e.message)));
            addEventListener('unhandledrejection', e => window.__fixtureErrors.push(String(e.reason?.message || e.reason)));
            const request = window.fetch.bind(window);
            window.fetch = (url, options) => {
              const target = typeof url === 'string' ? url : url.url;
              if (target !== window.__responsesFixtureURL && new URL(target, location.href).origin !== location.origin) {
                window.__fixtureErrors.push('external request blocked'); return Promise.reject(Error('Isolated fixture blocks external requests'));
              }
              return request(url, options);
            };
          })();
          """#, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 720), configuration: config)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first(where: { $0.isKeyWindow })
        window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(web)
        window.makeKeyAndVisible()
    }
    func close() {
        web.stopLoading(); web.removeFromSuperview(); window.isHidden = true
        previousWindow?.makeKeyAndVisible(); server.stop()
    }
    func phase(_ label: String) {
        stage = label
        if traceEnabled { print("AIBRO_RESPONSES_QA phase: \(label)") }
    }
    private func diagnosticError(_ error: Error) -> String {
        let native = error as NSError
        return "\(native.domain)/\(native.code): \(native.localizedDescription.prefix(600))"
    }
    @discardableResult func js(_ source: String) async throws -> Any? {
        scriptNumber += 1
        let number = scriptNumber
        if traceEnabled { print("AIBRO_RESPONSES_QA js \(number) start: \(stage)") }
        do {
            let result = try await web.callAsyncJavaScript(source, arguments: [:], in: nil, contentWorld: .page)
            if traceEnabled { print("AIBRO_RESPONSES_QA js \(number) done") }
            return result
        } catch {
            if traceEnabled { print("AIBRO_RESPONSES_QA js \(number) error: \(diagnosticError(error))") }
            throw error
        }
    }
    func failureDiagnostic(_ error: Error) async -> String {
        // This separate callback API records the page even if an async-script
        // bridge fails. Only this isolated synthetic page is inspected.
        let source = "JSON.stringify({url:location.href,ready:document.readyState,requests:window.__responsesRequests,errors:window.__fixtureErrors,documentProbe:window.__document044Probe,editors:[...document.querySelectorAll('#note-form textarea')].map(t=>({value:t.value,start:t.selectionStart,end:t.selectionEnd,disabled:t.disabled,active:document.activeElement===t,hidden:t.form.hidden})),controls:[...document.querySelectorAll('[data-document-control]')].map(b=>({name:b.dataset.documentControl,disabled:b.disabled,pressed:b.getAttribute('aria-pressed')})),body:document.body?.innerText?.slice(0,4000)})"
        let page: String = await withCheckedContinuation { continuation in
            web.evaluateJavaScript(source) { value, failure in
                continuation.resume(returning: value as? String ?? "Page diagnostic unavailable: \(failure?.localizedDescription ?? "empty result")")
            }
        }
        return "Stage: \(stage)\nOriginal error: \(diagnosticError(error))\n\(page)"
    }
    func expect<T: Equatable>(_ source: String, _ expected: T) async throws {
        let actual = try await js(source) as? T
        XCTAssertEqual(actual, expected)
    }
    func reload() async throws {
        let marker = try await js("return JSON.stringify(window.__fixtureDocument);") as? String ?? "null"
        web.reload()
        try await wait("window.__fixtureDocument !== \(marker) && document.querySelector('#home-chat-form')")
    }
    func wait(_ expression: String, seconds: TimeInterval = 20) async throws {
        if traceEnabled { print("AIBRO_RESPONSES_QA wait: \(expression)") }
        let deadline = Date().addingTimeInterval(seconds)
        var lastError = ""
        while Date() < deadline {
            do {
                if try await js("return !!(\(expression));") as? Bool == true { return }
            } catch { lastError = diagnosticError(error) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let text = (try? await js("return document.body?.innerText?.slice(0, 2500) || '';")) as? String ?? ""
        let message = "Timed out: \(expression)\nLast script error: \(lastError)\n\(text)"
        if traceEnabled { print("AIBRO_RESPONSES_QA \(message)") }
        throw NSError(domain: "NativeUIFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    func open(recurring: Bool = false) async throws {
        origin = try await server.start()
        web.load(URLRequest(url: origin.appendingPathComponent("__fixture_seed")))
        try await wait("document.title === 'isolated iOS fixture'")
        try await js(#"""
          const state = {schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{},blobs:{}};
          if (RECURRING_FIXTURE) {
            const start = new Date(2030,0,7,8).getTime(), until = new Date(2030,1,1,8).getTime();
            const event = {format:'aibro.agenda.v1', title:'合成重复课程', start, end:start+3600000,
              timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone, reminderMinutes:null,
              recurrence:{frequency:'weekly',interval:1,weekdays:[2,4,6],count:12,until},
              excluded:[start+2*86400000],completed:[start+4*86400000]};
            state.records['notes:synthetic_series'] = {data:{id:'synthetic_series',kind:'日程',title:event.title,content:JSON.stringify(event),projectId:null,createdAt:1,updatedAt:1},version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
          }
          await new Promise((resolve,reject) => {
            const request = indexedDB.open('aibro-mobile-v1',1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db=request.result, tx=db.transaction('state','readwrite'); tx.objectStore('state').put(state,'workspace'); tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error); };
          });
          return true;
          """#.replacingOccurrences(of: "RECURRING_FIXTURE", with: recurring ? "true" : "false"))
        web.load(URLRequest(url: origin))
        try await wait("document.querySelector('#home-chat-form')")
    }
    func expectDateInputsFit() async throws {
        let result = try await js("""
          const form = document.querySelector('#event-form').getBoundingClientRect();
          const inputs = [...document.querySelectorAll('#event-form input[type=\"datetime-local\"]')].map(input => {
            const r=input.getBoundingClientRect(); return {name:input.name,left:r.left,right:r.right,within:r.width>0&&r.left>=form.left-0.5&&r.right<=form.right+0.5};
          });
          return JSON.stringify({form:{left:form.left,right:form.right},inputs,passed:inputs.length===3&&inputs.every(input=>input.within)});
          """) as? String ?? "{}"
        let object = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any]
        guard object?["passed"] as? Bool == true else {
            throw NSError(domain: "NativeUIFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Date input exceeds form: " + result])
        }
    }
    func snapshot(_ name: String, test: XCTestCase) async throws {
        let image: UIImage = try await withCheckedThrowingContinuation { continuation in
            web.takeSnapshot(with: nil) { image, error in
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: error ?? NSError(domain: "snapshot", code: 1)) }
            }
        }
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; test.add(attachment)
    }
    func expectTaskDateInputFits() async throws {
        let result = try await js("""
          const sheet = document.querySelector('#sheet');
          const animations = sheet.getAnimations?.({subtree:true}) || [];
          await Promise.all(animations.filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const form=document.querySelector('#task-form'),input=form.querySelector('input[type="datetime-local"][name="due"]');
          const f=form.getBoundingClientRect(),r=input.getBoundingClientRect(),l=input.closest('label').getBoundingClientRect();
          const within=r.width>0&&r.left>=f.left-0.5&&r.right<=f.right+0.5&&r.left>=l.left-0.5&&r.right<=l.right+0.5;
          return JSON.stringify({input:{left:r.left,right:r.right,width:r.width},form:{left:f.left,right:f.right},label:{left:l.left,right:l.right},passed:within});
          """) as? String ?? "{}"
        if traceEnabled { print("AIBRO_RESPONSES_QA task-date-bounds: \(result)") }
        let object = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any]
        guard object?["passed"] as? Bool == true else {
            throw NSError(domain: "NativeUIFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Task date input exceeds form/label: " + result])
        }
    }
    static let stateReader = #"""
      const state = await new Promise((resolve,reject) => {
        const request=indexedDB.open('aibro-mobile-v1',1);request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{const db=request.result,tx=db.transaction('state'),get=tx.objectStore('state').get('workspace');get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);tx.oncomplete=()=>db.close();};
      });
      """#
    static let agendaClarificationFixtureScript = #"""
      (() => {
        const request = window.fetch.bind(window);
        window.__responsesFixtureURL = 'https://responses.fixture.invalid/v1/responses';
        window.__responsesRequests = 0;
        window.__agendaProviderPhases = [];
        const require = (condition, message) => { if (!condition) throw Error('Synthetic agenda provider: '+message); };
        const call = (id,name,args) => ({type:'function_call',id:'fc_'+id,call_id:id,name,arguments:JSON.stringify(args),status:'completed'});
        window.fetch = async (url, options) => {
          if ((typeof url === 'string' ? url : url.url) !== window.__responsesFixtureURL) return request(url,options);
          require(options.method==='POST' && options.headers.Authorization==='Bearer synthetic-ios-clarification-key','synthetic request');
          const body=JSON.parse(options.body),input=body.input;
          require(body.stream===true && body.store===false && body.model==='qa-ios-clarification' && Array.isArray(input),'Responses shape');
          require(body.tools.some(t=>t.name==='request_clarification') && body.tools.some(t=>t.name==='propose_changes'),'actual tool definitions');
          const users=input.filter(item=>item.role==='user'),prompt=users.at(-1)?.content;
          const results=input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
          let output,phase;
          if(prompt==='帮我新建日程：合成讨论，时间还没定') {
            require(results.length===0,'client must finish a validated clarification locally');
            phase='request-clarification';
            output=[call('clarify_ios_044','request_clarification',{kind:'agenda',operation:'create',fields:['start','end']})];
          } else {
            require(prompt==='2030年12月4日下午3点开始，持续1小时，上海时区','followup remains in original conversation');
            require(users.some(item=>item.content==='帮我新建日程：合成讨论，时间还没定'),'original mutation in actual history');
            require(input.some(item=>item.role==='assistant'&&String(item.content).includes('请补充日程')),'actual clarification retained in history');
            if(!results.length) {
              phase='propose-agenda';
              output=[call('plan_ios_044','propose_changes',{actions:[{operation:'create',kind:'agenda',changes:{
                title:'合成讨论',start:'2030-12-04T15:00:00+08:00',end:'2030-12-04T16:00:00+08:00',timeZone:'Asia/Shanghai',reminderMinutes:null
              }}]})];
            } else {
              require(results.length===1&&results[0].status==='awaiting_user_review'&&results[0].executed===false,'real unexecuted proposal');
              phase='review-summary';
              output=[{type:'message',id:'final_ios_044',role:'assistant',status:'completed',content:[{type:'output_text',text:'日程方案已准备，请审阅后确认。',annotations:[]}]}];
            }
          }
          window.__responsesRequests++;window.__agendaProviderPhases.push(phase);
          const events=[];
          output.forEach((item,output_index)=>{
            if(item.type==='function_call') {
              events.push({type:'response.output_item.added',output_index,item:{...item,arguments:'',status:'in_progress'}});
              const cut=Math.floor(item.arguments.length/2);
              for(const delta of [item.arguments.slice(0,cut),item.arguments.slice(cut)])events.push({type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta});
              events.push({type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments});
            }
            events.push({type:'response.output_item.done',output_index,item});
          });
          events.push({type:'response.completed',response:{status:'completed',output}});
          const encoder=new TextEncoder();let stopped=false;
          return new Response(new ReadableStream({async start(controller){
            try {for(const event of events){const bytes=encoder.encode('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
              for(let at=0;at<bytes.length;at+=71){if(stopped||options.signal?.aborted){controller.close();return;}controller.enqueue(bytes.slice(at,at+71));await new Promise(resolve=>setTimeout(resolve,2));}}
              controller.close();
            } catch(error){if(!stopped)controller.error(error);}
          },cancel(){stopped=true;}}),{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
        };
      })();
      """#
    // Only the synthetic provider is substituted. The bundled product still
    // runs fetchModelStream -> Responses parser -> tools -> review -> receipts.
    // This is not native HTTPS/Keychain/SQLite evidence; Android covers that gate.
    static let responsesFixtureScript = #"""
      (() => {
        const request = window.fetch.bind(window);
        window.__responsesFixtureURL = 'https://responses.fixture.invalid/v1/responses';
        window.__responsesRequests = 0;
        const require = (condition, message) => { if (!condition) throw Error('Synthetic Responses: ' + message); };
        const call = (id, name, args) => ({type:'function_call',id:'fc_'+id,call_id:id,name,arguments:JSON.stringify(args),status:'completed'});
        window.fetch = async (url, options) => {
          if ((typeof url === 'string' ? url : url.url) !== window.__responsesFixtureURL) return request(url, options);
          require(options.method === 'POST', 'POST required');
          require(options.headers.Authorization === 'Bearer synthetic-ios-responses-key', 'synthetic credential required');
          const body = JSON.parse(options.body);
          require(body.stream === true && body.store === false && body.model === 'qa-ios-responses', 'Responses request shape');
          require(body.tools.every(tool => tool.type === 'function' && tool.name && !tool.function), 'flat Responses tools');
          require(body.include.includes('reasoning.encrypted_content'), 'reasoning replay configuration');
          const results = body.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
          if (results.length) require(body.input.some(item => item.encrypted_content === 'qa-ios-opaque'), 'opaque reasoning replay');
          window.__responsesRequests++;
          let output;
          if (!results.length) output = [
            {type:'reasoning',id:'reasoning_ios',encrypted_content:'qa-ios-opaque',summary:[{type:'summary_text',text:'先核对合成目录，再准备审批。'}]},
            call('list_ios','workspace_list',{kind:'tasks'})
          ];
          else if (results.length === 1) {
            require(!results[0].error && Array.isArray(results[0].entries), 'real directory result');
            output = [call('plan_ios','propose_changes',{actions:[{operation:'create',kind:'tasks',changes:{title:'合成 iOS Responses 任务'}}]})];
          } else {
            require(results.length === 2 && results[1].executed === false && results[1].status === 'awaiting_user_review', 'actual unexecuted plan');
            output = [{type:'message',id:'final_ios',role:'assistant',status:'completed',content:[{type:'output_text',text:'我已替你保存，无需审批。',annotations:[]}]}];
          }
          const events = [];
          output.forEach((item, output_index) => {
            if (item.type === 'function_call') {
              events.push({type:'response.output_item.added',output_index,item:{...item,arguments:'',status:'in_progress'}});
              const cut = Math.floor(item.arguments.length / 2);
              for (const delta of [item.arguments.slice(0,cut),item.arguments.slice(cut)])
                events.push({type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta});
              events.push({type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments});
            }
            events.push({type:'response.output_item.done',output_index,item});
          });
          events.push({type:'response.completed',response:{status:'completed',output}});
          const encoder = new TextEncoder(); let stopped = false;
          return new Response(new ReadableStream({
            async start(controller) {
              try {
                for (const event of events) {
                  const bytes = encoder.encode('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
                  for (let at=0;at<bytes.length;at+=71) {
                    if (stopped || options.signal?.aborted) { controller.close(); return; }
                    controller.enqueue(bytes.slice(at,at+71));
                    await new Promise(resolve => setTimeout(resolve,2));
                  }
                }
                controller.close();
              } catch (error) { if (!stopped) controller.error(error); }
            }, cancel() { stopped = true; }
          }), {status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
        };
      })();
      """#
    func check(_ expression: String) async throws {
        let passed = try await js(Self.stateReader + "return !!(\(expression));") as? Bool
        XCTAssertEqual(passed, true, expression)
    }
}

extension MobileNativeTests {
    // Bundled WebKit + isolated IndexedDB only. A controlled incoming snapshot
    // is applied while the product page is unloaded; this is draft/UI coverage,
    // not a claim of native SQLite or real cloud transport acceptance.
    @MainActor func testBundledWebKitTaskEventDraftsAndParentReturn() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        func project() async throws {
            try await fixture.js("if(!document.querySelector('main[data-route=knowledge]'))document.querySelector('nav [data-tab=knowledge]').click();return true;")
            try await fixture.wait("document.querySelector('main[data-route=knowledge] [data-action=knowledge-mode][data-mode=projects]')")
            try await fixture.js("document.querySelector('[data-action=knowledge-mode][data-mode=projects]').click();return true;")
            try await fixture.wait("document.querySelector('[data-action=project][data-id=qa047_project]')")
            try await fixture.js("document.querySelector('[data-action=project][data-id=qa047_project]').click();return true;")
            try await fixture.wait("document.querySelector('#sheet [data-action=task][data-id=qa047_task]')")
        }
        func close() async throws {
            try await fixture.js("document.querySelector('#sheet .sheet-head [data-action=close]').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
        }
        func settle() async throws {
            try await fixture.js("await Promise.all((document.getAnimations?.()||[]).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
        }
        do {
            fixture.phase("047 seed synthetic project and original task")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title==='isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('projects',{id:'qa047_project',name:'合成父项目用于长标题返回层级验收',workspace:'科研'});
              put('tasks',{id:'qa047_task',title:'合成已有任务',description:'原始说明',projectId:'qa047_project',workspace:'科研',status:'in_progress',updatedAt:1});
              await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('#home-chat-form')")
            try await project()
            fixture.phase("047 new task keeps draft across full close and parent return")
            try await fixture.js("document.querySelector('#sheet [data-action=new-task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')")
            try await fixture.js("const f=document.querySelector('#task-form');f.elements.title.value='未保存的新任务';f.elements.description.value='合成任务草稿🙂';f.elements.description.dispatchEvent(new Event('input',{bubbles:true}));return true;")
            try await close()
            try await fixture.check("Object.keys(state.records).length===2&&state.drafts['form:task:new:qa047_project'].base===null&&state.drafts['form:task:new:qa047_project'].values.description==='合成任务草稿🙂'")
            try await project()
            try await fixture.js("document.querySelector('#sheet [data-action=new-task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form [name=description]')?.value==='合成任务草稿🙂'")
            try await fixture.expect("return document.querySelector('#task-form [name=title]').value;", "未保存的新任务")
            try await fixture.wait("document.querySelector('[data-form-draft-state=ready]')")
            try await settle()
            try await fixture.expect("const h=document.querySelector('#sheet .sheet-head');return [...h.querySelectorAll('button')].length===2&&[...h.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=320;});", true)
            try await fixture.snapshot("iOS-047-task-draft-parent-controls-320", test: self)
            try await fixture.js("document.querySelector('#sheet [data-action=sheet-back]').click();return true;")
            try await fixture.wait("document.querySelector('#sheet h2')?.textContent==='合成父项目用于长标题返回层级验收'&&document.querySelector('#sheet [data-action=task][data-id=qa047_task]')")
            try await fixture.js("document.querySelector('#sheet [data-action=task][data-id=qa047_task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form [name=description]')?.value==='原始说明'")
            try await fixture.js("const t=document.querySelector('#task-form [name=description]');t.value='未保存的旧版本草稿';t.dispatchEvent(new Event('input',{bubbles:true}));return true;")
            try await close()
            try await fixture.check("state.records['tasks:qa047_task'].data.description==='原始说明'&&state.drafts['form:task:record:qa047_task'].base.updatedAt===1")

            fixture.phase("047 new agenda raw datetime and repeating options survive reload")
            try await fixture.js("document.querySelector('nav [data-tab=today]').click();return true;")
            try await fixture.wait("document.querySelector('.mobile-planner button[aria-label=新建日程]')")
            try await fixture.js("document.querySelector('.mobile-planner button[aria-label=新建日程]').click();return true;")
            try await fixture.wait("document.querySelector('#event-form')")
            try await fixture.js(#"""
              const f=document.querySelector('#event-form');
              for(const [name,value] of Object.entries({title:'未保存的重复日程',start:'2030-01-02T15:00',end:'2030-01-02T16:00',details:' 保留第一行\n第二行🙂',frequency:'weekly',repeatCount:'8'}))f.elements[name].value=value;
              f.elements.frequency.dispatchEvent(new Event('change',{bubbles:true}));
              f.querySelector('[name=repeatDay][value="2"]').checked=true;
              f.dataset.weekdaysEdited='true';f.elements.details.dispatchEvent(new Event('input',{bubbles:true}));return true;
              """#)
            try await close()
            try await fixture.check("Object.keys(state.records).length===2&&state.drafts['form:event:new'].base===null&&state.drafts['form:event:new'].values.start==='2030-01-02T15:00'&&state.drafts['form:event:new'].values.repeatDays.includes('2')")
            try await fixture.reload()
            try await fixture.wait("document.querySelector('.mobile-planner button[aria-label=新建日程]')")
            try await fixture.js("document.querySelector('.mobile-planner button[aria-label=新建日程]').click();return true;")
            try await fixture.wait("document.querySelector('#event-form [name=title]')?.value==='未保存的重复日程'")
            try await fixture.expect(#"return document.querySelector('#event-form [name=details]').value===' 保留第一行\n第二行🙂';"#, true)
            try await fixture.expect("const f=document.querySelector('#event-form');return f.elements.start.value==='2030-01-02T15:00'&&f.elements.end.value==='2030-01-02T16:00'&&f.elements.frequency.value==='weekly'&&f.elements.repeatCount.value==='8'&&f.querySelector('[name=repeatDay][value=\"2\"]').checked;", true)
            try await settle(); try await fixture.expectDateInputsFit()
            try await fixture.snapshot("iOS-047-agenda-draft-reopened-320", test: self)
            try await close()

            fixture.phase("047 controlled incoming snapshot preserves the old draft baseline")
            // Unload the app first. Only the fixture's current record changes;
            // its real product-written drafts remain untouched.
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title==='isolated iOS fixture'")
            try await fixture.js(NativeUIFixture.stateReader + #"""
              const record=state.records['tasks:qa047_task'];record.data={...record.data,description:'同步后的最新说明',updatedAt:2};record.version=2;record.remote=structuredClone(record.data);record.dirty=false;
              await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('#home-chat-form')")
            try await project()
            try await fixture.js("document.querySelector('#sheet [data-action=task][data-id=qa047_task]').click();return true;")
            try await fixture.wait("document.querySelector('[data-form-draft-state=changed]')&&document.querySelector('#task-form button[type=submit]')?.disabled")
            try await fixture.expect("return document.querySelector('#task-form [name=description]').value;", "未保存的旧版本草稿")
            try await fixture.js("document.querySelector('#task-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true;")
            try await fixture.check("state.records['tasks:qa047_task'].data.description==='同步后的最新说明'&&state.drafts['form:task:record:qa047_task'].base.updatedAt===1&&state.drafts['form:task:record:qa047_task'].values.description==='未保存的旧版本草稿'")
            try await fixture.js("[...document.querySelectorAll('.form-draft-actions button')].find(b=>b.textContent==='查看最新内容').click();return true;")
            try await fixture.wait("document.querySelector('.form-latest')?.innerText.includes('同步后的最新说明')&&!document.querySelector('.form-latest').hidden")
            try await fixture.js("[...document.querySelectorAll('.form-draft-actions button')].find(b=>b.textContent==='返回草稿').click();return true;")
            try await fixture.wait("!document.querySelector('#task-form').hidden&&document.querySelector('#task-form [name=description]').value==='未保存的旧版本草稿'")
            try await settle(); try await fixture.snapshot("iOS-047-task-stale-draft-preserved-320", test: self)
            try await close()
            try await fixture.check("Object.keys(state.records).length===2&&state.drafts['form:task:new:qa047_project'].values.title==='未保存的新任务'&&state.drafts['form:event:new'].values.title==='未保存的重复日程'")
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            fixture.phase("047 isolated WebKit forms completed")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "iOS-047-form-navigation-failure"; attachment.lifetime = .keepAlways; add(attachment)
            throw error
        }
    }

    @MainActor func testBundledWebKitAgendaClarifiesThenCreatesReviewedResult() async throws {
        let fixture = try NativeUIFixture(providerScript: NativeUIFixture.agendaClarificationFixtureScript)
        defer { fixture.close() }
        do {
            fixture.phase("044 open synthetic model configuration")
            try await fixture.open()
            try await fixture.js("document.querySelector('header [data-tab=settings]').click();return true;")
            try await fixture.wait("document.querySelector('#model-form')")
            try await fixture.js("const f=document.querySelector('#model-form');f.elements.base.value='https://responses.fixture.invalid/v1';f.elements.model.value='qa-ios-clarification';f.elements.key.value='synthetic-ios-clarification-key';f.elements.format.value='responses';f.requestSubmit();return true;")
            try await fixture.wait("await (async()=>{" + NativeUIFixture.stateReader + "return document.querySelector('#model-form')?.elements.key.value===''&&state.settings.model?.model==='qa-ios-clarification'&&state.settings.model?.format==='responses';})()")
            try await fixture.js("document.querySelector('nav [data-tab=today]').click();return true;")
            try await fixture.wait("document.querySelector('#home-chat-form')")
            fixture.phase("044 request date clarification through actual provider")
            try await fixture.js("const t=document.querySelector('#home-chat-text');t.value='帮我新建日程：合成讨论，时间还没定';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#home-chat-form').requestSubmit();return true;")
            try await fixture.wait("!document.querySelector('#live-response')&&document.querySelector('.message.assistant')?.innerText.includes('请补充日程')")
            try await fixture.expect("return window.__responsesRequests;", 1)
            try await fixture.check("!Object.values(state.records).some(r=>!r.deleted&&r.data?.kind==='日程') && Object.values(state.records).some(r=>r.data?.role==='assistant'&&r.data.status==='completed'&&r.data.clarification?.status==='needs_input'&&!r.data.pendingPlan&&r.data.content.includes('尚未保存'))")
            try await fixture.expect("return !!document.querySelector('[data-action=review-plan]');", false)
            let savedConversationID = try await fixture.js(NativeUIFixture.stateReader + "return Object.values(state.records).find(r=>r.data?.clarification?.status==='needs_input').data.conversationId;")
            let conversationID = try XCTUnwrap(savedConversationID as? String)
            try await fixture.snapshot("iOS-044-agenda-clarification-320", test: self)
            fixture.phase("044 supplement time in same conversation and review proposal")
            try await fixture.js("const t=document.querySelector('#chat-text');t.value='2030年12月4日下午3点开始，持续1小时，上海时区';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chat-form').requestSubmit();return true;")
            try await fixture.wait("!document.querySelector('#live-response')&&document.querySelector('[data-action=review-plan]')")
            try await fixture.expect("return JSON.stringify(window.__agendaProviderPhases);", "[\"request-clarification\",\"propose-agenda\",\"review-summary\"]")
            try await fixture.check("!Object.values(state.records).some(r=>!r.deleted&&r.data?.kind==='日程') && Object.values(state.records).filter(r=>r.data?.role==='user').length===2 && Object.values(state.records).filter(r=>r.data?.role==='user').every(r=>r.data.conversationId==='\(conversationID)')")
            try await fixture.js("document.querySelector('[data-action=review-plan]').click();return true;")
            try await fixture.wait("document.querySelector('#apply-plan')")
            try await fixture.expect("const text=document.querySelector('.mobile-plan-review').innerText;return text.includes('合成讨论')&&text.includes('2030')&&text.includes('15:00')&&text.includes('16:00')&&text.includes('Asia/Shanghai');", true)
            fixture.phase("044 approve exact agenda and inspect persisted receipt")
            try await fixture.js("document.querySelector('#apply-plan').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open&&document.querySelector('.conversation-results[data-result-state=applied]')")
            try await fixture.check("(()=>{const events=Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程');if(events.length!==1)return false;const e=JSON.parse(events[0].data.content);const message=Object.values(state.records).find(r=>r.data?.pendingPlan?.status==='applied')?.data;return e.format==='aibro.agenda.v1'&&e.start===Date.parse('2030-12-04T15:00:00+08:00')&&e.end===Date.parse('2030-12-04T16:00:00+08:00')&&e.timeZone==='Asia/Shanghai'&&message.conversationId==='\(conversationID)'&&message.pendingPlan.receipts.length===1&&message.pendingPlan.receipts[0].id===events[0].data.id;})()")
            let savedNoteID = try await fixture.js(NativeUIFixture.stateReader + "return Object.values(state.records).find(r=>r.data?.pendingPlan?.status==='applied').data.pendingPlan.receipts[0].id;")
            let noteID = try XCTUnwrap(savedNoteID as? String)
            try await fixture.wait("document.querySelector('[aria-label=\"打开日程：合成讨论\"]')")
            try await fixture.js("document.querySelector('[aria-label=\"打开日程：合成讨论\"]').click();return true;")
            try await fixture.wait("document.querySelector('#event-form')?.dataset.new==='false'")
            try await fixture.expect("return document.querySelector('#sheet [data-action=delete-event]').dataset.id;", noteID)
            try await fixture.expect("return document.querySelector('#event-form [name=start]').value;", "2030-12-04T15:00")
            try await fixture.expect("return document.querySelector('#event-form [name=end]').value;", "2030-12-04T16:00")
            try await fixture.js("await Promise.all((document.getAnimations?.()||[]).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
            try await fixture.expect("const f=document.querySelector('#event-form').getBoundingClientRect();return ['start','end'].every(name=>{const i=document.querySelector('#event-form [name='+name+']'),r=i.getBoundingClientRect(),l=i.closest('label').getBoundingClientRect();return r.width>0&&r.left>=f.left-.5&&r.right<=f.right+.5&&r.left>=l.left-.5&&r.right<=l.right+.5;});", true)
            try await fixture.snapshot("iOS-044-agenda-result-320", test: self)
            fixture.phase("044 real home planner and reload retain same agenda identity")
            try await fixture.js("document.querySelector('#sheet [data-action=close]').click();document.querySelector('nav [data-tab=today]').click();return true;")
            try await fixture.wait("document.querySelector('#home-planner-day')")
            try await fixture.js("const d=new Date('2030-12-04T15:00:00+08:00'),v=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),i=document.querySelector('#home-planner-day');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,v);i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true;")
            try await fixture.wait("document.querySelector('[data-planner-type=event][data-planner-id=\"\(noteID)\"]')")
            try await fixture.reload()
            try await fixture.wait("document.querySelector('[data-action=conversation][data-id=\"\(conversationID)\"]')")
            try await fixture.js("document.querySelector('[data-action=conversation][data-id=\"\(conversationID)\"]').click();return true;")
            try await fixture.wait("document.querySelector('[aria-label=\"打开日程：合成讨论\"]')")
            try await fixture.js("document.querySelector('[aria-label=\"打开日程：合成讨论\"]').click();return true;")
            try await fixture.wait("document.querySelector('#event-form')")
            try await fixture.expect("return document.querySelector('#sheet [data-action=delete-event]').dataset.id;", noteID)
            try await fixture.check("Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程').length===1&&!JSON.stringify(state).includes('synthetic-ios-clarification-key')")
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            fixture.phase("044 agenda completed")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_AGENDA044_QA failure:\n\(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "iOS-044-agenda-failure"; attachment.lifetime = .keepAlways; add(attachment)
            throw error
        }
    }

    @MainActor func testBundledWebKitDocumentUndoSaveDiscussReturnsToSource() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        do {
            fixture.phase("044 seed isolated source document and origin discussion")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title==='isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('notes',{id:'qa044-note',title:'合成资料 A',content:'中文正文 👩🏽‍💻\n\n第二段资料',kind:'note',workspace:'科研',createdAt:1,updatedAt:1});
              put('conversations',{id:'qa044-origin',title:'原始讨论',workspace:'科研',createdAt:1,updatedAt:1});
              put('conversations',{id:'qa044-discussion',title:'资料讨论',workspace:'科研',createdAt:2,updatedAt:2,
                mobileContext:{version:1,keys:['notes:qa044-note'],source:{kind:'notes',id:'qa044-note',conversationId:'qa044-origin'}}});
              await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});
              return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('#home-chat-form')")
            try await fixture.js("document.querySelector('nav [data-tab=chat]').click();return true;")
            try await fixture.wait("document.querySelector('[data-action=conversation][data-id=qa044-discussion]')")
            try await fixture.js("document.querySelector('[data-action=conversation][data-id=qa044-discussion]').click();return true;")
            try await fixture.wait("document.querySelector('[data-document-control=source]')")
            try await fixture.js("document.querySelector('[data-document-control=source]').click();return true;")
            try await fixture.wait("document.querySelector('[data-document-control=read]')?.getAttribute('aria-pressed')==='true'")
            try await fixture.js("document.querySelector('[data-document-control=edit]').click();return true;")
            try await fixture.wait("document.querySelector('[data-document-control=edit]')?.getAttribute('aria-pressed')==='true'")
            fixture.phase("044 WebKit native edit command format undo redo")
            // Like the Android native fixture, establish the actual focused range
            // before a separate enabled-control click; iOS keyboard focus is async.
            try await fixture.wait("document.querySelector('[data-document-control=format-bold]')&&!document.querySelector('[data-document-control=format-bold]').disabled")
            try await fixture.js("const t=document.querySelector('#note-form [name=content]');window.__documentArea044=t;t.focus();t.setSelectionRange(0,4);t.dispatchEvent(new Event('select',{bubbles:true}));return true;")
            try await fixture.wait("(()=>{const t=document.querySelector('#note-form [name=content]');return document.activeElement===t&&t.selectionStart===0&&t.selectionEnd===4&&!document.querySelector('[data-document-control=format-bold]').disabled;})()")
            try await fixture.js("document.querySelector('[data-document-control=format-bold]').click();return true;")
            try await fixture.wait("document.querySelector('#note-form [name=content]')?.value==='**中文正文** 👩🏽‍💻\\n\\n第二段资料'")
            try await fixture.wait("document.querySelector('[data-document-control=format-undo]')&&!document.querySelector('[data-document-control=format-undo]').disabled")
            try await fixture.js("document.querySelector('[data-document-control=format-undo]').click();return true;")
            try await fixture.wait("document.querySelector('#note-form [name=content]')?.value==='中文正文 👩🏽‍💻\\n\\n第二段资料'")
            try await fixture.wait("document.querySelector('[data-document-control=format-redo]')&&!document.querySelector('[data-document-control=format-redo]').disabled")
            try await fixture.js("document.querySelector('[data-document-control=format-redo]').click();return true;")
            try await fixture.wait("document.querySelector('#note-form [name=content]')?.value==='**中文正文** 👩🏽‍💻\\n\\n第二段资料'")
            try await fixture.js("document.querySelector('[data-document-control=read]').click();return true;")
            try await fixture.wait("document.querySelector('#document-reader strong')?.textContent==='中文正文'")
            try await fixture.js("document.querySelector('[data-document-control=edit]').click();return true;")
            try await fixture.wait("document.querySelector('[data-document-control=discuss]')?.textContent==='保存并讨论'")
            try await fixture.expect("return window.__documentArea044===document.querySelector('#note-form [name=content]');", true)
            try await fixture.check("state.records['notes:qa044-note'].data.content==='中文正文 👩🏽‍💻\\n\\n第二段资料'&&state.drafts['editor:qa044-note'].values.content==='**中文正文** 👩🏽‍💻\\n\\n第二段资料'")
            fixture.phase("044 save exact draft before discussion and preserve return origin")
            try await fixture.js("document.querySelector('[data-document-control=discuss]').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open&&document.querySelector('[data-document-control=source]')?.textContent.includes('合成资料 A')")
            try await fixture.check("state.records['notes:qa044-note'].data.content==='**中文正文** 👩🏽‍💻\\n\\n第二段资料'&&!state.drafts['editor:qa044-note']&&Object.values(state.records).some(r=>r.data?.mobileContext?.source?.conversationId==='qa044-discussion'&&r.data.mobileContext.keys.join(',')==='notes:qa044-note')")
            let savedDiscussionID = try await fixture.js(NativeUIFixture.stateReader + "return Object.values(state.records).find(r=>r.data?.mobileContext?.source?.conversationId==='qa044-discussion').data.id;")
            let discussionID = try XCTUnwrap(savedDiscussionID as? String)
            try await fixture.reload()
            try await fixture.js("document.querySelector('nav [data-tab=chat]').click();return true;")
            try await fixture.wait("document.querySelector('[data-action=conversation][data-id=\"\(discussionID)\"]')")
            try await fixture.js("document.querySelector('[data-action=conversation][data-id=\"\(discussionID)\"]').click();return true;")
            try await fixture.wait("document.querySelector('[data-document-control=parent]')&&!document.querySelector('[data-document-control=parent]').disabled")
            try await fixture.js("document.querySelector('[data-document-control=parent]').click();return true;")
            try await fixture.wait("document.querySelector('.conversation-bar')?.innerText.includes('资料讨论')")
            try await fixture.wait("document.querySelector('[data-document-control=source]')&&!document.querySelector('[data-document-control=source]').disabled")
            try await fixture.js("document.querySelector('[data-document-control=source]').click();return true;")
            try await fixture.wait("document.querySelector('#document-reader strong')?.textContent==='中文正文'")
            try await fixture.expect("return document.querySelector('#sheet h2').textContent;", "合成资料 A")
            try await fixture.js("await Promise.all((document.getAnimations?.()||[]).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
            try await fixture.expect("return document.documentElement.scrollWidth<=innerWidth&&document.querySelector('#sheet').scrollWidth<=document.querySelector('#sheet').clientWidth;", true)
            try await fixture.snapshot("iOS-044-document-return-source-320", test: self)
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            fixture.phase("044 document completed")
        } catch {
            // Probe only a detached-from-product synthetic textarea after failure;
            // never use it to repair the product value or acceptance assertions.
            _ = try? await fixture.js("const original=document.querySelector('#note-form [name=content]'),before=original&&{value:original.value,start:original.selectionStart,end:original.selectionEnd,active:document.activeElement===original};const p=document.createElement('textarea');p.value='probe';document.body.append(p);p.focus();p.setSelectionRange(0,5);const returned=document.execCommand('insertText',false,'**probe**');window.__document044Probe={before,returned,value:p.value,start:p.selectionStart,end:p.selectionEnd};p.remove();return true;")
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_DOCUMENT044_QA failure:\n\(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "iOS-044-document-failure"; attachment.lifetime = .keepAlways; add(attachment)
            throw error
        }
    }

    @MainActor func testBundledWebKitReferenceRecoveryPreservesDraftAndSource() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        func openDiscussion() async throws {
            try await fixture.js("document.querySelector('nav [data-tab=chat]').click();return true;")
            try await fixture.wait("document.querySelector('[data-action=conversation][data-id=reference_discussion]')")
            try await fixture.js("document.querySelector('[data-action=conversation][data-id=reference_discussion]').click();return true;")
            try await fixture.wait("document.querySelector('#chat-text')")
        }
        do {
            fixture.phase("reference recovery: seed isolated unavailable reference and intact source")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title==='isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{'chat:reference_discussion':'未发送的中文草稿'},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('notes',{id:'reference_a',title:'合成来源 A',content:'来源正文不变',kind:'note',workspace:'科研'});
              put('notes',{id:'reference_b',title:'合成资料 B',content:'B 的正文',kind:'note',workspace:'科研'});
              put('notes',{id:'reference_private',title:'私密候选',kind:'note',private:true});
              put('notes',{id:'reference_conflict',title:'冲突候选',kind:'note'});
              state.records['notes:reference_conflict'].conflict={version:3,data:{id:'reference_conflict',title:'云端冲突候选'},deleted:false};
              put('conversations',{id:'reference_origin',title:'原对话'});
              put('conversations',{id:'reference_discussion',title:'引用恢复讨论',mobileContext:{version:1,keys:['notes:missing'],source:{kind:'notes',id:'reference_a',conversationId:'reference_origin'}}});
              await new Promise((resolve,reject)=>{const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});
              return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('#home-chat-form')")
            try await openDiscussion()
            try await fixture.wait("document.querySelector('#conversation-context-status-root')?.innerText.includes('1 项引用已不可用')")
            try await fixture.expect("return document.querySelector('.context-count').textContent;", "1 项引用待处理")
            try await fixture.expect("return document.querySelector('#chat-text').value;", "未发送的中文草稿")
            try await fixture.snapshot("iOS-reference-unavailable-320", test: self)
            fixture.phase("reference recovery: real picker excludes private/conflict and retains draft/source")
            try await fixture.js("[...document.querySelectorAll('#conversation-context-status-root button')].find(b=>b.textContent==='重新选择引用').click();return true;")
            try await fixture.wait("document.querySelector('#context-picker-list')")
            try await fixture.expect("return document.querySelector('[data-action=finish-context]').disabled;", true)
            try await fixture.expect("const t=document.querySelector('#context-picker-list').textContent;return !t.includes('私密候选')&&!t.includes('冲突候选');", true)
            try await fixture.js("document.querySelector('#context-picker-list [data-ref=\"notes:reference_b\"]').click();document.querySelector('[data-action=finish-context]').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open&&document.querySelector('.context-count')?.textContent==='1 项引用'")
            try await fixture.check("state.records['conversations:reference_discussion'].data.mobileContext.keys.join(',')==='notes:reference_b'&&state.records['conversations:reference_discussion'].data.mobileContext.source.id==='reference_a'&&state.drafts['chat:reference_discussion']==='未发送的中文草稿'")
            try await fixture.reload(); try await openDiscussion()
            try await fixture.expect("return document.querySelector('.context-count').textContent;", "1 项引用")
            try await fixture.wait("document.querySelector('[data-document-control=source]')&&!document.querySelector('[data-document-control=source]').disabled")
            try await fixture.js("document.querySelector('[data-document-control=source]').click();return true;")
            // Markdown emits a trailing newline outside its paragraph. Compare
            // the single paragraph and stored editor value, not container whitespace.
            try await fixture.wait("document.querySelector('#document-reader p')?.textContent==='来源正文不变'&&document.querySelector('#document-reader').children.length===1")
            try await fixture.expect("return document.querySelector('#note-form [name=content]').value;", "来源正文不变")
            try await fixture.js("document.querySelector('#sheet [data-action=close]').click();return true;")
            fixture.phase("reference recovery: empty selection cannot silently broaden knowledge")
            try await fixture.js("document.querySelector('[data-action=pick-context]').click();return true;")
            try await fixture.wait("document.querySelector('#context-picker-list [data-ref=\"notes:reference_b\"]')?.checked")
            try await fixture.js("document.querySelector('#context-picker-list [data-ref=\"notes:reference_b\"]').click();return true;")
            try await fixture.expect("return document.querySelector('[data-action=finish-context]').disabled;", true)
            try await fixture.check("state.records['conversations:reference_discussion'].data.mobileContext.keys.join(',')==='notes:reference_b'")
            try await fixture.js("document.querySelector('[data-action=use-knowledge-scope]').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open&&document.querySelector('.context-count')?.textContent==='全部知识'")
            try await fixture.check("state.records['conversations:reference_discussion'].data.mobileContext.keys.length===0&&state.records['conversations:reference_discussion'].data.mobileContext.source.id==='reference_a'&&state.drafts['chat:reference_discussion']==='未发送的中文草稿'")
            try await fixture.js("await Promise.all((document.getAnimations?.()||[]).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;")
            try await fixture.expect("return document.documentElement.scrollWidth<=innerWidth;", true)
            try await fixture.snapshot("iOS-reference-explicit-knowledge-320", test: self)
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_REFERENCE_QA failure:\n\(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "iOS-reference-failure"; attachment.lifetime = .keepAlways; add(attachment)
            throw error
        }
    }

    // The actual bundled UI uses its browser adapter in this isolated WK data
    // store. This verifies editor integration and reload, not native SQLite sync.
    @MainActor func testBundledWebKitManualEditorsPreserveMacFieldsAndRecoverDraft() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        func phase(_ value: String) {
            fixture.phase(value); print("AIBRO_EDITORS043_QA phase: \(value)")
        }
        func settle() async throws {
            try await fixture.js("""
              const animations=document.getAnimations?.() || [];
              await Promise.all(animations.filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              return true;
              """)
        }
        do {
            phase("seed isolated Mac task and legacy/changed note drafts")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title === 'isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('projects',{id:'qa043-project',name:'合成旧项目',workspace:'科研',status:'active',createdAt:1,updatedAt:1});
              put('tasks',{id:'qa043-task',title:'合成进行中任务',description:'Mac 原任务说明',workspace:'科研',status:'in_progress',completedAt:77,
                projectId:'qa043-project',project:'合成旧项目',priority:'high',customField:{origin:'synthetic-mac'},createdAt:1,updatedAt:2});
              for(const variant of ['legacy','changed']) {
                const base={id:'qa043-'+variant,title:'合成原资料 '+variant,content:'合成旧原文 '+variant,kind:'note',workspace:'科研',
                  projectId:'qa043-project',project:'合成旧项目',customField:{origin:'synthetic-mac',retained:true},createdAt:1,updatedAt:2};
                put('notes',{...base,content:'Mac 已更新的合成原文 '+variant,updatedAt:3});
                const values={title:'合成未保存草稿 '+variant,content:'手机保留的合成草稿 '+variant};
                state.drafts['editor:'+base.id]=variant==='legacy'?values:{format:'aibro.editor-draft.v1',kind:'note',base,values};
              }
              await new Promise((resolve,reject)=>{
                const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);
                r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');
                  t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};
              });
              return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('.mobile-planner__modes') && document.querySelector('#home-chat-form')")
            try await fixture.expect("return innerWidth;", 320)
            let originalNotes = try await fixture.js(NativeUIFixture.stateReader + "return JSON.stringify(['legacy','changed'].map(v=>state.records['notes:qa043-'+v].data));") as? String ?? ""
            XCTAssertFalse(originalNotes.isEmpty)

            phase("edit only description without rewriting Mac task status or completion history")
            try await fixture.js("[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.trim().startsWith('待办')).click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa043-task]')")
            try await fixture.js("document.querySelector('[data-planner-id=qa043-task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')?.dataset.id==='qa043-task' && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='保存任务')")
            try await fixture.expect("return document.querySelector('#task-form [name=status]').value;", "in_progress")
            try await fixture.js("const f=document.querySelector('#task-form');f.elements.description.value='只改说明，保留进行中与完成历史';f.elements.description.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='保存任务').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
            try await fixture.check("(()=>{const t=state.records['tasks:qa043-task'].data;return t.description==='只改说明，保留进行中与完成历史'&&t.status==='in_progress'&&t.completedAt===77&&t.projectId==='qa043-project'&&t.project==='合成旧项目'&&t.workspace==='科研'&&t.priority==='high'&&t.customField.origin==='synthetic-mac';})()")

            phase("explicit project detach clears stable ID and legacy display alias")
            try await fixture.js("document.querySelector('[data-planner-id=qa043-task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')?.dataset.id==='qa043-task' && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='保存任务')")
            try await fixture.expect("return document.querySelector('#task-form [name=project]').value;", "qa043-project")
            try await fixture.js("const f=document.querySelector('#task-form');f.querySelector('.task-properties').open=true;f.elements.project.value='';f.elements.project.dispatchEvent(new Event('change',{bubbles:true}));[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='保存任务').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
            try await fixture.check("(()=>{const t=state.records['tasks:qa043-task'].data;return t.projectId===null&&t.project===null&&t.workspace==='科研'&&t.status==='in_progress'&&t.completedAt===77;})()")
            try await fixture.js("document.querySelector('[data-planner-id=qa043-task]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form [name=project]')?.value==='' && document.querySelector('#task-form [name=status]')?.value==='in_progress'")
            try await fixture.js("document.querySelector('#task-form .task-properties').open=true;document.querySelector('#task-form [name=project]').scrollIntoView({block:'center'});return true;")
            try await settle()
            try await fixture.snapshot("iOS-043-manual-task-detached-320", test: self)
            try await fixture.js("document.querySelector('#sheet [data-action=close]').click();return true;")

            for variant in ["legacy", "changed"] {
                phase("protect \(variant) draft and preview current original")
                let sourceDraft = try await fixture.js(NativeUIFixture.stateReader + "return JSON.stringify(state.drafts['editor:qa043-\(variant)']);") as? String ?? ""
                XCTAssertFalse(sourceDraft.isEmpty)
                try await fixture.js("document.querySelector('nav [data-tab=knowledge]').click();return true;")
                try await fixture.wait("document.querySelector('[data-action=note][data-id=qa043-\(variant)]')")
                try await fixture.js("document.querySelector('[data-action=note][data-id=qa043-\(variant)]').click();return true;")
                try await fixture.wait("document.querySelector('[data-editor-recovery=\(variant)]') && [...document.querySelectorAll('#editor-recovery-root button')].some(b=>b.textContent.trim()==='另存为新资料')")
                try await fixture.expect("return document.querySelector('#sheet article.reader').textContent.trim();", "手机保留的合成草稿 \(variant)")
                try await fixture.js("document.querySelector('#sheet [data-document-control=edit]').click();return true;")
                try await fixture.wait("document.querySelector('#note-form [name=content]')?.disabled===true && document.querySelector('#editor-recovery-root button')")
                try await fixture.expect("return document.querySelector('#note-form [name=content]').value;", "手机保留的合成草稿 \(variant)")
                try await fixture.expect("return [...document.querySelectorAll('#note-form input,#note-form textarea,#note-form button')].every(control=>control.disabled);", true)
                try await fixture.js("[...document.querySelectorAll('#editor-recovery-root button')].find(b=>b.textContent.trim()==='查看最新内容').click();return true;")
                try await fixture.wait("document.querySelector('#sheet article.reader')?.textContent.trim()==='Mac 已更新的合成原文 \(variant)' && document.querySelector('#editor-recovery-root button')")
                try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(state.drafts['editor:qa043-\(variant)']);", sourceDraft)
                try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(['legacy','changed'].map(v=>state.records['notes:qa043-'+v].data));", originalNotes)
                try await settle()
                try await fixture.snapshot("iOS-043-\(variant)-draft-current-preview-320", test: self)
                try await fixture.js("document.querySelector('#sheet [data-action=close]').click();return true;")

                phase("reload \(variant) draft without adopting the newer original as its baseline")
                try await fixture.reload()
                try await fixture.js("document.querySelector('nav [data-tab=knowledge]').click();return true;")
                try await fixture.wait("document.querySelector('[data-action=note][data-id=qa043-\(variant)]')")
                try await fixture.js("document.querySelector('[data-action=note][data-id=qa043-\(variant)]').click();return true;")
                try await fixture.wait("document.querySelector('[data-editor-recovery=\(variant)]') && [...document.querySelectorAll('#editor-recovery-root button')].some(b=>b.textContent.trim()==='另存为新资料')")
                try await fixture.expect("return document.querySelector('#sheet article.reader').textContent.trim();", "手机保留的合成草稿 \(variant)")
                try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(state.drafts['editor:qa043-\(variant)']);", sourceDraft)
                try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(['legacy','changed'].map(v=>state.records['notes:qa043-'+v].data));", originalNotes)

                phase("explicitly save \(variant) draft as a separate record")
                try await fixture.js("[...document.querySelectorAll('#editor-recovery-root button')].find(b=>b.textContent.trim()==='另存为新资料').click();return true;")
                try await fixture.wait("!document.querySelector('#editor-recovery-root') && document.querySelector('#sheet .sheet-head h2')?.textContent==='合成未保存草稿 \(variant)（草稿副本）' && document.querySelector('#sheet article.reader')?.textContent.trim()==='手机保留的合成草稿 \(variant)'")
                try await fixture.check("(()=>{const copies=Object.values(state.records).filter(r=>!r.deleted&&r.data?.title==='合成未保存草稿 \(variant)（草稿副本）');return copies.length===1&&copies[0].data.id!=='qa043-\(variant)'&&copies[0].data.content==='手机保留的合成草稿 \(variant)'&&!Object.hasOwn(state.drafts,'editor:qa043-\(variant)');})()")
                try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(['legacy','changed'].map(v=>state.records['notes:qa043-'+v].data));", originalNotes)
                try await settle()
                try await fixture.snapshot("iOS-043-\(variant)-draft-saved-copy-320", test: self)
                try await fixture.js("document.querySelector('#sheet [data-action=close]').click();return true;")
            }
            phase("reload and verify both original notes, two copies, and detached task remain durable")
            try await fixture.reload()
            try await fixture.check("(()=>{const t=state.records['tasks:qa043-task'].data;return t.status==='in_progress'&&t.completedAt===77&&t.projectId===null&&t.project===null&&t.description==='只改说明，保留进行中与完成历史'&&Object.entries(state.records).filter(([key,r])=>key.startsWith('notes:')&&!r.deleted).length===4&&['legacy','changed'].every(v=>!Object.hasOwn(state.drafts,'editor:qa043-'+v)&&Object.values(state.records).filter(r=>!r.deleted&&r.data?.title==='合成未保存草稿 '+v+'（草稿副本）'&&r.data.content==='手机保留的合成草稿 '+v).length===1)&&!state.settings.model&&state.binding===null;})()")
            try await fixture.expect(NativeUIFixture.stateReader + "return JSON.stringify(['legacy','changed'].map(v=>state.records['notes:qa043-'+v].data));", originalNotes)
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            phase("completed")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_EDITORS043_QA failure: \(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic)
            attachment.name = "iOS-043-manual-editors-failure-stage"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail(diagnostic)
        }
    }

    @MainActor func testBundledWebKitHomeTasksLegacyChecklistAndCompletion() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        func phase(_ value: String) {
            fixture.phase(value); print("AIBRO_HOME042_QA phase: \(value)")
        }
        func settle() async throws {
            try await fixture.js("""
              const animations=document.getAnimations?.() || [];
              await Promise.all(animations.filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              return true;
              """)
        }
        func taskDateBounds() async throws {
            try await settle()
            let raw = try await fixture.js("""
              const form=document.querySelector('#task-form'), f=form.getBoundingClientRect();
              const inputs=[...form.querySelectorAll('input[type="datetime-local"]')].map(input=>{
                const r=input.getBoundingClientRect(),l=input.closest('label').getBoundingClientRect();
                return {name:input.name,left:r.left,right:r.right,width:r.width,label:{left:l.left,right:l.right},
                  within:r.width>0&&r.left>=f.left-0.5&&r.right<=f.right+0.5&&r.left>=l.left-0.5&&r.right<=l.right+0.5};
              });
              return JSON.stringify({viewport:innerWidth,form:{left:f.left,right:f.right},inputs,
                passed:innerWidth===320&&inputs.length===2&&inputs.every(input=>input.within)&&f.left>=-0.5&&f.right<=innerWidth+0.5});
              """) as? String ?? "{}"
            print("AIBRO_HOME042_QA task-date-bounds: \(raw)")
            let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            guard result?["passed"] as? Bool == true else {
                throw NSError(domain: "NativeHome042Fixture", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Task datetime control exceeds its form/label: " + raw])
            }
        }
        do {
            phase("seed isolated legacy Mac-shaped tasks before loading product")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title === 'isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{},drafts:{},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('tasks',{id:'qa042-undated',title:'整理合成阅读清单',description:'保留问题与原文页码，准备下一次讨论。',workspace:'科研',status:'todo',
                checklist:[{id:'mac-1',title:'核对原文',done:false,sourceId:'paper-a',meta:{origin:'synthetic-mac',order:7}},'列出问题'],
                customField:'preserve',createdAt:1,updatedAt:1});
              put('tasks',{id:'qa042-done',title:'合成已完成摘要',status:'done',completedAt:2,createdAt:1,updatedAt:2});
              put('tasks',{id:'qa042-date-only',title:'提交合成读书报告',workspace:'课程',status:'todo',dueAt:'2030-01-06',priority:'high',createdAt:2,updatedAt:2});
              const start=new Date(2030,0,7,15).getTime(),event={format:'aibro.agenda.v1',title:'合成首页读书会',start,end:start+3600000,
                timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,allDay:false,reminderMinutes:null};
              put('notes',{id:'qa042-agenda',kind:'日程',title:event.title,content:JSON.stringify(event),projectId:null,createdAt:1,updatedAt:1});
              await new Promise((resolve,reject)=>{
                const r=indexedDB.open('aibro-mobile-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);
                r.onsuccess=()=>{const db=r.result,t=db.transaction('state','readwrite');t.objectStore('state').put(state,'workspace');
                  t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};
              });
              return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('.mobile-planner [data-planner-id=qa042-agenda]') && document.querySelector('#home-chat-form')")
            try await fixture.expect("return innerWidth;", 320)
            try await fixture.check("!state.settings.model && state.binding===null")
            phase("switch calendar and tasks without replacing the home draft")
            try await fixture.js("const i=document.querySelector('#home-chat-text');window.__home042Composer=i;i.value='还没说完的合成草稿';i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.trim().startsWith('待办')).click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-undated]') && document.querySelector('[aria-label=查看已完成待办]')")
            try await fixture.expect("return !document.querySelector('[data-planner-id=qa042-done]') && window.__home042Composer===document.querySelector('#home-chat-text') && window.__home042Composer.isConnected && window.__home042Composer.value==='还没说完的合成草稿';", true)
            try await fixture.js("[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.trim()==='日程').click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-agenda]')")
            try await fixture.js("[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.trim().startsWith('待办')).click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-undated]')")
            try await settle()
            try await fixture.expect("const r=document.querySelector('.mobile-planner').getBoundingClientRect();return r.left>=-0.5&&r.right<=innerWidth+0.5&&document.documentElement.scrollWidth<=innerWidth;", true)
            try await fixture.snapshot("iOS-042-home-tasks-320", test: self)

            phase("edit standalone task description and legacy checklist")
            try await fixture.js("document.querySelector('[data-planner-id=qa042-undated]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')?.dataset.id==='qa042-undated' && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='保存任务')")
            try await fixture.expect("return document.querySelector('#task-form [name=description]').value;", "保留问题与原文页码，准备下一次讨论。")
            try await fixture.expect("return document.querySelector('#task-form [name=due]').value==='' && document.querySelectorAll('.task-checklist-row').length===2 && document.querySelector('.task-checklist-row input[type=text]').value==='核对原文';", true)
            try await fixture.js("const f=document.querySelector('#task-form');f.querySelector('.task-properties').open=true;f.elements.description.value='已经核对原文；继续列出两个问题。';f.elements.description.dispatchEvent(new Event('input',{bubbles:true}));f.querySelector('.task-checklist-row input[type=checkbox]').click();return true;")
            try await taskDateBounds()
            try await fixture.js("document.querySelector('#task-form [name=description]').scrollIntoView({block:'start'});return true;")
            try await settle()
            try await fixture.snapshot("iOS-042-task-legacy-checklist-320", test: self)
            try await fixture.js("document.querySelector('#task-form [name=due]').scrollIntoView({block:'center'});return true;")
            try await settle()
            try await fixture.snapshot("iOS-042-task-date-controls-320", test: self)
            try await fixture.js("[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='保存任务').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
            try await fixture.check("(()=>{const t=state.records['tasks:qa042-undated'].data,c=t.checklist[0];return t.id==='qa042-undated'&&t.description==='已经核对原文；继续列出两个问题。'&&t.workspace==='科研'&&t.customField==='preserve'&&!t.projectId&&!t.dueAt&&!t.startAt&&c.id==='mac-1'&&c.title==='核对原文'&&!Object.hasOwn(c,'text')&&c.done===true&&c.sourceId==='paper-a'&&c.meta.origin==='synthetic-mac'&&c.meta.order===7&&t.checklist[1]==='列出问题';})()")
            try await fixture.js("document.querySelector('[data-planner-id=qa042-undated]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form .task-checklist-row input[type=checkbox]')?.checked===true && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='标记完成')")
            try await fixture.expect("return document.querySelector('#task-form [name=description]').value;", "已经核对原文；继续列出两个问题。")

            phase("complete then find the same task in completed history")
            try await fixture.js("[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='标记完成').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open && !document.querySelector('[data-planner-id=qa042-undated]')")
            try await fixture.check("state.records['tasks:qa042-undated'].data.status==='done' && state.records['tasks:qa042-undated'].data.completedAt>0")
            try await fixture.js("document.querySelector('[aria-label=查看已完成待办]').click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-undated]') && document.querySelector('[data-planner-id=qa042-done]')")
            try await settle()
            try await fixture.snapshot("iOS-042-completed-tasks-320", test: self)
            phase("reload and reopen the persisted completed task")
            try await fixture.reload()
            try await fixture.wait("document.querySelector('.mobile-planner__modes')")
            try await fixture.js("[...document.querySelectorAll('.mobile-planner__modes button')].find(b=>b.textContent.trim().startsWith('待办')).click();return true;")
            try await fixture.wait("document.querySelector('.mobile-planner__task-filter')")
            try await fixture.js("document.querySelector('[aria-label=查看已完成待办]')?.click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-undated]')")
            try await fixture.js("document.querySelector('[data-planner-id=qa042-undated]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')?.dataset.id==='qa042-undated' && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='重新打开')")
            try await fixture.expect("return document.querySelector('#task-form .task-checklist-row input[type=checkbox]').checked;", true)
            try await fixture.js("[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='重新打开').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
            try await fixture.js("document.querySelector('[aria-label=查看未完成待办]')?.click();return true;")
            try await fixture.wait("document.querySelector('[data-planner-id=qa042-undated]') && document.querySelector('[data-planner-id=qa042-date-only]')")
            try await fixture.check("state.records['tasks:qa042-undated'].data.status==='todo' && !state.records['tasks:qa042-undated'].data.completedAt && state.records['tasks:qa042-undated'].data.checklist[0].meta.origin==='synthetic-mac'")

            phase("preserve a Mac date-only deadline during a title edit")
            try await fixture.js("document.querySelector('[data-planner-id=qa042-date-only]').click();return true;")
            try await fixture.wait("document.querySelector('#task-form')?.dataset.id==='qa042-date-only' && [...document.querySelectorAll('#task-actions-root button')].some(b=>b.textContent.trim()==='保存任务')")
            try await fixture.expect("return document.querySelector('#task-form [name=due]').value;", "2030-01-06T09:00")
            try await fixture.js("const f=document.querySelector('#task-form');f.querySelector('.task-properties').open=true;f.elements.title.value='提交合成读书报告（已检查）';return true;")
            try await taskDateBounds()
            try await fixture.js("[...document.querySelectorAll('#task-actions-root button')].find(b=>b.textContent.trim()==='保存任务').click();return true;")
            try await fixture.wait("!document.querySelector('#sheet').open")
            try await fixture.check("state.records['tasks:qa042-date-only'].data.dueAt==='2030-01-06' && state.records['tasks:qa042-date-only'].data.workspace==='课程' && state.records['tasks:qa042-date-only'].data.priority==='high' && !state.settings.model && state.binding===null")
            try await fixture.expect("return document.documentElement.scrollWidth<=innerWidth;", true)
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            phase("completed")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_HOME042_QA failure: \(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic)
            attachment.name = "iOS-042-home-failure-stage"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail(diagnostic)
        }
    }
    @MainActor func testBundledWebKitResponsesReviewOpensPersistedResult() async throws {
        let fixture = try NativeUIFixture(responses: true); defer { fixture.close() }
        do {
        fixture.phase("open isolated bundled page")
        try await fixture.open()
        fixture.phase("open model settings")
        try await fixture.js("document.querySelector('header [data-tab=settings]').click(); return true;")
        try await fixture.wait("document.querySelector('#model-form')")
        fixture.phase("save synthetic Responses configuration")
        try await fixture.js("const f=document.querySelector('#model-form');f.elements.base.value='https://responses.fixture.invalid/v1';f.elements.model.value='qa-ios-responses';f.elements.key.value='synthetic-ios-responses-key';f.elements.format.value='responses';f.requestSubmit();return true;")
        // This isolated WKWebView uses the browser adapter. Its success toast
        // intentionally differs from the production native Keychain wording.
        // Verify the durable configuration and re-rendered form, not the toast.
        try await fixture.wait("await (async()=>{" + NativeUIFixture.stateReader + "return document.querySelector('#model-form')?.elements.key.value === '' && state?.settings?.model?.base === 'https://responses.fixture.invalid/v1' && state.settings.model.model === 'qa-ios-responses' && state.settings.model.format === 'responses';})()")
        fixture.phase("submit home task request")
        try await fixture.js("document.querySelector('nav [data-tab=today]').click(); return true;")
        try await fixture.wait("document.querySelector('#home-chat-form')")
        try await fixture.js("const i=document.querySelector('#home-chat-text');i.value='创建一个合成任务，先让我确认。';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#home-chat-form').requestSubmit();return true;")
        try await fixture.wait("!document.querySelector('#live-response') && document.querySelector('[data-action=review-plan]')")
        fixture.phase("validate real unexecuted proposal")
        // A complete, validated write plan now finishes locally; the provider's
        // optional final prose is not required before the user can review it.
        try await fixture.expect("return window.__responsesRequests;", 2)
        try await fixture.check("!Object.keys(state.records).some(key=>key.startsWith('tasks:')) && Object.values(state.records).some(r=>r.data?.pendingPlan?.status==='pending')")
        try await fixture.expect("return document.querySelector('.messages').innerText.includes('我已替你保存，无需审批');", false)
        try await fixture.js("document.querySelector('[data-action=review-plan]').click();return true;")
        fixture.phase("open actual review and snapshot")
        try await fixture.wait("document.querySelector('#apply-plan')")
        try await fixture.expect("return document.querySelector('.mobile-plan-review').innerText.includes('合成 iOS Responses 任务');", true)
        try await fixture.snapshot("iOS-responses-review-320", test: self)
        fixture.phase("approve and validate persisted receipt")
        try await fixture.js("document.querySelector('#apply-plan').click();return true;")
        try await fixture.wait("!document.querySelector('#sheet').open && document.querySelector('.conversation-results[data-result-state=applied]')")
        try await fixture.check("Object.keys(state.records).filter(key=>key.startsWith('tasks:')&&!state.records[key].deleted).length===1 && Object.values(state.records).some(r=>r.data?.pendingPlan?.status==='applied'&&r.data.pendingPlan.receipts.length===1)")
        let savedTaskID = try await fixture.js(NativeUIFixture.stateReader + "return Object.values(state.records).find(r=>r.data?.pendingPlan?.status==='applied').data.pendingPlan.receipts[0].id;")
        let taskID = try XCTUnwrap(savedTaskID as? String)
        let savedConversationID = try await fixture.js(NativeUIFixture.stateReader + "return Object.values(state.records).find(r=>r.data?.pendingPlan?.status==='applied').data.conversationId;")
        let conversationID = try XCTUnwrap(savedConversationID as? String)
        fixture.phase("open exact task result")
        try await fixture.wait("document.querySelector('[aria-label=\"打开任务：合成 iOS Responses 任务\"]')")
        try await fixture.js("document.querySelector('[aria-label=\"打开任务：合成 iOS Responses 任务\"]').click();return true;")
        try await fixture.wait("document.querySelector('#task-form')")
        try await fixture.expect("return document.querySelector('#task-form').dataset.id;", taskID)
        try await fixture.expect("return document.querySelector('#task-form [name=title]').value;", "合成 iOS Responses 任务")
        try await fixture.expectTaskDateInputFits()
        try await fixture.snapshot("iOS-responses-result-task-320", test: self)
        try await fixture.check("!JSON.stringify(state).includes('qa-ios-opaque') && !JSON.stringify(state).includes('synthetic-ios-responses-key')")
        fixture.phase("reload and reopen saved conversation")
        try await fixture.reload()
        // The native WebKit fixture keeps its ephemeral website data across a
        // document reload. This does not claim native database persistence.
        let selector = "[data-action=conversation][data-id='\(conversationID)']"
        try await fixture.wait("document.querySelector(\"\(selector)\")")
        try await fixture.js("document.querySelector(\"\(selector)\").click();return true;")
        try await fixture.wait("document.querySelector('.conversation-results[data-result-state=applied]') && !document.querySelector('[data-action=review-plan]')")
        try await fixture.js("document.querySelector('[aria-label=\"打开任务：合成 iOS Responses 任务\"]').click();return true;")
        try await fixture.wait("document.querySelector('#task-form')")
        try await fixture.expect("return document.querySelector('#task-form').dataset.id;", taskID)
        try await fixture.expectTaskDateInputFits()
        try await fixture.expect("return document.documentElement.scrollWidth <= innerWidth;", true)
        try await fixture.expect("return window.__fixtureErrors.length;", 0)
        fixture.phase("completed")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            print("AIBRO_RESPONSES_QA failure before teardown:\n\(diagnostic)")
            let attachment = XCTAttachment(string: diagnostic)
            attachment.name = "iOS-responses-failure-stage"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail(diagnostic)
        }
    }
    @MainActor func testBundledWebKitReviewApplyOnceAndReject() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        try await fixture.open()
        try await fixture.js("const input=document.querySelector('#home-chat-text'); input.value='明天下午三点合成篮球，帮我新建日程'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#home-chat-form').requestSubmit(); return true;")
        try await fixture.wait("document.querySelector('[data-action=review-plan]')")
        try await fixture.check("Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程').length===0 && !state.settings.model")
        try await fixture.js("document.querySelector('[data-action=review-plan]').click(); return true;")
        try await fixture.wait("document.querySelector('#apply-plan') && document.querySelector('#reject-plan')")
        let review = try await fixture.js("return document.querySelector('.mobile-plan-review').innerText;") as? String ?? ""
        XCTAssertTrue(review.contains("15:00")); XCTAssertTrue(review.contains("16:00")); XCTAssertTrue(review.contains("不提醒"))
        try await fixture.expect("return document.documentElement.scrollWidth <= innerWidth;", true)
        try await fixture.snapshot("iOS-040-review-320", test: self)
        try await fixture.js("const b=document.querySelector('#apply-plan'); b.click(); b.click(); return true;")
        try await fixture.wait("!document.querySelector('#sheet').open && !document.querySelector('[data-action=review-plan]')")
        try await fixture.check("Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程').length===1 && Object.values(state.records).some(r=>r.data?.pendingPlan?.status==='applied' && r.data.pendingPlan.receipts.length===1)")
        try await fixture.js("document.querySelector('nav [data-tab=today]').click(); return true;")
        try await fixture.wait("document.querySelector('#home-chat-form')")
        try await fixture.js("const input=document.querySelector('#home-chat-text'); input.value='明天下午五点合成拒绝，帮我新建日程'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#home-chat-form').requestSubmit(); return true;")
        try await fixture.wait("document.querySelector('[data-action=review-plan]')")
        try await fixture.js("document.querySelector('[data-action=review-plan]').click(); return true;")
        try await fixture.wait("document.querySelector('#reject-plan')")
        try await fixture.js("document.querySelector('#reject-plan').click(); return true;")
        try await fixture.wait("!document.querySelector('#sheet').open && !document.querySelector('[data-action=review-plan]')")
        try await fixture.check("Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程').length===1 && Object.values(state.records).some(r=>r.data?.pendingPlan?.status==='rejected')")
        try await fixture.reload()
        try await fixture.check("Object.values(state.records).filter(r=>!r.deleted&&r.data?.kind==='日程').length===1")
        try await fixture.expect("return window.__fixtureErrors.length;", 0)
    }
    @MainActor func testBundledWebKitRepeatingSeriesEditPreservesRules() async throws {
        let fixture = try NativeUIFixture(); defer { fixture.close() }
        try await fixture.open(recurring: true)
        try await fixture.wait("document.querySelector('[data-action=event][data-id=synthetic_series]')")
        try await fixture.js("document.querySelector('[data-action=event][data-id=synthetic_series]').click(); return true;")
        try await fixture.wait("document.querySelector('#event-form [name=frequency]')")
        try await fixture.expect("return document.querySelector('#event-form [name=frequency]').value;", "weekly")
        try await fixture.expect("return document.querySelector('#event-form').innerText.includes('整个重复系列');", true)
        try await fixture.js("const f=document.querySelector('#event-form'); f.elements.start.value='2030-01-07T09:00'; f.elements.end.value='2030-01-07T10:00'; return true;")
        try await fixture.expectDateInputsFit()
        try await fixture.snapshot("iOS-040-recurring-form-320", test: self)
        try await fixture.js("document.querySelector('#event-form [name=repeatUntil]').scrollIntoView({block:'center'}); return true;")
        try await fixture.snapshot("iOS-040-recurring-until-320", test: self)
        try await fixture.js("document.querySelector('#event-form').requestSubmit(); return true;")
        try await fixture.wait("!document.querySelector('#sheet').open")
        try await fixture.check("(()=>{const e=JSON.parse(state.records['notes:synthetic_series'].data.content),start=new Date(2030,0,7,9).getTime();return e.start===start && e.end===start+3600000 && e.recurrence.frequency==='weekly' && e.recurrence.count===12 && JSON.stringify(e.recurrence.weekdays)==='[2,4,6]' && e.recurrence.until===new Date(2030,1,1,9).getTime() && e.excluded[0]===start+2*86400000 && e.completed[0]===start+4*86400000;})()")
        try await fixture.reload(); try await fixture.wait("document.querySelector('[data-action=event][data-id=synthetic_series]')")
        try await fixture.js("document.querySelector('[data-action=event][data-id=synthetic_series]').click(); return true;")
        try await fixture.wait("document.querySelector('#event-form')")
        try await fixture.expect("return document.querySelector('#event-form [name=start]').value;", "2030-01-07T09:00")
        try await fixture.expect("return document.querySelector('#event-form [name=repeatUntil]').value;", "2030-02-01T09:00")
        try await fixture.expectDateInputsFit()
        try await fixture.expect("return document.documentElement.scrollWidth <= innerWidth;", true)
        try await fixture.expect("return window.__fixtureErrors.length;", 0)
    }
}

extension NativeUIFixture {
    // A manually gated provider keeps the real bundled page streaming while the
    // test reads it. Only fetch is substituted; no user workspace or live model.
    static let streamReaderFixtureScript = #"""
      (() => {
        const request = window.fetch.bind(window);
        window.__responsesFixtureURL = 'https://reader.fixture.invalid/v1/chat/completions';
        window.__responsesRequests = 0;
        window.__readerEvidenceText = Array.from({length:65},(_,i)=>'iOS 合成证据第 '+(i+1)+' 行：保留阅读位置与采样结果。').join('\n')
          +'\nhttps://fixture.invalid/'+'long-segment-'.repeat(40);
        const reasoning = Array.from({length:38},(_,i)=>'iOS 推理段落 '+(i+1)+'：核对合成资料，再解释采样结果。').join('\n\n');
        const text = '可选择的 iOS 正文起点，保留此处选区。\n\n'
          +Array.from({length:24},(_,i)=>'iOS 正文段落 '+(i+1)+'：继续阅读合成回答与引用资料 [1]。').join('\n\n');
        const require = (condition,message)=>{if(!condition)throw Error('Synthetic reader: '+message);};
        window.fetch = async (url,options) => {
          if ((typeof url==='string'?url:url.url)!==window.__responsesFixtureURL) return request(url,options);
          require(options.method==='POST'&&options.headers.Authorization==='Bearer synthetic-ios-reader-key','synthetic request');
          const body=JSON.parse(options.body);
          require(body.stream===true&&body.model==='qa-ios-reader'&&Array.isArray(body.messages),'Chat stream shape');
          require(body.messages.filter(m=>m.role==='user').at(-1)?.content==='阅读状态验收：iOS 合成资料','read-only prompt');
          const result=body.messages.find(m=>m.role==='tool');
          if(result)require(!JSON.parse(result.content).error&&result.content.includes('iOS 合成证据第 65 行'),'real knowledge_read output');
          window.__responsesRequests++;
          const encoder=new TextEncoder(); let stopped=false;
          return new Response(new ReadableStream({start(controller){
            const raw=value=>{require(!stopped,'gate closed');controller.enqueue(encoder.encode('data: '+value+'\r\n\r\n'));};
            const emit=(delta,finish_reason=null)=>raw(JSON.stringify({choices:[{index:0,delta,finish_reason}]}));
            if(!result){
              emit({reasoning_content:reasoning});
              const args=JSON.stringify({kind:'notes',id:'ios-reader-evidence',limit:12000}),at=Math.floor(args.length/2);
              emit({tool_calls:[{index:0,id:'ios-reader-call',type:'function',function:{name:'knowledge_read',arguments:args.slice(0,at)}}]});
              emit({tool_calls:[{index:0,function:{arguments:args.slice(at)}}]},'tool_calls');
              raw('[DONE]');controller.close();stopped=true;
            }else{
              emit({content:text});
              window.__readerEmit=delta=>emit(delta);
              window.__readerFinish=()=>{emit({},'stop');raw('[DONE]');controller.close();stopped=true;};
            }
          },cancel(){stopped=true;}}),{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
        };
      })();
      """#
}

extension MobileNativeTests {
    // One bundled-WebKit reading gate. This uses the isolated browser adapter,
    // not native HTTPS/Keychain/SQLite, and does not claim selection-handle input.
    @MainActor func testBundledWebKitStreamReaderRetainsReadingStateAt320() async throws {
        let fixture = try NativeUIFixture(providerScript: NativeUIFixture.streamReaderFixtureScript)
        defer { fixture.close() }
        do {
            fixture.phase("reader seed isolated read-only conversation")
            fixture.origin = try await fixture.server.start()
            fixture.web.load(URLRequest(url: fixture.origin.appendingPathComponent("__fixture_seed")))
            try await fixture.wait("document.title==='isolated iOS fixture'")
            try await fixture.js(#"""
              const state={schema:1,records:{},cursor:0,binding:null,settings:{model:{base:'https://reader.fixture.invalid/v1',model:'qa-ios-reader',format:'chat'}},drafts:{},blobs:{}};
              const put=(kind,data)=>state.records[kind+':'+data.id]={data,version:0,remote:null,remoteDeleted:false,deleted:false,dirty:true};
              put('notes',{id:'ios-reader-evidence',title:'iOS 合成阅读证据',content:window.__readerEvidenceText,kind:'笔记',workspace:'科研',createdAt:1,updatedAt:1});
              put('conversations',{id:'ios-reader',title:'iOS 合成阅读',projectId:null,workspace:'科研',createdAt:1,updatedAt:1,
                mobileContext:{version:1,keys:['notes:ios-reader-evidence'],source:null}});
              await new Promise((resolve,reject)=>{
                const request=indexedDB.open('aibro-mobile-v1',1);
                request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onerror=()=>reject(request.error);
                request.onsuccess=()=>{const db=request.result,tx=db.transaction('state','readwrite');tx.objectStore('state').put(state,'workspace');
                  tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
              });
              sessionStorage.setItem('aibro-web-session:live:model','synthetic-ios-reader-key');return true;
              """#)
            fixture.web.load(URLRequest(url: fixture.origin))
            try await fixture.wait("document.querySelector('#home-chat-form')")
            try await fixture.expect("return innerWidth;", 320)
            try await fixture.js("document.querySelector('nav [data-tab=chat]').click();return true;")
            try await fixture.wait("document.querySelector('[data-action=conversation][data-id=ios-reader]')")
            try await fixture.js("document.querySelector('[data-action=conversation][data-id=ios-reader]').click();return true;")
            try await fixture.wait("document.querySelector('#chat-form')")
            try await fixture.js("const t=document.querySelector('#chat-text');t.value='阅读状态验收：iOS 合成资料';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chat-form').requestSubmit();return true;")
            try await fixture.wait("document.querySelector('#live-response .live-text')?.textContent.includes('iOS 正文段落 24')&&document.querySelector('#live-response [data-conversation-activity]')&&typeof window.__readerEmit==='function'")
            try await fixture.expect("return window.__responsesRequests;", 2)

            fixture.phase("reader open long detail content and retain inner scroll through delta")
            try await fixture.js(#"""
              const article=document.querySelector('#live-response'),reasoning=article.querySelector('details.reasoning'),tool=article.querySelector('details.tool-trace');
              reasoning.querySelector('summary').click();tool.querySelector('summary').click();
              window.__readerRefs={article,reasoning,tool,body:article.querySelector('.live-text')};return true;
              """#)
            try await fixture.wait("window.__readerRefs.reasoning.open&&window.__readerRefs.tool.open&&window.__readerRefs.reasoning.querySelector('.markdown')?.textContent.includes('iOS 推理段落 38')&&window.__readerRefs.tool.textContent.includes('iOS 合成证据第 65 行')")
            try await fixture.js(#"""
              const r=window.__readerRefs;r.reasonText=r.reasoning.querySelector('.markdown');r.output=[...r.tool.querySelectorAll('pre')].at(-1);r.summary=r.tool.querySelector('summary');
              r.reasonText.scrollTop=117;r.output.scrollTop=91;r.summary.focus({preventScroll:true});
              window.__readerStable=()=>r.article.isConnected&&r.reasoning===r.article.querySelector('details.reasoning')&&r.tool===r.article.querySelector('details.tool-trace')
                &&r.reasonText===r.reasoning.querySelector('.markdown')&&r.output===[...r.tool.querySelectorAll('pre')].at(-1)
                &&r.body===r.article.querySelector('.live-text,.message-body')&&r.reasoning.open&&r.tool.open
                &&r.reasonText.scrollTop===117&&r.output.scrollTop===91&&document.activeElement===r.summary;
              return true;
              """#)
            try await fixture.expect("return window.__readerRefs.reasonText.scrollHeight-window.__readerRefs.reasonText.clientHeight>200&&window.__readerRefs.output.scrollHeight-window.__readerRefs.output.clientHeight>200&&window.__readerStable();", true)
            try await fixture.js("window.__readerEmit({content:'\\n\\n原生正文增量一。'});return true;")
            try await fixture.wait("document.querySelector('#live-response .live-text')?.textContent.includes('原生正文增量一')")
            try await fixture.expect("return window.__readerStable();", true)

            fixture.phase("reader keeps closed details lazy until explicit reopen")
            try await fixture.js("const r=window.__readerRefs;r.reasoning.querySelector('summary').click();r.tool.querySelector('summary').click();window.__readerEmit({content:'\\n\\n关闭后的原生正文。',reasoning_content:'\\n\\n关闭后的原生推理。'});return true;")
            try await fixture.wait("document.querySelector('#live-response .live-text')?.textContent.includes('关闭后的原生正文')")
            try await fixture.expect("const r=window.__readerRefs;return !r.reasoning.open&&!r.tool.open&&r.reasoning===r.article.querySelector('details.reasoning')&&r.tool===r.article.querySelector('details.tool-trace')&&!r.reasonText.textContent.includes('关闭后的原生推理');", true)
            try await fixture.js("window.__readerRefs.reasoning.querySelector('summary').click();return true;")
            try await fixture.wait("window.__readerRefs.reasonText.textContent.includes('关闭后的原生推理')")

            fixture.phase("reader preserves actual DOM range while body deltas are buffered")
            try await fixture.js(#"""
              const node=window.__readerRefs.body.querySelector('p').firstChild,selection=getSelection(),range=document.createRange();
              range.setStart(node,0);range.setEnd(node,8);selection.removeAllRanges();selection.addRange(range);
              window.__readerSelection={node,text:selection.toString()};
              window.__readerEmit({content:'\n\n选区期间原生正文应缓冲。',reasoning_content:'\n\n选区期间原生推理已处理。'});return true;
              """#)
            try await fixture.wait("window.__readerRefs.reasonText.textContent.includes('选区期间原生推理已处理')")
            try await fixture.expect("const s=getSelection(),r=window.__readerSelection;return r.node.isConnected&&s.toString()===r.text&&s.anchorNode===r.node&&s.focusNode===r.node&&s.anchorOffset===0&&s.focusOffset===8&&!window.__readerRefs.body.textContent.includes('选区期间原生正文应缓冲');", true)
            try await fixture.js("getSelection().removeAllRanges();return true;")
            try await fixture.wait("window.__readerRefs.body.textContent.includes('选区期间原生正文应缓冲')")

            fixture.phase("reader completion keeps article details scroll and focus")
            try await fixture.js("const r=window.__readerRefs;r.tool.querySelector('summary').click();return true;")
            try await fixture.wait("window.__readerRefs.tool.open&&window.__readerRefs.tool.textContent.includes('iOS 合成证据第 65 行')")
            try await fixture.js(#"""
              const r=window.__readerRefs;r.reasonText.scrollTop=117;r.output.scrollTop=91;r.summary.focus({preventScroll:true});
              const node=r.body.querySelector('p').firstChild,selection=getSelection(),range=document.createRange();
              range.setStart(node,0);range.setEnd(node,8);selection.removeAllRanges();selection.addRange(range);
              window.__readerTerminalSelection={node,text:selection.toString()};
              window.__readerEmit({content:'\n\n跨越原生终态的最后正文后缀。'});window.__readerFinish();return true;
              """#)
            try await fixture.wait("!document.querySelector('#live-response')&&document.querySelector('.message.assistant .message-body')?.textContent.includes('选区期间原生正文应缓冲')&&document.querySelector('.message.assistant [data-activity-status=completed]')")
            try await fixture.expect("return window.__readerStable();", true)
            try await fixture.expect("const s=getSelection(),r=window.__readerTerminalSelection;return r.node.isConnected&&s.toString()===r.text&&s.anchorNode===r.node&&s.focusNode===r.node&&s.anchorOffset===0&&s.focusOffset===8&&!window.__readerRefs.body.textContent.includes('跨越原生终态的最后正文后缀');", true)
            try await fixture.js("getSelection().removeAllRanges();return true;")
            try await fixture.wait("window.__readerRefs.body.textContent.includes('跨越原生终态的最后正文后缀')")
            try await fixture.expect("return document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.message.assistant .reasoning .markdown,.message.assistant .tool-trace pre')].every(n=>n.scrollWidth<=n.clientWidth);", true)
            try await fixture.js("window.__readerRefs.reasoning.scrollIntoView({block:'start'});return true;")
            try await fixture.snapshot("iOS-stream-reader-completed-320", test: self)
            try await fixture.check("Object.values(state.records).filter(r=>r.data?.role==='assistant'&&r.data?.conversationId==='ios-reader').length===1&&Object.values(state.records).some(r=>r.data?.role==='assistant'&&r.data?.status==='completed'&&r.data?.content.includes('跨越原生终态的最后正文后缀'))")
            try await fixture.expect("return window.__fixtureErrors.length;", 0)
            fixture.phase("reader gate complete")
        } catch {
            let diagnostic = await fixture.failureDiagnostic(error)
            let attachment = XCTAttachment(string: diagnostic)
            attachment.name = "iOS-stream-reader-failure-stage"; attachment.lifetime = .keepAlways; add(attachment)
            XCTFail(diagnostic)
        }
    }
}

// Isolated service per test; uses production CAS + actual Keychain, never the App's service.
private final class ConnectionVaultKeychainFixture {
    let service = "app.aibro.mobile.connection-test." + UUID().uuidString
    let binding: [String: Any] = ["serverOrigin": "https://sync.example.test", "accountId": "account_fixture"]
    let raw = "{\"base\":\"https://sync.example.test/prefix\",\"token\":\"synthetic-sync-token\",\"accountId\":\"account_fixture\",\"sessionId\":\"session_fixture\"}"
    lazy var storage = MobileKeychainStorage(service: service)
    lazy var vault = MobileCredentialVault(storage: storage)
    func start() throws { try vault.set("sync", value: raw) }
    func fence() throws -> [String: Any] {
        ["serverOrigin": "https://sync.example.test", "accountId": "account_fixture", "sessionId": "session_fixture", "generation": 1,
         "nativeFence": try vault.connectionSessionFence(expectedSyncSha256: SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined())]
    }
    func profile(_ key: String = "synthetic-api-key") -> [String: Any] {
        ["format": "aibro.connection-sync-local.v1", "binding": binding, "activeProfiles": ["chat": ["apiKey": key, "baseUrl": "https://api.example.test/v1"]]]
    }
    deinit { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
}
import CryptoKit
extension MobileNativeTests {
    func testConnectionVaultKeychainCASPersistsWholeBundleAndTombstone() throws {
        let fixture = ConnectionVaultKeychainFixture(); try fixture.start()
        let fence = try fixture.fence(), vault = fixture.vault
        XCTAssertEqual(try vault.connectionVaultRead(binding: fixture.binding, sessionFence: fence)["revision"] as? Int, 0)
        XCTAssertTrue(try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: fence))
        let reopened = MobileCredentialVault(storage: MobileKeychainStorage(service: fixture.service))
        let stored = try reopened.connectionVaultRead(binding: fixture.binding, sessionFence: fence)
        XCTAssertEqual(stored["revision"] as? Int64, 1)
        let profiles = (stored["value"] as? [String: Any])?["activeProfiles"] as? [String: [String: String]]
        XCTAssertEqual(profiles?["chat"]?["apiKey"], "synthetic-api-key")
        XCTAssertFalse(try reopened.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile("late"), sessionFence: fence))
        XCTAssertTrue(try reopened.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 1, value: NSNull(), sessionFence: fence))
        let deleted = try reopened.connectionVaultRead(binding: fixture.binding, sessionFence: fence)
        XCTAssertEqual(deleted["revision"] as? Int64, 2); XCTAssertTrue(deleted["value"] is NSNull)
        XCTAssertFalse(try reopened.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: fence))
        XCTAssertThrowsError(try reopened.set("connections.v1.forbidden", value: "bypass"))
    }
    func testConnectionVaultKeychainFencesSameCredentialABAAndWrongSession() throws {
        let fixture = ConnectionVaultKeychainFixture(); try fixture.start()
        let old = try fixture.fence(), vault = fixture.vault
        try vault.set("sync", value: fixture.raw)
        XCTAssertFalse(try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: old))
        XCTAssertThrowsError(try vault.connectionVaultRead(binding: fixture.binding, sessionFence: old))
        let next = try fixture.fence()
        try vault.remove("sync"); try vault.set("sync", value: fixture.raw)
        XCTAssertFalse(try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: next))
        let fresh = try fixture.fence()
        try vault.set("model", value: "synthetic-legacy-model")
        XCTAssertTrue(try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: fresh))
        var forged = fresh; forged["sessionId"] = "another_session"
        XCTAssertThrowsError(try vault.connectionVaultRead(binding: fixture.binding, sessionFence: forged))
        XCTAssertFalse(try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 1, value: fixture.profile("late"), sessionFence: forged))
        XCTAssertThrowsError(try vault.connectionSessionFence(expectedSyncSha256: String(repeating: "0", count: 64)))
    }
    func testConnectionVaultKeychainConcurrentInstancesHaveSingleCASWinner() throws {
        let fixture = ConnectionVaultKeychainFixture(); try fixture.start()
        let fence = try fixture.fence(), resultLock = NSLock()
        var successes = 0, failures = 0
        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            do {
                let vault = MobileCredentialVault(storage: MobileKeychainStorage(service: fixture.service))
                let won = try vault.connectionVaultCompareAndSwap(binding: fixture.binding, expectedRevision: 0, value: fixture.profile(), sessionFence: fence)
                resultLock.lock(); if won { successes += 1 }; resultLock.unlock()
            } catch { resultLock.lock(); failures += 1; resultLock.unlock() }
        }
        XCTAssertEqual(successes, 1); XCTAssertEqual(failures, 0)
        XCTAssertEqual(try fixture.vault.connectionVaultRead(binding: fixture.binding, sessionFence: fence)["revision"] as? Int64, 1)
    }
}
