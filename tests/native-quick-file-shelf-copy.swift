import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }
actor CopyPause {
    var waiting = false
    private var continuation: CheckedContinuation<Void, Never>?
    func hold() async { await withCheckedContinuation { continuation = $0; waiting = true } }
    func resume() { continuation?.resume(); continuation = nil; waiting = false }
}

@main struct ShelfCopyChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fm = FileManager.default
        let original = root.appendingPathComponent("Synthetic Originals", isDirectory:true)
        try fm.createDirectory(at:original, withIntermediateDirectories:true)
        let file = original.appendingPathComponent("课件 #1 100%.md"), folder = original.appendingPathComponent("Synthetic Folder", isDirectory:true)
        let content = Data("# Fictional lecture\nOriginal stays here".utf8)
        try content.write(to:file); try fm.createDirectory(at:folder, withIntermediateDirectories:true)
        let board = NSPasteboard.withUniqueName(); defer { board.releaseGlobally() }
        var checks = 0, writes = 0
        func check(_ condition: Bool, _ text: String) { precondition(condition, text); checks += 1; print("PASS \(text)") }
        func settle(_ store: NativeQuickFileShelfStore) async throws {
            for _ in 0..<500 where store.busy { try await Task.sleep(nanoseconds:2_000_000) }
            check(!store.busy, "operation settles")
        }
        func sentinel() { board.clearContents(); board.setString("SYNTHETIC unchanged clipboard", forType:.string) }
        let directory = root.appendingPathComponent("Shelf")
        let store = NativeQuickFileShelfStore(directory:directory, copyChangeCount:{ board.changeCount }, copyWrite: { urls in writes += 1; return NativeQuickFileShelfCopy.write(urls, to:board) })
        sentinel(); let initialCount = board.changeCount
        check(!store.copySelection(), "unavailable copy does not start")
        store.setAvailable(true); try await settle(store); store.setVisible(true); try await settle(store)
        store.add([file,folder]); try await settle(store)
        check(writes == 0 && board.changeCount == initialCount, "load, visibility and add never touch clipboard")
        let archiveBefore = try Data(contentsOf:directory.appendingPathComponent("file-shelf.json"))
        check(!store.copySelection(), "empty selection does not copy")
        store.selection = Set(store.rows.map(\.id))
        check(store.copySelection() && !store.copySelection(), "explicit batch copy accepts once and rejects overlap")
        try await settle(store)
        let copied = board.readObjects(forClasses:[NSURL.self], options:[.urlReadingFileURLsOnly:true]) as? [URL] ?? []
        check(copied.count == 2 && Set(copied.map { $0.resolvingSymlinksInPath() }) == Set([file,folder].map { $0.resolvingSymlinksInPath() }), "real pasteboard contains complete file and folder NSURL batch with Unicode escaping")
        check(board.pasteboardItems?.count == 2 && board.pasteboardItems!.allSatisfy { $0.types.contains(.fileURL) }, "each selected item remains a separate standard file URL item")
        check(NativeQuickClipboardPolicy.excluded(board.pasteboardItems!.flatMap { $0.types.map(\.rawValue) }), "actual clipboard history policy excludes programmatic file-reference writes")
        check(writes == 1 && store.notice?.contains("2 file references") == true && store.error == nil, "success notice follows complete clipboard write")
        check(try Data(contentsOf:file) == content && Data(contentsOf:directory.appendingPathComponent("file-shelf.json")) == archiveBefore && store.selection.count == 2, "copy preserves original bytes, archive and selection")

        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:700,height:380), styleMask:[.titled], backing:.buffered, defer:false)
        let host = NSHostingView(rootView:NativeQuickFileShelfView(store:store)); window.contentView = host
        host.frame = window.contentLayoutRect
        func find(_ view:NSView)->NativeQuickFileShelfTableView? {
            if let table = view as? NativeQuickFileShelfTableView { return table }
            for child in view.subviews { if let table = find(child) { return table } }; return nil
        }
        for _ in 0..<20 { host.layoutSubtreeIfNeeded(); try await Task.sleep(nanoseconds:5_000_000) }
        guard let table = find(host) else { fatalError("Production table did not mount") }
        check(window.makeFirstResponder(table), "hidden actual window gives table the responder")
        let copyMenu = NSMenuItem(title:"Copy", action:#selector(NativeQuickFileShelfTableView.copy(_:)), keyEquivalent:"c")
        check(table.validateUserInterfaceItem(copyMenu), "Edit Copy validates for selected focused table")
        func command(_ modifiers:NSEvent.ModifierFlags)->NSEvent {
            NSEvent.keyEvent(with:.keyDown, location:.zero, modifierFlags:modifiers, timestamp:0, windowNumber:window.windowNumber, context:nil, characters:"c", charactersIgnoringModifiers:"c", isARepeat:false, keyCode:8)!
        }
        let beforeShortcut = writes
        check(table.performKeyEquivalent(with:command(.command)), "real table Cmd-C begins copy")
        try await settle(store)
        check(writes == beforeShortcut + 1, "Cmd-C performs exactly one complete write")
        check(!table.performKeyEquivalent(with:command([.command,.shift])) && writes == beforeShortcut + 1, "modified Cmd-Shift-C is not captured")
        let other = NSTextView(frame:NSRect(x:0,y:0,width:100,height:40)); host.addSubview(other); window.makeFirstResponder(other)
        check(!table.validateUserInterfaceItem(copyMenu) && !table.performKeyEquivalent(with:command(.command)), "another editor owns copy and table does not steal Cmd-C")
        table.copy(nil)
        check(writes == beforeShortcut + 1, "direct Copy action cannot run when table is not first responder")
        other.removeFromSuperview()

        // Cached rows are deliberately not refreshed: action must re-resolve.
        let renamed = original.appendingPathComponent("Renamed lecture.md")
        try fm.moveItem(at:file,to:renamed); try Data("A different original-path occupant".utf8).write(to:file)
        sentinel(); let replacementCount = board.changeCount
        let oldItem = store.rows.first { !$0.item.isDirectory }!.item
        check(store.copySelection(), "stale cached selection reaches fresh identity validation")
        try await settle(store)
        if let resolved = NativeQuickFileShelfArchive.resolve(oldItem) {
            let result = board.readObjects(forClasses:[NSURL.self],options:nil) as? [URL] ?? []
            check(result.count == 2 && result.contains { $0.resolvingSymlinksInPath() == resolved.resolvingSymlinksInPath() } && !result.contains { $0.resolvingSymlinksInPath() == file.resolvingSymlinksInPath() }, "rename resolves true original and never copies replacement")
        } else {
            check(board.changeCount == replacementCount && store.error?.contains("Nothing was copied") == true, "unresolvable replaced path rejects entire batch before clipboard change")
        }
        store.selection = [store.rows.first { $0.item.isDirectory }!.id]
        try fm.removeItem(at:folder); sentinel(); let missingCount = board.changeCount
        check(store.copySelection(), "newly removed original is checked at copy time")
        try await settle(store)
        check(board.changeCount == missingCount && store.error != nil && store.notice == nil, "missing original leaves existing clipboard and no false success")

        let missingFile = original.appendingPathComponent("Remove after adding.txt"); try Data("Synthetic missing item".utf8).write(to:missingFile)
        var mixedWrites = 0
        let mixed = NativeQuickFileShelfStore(directory:root.appendingPathComponent("Mixed"), copyChangeCount:{ board.changeCount }, copyWrite:{ urls in mixedWrites += 1; return NativeQuickFileShelfCopy.write(urls,to:board) })
        mixed.setAvailable(true); try await settle(mixed); mixed.setVisible(true); try await settle(mixed); mixed.add([renamed,missingFile]); try await settle(mixed)
        mixed.selection = Set(mixed.rows.map(\.id)); try fm.removeItem(at:missingFile); sentinel(); let mixedCount = board.changeCount
        mixed.copySelection(); try await settle(mixed)
        check(mixedWrites == 0 && board.changeCount == mixedCount && mixed.error?.contains("1 originals") == true, "one valid plus one missing original rejects entire batch without replacing clipboard")
        check(mixed.rows.count == 2 && mixed.selection.count == 2 && fm.fileExists(atPath:renamed.path), "failed batch keeps references, selection and surviving original")

        // Stable suspended resolution, not timing a filesystem race.
        func pausedStore(_ name:String, pause:CopyPause, write: @escaping ([URL])->Bool) async throws -> NativeQuickFileShelfStore {
            let state = NativeQuickFileShelfStore(directory:root.appendingPathComponent(name), copyResolve:{ items in
                await pause.hold(); return try NativeQuickFileShelfCopyBatch(items:items)
            }, copyChangeCount:{ board.changeCount }, copyWrite:write)
            state.setAvailable(true); try await settle(state); state.setVisible(true); try await settle(state)
            state.add([renamed,file]); try await settle(state); state.selection = Set(state.rows.map(\.id)); return state
        }
        func waitForPause(_ pause:CopyPause) async throws { for _ in 0..<500 { if await pause.waiting { return }; try await Task.sleep(nanoseconds:1_000_000) }; fatalError("resolution did not suspend") }
        var lateWrites = 0
        let selectionPause = CopyPause(), changed = try await pausedStore("Selection",pause:selectionPause,write:{ _ in lateWrites += 1; return true })
        changed.copySelection(); try await waitForPause(selectionPause); changed.selection = [changed.rows[0].id]; await selectionPause.resume(); try await settle(changed)
        check(lateWrites == 0 && changed.notice?.contains("Selection changed") == true, "changing selection while resolving cannot copy the old batch")
        let roundTripPause = CopyPause(), roundTrip = try await pausedStore("SelectionRoundTrip",pause:roundTripPause,write:{ _ in lateWrites += 1; return true })
        let previousSelection = roundTrip.selection
        roundTrip.copySelection(); try await waitForPause(roundTripPause); roundTrip.selection = [roundTrip.rows[0].id]; roundTrip.selection = previousSelection
        await roundTripPause.resume(); try await settle(roundTrip)
        check(lateWrites == 0 && roundTrip.notice?.contains("Selection changed") == true, "selection round trip still invalidates the earlier copy intent")
        let clipboardPause = CopyPause(), clipboardOwner = try await pausedStore("ClipboardOwner",pause:clipboardPause,write:{ urls in lateWrites += 1; return NativeQuickFileShelfCopy.write(urls,to:board) })
        clipboardOwner.copySelection(); try await waitForPause(clipboardPause)
        board.clearContents(); board.setString("NEW synthetic user copy", forType:.string); let newCopyCount = board.changeCount
        await clipboardPause.resume(); try await settle(clipboardOwner)
        check(lateWrites == 0 && board.changeCount == newCopyCount && board.string(forType:.string) == "NEW synthetic user copy" && clipboardOwner.notice?.contains("clipboard changed") == true, "newer user copy wins across background resolution without reading its content in production")
        clipboardOwner.copySelection(); try await waitForPause(clipboardPause); await clipboardPause.resume(); try await settle(clipboardOwner)
        check(lateWrites == 1 && (board.readObjects(forClasses:[NSURL.self],options:nil)?.count ?? 0) == 2 && clipboardOwner.error == nil, "a new explicit copy can replace the clipboard after the earlier request yields")
        lateWrites = 0
        let hiddenPause = CopyPause(), hidden = try await pausedStore("Hidden",pause:hiddenPause,write:{ _ in lateWrites += 1; return true })
        hidden.copySelection(); try await waitForPause(hiddenPause); hidden.setVisible(false); await hiddenPause.resume()
        try await Task.sleep(nanoseconds:20_000_000)
        check(lateWrites == 0 && !hidden.busy && hidden.notice == nil && hidden.error == nil, "hiding module cancels copy without late clipboard write or error")
        let privatePause = CopyPause(), privateStore = try await pausedStore("Private",pause:privatePause,write:{ _ in lateWrites += 1; return true })
        privateStore.copySelection(); try await waitForPause(privatePause); privateStore.setAvailable(false); await privatePause.resume()
        try await Task.sleep(nanoseconds:20_000_000)
        check(lateWrites == 0 && privateStore.rows.isEmpty && privateStore.selection.isEmpty && privateStore.notice == nil && privateStore.error == nil, "private revocation removes visible state and rejects late copy")
        let failing = NativeQuickFileShelfStore(directory:root.appendingPathComponent("FailWrite"),copyChangeCount:{ board.changeCount },copyWrite:{ _ in false })
        failing.setAvailable(true); try await settle(failing); failing.setVisible(true); try await settle(failing); failing.add([renamed,file]); try await settle(failing)
        failing.selection = Set(failing.rows.map(\.id)); failing.copySelection(); try await settle(failing)
        check(failing.error?.contains("Could not copy") == true && failing.notice == nil && failing.rows.count == 2 && failing.selection.count == 2, "writer failure is explicit and does not remove references or claim success")
        print("PASS: \(checks) shelf copy checks; only a unique named pasteboard, no Finder GUI or general clipboard")
    }
}
