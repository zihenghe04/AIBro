import Foundation
import AppKit
func nativeUI(_ zh:String,_ en:String)->String {en}
@MainActor final class Fixture {
    let directory: URL
    let store: NativeQuickLinksStore
    var calls: [[String:Any]] = []
    var rows: [[String:Any]] = []
    var listFailure=false, addFailure=false, metadataFailure=false, metadataRejected=false, duplicate=false, savingFailure=false
    var listHook: (() -> Void)?
    var metadataHook: (() -> Void)?
    init(_ root:URL,_ name:String) throws {
        directory=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        store=NativeQuickLinksStore()
        configure()
    }
    func configure(){store.configure(directory:directory,request:{[unowned self] in try await self.request($0)},openSource:{_ in true},openURL:{_ in true});store.setAvailable(true);store.setVisible(true)}
    func request(_ payload:[String:Any]) async throws -> [String:Any] {
        calls.append(payload);let action=payload["action"] as? String ?? ""
        if action=="list" {
            listHook?()
            if listFailure {throw NativeQuickLinksError.unavailable}
            let q=payload["query"] as? String ?? "",matches=q.isEmpty ? rows:rows.filter{($0["title"] as? String ?? "").contains(q)}
            return ["status":"ready","rows":matches,"groups":[],"projects":[],"trash":[]]
        }
        let id=payload["requestId"] as! String
        let disk=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("native-quick-links-draft.json"))) as! [String:Any]
        precondition(disk["pending"] != nil,"actual durable pending precedes every mutation")
        if action=="add" {
            let rowID=duplicate ? "existing":id
            if !rows.contains(where:{$0["id"] as? String==rowID}) {
                rows.append(["id":rowID,"title":payload["title"] as? String ?? "","url":(payload["url"] as! String).contains("://") ? payload["url"]! : "https://" + (payload["url"] as! String),"site":"example.org","folder":payload["folder"]!,"workspace":payload["workspace"]!,"projectId":payload["projectId"]!,"projectTitle":"","version":"v1","createdAt":1,"hasContent":false,"order":0])
            }
            if addFailure {throw NativeQuickLinksError.unconfirmed}
            return ["status":"saved","action":"add","requestId":id,"ids":[rowID],"duplicate":duplicate]
        }
        let ids=(payload["items"] as? [[String:Any]] ?? []).compactMap{$0["id"] as? String}
        if action=="metadata" {
            metadataHook?()
            if metadataFailure {throw NativeQuickLinksError.unconfirmed}
            return ["status":"saved","action":action,"requestId":id,"ids":ids,"metadataStatus":metadataRejected ? "failed":"ready","metadataError":"Synthetic offline error","iconStatus":"ready","hasMetadata":true]
        }
        return ["status":"saved","action":action,"requestId":id,"ids":ids,"duplicate":false]
    }
    var metadataCount:Int {calls.filter{$0["action"] as? String=="metadata"}.count}
    func add(_ url:String="https://example.org/paper",title:String="Human heading") async {
        store.beginNew();store.url=url;store.title=title;store.folder="Reading";store.workspace="科研";store.projectID="p";await store.saveEditor()
    }
}
@main struct Checks {
 @MainActor static func main() async throws {
    let root=URL(fileURLWithPath:CommandLine.arguments[1]);var count=0
    func check(_ condition:Bool,_ label:String)throws{guard condition else{throw NSError(domain:label,code:1)};count+=1;print("PASS \(label)")}
    let off=try Fixture(root,"off");await off.add()
    try check(!off.store.automaticMetadata && off.metadataCount==0 && off.rows.count==1,"default-off new link saves locally without metadata request")
    off.store.setAutomaticMetadata(true);await off.store.refresh()
    try check(off.metadataCount==0,"enabling preference and refreshing never backfills existing records")
    await off.add("https://example.org/new")
    try check(off.metadataCount==1 && off.store.pending==nil && off.store.notice?.contains("icon saved") == true,"new link durable ACK then one metadata receipt completes visible workflow")
    let request=off.calls.first{$0["action"] as? String=="metadata"}!,item=(request["items"] as! [[String:Any]])[0]
    try check(Set(item.keys)==["id","expectedVersion"] && item["expectedVersion"] as? String=="v1","automatic request reuses exact ID/version CAS without title/body/scope patch")
    try check(off.rows.last?["title"] as? String=="Human heading" && off.rows.last?["folder"] as? String=="Reading" && off.rows.last?["projectId"] as? String=="p","automatic dispatch retains human fields and project destination")
    let restarted=NativeQuickLinksStore();restarted.configure(directory:off.directory,request:{_ in throw NativeQuickLinksError.unavailable},openSource:{_ in true},openURL:{_ in true});restarted.setAvailable(true)
    try check(restarted.automaticMetadata,"explicit local opt-in persists across a new store")
    await off.store.refresh();try check(off.metadataCount==1,"completed automatic request is not repeated on refresh")
    off.store.beginEditing(off.store.rows[0]);off.store.title="Edited";await off.store.saveEditor()
    try check(off.metadataCount==1,"editing an existing link never triggers automatic metadata")
    let dup=try Fixture(root,"duplicate");dup.duplicate=true;dup.store.setAutomaticMetadata(true);await dup.add()
    try check(dup.metadataCount==0,"duplicate-add ACK cannot cause a background network request")
    for (name,mutation) in [("hide",{(s:NativeQuickLinksStore) in s.setVisible(false)}),("private",{s in s.setAvailable(false)}),("disable",{s in s.setAutomaticMetadata(false)}),("hide-reopen",{s in s.setVisible(false);s.setVisible(true)})] {
        let f=try Fixture(root,name);f.store.setAutomaticMetadata(true);f.listHook={mutation(f.store)};await f.add()
        try check(f.metadataCount==0,"\(name) during add refresh invalidates the automatic continuation")
        f.listHook=nil;f.store.setAvailable(true);f.store.setVisible(true);await f.store.refresh()
        try check(f.metadataCount==0,"\(name) restoration does not retry hidden automatic work")
    }
    let lost=try Fixture(root,"lost-add");lost.store.setAutomaticMetadata(true);lost.addFailure=true;await lost.add();let pending=lost.store.pending
    try check(pending != nil && lost.metadataCount==0,"unconfirmed bookmark save never dispatches website request")
    lost.addFailure=false;await lost.store.retry()
    try check(lost.store.pending==nil && lost.metadataCount==0,"explicit retry recovers only its original add operation, not a new automatic fetch")
    let filtered=try Fixture(root,"filtered");filtered.store.setAutomaticMetadata(true);filtered.store.query="different";await filtered.add()
    try check(filtered.metadataCount==1 && filtered.store.query=="different" && filtered.store.rows.isEmpty,"searched-out new record resolves current version without clearing the search")
    let failed=try Fixture(root,"metadata-failure");failed.store.setAutomaticMetadata(true);failed.metadataFailure=true;await failed.add();let original=failed.store.pending
    try check(original != nil && failed.rows.count==1 && failed.store.error != nil,"metadata failure retains saved bookmark and exact explicit retry envelope")
    await failed.store.refresh()
    try check(failed.metadataCount==1 && failed.store.pending==original && failed.store.error != nil,"refresh never retries metadata or hides its unconfirmed write error")
    failed.metadataFailure=false;await failed.store.retry()
    try check(failed.metadataCount==2 && failed.store.pending==nil,"manual retry settles metadata using existing durable protocol")
    let bare=try Fixture(root,"normalized-url");bare.store.setAutomaticMetadata(true);await bare.add("example.org/no-scheme")
    try check(bare.metadataCount==1,"eligibility uses bridge-normalized saved URL so pasted domains work")
    let late=try Fixture(root,"private-in-metadata");late.store.setAutomaticMetadata(true);late.metadataHook={late.store.setAvailable(false)};await late.add()
    try check(late.metadataCount==1 && late.store.pending != nil && late.store.rows.isEmpty && late.store.notice==nil && late.store.error==nil,"private after request dispatch rejects native late receipt and preserves explicit retry")
    late.metadataHook=nil;late.store.setAvailable(true);await late.store.refresh()
    try check(late.metadataCount==1,"leaving private mode never automatically resumes the retained request")
    let rejected=try Fixture(root,"failed-metadata-receipt");rejected.store.setAutomaticMetadata(true);rejected.metadataRejected=true;await rejected.add()
    try check(rejected.store.pending==nil && rejected.store.error=="Synthetic offline error","durable failed metadata receipt stays a visible failed attempt")
    await rejected.store.refresh()
    try check(rejected.store.error=="Synthetic offline error" && rejected.metadataCount==1,"successful list refresh does not relabel metadata failure as success")
    let read=try Fixture(root,"read-error");read.listFailure=true;await read.store.refresh()
    try check(read.store.refreshError != nil && read.store.error==nil,"read-list failure has its own error channel")
    read.listFailure=false;await read.store.refresh()
    try check(read.store.refreshError==nil,"successful refresh removes obsolete read-list error")
    let oldDir=root.appendingPathComponent("old-setting");try FileManager.default.createDirectory(at:oldDir,withIntermediateDirectories:true)
    try Data(#"{"version":1,"groupBySite":true,"collapsedFolders":["folder"],"collapsedSites":[]}"#.utf8).write(to:oldDir.appendingPathComponent("native-quick-links-view.json"))
    let old=NativeQuickLinksStore();old.configure(directory:oldDir,request:{_ in [:]},openSource:{_ in true},openURL:{_ in true});old.setAvailable(true)
    try check(!old.automaticMetadata && old.groupBySite && old.viewStateError==nil,"old settings decode with opt-in off and existing grouping retained")
    var failWrite=true
    let pref=NativeQuickLinksStore(write:{data,file in if failWrite && file.lastPathComponent=="native-quick-links-view.json"{throw CocoaError(.fileWriteUnknown)};try data.write(to:file,options:.atomic)})
    pref.configure(directory:root.appendingPathComponent("failed-setting"),request:{_ in [:]},openSource:{_ in true},openURL:{_ in true});pref.setAvailable(true)
    pref.setAutomaticMetadata(true)
    try check(!pref.automaticMetadata && pref.viewStateError != nil,"failed opt-in persistence cannot silently enable network")
    failWrite=false;pref.setAutomaticMetadata(true);failWrite=true;pref.setAutomaticMetadata(false)
    try check(!pref.automaticMetadata && pref.viewStateError != nil,"turning off takes effect in memory even if preference save fails")
    for url in ["http://localhost/x","http://127.0.0.1/x","https://192.168.1.1/x","http://[::1]/","https://site.local/a","https://user:pass@example.org/x","file:///tmp/a","https://private.internal/a"] {
        try check(!NativeQuickLinksStore.permitsAutomaticMetadata(url),"no automatic dispatch for \(url)")
    }
    try check(NativeQuickLinksStore.permitsAutomaticMetadata("https://example.org/a") && NativeQuickLinksStore.permitsAutomaticMetadata("http://example.com/a"),"ordinary public hostname URLs can use backend public-DNS validation")
    try check(NSApp==nil,"tests use no GUI, networking, permissions, user sources or clipboard")
    print("PASS \(count) automatic metadata checks")
 }
}
