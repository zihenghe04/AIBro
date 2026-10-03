import Foundation
import CoreGraphics

/// Latest intent owns the transition. A previous animation can never hide a
/// newly reopened panel or restore focus after another window has taken it.
struct NativeQuickPresentation: Equatable {
    enum Phase: Equatable { case collapsed, opening, expanded, closing }
    static let openingDuration = 0.34
    static let contentDelay = 0.11
    static let contentExitDuration = 0.08
    static let closingDuration = 0.28
    static let completionWatchdog = 0.9
    private(set) var phase: Phase = .collapsed
    private(set) var wantsExpanded = false
    private(set) var shellExpanded = false
    private(set) var visualContentVisible = false
    private var hasPresentedContent = false
    /// Activity and input stop as soon as close is requested, while the
    /// rendered content can finish its opacity animation inside the canvas.
    var contentVisible: Bool { wantsExpanded && visualContentVisible }
    /// A voice shortcut may temporarily summon the ordinary workbench at the
    /// physical top edge. This is an open-session choice, never a preference.
    private(set) var temporaryTopEntry = false
    mutating func setTemporaryTopEntry(_ value: Bool) { temporaryTopEntry = value }
    private(set) var generation: UInt64 = 0
    private var settledGeneration: UInt64?

    mutating func request(expanded: Bool, reducedMotion: Bool) -> UInt64? {
        guard wantsExpanded != expanded else { return nil }
        let reversingVisibleClose = expanded && phase == .closing && hasPresentedContent
        generation &+= 1
        wantsExpanded = expanded
        phase = reducedMotion ? (expanded ? .expanded : .collapsed) : (expanded ? .opening : .closing)
        visualContentVisible = reducedMotion ? expanded : reversingVisibleClose
        if reducedMotion { shellExpanded = expanded; hasPresentedContent = expanded }
        return generation
    }
    /// Only a committed canvas (open) or finished content exit (close) may
    /// start the shape animation. Intent alone never resizes its mask.
    mutating func animateShell(_ token: UInt64) -> Bool {
        guard token == generation, phase == .opening || phase == .closing else { return false }
        shellExpanded = wantsExpanded
        return true
    }
    mutating func revealContent(_ token: UInt64) -> Bool {
        guard token == generation, wantsExpanded, phase == .opening else { return false }
        visualContentVisible = true
        hasPresentedContent = true
        return true
    }
    mutating func settle(_ token: UInt64) -> Bool {
        guard token == generation, settledGeneration != token else { return false }
        settledGeneration = token
        phase = wantsExpanded ? .expanded : .collapsed
        shellExpanded = wantsExpanded
        visualContentVisible = wantsExpanded
        hasPresentedContent = wantsExpanded
        return true
    }
    mutating func settleImmediately() {
        generation &+= 1
        settledGeneration = generation
        phase = wantsExpanded ? .expanded : .collapsed
        shellExpanded = wantsExpanded
        visualContentVisible = wantsExpanded
        hasPresentedContent = wantsExpanded
    }
    mutating func reset() {
        generation &+= 1
        settledGeneration = generation
        wantsExpanded = false; shellExpanded = false; visualContentVisible = false
        hasPresentedContent = false; phase = .collapsed; temporaryTopEntry = false
    }
}

/// Screen coordinates are AppKit coordinates. The island touches the physical
/// top edge; visibleFrame is only used to avoid the Dock in other entry modes.
struct NativeQuickGeometry: Equatable {
    enum Placement: Equatable { case island, edge, menu }
    let collapsed: CGRect
    let expanded: CGRect
    let safeTop: CGFloat
    let hardwareWidth: CGFloat
    let placement: Placement

    static func resolve(screen: CGRect, visible: CGRect, safeTop: CGFloat,
                        leftArea: CGRect? = nil, rightArea: CGRect? = nil,
                        placement: Placement, menuAnchor: CGRect? = nil) -> Self {
        let gap: CGFloat
        if safeTop > 0, let leftArea, let rightArea, rightArea.minX > leftArea.maxX {
            gap = min(screen.width, rightArea.minX - leftArea.maxX)
        } else { gap = 0 }
        // A quick entry must leave the surrounding work visible. The upstream
        // 1240 × 616 dashboard nearly fills a MacBook; keep one smaller canvas
        // across tabs, and let module content scroll instead of resizing it.
        let width = min(760, max(1, screen.width * 0.8), max(1, screen.width - 48))
        let preferredHeight = min(520, max(1, screen.height * 0.75))
        if placement == .island {
            let inset = max(safeTop, screen.maxY - visible.maxY)
            let collapsedWidth = min(width, gap > 0 ? gap + 64 : 176)
            let collapsedHeight = gap > 0 ? max(inset, 28) + 6 : max(32, inset)
            let height = min(preferredHeight, max(1, screen.height - 48))
            return .init(collapsed: CGRect(x: screen.midX - collapsedWidth / 2, y: screen.maxY - collapsedHeight, width: collapsedWidth, height: collapsedHeight),
                         expanded: CGRect(x: screen.midX - width / 2, y: screen.maxY - height, width: width, height: height),
                         safeTop: inset, hardwareWidth: gap, placement: placement)
        }
        let usable = visible.insetBy(dx: 10, dy: 10)
        let height = min(preferredHeight, usable.height), fittedWidth = min(width, usable.width)
        if placement == .edge {
            return .init(collapsed: CGRect(x: usable.maxX - 132, y: usable.midY - 18, width: 132, height: 36),
                         expanded: CGRect(x: usable.maxX - fittedWidth, y: usable.midY - height / 2, width: fittedWidth, height: height),
                         safeTop: 0, hardwareWidth: 0, placement: placement)
        }
        let midX = menuAnchor?.midX ?? usable.midX
        let top = min(menuAnchor?.minY ?? usable.maxY, usable.maxY)
        let x = min(max(midX - fittedWidth / 2, usable.minX), usable.maxX - fittedWidth)
        return .init(collapsed: CGRect(x: x + (fittedWidth - 132) / 2, y: top - 36, width: 132, height: 36),
                     expanded: CGRect(x: x, y: max(usable.minY, top - height), width: fittedWidth, height: height),
                     safeTop: 0, hardwareWidth: 0, placement: placement)
    }
}
