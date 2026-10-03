import AppKit
import Combine
import Carbon

enum NativeQuickSpotifyOperation: Equatable {
    case read, authorize, play, pause, previous, next
    case seek(NativeQuickSpotifySeek), setRepeat(Bool), setShuffle(Bool)
}
struct NativeQuickSpotifySeek: Equatable {
    let trackID: String
    let target: NativeQuickSpotifyTarget
    let observedAt: TimeInterval
    let position: TimeInterval
    let duration: TimeInterval
}
enum NativeQuickSpotifyRejection { case trackChanged, processChanged, expired, invalidPosition }
enum NativeQuickSpotifyState: Equatable {
    case checking, notInstalled, notRunning, launching, launchFailed, launchTimedOut
    case authorizationRequired, denied, stopped, paused, playing, timedOut, unavailable
}
struct NativeQuickSpotifySnapshot: Equatable {
    var state: NativeQuickSpotifyState
    var title = ""
    var artist = ""
    var trackID = ""
    var target: NativeQuickSpotifyTarget?
    var observedAt: TimeInterval = 0
    var position: TimeInterval?
    var duration: TimeInterval?
    var rawDuration: Double?
    var repeating: Bool?
    var shuffling: Bool?
    var canSeek: Bool {
        guard canControl, !trackID.isEmpty, target != nil, let duration, let position else { return false }
        return duration.isFinite && duration > 0 && position.isFinite && position >= 0 && position <= duration + 1
    }
    func displayedPosition(at uptime: TimeInterval) -> TimeInterval {
        let elapsed = state == .playing ? max(0, min(3, uptime - observedAt)) : 0
        return min(duration ?? 0, max(0, (position ?? 0) + elapsed))
    }
    var canControl: Bool { [.playing, .paused, .stopped].contains(state) }
    var statusText: String {
        switch state {
        case .checking: return nativeUI("正在检查 Spotify…", "Checking Spotify…")
        case .notInstalled: return nativeUI("未找到已安装的 Spotify，可先使用本地音频", "Spotify is not installed. Local audio is available.")
        case .notRunning: return nativeUI("Spotify 未运行", "Spotify is not running")
        case .launching: return nativeUI("正在启动 Spotify…", "Starting Spotify…")
        case .launchFailed: return nativeUI("无法确认 Spotify 已启动，请重新检查", "Could not confirm Spotify started. Check again.")
        case .launchTimedOut: return nativeUI("启动 Spotify 尚未完成，请重新检查", "Spotify has not finished starting. Check again.")
        case .authorizationRequired: return nativeUI("连接 Spotify 以显示正在播放", "Connect Spotify to see now playing")
        case .denied: return nativeUI("请在系统设置的自动化中允许 AI Bro 控制 Spotify", "Allow AI Bro to control Spotify in System Settings → Automation")
        case .stopped: return nativeUI("尚未播放", "Not playing")
        case .paused: return nativeUI("已暂停", "Paused")
        case .playing: return nativeUI("正在播放", "Playing")
        case .timedOut: return nativeUI("Spotify 未及时响应，请检查后重试", "Spotify did not respond in time. Check it and retry.")
        case .unavailable: return nativeUI("暂时无法读取 Spotify，请重试", "Spotify is unavailable. Try again.")
        }
    }
}

struct NativeQuickSpotifyTarget: Equatable {
    let pid: pid_t
    let launchedAt: Date
}
enum NativeQuickSpotifyReply { case snapshot(NativeQuickSpotifySnapshot), rejected(NativeQuickSpotifyRejection), busy, cancelled }
enum NativeQuickSpotifyFailure: Error { case status(OSStatus), rejected(NativeQuickSpotifyRejection), cancelled, timeout }

