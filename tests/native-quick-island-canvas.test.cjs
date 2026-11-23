const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Opening resizes the window before SwiftUI draws again. Whatever SwiftUI last
// laid out must already sit at the right place on screen in the resized window:
// the shell's horizontal centre in screen coordinates stays on the midline.
test('native island shell stays on the screen midline across window resizes', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-island-canvas-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickPresentation.swift'), 'utf8');
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, source + `
func check(_ value: @autoclosure () -> Bool, _ message: String) { if !value() { print(message); exit(1) } }
// SwiftUI's part: the shell aligned inside a canvas of the size it was laid out at.
func shellInCanvas(_ shell: CGSize, canvas: CGSize, placement: NativeQuickGeometry.Placement) -> CGRect {
    let x = placement == .edge ? canvas.width - shell.width : (canvas.width - shell.width) / 2
    let y = placement == .edge ? (canvas.height - shell.height) / 2 : canvas.height - shell.height
    return CGRect(x: x, y: y, width: shell.width, height: shell.height)
}
// The shell on screen: laid out for one window, displayed in another.
func shellOnScreen(_ shell: CGSize, laidOutIn layoutWindow: CGRect, shownIn window: CGRect, _ g: NativeQuickGeometry) -> CGRect {
    let layoutCanvas = NativeQuickGeometry.canvasFrame(window: layoutWindow.size, canvas: g.canvasSize, placement: g.placement)
    let canvas = NativeQuickGeometry.canvasFrame(window: window.size, canvas: g.canvasSize, placement: g.placement)
    let local = shellInCanvas(shell, canvas: layoutCanvas.size, placement: g.placement)
    return local.offsetBy(dx: window.minX + canvas.minX, dy: window.minY + canvas.minY)
}
let notch = CGRect(x: 0, y: 0, width: 1512, height: 982)
let screens: [(CGRect, CGFloat, CGRect?, CGRect?)] = [
    (notch, 38, CGRect(x: 0, y: 944, width: 664, height: 38), CGRect(x: 848, y: 944, width: 664, height: 38)),
    (CGRect(x: -1920, y: 120, width: 1920, height: 1080), 0, nil, nil),
    (CGRect(x: 1512, y: -300, width: 2560, height: 1440), 0, nil, nil)]
for (frame, safeTop, left, right) in screens {
    let visible = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height - max(safeTop, 24))
    let base = NativeQuickGeometry.resolve(screen: frame, visible: visible, safeTop: safeTop, leftArea: left, rightArea: right, placement: .island)
    for width in [base.collapsed.width, 280, 99999] {
        let g = base.withCollapsed(base.collapsedFrame(contentWidth: width))
        let windows = [g.collapsed, g.expanded, base.collapsed]
        for layoutWindow in windows {
            let a = NativeQuickGeometry.canvasFrame(window: layoutWindow.size, canvas: g.canvasSize, placement: .island)
            let b = NativeQuickGeometry.canvasFrame(window: g.expanded.size, canvas: g.canvasSize, placement: .island)
            check(a.size == b.size, "canvas size depends on the window: \\(a.size) vs \\(b.size)")
            for window in windows {
                // Every animated shell width, including the stale collapsed
                // shell in the just-enlarged window (the ⌥⇧V opening frame).
                for t in stride(from: 0.0, through: 1.0, by: 0.125) {
                    let shell = CGSize(width: g.collapsed.width + (g.expanded.width - g.collapsed.width) * t,
                                       height: g.collapsed.height + (g.expanded.height - g.collapsed.height) * t)
                    let rect = shellOnScreen(shell, laidOutIn: layoutWindow, shownIn: window, g)
                    check(abs(rect.midX - frame.midX) < 0.001,
                          "shell centre \\(rect.midX) != screen midline \\(frame.midX) (laid out in \\(layoutWindow.width), shown in \\(window.width), t=\\(t))")
                    check(abs(rect.maxY - frame.maxY) < 0.001, "shell left the top edge: \\(rect.maxY)")
                }
            }
        }
    }
    // The edge tab and menu entry also keep a resize from moving the shell.
    for placement in [NativeQuickGeometry.Placement.edge, .menu] {
        let g = NativeQuickGeometry.resolve(screen: frame, visible: visible, safeTop: safeTop, placement: placement,
            menuAnchor: CGRect(x: frame.midX, y: frame.maxY - 24, width: 30, height: 24))
        for shell in [g.collapsed.size, g.expanded.size] {
            let settled = shellOnScreen(shell, laidOutIn: g.collapsed, shownIn: g.collapsed, g)
            let resized = shellOnScreen(shell, laidOutIn: g.collapsed, shownIn: g.expanded, g)
            let settledExpanded = shellOnScreen(shell, laidOutIn: g.expanded, shownIn: g.expanded, g)
            check(abs(settled.midX - resized.midX) < 0.001 || placement == .edge, "\\(placement) resize moved the shell centre")
            check(abs(resized.minX - settledExpanded.minX) < 0.001 && abs(resized.minY - settledExpanded.minY) < 0.001,
                  "\\(placement) stale layout differs from settled layout")
        }
    }
}
print("ok")
`);
    const compile = spawnSync('swiftc', ['-o', binary, program], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
