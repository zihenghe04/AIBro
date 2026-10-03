import AppKit
import ApplicationServices
import Combine

/// An ephemeral process identity, never persisted with clipboard history.
struct NativeQuickClipboardPasteTarget: Equatable {
    let pid: pid_t
    let bundleID: String
    let bundlePath: String
    let launchedAt: Date
    let name: String
    func isSameProcess(as other: Self) -> Bool {
        pid == other.pid && bundleID == other.bundleID && bundlePath == other.bundlePath && launchedAt == other.launchedAt
    }
}

@MainActor protocol NativeQuickClipboardPasteEnvironment: AnyObject {
    var ownPID: pid_t { get }
    var trusted: Bool { get }
    func frontmost() -> NativeQuickClipboardPasteTarget?
    func isRunning(_ target: NativeQuickClipboardPasteTarget) -> Bool
    func captureFocus(_ target: NativeQuickClipboardPasteTarget) async -> AnyObject?
    func focusMatches(_ focus: AnyObject, target: NativeQuickClipboardPasteTarget) -> Bool
    func activate(_ target: NativeQuickClipboardPasteTarget) -> Bool
    func sendPaste(_ target: NativeQuickClipboardPasteTarget) -> Bool
    func observeActivation(_ changed: @escaping (pid_t) -> Void) -> () -> Void
    func waitForActivation() async throws
}

/// AX IPC stays off the main actor. Only an opaque focused-element identity is
/// returned; cancellation releases the awaiter without pretending to interrupt
/// an IPC already in progress. The OS request itself also has a short timeout.
final class NativeQuickClipboardFocusWorker: @unchecked Sendable {
    final class Snapshot: @unchecked Sendable {
        let value: AnyObject
        init(_ value: AnyObject) { self.value = value }
    }
    private final class Request: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private var continuation: CheckedContinuation<Snapshot?, Never>?
        func attach(_ value: CheckedContinuation<Snapshot?, Never>) -> Bool {
            lock.lock()
            if finished { lock.unlock(); value.resume(returning: nil); return false }
            continuation = value; lock.unlock(); return true
        }
        var isActive: Bool { lock.lock(); defer { lock.unlock() }; return !finished }
        func finish(_ value: Snapshot?) {
            lock.lock()
            guard !finished else { lock.unlock(); return }
            finished = true; let reply = continuation; continuation = nil
            lock.unlock(); reply?.resume(returning: value)
        }
    }
    private let queue = DispatchQueue(label: "app.aibro.clipboard.focus", qos: .userInitiated)
    private let read: @Sendable (pid_t) -> Snapshot?
    init(read: @escaping @Sendable (pid_t) -> Snapshot? = { pid in
        NativeQuickClipboardAXFocus.read(pid: pid).map { Snapshot($0) }
    }) { self.read = read }
    func capture(pid: pid_t) async -> Snapshot? {
        let request = Request()
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                guard request.attach(continuation) else { return }
                queue.async { [read] in
                    guard request.isActive else { return }
                    let result = read(pid)
                    request.finish(result)
                }
            }
        }, onCancel: { request.finish(nil) })
    }
}

private final class NativeQuickClipboardAXFocus {
    let element: AXUIElement
    init(_ element: AXUIElement) { self.element = element }
    static func read(pid: pid_t) -> NativeQuickClipboardAXFocus? {
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(app, 0.12) == .success else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return NativeQuickClipboardAXFocus(value as! AXUIElement)
    }
}

@MainActor final class NativeQuickClipboardSystemPasteEnvironment: NativeQuickClipboardPasteEnvironment {
    private let focusWorker = NativeQuickClipboardFocusWorker()
    var ownPID: pid_t { ProcessInfo.processInfo.processIdentifier }
    // Neither API requests permission. Missing permission is a copy-only outcome.
    var trusted: Bool { AXIsProcessTrusted() && CGPreflightPostEventAccess() }
    private func identity(_ app: NSRunningApplication?) -> NativeQuickClipboardPasteTarget? {
        guard let app, !app.isTerminated, let bundle = app.bundleIdentifier,
              let path = app.bundleURL?.standardizedFileURL.path, let launched = app.launchDate else { return nil }
        return .init(pid: app.processIdentifier, bundleID: bundle, bundlePath: path, launchedAt: launched,
                     name: app.localizedName ?? bundle)
    }
    func frontmost() -> NativeQuickClipboardPasteTarget? { identity(NSWorkspace.shared.frontmostApplication) }
    func isRunning(_ target: NativeQuickClipboardPasteTarget) -> Bool {
        identity(NSRunningApplication(processIdentifier: target.pid))?.isSameProcess(as: target) == true
    }
    func captureFocus(_ target: NativeQuickClipboardPasteTarget) async -> AnyObject? {
        guard trusted, isRunning(target), frontmost()?.isSameProcess(as: target) == true else { return nil }
        let snapshot = await focusWorker.capture(pid: target.pid)
        guard !Task.isCancelled, trusted, isRunning(target),
              frontmost()?.isSameProcess(as: target) == true else { return nil }
        return snapshot?.value
    }
    func focusMatches(_ focus: AnyObject, target: NativeQuickClipboardPasteTarget) -> Bool {
        guard trusted, isRunning(target), let expected = focus as? NativeQuickClipboardAXFocus,
              let current = NativeQuickClipboardAXFocus.read(pid: target.pid) else { return false }
        return CFEqual(expected.element, current.element)
    }
    func activate(_ target: NativeQuickClipboardPasteTarget) -> Bool {
        guard isRunning(target), let app = NSRunningApplication(processIdentifier: target.pid) else { return false }
        return app.activate(options: [])
    }
    func sendPaste(_ target: NativeQuickClipboardPasteTarget) -> Bool {
        guard trusted, isRunning(target), frontmost()?.isSameProcess(as: target) == true,
              let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { return false }
        down.flags = .maskCommand; up.flags = .maskCommand
        // PID-directed events cannot fall through to a different frontmost app.
        // Delivery is not an acknowledgement that the receiving editor inserted.
        down.postToPid(target.pid); up.postToPid(target.pid)
        return true
    }
    func observeActivation(_ changed: @escaping (pid_t) -> Void) -> () -> Void {
        let center = NSWorkspace.shared.notificationCenter
        let observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { changed(app.processIdentifier) }
        }
        return { center.removeObserver(observer) }
    }
    func waitForActivation() async throws { try await Task.sleep(nanoseconds: 20_000_000) }
}

