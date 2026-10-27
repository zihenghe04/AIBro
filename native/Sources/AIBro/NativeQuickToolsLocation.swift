import Foundation

/// Where QuickTools (speech/realtime schemes, vault, clipboard, shelf, mirror) keep private data.
/// A disposable data directory (AIBRO_NATIVE_DATA_DIR) takes its QuickTools with it, so a test build can never read or
/// change the real schemes. Without that variable the location is the unchanged production one.
enum NativeQuickToolsLocation {
    static func directory(environment: [String: String], home: URL, bundleID: String) -> URL {
        if let isolated = environment["AIBRO_NATIVE_DATA_DIR"], isolated.hasPrefix("/") {
            return URL(fileURLWithPath: isolated, isDirectory: true).appendingPathComponent("QuickTools", isDirectory: true)
        }
        return home.appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(bundleID, isDirectory: true).appendingPathComponent("QuickTools", isDirectory: true)
    }
}