struct NativeQuickSpotifyLaunchedApplication {
    let bundleID: String?
    let pid: pid_t
    let launchedAt: Date?
    let terminated: Bool
    var observe: (() -> NativeQuickSpotifyLaunchObservation)? = nil
    var target: NativeQuickSpotifyTarget? {
        guard bundleID == NativeQuickSpotifyAppleEvents.bundleID, pid > 0, !terminated, let launchedAt else { return nil }
        return .init(pid: pid, launchedAt: launchedAt)
    }
}
enum NativeQuickSpotifyLaunchObservation {
    case ready(NativeQuickSpotifyTarget), pending(String), rejected(String)
}
struct NativeQuickSpotifyOpenResult {
    var application: NativeQuickSpotifyLaunchedApplication?
    var errorDomain: String? = nil
    var errorCode: Int? = nil
}
struct NativeQuickSpotifyLaunchDiagnostic: Codable, Equatable {
    let reason: String
    var pid: pid_t? = nil
    var errorDomain: String? = nil
    var errorCode: Int? = nil
    private static let writer = DispatchQueue(label: "app.aibro.spotify-launch-diagnostic")
    static func record(_ events: [Self]) {
        // Isolated Demo diagnostics contain only lifecycle reasons, process IDs
        // and OS error codes, never error descriptions, track or library data.
        guard Bundle.main.object(forInfoDictionaryKey: "AIBroProduction") as? Bool == false,
              Bundle.main.bundleIdentifier == "dev.aibro.marketing.20261001" else { return }
        writer.async {
            guard let data = try? JSONEncoder().encode(events) else { return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-spotify-launch-\(ProcessInfo.processInfo.processIdentifier).json")
            try? data.write(to: file, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }
}
enum NativeQuickSpotifyLaunchReply { case opened(NativeQuickSpotifyTarget), notInstalled, failed, timedOut, busy, cancelled }

final class NativeQuickSpotifyLaunchRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: ((NativeQuickSpotifyLaunchReply) -> Void)?
    private var expired = false
    private var openCompleted = false
    private var events: [NativeQuickSpotifyLaunchDiagnostic] = []
    init(_ callback: @escaping (NativeQuickSpotifyLaunchReply) -> Void) { self.callback = callback }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return expired }
    var didOpenComplete: Bool { lock.lock(); defer { lock.unlock() }; return openCompleted }
    func claimOpenCompletion() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !openCompleted else { return false }; openCompleted = true; return true
    }
    func note(_ event: NativeQuickSpotifyLaunchDiagnostic, emit: ([NativeQuickSpotifyLaunchDiagnostic]) -> Void) {
        lock.lock()
        guard events.last != event else { lock.unlock(); return }
        events.append(event); let snapshot = Array(events.suffix(24)); lock.unlock()
        emit(snapshot)
    }
    func cancel() { finish(.cancelled, invalidate: true) }
    func finish(_ result: NativeQuickSpotifyLaunchReply, invalidate: Bool = false) {
        lock.lock(); let completion = callback; callback = nil; expired = expired || invalidate; lock.unlock()
        completion?(result)
    }
}

