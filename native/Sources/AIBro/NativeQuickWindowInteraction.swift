import Foundation
import CoreGraphics

/// Adapted from TO-DO Panel 1deb3cac (MIT): 460ms hold, 8pt cancellation,
/// release outside the card to hide, and a 450ms post-drag click guard.
/// Coordinates are the card's untransformed local points, never the moving icon.
struct NativeQuickWindowInteraction {
    static let holdDuration: TimeInterval = 0.460
    static let movementTolerance: CGFloat = 8
    static let clickSuppression: TimeInterval = 0.450
    enum Phase: Equatable { case idle, pressing, dragging }
    private(set) var phase: Phase = .idle
    private(set) var token: UUID?
    private(set) var source: String?
    private(set) var translation = CGSize.zero
    private(set) var removeReady = false
    private(set) var suppressClickUntil: TimeInterval = 0
    private var origin = CGPoint.zero
    private var beganAt: TimeInterval = 0
    private var bounds = CGRect.zero
    private var owner: UInt64 = 0

    mutating func begin(id: String, at point: CGPoint, now: TimeInterval, frame: CGRect,
                        bounds: CGRect, owner: UInt64) -> UUID? {
        guard phase == .idle, !id.isEmpty, bounds.width > 0, bounds.height > 0,
              frame.contains(point), bounds.contains(point) else { return nil }
        let next = UUID()
        phase = .pressing; token = next; source = id; origin = point; beganAt = now
        self.bounds = bounds; self.owner = owner
        return next
    }
    mutating func activate(token: UUID, now: TimeInterval, owner: UInt64) -> Bool {
        guard phase == .pressing, self.token == token, self.owner == owner,
              now - beganAt >= Self.holdDuration else { return false }
        phase = .dragging; return true
    }
    mutating func move(to point: CGPoint, now: TimeInterval) {
        guard phase != .idle else { return }
        let delta = CGSize(width: point.x-origin.x, height: point.y-origin.y)
        if phase == .pressing {
            if hypot(delta.width, delta.height) > Self.movementTolerance { cancel(now: now) }
        } else {
            translation = delta
            removeReady = !bounds.contains(point)
        }
    }
    mutating func finish(at point: CGPoint, now: TimeInterval, owner: UInt64) -> String? {
        move(to: point, now: now)
        let result = phase == .dragging && removeReady && self.owner == owner ? source : nil
        cancel(now: now)
        return result
    }
    mutating func cancel(now: TimeInterval) {
        if phase == .dragging { suppressClickUntil = max(suppressClickUntil, now + Self.clickSuppression) }
        phase = .idle; token = nil; source = nil; translation = .zero; removeReady = false
    }
    func mayActivate(now: TimeInterval) -> Bool { phase != .dragging && now >= suppressClickUntil }
}

enum NativeQuickWindowProximity {
    struct Transform: Equatable { var scale: CGFloat; var lift: CGFloat }
    static func transform(point: CGPoint?, frame: CGRect, reducedMotion: Bool) -> Transform {
        guard !reducedMotion, let point, frame.width > 0, frame.height > 0 else { return .init(scale: 1, lift: 0) }
        let distance = hypot(point.x-frame.midX, point.y-frame.midY)
        let radius = max(72, min(150, frame.width * 2.2))
        let strength = pow(max(0, 1-distance/radius), 2)
        return .init(scale: 1+0.12*strength, lift: -5*strength)
    }
}
