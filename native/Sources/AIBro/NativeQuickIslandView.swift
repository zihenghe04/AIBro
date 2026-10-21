import AppKit
import SwiftUI

/// Freezes island motion at a time offset (seconds since the state appeared)
/// so offscreen renders can inspect intermediate frames. nil in the app.
private struct NativeQuickIslandMotionTimeKey: EnvironmentKey { static let defaultValue: Double? = nil }
extension EnvironmentValues {
    var islandMotionTime: Double? {
        get { self[NativeQuickIslandMotionTimeKey.self] }
        set { self[NativeQuickIslandMotionTimeKey.self] = newValue }
    }
}

/// Critically-damped-ish spring step matching .spring(response:dampingFraction:).
func nativeQuickSpringProgress(_ t: Double, response: Double = 0.35, damping: Double = 0.72) -> Double {
    guard t > 0 else { return 0 }
    let omega = 2 * Double.pi / response, decay = damping * omega
    let damped = omega * (1 - damping * damping).squareRoot()
    return 1 - exp(-decay * t) * (cos(damped * t) + decay / damped * sin(damped * t))
}

/// Collapsed island content. The black shell belongs to the entry view; this
/// view only lays out the one status the model chose for it.
struct NativeQuickIslandCollapsedLabel: View {
    let status: NativeQuickIslandStatus
    /// Hardware camera gap; zero on displays without a notch.
    let notchGap: CGFloat
    let width: CGFloat
    let reduceMotion: Bool
    /// The island is temporarily wider; an action word may replace the dot.
    var peeking = false
    /// Menu bar band height beside a notch. Shoulder content centres on it
    /// so the glyph lines up with menu bar icons, not the island's lip.
    var menuBand: CGFloat = 0

    static func color(_ tint: NativeQuickIslandStatus.Tint) -> Color {
        switch tint {
        case .neutral: return Color.white.opacity(0.86)
        case .accent: return Color(red: 0.66, green: 0.85, blue: 0.72)
        case .amber: return Color(red: 0.98, green: 0.76, blue: 0.38)
        case .red: return Color(red: 1, green: 0.47, blue: 0.43)
        }
    }
    /// The same font measures the label for the island width.
    static let titleFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
    static let detailFont = NSFont.systemFont(ofSize: 11, weight: .regular)
    static func measure(_ text: String) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: titleFont]).width)
    }

    private var tint: Color { Self.color(status.tint) }

    var body: some View {
        if notchGap > 0 {
            // The camera housing hides the middle. Keep the glyph on the left
            // and one compact value on the right, centred on each shoulder.
            let side = max(0, (width - notchGap) / 2)
            HStack(spacing: 0) {
                glyph.frame(width: side)
                Color.clear.frame(width: notchGap)
                shoulderValue.frame(width: side)
            }.frame(height: menuBand > 0 ? menuBand : nil)
                .frame(maxHeight: .infinity, alignment: menuBand > 0 ? .top : .center)
        } else {
            // Content fits the current frame: the title truncates before the
            // trailing value, and detail appears only when it has real room.
            let trailingWidth = rightValue.map(Self.measure) ?? 14
            let titleRoom = max(0, width - 24 - 14 - 7 - 7 - trailingWidth)
            let titleWidth = Self.measure(status.title)
            let detailRoom = titleRoom - titleWidth - 6
            HStack(spacing: 7) {
                glyph
                if titleWidth <= titleRoom {
                    NativeQuickIslandSwapText(text: status.title, font: .system(size: 11, weight: .semibold),
                                              color: titleColor, reduceMotion: reduceMotion)
                } else {
                    Text(status.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(titleColor)
                        .lineLimit(1).truncationMode(.tail)
                }
                if let detail = status.detail, detailRoom >= 36 {
                    Text(detail).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.58))
                        .lineLimit(1).truncationMode(.tail)
                        .modifier(NativeQuickIslandShimmer(active: status.busy && !reduceMotion))
                        .transition(.opacity)
                }
                Spacer(minLength: 0)
                trailing
            }.padding(.horizontal, 12)
        }
    }

    private var titleColor: Color { status.kind == .idle ? .white.opacity(0.92) : tint }

    private var rightValue: String? { status.trailing ?? (peeking ? status.actionWord : nil) }

    /// Shoulders beside a notch are narrow; the value scales down rather
    /// than widening the island, and digits roll instead of re-entering.
    @ViewBuilder private var shoulderValue: some View {
        if let value = peeking ? (status.actionWord ?? status.shoulder) : status.shoulder {
            Text(value).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.7)
                .contentTransition(reduceMotion ? .identity : .numericText())
                .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: value)
                .padding(.horizontal, 4)
        } else { dot }
    }

    private var glyph: some View {
        Image(systemName: status.symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(status.kind == .idle ? Color.white.opacity(0.86) : tint)
            // Monochrome keeps filled glyphs (triangle, check) at full tint;
            // hierarchical dims their fill to an unreadable layer on black.
            .symbolRenderingMode(.monochrome)
            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
            .symbolEffect(.pulse, options: .repeating, isActive: status.busy && !reduceMotion)
            .frame(width: 14, height: 14)
    }

    @ViewBuilder private var trailing: some View {
        if let value = rightValue {
            Text(value).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(tint)
                .lineLimit(1).fixedSize()
                .contentTransition(reduceMotion ? .identity : .numericText())
                .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: value)
        } else { dot }
    }

    @ViewBuilder private var dot: some View {
        if status.busy {
            NativeQuickIslandPulseDot(color: tint, reduceMotion: reduceMotion)
        } else {
            // Idle stays quiet; any other settled state keeps its tint.
            Circle().fill(status.kind == .idle ? Color.white.opacity(0.32) : tint).frame(width: 5, height: 5)
        }
    }
}