/// Discovery never opens an application. Only an explicit launch request reaches
/// NSWorkspace, and its callback supplies a process identity, not playback state.
final class NativeQuickSpotifyLauncher: @unchecked Sendable {
    typealias Open = (URL, @escaping (NativeQuickSpotifyOpenResult) -> Void) -> Void
    private let findApplication: () -> URL?
    private let validApplication: (URL) -> Bool
    private let runningTarget: () -> NativeQuickSpotifyTarget?
    private let isSameTarget: (NativeQuickSpotifyTarget) -> Bool
    private let open: Open
    private let timeout: TimeInterval
    private let readinessInterval: TimeInterval
    private let now: () -> Date
    private let diagnostics: ([NativeQuickSpotifyLaunchDiagnostic]) -> Void
    private let lock = NSLock()
    private var opening: UUID?
    init(findApplication: @escaping () -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: NativeQuickSpotifyAppleEvents.bundleID) },
         validApplication: @escaping (URL) -> Bool = NativeQuickSpotifyLauncher.isSpotifyApplication,
         runningTarget: @escaping () -> NativeQuickSpotifyTarget? = { NativeQuickSpotifyAppleEvents().runningTarget() },
         isSameTarget: @escaping (NativeQuickSpotifyTarget) -> Bool = { NativeQuickSpotifyAppleEvents().isSameTarget($0) },
         timeout: TimeInterval = 15, readinessInterval: TimeInterval = 0.1, now: @escaping () -> Date = Date.init,
         diagnostics: @escaping ([NativeQuickSpotifyLaunchDiagnostic]) -> Void = NativeQuickSpotifyLaunchDiagnostic.record,
         open: @escaping Open = NativeQuickSpotifyLauncher.openApplication) {
        self.findApplication = findApplication; self.validApplication = validApplication
        self.runningTarget = runningTarget; self.isSameTarget = isSameTarget
        self.timeout = timeout; self.open = open; self.readinessInterval = readinessInterval
        self.now = now; self.diagnostics = diagnostics
    }
    static func isSpotifyApplication(_ url: URL) -> Bool {
        guard url.isFileURL, let bundle = Bundle(url: url), bundle.bundleIdentifier == NativeQuickSpotifyAppleEvents.bundleID,
              let executable = bundle.executableURL else { return false }
        return FileManager.default.isExecutableFile(atPath: executable.path)
    }
    static func openApplication(_ url: URL, completion: @escaping (NativeQuickSpotifyOpenResult) -> Void) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            // NSWorkspace calls back on a concurrent queue. NSRunningApplication
            // property freshness follows the main run loop; normalize there,
            // retain the callback object and compare isEqual (the SDK's process
            // identity API), not two independently captured launch-date values.
            DispatchQueue.main.async {
                let value = app.map { app in
                    NativeQuickSpotifyLaunchedApplication(bundleID: app.bundleIdentifier, pid: app.processIdentifier,
                        launchedAt: app.launchDate, terminated: app.isTerminated, observe: {
                            guard !app.isTerminated else { return .rejected("callback-process-exited") }
                            guard let bundle = app.bundleIdentifier else { return .pending("callback-bundle-pending") }
                            guard bundle == NativeQuickSpotifyAppleEvents.bundleID else { return .rejected("callback-bundle-mismatch") }
                            let pid = app.processIdentifier
                            guard pid > 0, let current = NSRunningApplication(processIdentifier: pid) else { return .pending("callback-process-pending") }
                            guard !current.isTerminated, app.isEqual(current) else { return .rejected("callback-identity-changed") }
                            guard current.bundleIdentifier == NativeQuickSpotifyAppleEvents.bundleID,
                                  let date = current.launchDate else { return .pending("callback-date-pending") }
                            return .ready(.init(pid: pid, launchedAt: date))
                        })
                }
                let failure = error as NSError?
                completion(.init(application: value, errorDomain: failure?.domain, errorCode: failure?.code))
            }
        }
    }
    func installedApplication() -> URL? {
        guard let url = findApplication(), validApplication(url) else { return nil }
        return url
    }
    @discardableResult func launch(completion: @escaping (NativeQuickSpotifyLaunchReply) -> Void) -> NativeQuickSpotifyLaunchRequest {
        let request = NativeQuickSpotifyLaunchRequest(completion), identity = UUID()
        lock.lock(); let occupied = opening != nil; if !occupied { opening = identity }; lock.unlock()
        guard !occupied else { request.finish(.busy); return request }
        func release() { lock.lock(); if opening == identity { opening = nil }; lock.unlock() }
        func isCurrent() -> Bool { lock.lock(); defer { lock.unlock() }; return opening == identity }
        func note(_ reason: String, pid: pid_t? = nil) { request.note(.init(reason: reason, pid: pid), emit: diagnostics) }
        // A process may have appeared since the card's last passive check.
        if let target = runningTarget(), isSameTarget(target) {
            release(); request.finish(.opened(target)); return request
        }
        guard let url = installedApplication() else { release(); request.finish(.notInstalled); return request }
        if let target = runningTarget(), isSameTarget(target) {
            release(); request.finish(.opened(target)); return request
        }
        let beganAt = now()
        let deadline = DispatchWorkItem {
            note("readiness-deadline")
            request.finish(.timedOut, invalidate: true)
            // An OS open which has not returned stays occupied. Readiness after
            // its callback is only observation, so its deadline can release it.
            if request.didOpenComplete { release() }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: deadline)
        open(url) { [self] result in
            guard request.claimOpenCompletion() else { return }
            DispatchQueue.main.async {
                guard isCurrent() else { return }
                if let code = result.errorCode {
                    let domain = result.errorDomain.map { String($0.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || ".-_".unicodeScalars.contains($0) }.prefix(80)) }
                    request.note(.init(reason: "workspace-error", errorDomain: domain, errorCode: code), emit: diagnostics)
                }
                func finish(_ reply: NativeQuickSpotifyLaunchReply) { deadline.cancel(); release(); request.finish(reply) }
                func observe() {
                    guard isCurrent() else { return }
                    guard !request.isCancelled else { note("observation-cancelled"); deadline.cancel(); release(); return }
                    let observation: NativeQuickSpotifyLaunchObservation
                    if let application = result.application {
                        if let inspect = application.observe { observation = inspect() }
                        else if application.terminated { observation = .rejected("callback-process-exited") }
                        else if let bundle = application.bundleID, bundle != NativeQuickSpotifyAppleEvents.bundleID { observation = .rejected("callback-bundle-mismatch") }
                        else if let target = application.target { observation = .ready(target) }
                        else { observation = .pending("callback-metadata-pending") }
                    } else if let target = runningTarget() {
                        // A LaunchServices completion can lack an app despite
                        // a successful start. Accept only an independently
                        // identified Spotify process from this launch window.
                        let age = now().timeIntervalSince(target.launchedAt)
                        if target.launchedAt >= beganAt.addingTimeInterval(-1), age >= -1, isSameTarget(target) {
                            observation = .ready(target)
                        } else { observation = .pending("unattributed-process") }
                    } else { observation = .pending("workspace-process-pending") }
                    switch observation {
                    case .ready(let target):
                        if isSameTarget(target) { note("process-confirmed", pid: target.pid); finish(.opened(target)); return }
                        if let current = runningTarget(), current != target { note("process-identity-changed", pid: target.pid); finish(.failed); return }
                        note("process-registration-pending", pid: target.pid)
                    case .rejected(let reason): note(reason); finish(.failed); return
                    case .pending(let reason): note(reason)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + readinessInterval) { observe() }
                }
                observe()
            }
        }
        return request
    }
}

