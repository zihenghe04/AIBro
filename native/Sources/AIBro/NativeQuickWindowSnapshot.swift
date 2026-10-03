import AppKit
import CoreGraphics

/// Only immutable pixels cross back to the UI. NSRunningApplication's SDK
/// contract permits background property reads; its NSImage never leaves here.
struct NativeQuickWindowSnapshot: Sendable {
    struct Row: Sendable {
        let id: String
        let pid: pid_t
        let title: String
        let appName: String
        let applicationIdentity: String
        let icon: CGImage?
        var bounds: CGRect? = nil
    }
    let rows: [Row]
    let canReadTitles: Bool
}

actor NativeQuickWindowScanner {
    struct Raw: Sendable {
        let number: Int
        let pid: pid_t
        let title: String
        var bounds: CGRect? = nil
    }
    struct Application: Sendable {
        let identity: String
        let name: String
        let icon: CGImage?
    }
    enum Failure: Error { case unavailable }
    typealias ReadWindows = @Sendable () throws -> [Raw]
    typealias ReadApplication = @Sendable (pid_t) -> Application?
    private let readWindows: ReadWindows
    private let readApplication: ReadApplication
    private let permission: @Sendable () -> Bool

    init(readWindows: @escaping ReadWindows = NativeQuickWindowScanner.systemWindows,
         readApplication: @escaping ReadApplication = NativeQuickWindowScanner.systemApplication,
         permission: @escaping @Sendable () -> Bool = { CGPreflightScreenCaptureAccess() }) {
        self.readWindows = readWindows; self.readApplication = readApplication; self.permission = permission
    }

    // This actor is not MainActor. No workspace/app observer or window mutation
    // happens in it. Coalesce each app's expensive icon work within a scan.
    func scan() throws -> NativeQuickWindowSnapshot {
        try Task.checkCancellation()
        let titlesAtStart = permission()
        let raw = try readWindows()
        var apps: [pid_t: Application] = [:], rejected = Set<pid_t>()
        var rows: [NativeQuickWindowSnapshot.Row] = [], seen = Set<String>()
        for window in raw {
            try Task.checkCancellation()
            if apps[window.pid] == nil, !rejected.contains(window.pid) {
                if let app = readApplication(window.pid) { apps[window.pid] = app }
                else { rejected.insert(window.pid) }
            }
            guard let app = apps[window.pid] else { continue }
            let title = titlesAtStart ? window.title.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let id = "\(window.pid):\(window.number)"
            guard seen.insert(title.isEmpty ? "app:\(window.pid)" : id).inserted else { continue }
            rows.append(.init(id: id, pid: window.pid, title: title, appName: app.name,
                              applicationIdentity: app.identity, icon: app.icon, bounds: title.isEmpty ? nil : window.bounds))
        }
        try Task.checkCancellation()
        let titlesAtEnd = permission()
        if !titlesAtEnd {
            seen.removeAll()
            rows = rows.filter { seen.insert("\($0.pid)").inserted }.map {
                .init(id: $0.id, pid: $0.pid, title: "", appName: $0.appName, applicationIdentity: $0.applicationIdentity, icon: $0.icon)
            }
        }
        return .init(rows: rows, canReadTitles: titlesAtStart && titlesAtEnd)
    }

    nonisolated static func systemWindows() throws -> [Raw] {
        guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { throw Failure.unavailable }
        return windows.compactMap { window in
            guard let pid = window[kCGWindowOwnerPID as String] as? Int32, pid != ProcessInfo.processInfo.processIdentifier,
                  (window[kCGWindowLayer as String] as? Int ?? 1) == 0,
                  let number = window[kCGWindowNumber as String] as? Int else { return nil }
            return .init(number: number, pid: pid, title: window[kCGWindowName as String] as? String ?? "", bounds: bounds(window[kCGWindowBounds as String]))
        }
    }

    nonisolated static func bounds(_ value: Any?) -> CGRect? {
        guard let value = value as? [String:Any], let rect = CGRect(dictionaryRepresentation:value as CFDictionary),
              [rect.minX,rect.minY,rect.width,rect.height].allSatisfy(\.isFinite), rect.width > 0, rect.height > 0 else { return nil }
        return rect
    }

    nonisolated static func identity(_ app: NSRunningApplication) -> String {
        "\(app.bundleURL?.path ?? "")|\(app.launchDate?.timeIntervalSince1970 ?? 0)"
    }

    nonisolated static func systemApplication(_ pid: pid_t) -> Application? {
        autoreleasepool {
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, app.activationPolicy != .prohibited else { return nil }
            let identity = identity(app), name = app.localizedName ?? "App"
            var pixels: CGImage?
            if let image = app.icon,
               let original = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
               let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                context.interpolationQuality = .high
                context.draw(original, in: CGRect(x: 0, y: 0, width: 64, height: 64))
                pixels = context.makeImage()
            }
            guard !app.isTerminated else { return nil }
            return .init(identity: identity, name: name, icon: pixels)
        }
    }
}
