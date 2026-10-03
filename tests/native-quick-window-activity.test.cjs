const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('window worker and store: settled activity, coalescing, cancellation, privacy and cache', {skip: process.platform !== 'darwin', timeout: 90000}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-window-activity-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickMedia.swift'), 'utf8');
    const begin = source.indexOf('struct NativeQuickWindowItem:');
    const end = source.indexOf('@MainActor final class NativeQuickMusicStore');
    assert.ok(begin >= 0 && end > begin);
    const extracted = path.join(temporary, 'WindowProduction.swift');
    fs.writeFileSync(extracted, 'import AppKit\nimport SwiftUI\nimport Combine\n' + source.slice(begin, end));
    const files = ['NativeQuickWindowSnapshot.swift', 'NativeQuickWindowActivation.swift', 'NativeQuickWindowInteraction.swift', 'NativeQuickWindowInteractionView.swift', 'NativeQuickPresentation.swift', 'NativeQuickWidgetContext.swift'].map(f => path.join(root, 'native/Sources/AIBro', f));
    const binary = path.join(temporary, 'checks');
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...files, extracted, path.join(root, 'tests/native-quick-window-activity.swift'), '-o', binary], {encoding: 'utf8', timeout: 60000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(binary, [], {encoding: 'utf8', timeout: 15000});
    process.stdout.write(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /window activity assertions passed/);
    // Integration contracts only; this does not claim mounted SwiftUI/live QA.
    const home = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickHomeView.swift'), 'utf8');
    assert.equal((home.match(/active: coordinator\.presentation\.phase == \.expanded/g) || []).length, 2);
    assert.match(home, /onVisibilityChange: visible\.contains\(id\) \? nil : module\.onVisibilityChange,\s+onActivityChange: visible\.contains\(id\) \? nil : module\.onActivityChange/);
    assert.match(home, /onDisappear \{ module\.onVisibilityChange\?\(false\); module\.onActivityChange\?\(false\) \}/);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});
