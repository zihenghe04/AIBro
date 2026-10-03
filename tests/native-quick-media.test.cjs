const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const harness = String.raw`
import Foundation
func nativeUI(_ zh: String, _ en: String) -> String { en }
struct TestFailure: Error { let message: String }
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw TestFailure(message: message) }
}
func fixture(_ id: String = UUID().uuidString.lowercased(), state: String = "ready") -> NativeQuickRecordingItem {
    .init(id: id, title: "Synthetic recording", createdAt: Date(timeIntervalSince1970: 1900000000), duration: 12.5, transcript: "", state: state)
}
@main struct Main {
    @MainActor static func main() async throws {
        let name = CommandLine.arguments[1]
        let dir = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        let fm = FileManager.default
        switch name {
        case "roundtrip-owner-only":
            var archive = try NativeQuickRecordingArchive(directory: dir)
            let item = fixture(); try archive.replace([item])
            let restarted = try NativeQuickRecordingArchive(directory: dir)
            try check(restarted.items == [item], "Manifest must retain the exact recording identity")
            try check((try fm.attributesOfItem(atPath: dir.path)[.posixPermissions] as? NSNumber)?.intValue == 0o700, "Folder must be owner-only")
            try check((try fm.attributesOfItem(atPath: dir.appendingPathComponent("index.json").path)[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Manifest must be owner-only")
        case "interrupted-and-orphan-recovery":
            var archive = try NativeQuickRecordingArchive(directory: dir)
            let item = fixture(state: "recording"), orphan = fixture()
            try archive.replace([item])
            try Data("synthetic audio".utf8).write(to: dir.appendingPathComponent(orphan.fileName))
            let restarted = try NativeQuickRecordingArchive(directory: dir)
            try check(restarted.items.count == 2 && restarted.items.allSatisfy { $0.state == "interrupted" }, "Crash and orphan recordings must be recovered without claiming completion")
            let again = try NativeQuickRecordingArchive(directory: dir)
            try check(again.items.count == 2, "Orphan recovery must be idempotent")
        case "reversible-delete-keeps-bytes":
            var archive = try NativeQuickRecordingArchive(directory: dir)
            let item = fixture(); try archive.replace([item])
            let audio = try archive.audioURL(for: item.id, mustExist: false)
            let bytes = Data("synthetic audio bytes".utf8); try bytes.write(to: audio)
            try archive.update(id: item.id) { $0.deletedAt = Date() }
            var restarted = try NativeQuickRecordingArchive(directory: dir)
            try check(restarted.items[0].deletedAt != nil && (try Data(contentsOf: audio)) == bytes, "Deletion must retain exact recoverable audio")
            try restarted.update(id: item.id) { $0.deletedAt = nil }
            try check(restarted.items[0].deletedAt == nil && (try Data(contentsOf: audio)) == bytes, "Restore must preserve identity and bytes")
        case "manifest-write-failure-retains-state":
            var good = try NativeQuickRecordingArchive(directory: dir)
            let item = fixture(); try good.replace([item])
            let before = try Data(contentsOf: dir.appendingPathComponent("index.json"))
            var failing = try NativeQuickRecordingArchive(directory: dir, write: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
            do { try failing.update(id: item.id) { $0.title = "Must not publish" }; throw TestFailure(message: "Write unexpectedly succeeded") }
            catch is CocoaError {}
            try check(failing.items[0].title == item.title, "Failed write must not change published in-memory state")
            try check(try Data(contentsOf: dir.appendingPathComponent("index.json")) == before, "Failed write must preserve old manifest")
        case "corrupt-manifest-not-overwritten":
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("index.json"), bytes = Data("{broken:".utf8); try bytes.write(to: file)
            do { _ = try NativeQuickRecordingArchive(directory: dir); throw TestFailure(message: "Corrupt file was accepted") }
            catch is DecodingError {}
            try check(try Data(contentsOf: file) == bytes, "Corrupt original must remain recoverable")
        case "reject-traversal-duplicates-and-symlinks":
            var archive = try NativeQuickRecordingArchive(directory: dir)
            let item = fixture(); try archive.replace([item])
            do { try archive.replace([fixture("../../escape")]); throw TestFailure(message: "Path traversal accepted") } catch is CocoaError {}
            do { try archive.replace([item, item]); throw TestFailure(message: "Duplicate identity accepted") } catch is CocoaError {}
            let outside = dir.deletingLastPathComponent().appendingPathComponent("outside-audio")
            try Data("private".utf8).write(to: outside)
            try fm.createSymbolicLink(at: dir.appendingPathComponent(item.fileName), withDestinationURL: outside)
            do { _ = try archive.audioURL(for: item.id); throw TestFailure(message: "Symlink accepted") } catch is CocoaError {}
            try check(try Data(contentsOf: outside) == Data("private".utf8), "Outside target must not be mutated")
        case "non-finite-duration-rejected":
            var archive = try NativeQuickRecordingArchive(directory: dir)
            var item = fixture(); item.duration = .infinity
            do { try archive.replace([item]); throw TestFailure(message: "Infinite duration accepted") } catch is CocoaError {}
            item.duration = -1
            do { try archive.replace([item]); throw TestFailure(message: "Negative duration accepted") } catch is CocoaError {}
        case "store-no-automatic-permissions-or-recording":
            let store = NativeQuickRecordingStore(); store.configure(directory: dir)
            try check(store.ready && store.phase == .idle && store.items.isEmpty, "Configuration must be passive")
            store.setVisible(true)
            try check(store.phase == .idle, "Showing panel must not capture microphone")
            store.setVisible(false); await store.start()
            try check(store.phase == .idle && store.items.isEmpty, "Hidden start must not request permission or create a record")
            store.configure(directory: dir.appendingPathComponent("different"))
            try check(store.error != nil, "Workspace switches cannot silently mix recording libraries")
            store.shutdown()
        case "store-title-transcript-delete-restore":
            var archive = try NativeQuickRecordingArchive(directory: dir.appendingPathComponent("quick-recordings"))
            let item = fixture(); try archive.replace([item])
            let store = NativeQuickRecordingStore(); store.configure(directory: dir)
            store.rename(id: item.id, title: "Updated synthetic title")
            store.saveTranscript(id: item.id, text: "Original words, locally edited.")
            store.setDeleted(id: item.id, deleted: true); store.setDeleted(id: item.id, deleted: false)
            let restarted = NativeQuickRecordingStore(); restarted.configure(directory: dir)
            try check(restarted.items.count == 1 && restarted.items[0].id == item.id && restarted.items[0].deletedAt == nil, "Editing and restore retain exact identity")
            try check(restarted.items[0].title == "Updated synthetic title" && restarted.items[0].transcript == "Original words, locally edited.", "User-edited title and transcript must survive restart")
        default: throw TestFailure(message: "Unknown test")
        }
        print("PASS " + name)
    }
}
`;

