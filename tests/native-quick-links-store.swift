import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum Failure: Error { case failed(String) }
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws { if try !condition() { throw Failure.failed(message) } }
func row(_ id:String="source-1",title:String="Original") -> [String:Any] {
    ["id":id,"title":title,"url":"https://example.org/paper","site":"example.org","folder":"Research","workspace":"科研","projectId":"p","projectTitle":"Project","version":"v1","createdAt":1,"hasContent":true,"order":0]
}
func rowValue() throws -> NativeQuickLinkRow { try JSONDecoder().decode(NativeQuickLinkRow.self,from:JSONSerialization.data(withJSONObject:row())) }
func bookmarkValue() throws -> NativeQuickLinkRow {
    var value=row(); value["canFetch"]=true; value["hasContent"]=false; value["fetchStatus"]="idle"
    return try JSONDecoder().decode(NativeQuickLinkRow.self,from:JSONSerialization.data(withJSONObject:value))
}
func listed(_ rows:[[String:Any]]=[row()]) -> [String:Any] { ["status":"ready","rows":rows,"projects":[["id":"p","title":"Project","workspace":"科研"]],"trash":[]] }
func saved(_ payload:[String:Any]) -> [String:Any] {
    let ids=(payload["items"] as? [[String:Any]])?.compactMap{$0["id"] as? String} ?? [payload["requestId"] as! String]
    return ["status":"saved","requestId":payload["requestId"]!,"action":payload["action"]!,"ids":ids,"duplicate":false]
}
func pendingOnDisk(_ directory:URL) throws -> [String:Any]? {
    let data=try Data(contentsOf:directory.appendingPathComponent("native-quick-links-draft.json"))
    let draft=try JSONSerialization.jsonObject(with:data) as! [String:Any]
    guard let encoded=draft["pending"] as? String, let pending=Data(base64Encoded:encoded) else { return nil }
    return try JSONSerialization.jsonObject(with:pending) as? [String:Any]
}
@main struct LinkStoreChecks {
    @MainActor static func main() async {
        do {
            let name=CommandLine.arguments[1], directory=URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            try await run(name,directory); print("PASS: " + name)
        } catch { FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1) }
    }
    @MainActor static func configure(_ store:NativeQuickLinksStore,_ directory:URL,request:@escaping NativeQuickLinksStore.Request) {
        store.configure(directory:directory,request:request,openSource:{_ in true},openURL:{_ in true}); store.setAvailable(true)
    }
    @MainActor static func run(_ name:String,_ directory:URL) async throws {
        switch name {
        case "folder-draft-restart":
            let first=NativeQuickLinksStore();configure(first,directory,request:{_ in listed()});first.beginGroup();first.folder="Notes/Reading";first.workspace="科研";first.projectID="p"
            try check(first.canSave && first.flushForQuit(),"Named group draft is persisted")
            let second=NativeQuickLinksStore();configure(second,directory,request:{_ in listed()})
            try check(second.editingGroup && second.folder=="Notes/Reading" && second.projectID=="p" && second.canSave,"Group draft restores separately from link URL form")
        case "folder-create-exact-ack":
            let store=NativeQuickLinksStore();var mutations=0
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                mutations += 1;try check(try pendingOnDisk(directory)?["action"] as? String=="folder-create","Exact folder operation durable before mutation")
                return ["status":"saved","action":payload["action"]!,"requestId":payload["requestId"]!,"ids":[],"folderId":payload["requestId"]!,"groupId":"科研\u{1f}p\u{1f}Reading"]
            });store.beginGroup();store.folder="Reading";store.workspace="科研";store.projectID="p";await store.saveEditor()
            try check(mutations==1 && store.pending==nil && !store.editingGroup && !store.editing,"Empty-folder ACK needs a real folder ID, no fake import")
        case "folder-wrong-ack-retains":
            let store=NativeQuickLinksStore();configure(store,directory,request:{payload in
                ["status":"saved","action":payload["action"]!,"requestId":payload["requestId"]!,"ids":[],"folderId":"wrong","groupId":"Reading"]
            });store.beginGroup();store.folder="Reading";await store.saveEditor()
            try check(store.pending != nil && store.editingGroup && store.folder=="Reading","Wrong folder ACK preserves draft and envelope")
        case "folder-lost-ack-restart":
            let first=NativeQuickLinksStore();var requestID=""
            configure(first,directory,request:{payload in requestID=payload["requestId"] as? String ?? "";throw NativeQuickLinksError.unconfirmed })
            first.beginGroup();first.folder="Reading";await first.saveEditor()
            let second=NativeQuickLinksStore();configure(second,directory,request:{payload in
                if payload["action"] as? String=="list" {return listed()}
                try check(payload["requestId"] as? String==requestID,"Folder retry keeps ID after restart")
                return ["status":"saved","action":payload["action"]!,"requestId":payload["requestId"]!,"ids":[],"folderId":requestID,"groupId":"Reading"]
            });await second.retry();try check(second.pending==nil && !second.editing,"Lost folder ACK recovered")
        case "folder-rename-retains-collapse":
            let old=NativeQuickLinkGroup(id:"科研\u{1f}p\u{1f}Reading",folder:"Reading",workspace:"科研",projectId:"p",projectTitle:"Project",folderId:"folder-1",version:"v1",linkIDs:["source-1"],canRename:true,canDelete:false,blockedReason:"")
            let next="科研\u{1f}p\u{1f}Methods",store=NativeQuickLinksStore()
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                try check(payload["expectedVersion"] as? String=="v1","Whole group version included")
                return ["status":"saved","action":payload["action"]!,"requestId":payload["requestId"]!,"ids":["source-1"],"folderId":"folder-1","groupId":next,"previousGroupId":old.id]
            });store.toggleGroup(old.id);store.beginGroup(old);store.folder="Methods";await store.saveEditor()
            try check(store.isGroupCollapsed(next) && !store.isGroupCollapsed(old.id),"Renamed folder keeps its collapsed preference")
            let restarted=NativeQuickLinksStore();configure(restarted,directory,request:{_ in listed()});try check(restarted.isGroupCollapsed(next),"Collapse follows rename durably")
        case "folder-edit-preserves-link-draft":
            let store=NativeQuickLinksStore();configure(store,directory,request:{_ in listed()});store.beginNew();store.url="https://example.org/unsent";store.beginGroup()
            try check(!store.editingGroup && store.url=="https://example.org/unsent","New folder cannot overwrite active link input")
        case "folder-drop-to-empty":
            let group=NativeQuickLinkGroup(id:"科研\u{1f}p\u{1f}Empty",folder:"Empty",workspace:"科研",projectId:"p",projectTitle:"Project",folderId:"folder-1",version:"g1",linkIDs:[],canRename:true,canDelete:true,blockedReason:"")
            let sourceGroup=NativeQuickLinkGroup(id:"科研\u{1f}p\u{1f}Research",folder:"Research",workspace:"科研",projectId:"p",projectTitle:"Project",folderId:nil,version:"s1",linkIDs:["source-1"],canRename:true,canDelete:false,blockedReason:"")
            let store=NativeQuickLinksStore();var writes=0,storedRow=row()
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" {
                    var result=listed([storedRow])
                    var liveGroups=try JSONSerialization.jsonObject(with:JSONEncoder().encode([sourceGroup,group])) as! [[String:Any]]
                    if writes>0 {
                        liveGroups[0]["linkIDs"]=[];liveGroups[0]["version"]="s2"
                        liveGroups[1]["linkIDs"]=["source-1"];liveGroups[1]["version"]="g2"
                    }
                    result["groups"]=liveGroups;return result
                }
                writes += 1;let items=payload["items"] as! [[String:Any]],patch=items[0]["patch"] as! [String:Any]
                try check(items.count==1 && items[0]["id"] as? String=="source-1" && patch["folder"] as? String=="Empty","Drop changes the same link's real folder")
                try check((payload["destination"] as? [String:Any])?["expectedVersion"] as? String=="g1","Drop validates current destination")
                for (key,value) in patch {storedRow[key]=value};storedRow["version"]="v2"
                return saved(payload)
            });await store.refresh();await store.move(try rowValue(),to:group)
            try check(writes==1 && store.pending==nil,"Move uses one confirmed source update")
            try check(store.rows.count==1 && store.rows[0].folder=="Empty" && store.rows[0].version=="v2","Confirmed move refreshes the original source from the bridge")
            let current=store.rows[0],returnGroup=store.groups.first(where:{$0.id==sourceGroup.id})!
            store.query="filtered";await store.move(current,to:returnGroup);try check(writes==1,"Filtered lists cannot silently reorder missing records")
        case "layout-restart-and-search":
            let first=NativeQuickLinksStore(); var mutations=0
            configure(first,directory,request:{payload in if payload["action"] as? String != "list" { mutations += 1 }; return listed() })
            first.toggleGroup("shared-name"); first.groupBySite=true
            try check(!first.isGroupCollapsed("shared-name"),"Folder and site namespaces are independent")
            first.toggleGroup("example.org")
            let second=NativeQuickLinksStore(); configure(second,directory,request:{_ in listed() })
            try check(second.groupBySite && second.isGroupCollapsed("example.org"),"Site grouping and collapse survive a fresh store")
            second.groupBySite=false
            try check(second.isGroupCollapsed("shared-name"),"Folder collapse retained across grouping switches")
            second.query="a matching title"; try check(!second.isGroupCollapsed("shared-name"),"Search reveals matching groups")
            second.toggleGroup("shared-name"); second.query=""
            try check(second.isGroupCollapsed("shared-name"),"Search does not overwrite saved collapse")
            second.setAvailable(false); second.toggleGroup("shared-name"); second.setAvailable(true)
            try check(second.isGroupCollapsed("shared-name") && mutations==0,"Privacy transition retains local layout without record mutation")
            let attributes=try FileManager.default.attributesOfItem(atPath:directory.appendingPathComponent("native-quick-links-view.json").path)
            try check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,"Layout file is owner-only")
        case "layout-owner-isolation":
            let first=NativeQuickLinksStore(); configure(first,directory,request:{_ in listed() }); first.toggleGroup("folder")
            let other=NativeQuickLinksStore(); configure(other,directory.appendingPathComponent("other"),request:{_ in listed() })
            try check(!other.isGroupCollapsed("folder"),"No layout leaking to another workspace")
        case "layout-corrupt-preserved":
            let file=directory.appendingPathComponent("native-quick-links-view.json"), original=Data("{\"version\":99}".utf8)
            try original.write(to:file)
            let store=NativeQuickLinksStore(); configure(store,directory,request:{_ in listed() }); store.toggleGroup("folder"); await store.refresh()
            try check(store.viewStateError != nil && store.rows.count==1 && (try Data(contentsOf:file))==original,"Unreadable layout preserves file and does not disable library")
        case "layout-save-failure-isolated":
            let store=NativeQuickLinksStore(write:{data,file in
                if file.lastPathComponent=="native-quick-links-view.json" { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to:file,options:.atomic)
            }); configure(store,directory,request:{_ in listed() }); store.toggleGroup("folder")
            store.beginNew(); store.url="https://example.org/retained"
            try check(store.viewStateError != nil && store.flushForQuit(),"Layout write error is visible but cannot block a saved editor draft")
        case "offline-draft-restart":
            let first=NativeQuickLinksStore(); configure(first,directory,request:{_ in listed()}); first.beginNew(); first.url="https://example.org/offline"; first.title="An idea"; first.workspace="科研"; first.projectID="p"; try check(first.flushForQuit(),"Draft flush")
            let second=NativeQuickLinksStore(); configure(second,directory,request:{_ in listed()}); try check(second.url==first.url && second.title==first.title && second.projectID=="p","Restored all input"); try check(second.hasUnsettledEditor,"Unsaved edit tracked")
        case "envelope-before-request":
            let store=NativeQuickLinksStore(); var requestCount=0
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                requestCount += 1; let pending=try pendingOnDisk(directory); try check(pending?["requestId"] as? String == payload["requestId"] as? String,"Envelope durable before request"); return saved(payload)
            }); store.beginNew(); store.url="https://example.org"; await store.saveEditor()
            try check(requestCount==1 && store.pending==nil && !store.editing,"Save acknowledged"); try check(try pendingOnDisk(directory)==nil,"Disk envelope cleared after ACK")
        case "lost-ack-restart":
            let first=NativeQuickLinksStore(); var firstID=""
            configure(first,directory,request:{payload in firstID=payload["requestId"] as? String ?? ""; throw NativeQuickLinksError.unconfirmed }); first.beginNew(); first.url="https://example.org"; await first.saveEditor()
            try check(first.pending != nil,"Envelope retained")
            let second=NativeQuickLinksStore(); var retryID=""
            configure(second,directory,request:{payload in if payload["action"] as? String=="list" { return listed() }; retryID=payload["requestId"] as? String ?? ""; return saved(payload) }); await second.retry()
            try check(!firstID.isEmpty && firstID==retryID && second.pending==nil,"Same request after restart")
        case "wrong-ack-retains":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in var result=saved(payload); result["requestId"]="another"; return result }); store.beginNew(); store.url="https://example.org"; await store.saveEditor()
            try check(store.pending != nil && store.url=="https://example.org" && store.error != nil,"Wrong ACK retains input")
        case "wrong-record-ack":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in var result=saved(payload); result["ids"]=["another-record"]; return result }); store.beginEditing(try rowValue()); store.title="Change"; await store.saveEditor()
            try check(store.pending != nil && store.title=="Change","Wrong record rejected")
        case "stale-version-retains":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in
                let item=(payload["items"] as! [[String:Any]])[0]; try check(item["expectedVersion"] as? String=="v1","Sends baseline version"); return ["status":"error","reason":"changed"]
            }); store.beginEditing(try rowValue()); store.title="Manual title"; await store.saveEditor(); try check(store.pending != nil && store.title=="Manual title","Conflict retains edit")
        case "disk-failure-no-request":
            var count=0; let store=NativeQuickLinksStore(write:{_,_ in throw CocoaError(.fileWriteOutOfSpace) }); configure(store,directory,request:{_ in count += 1; return listed() }); store.beginNew(); store.url="https://example.org"; await store.saveEditor()
            try check(count==0 && store.pending != nil && !store.flushForQuit(),"No request without disk envelope")
        case "disk-failure-after-ack":
            var failed=false; let store=NativeQuickLinksStore(write:{data,file in if failed { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to:file,options:.atomic) })
            configure(store,directory,request:{payload in failed=true; return saved(payload) }); store.beginNew(); store.url="https://example.org"; await store.saveEditor()
            try check(store.pending != nil && store.url=="https://example.org" && store.draftError != nil,"Pending cleanup failure retained")
            failed=false; try check(store.flushForQuit(),"Recover original pending"); try check(try pendingOnDisk(directory) != nil,"Disk same retry envelope")
        case "private-during-read":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{_ in store.setAvailable(false); return listed() }); await store.refresh(); try check(store.rows.isEmpty && store.projects.isEmpty,"Late read cannot leak private rows")
        case "private-during-save":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in store.setAvailable(false); return saved(payload) }); store.beginNew(); store.url="https://example.org"; await store.saveEditor()
            try check(store.rows.isEmpty && !store.available && store.notice==nil,"No late visible payload")
        case "owner-rebind":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{_ in listed() }); store.beginNew(); store.url="https://example.org"; _=store.flushDraft()
            configure(store,directory.appendingPathComponent("other"),request:{_ in throw Failure.failed("Must not use another owner") }); try check(!store.available && store.draftError != nil,"Owner binding retained")
        case "query-generation":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in
                if payload["query"] as? String=="old" { try await Task.sleep(nanoseconds:50_000_000); return listed([row("old")]) }
                return listed([row("new")])
            }); store.query="old"; let first=Task { await store.refresh() }; try await Task.sleep(nanoseconds:5_000_000); store.query="new"; await store.refresh(); await first.value; try check(store.rows.map(\.id)==["new"],"Old result never replaces new")
        case "corrupt-file-readonly":
            try Data("broken".utf8).write(to:directory.appendingPathComponent("native-quick-links-draft.json")); let store=NativeQuickLinksStore(); configure(store,directory,request:{_ in listed() }); store.beginNew()
            try check(!store.editing && store.draftError != nil && store.flushForQuit(),"Corrupt file preserved without quit deadlock")
        case "delete-keeps-pending-before-ack":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in try check(try pendingOnDisk(directory)?["action"] as? String=="remove","Delete journal durable"); return ["status":"error","reason":"storage_failed"] }); await store.remove([try rowValue()]); try check(store.pending != nil,"Pending remove retained")
        case "open-revalidates":
            let store=NativeQuickLinksStore(); var opened=0; store.configure(directory:directory,request:{_ in ["status":"error","reason":"private"] },openSource:{_ in opened += 1; return true},openURL:{_ in opened += 1; return true}); store.setAvailable(true); await store.open(try rowValue()); try check(opened==0,"Stale private URL never opens")
        case "fetch-journal-and-status":
            let store=NativeQuickLinksStore(); var count=0
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                count += 1; try check(store.fetchingID=="source-1","Only the fetching row is marked")
                try check(try pendingOnDisk(directory)?["action"] as? String=="fetch","Fetch envelope durable before external request")
                var response=saved(payload); response["fetchStatus"]="ready"; response["hasText"]=true; return response
            }); await store.fetchContent(try bookmarkValue())
            try check(count==1 && store.pending==nil && store.fetchingID==nil && store.notice != nil,"Fetch ACK clears pending and shows saved content")
        case "fetch-failed-clears-envelope":
            let store=NativeQuickLinksStore()
            configure(store,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                var response=saved(payload); response["fetchStatus"]="failed"; response["fetchError"]="Offline; bookmark retained"; return response
            }); await store.fetchContent(try bookmarkValue())
            try check(store.pending==nil && store.error=="Offline; bookmark retained" && store.notice==nil,"Acknowledged failure offers a new manual retry without false success")
            try check(try pendingOnDisk(directory)==nil,"Failure ACK clears only operation envelope")
        case "fetch-lost-ack-restart":
            let first=NativeQuickLinksStore(); var firstID=""
            configure(first,directory,request:{payload in firstID=payload["requestId"] as? String ?? ""; throw NativeQuickLinksError.unconfirmed })
            await first.fetchContent(try bookmarkValue()); try check(first.pending != nil,"Fetch retry envelope retained")
            let second=NativeQuickLinksStore(); configure(second,directory,request:{payload in
                if payload["action"] as? String=="list" { return listed() }
                try check(payload["requestId"] as? String==firstID,"Restored exact fetch request")
                var response=saved(payload); response["fetchStatus"]="ready"; response["hasText"]=false; return response
            }); await second.retry(); try check(second.pending==nil,"Recovered exact fetch receipt")
        case "fetch-wrong-status-retains":
            let store=NativeQuickLinksStore(); configure(store,directory,request:{payload in saved(payload) })
            await store.fetchContent(try bookmarkValue()); try check(store.pending != nil && store.error != nil,"Generic saved ACK cannot falsely confirm downloaded content")
        case "fetch-preserves-unsent-edit":
            let store=NativeQuickLinksStore(); var requests=0
            configure(store,directory,request:{_ in requests += 1; return listed() }); store.beginNew(); store.url="https://example.org/unsent"
            await store.fetchContent(try bookmarkValue()); try check(requests==0 && store.url=="https://example.org/unsent" && store.editing,"Fetch never destroys an unsent link editor")
        default: throw Failure.failed("Unknown scenario")
        }
    }
}
