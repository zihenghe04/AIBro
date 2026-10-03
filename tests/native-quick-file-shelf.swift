import AppKit
import SwiftUI
import UniformTypeIdentifiers
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct FileShelfChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let fm = FileManager.default, root = URL(fileURLWithPath: CommandLine.arguments[1])
        let originals = root.appendingPathComponent("Originals", isDirectory: true)
        try fm.createDirectory(at: originals, withIntermediateDirectories: true)
        let first = originals.appendingPathComponent("Lecture.md"), second = originals.appendingPathComponent("Plan.txt"), folder = originals.appendingPathComponent("Sources", isDirectory: true)
        let firstData = Data("# Synthetic lecture\nDo not move me".utf8)
        try firstData.write(to:first); try Data("Synthetic plan".utf8).write(to:second); try fm.createDirectory(at:folder,withIntermediateDirectories:true)
        var checks = 0
        func check(_ value: Bool,_ label:String) { precondition(value,label); checks += 1 }
        let directory = root.appendingPathComponent("QuickTools"), archive = NativeQuickFileShelfArchive(directory:directory)
        var result = try await archive.add([first,second,folder])
        check(result.rows.count == 3 && result.rows.allSatisfy(\.available), "Files and folder references resolve")
        check(try Data(contentsOf:first) == firstData, "Adding leaves original bytes untouched")
        check(try fm.contentsOfDirectory(atPath:directory.path) == ["file-shelf.json"], "Only reference JSON is persisted")
        let bytes = try Data(contentsOf:directory.appendingPathComponent("file-shelf.json"))
        check(!String(decoding:bytes,as:UTF8.self).contains("Do not move me"), "File contents never enter the archive")
        let permissions = try fm.attributesOfItem(atPath:directory.appendingPathComponent("file-shelf.json").path)[.posixPermissions] as? NSNumber
        check(permissions?.intValue == 0o600, "Reference archive is owner-only")
        let alias=originals.appendingPathComponent("Lecture-alias.md"); try fm.createSymbolicLink(at:alias,withDestinationURL:first)
        result = try await archive.add([first,alias,first])
        check(result.rows.count == 3 && result.duplicates == 3, "Existing, repeated and symlink targets deduplicate")
        let restarted = NativeQuickFileShelfArchive(directory:directory)
        result = try await restarted.read()
        check(result.rows.count == 3 && result.rows.allSatisfy(\.available), "Restart resolves bookmarks")
        do { _ = try await restarted.add([originals.appendingPathComponent("missing.txt"), URL(string:"https://example.test/file")!]); fatalError("Expected invalid file") }
        catch NativeQuickFileShelfError.invalidFile { checks += 1 }
        check(try await restarted.read().rows.count == 3, "Invalid batch does not change saved references")
        let renamed = originals.appendingPathComponent("Lecture-renamed.md")
        try fm.moveItem(at:first,to:renamed)
        result = try await restarted.read()
        check(result.rows.contains(where:{$0.url?.lastPathComponent == renamed.lastPathComponent}), "Bookmark tracks original rename")
        let missingID = result.rows.first(where:{$0.name == second.lastPathComponent})!.id
        try fm.removeItem(at:second)
        result = try await restarted.read()
        check(result.rows.first(where:{$0.id == missingID})?.available == false, "Missing original stays visible but unavailable")
        let selected=Set(result.rows.map(\.id).prefix(2))
        result = try await restarted.remove(selected)
        check(result.rows.count == 1 && result.canUndo, "Batch remove records one undo")
        check(fm.fileExists(atPath:renamed.path) && fm.fileExists(atPath:folder.path), "Removing references does not delete originals")
        result = try await restarted.undoRemoval()
        check(result.rows.count == 3 && !result.canUndo, "Batch undo restores missing and present references")
        let renamedID=result.rows.first(where:{$0.name == renamed.lastPathComponent})!.id
        _ = try await restarted.remove([renamedID]); _ = try await restarted.add([renamed])
        result=try await restarted.undoRemoval()
        check(result.rows.count == 3 && result.rows.filter{$0.name == renamed.lastPathComponent}.count == 1, "Re-add then undo cannot duplicate a reference")
        let limitArchive=NativeQuickFileShelfArchive(directory:root.appendingPathComponent("Limits"))
        var many:[URL]=[]
        for index in 0..<101 { let url=originals.appendingPathComponent("item-\(index).txt"); try Data("synthetic".utf8).write(to:url); many.append(url) }
        _ = try await limitArchive.add(Array(many.prefix(99)))
        do { _ = try await limitArchive.add(Array(many.suffix(2))); fatalError("Expected capacity error") } catch NativeQuickFileShelfError.limit { checks += 1 }
        check(try await limitArchive.read().rows.count == 99, "Overflow rejects the entire batch, no silent partial add")
        _ = try await limitArchive.add([many[99]])
        check(try await limitArchive.read().rows.count == 100, "Exactly 100 references supported")
        let bad=root.appendingPathComponent("Corrupt"); try fm.createDirectory(at:bad,withIntermediateDirectories:true)
        let badFile=bad.appendingPathComponent("file-shelf.json"); try Data("not a shelf".utf8).write(to:badFile)
        do { _ = try await NativeQuickFileShelfArchive(directory:bad).add([renamed]); fatalError("Expected corruption") } catch NativeQuickFileShelfError.corrupt { checks += 1 }
        check(try String(contentsOf:badFile) == "not a shelf", "Corrupt archive is not overwritten")
        let gatedDirectory = root.appendingPathComponent("Gated")
        let gatedArchive = NativeQuickFileShelfArchive(directory:gatedDirectory)
        _ = try await gatedArchive.add([folder])
        let beforeRevoke = try Data(contentsOf:gatedDirectory.appendingPathComponent("file-shelf.json"))
        let gate = NativeQuickFileShelfCommitGate(); gate.revoke()
        do { _ = try await gatedArchive.add([renamed],gate:gate); fatalError("Expected revoked commit") } catch is CancellationError { checks += 1 }
        check(try Data(contentsOf:gatedDirectory.appendingPathComponent("file-shelf.json")) == beforeRevoke, "Revoked final commit cannot overwrite the manifest even without Task cancellation")
        check(try fm.contentsOfDirectory(atPath:gatedDirectory.path) == ["file-shelf.json"], "Revoked commit removes the staged reference manifest")
        let symlink=root.appendingPathComponent("Redirect"); try fm.createSymbolicLink(at:symlink,withDestinationURL:directory)
        do { _ = try await NativeQuickFileShelfArchive(directory:symlink).add([renamed]); fatalError("Expected unsafe directory") } catch NativeQuickFileShelfError.unsafeDirectory { checks += 1 }
        let provider=NSItemProvider(contentsOf:renamed)!
        // Use the same explicit file-URL representation Finder drops supply.
        let fileProvider=NSItemProvider(); fileProvider.registerDataRepresentation(forTypeIdentifier:UTType.fileURL.identifier,visibility:.all) { completion in completion(renamed.dataRepresentation,nil); return nil }
        check(NativeQuickFileShelfStore.canAccept([fileProvider]), "Declared file-URL provider is accepted")
        check(!NativeQuickFileShelfStore.canAccept([NSItemProvider(object:"https://example.test" as NSString)]) && !NativeQuickFileShelfStore.canAccept([]), "Text, remote links and empty drops are rejected")
        let url=try await NativeQuickFileShelfStore.loadURL(fileProvider)
        check(url == renamed, "Provider URL decodes without copying file payload")
        let hanging=NSItemProvider(); hanging.registerDataRepresentation(forTypeIdentifier:UTType.fileURL.identifier,visibility:.all) { _ in Progress(totalUnitCount:1) }
        do { _ = try await NativeQuickFileShelfStore.loadURL(hanging,timeout:0.05); fatalError("Expected timeout") } catch NativeQuickFileShelfError.timedOut { checks += 1 }
        let store=NativeQuickFileShelfStore(directory:root.appendingPathComponent("UI"))
        check(!store.acceptProviders([fileProvider]), "Unavailable store rejects drops")
        store.setAvailable(true)
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        check(store.loaded && store.rows.isEmpty, "Ready store finishes asynchronous load")
        store.setVisible(true) // Same event ordering as hover-expanding the island.
        check(store.busy && store.canReceiveDrop, "Read-only visibility refresh remains receptive to a drop")
        check(store.acceptProviders([fileProvider]), "Ready store queues provider asynchronously")
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        check(store.rows.count == 1 && store.error == nil, "Accepted drop publishes saved reference")
        store.add([folder])
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:360),styleMask:[.titled],backing:.buffered,defer:false)
        let host=NSHostingView(rootView:NativeQuickFileShelfView(store:store)); window.contentView=host
        host.frame=window.contentLayoutRect; host.layoutSubtreeIfNeeded()
        for _ in 0..<20 { try await Task.sleep(nanoseconds:10_000_000); host.layoutSubtreeIfNeeded() }
        func findTable(_ view:NSView)->NSTableView? { if let table=view as? NSTableView{return table}; for child in view.subviews {if let table=findTable(child){return table}}; return nil }
        guard let table=findTable(host), let source=table.dataSource else {fatalError("Production table not mounted")}
        check(table.numberOfRows == 2 && table.allowsMultipleSelection, "Production hidden-window table mounts both references and multi-selection")
        table.selectRowIndexes(IndexSet([0,1]),byExtendingSelection:false)
        check(store.selection.count == 2, "Native table selection feeds batch action")
        check(table.canDragRows(with:IndexSet([0,1]),at:.zero), "AppKit drag gate prepares the entire selected batch before requesting writers")
        let writers=(0..<2).compactMap { source.tableView?(table,pasteboardWriterForRow:$0) }
        let board=NSPasteboard.withUniqueName(); defer { board.releaseGlobally() }
        check(writers.count == 2 && board.writeObjects(writers), "Production drag writers write both selected real URLs")
        let urls=board.readObjects(forClasses:[NSURL.self],options:nil) as? [URL] ?? []
        check(urls.count == 2 && Set(urls.map{$0.resolvingSymlinksInPath()}) == Set([folder,renamed].map{$0.resolvingSymlinksInPath()}), "Outgoing drag contains original URLs, not temporary copies or text")
        check(store.rows.count == 2 && fm.fileExists(atPath:renamed.path), "Creating/cancelling an unconsumed drag does not remove entries or originals")
        (table as? NativeQuickFileShelfTableView)?.onFinishUnstartedDrag()
        let movedAgain = originals.appendingPathComponent("Lecture-original-moved.md")
        try fm.moveItem(at:renamed,to:movedAgain)
        try Data("Different file at the old path".utf8).write(to:renamed)
        let originalRow = store.rows.firstIndex(where:{$0.name == renamed.lastPathComponent})!
        let originalID = store.rows[originalRow].id
        _ = table.canDragRows(with:IndexSet(integer:originalRow),at:.zero)
        let freshWriter = source.tableView?(table,pasteboardWriterForRow:originalRow) as? NSURL
        check(freshWriter == nil || freshWriter?.resolvingSymlinksInPath?.lastPathComponent == movedAgain.lastPathComponent, "Drag resolves the original or refuses, never the replacement at the cached path")
        if freshWriter == nil { check(store.rows.first(where:{$0.id == originalID})?.available == false && store.error != nil, "An identity mismatch is visibly unavailable rather than silently substituting a file") }
        (table as? NativeQuickFileShelfTableView)?.onFinishUnstartedDrag()
        let revealURLs = store.resolvedSelection()
        check(!revealURLs.contains(where:{$0.lastPathComponent == renamed.lastPathComponent}) && revealURLs.allSatisfy({$0.lastPathComponent == movedAgain.lastPathComponent || $0.lastPathComponent == folder.lastPathComponent}), "Finder action only resolves original identities and never a cached replacement path")
        store.removeSelection()
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        check(store.rows.isEmpty && store.canUndo && fm.fileExists(atPath:folder.path), "UI batch remove persists reference removal only")
        store.undoRemoval()
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        check(store.rows.count == 2, "UI undo restores both references")
        try fm.removeItem(at:movedAgain)
        host.layoutSubtreeIfNeeded()
        let renamedRow = store.rows.firstIndex(where:{$0.id == originalID})!
        for _ in 0..<4 { try await Task.sleep(nanoseconds:5_000_000); host.layoutSubtreeIfNeeded() }
        _ = table.canDragRows(with:IndexSet(integer:renamedRow),at:.zero)
        check(source.tableView?(table,pasteboardWriterForRow:renamedRow) == nil, "A newly missing original cannot be dragged even before refresh")
        store.setAvailable(false)
        check(store.rows.isEmpty && store.selection.isEmpty && !store.acceptProviders([fileProvider]), "Private/unavailable clears visible data and rejects drops")
        store.setAvailable(true)
        for _ in 0..<200 where store.busy { try await Task.sleep(nanoseconds:10_000_000) }
        let late = NSItemProvider(); late.registerDataRepresentation(forTypeIdentifier:UTType.fileURL.identifier,visibility:.all) { completion in
            DispatchQueue.global().asyncAfter(deadline:.now()+0.05) { completion(many[0].dataRepresentation,nil) }; return nil
        }
        check(store.acceptProviders([late]), "Delayed explicit file URL can be queued")
        store.setAvailable(false)
        try await Task.sleep(nanoseconds:150_000_000)
        let persisted = try await NativeQuickFileShelfArchive(directory:root.appendingPathComponent("UI")).read()
        check(persisted.rows.count == 2 && store.rows.isEmpty, "Switching to private cancels delayed provider before archive mutation")
        _ = provider // A contents provider is intentionally not required/accepted unless it declares file-url.
        print("PASS: \(checks) file shelf checks")
    }
}
