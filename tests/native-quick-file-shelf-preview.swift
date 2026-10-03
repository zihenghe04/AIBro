import AppKit
import SwiftUI
import Quartz
func nativeUI(_ zh: String, _ en: String) -> String { en }

actor DelayedShelfPreviewResolver {
    private var pending: [(NativeQuickFileShelfItem, CheckedContinuation<NativeQuickFileShelfCopyBatch, Error>)] = []
    func resolve(_ items: [NativeQuickFileShelfItem]) async throws -> NativeQuickFileShelfCopyBatch {
        try await withCheckedThrowingContinuation { pending.append((items[0], $0)) }
    }
    var count: Int { pending.count }
    func finish(_ index: Int) throws {
        let (item, continuation) = pending.remove(at: index)
        continuation.resume(returning: try NativeQuickFileShelfCopyBatch(items: [item]))
    }
}

@main struct FileShelfPreviewChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let fm = FileManager.default, root = URL(fileURLWithPath: CommandLine.arguments[1])
        var checks = 0
        func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1 }
        func settle(_ condition: @MainActor () -> Bool) async {
            for _ in 0..<500 { if condition() { return }; try? await Task.sleep(nanoseconds: 5_000_000) }
            precondition(condition(), "Timed out waiting for actual state")
        }
        let first = root.appendingPathComponent("First.txt"), second = root.appendingPathComponent("Second.txt")
        let folder = root.appendingPathComponent("Folder", isDirectory: true)
        let firstBytes = Data("Synthetic preview alpha".utf8), secondBytes = Data("Synthetic preview beta".utf8)
        try firstBytes.write(to: first); try secondBytes.write(to: second)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let directory = root.appendingPathComponent("Shelf")
        let store = NativeQuickFileShelfStore(directory: directory, copyChangeCount: { 0 }, copyWrite: { _ in fatalError("Preview must not write clipboard") })
        let controller = NativeQuickFileShelfPreviewController(store: store)
        check(!controller.open(), "Unavailable shelf refuses preview")
        store.setAvailable(true); store.setVisible(true)
        await settle { store.loaded && !store.busy }
        store.add([first, second, folder]); await settle { !store.busy }
        check(!controller.open(), "Empty selection refuses preview")
        let rows = store.rows, ids = Set(rows.map(\.id))
        let saved = try Data(contentsOf: directory.appendingPathComponent("file-shelf.json"))
        store.selection = ids
        check(controller.open(), "Explicit preview accepts selected files and folder")
        await settle { !controller.loading }
        check(controller.count == 3 && controller.index == 0, "Multi selection follows visible row order")
        check(controller.resource?.item.id == rows[0].id, "Preview resolves the actual first selected reference")
        check(!controller.canGoBack && controller.canGoForward, "Navigation bounds reflect real selection")
        controller.move(-1)
        check(controller.index == 0, "Previous at first item does not wrap")
        controller.move(1); await settle { !controller.loading }
        check(controller.resource?.item.id == rows[1].id, "Next previews the second selected reference")
        controller.move(1); await settle { !controller.loading }
        check(controller.resource?.item.id == rows[2].id && !controller.canGoForward, "Last selected item and final navigation bound")
        controller.move(1); check(controller.index == 2, "Next at last item does not wrap")
        controller.close()
        check(!controller.presented && controller.resource == nil && controller.count == 0, "Close releases preview and its reference lease")
        check(store.selection == ids, "Closing preserves the same selection")
        check(try Data(contentsOf: first) == firstBytes && Data(contentsOf: second) == secondBytes, "Preview does not modify original bytes")
        check(try Data(contentsOf: directory.appendingPathComponent("file-shelf.json")) == saved, "Preview does not write the reference archive")

        _ = controller.open(); await settle { !controller.loading }
        store.setVisible(false)
        check(!controller.presented && controller.resource == nil, "Opacity collapse closes preview without waiting for SwiftUI unmount")
        check(!controller.open(), "Hidden page cannot start another preview")
        store.setVisible(true); await settle { !store.busy }
        _ = controller.open(); await settle { !controller.loading }
        store.selection = [rows[0].id]
        check(!controller.presented, "Changing selection invalidates existing preview snapshot")
        _ = controller.open(); await settle { !controller.loading }
        store.setAvailable(false)
        check(!controller.presented && controller.resource == nil, "Private or unavailable context clears preview synchronously")
        store.setAvailable(true); await settle { store.loaded && !store.busy }
        store.selection = [rows[0].id]; _ = controller.open(); await settle { !controller.loading }
        store.removeSelection(); await settle { !store.busy }
        check(!controller.presented, "Deleting a previewed reference closes the preview")
        store.undoRemoval(); await settle { !store.busy }

        let slow = DelayedShelfPreviewResolver()
        let delayed = NativeQuickFileShelfPreviewController(store: store, resolve: { try await slow.resolve($0) })
        store.selection = ids
        _ = delayed.open()
        while await slow.count < 1 { await Task.yield() }
        delayed.close(); try await slow.finish(0); await Task.yield()
        check(!delayed.presented && delayed.resource == nil, "Late completion after close cannot restore preview")
        _ = delayed.open()
        while await slow.count < 1 { await Task.yield() }
        delayed.move(1)
        while await slow.count < 2 { await Task.yield() }
        try await slow.finish(1); await settle { delayed.resource != nil }
        let latest = delayed.resource?.item.id
        try await slow.finish(0); for _ in 0..<5 { await Task.yield() }
        check(delayed.index == 1 && delayed.resource?.item.id == latest, "Late earlier item cannot overwrite a newer navigation")
        delayed.close()
        _ = delayed.open()
        while await slow.count < 1 { await Task.yield() }
        store.setVisible(false); try await slow.finish(0); for _ in 0..<5 { await Task.yield() }
        check(!delayed.presented && delayed.resource == nil, "Read completion after collapse remains invalidated")
        store.setVisible(true); await settle { !store.busy }

        let originalRow = store.rows.first { $0.item.path == first.path }!
        let otherRow = store.rows.first { $0.item.path == second.path }!
        store.selection = [originalRow.id, otherRow.id]
        _ = controller.open(); await settle { !controller.loading }
        let moved = root.appendingPathComponent("First-moved.txt")
        try fm.moveItem(at: first, to: moved); try Data("Unrelated replacement".utf8).write(to: first)
        let firstIndex = controller.items.firstIndex { $0.id == originalRow.id }!
        controller.move(firstIndex - controller.index)
        await settle { !controller.loading }
        check(controller.resource?.url.standardizedFileURL.path != first.standardizedFileURL.path, "Same path replacement is never previewed as original")
        check(controller.resource == nil || controller.resource?.url.lastPathComponent == moved.lastPathComponent, "Moved bookmark either follows actual original or reports unavailable")
        controller.close()
        try fm.removeItem(at: second)
        store.selection = [otherRow.id]; _ = controller.open(); await settle { !controller.loading }
        check(controller.presented && controller.resource == nil && controller.issue != nil, "Missing original gives explicit preview failure")
        check(store.rows.first { $0.id == otherRow.id }?.available == false, "Failure uses existing unavailable-reference handling")
        controller.close()

        // Real AppKit table routing, in a hidden window. Never opens Finder or
        // touches the system clipboard, user files, or a visible app window.
        let window = NSWindow(contentRect: NSRect(x:0,y:0,width:700,height:430), styleMask:[.titled], backing:.buffered, defer:false)
        let table = NativeQuickFileShelfTableView(frame: NSRect(x:0,y:0,width:600,height:300))
        table.addTableColumn(NSTableColumn(identifier:.init("file")))
        window.contentView = table; window.makeFirstResponder(table)
        var previewRequests = 0
        table.onPreview = { previewRequests += 1; return true }
        func key(_ flags: NSEvent.ModifierFlags = [], repeatKey: Bool = false) -> NSEvent {
            NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:flags,timestamp:0,windowNumber:window.windowNumber,context:nil,characters:" ",charactersIgnoringModifiers:" ",isARepeat:repeatKey,keyCode:49)!
        }
        table.keyDown(with:key())
        check(previewRequests == 1, "Space on focused file table requests preview")
        table.keyDown(with:key(.command)); table.keyDown(with:key(repeatKey:true))
        check(previewRequests == 1, "Modified or repeated Space does not create another preview")
        store.selection = [store.rows.first { $0.item.isDirectory }!.id]
        controller.table = table
        _ = controller.open(); await settle { !controller.loading }
        check(window.firstResponder !== table, "Hidden retained table cannot keep consuming Delete and arrows during preview")
        controller.close()

        // Some bookmark resolvers reject a moved-and-replaced path. Use an
        // independent stable temporary text reference for the actual QL view.
        let stableURL = root.appendingPathComponent("Stable-preview.txt")
        try Data("Synthetic Quick Look content".utf8).write(to: stableURL)
        let stableArchive = NativeQuickFileShelfArchive(directory: root.appendingPathComponent("StableShelf"))
        let stableItem = try await stableArchive.add([stableURL]).rows[0].item
        let resource = NativeQuickFileShelfPreviewResource(item: stableItem, batch: try NativeQuickFileShelfCopyBatch(items: [stableItem]))
        let quickLookHost = NSHostingView(rootView: NativeQuickFileShelfQuickLook(resource: resource))
        window.contentView = quickLookHost; quickLookHost.frame = NSRect(x:0,y:0,width:700,height:430)
        quickLookHost.layoutSubtreeIfNeeded()
        func quickLook(_ view: NSView) -> QLPreviewView? {
            if let view = view as? QLPreviewView { return view }
            return view.subviews.compactMap(quickLook).first
        }
        await settle { quickLook(quickLookHost) != nil }
        check(quickLook(quickLookHost)?.autostarts == false, "Actual production Quick Look view never autostarts media")
        check((quickLook(quickLookHost)?.previewItem?.previewItemURL ?? nil)?.lastPathComponent == stableURL.lastPathComponent, "Actual Quick Look view receives the resolved original URL")
        resource.close()
        let hosted = NSHostingView(rootView: NativeQuickFileShelfView(store: store))
        window.contentView = hosted; hosted.frame = NSRect(x:0,y:0,width:700,height:430); hosted.layoutSubtreeIfNeeded()
        check(hosted.fittingSize.width > 0, "Full production shelf view mounts with inline preview owner")
        store.setAvailable(false); window.contentView = nil
        print("PASS: \(checks) file shelf preview checks")
    }
}
