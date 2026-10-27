import Foundation
import WebKit
import UserNotifications

/// Headless kernel host (P8b). A hidden WKWebView loads `/kernel.html` from the
/// local service and runs queued `/__kernel/runs` there (kernel-host.js); it is
/// created only while runs are queued or active and released after two idle
/// minutes. The page gets a per-launch host token (also passed to the service)
/// and a `kernelHost` bridge with two jobs: the saved API key for the model
/// connection the page names (read from NativeCredentials, never stored by the
/// page), and attention: a run waiting for a person becomes a notification
/// whose 批准/拒绝 actions answer through the service with the native token.
/// The page never gets the native token, the credential store or any other
/// desktop bridge.
@MainActor final class NativeKernelHost: NSObject, WKScriptMessageHandlerWithReply {
    /// Per-launch secret shared with the service (AI_WORKSTATION_KERNEL_HOST_TOKEN).
    let token = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    var credentials: NativeCredentials?
    var nativeToken = ""
    var notificationsEnabled = true
    /// Opens the main window at a run (notification click).
    var onShow: ((String) -> Void)?
    private(set) var web: WKWebView?
    private var origin: URL?
    private var poll: Task<Void, Never>?
    private var idleSince: Date?
    private var notified = Set<String>()
    /// Registered with the agenda categories in AgendaStore (批准 / 拒绝 actions).
    static let category = "AIBRO_KERNEL_APPROVAL"
    /// Destructive steps: 查看 / 拒绝 only; approving needs the main window (the service enforces it too).
    static let reviewCategory = "AIBRO_KERNEL_REVIEW"
    static let idleRelease: TimeInterval = 120

