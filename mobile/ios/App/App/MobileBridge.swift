import Foundation
import Capacitor
import Security
import SQLite3
import QuickLook
import Vision
import PDFKit
import WidgetKit
import CryptoKit

@objc(AIBroViewController)
final class AIBroViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(MobileBridge()) }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@objc(MobileBridge)
final class MobileBridge: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource {
    let identifier = "MobileBridge"
    let jsName = "MobileBridge"
    let pluginMethods = ["load", "save", "secretGet", "secretSet", "secretRemove", "connectionSessionFence", "connectionVaultRead", "connectionVaultCompareAndSwap", "request", "requestStream", "cancelRequest", "preview", "extractText", "shared", "sharedAck", "widgetSave", "voiceStart", "voiceStop", "voiceCancel", "voiceStatus", "voiceShortcutPending", "voiceShortcutAck"].compactMap { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private let queue = DispatchQueue(label: "app.aibro.mobile.storage")
    private let credentialVault = MobileCredentialVault()
    private var previewURL: URL?
    private let redirect = NoRedirect()
    private let streamLock = NSLock()
    private var streams: [String: NativeRequestStream] = [:]
    private var voiceShortcutObserver: NSObjectProtocol?

    override func load() {
        NativeVoiceCapture.shared.event = { [weak self] event in self?.notifyListeners("voiceRecordingEvent", data: event) }
        voiceShortcutObserver = NotificationCenter.default.addObserver(forName: VoiceShortcutInbox.changed, object: nil, queue: .main) { [weak self] notification in
            guard let event = notification.userInfo as? [String: Any] else { return }
            self?.notifyListeners("voiceShortcut", data: event)
        }
    }

    deinit {
        for stream in streams.values { stream.cancel() }
        network.invalidateAndCancel()
        privateNetwork.invalidateAndCancel()
        if let voiceShortcutObserver { NotificationCenter.default.removeObserver(voiceShortcutObserver) }
        DispatchQueue.main.async { NativeVoiceCapture.shared.cancelAll() }
    }
    static func usesPrivateRoute(_ url: URL) -> Bool {
        let host = (url.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return host.hasSuffix(".ts.net") || ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }
    static func networkConfiguration(privateRoute: Bool) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 180
        // Private tailnet traffic uses the VPN route, with normal TLS validation.
        if privateRoute { configuration.connectionProxyDictionary = [:] }
        return configuration
    }
    private lazy var network = URLSession(configuration: Self.networkConfiguration(privateRoute: false), delegate: redirect, delegateQueue: nil)
    private lazy var privateNetwork = URLSession(configuration: Self.networkConfiguration(privateRoute: true), delegate: redirect, delegateQueue: nil)
    static func networkError(_ error: Error?) -> String {
        guard let error = error as NSError?, error.domain == NSURLErrorDomain else { return "连接未完成；提交结果请刷新核对。" }
        let hint: String
        switch error.code {
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: hint = "无法解析服务器地址，请检查地址与 Tailscale 连接。"
        case NSURLErrorCannotConnectToHost, NSURLErrorNotConnectedToInternet: hint = "无法连接服务器，请检查网络与 Tailscale 是否在线。"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot: hint = "HTTPS 安全连接失败，请检查证书或代理配置。"
        case NSURLErrorTimedOut: hint = "连接超时；提交结果请刷新核对。"
        default: hint = "连接中断；提交结果请刷新核对。"
        }
        return "\(hint)（网络错误 \(error.code)）"
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "AI Bro", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    @objc func widgetSave(_ call: CAPPluginCall) {
        guard let value = call.getString("value")?.data(using: .utf8), value.count < 131072 else { call.reject("小组件内容过大"); return }
        queue.async {
            do {
                guard let object = try JSONSerialization.jsonObject(with: value) as? [String: Any],
                      let items = object["items"] as? [[String: Any]], items.count <= 64,
                      object["updatedAt"] is NSNumber,
                      items.allSatisfy({ $0["title"] is String && $0["start"] is NSNumber && $0["end"] is NSNumber }),
                      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile") else { throw self.failure("小组件共享容器不可用") }
                try value.write(to: root.appendingPathComponent("widget.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                WidgetCenter.shared.reloadTimelines(ofKind: "AIBroToday")
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    private func storage() throws -> WorkspaceDatabase {
        WorkspaceDatabase(directory: try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
    }
    @objc func load(_ call: CAPPluginCall) {
        queue.async { do { let value = try self.storage().load(); call.resolve(["value": value as Any? ?? NSNull()]) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func save(_ call: CAPPluginCall) {
        guard let value = call.getString("value") else { call.reject("工作区数据无效"); return }
        queue.async { do { try self.storage().save(value); call.resolve() } catch { call.reject(error.localizedDescription) } }
    }
    @objc func secretGet(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        queue.async { do { call.resolve(["value": try self.credentialVault.get(key) as Any? ?? NSNull()]) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func secretSet(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        guard let value = call.getString("value") else { call.reject("凭据格式无效"); return }
        queue.async { do { try self.credentialVault.set(key, value: value); call.resolve() } catch { call.reject(error.localizedDescription) } }
    }
    @objc func secretRemove(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        queue.async { do { try self.credentialVault.remove(key); call.resolve() } catch { call.reject(error.localizedDescription) } }
    }
    @objc func connectionSessionFence(_ call: CAPPluginCall) {
        let expected = call.getString("expectedSyncSha256") ?? ""
        queue.async { do { call.resolve(["fence": try self.credentialVault.connectionSessionFence(expectedSyncSha256: expected)]) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func connectionVaultRead(_ call: CAPPluginCall) {
        let binding = call.getObject("binding") ?? [:], fence = call.getObject("sessionFence") ?? [:]
        queue.async { do { call.resolve(try self.credentialVault.connectionVaultRead(binding: binding, sessionFence: fence)) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func connectionVaultCompareAndSwap(_ call: CAPPluginCall) {
        let binding = call.getObject("binding") ?? [:], fence = call.getObject("sessionFence") ?? [:]
        guard let revision = call.options["expectedRevision"], let value = call.options["value"] else { call.reject("连接配置格式无效"); return }
        queue.async { do { call.resolve(["swapped": try self.credentialVault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: revision, value: value, sessionFence: fence)]) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func request(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(url.host ?? "")) else { call.reject("请使用 HTTPS 地址"); return }
        let method = call.getString("method") ?? "GET"
        guard ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].contains(method) else { call.reject("请求方式无效"); return }
        var request = URLRequest(url: url)
        request.httpMethod = method
        for (key, value) in call.getObject("headers") ?? [:] {
            guard let value = value as? String, !["host", "cookie", "content-length"].contains(key.lowercased()), !value.contains("\r"), !value.contains("\n") else { continue }
            request.setValue(value, forHTTPHeaderField: key)
        }
        let body = call.getString("body") ?? ""
        if !["GET", "HEAD"].contains(method) {
            request.httpBody = call.getBool("binaryBody") == true ? Data(base64Encoded: body) : body.data(using: .utf8)
            guard (request.httpBody?.count ?? 0) <= 64 * 1024 * 1024 else { call.reject("请求内容过大"); return }
        }
        let session = Self.usesPrivateRoute(url) ? privateNetwork : network
        session.dataTask(with: request) { data, response, error in
            guard error == nil, let response = response as? HTTPURLResponse else { call.reject(Self.networkError(error)); return }
            let bytes = data ?? Data()
            guard bytes.count <= 64 * 1024 * 1024 else { call.reject("返回内容过大"); return }
            call.resolve(["status": response.statusCode, "data": call.getBool("raw") == true ? bytes.base64EncodedString() : String(data: bytes, encoding: .utf8) ?? ""])
        }.resume()
    }
    @objc func requestStream(_ call: CAPPluginCall) {
        guard let requestID = call.getString("requestId"), !requestID.isEmpty, requestID.count <= 128,
              let text = call.getString("url"), let url = URL(string: text), url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(url.host ?? "")) else {
            call.reject("流式请求标识或 HTTPS 地址无效"); return
        }
        let method = call.getString("method") ?? "POST"
        guard ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].contains(method) else { call.reject("请求方式无效"); return }
        var request = URLRequest(url: url)
        request.httpMethod = method
        for (key, value) in call.getObject("headers") ?? [:] {
            guard let value = value as? String, !["host", "cookie", "content-length"].contains(key.lowercased()),
                  !key.contains("\r"), !key.contains("\n"), !value.contains("\r"), !value.contains("\n") else { continue }
            request.setValue(value, forHTTPHeaderField: key)
        }
        if !["GET", "HEAD"].contains(method) {
            request.httpBody = (call.getString("body") ?? "").data(using: .utf8)
            guard (request.httpBody?.count ?? 0) <= 64 * 1024 * 1024 else { call.reject("请求内容过大"); return }
        }
        let stream = NativeRequestStream(requestID: requestID,
            configuration: Self.networkConfiguration(privateRoute: Self.usesPrivateRoute(url)), request: request,
            safeNetworkError: { Self.networkError($0) },
            event: { [weak self] event in
                DispatchQueue.main.async { self?.notifyListeners("requestStreamEvent", data: event) }
            }, completion: { [weak self] in
                guard let self else { return }
                self.streamLock.lock()
                self.streams.removeValue(forKey: requestID)
                self.streamLock.unlock()
            })
        streamLock.lock()
        guard streams[requestID] == nil else { streamLock.unlock(); call.reject("请求标识正在使用"); return }
        streams[requestID] = stream
        streamLock.unlock()
        call.resolve(["requestId": requestID])
        stream.start()
    }

    @objc func cancelRequest(_ call: CAPPluginCall) {
        guard let requestID = call.getString("requestId") else { call.reject("请求标识无效"); return }
        streamLock.lock()
        let stream = streams[requestID]
        streamLock.unlock()
        stream?.cancel()
        call.resolve()
    }

    @objc func voiceStart(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId") else { call.reject("录音标识无效"); return }
        DispatchQueue.main.async {
            NativeVoiceCapture.shared.start(id) { result in
                switch result {
                case .success: call.resolve(["requestId": id])
                case .failure(let error): call.reject(error.localizedDescription)
                }
            }
        }
    }
    @objc func voiceStop(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId") else { call.reject("录音标识无效"); return }
        DispatchQueue.main.async {
            do {
                let result = try NativeVoiceCapture.shared.stop(id)
                call.resolve(["requestId": result.requestID, "data": result.data.base64EncodedString(), "mimeType": "audio/mp4", "durationMs": result.durationMS])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func voiceCancel(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), VoiceCaptureCore.validID(id) else { call.reject("录音标识无效"); return }
        DispatchQueue.main.async {
            do { try NativeVoiceCapture.shared.cancel(id); call.resolve(["requestId": id]) }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func voiceStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["recording": NativeVoiceCapture.shared.recording, "microphonePermission": NativeVoiceCapture.shared.microphonePermission,
                          "shortcutSupported": false, "shortcutEnabled": false, "appShortcutSupported": true])
        }
    }
    @objc func voiceShortcutPending(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(VoiceShortcutInbox.shared.pending()) }
    }
    @objc func voiceShortcutAck(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), VoiceCaptureCore.validID(id) else { call.reject("快捷入口标识无效"); return }
        DispatchQueue.main.async { VoiceShortcutInbox.shared.acknowledge(id); call.resolve() }
    }

    @objc func preview(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), data.count <= 64 * 1024 * 1024 else { call.reject("文件无效或超过 64 MB"); return }
        let name = (call.getString("name") ?? "file").components(separatedBy: CharacterSet(charactersIn: "/\\\0")).joined(separator: "_")
        DispatchQueue.main.async { do {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("preview-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(String(name.prefix(180)))
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            self.previewURL = url
            let controller = QLPreviewController()
            controller.dataSource = self
            self.bridge?.viewController?.present(controller, animated: true)
            call.resolve()
        } catch { call.reject("无法预览文件") } }
    }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { previewURL! as NSURL }
    @objc func extractText(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), data.count <= 32 * 1024 * 1024 else { call.reject("本机文字提取最多支持 32 MB 文件"); return }
        let name = call.getString("name") ?? ""
        DispatchQueue.global(qos: .userInitiated).async { do {
            var text = "", warning = ""
            if name.lowercased().hasSuffix(".pdf") {
                guard let pdf = PDFDocument(data: data), !pdf.isLocked else { call.reject("PDF 无法打开或需要密码；原件仍可预览"); return }
                for index in 0..<min(pdf.pageCount, 100) {
                    let value = pdf.page(at: index)?.string ?? ""
                    if !value.isEmpty { text += "\n\n[第 \(index+1) 页]\n" + value }
                    if text.count >= 200000 { break }
                }
                if text.isEmpty { warning = "此 PDF 没有可提取文字；请使用原件预览" }
                else if pdf.pageCount > 100 || text.count >= 200000 { warning = "提取内容已截断，请结合原件查看" }
            } else {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                request.usesLanguageCorrection = true
                try VNImageRequestHandler(data: data, options: [:]).perform([request])
                text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                warning = "图片文字由设备识别，可能有误，请对照原图"
            }
            call.resolve(["text": String(text.prefix(200000)), "warning": warning])
        } catch { call.reject("本机暂未提取到文字；原件仍可预览") } }
    }
    private func inbox() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.aibro.mobile")?.appendingPathComponent("Inbox", isDirectory: true)
    }
    @objc func shared(_ call: CAPPluginCall) {
        queue.async { do {
            guard let root = self.inbox() else { call.resolve(["items": []]); return }
            let item = try SharedInbox(root: root).nextItem()
            call.resolve(["items": item.map { [$0] } ?? []])
        } catch { call.reject("分享资料暂未读取，原件仍保留") } }
    }
    @objc func sharedAck(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil, let root = inbox() else { call.reject("分享标识无效"); return }
        queue.async { do { try SharedInbox(root: root).acknowledge(id); call.resolve() } catch { call.reject("分享已导入，但清理收件箱失败") } }
    }
}

// BEGIN CONNECTION_NATIVE_VAULT
// Shared by legacy secret mutations and connection CAS. Storage adapters never log values.
protocol MobileCredentialStorage {
    func read(_ key: String) throws -> Data?
    func write(_ key: String, data: Data) throws
    func remove(_ key: String) throws
}

enum MobileCredentialError: Error, LocalizedError {
    case invalid, reconnect, session, read, write, remove, oversized
    var errorDescription: String? {
        switch self {
        case .invalid: return "连接配置格式无效"
        case .reconnect: return "请重新连接云同步后启用配置同步"
        case .session: return "同步登录已变化，请重新连接后重试"
        case .read: return "连接配置无法读取，原数据已保留"
        case .write: return "连接配置未保存，原数据已保留"
        case .remove: return "凭据未移除"
        case .oversized: return "连接配置超过 4 MiB"
        }
    }
}

final class MobileKeychainStorage: MobileCredentialStorage {
    private let service: String
    init(service: String = "app.aibro.mobile") { self.service = service }
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    func read(_ key: String) throws -> Data? {
        var query = query(key); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw MobileCredentialError.read }
        return data
    }
    func write(_ key: String, data: Data) throws {
        let query = query(key)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw MobileCredentialError.write }
    }
    func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MobileCredentialError.remove }
    }
}

final class MobileCredentialVault {
    private static let lock = NSLock()
    private static var processSalt = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    private static var syncGeneration: UInt64 = 0
    private static let allowed = Set(["sync", "model", "ucas", "speech"])
    private static let format = "aibro.connection-vault-native.v1"
    private static let limit = 4 * 1024 * 1024
    private static let maxRevision: Int64 = 9_007_199_254_740_991
    private let storage: MobileCredentialStorage
    init(storage: MobileCredentialStorage = MobileKeychainStorage()) { self.storage = storage }
    private func locked<T>(_ work: () throws -> T) rethrows -> T {
        Self.lock.lock(); defer { Self.lock.unlock() }; return try work()
    }
    private func legacyKey(_ key: String) throws {
        guard Self.allowed.contains(key) else { throw MobileCredentialError.invalid }
    }
    private static func advanceSession() {
        if syncGeneration == UInt64.max {
            processSalt = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }; syncGeneration = 0
        } else { syncGeneration += 1 }
    }
    func get(_ key: String) throws -> String? {
        try locked {
            try legacyKey(key)
            guard let data = try storage.read(key) else { return nil }
            guard let result = String(data: data, encoding: .utf8) else { throw MobileCredentialError.read }
            return result
        }
    }
    func set(_ key: String, value: String) throws {
        try locked {
            try legacyKey(key)
            let data = Data(value.utf8); guard data.count < 65536 else { throw MobileCredentialError.invalid }
            try storage.write(key, data: data)
            if key == "sync" { Self.advanceSession() }
        }
    }
    func remove(_ key: String) throws {
        try locked {
            try legacyKey(key); try storage.remove(key)
            if key == "sync" { Self.advanceSession() }
        }
    }
    private static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func digest(_ data: Data) -> String { encode(Data(SHA256.hash(data: data))) }
    private static func json(_ value: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else { throw MobileCredentialError.invalid }
        do { return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
        catch { throw MobileCredentialError.invalid }
    }
    private static func object(_ data: Data) throws -> [String: Any] {
        do {
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MobileCredentialError.invalid }
            return value
        } catch { throw MobileCredentialError.invalid }
    }
    private static func fields(_ value: [String: Any], _ keys: [String]) throws {
        guard Set(value.keys) == Set(keys) else { throw MobileCredentialError.invalid }
    }
    private static func text(_ value: [String: Any], _ key: String) throws -> String {
        guard let text = value[key] as? String else { throw MobileCredentialError.invalid }; return text
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    }
    private static func id(_ value: [String: Any], _ key: String) throws -> String {
        let value = try text(value, key)
        guard matches(value, "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$") else { throw MobileCredentialError.invalid }; return value
    }
    private static func revision(_ raw: Any?) throws -> Int64 {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= Double(maxRevision), number.doubleValue.rounded(.down) == number.doubleValue else { throw MobileCredentialError.invalid }
        return number.int64Value
    }
    private static func origin(_ raw: String) throws -> String {
        guard raw.utf8.count <= 2048, let url = URLComponents(string: raw), let scheme = url.scheme?.lowercased(), var host = url.host?.lowercased(),
              !host.isEmpty, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              url.port == nil || (0...65535).contains(url.port!) else { throw MobileCredentialError.invalid }
        if host.contains(":") && !host.hasPrefix("[") { host = "[" + host + "]" }
        let port = url.port
        return scheme + "://" + host + (port == nil || port == (scheme == "https" ? 443 : 80) ? "" : ":\(port!)")
    }
    private static func binding(_ value: [String: Any]) throws -> [String: String] {
        try fields(value, ["serverOrigin", "accountId"])
        let server = try text(value, "serverOrigin"), account = try id(value, "accountId")
        guard try origin(server) == server else { throw MobileCredentialError.invalid }
        return ["serverOrigin": server, "accountId": account]
    }
    private static func slot(_ binding: [String: String]) throws -> String {
        "connections.v1." + digest(try json([binding["serverOrigin"]!, binding["accountId"]!]))
    }
    private static func constantEqual(_ first: String, _ second: String) -> Bool {
        let a = Array(first.utf8), b = Array(second.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0; for index in a.indices { difference |= a[index] ^ b[index] }; return difference == 0
    }
    private static func fingerprint(_ value: String) throws {
        let encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
        guard matches(value, "^[A-Za-z0-9_-]{43}$"), let data = Data(base64Encoded: encoded), data.count == 32, encode(data) == value else { throw MobileCredentialError.invalid }
    }
    private static func session(_ raw: Data?) throws -> [String: Any] {
        do {
            guard let raw, raw.count < 65536 else { throw MobileCredentialError.invalid }
            let value = try object(raw); try fields(value, ["base", "token", "accountId", "sessionId"])
            guard !(try text(value, "token")).isEmpty else { throw MobileCredentialError.invalid }
            _ = try id(value, "accountId"); _ = try id(value, "sessionId"); _ = try origin(text(value, "base"))
            return value
        } catch { throw MobileCredentialError.reconnect }
    }
    private static func fence(_ raw: Data) throws -> String {
        guard let string = String(data: raw, encoding: .utf8) else { throw MobileCredentialError.reconnect }
        return digest(try json(["aibro.connection-session.v1", processSalt.base64EncodedString(), String(syncGeneration), string]))
    }
    func connectionSessionFence(expectedSyncSha256: String) throws -> String {
        try locked {
            guard Self.matches(expectedSyncSha256, "^[a-f0-9]{64}$") else { throw MobileCredentialError.invalid }
            let raw = try storage.read("sync"); _ = try Self.session(raw)
            let digest = SHA256.hash(data: raw!).map { String(format: "%02x", $0) }.joined()
            guard Self.constantEqual(digest, expectedSyncSha256) else { throw MobileCredentialError.session }
            return try Self.fence(raw!)
        }
    }
    private static func validateFence(_ fence: [String: Any], _ binding: [String: String]) throws {
        try fields(fence, ["nativeFence", "serverOrigin", "accountId", "sessionId", "generation"])
        try fingerprint(text(fence, "nativeFence")); _ = try id(fence, "accountId"); _ = try id(fence, "sessionId"); _ = try revision(fence["generation"])
        guard try text(fence, "serverOrigin") == binding["serverOrigin"], try text(fence, "accountId") == binding["accountId"] else { throw MobileCredentialError.invalid }
    }
    private func matchesSession(_ fence: [String: Any]) throws -> Bool {
        let raw = try storage.read("sync")
        guard let current = try? Self.session(raw), let raw else { return false }
        return try Self.text(current, "accountId") == Self.text(fence, "accountId") &&
            Self.text(current, "sessionId") == Self.text(fence, "sessionId") &&
            Self.origin(Self.text(current, "base")) == Self.text(fence, "serverOrigin") &&
            Self.constantEqual(Self.fence(raw), Self.text(fence, "nativeFence"))
    }
    private static func validateValue(_ value: Any, _ binding: [String: String]) throws {
        if value is NSNull { return }
        guard let object = value as? [String: Any], let rawBinding = object["binding"] as? [String: Any],
              try text(object, "format") == "aibro.connection-sync-local.v1", try self.binding(rawBinding) == binding else { throw MobileCredentialError.invalid }
    }
    private func readConnection(_ binding: [String: String]) throws -> [String: Any] {
        guard let raw = try storage.read(Self.slot(binding)) else { return ["revision": 0, "value": NSNull()] }
        do {
            guard raw.count <= Self.limit else { throw MobileCredentialError.invalid }
            let stored = try Self.object(raw); try Self.fields(stored, ["format", "binding", "revision", "value"])
            guard try Self.text(stored, "format") == Self.format, let rawBinding = stored["binding"] as? [String: Any],
                  try Self.binding(rawBinding) == binding, let value = stored["value"] else { throw MobileCredentialError.invalid }
            let revision = try Self.revision(stored["revision"]); guard revision > 0 else { throw MobileCredentialError.invalid }
            try Self.validateValue(value, binding)
            return ["revision": revision, "value": value]
        } catch { throw MobileCredentialError.read }
    }
    func connectionVaultRead(binding rawBinding: [String: Any], sessionFence: [String: Any]) throws -> [String: Any] {
        try locked {
            let binding = try Self.binding(rawBinding); try Self.validateFence(sessionFence, binding)
            guard try matchesSession(sessionFence) else { throw MobileCredentialError.session }
            return try readConnection(binding)
        }
    }
    func connectionVaultCompareAndSwap(binding rawBinding: [String: Any], expectedRevision: Any, value: Any, sessionFence: [String: Any]) throws -> Bool {
        try locked {
            let binding = try Self.binding(rawBinding); try Self.validateFence(sessionFence, binding)
            let revision = try Self.revision(expectedRevision); guard revision < Self.maxRevision else { throw MobileCredentialError.invalid }
            try Self.validateValue(value, binding)
            let raw = try Self.json(["format": Self.format, "binding": binding, "revision": revision + 1, "value": value])
            guard raw.count <= Self.limit else { throw MobileCredentialError.oversized }
            guard try matchesSession(sessionFence), try Self.revision(readConnection(binding)["revision"]) == revision else { return false }
            try storage.write(Self.slot(binding), data: raw); return true
        }
    }
}
// END CONNECTION_NATIVE_VAULT