test('native media: durable state, recovery and passive device lifecycle', { timeout: 90_000 }, t => {
  if (process.platform !== 'darwin') return t.skip('macOS frameworks');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-quick-media-'));
  try {
    const source = path.join(temp, 'Harness.swift'), binary = path.join(temp, 'media-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-target', 'arm64-apple-macosx14.0', source,
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingBatch.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingStore.swift'),
      ...['NativeSpeechService','NativeSpeechCredentials','NativeSpeechSettingsView','NativeCredentials','AgendaCore'].map(s=>path.join(root,'native/Sources/AIBro/'+s+'.swift')),
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingPlayback.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRHandoff.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRProtocol.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRSession.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRSettings.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRAudio.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRealtimeASRView.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingTitle.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingProjection.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickRecordingViews.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickWidgetContext.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickNowPlaying.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickWindowSnapshot.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickWindowActivation.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickWindowInteraction.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickWindowInteractionView.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickMirrorCamera.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickMirrorPreferences.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickMirrorStore.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickMirrorView.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickMedia.swift'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    for (const name of ['roundtrip-owner-only', 'interrupted-and-orphan-recovery', 'reversible-delete-keeps-bytes',
      'manifest-write-failure-retains-state', 'corrupt-manifest-not-overwritten', 'reject-traversal-duplicates-and-symlinks',
      'non-finite-duration-rejected', 'store-no-automatic-permissions-or-recording', 'store-title-transcript-delete-restore']) {
      const result = spawnSync(binary, [name, path.join(temp, name)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, name + ': ' + result.stdout + result.stderr);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