/// Direct, public AppleEvents only. The contract is Spotify's installed,
/// published Spotify.sdef, not private MediaRemote ABI or UI key simulation.
protocol NativeQuickSpotifyTransport: AnyObject {
    func runningTarget() -> NativeQuickSpotifyTarget?
    func isSameTarget(_ target: NativeQuickSpotifyTarget) -> Bool
    func permission(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, ask: Bool) -> OSStatus
    func send(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation,
              property: String?, timeout: TimeInterval) throws -> NSAppleEventDescriptor
}

final class NativeQuickSpotifyAppleEvents: NativeQuickSpotifyTransport {
    static let bundleID = "com.spotify.client"
    static func code(_ value: String) -> OSType { value.utf8.reduce(0) { ($0 << 8) | OSType($1) } }
    func runningTarget() -> NativeQuickSpotifyTarget? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID)
            .first(where: { !$0.isTerminated }), let date = app.launchDate else { return nil }
        return .init(pid: app.processIdentifier, launchedAt: date)
    }
    func isSameTarget(_ target: NativeQuickSpotifyTarget) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: target.pid) else { return false }
        return !app.isTerminated && app.bundleIdentifier == Self.bundleID && app.launchDate == target.launchedAt
    }
    private func address(_ target: NativeQuickSpotifyTarget) -> NSAppleEventDescriptor {
        // PID addressing cannot launch a stopped application. Verify bundle and
        // launch time again before each event to guard process-ID reuse.
        var pid = target.pid
        return NSAppleEventDescriptor(descriptorType: typeKernelProcessID, bytes: &pid, length: MemoryLayout<pid_t>.size)!
    }
    static func eventCode(_ operation: NativeQuickSpotifyOperation) -> (OSType, OSType) {
        switch operation {
        case .read, .authorize: return (code("core"), code("getd"))
        case .seek, .setRepeat, .setShuffle: return (code("core"), code("setd"))
        case .play: return (code("spfy"), code("Play"))
        case .pause: return (code("spfy"), code("Paus"))
        case .previous: return (code("spfy"), code("Prev"))
        case .next: return (code("spfy"), code("Next"))
        }
    }
    func permission(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, ask: Bool) -> OSStatus {
        guard isSameTarget(target) else { return OSStatus(procNotFound) }
        let targetDescriptor = address(target), codes = Self.eventCode(operation)
        return AEDeterminePermissionToAutomateTarget(targetDescriptor.aeDesc, codes.0, codes.1, ask)
    }
    static func property(_ name: String, container: NSAppleEventDescriptor = .null()) throws -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(typeCode: typeProperty), forKeyword: AEKeyword(keyAEDesiredClass))
        record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
        record.setDescriptor(.init(enumCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
        record.setDescriptor(.init(typeCode: code(name)), forKeyword: AEKeyword(keyAEKeyData))
        guard let specifier = record.coerce(toDescriptorType: typeObjectSpecifier) else { throw NativeQuickSpotifyFailure.status(OSStatus(errAECoercionFail)) }
        return specifier
    }
    static var sendOptions: NSAppleEventDescriptor.SendOptions {
        // Permission can be revoked after the preflight. The send itself must
        // also forbid a surprise consent dialog, even for explicit controls.
        .init(rawValue: UInt(kAEWaitReply | kAENeverInteract | kAEDontReconnect | kAEDoNotPromptForUserConsent))
    }
    func send(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation,
              property name: String?, timeout: TimeInterval) throws -> NSAppleEventDescriptor {
        guard isSameTarget(target) else { throw NativeQuickSpotifyFailure.status(OSStatus(procNotFound)) }
        let codes = Self.eventCode(operation)
        let event = NSAppleEventDescriptor(eventClass: codes.0, eventID: codes.1, targetDescriptor: address(target),
                                           returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        let write: (String, NSAppleEventDescriptor)?
        switch operation {
        case .seek(let seek): write = ("pPos", .init(double: seek.position))
        case .setRepeat(let value): write = ("pRep", .init(boolean: value))
        case .setShuffle(let value): write = ("pShu", .init(boolean: value))
        default: write = nil
        }
        if let write {
            event.setParam(try Self.property(write.0), forKeyword: keyDirectObject)
            event.setParam(write.1, forKeyword: keyAEData)
        } else if let name {
            let appProperty = ["pPlS", "pPos", "pRep", "pShu"].contains(name)
            let container = appProperty ? NSAppleEventDescriptor.null() : try Self.property("pTrk")
            event.setParam(try Self.property(name, container: container), forKeyword: keyDirectObject)
        }
        let reply = try event.sendEvent(options: Self.sendOptions, timeout: max(0.05, timeout))
        if let error = reply.paramDescriptor(forKeyword: keyErrorNumber), error.int32Value != 0 {
            throw NativeQuickSpotifyFailure.status(error.int32Value)
        }
        return reply.paramDescriptor(forKeyword: keyDirectObject) ?? .null()
    }
}

/// One actual worker at a time. Cancellation/outer deadline completes the UI
/// once and prevents later sends; an OS-owned consent dialog cannot be forcibly
/// cancelled by public API. While it is outstanding, no second worker is queued.
final class NativeQuickSpotifyRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: ((NativeQuickSpotifyReply) -> Void)?
    private var expired = false
    init(_ callback: @escaping (NativeQuickSpotifyReply) -> Void) { self.callback = callback }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return expired }
    func cancel() { finish(.cancelled, invalidate: true) }
    func finish(_ result: NativeQuickSpotifyReply, invalidate: Bool = false) {
        lock.lock(); let completion = callback; callback = nil; expired = expired || invalidate; lock.unlock()
        completion?(result)
    }
}

