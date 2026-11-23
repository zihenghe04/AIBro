import AppKit

/// Debug-only trace of the island window and its SwiftUI shell. Off unless
/// AIBRO_ISLAND_TRACE names a file. Each line: ms since process start, event,
/// window frame, hosting frame and the shell's last laid-out frame on screen.
@MainActor final class NativeIslandTrace {
    static let shared = NativeIslandTrace()
    let enabled: Bool
    private let handle: FileHandle?
    private let start = CACurrentMediaTime()
    private var sampler: Timer?
    private var samplerEnd: CFTimeInterval = 0
    private var lastTick: CFTimeInterval = 0
    /// Shell frame in window coordinates (SwiftUI .global), as last laid out.
    var shellLocal: CGRect = .zero
    weak var window: NSWindow? {
        didSet {
            guard enabled, let window, window !== oldValue else { return }
            // Every setFrame, wherever it comes from, lands in the trace.
            for (name, event) in [(NSWindow.didResizeNotification, "window.didResize"), (NSWindow.didMoveNotification, "window.didMove")] {
                NotificationCenter.default.addObserver(forName: name, object: window, queue: nil) { _ in
                    MainActor.assumeIsolated { NativeIslandTrace.shared.log(event) }
                }
            }
        }
    }
    /// The SwiftUI hosting view; logged so its offset inside the window is visible.
    weak var canvas: NSView?

    private init() {
        let path = ProcessInfo.processInfo.environment["AIBRO_ISLAND_TRACE"] ?? ""
        enabled = !path.isEmpty
        if enabled {
            FileManager.default.createFile(atPath: path, contents: nil)
            handle = FileHandle(forWritingAtPath: path)
        } else { handle = nil }
    }

    private func f(_ r: CGRect) -> String { String(format: "%.1f,%.1f %.1fx%.1f", r.minX, r.minY, r.width, r.height) }

    func log(_ event: String) {
        guard enabled, let handle else { return }
        let now = CACurrentMediaTime()
        var line = String(format: "%9.2f %@", (now - start) * 1000, event)
        if let window {
            let bounds = canvas?.frame ?? .zero
            // .global already includes the canvas offset, so only the window origin is added.
            let shellX = window.frame.minX + shellLocal.minX
            let mid = window.screen.map { $0.frame.midX } ?? 0
            line += " win=\(f(window.frame)) canvas=\(f(bounds)) shell=\(f(shellLocal))"
            line += String(format: " shellScreenX=%.1f shellMidOffset=%.1f", shellX, shellX + shellLocal.width / 2 - mid)
        }
        handle.write((line + "\n").data(using: .utf8)!)
    }

    /// Samples every ~4 ms; gaps between ticks show a blocked main thread.
    func sample(for seconds: CFTimeInterval) {
        guard enabled else { return }
        samplerEnd = CACurrentMediaTime() + seconds
        guard sampler == nil else { return }
        lastTick = CACurrentMediaTime()
        let timer = Timer(timeInterval: 0.004, repeats: true) { _ in
            MainActor.assumeIsolated {
                let trace = NativeIslandTrace.shared
                let now = CACurrentMediaTime()
                trace.log(String(format: "tick gap=%.1f", (now - trace.lastTick) * 1000))
                trace.lastTick = now
                if now > trace.samplerEnd { trace.sampler?.invalidate(); trace.sampler = nil }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        sampler = timer
    }
}
