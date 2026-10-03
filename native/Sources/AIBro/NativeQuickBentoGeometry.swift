import Foundation
import CoreGraphics

/// Adapted from TO-DO Panel's MIT-licensed renderer/domain.js home layout.
/// A native unit equals two of its twelve columns, preserving the same gutters
/// and mini 2×1 / small 2×2 / medium 4×2 / large 4×4 proportions.
enum NativeQuickBentoGeometry {
    struct Dimension: Equatable {
        var columns: Int
        var rows: Int
        init(_ columns: Int, _ rows: Int) { self.columns = columns; self.rows = rows }
        init(size: String) {
            switch size {
            case "mini": self.init(1, 1)
            case "small": self.init(1, 2)
            case "large": self.init(2, 4)
            default: self.init(2, 2)
            }
        }
    }
    struct Slot: Equatable {
        var column: Int
        var row: Int
        var columns: Int
        var rows: Int
        init(_ column: Int, _ row: Int, _ columns: Int, _ rows: Int) {
            self.column = column; self.row = row; self.columns = columns; self.rows = rows
        }
        /// A widget must describe the slot that was actually placed, including
        /// responsive packing; the six-column visibility template is not a size.
        var widgetSize: String {
            if rows > 2 { return "large" }
            return columns > 1 ? "medium" : rows > 1 ? "small" : "mini"
        }
    }
    struct Result: Equatable {
        var frames: [CGRect]
        var slots: [Slot]
        var height: CGFloat
    }
    struct Request: Equatable {
        var dimensions: [Dimension]
        var width: CGFloat
        var viewportHeight: CGFloat
        var minimumRowHeight: CGFloat
        var automatic: Bool
        var compactWindowIndex: Int?
    }
    /// View-local memoization: clock and player updates must not run the packing
    /// search again. Both SwiftUI placement and widget content consume this result.
    final class Cache {
        private var previous: Request?
        private var result: Result?
        func resolve(_ request: Request) -> Result {
            if previous == request, let result { return result }
            let next = NativeQuickBentoGeometry.resolve(dimensions: request.dimensions, width: request.width,
                viewportHeight: request.viewportHeight, minimumRowHeight: request.minimumRowHeight,
                automatic: request.automatic, compactWindowIndex: request.compactWindowIndex)
            previous = request; result = next
            return next
        }
    }
    static func resolve(dimensions: [Dimension], width: CGFloat, viewportHeight: CGFloat,
                        minimumRowHeight: CGFloat, automatic: Bool, spacing: CGFloat = 10,
                        compactWindowIndex: Int? = nil) -> Result {
        guard !dimensions.isEmpty else { return Result(frames: [], slots: [], height: 0) }
        let columns = width >= 950 ? 6 : width >= 600 ? 4 : 2
        var dimensions = dimensions
        // The caller opts in only for the unchanged default layout. This is a
        // presentation adjustment, never a write to the user's saved sizes.
        if columns < 6, let index = compactWindowIndex, dimensions.indices.contains(index),
           dimensions[index] == Dimension(size: "large") { dimensions[index] = Dimension(size: "medium") }
        let template = automatic ? automaticSlots(dimensions, columns: columns) : nil
        let slots = template ?? pack(dimensions, columns: columns)
        let rows = template == nil ? 4 : (slots.map { $0.row + $0.rows }.max() ?? 4)
        // Automatic cards fill the available canvas, not an unreachable desktop
        // template. Each card still gets at least a normal two-row content area;
        // dense/narrow layouts scroll rather than shrinking their controls.
        let minimumUnit = template == nil ? minimumRowHeight : slots.map {
            (minimumRowHeight * 2 + spacing - CGFloat($0.rows - 1) * spacing) / CGFloat($0.rows)
        }.max() ?? minimumRowHeight
        let rowHeight = max(minimumUnit, (viewportHeight - spacing * CGFloat(rows - 1)) / CGFloat(rows))
        let columnWidth = max(1, (width - CGFloat(columns - 1) * spacing) / CGFloat(columns))
        let frames = slots.map { slot in
            CGRect(x: CGFloat(slot.column) * (columnWidth + spacing), y: CGFloat(slot.row) * (rowHeight + spacing),
                   width: CGFloat(slot.columns) * columnWidth + CGFloat(slot.columns - 1) * spacing,
                   height: CGFloat(slot.rows) * rowHeight + CGFloat(slot.rows - 1) * spacing)
        }
        return Result(frames: frames, slots: slots, height: frames.map(\.maxY).max() ?? 0)
    }
    static func automaticSlots(_ dimensions: [Dimension], columns: Int = 6) -> [Slot]? {
        guard (1...6).contains(dimensions.count) else { return nil }
        if columns == 2 {
            if dimensions.count == 1 { return [Slot(0, 0, 2, 4)] }
            return dimensions.indices.map { Slot(0, $0 * 2, 2, 2) }
        }
        if columns == 4 {
            switch dimensions.count {
            case 1: return [Slot(0, 0, 4, 4)]
            case 2: return [Slot(0, 0, 2, 4), Slot(2, 0, 2, 4)]
            case 3: return [Slot(0, 0, 2, 4), Slot(2, 0, 2, 2), Slot(2, 2, 2, 2)]
            case 4: return (0..<4).map { Slot(($0 % 2) * 2, ($0 / 2) * 2, 2, 2) }
            case 5:
                let primary = dimensions.indices.max { lhs, rhs in
                    let left = dimensions[lhs].columns * dimensions[lhs].rows, right = dimensions[rhs].columns * dimensions[rhs].rows
                    return left == right ? lhs > rhs : left < right
                } ?? 0
                let rest = [Slot(2, 0, 2, 2), Slot(2, 2, 2, 2), Slot(0, 4, 2, 2), Slot(2, 4, 2, 2)]
                var index = 0
                return dimensions.indices.map { id in
                    if id == primary { return Slot(0, 0, 2, 4) }
                    defer { index += 1 }; return rest[index]
                }
            default: return (0..<6).map { Slot(($0 % 2) * 2, ($0 / 2) * 2, 2, 2) }
            }
        }
        guard columns == 6 else { return nil }
        switch dimensions.count {
        case 1: return [Slot(0, 0, 6, 4)]
        case 2: return [Slot(0, 0, 3, 4), Slot(3, 0, 3, 4)]
        case 3: return [Slot(0, 0, 2, 4), Slot(2, 0, 2, 4), Slot(4, 0, 2, 4)]
        case 4: return [Slot(0, 0, 3, 2), Slot(3, 0, 3, 2), Slot(0, 2, 3, 2), Slot(3, 2, 3, 2)]
        case 5:
            let primary = dimensions.indices.max { lhs, rhs in
                let left = dimensions[lhs].columns * dimensions[lhs].rows, right = dimensions[rhs].columns * dimensions[rhs].rows
                return left == right ? lhs > rhs : left < right
            } ?? 0
            let rest = [Slot(2, 0, 2, 2), Slot(4, 0, 2, 2), Slot(2, 2, 2, 2), Slot(4, 2, 2, 2)]
            var index = 0
            return dimensions.indices.map { id in
                if id == primary { return Slot(0, 0, 2, 4) }
                defer { index += 1 }; return rest[index]
            }
        case 6: return (0..<6).map { Slot(($0 % 3) * 2, ($0 / 3) * 2, 2, 2) }
        default: return nil
        }
    }
    static func pack(_ dimensions: [Dimension], columns: Int) -> [Slot] {
        let sizes = dimensions.map { Dimension(min(columns, max(1, $0.columns)), max(1, $0.rows)) }
        let area = sizes.reduce(0) { $0 + $1.columns * $1.rows }
        let firstRows = max(4, sizes.map(\.rows).max() ?? 1, Int(ceil(Double(area) / Double(columns))))
        // Exact upstream order/first-fit backtracking for the normal seven-card
        // canvas. A bounded search adds scrollable rows for custom extra cards
        // rather than silently shrinking or dropping a user's saved widgets.
        for rows in firstRows...max(firstRows, sizes.reduce(0) { $0 + $1.rows }) {
            var occupied = Array(repeating: false, count: columns * rows)
            var placed: [Slot] = []
            var attempts = 0
            func place(_ index: Int) -> Bool {
                if index == sizes.count { return true }
                guard attempts < 20_000 else { return false }
                let size = sizes[index]
                for row in 0...(rows - size.rows) {
                    for column in 0...(columns - size.columns) {
                        attempts += 1
                        let cells = (row..<(row + size.rows)).flatMap { y in (column..<(column + size.columns)).map { y * columns + $0 } }
                        guard cells.allSatisfy({ !occupied[$0] }) else { continue }
                        cells.forEach { occupied[$0] = true }; placed.append(Slot(column, row, size.columns, size.rows))
                        if place(index + 1) { return true }
                        placed.removeLast(); cells.forEach { occupied[$0] = false }
                    }
                }
                return false
            }
            if place(0) { return placed }
        }
        // Defensive linear fallback is reachable and never clips a module.
        var row = 0
        return sizes.map { size in defer { row += size.rows }; return Slot(0, row, size.columns, size.rows) }
    }
}
