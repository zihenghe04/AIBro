const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
test('note header controls pass through native reorder overlay and menu geometry uses chosen screen', {skip: process.platform !== 'darwin', timeout: 60000}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-entry-integration-'));
  try {
    const entry = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickEntry.swift'), 'utf8');
    const start = entry.indexOf('    private func resolvedGeometry(on screen: NSScreen) -> NativeQuickGeometry {');
    const end = entry.indexOf('\n    private func repositionWindows()', start);
    assert(start >= 0 && end > start);
    const method = entry.slice(start, end).replaceAll('private func', 'func').replaceAll('NSScreen', 'FixtureScreen');
    const fixture = path.join(temporary, 'GeometryHost.swift');
    // Compile the exact production method with immutable screen/window inputs.
    // This tests routing/geometry, not AppKit screen enumeration or actual displays.
    fs.writeFileSync(fixture, `import Foundation
import CoreGraphics
struct FixtureScreen { let id: UInt32?; let frame: CGRect
var visibleFrame: CGRect { frame }; var safeAreaInsets: FixtureInsets { .init(top: 0) }
var auxiliaryTopLeftArea: CGRect? { nil }; var auxiliaryTopRightArea: CGRect? { nil } }
struct FixtureInsets { let top: CGFloat }
struct FixtureWindow { let screen: FixtureScreen?; let frame: CGRect }
struct FixtureButton { let window: FixtureWindow? }
struct FixtureStatusItem { let button: FixtureButton? }
final class FixtureGeometryHost {
enum Mode { case island, edge, menuBar }; var mode: Mode = .menuBar
var statusItem: FixtureStatusItem?; var screenAnchorID: UInt32?
var presentation = NativeQuickPresentation()
var usesTopIslandPresentation: Bool { mode == .island || presentation.temporaryTopEntry }
var geometry = NativeQuickGeometry.resolve(screen: CGRect(x:0,y:0,width:1440,height:900), visible: CGRect(x:0,y:0,width:1440,height:900), safeTop:0, placement:.menu)
func screenID(_ screen: FixtureScreen) -> UInt32? { screen.id }
${method}
}
`);
    const binary = path.join(temporary, 'checks');
    const files = ['NativeQuickHomeReorder.swift', 'NativeQuickHomeReorderSurface.swift', 'NativeQuickPresentation.swift'].map(name => path.join(root, 'native/Sources/AIBro', name));
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...files, fixture, path.join(root, 'tests/native-quick-entry-integration.swift'), '-o', binary], {encoding: 'utf8', timeout: 45000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], {encoding: 'utf8', timeout: 10000});
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /22 entry integration assertions passed/);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
