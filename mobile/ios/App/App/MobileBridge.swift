import Foundation
import Capacitor
import Security
import SQLite3
import QuickLook
import Vision
import PDFKit
import WidgetKit

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
    let pluginMethods = ["load", "save", "secretGet", "secretSet", "secretRemove", "request", "preview", "extractText", "shared", "sharedAck", "widgetSave"].compactMap { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private let queue = DispatchQueue(label: "app.aibro.mobile.storage")
    private var previewURL: URL?
    private let redirect = NoRedirect()
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
    private func secretQuery(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"), ["sync", "model", "ucas"].contains(key) else { call.reject("未知凭据类型"); return nil }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.aibro.mobile", kSecAttrAccount as String: key]
    }
    @objc func secretGet(_ call: CAPPluginCall) {
        guard var query = secretQuery(call) else { return }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { call.reject("钥匙串暂不可读取，请解锁设备后重试"); return }
        call.resolve(["value": value])
    }
    @objc func secretSet(_ call: CAPPluginCall) {
        guard let query = secretQuery(call) else { return }
        guard let value = call.getString("value")?.data(using: .utf8), value.count < 65536 else { call.reject("凭据格式无效"); return }
        let attributes: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        if status == errSecSuccess { call.resolve() } else { call.reject("凭据未保存，请解锁设备后重试") }
    }
    @objc func secretRemove(_ call: CAPPluginCall) {
        guard let query = secretQuery(call) else { return }
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("凭据未移除") }
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
            guard let root = self.inbox(), FileManager.default.fileExists(atPath: root.path) else { call.resolve(["items": []]); return }
            let folders = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).sorted { $0.lastPathComponent < $1.lastPathComponent }
            var items: [[String: Any]] = []
            for folder in folders.prefix(1) {
                guard UUID(uuidString: folder.lastPathComponent) != nil,
                      let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
                      var item = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                var files: [[String: Any]] = []
                var totalBytes=0
                for descriptor in item["files"] as? [[String: Any]] ?? [] {
                    guard let path = descriptor["path"] as? String, !path.contains("/"), !path.contains("..") else { continue }
                    let data = try Data(contentsOf: folder.appendingPathComponent(path))
                    totalBytes += data.count
                    guard totalBytes <= 32 * 1024 * 1024 else { throw self.failure("分享附件合计超过 32 MB") }
                    var file = descriptor; file["data"] = data.base64EncodedString(); files.append(file)
                }
                item["id"] = folder.lastPathComponent; item["files"] = files; items.append(item)
            }
            call.resolve(["items": items])
        } catch { call.reject("分享资料暂未读取，原件仍保留") } }
    }
    @objc func sharedAck(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil, let root = inbox() else { call.reject("分享标识无效"); return }
        queue.async { do { try FileManager.default.removeItem(at: root.appendingPathComponent(id)); call.resolve() } catch { call.reject("分享已导入，但清理收件箱失败") } }
    }
}
