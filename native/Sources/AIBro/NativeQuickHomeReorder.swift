import Foundation
import CoreGraphics

/// The TO-DO Panel 1deb3cac home gesture, adapted to native window coordinates.
/// It never changes preferences while the pointer is down. Every timer carries
/// the press identity, so a cancelled press cannot activate a subsequent one.
struct NativeQuickHomeReorder {
    static let holdDuration: TimeInterval = 0.420
    static let movementTolerance: CGFloat = 8
    enum Phase: Equatable { case idle, pressing, dragging }
    struct Commit: Equatable {
        let source: String
        let target: String
    }
    private(set) var phase: Phase = .idle
    private(set) var token: UUID?
    private(set) var source: String?
    private(set) var target: String?
    private(set) var translation = CGSize.zero
    private var origin = CGPoint.zero
    private var beganAt: TimeInterval = 0
    private var order: [String] = []
    private var frames: [String: CGRect] = [:]
    private var viewport = CGRect.zero

    mutating func begin(source: String, point: CGPoint, now: TimeInterval,
                        order: [String], frames: [String: CGRect], viewport: CGRect) -> UUID? {
        guard phase == .idle, order.count > 1, Set(order).count == order.count,
              order.contains(source), let frame = frames[source], frame.contains(point),
              viewport.contains(point) else { return nil }
        let token = UUID()
        self.token = token; self.source = source; self.origin = point; self.beganAt = now
        self.order = order; self.frames = frames; self.viewport = viewport; phase = .pressing
        return token
    }
    @discardableResult mutating func activate(token: UUID, now: TimeInterval) -> Bool {
        guard self.token == token, phase == .pressing,
              now - beganAt >= Self.holdDuration else { return false }
        phase = .dragging; return true
    }
    mutating func move(to point: CGPoint) {
        guard phase != .idle else { return }
        let offset = CGSize(width: point.x - origin.x, height: point.y - origin.y)
        if phase == .pressing {
            if hypot(offset.width, offset.height) > Self.movementTolerance || !viewport.contains(point) { cancel() }
            return
        }
        translation = offset
        target = viewport.contains(point)
            ? order.first(where: { $0 != source && frames[$0]?.contains(point) == true }) : nil
    }
    mutating func finish() -> Commit? {
        let result: Commit?
        if phase == .dragging, let source, let target { result = Commit(source: source, target: target) }
        else { result = nil }
        cancel(); return result
    }
    mutating func cancel() { self = Self() }
}

/// Only known inert regions take part: title/grip area and the outer 6pt edge.
/// Body text, media controls, menus and the expand button are never covered by
/// the native input surface. Larger widget internals retain their own gestures.
enum NativeQuickHomeReorderHitRegion {
    static func headerRect(in size: CGSize, headerTop: CGFloat, headerTrailingInset: CGFloat = 64) -> CGRect {
        CGRect(x: 12, y: headerTop, width: max(0, size.width - 12 - max(0, headerTrailingInset)), height: 19)
    }
    static func contains(_ point: CGPoint, in size: CGSize, headerTop: CGFloat, headerTrailingInset: CGFloat = 64) -> Bool {
        guard size.width > 76, size.height > 20,
              CGRect(origin: .zero, size: size).contains(point) else { return false }
        let header = headerRect(in: size, headerTop: headerTop, headerTrailingInset: headerTrailingInset)
        return header.contains(point) || point.x < 6 || point.x >= size.width - 6 || point.y >= size.height - 6
    }
}