final class NativeQuickSpotifyClient: @unchecked Sendable {
    private let transport: NativeQuickSpotifyTransport
    private let worker = DispatchQueue(label: "app.aibro.spotify-events", qos: .userInitiated)
    private let lock = NSLock()
    private var working = false
    private let usageDescription: () -> Bool
    private let operationTimeout: TimeInterval
    private let authorizationTimeout: TimeInterval
    init(transport: NativeQuickSpotifyTransport = NativeQuickSpotifyAppleEvents(),
         operationTimeout: TimeInterval = 3, authorizationTimeout: TimeInterval = 30,
         usageDescription: @escaping () -> Bool = { Bundle.main.object(forInfoDictionaryKey: "NSAppleEventsUsageDescription") != nil }) {
        self.transport = transport; self.operationTimeout = operationTimeout
        self.authorizationTimeout = authorizationTimeout; self.usageDescription = usageDescription
    }
    @discardableResult func request(_ operation: NativeQuickSpotifyOperation,
                                    expectedTarget: NativeQuickSpotifyTarget? = nil,
                                    completion: @escaping (NativeQuickSpotifyReply) -> Void) -> NativeQuickSpotifyRequest {
        let request = NativeQuickSpotifyRequest(completion)
        lock.lock(); let occupied = working; if !occupied { working = true }; lock.unlock()
        guard !occupied else { request.finish(.busy); return request }
        let limit = operation == .authorize ? authorizationTimeout : operationTimeout
        let deadline = ProcessInfo.processInfo.systemUptime + limit
        let timeout = DispatchWorkItem { request.finish(.snapshot(.init(state: .timedOut)), invalidate: true) }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + limit, execute: timeout)
        worker.async { [self] in
            let result: NativeQuickSpotifyReply
            do { result = .snapshot(try execute(operation, request: request, deadline: deadline, expectedTarget: expectedTarget)) }
            catch NativeQuickSpotifyFailure.cancelled { result = .cancelled }
            catch NativeQuickSpotifyFailure.timeout { result = .snapshot(.init(state: .timedOut)) }
            catch NativeQuickSpotifyFailure.rejected(let reason) { result = .rejected(reason) }
            catch NativeQuickSpotifyFailure.status(let status) { result = .snapshot(.init(state: Self.state(for: status))) }
            catch { result = .snapshot(.init(state: Self.state(for: OSStatus((error as NSError).code)))) }
            timeout.cancel(); lock.lock(); working = false; lock.unlock()
            request.finish(result)
        }
        return request
    }
    static func state(for status: OSStatus) -> NativeQuickSpotifyState {
        switch status {
        case OSStatus(procNotFound): return .notRunning
        case OSStatus(errAEEventWouldRequireUserConsent): return .authorizationRequired
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAETimeout): return .timedOut
        default: return .unavailable
        }
    }
    private func execute(_ operation: NativeQuickSpotifyOperation, request: NativeQuickSpotifyRequest,
                         deadline: TimeInterval, expectedTarget: NativeQuickSpotifyTarget?) throws -> NativeQuickSpotifySnapshot {
        func remaining() throws -> TimeInterval {
            guard !request.isCancelled else { throw NativeQuickSpotifyFailure.cancelled }
            let value = deadline - ProcessInfo.processInfo.systemUptime
            guard value > 0 else { throw NativeQuickSpotifyFailure.timeout }
            return min(1, value)
        }
        _ = try remaining()
        guard let target = transport.runningTarget() else { return .init(state: .notRunning) }
        if let expectedTarget, target != expectedTarget { throw NativeQuickSpotifyFailure.rejected(.processChanged) }
        if operation == .authorize, !usageDescription() { return .init(state: .unavailable) }
        let permission = transport.permission(target, operation: operation, ask: operation == .authorize)
        guard permission == noErr else { throw NativeQuickSpotifyFailure.status(permission) }
        _ = try remaining()
        guard transport.isSameTarget(target) else { return .init(state: .notRunning) }
        if case .seek(let seek) = operation {
            let age = ProcessInfo.processInfo.systemUptime - seek.observedAt
            guard age >= 0, age <= 120 else { throw NativeQuickSpotifyFailure.rejected(.expired) }
            guard seek.position.isFinite, seek.duration.isFinite, seek.duration > 0,
                  seek.position >= 0, seek.position < seek.duration else { throw NativeQuickSpotifyFailure.rejected(.invalidPosition) }
            guard seek.target == target, !seek.trackID.isEmpty else { throw NativeQuickSpotifyFailure.rejected(.trackChanged) }
            let currentID = try transport.send(target, operation: .read, property: "ID  ", timeout: remaining()).stringValue
            guard currentID == seek.trackID else { throw NativeQuickSpotifyFailure.rejected(.trackChanged) }
        }
        if ![.read, .authorize].contains(operation) {
            _ = try transport.send(target, operation: operation, property: nil, timeout: remaining())
        }
        // Read back actual state after controls; no optimistic success. Reads and
        // writes share one worker and one deadline, and never inspect accounts.
        let stateValue = try transport.send(target, operation: .read, property: "pPlS", timeout: remaining()).enumCodeValue
        _ = try remaining()
        guard transport.isSameTarget(target) else { return .init(state: .notRunning) }
        let state: NativeQuickSpotifyState
        switch stateValue {
        case NativeQuickSpotifyAppleEvents.code("kPSP"): state = .playing
        case NativeQuickSpotifyAppleEvents.code("kPSp"): state = .paused
        case NativeQuickSpotifyAppleEvents.code("kPSS"): return .init(state: .stopped)
        default: return .init(state: .unavailable)
        }
        let trackID = try transport.send(target, operation: .read, property: "ID  ", timeout: remaining()).stringValue ?? ""
        if case .seek(let seek) = operation, trackID != seek.trackID {
            throw NativeQuickSpotifyFailure.rejected(.trackChanged)
        }
        let title = try transport.send(target, operation: .read, property: "pnam", timeout: remaining()).stringValue ?? ""
        let artist = try transport.send(target, operation: .read, property: "pArt", timeout: remaining()).stringValue ?? ""
        func optional(_ name: String) throws -> NSAppleEventDescriptor? {
            do { return try transport.send(target, operation: .read, property: name, timeout: remaining()) }
            catch NativeQuickSpotifyFailure.status(let status) where [OSStatus(errAENoSuchObject), OSStatus(errAEEventNotHandled)].contains(status) { return nil }
        }
        func number(_ value: NSAppleEventDescriptor?) -> Double? {
            guard let value, let real = value.coerce(toDescriptorType: typeIEEE64BitFloatingPoint) else { return nil }
            let result = real.doubleValue
            return result.isFinite && result >= 0 ? result : nil
        }
        func boolean(_ value: NSAppleEventDescriptor?) -> Bool? {
            guard let value, let bool = value.coerce(toDescriptorType: typeBoolean) else { return nil }
            return bool.booleanValue
        }
        let rawDuration = number(try optional("pDur"))
        // Spotify's installed dictionary says seconds, while deployed clients
        // historically return milliseconds. This explicit conversion is gated
        // by a Demo UI comparison; never guess a unit from track length.
        let duration = rawDuration.flatMap { $0 > 0 ? $0 / 1000 : nil }
        let position = number(try optional("pPos"))
        let observedAt = ProcessInfo.processInfo.systemUptime
        let repeating = boolean(try optional("pRep"))
        let shuffling = boolean(try optional("pShu"))
        let endID = try transport.send(target, operation: .read, property: "ID  ", timeout: remaining()).stringValue ?? ""
        _ = try remaining()
        guard transport.isSameTarget(target) else { return .init(state: .notRunning) }
        guard trackID == endID else { throw NativeQuickSpotifyFailure.rejected(.trackChanged) }
        return .init(state: state, title: Self.display(title), artist: Self.display(artist), trackID: trackID,
                     target: target, observedAt: observedAt, position: position, duration: duration,
                     rawDuration: rawDuration, repeating: repeating, shuffling: shuffling)
    }
    private static func display(_ value: String) -> String {
        String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) }
            .map(String.init).joined().prefix(300))
    }
}