    func start(origin: URL) {
        self.origin = origin
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    func stop() {
        poll?.cancel(); poll = nil
        release()
    }

    private func release() {
        guard let web else { return }
        web.stopLoading()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "kernelHost", contentWorld: .page)
        self.web = nil
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, native: Bool = false) async -> [String: Any]? {
        guard let origin, let url = URL(string: path, relativeTo: origin) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = method
        if native { request.setValue(nativeToken, forHTTPHeaderField: "X-AIBro-Native-Token") }
        else { request.setValue(token, forHTTPHeaderField: "X-AIBro-Kernel-Host") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Creates the page when there is work, releases it after a quiet spell,
    /// and turns new approvals into notifications (the page also reports them
    /// at once; whichever comes first wins, an approval is announced once).
    private func check() async {
        guard let pending = await request("/__kernel/host/pending") else { return }
        let work = (pending["queued"] as? Int ?? 0) + (pending["active"] as? Int ?? 0)
        if work > 0 { idleSince = nil; ensureWeb() }
        else if web != nil {
            if idleSince == nil { idleSince = Date() }
            if let since = idleSince, Date().timeIntervalSince(since) > Self.idleRelease { release(); idleSince = nil }
        }
        for item in pending["approvals"] as? [[String: Any]] ?? [] { announce(item) }
        if let reminders = pending["reminders"] as? [[String: Any]] { await planReminders(reminders) }
    }

    /// M1 scheduler reminders: handed to the system ahead of time (next 30 days,
    /// up to 60), so they arrive while AI Bro is closed, the same way agenda
    /// reminders do. One that came due before this process saw it (and is not
    /// past its two-hour window, which the service already applies) is shown once now.
    static let reminderPrefix = "scheduler-reminder-"
    private var reminderPlan = ""
    private var remindedNow = Set<String>()
    private func planReminders(_ items: [[String: Any]]) async {
        guard notificationsEnabled else { return }
        let wanted: [(id: String, fire: Date, title: String, body: String)] = items.compactMap { item in
            guard let id = item["id"] as? String, let at = item["fireAt"] as? Double else { return nil }
            return (Self.reminderPrefix + id, Date(timeIntervalSince1970: at), item["title"] as? String ?? "", item["body"] as? String ?? "")
        }
        let signature = wanted.map { $0.id + "|" + $0.title + "|" + $0.body }.joined(separator: "\n")
        guard signature != reminderPlan else { return }
        let center = UNUserNotificationCenter.current()
        let queued = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.reminderPrefix) }
        let shown = Set(await center.deliveredNotifications().map(\.request.identifier))
        let keep = Set(wanted.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers: queued.filter { !keep.contains($0) })
        let now = Date()
        for item in wanted {
            let content = UNMutableNotificationContent()
            content.title = nativeUI("提醒：", "Reminder: ") + item.title
            content.body = item.body.isEmpty ? nativeUI("打开 AI Bro 标记完成；2 小时未处理会标为过期。", "Open AI Bro to mark it done; it expires after two hours.") : item.body
            content.sound = .default
            content.userInfo = ["schedulerReminder": item.id]
            if item.fire > now {
                var parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.fire); parts.timeZone = Calendar.current.timeZone
                try? await center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)))
            } else if !shown.contains(item.id), remindedNow.insert(item.id).inserted {
                try? await center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: nil))
            }
        }
        reminderPlan = signature
    }

    private func ensureWeb() {
        guard web == nil, let origin, let url = URL(string: "/kernel.html", relativeTo: origin) else { return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // A hidden page must not be suspended or throttled while a run waits.
        config.preferences.inactiveSchedulingPolicy = .none
        let values: [String: Any] = ["hostToken": token, "hostId": "native-" + String(token.prefix(8))]
        if let data = try? JSONSerialization.data(withJSONObject: values) {
            config.userContentController.addUserScript(WKUserScript(source: "window.__aibroKernel=" + String(decoding: data, as: UTF8.self) + ";", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "kernelHost")
        let view = WKWebView(frame: .zero, configuration: config)
        web = view
        view.load(URLRequest(url: url))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === web, let origin, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == origin.host, message.frameInfo.securityOrigin.port == (origin.port ?? 80),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { replyHandler(nil, "unavailable"); return }
        switch type {
        case "connection":
            // Only the key for the service the page names; nothing else from the store.
            guard let base = body["base"] as? String, let store = credentials else { replyHandler(["token": ""], nil); return }
            // The store may touch the Keychain; keep it off the main thread.
            DispatchQueue.global(qos: .userInitiated).async {
                let token = (try? store.call("api", "read", ["base": base]))?["token"] as? String ?? ""
                DispatchQueue.main.async { replyHandler(["token": token], nil) }
            }
        case "attention":
            announce(["runId": body["runId"] ?? "", "approvalId": body["approvalId"] ?? "", "title": body["title"] ?? "", "tool": body["tool"] ?? "", "destructive": body["destructive"] as? Bool ?? false,
                      "scheduled": body["scheduled"] as? Bool ?? false, "outOfScope": body["outOfScope"] as? Bool ?? false])
            replyHandler(true, nil)
        case "paused":
            announcePause(runId: body["runId"] as? String ?? "", title: body["title"] as? String ?? "", message: body["message"] as? String ?? "")
            replyHandler(true, nil)
        default:
            replyHandler(true, nil)
        }
    }

    private func announce(_ item: [String: Any]) {
        guard notificationsEnabled, let runId = item["runId"] as? String, let approvalId = item["approvalId"] as? String,
              !runId.isEmpty, !approvalId.isEmpty, notified.insert(approvalId).inserted else { return }
        let tools = ["create_task": nativeUI("新建任务", "Create task"), "create_note": nativeUI("新建笔记", "Create note")]
        let content = UNMutableNotificationContent()
        // A scheduled task that stepped outside its declared scope is paused until you answer.
        content.title = item["outOfScope"] as? Bool == true ? nativeUI("计划任务超出声明范围，已暂停等你批准", "A scheduled task went beyond its declared scope and is waiting for you")
            : item["scheduled"] as? Bool == true ? nativeUI("计划任务需要你审批", "A scheduled task needs your approval")
            : nativeUI("后台运行需要你审批", "A background run needs your approval")
        let tool = item["tool"] as? String ?? ""
        let title = item["title"] as? String ?? nativeUI("后台运行", "Background run")
        let destructive = item["destructive"] as? Bool ?? false
        content.body = destructive
            ? nativeUI("\(title)：\(tools[tool] ?? tool)（风险步骤）。请在 AI Bro 主窗口查看后批准。", "\(title): \(tools[tool] ?? tool) (risky step). Review and approve it in the AI Bro main window.")
            : nativeUI("\(title)：\(tools[tool] ?? tool)。打开 AI Bro 查看详情。", "\(title): \(tools[tool] ?? tool). Open AI Bro for details.")
        content.sound = .default
        content.categoryIdentifier = destructive ? Self.reviewCategory : Self.category
        content.userInfo = ["kernelRun": runId, "kernelApproval": approvalId]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "kernel-approval-" + approvalId, content: content, trigger: nil))
    }

    /// A run paused by the model's usage limit (P9b): tell the user once per pause; a click opens the run.
    private func announcePause(runId: String, title: String, message: String) {
        guard notificationsEnabled, !runId.isEmpty else { return }
        let content = UNMutableNotificationContent()
        content.title = nativeUI("后台运行已暂停", "A background run is paused")
        let name = title.isEmpty ? nativeUI("后台运行", "Background run") : String(title.prefix(80))
        let reason = message.isEmpty ? nativeUI("模型额度已用尽。", "The model's usage limit was reached.") : String(message.prefix(200))
        content.body = "\(name)：\(reason)"
        content.sound = .default
        // No approval id: a click only opens the run (respond() shows it).
        content.userInfo = ["kernelRun": runId, "kernelApproval": ""]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "kernel-paused-" + runId + "-" + String(Int(Date().timeIntervalSince1970)), content: content, trigger: nil))
    }

    /// A notification action: 批准 / 拒绝 answer as the native shell; 查看 or a plain click opens the run.
    func respond(runId: String, approvalId: String, action: String) {
        let decision = action == "KERNEL_APPROVE" ? "allowed-once" : action == "KERNEL_REJECT" ? "rejected" : nil
        guard let decision else { onShow?(runId); return }
        let path = "/__kernel/runs/\(runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")/approvals/\(approvalId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")"
        Task { _ = await request(path, method: "POST", body: ["decision": decision], native: true) }
    }
}