/// One explicit paste request, tied to the opening that captured its target.
/// This service has no clipboard reader, permission prompt, history monitor,
/// persisted target, shell command, or ability to select an arbitrary app.
@MainActor final class NativeQuickClipboardPasteBack: ObservableObject {
    @Published private(set) var targetName: String?
    @Published private(set) var busy = false
    var onFeedback: ((String) -> Void)?
    private let environment: NativeQuickClipboardPasteEnvironment
    private var available = false
    private var session: UUID?
    private var target: NativeQuickClipboardPasteTarget?
    private var focus: AnyObject?
    private var stopObserving: (() -> Void)?
    private var focusCapture: Task<Void, Never>?
    private var captureToken: UUID?
    private var activationEpoch: UInt64 = 0
    private var collapsingSession: UUID?
    private var focusRevokedSession: UUID?
    private var isPresented: () -> Bool = { false }
    private var collapse: () async -> Bool = { false }
    init(environment: NativeQuickClipboardPasteEnvironment? = nil) {
        self.environment = environment ?? NativeQuickClipboardSystemPasteEnvironment()
    }
    deinit { focusCapture?.cancel(); stopObserving?() }
    func configure(isPresented: @escaping () -> Bool, collapse: @escaping () async -> Bool) {
        self.isPresented = isPresented; self.collapse = collapse
    }
    func setAvailable(_ value: Bool) { available = value; if !value { invalidate() } }
    func shutdown() { available = false; invalidate() }
    /// Call before the island becomes key/activates AI Bro, only for a new opening.
    func beginSession() {
        invalidate()
        guard available else { return }
        let token = UUID(); session = token
        guard let app = environment.frontmost(), app.pid != environment.ownPID else { return }
        target = app; targetName = app.name
        // Install before scheduling IPC. A switch away and back while reading
        // must not turn a later input field into the original focus snapshot.
        stopObserving = environment.observeActivation { [weak self] pid in
            guard let self, let target else { return }
            if pid != target.pid { cancelFocusCapture() }
            if pid != environment.ownPID && pid != target.pid { invalidate(focusChanged: true) }
        }
        guard environment.trusted else { return }
        let epoch = activationEpoch, captureEnvironment = environment
        captureToken = token
        focusCapture = Task { [weak self] in
            defer { self?.finishFocusCapture(token) }
            guard self?.canCapture(token, epoch: epoch, target: app) == true else { return }
            let original = await captureEnvironment.captureFocus(app)
            guard let self, canCapture(token, epoch: epoch, target: app) else { return }
            focus = original
        }
    }
    private func canCapture(_ token: UUID, epoch: UInt64, target: NativeQuickClipboardPasteTarget) -> Bool {
        valid(token) && captureToken == token && activationEpoch == epoch && environment.trusted &&
            environment.isRunning(target) && environment.frontmost()?.isSameProcess(as: target) == true
    }
    private func finishFocusCapture(_ token: UUID) {
        guard captureToken == token else { return }
        focusCapture = nil; captureToken = nil
    }
    private func cancelFocusCapture() {
        activationEpoch &+= 1
        focusCapture?.cancel(); focusCapture = nil; captureToken = nil
    }
    /// An ordinary close cancels pending reads. Our acknowledged close retains
    /// only its in-flight lease; a new opening or private mode always revokes it.
    func endSession() { if collapsingSession != session || session == nil { invalidate() } }
    private func invalidate(focusChanged: Bool = false) {
        cancelFocusCapture()
        focusRevokedSession = focusChanged ? session : nil
        session = nil; target = nil; focus = nil; targetName = nil
        stopObserving?(); stopObserving = nil
    }
    private func valid(_ token: UUID) -> Bool { available && session == token && !Task.isCancelled }
    private func focusChangeFeedback(_ token: UUID, outsidePanel: Bool = false) -> String? {
        guard available, focusRevokedSession == token, !Task.isCancelled else { return nil }
        let message = nativeUI("目标应用已切换，未发送粘贴。", "The target app changed. No paste was sent.")
        focusRevokedSession = nil
        if outsidePanel { onFeedback?(message) }
        return message
    }
    private func permittedFrontmost(_ target: NativeQuickClipboardPasteTarget) -> Bool {
        guard let current = environment.frontmost() else { return false }
        return current.pid == environment.ownPID || current.isSameProcess(as: target)
    }
    var actionLabel: String {
        targetName.map { nativeUI("粘回 \($0)", "Paste back to \($0)") } ?? nativeUI("复制", "Copy")
    }
    /// copy receives a commit guard so a delayed archive read cannot write after
    /// the user closes or leaves the island. isCopyCurrent is count-only.
    func perform(copy: (_ canCommit: @escaping () -> Bool) async -> Int?,
                 isCopyCurrent: (Int) -> Bool) async -> String? {
        guard !busy, available, isPresented(), let token = session else { return nil }
        busy = true
        defer { busy = false; collapsingSession = nil }
        let destination = target
        guard let count = await copy({ [weak self] in self?.valid(token) == true && self?.isPresented() == true }) else { return nil }
        guard valid(token) else { return focusChangeFeedback(token) }
        if let pendingCapture = focusCapture { await pendingCapture.value }
        guard valid(token) else { return focusChangeFeedback(token) }
        guard isCopyCurrent(count) else { return nil }
        let originalFocus = focus
        func copiedOnly(_ zh: String, _ en: String) -> String { nativeUI("已复制；" + zh, "Copied. " + en) }
        guard let destination else { return copiedOnly("没有可返回的原应用，请手动粘贴。", "No previous app is available. Paste manually.") }
        guard environment.trusted else { return copiedOnly("未获辅助功能权限，请在原应用手动粘贴。", "Accessibility permission is unavailable. Paste manually in the original app.") }
        guard environment.isRunning(destination) else { return copiedOnly("原应用已退出，请手动粘贴。", "The original app has quit. Paste manually.") }
        guard let originalFocus, permittedFrontmost(destination) else { return copiedOnly("原输入位置无法确认，请手动粘贴。", "The original input target could not be confirmed. Paste manually.") }
        collapsingSession = token
        let collapsed = await collapse()
        guard valid(token) else { return focusChangeFeedback(token, outsidePanel: collapsed) }
        defer { if session == token { invalidate() } }
        func feedback(_ message: String) -> String? {
            guard valid(token) else { return focusChangeFeedback(token, outsidePanel: collapsed) }
            if collapsed { onFeedback?(message) }
            return message
        }
        guard collapsed else { return feedback(copiedOnly("面板未完成收起，请手动粘贴。", "The panel did not finish closing. Paste manually.")) }
        guard isCopyCurrent(count) else { return feedback(nativeUI("剪贴板已改变，未发送粘贴。", "Clipboard changed. No paste was sent.")) }
        guard environment.trusted, environment.isRunning(destination), permittedFrontmost(destination) else {
            return feedback(copiedOnly("原应用或权限已变化，未自动粘贴。", "The original app or permission changed. No automatic paste was sent."))
        }
        guard environment.activate(destination) else { return feedback(copiedOnly("无法激活原应用，请手动粘贴。", "Could not activate the original app. Paste manually.")) }
        // At most 400 ms, without blocking the main actor or changing another app.
        for attempt in 0...20 {
            guard valid(token) else { return focusChangeFeedback(token, outsidePanel: collapsed) }
            guard isCopyCurrent(count), environment.trusted, environment.isRunning(destination), permittedFrontmost(destination) else {
                return feedback(nativeUI("目标或剪贴板已变化，未发送粘贴。", "The target or clipboard changed. No paste was sent."))
            }
            if environment.frontmost()?.isSameProcess(as: destination) == true {
                guard environment.focusMatches(originalFocus, target: destination),
                      valid(token), isCopyCurrent(count), environment.trusted,
                      environment.frontmost()?.isSameProcess(as: destination) == true else {
                    return feedback(copiedOnly("输入焦点已变化，请手动粘贴。", "Input focus changed. Paste manually."))
                }
                guard environment.sendPaste(destination) else { return feedback(copiedOnly("粘贴未能发送，请手动粘贴。", "Paste could not be sent. Paste manually.")) }
                return feedback(nativeUI("已向 \(destination.name) 发送粘贴。", "Paste sent to \(destination.name)."))
            }
            if attempt == 20 { break }
            do { try await environment.waitForActivation() } catch { return nil }
        }
        return feedback(copiedOnly("原应用未取得焦点，请手动粘贴。", "The original app did not gain focus. Paste manually."))
    }
}