/// Status word swap: each character rises from a small, blurred state with a
/// short stagger; the outgoing word only fades so the change reads quickly.
struct NativeQuickIslandSwapText: View {
    let text: String
    let font: Font
    let color: Color
    let reduceMotion: Bool

    var body: some View {
        ZStack {
            NativeQuickIslandWord(text: text, font: font, color: color, reduceMotion: reduceMotion)
                .id(text)
                .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: 0.14)))
        }.fixedSize()
    }
}

private struct NativeQuickIslandWord: View {
    let text: String
    let font: Font
    let color: Color
    let reduceMotion: Bool
    @State private var entered = false
    @Environment(\.islandMotionTime) private var frozenTime

    var body: some View {
        let characters = Array(text)
        // Bound the total stagger so a long label never trails behind.
        let stagger = characters.count > 1 ? min(0.045, 0.3 / Double(characters.count - 1)) : 0
        Group {
            if reduceMotion || characters.count > 24 {
                Text(text).font(font).foregroundStyle(color).lineLimit(1)
            } else {
                HStack(spacing: 0) {
                    ForEach(Array(characters.enumerated()), id: \.offset) { index, character in
                        Text(String(character)).font(font).foregroundStyle(color)
                            .modifier(NativeQuickIslandRise(progress: frozenTime.map { nativeQuickSpringProgress($0 - Double(index) * stagger) } ?? (entered ? 1 : 0)))
                            .animation(.spring(response: 0.35, dampingFraction: 0.72).delay(Double(index) * stagger), value: entered)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .onAppear { entered = true }
    }
}

private struct NativeQuickIslandRise: ViewModifier, Animatable {
    var progress: Double
    var animatableData: Double { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        content
            .scaleEffect(0.42 + 0.58 * progress, anchor: .bottom)
            .blur(radius: 2 * (1 - min(1, max(0, progress))))
            .offset(y: 4 * (1 - progress))
            .opacity(min(1, max(0, progress * 1.4)))
    }
}

/// A light sweep across live detail text, pausing between passes.
private struct NativeQuickIslandShimmer: ViewModifier {
    let active: Bool
    @State private var phase: CGFloat = -1
    @Environment(\.islandMotionTime) private var frozenTime
    /// Sweep position for a frozen time: 0.7s rest, then a 1.9s pass.
    private var shownPhase: CGFloat {
        guard let frozenTime else { return phase }
        let cycle = frozenTime.truncatingRemainder(dividingBy: 2.6)
        return cycle < 0.7 ? -0.2 : CGFloat(-0.2 + 1.3 * (cycle - 0.7) / 1.9)
    }

    func body(content: Content) -> some View {
        content.overlay {
            if active {
                GeometryReader { proxy in
                    LinearGradient(colors: [.clear, .white.opacity(0.75), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: max(24, proxy.size.width * 0.45))
                        .offset(x: shownPhase * (proxy.size.width + max(24, proxy.size.width * 0.45)) - max(24, proxy.size.width * 0.45) / 2)
                }
                .mask(content)
                .allowsHitTesting(false)
                .onAppear {
                    phase = -0.2
                    withAnimation(.linear(duration: 1.9).delay(0.7).repeatForever(autoreverses: false)) { phase = 1.1 }
                }
                .onDisappear { phase = -1 }
            }
        }
    }
}

private struct NativeQuickIslandPulseDot: View {
    let color: Color
    let reduceMotion: Bool
    @State private var expanded = false

    var body: some View {
        ZStack {
            if !reduceMotion {
                Circle().stroke(color.opacity(expanded ? 0 : 0.5), lineWidth: 1)
                    .frame(width: 6, height: 6).scaleEffect(expanded ? 2.3 : 1)
            }
            Circle().fill(color).frame(width: 6, height: 6)
        }
        .frame(width: 14, height: 14)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { expanded = true }
        }
        .accessibilityHidden(true)
    }
}
