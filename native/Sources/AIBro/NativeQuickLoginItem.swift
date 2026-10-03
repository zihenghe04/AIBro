import AppKit
import Combine
import ServiceManagement

enum NativeQuickLoginItemStatus: Equatable {
    case notRegistered, enabled, requiresApproval, notFound, unknown
    var isRegistered: Bool { self == .enabled || self == .requiresApproval }
}

@MainActor protocol NativeQuickLoginItemService: AnyObject {
    var status: NativeQuickLoginItemStatus { get }
    func register() throws
    func unregister() async throws
    func openSettings()
}

@MainActor final class NativeQuickSystemLoginItem: NativeQuickLoginItemService {
    private let service = SMAppService.mainApp
    var status: NativeQuickLoginItemStatus {
        switch service.status {
        case .notRegistered: return .notRegistered
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .unknown
        }
    }
    func register() throws { try service.register() }
    func unregister() async throws { try await service.unregister() }
    func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// The OS is the only source of truth. Merely opening AI Bro, changing island
/// placement, or restoring local preferences never registers a login item.
@MainActor final class NativeQuickLoginItemStore: ObservableObject {
    @Published private(set) var status: NativeQuickLoginItemStatus
    @Published private(set) var changing = false
    @Published private(set) var issue: String?
    private let service: NativeQuickLoginItemService

    init(service: NativeQuickLoginItemService) {
        self.service = service
        self.status = service.status
    }
    convenience init() { self.init(service: NativeQuickSystemLoginItem()) }

    func refresh() {
        let current = service.status
        if current != status { issue = nil }
        status = current
    }
    func openSettings() { service.openSettings() }

    func setEnabled(_ enabled: Bool) async {
        guard !changing else { return }
        refresh()
        // notFound is a lookup failure, not an API prohibition on registration.
        // An explicit user request may register mainApp; only its OS result can
        // establish whether this installation is eligible. Never retry implicitly.
        guard status != .unknown else {
            issue = nativeUI("当前安装无法注册登录项，请检查 App 安装。", "This installation cannot register a login item. Check the app installation.")
            return
        }
        guard enabled != status.isRegistered else { issue = nil; return }
        changing = true
        issue = nil
        defer { refresh(); changing = false }
        do {
            if enabled { try service.register() }
            else { try await service.unregister() }
            refresh()
            if enabled != status.isRegistered {
                issue = nativeUI("系统尚未应用此更改，请在登录项设置中检查。", "macOS has not applied this change. Check Login Items in System Settings.")
            }
        } catch {
            refresh()
            // The OS may already have performed the requested operation (for
            // example after an external settings change). Do not invent failure.
            if enabled != status.isRegistered {
                issue = nativeUI("无法更改登录项：", "Unable to change the login item: ") + error.localizedDescription
            }
        }
    }
}