@MainActor final class NativeQuickNowPlayingStore: ObservableObject {
    @Published private(set) var snapshot = NativeQuickSpotifySnapshot(state: .checking)
    @Published private(set) var busy = false
    @Published private(set) var seeking = false
    @Published private(set) var seekPosition: TimeInterval = 0
    @Published private(set) var controlError: String?
    private var seekOrigin: NativeQuickSpotifySnapshot?
    private var deferredSeek: NativeQuickSpotifySeek?
    private let client: NativeQuickSpotifyClient
    private let launcher: NativeQuickSpotifyLauncher
    private let schedulesPolling: Bool
    private var visible = false
    private var generation = 0
    private var request: NativeQuickSpotifyRequest?
    private var launchRequest: NativeQuickSpotifyLaunchRequest?
    private var poll: Task<Void, Never>?
    init(client: NativeQuickSpotifyClient = NativeQuickSpotifyClient(), schedulesPolling: Bool = true,
         launcher: NativeQuickSpotifyLauncher = NativeQuickSpotifyLauncher()) {
        self.client = client; self.schedulesPolling = schedulesPolling; self.launcher = launcher
    }
    deinit { request?.cancel(); launchRequest?.cancel(); poll?.cancel() }
    func setVisible(_ value: Bool) {
        guard visible != value else { return }
        visible = value; generation += 1; poll?.cancel(); poll = nil
        request?.cancel(); request = nil; launchRequest?.cancel(); launchRequest = nil; busy = false
        seeking = false; seekOrigin = nil; deferredSeek = nil; controlError = nil
        if value {
            snapshot = .init(state: .checking)
            refresh()
        }
    }
    func refresh() { guard !seeking, !busy else { return }; controlError = nil; perform(.read) }
    var primaryActionTitle: String {
        if snapshot.canControl { return snapshot.state == .playing ? nativeUI("暂停 Spotify", "Pause Spotify") : nativeUI("播放 Spotify", "Play Spotify") }
        switch snapshot.state {
        case .notRunning: return nativeUI("启动 Spotify", "Start Spotify")
        case .authorizationRequired: return nativeUI("连接 Spotify", "Connect Spotify")
        case .launching: return nativeUI("正在启动 Spotify", "Starting Spotify")
        case .notInstalled: return nativeUI("重新检查安装", "Check installation again")
        default: return nativeUI("重新检查 Spotify", "Check Spotify again")
        }
    }
    var primaryActionSymbol: String {
        if snapshot.canControl { return snapshot.state == .playing ? "pause.fill" : "play.fill" }
        switch snapshot.state {
        case .notRunning: return "power"
        case .authorizationRequired: return "link"
        case .launching: return "hourglass"
        default: return "arrow.clockwise"
        }
    }
    func performPrimaryAction() {
        if snapshot.canControl { playPause() }
        else if snapshot.state == .notRunning { launch() }
        else if snapshot.state == .authorizationRequired { authorize() }
        else { refresh() }
    }
    func launch() {
        guard visible, !busy, !seeking, snapshot.state == .notRunning else { return }
        poll?.cancel(); poll = nil; controlError = nil; busy = true; generation += 1
        snapshot = .init(state: .launching)
        let token = generation
        launchRequest = launcher.launch { [weak self] reply in
            DispatchQueue.main.async {
                guard let self, self.visible, self.generation == token else { return }
                self.busy = false; self.launchRequest = nil
                switch reply {
                case .opened(let target):
                    self.snapshot = .init(state: .checking)
                    self.perform(.read, expectedTarget: target)
                case .notInstalled: self.snapshot = .init(state: .notInstalled)
                case .failed: self.snapshot = .init(state: .launchFailed)
                case .timedOut: self.snapshot = .init(state: .launchTimedOut)
                case .busy:
                    self.snapshot = .init(state: .launchTimedOut)
                    self.controlError = nativeUI("上一项启动请求仍在等待系统响应，请稍后重新检查。", "The system is still handling the previous launch. Check again shortly.")
                case .cancelled: break
                }
                // No timer reopens Spotify or retries a failed launch. A read
                // after a verified callback owns the normal polling lifecycle.
            }
        }
    }
    func setRepeating(_ value: Bool) { guard snapshot.canControl, snapshot.repeating != nil else { return }; perform(.setRepeat(value)) }
    func setShuffling(_ value: Bool) { guard snapshot.canControl, snapshot.shuffling != nil else { return }; perform(.setShuffle(value)) }
    func beginSeek() {
        guard visible, snapshot.canSeek, !seeking else { return }
        // Do not cancel an in-flight worker and immediately start another: a
        // pending read is allowed to finish, but cannot move the dragged thumb.
        seeking = true; seekOrigin = snapshot; controlError = nil
        seekPosition = snapshot.displayedPosition(at: ProcessInfo.processInfo.systemUptime)
        poll?.cancel(); poll = nil
    }
    func updateSeek(_ value: TimeInterval) {
        if !seeking { beginSeek() }
        guard seeking, value.isFinite else { return }
        seekPosition = min(max(0, value), seekOrigin?.duration ?? 0)
    }
    func endSeek() {
        guard seeking, let origin = seekOrigin, let target = origin.target, let duration = origin.duration else { return }
        seeking = false; seekOrigin = nil
        // Seek-to-duration advances the track in Spotify. Keep a drag to the
        // right edge inside this song instead of issuing an implicit Next.
        let value = min(seekPosition, max(0, duration - 0.25))
        let seek = NativeQuickSpotifySeek(trackID: origin.trackID, target: target,
            observedAt: origin.observedAt, position: value, duration: duration)
        if busy { deferredSeek = seek } else { perform(.seek(seek)) }
    }
    func cancelSeek() {
        seeking = false; seekOrigin = nil; deferredSeek = nil; schedule()
    }
    func authorize() { perform(.authorize) }
    func playPause() { guard snapshot.canControl else { return }; perform(snapshot.state == .playing ? .pause : .play) }
    func previous() { guard snapshot.canControl else { return }; perform(.previous) }
    func next() { guard snapshot.canControl else { return }; perform(.next) }
    private func perform(_ operation: NativeQuickSpotifyOperation, expectedTarget: NativeQuickSpotifyTarget? = nil) {
        guard visible, !busy, !seeking else { return }
        poll?.cancel(); poll = nil; busy = true; generation += 1
        if operation != .read { controlError = nil }
        let token = generation
        request = client.request(operation, expectedTarget: expectedTarget) { [weak self] reply in
            DispatchQueue.main.async {
                guard let self, self.visible, self.generation == token else { return }
                self.busy = false; self.request = nil
                var scheduleNextRead = true
                switch reply {
                case .snapshot(let snapshot):
                    self.snapshot = snapshot
                    if snapshot.state == .notRunning, self.launcher.installedApplication() == nil {
                        self.snapshot = .init(state: .notInstalled)
                    }
                    if snapshot.canControl { self.controlError = nil }
                    NativeQuickSpotifyDurationDiagnostic.record(snapshot)
                case .rejected(let reason):
                    switch reason {
                    case .trackChanged: self.controlError = nativeUI("歌曲已切换，请稍后重试。", "The track changed. Try again shortly.")
                    case .processChanged: self.controlError = nativeUI("Spotify 已重新启动，请重新检查后连接。", "Spotify restarted. Check again before connecting.")
                    case .expired: self.controlError = nativeUI("播放信息已过期，请刷新后重试。", "Playback information expired. Refresh and try again.")
                    case .invalidPosition: self.controlError = nativeUI("无法跳转到这个播放位置。", "This playback position is unavailable.")
                    }
                    if expectedTarget != nil { self.snapshot = .init(state: .unavailable); scheduleNextRead = false }
                case .busy:
                    if operation != .read || expectedTarget != nil { self.controlError = nativeUI("上一项操作仍在等待 Spotify，请稍后重试。", "Spotify is still finishing the previous request. Try again shortly.") }
                    if expectedTarget != nil { self.snapshot = .init(state: .unavailable); scheduleNextRead = false }
                case .cancelled: break
                }
                if let seek = self.deferredSeek {
                    self.deferredSeek = nil
                    // A worker may still be returning after the UI deadline.
                    // No automatic control retry; the client enforces one worker.
                    self.perform(.seek(seek))
                } else if scheduleNextRead { self.schedule() }
            }
        }
    }
    private func schedule() {
        guard visible, schedulesPolling, !seeking else { return }
        poll?.cancel()
        poll = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard let self, !Task.isCancelled, self.visible else { return }
            self.refresh()
        }
    }
}

/// Runtime unit confirmation for the isolated Demo only. No titles, IDs,
/// account information or diagnostics from the production application.
private enum NativeQuickSpotifyDurationDiagnostic {
    static func record(_ snapshot: NativeQuickSpotifySnapshot) {
        guard Bundle.main.object(forInfoDictionaryKey: "AIBroProduction") as? Bool == false,
              Bundle.main.bundleIdentifier == "dev.aibro.marketing.20261001",
              let raw = snapshot.rawDuration, let position = snapshot.position else { return }
        let fields: [String: Any] = ["rawDuration": raw, "positionSeconds": position,
            "assumedDurationSeconds": snapshot.duration ?? 0, "timestamp": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-spotify-duration-\(ProcessInfo.processInfo.processIdentifier).json")
        try? data.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
