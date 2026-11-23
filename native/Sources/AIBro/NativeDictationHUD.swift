import AppKit
import SwiftUI

/// What the dictation pill shows. On a notched display the collapsed island
/// only has room for a glyph, so the listening state, the input level and the
/// words heard so far live in this separate pill just below the menu bar.
@MainActor final class NativeDictationHUDModel: ObservableObject {
    @Published var title = ""
    @Published var hint: String?
    @Published var text: String?
    @Published var level: Double = 0
    @Published var listening = false
    @Published var symbol = "mic.fill"

    /// Five bar heights (0...1) for an input level; the middle bar leads.
    static func bars(level: Double, phase: Double) -> [Double] {
        let shape = [0.55, 0.8, 1, 0.8, 0.55]
        let clamped = min(1, max(0, level))
        return shape.enumerated().map { index, weight in
            let wobble = 0.5 + 0.5 * sin(phase * 2 * .pi + Double(index) * 1.3)
            return min(1, 0.18 + clamped * weight * (0.65 + 0.35 * wobble))
        }
    }
}

/// A floating, non-activating pill: showing it never takes focus from the
/// app the text goes into. Only the stop square accepts clicks.
@MainActor final class NativeDictationHUD {
    let model = NativeDictationHUDModel()
    var onStop: (() -> Void)?
    private var panel: NSPanel?
    private(set) var visible = false
    private static let size = NSSize(width: 320, height: 56)

    func show(title: String, hint: String?, text: String?, symbol: String, listening: Bool) {
        if model.title != title { model.title = title }
        if model.hint != hint { model.hint = hint }
        if model.text != text { model.text = text }
        if model.symbol != symbol { model.symbol = symbol }
        if model.listening != listening { model.listening = listening }
        if !listening, model.level != 0 { model.level = 0 }
        guard !visible else { return }
        visible = true
        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.setFrame(Self.frame(on: Self.targetScreen()), display: false)
        panel.orderFrontRegardless()
        dictateLog("hud shown title=\(title)")
    }

    func setLevel(_ level: Double) {
        guard visible, model.listening, abs(model.level - level) > 0.01 else { return }
        model.level = level
    }

    func hide() {
        guard visible else { return }
        visible = false
        panel?.orderOut(nil)
        model.level = 0
        dictateLog("hud hidden")
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.title = "AI Bro Dictation"
        panel.contentView = NSHostingView(rootView: NativeDictationHUDView(model: model, stop: { [weak self] in self?.onStop?() }))
        return panel
    }

    private static func targetScreen() -> NSScreen? {
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    /// Centered under the notch or the menu bar of `screen`.
    static func frame(on screen: NSScreen?) -> NSRect {
        guard let screen else { return NSRect(origin: .zero, size: size) }
        let top = max(screen.safeAreaInsets.top, screen.frame.maxY - screen.visibleFrame.maxY)
        return NSRect(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - top - 8 - size.height,
                      width: size.width, height: size.height)
    }
}

struct NativeDictationHUDView: View {
    @ObservedObject var model: NativeDictationHUDModel
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if model.listening {
                TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1)
                    HStack(spacing: 3) {
                        ForEach(Array(NativeDictationHUDModel.bars(level: model.level, phase: phase).enumerated()), id: \.offset) { _, height in
                            Capsule().fill(Color.white).frame(width: 4, height: 4 + 20 * height)
                        }
                    }
                    .frame(width: 32, height: 26)
                    .animation(.easeOut(duration: 0.12), value: model.level)
                }
            } else {
                Image(systemName: model.symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).frame(width: 32, height: 26)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(model.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    if let hint = model.hint {
                        Text(hint).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
                    }
                }
                .lineLimit(1)
                if model.text != nil || model.listening {
                    Text(model.text ?? nativeUI("请开始说话…", "Start speaking…"))
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(model.text == nil ? 0.45 : 0.85))
                        .lineLimit(1).truncationMode(.head)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if model.listening {
                Button(action: stop) {
                    ZStack {
                        Circle().fill(Color.white.opacity(0.14))
                        RoundedRectangle(cornerRadius: 2.5).fill(Color.white).frame(width: 10, height: 10)
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .help(nativeUI("结束听写", "Stop dictation"))
            }
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Capsule().fill(Color.black.opacity(0.92)))
        .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
        .environment(\.colorScheme, .dark)
    }
}
