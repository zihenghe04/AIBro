import AppKit
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String{en}
@main struct ShelfDragChecks {
 @MainActor static func main() async throws {
  _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
  let root=URL(fileURLWithPath:CommandLine.arguments[1]), a=root.appendingPathComponent("Fixture-A.txt"), b=root.appendingPathComponent("资料 B.txt"), folder=root.appendingPathComponent("Fixture-folder",isDirectory:true)
  try Data("Synthetic A".utf8).write(to:a);try Data("Synthetic B".utf8).write(to:b)
  try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
  let store=NativeQuickFileShelfStore(directory:root.appendingPathComponent("archive"),copyChangeCount:{0},copyWrite:{_ in fatalError("No keyboard copy in this test")})
  var checks=0
  func check(_ ok:Bool,_ label:String){precondition(ok,label);checks += 1;print("PASS \(checks): \(label)")}
  func wait() async throws {for _ in 0..<300 where store.busy {try await Task.sleep(nanoseconds:2_000_000)};precondition(!store.busy)}
  store.setAvailable(true);store.setVisible(true);try await wait();store.add([a,b,folder]);try await wait()
  let originalManifest=try Data(contentsOf:root.appendingPathComponent("archive/file-shelf.json"))
  let window=NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:360),styleMask:[.titled],backing:.buffered,defer:false)
  let host=NSHostingView(rootView:NativeQuickFileShelfView(store:store));window.contentView=host;host.frame=window.contentLayoutRect
  for _ in 0..<20 {host.layoutSubtreeIfNeeded();try await Task.sleep(nanoseconds:5_000_000)}
  func find(_ v:NSView)->NativeQuickFileShelfTableView? {if let t=v as? NativeQuickFileShelfTableView{return t};for c in v.subviews{if let t=find(c){return t}};return nil}
  guard let table=find(host), let source=table.dataSource else {fatalError("Missing production table")}
  let indexes=IndexSet(integersIn:0..<3), point=NSPoint(x:16,y:20)
  func writers()->[NSPasteboardWriting]{indexes.compactMap{source.tableView?(table,pasteboardWriterForRow:$0)}}
  table.selectRowIndexes(indexes,byExtendingSelection:false)
  check(table.canDragRows(with:indexes,at:point),"Actual native table admits an intact three-item drag")
  let complete=writers();let board=NSPasteboard.withUniqueName();defer{board.releaseGlobally()}
  check(complete.count==3 && board.writeObjects(complete),"All production row writers publish standard NSURL objects")
  let decoded=board.readObjects(forClasses:[NSURL.self],options:nil) as? [URL] ?? []
  check(Set(decoded.map{$0.standardizedFileURL})==Set([a,b,folder].map{$0.standardizedFileURL}),"Unique drag pasteboard contains all originals, including Unicode and directory")
  let cell=table.view(atColumn:0,row:0,makeIfNecessary:true) as! NSTableCellView
  check(cell.draggingImageComponents.contains{$0.contents != nil && $0.frame.width>0 && $0.frame.height>0},"Existing AppKit drag preview is nonempty; no speculative preview rewrite")
  table.onFinishUnstartedDrag()
  check(writers().isEmpty,"A cancelled pre-session candidate releases all prepared writers")
  check(store.rows.count==3 && FileManager.default.fileExists(atPath:a.path),"Cancelling preparation leaves references and originals intact")
  try FileManager.default.removeItem(at:a)
  check(!table.canDragRows(with:indexes,at:point),"One missing original rejects the entire native drag gate")
  check(writers().isEmpty,"A rejected multi-drag cannot silently publish the remaining files")
  check(store.error?.contains("whole drag") == true,"Batch rejection is explicit to the user")
  // Remove only the broken selection. The next actual preparation starts a
  // fresh lease; a failed previous attempt must not poison valid later drags.
  for _ in 0..<4 {host.layoutSubtreeIfNeeded();try await Task.sleep(nanoseconds:5_000_000)}
  let validIndexes=IndexSet(store.rows.indices.filter{store.rows[$0].item.path != a.path})
  table.selectRowIndexes(validIndexes,byExtendingSelection:false)
  check(table.canDragRows(with:validIndexes,at:point),"Deselecting the missing reference permits a fresh valid batch")
  check(validIndexes.compactMap{source.tableView?(table,pasteboardWriterForRow:$0)}.count==2,"Both remaining originals are delivered after an explicit new attempt")
  table.onFinishUnstartedDrag()
  // Snapshot identity must still follow the original or reject it, never use a
  // replacement placed at a formerly valid path.
  let bIndex=store.rows.firstIndex{$0.item.path==b.path}!, renamed=root.appendingPathComponent("Moved-original.txt")
  try FileManager.default.moveItem(at:b,to:renamed);try Data("REPLACEMENT".utf8).write(to:b)
  table.selectRowIndexes(IndexSet(integer:bIndex),byExtendingSelection:false)
  let admitted=table.canDragRows(with:IndexSet(integer:bIndex),at:point)
  let movedWriter=source.tableView?(table,pasteboardWriterForRow:bIndex) as? NSURL
  check(!admitted || movedWriter.map { ($0 as URL).standardizedFileURL }==renamed.standardizedFileURL,"Fresh drag resolves the original identity or refuses the replacement path")
  table.onFinishUnstartedDrag()
  for _ in 0..<4 {host.layoutSubtreeIfNeeded();try await Task.sleep(nanoseconds:5_000_000)}
  // Revoke before AppKit asks for its first writer; none may escape the lease.
  let folderIndex=store.rows.firstIndex{$0.item.path==folder.path}!
  table.selectRowIndexes(IndexSet(integer:folderIndex),byExtendingSelection:false)
  check(table.canDragRows(with:IndexSet(integer:folderIndex),at:point),"Final intact candidate can prepare normally")
  store.setVisible(false)
  check(source.tableView?(table,pasteboardWriterForRow:folderIndex)==nil,"Leaving the page before publishing prevents a stale writer")
  table.onFinishUnstartedDrag();store.setAvailable(false)
  check(!table.canDragRows(with:IndexSet(integer:folderIndex),at:point),"Private/unavailable rejects a new drag even before view teardown")
  check(try Data(contentsOf:root.appendingPathComponent("archive/file-shelf.json"))==originalManifest,"Drag preparation, rejection and cancellation never rewrite the reference archive")
  check(try Data(contentsOf:b)==Data("REPLACEMENT".utf8) && Data(contentsOf:renamed)==Data("Synthetic B".utf8),"Drag inspection never changes replacement or original contents")
  check(!window.isVisible,"All checks use an unshown layout window, not a live GUI drag")
  print("PASS: \(checks) new native drag-contract checks; actual Finder drop and in-flight Escape remain unverified")
 }
}
