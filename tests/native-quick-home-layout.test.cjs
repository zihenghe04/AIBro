const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('native home matches upstream seven-widget grid and keeps narrow/custom/hidden modules reachable', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-home-layout-'));
  try {
    const geometry = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickBentoGeometry.swift'), 'utf8');
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, geometry + `
func verify(_ result: NativeQuickBentoGeometry.Result, count: Int, width: CGFloat) {
    precondition(result.frames.count == count && result.slots.count == count, "Every visible module must remain reachable")
    for (index, frame) in result.frames.enumerated() {
        precondition(frame.minX >= 0 && frame.maxX <= width + 0.01 && frame.minY >= 0 && frame.maxY <= result.height, "Widget stays in the scrollable canvas")
        for previous in result.frames.prefix(index) {
            precondition(!frame.insetBy(dx: -4.9, dy: -4.9).intersects(previous.insetBy(dx: -4.9, dy: -4.9)), "Cards retain gutters and never overlap")
        }
    }
}
let sizes = ["medium", "mini", "large", "small", "medium", "medium", "mini"]
let dimensions = sizes.map { NativeQuickBentoGeometry.Dimension(size: $0) }
let desktop = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 1208, viewportHeight: 400, minimumRowHeight: 88, automatic: false)
let expected = [NativeQuickBentoGeometry.Slot(0,0,2,2), .init(2,0,1,1), .init(4,0,2,4), .init(3,0,1,2), .init(0,2,2,2), .init(2,2,2,2), .init(2,1,1,1)]
precondition(desktop.slots == expected, "Exact TO-DO Panel 1deb3cac default placement, with x tracks divided by two")
precondition(desktop.height == 400 && desktop.frames[2].height == 400, "Default seven widgets fit the available four-row viewport")
precondition(desktop.frames[1].height < desktop.frames[3].height && desktop.frames[3].height == desktop.frames[0].height, "Mini/small/medium/large use real grid proportions")
verify(desktop, count: 7, width: 1208)
for width: CGFloat in [372, 720] {
    let result = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: width, viewportHeight: 400, minimumRowHeight: 88, automatic: false)
    verify(result, count: 7, width: width)
    precondition(result.height > 400, "Narrow screens add reachable scroll rows instead of shrinking controls")
}
for count in 1...6 {
    let result = NativeQuickBentoGeometry.resolve(dimensions: Array(dimensions.prefix(count)), width: 1208, viewportHeight: 400, minimumRowHeight: 88, automatic: true)
    verify(result, count: count, width: 1208)
    precondition(result.slots.reduce(0) { $0 + $1.columns * $1.rows } == 24 && result.height == 400, "Hidden-module templates cover the full 12 by 4 upstream canvas")
}
// Hidden widgets must fill the actual compact canvas, not only the old wide one.
for count in 1...6 {
    let selected = Array(dimensions.prefix(count))
    let narrow = NativeQuickBentoGeometry.resolve(dimensions: selected, width: 728, viewportHeight: 310, minimumRowHeight: 88, automatic: true)
    verify(narrow, count: count, width: 728)
    let rows = narrow.slots.map { $0.row + $0.rows }.max()!
    precondition(narrow.slots.reduce(0) { $0 + $1.columns * $1.rows } == 4 * rows, "Compact automatic templates have no vacant cells")
    precondition(narrow.frames.allSatisfy { $0.height >= 186 }, "Automatic layout does not squeeze interactive controls")
    if count == 1 { precondition(narrow.frames[0].width == 728 && narrow.frames[0].height == 310, "Single widget uses the available canvas") }
}
let compact = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 728, viewportHeight: 310, minimumRowHeight: 88, automatic: false, compactWindowIndex: 2)
let preserved = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 728, viewportHeight: 310, minimumRowHeight: 88, automatic: false)
precondition(compact.slots[2].widgetSize == "medium" && compact.frames[2].height == 186, "Untouched defaults show a medium window preview on a narrow canvas")
precondition(preserved.slots[2].widgetSize == "large" && preserved.frames[2].height == 382, "Customized layouts keep the stored large window size when not opted in")
precondition(dimensions[2] == .init(size: "large"), "Responsive presentation never mutates the preferred dimensions")
precondition(compact.height <= preserved.height, "Compact defaults must not increase required scrolling; other saved shapes may still require six rows")
verify(compact, count: 7, width: 728)
let wideWithOptIn = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 1208, viewportHeight: 400, minimumRowHeight: 88, automatic: false, compactWindowIndex: 2)
precondition(wideWithOptIn == desktop, "Wide screens retain original default geometry")
let custom = NativeQuickBentoGeometry.resolve(dimensions: Array(repeating: .init(size: "large"), count: 9), width: 1208, viewportHeight: 400, minimumRowHeight: 88, automatic: false)
verify(custom, count: 9, width: 1208)
precondition(custom.height > 400, "Optional AI Bro cards and custom sizes remain accessible")
let enlarged = NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 1208, viewportHeight: 400, minimumRowHeight: 120, automatic: false)
precondition(enlarged.height > desktop.height, "Larger text metrics increase the scrollable canvas")
precondition(desktop == NativeQuickBentoGeometry.resolve(dimensions: dimensions, width: 1208, viewportHeight: 400, minimumRowHeight: 88, automatic: false), "Clock ticks cannot change geometry")
print("PASS: upstream placement, real sizes, six visibility templates, responsive and accessible overflow")
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: upstream placement/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('window preview is explicit and complete listing has no fifteen-window cap', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-window-listing-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickMedia.swift'), 'utf8');
    const item = source.slice(source.indexOf('struct NativeQuickWindowItem:'), source.indexOf('@MainActor final class NativeQuickWindowsStore'));
    const listing = source.slice(source.indexOf('enum NativeQuickWindowListing {'), source.indexOf('struct NativeQuickWindowsCard:'));
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, 'import AppKit\n' + item + listing + `
let items = (0..<64).map { NativeQuickWindowItem(id: String($0), pid: 1, title: "Research draft \\($0)", appName: $0 % 2 == 0 ? "Notes" : "Editor", icon: nil) }
let all = NativeQuickWindowListing.matching(items, hidden: [])
precondition(all.count == 64 && all.last?.id == "63", "Every discovered window must be available in detail")
let filtered = NativeQuickWindowListing.matching(items, hidden: ["1"], query: "editor research")
precondition(filtered.count == 31 && !filtered.contains(where: { $0.id == "1" }), "Search spans app and title while respecting explicit hidden windows")
for size in ["mini", "small", "medium", "large"] {
    let preview = all.prefix(NativeQuickWindowListing.previewLimit(size: size))
    precondition(preview.count <= 8 && all.count == 64, "Compact previews cannot mutate or cap the full listing")
}
precondition(NativeQuickWindowListing.matching(items, hidden: Set(items.map(\\.id))).isEmpty)
precondition(NativeQuickWindowListing.matching(items, hidden: [], query: "unknown app").isEmpty)
print("PASS: complete window access, app/title search and explicit previews")
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
