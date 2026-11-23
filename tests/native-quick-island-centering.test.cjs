const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Every frame the island can take (collapsed at any peek width, expanded) must
// be centred on the screen midline, with and without a notch.
test('native island frames stay centred on the screen midline', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-island-centering-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickPresentation.swift'), 'utf8');
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, source + `
func check(_ value: @autoclosure () -> Bool, _ message: String) { precondition(value(), message) }
struct Screen { let frame: CGRect; let safeTop: CGFloat; let left: CGRect?; let right: CGRect? }
let screens = [
    Screen(frame: CGRect(x: 0, y: 0, width: 1512, height: 982), safeTop: 38,
           left: CGRect(x: 0, y: 944, width: 664, height: 38), right: CGRect(x: 848, y: 944, width: 664, height: 38)),
    Screen(frame: CGRect(x: -1920, y: 120, width: 1920, height: 1080), safeTop: 0, left: nil, right: nil),
    Screen(frame: CGRect(x: 1512, y: -300, width: 2560, height: 1440), safeTop: 0, left: nil, right: nil)]
for screen in screens {
    let visible = CGRect(x: screen.frame.minX, y: screen.frame.minY, width: screen.frame.width, height: screen.frame.height - max(screen.safeTop, 24))
    let base = NativeQuickGeometry.resolve(screen: screen.frame, visible: visible, safeTop: screen.safeTop,
        leftArea: screen.left, rightArea: screen.right, placement: .island)
    let mid = screen.frame.midX
    check(abs(base.collapsed.midX - mid) < 0.001, "base collapsed frame centred")
    check(abs(base.expanded.midX - mid) < 0.001, "expanded frame centred")
    // Peek transitions: base -> wide -> base -> over-wide (clamped) -> base.
    var geometry = base
    for contentWidth in [base.collapsed.width, 240, 300, 99999, base.collapsed.width, 0, CGFloat.nan, 321.4] {
        let next = base.withCollapsed(base.collapsedFrame(contentWidth: contentWidth))
        // The new frame is derived from the base, never from the previous (peeking) one.
        let fromPrevious = geometry.withCollapsed(geometry.collapsedFrame(contentWidth: contentWidth))
        check(abs(next.collapsed.midX - mid) < 0.001, "collapsed frame centred at width \\(contentWidth)")
        check(abs(fromPrevious.collapsed.midX - mid) < 0.001, "re-deriving from a peeked frame stays centred at \\(contentWidth)")
        check(next.collapsed.width >= base.collapsed.width && next.collapsed.width <= base.expanded.width, "width clamped")
        check(next.collapsed.maxY == base.collapsed.maxY && next.collapsed.height == base.collapsed.height, "vertical placement unchanged")
        check(abs(next.expanded.midX - mid) < 0.001, "expanded unchanged by peek")
        geometry = next
    }
}
print("ok")
`);
    const compile = spawnSync('swiftc', ['-parse-as-library', '-o', binary, program].filter((x) => x !== '-parse-as-library'), { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
