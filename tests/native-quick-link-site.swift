import AppKit
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String {en}

@MainActor final class SiteFixture {
    let store:NativeQuickLinksStore
    let directory:URL
    var data:[[String:Any]],groups:[[String:Any]],calls:[[String:Any]]=[]
    var gate:CheckedContinuation<Void,Never>?,delay=false,fail=false
    var listGate:CheckedContinuation<Void,Never>?,delayList=false,failList=false
    init(_ name:String,root:URL,source:[String:Any]) throws {
        directory=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        store=NativeQuickLinksStore();data=source["rows"] as! [[String:Any]];groups=source["groups"] as! [[String:Any]]
        bind(store)
    }
    func bind(_ s:NativeQuickLinksStore) {
        s.configure(directory:directory,request:{[unowned self] in try await self.request($0)},openSource:{_ in true},openURL:{_ in true})
        s.setAvailable(true);s.setVisible(true)
    }
    func request(_ p:[String:Any]) async throws->[String:Any] {
        if p["action"] as? String=="list" {
            let q=p["query"] as? String ?? ""
            if delayList { await withCheckedContinuation { listGate=$0 } }
            if failList { throw CocoaError(.fileReadUnknown) }
            return ["status":"ready","rows":data.filter{q.isEmpty || ($0["title"] as! String).contains(q)},"groups":groups,"projects":[],"trash":[]]
        }
        calls.append(p)
        if delay {await withCheckedContinuation{gate=$0}}
        if fail {throw CocoaError(.fileWriteUnknown)}
        let id=p["requestId"] as! String
        if !data.contains(where:{$0["id"] as? String==id}) {
            data.append(["id":id,"title":p["title"]!,"url":p["url"]!,"site":NativeQuickLinkSitePolicy.host(p["url"] as! String)!,"folder":p["folder"]!,"workspace":p["workspace"]!,"projectId":p["projectId"]!,"projectTitle":"Project","version":"new-v1","createdAt":1,"hasContent":false,"order":9])
        }
        return ["status":"saved","requestId":id,"action":"add","ids":[id],"duplicate":false]
    }
    func edit(_ url:String="https://support.example.com/new") {
        store.beginNew();store.workspace="科研";store.projectID="p";store.url=url;store.title="Keep manual title"
    }
}

@main struct SiteChecks {
    @MainActor static func main() async throws {
        setbuf(stdout,nil);let root=URL(fileURLWithPath:CommandLine.arguments[1]);var count=0
        func check(_ value:Bool,_ text:String){precondition(value,text);count+=1;print("PASS \(count): "+text)}
        func wait(_ p:()->Bool) async {for _ in 0..<500{if p(){return};try? await Task.sleep(nanoseconds:1_000_000)};preconditionFailure("wait timed out")}
        let vectors:[(String,String?)]=[
            ("https://docs.example.com/a","example.com"),("https://NEWS.example.com/b?x=1#part","example.com"),
            ("https://www.example.com./","example.com"),("example.com/docs","example.com"),
            ("https://docs.example.co.uk/","example.co.uk"),("https://news.example.co.uk/","example.co.uk"),
            ("https://alice.github.io/","alice.github.io"),("https://docs.alice.github.io/","alice.github.io"),
            ("https://bob.github.io/","bob.github.io"),("https://github.io/","github.io"),
            ("https://alice.vercel.app/","alice.vercel.app"),("https://bob.vercel.app/","bob.vercel.app"),
            ("https://a.example.unlisted/","a.example.unlisted"),("https://b.example.unlisted/","b.example.unlisted"),
            ("https://alpha.unlisted.jp/","alpha.unlisted.jp"),("https://alice.appspot.com/","alice.appspot.com"),
            ("https://example.com.evil.net/","evil.net"),("https://evil-example.com/","evil-example.com"),
            ("https://user:secret@example.com/",nil),("file:///tmp/example.com",nil),("https://127.0.0.1/",nil),
            ("https://host.local/",nil),("https://example..com/",nil),("javascript:alert(1)",nil)]
        for (url,expected) in vectors {check(NativeQuickLinkSitePolicy.siteKey(for:url)==expected,"site policy "+url.replacingOccurrences(of:"user:secret@",with:"[credential]@"))}
        let source=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("bridge.json"))) as! [String:Any]
        let f=try SiteFixture("main",root:root,source:source);await f.store.refresh();f.edit()
        check(f.store.siteGroupSuggestions.map(\.folder)==["Reading"],"only the unique related-site folder in this exact workspace/project is suggested")
        check(f.store.folder=="Reading" && f.calls.isEmpty,"a unique same-project folder fills only the fresh unsaved form without a write")
        let original=f.store.siteGroupSuggestions[0];f.store.folder="My manual folder";f.store.url="https://news.example.com/next";await f.store.refresh()
        check(f.store.folder=="My manual folder" && f.store.title=="Keep manual title","URL changes and refreshed suggestions preserve manual fields")
        check(f.store.useSiteGroupSuggestion(original) && f.store.folder=="Reading" && f.store.projectID=="p" && f.store.workspace=="科研","explicit use fills only the current folder")
        f.store.toggleGroup(original.id);let unchanged=f.data;await f.store.saveEditor();let payload=f.calls.last!
        check(payload["folder"] as? String=="Reading" && payload["title"] as? String=="Keep manual title" && payload["projectId"] as? String=="p","existing durable add receives the exact manually accepted scope")
        check(f.store.pending==nil && !f.store.editing && f.data.dropLast().elementsEqual(unchanged,by:{NSDictionary(dictionary:$0)==NSDictionary(dictionary:$1)}),"confirmed add never migrates or rewrites existing links")
        check(f.store.focusedRecordID==payload["requestId"] as? String && !f.store.isGroupCollapsed(original.id),"confirmed add reveals its same-site folder and record without a keyboard-focus call")
        f.store.clearRecordFocus();check(f.store.isGroupCollapsed(original.id),"revealing a saved link does not overwrite the user's collapsed-folder preference")
        try JSONSerialization.data(withJSONObject:payload,options:.sortedKeys).write(to:root.appendingPathComponent("add.json"))

        let automatic=try SiteFixture("automatic",root:root,source:source);await automatic.store.refresh();automatic.edit()
        automatic.store.url="https://alice.github.io/new";check(automatic.store.folder=="Personal","URL changes recompute the unique folder while the fresh form remains unassigned")
        automatic.store.url="https://unknown.invalid/";check(automatic.store.folder=="链接收藏","no candidate clears the previous automatic folder instead of leaving a wrong destination")
        automatic.store.url="https://news.example.com/";automatic.store.projectID="p2";check(automatic.store.folder=="Elsewhere" && automatic.store.projectID=="p2","project changes only consider the newly selected project")
        automatic.store.projectID="p";automatic.store.folder="Reading";automatic.store.url="https://alice.github.io/new";check(automatic.store.folder=="Reading","even explicitly re-entering the current folder locks the manual choice")
        let scoped=try SiteFixture("scoped",root:root,source:source);await scoped.store.refresh();let scopedGroup=scoped.store.groups.first{$0.folder=="Reading" && $0.projectId=="p"}!;scoped.store.beginNew(in:scopedGroup);scoped.store.url="https://alice.github.io/new"
        check(scoped.store.folder=="Reading" && scoped.store.projectID=="p","adding inside an existing folder locks the human-selected scope")
        let draft=try SiteFixture("restored",root:root,source:source);await draft.store.refresh();draft.edit();_=draft.store.flushDraft();let draftStore=NativeQuickLinksStore();draft.bind(draftStore);await draftStore.refresh();draftStore.url="https://alice.github.io/new"
        check(draftStore.folder=="Reading","a restored draft keeps its saved folder even if the previous process auto-filled it")
        let late=try SiteFixture("late",root:root,source:source);late.edit();check(late.store.folder=="链接收藏","a new form waits for a complete current projection before auto-filling");await late.store.refresh();check(late.store.folder=="Reading","a complete refresh can fill a still-unassigned fresh form")
        late.store.folder="My manual folder";await late.store.refresh();check(late.store.folder=="My manual folder","a late refresh cannot overwrite manual folder input")

        let delayed=try SiteFixture("delayed",root:root,source:source);delayed.edit();delayed.delayList=true
        let refresh=Task{await delayed.store.refresh()};await wait{delayed.listGate != nil};delayed.store.projectID="p2";delayed.listGate?.resume();delayed.listGate=nil;await refresh.value
        check(delayed.store.folder=="Elsewhere" && delayed.store.projectID=="p2","a delayed full projection derives the current project rather than the request-time project")
        let manualRefresh=Task{await delayed.store.refresh()};await wait{delayed.listGate != nil};delayed.store.folder="Manual while loading";delayed.listGate?.resume();delayed.listGate=nil;await manualRefresh.value
        check(delayed.store.folder=="Manual while loading","an async refresh cannot replace a folder entered while it was pending")
        let revoked=try SiteFixture("revoked",root:root,source:source);revoked.edit();revoked.delayList=true
        let privateRefresh=Task{await revoked.store.refresh()};await wait{revoked.listGate != nil};revoked.store.setAvailable(false);revoked.listGate?.resume();revoked.listGate=nil;await privateRefresh.value
        check(revoked.store.folder=="链接收藏" && revoked.store.rows.isEmpty && revoked.store.siteGroupSuggestions.isEmpty,"revocation discards a delayed projection and prevents automatic folder assignment")

        let failedRefresh=try SiteFixture("failed-refresh",root:root,source:source);await failedRefresh.store.refresh();failedRefresh.edit();failedRefresh.failList=true;await failedRefresh.store.refresh();failedRefresh.store.url="https://alice.github.io/"
        check(failedRefresh.store.folder=="Reading" && failedRefresh.store.siteGroupSuggestions.isEmpty,"a failed refresh does not reuse a stale projection to reassign the unsaved folder")

        let multiple=try SiteFixture("multiple",root:root,source:source)
        var row=multiple.data.first{$0["id"] as? String=="a"}!;row["id"]="another";row["folder"]="Alternative";row["url"]="https://news.example.com/other";row["site"]="news.example.com";multiple.data.append(row)
        var group=multiple.groups.first{$0["folder"] as? String=="Reading" && $0["projectId"] as? String=="p"}!;group["id"]="科研\u{1f}p\u{1f}Alternative";group["folder"]="Alternative";group["linkIDs"]=["another"];multiple.groups.append(group)
        await multiple.store.refresh();multiple.edit()
        check(Set(multiple.store.siteGroupSuggestions.map(\.folder))==["Reading","Alternative"] && multiple.store.folder=="链接收藏","multiple groups remain explicit choices and never use first-match auto assignment")
        multiple.store.url="https://alice.github.io/new";check(multiple.store.folder=="Personal","a fresh form can leave an ambiguous site for a unique candidate");multiple.store.url="https://news.example.com/";check(multiple.store.folder=="链接收藏","returning to multiple candidates does not retain the previous site's automatic folder")
        let alternative=multiple.store.siteGroupSuggestions.first{$0.folder=="Alternative"}!
        check(multiple.store.useSiteGroupSuggestion(alternative) && multiple.store.folder=="Alternative","the user can choose the second candidate")
        multiple.store.url="https://different.org/";check(!multiple.store.useSiteGroupSuggestion(alternative),"a menu from a previous URL cannot apply")
        multiple.store.url="https://news.example.com/";multiple.store.projectID="p2";check(!multiple.store.useSiteGroupSuggestion(alternative),"changing project rejects a stale suggestion instead of switching scope")
        multiple.store.projectID="p";multiple.store.query="unmatched";await multiple.store.refresh();check(multiple.store.siteGroupSuggestions.isEmpty,"filtered rows cannot claim a complete same-site candidate set")
        multiple.store.query="";check(multiple.store.siteGroupSuggestions.isEmpty,"cleared query still waits for its complete projection")
        await multiple.store.refresh();let stale=multiple.store.siteGroupSuggestions[0]
        let index=multiple.groups.firstIndex{$0["id"] as? String==stale.id}!;multiple.groups[index]["version"]="v2";await multiple.store.refresh()
        check(!multiple.store.useSiteGroupSuggestion(stale),"a changed folder version rejects a menu captured before refresh")
        multiple.groups[index]["blockedReason"]="folder_protected";await multiple.store.refresh()
        check(!multiple.store.siteGroupSuggestions.contains{$0.id==stale.id},"protected or ambiguous groups do not reveal a destination suggestion")
        let other=multiple.store.siteGroupSuggestions.first!;multiple.store.setVisible(false);check(!multiple.store.useSiteGroupSuggestion(other),"a hidden island cannot apply a captured choice")
        multiple.store.setVisible(true);multiple.store.setAvailable(false);check(multiple.store.siteGroupSuggestions.isEmpty && !multiple.store.useSiteGroupSuggestion(other),"private withdrawal removes suggestions and rejects their callbacks")

        let retry=try SiteFixture("retry",root:root,source:source);await retry.store.refresh();retry.edit();_=retry.store.useSiteGroupSuggestion(retry.store.siteGroupSuggestions[0]);retry.delay=true;retry.fail=true
        let save=Task{await retry.store.saveEditor()};await wait{retry.gate != nil}
        check(retry.store.siteGroupSuggestions.isEmpty && !retry.store.useSiteGroupSuggestion(original),"pending save cannot alter destination or reuse a suggestion")
        retry.gate?.resume();retry.gate=nil;await save.value
        let savedPending=retry.store.pending;check(savedPending != nil && retry.store.folder=="Reading","unknown ACK keeps exact pending add and the accepted folder draft")
        let restored=NativeQuickLinksStore();retry.bind(restored);check(restored.pending==savedPending && restored.folder=="Reading","restart retains accepted folder and original immutable add")
        retry.delay=false;retry.fail=false;await restored.retry()
        check(restored.pending==nil && retry.calls.count==2 && NSDictionary(dictionary:retry.calls[0])==NSDictionary(dictionary:retry.calls[1]),"retry uses the same request and scope rather than recomputing suggestions")

        let hidden=try SiteFixture("hidden",root:root,source:source);await hidden.store.refresh();hidden.edit();let destination=hidden.store.siteGroupSuggestions[0];_=hidden.store.useSiteGroupSuggestion(destination);hidden.store.toggleGroup(destination.id);hidden.delay=true
        let hiddenSave=Task{await hidden.store.saveEditor()};await wait{hidden.gate != nil};hidden.store.setVisible(false);hidden.store.setVisible(true);hidden.gate?.resume();hidden.gate=nil;await hiddenSave.value
        check(hidden.store.pending==nil && hidden.store.focusedRecordID==nil && hidden.store.isGroupCollapsed(destination.id),"a save finishing after hide/reopen does not reopen the old folder or restore focus")

        let interacted=try SiteFixture("interacted",root:root,source:source);await interacted.store.refresh();interacted.edit();let recentGroup=interacted.store.siteGroupSuggestions[0];_=interacted.store.useSiteGroupSuggestion(recentGroup);interacted.delay=true
        let interactionSave=Task{await interacted.store.saveEditor()};await wait{interacted.gate != nil};interacted.store.toggleGroup(recentGroup.id);interacted.gate?.resume();interacted.gate=nil;await interactionSave.value
        check(interacted.store.pending==nil && interacted.store.focusedRecordID==nil && interacted.store.isGroupCollapsed(recentGroup.id),"a user collapse during save wins over the late saved-record reveal")

        let layout=try SiteFixture("layout",root:root,source:source);await layout.store.refresh();layout.store.groupBySite=true
        let members=layout.store.rows.filter{["a","b"].contains($0.id)}
        check(Set(members.map{layout.store.siteGroupID(for:$0)})==["example.com"],"site presentation merges related hosts without moving their records")
        layout.store.toggleGroup("example.com");let stateFile=layout.directory.appendingPathComponent("native-quick-links-view.json"),beforeRead=try Data(contentsOf:stateFile)
        check(layout.store.isGroupCollapsed("example.com"),"canonical site can be collapsed")
        let restoredLayout=NativeQuickLinksStore();layout.bind(restoredLayout);await restoredLayout.refresh()
        let restoredBytes=try Data(contentsOf:stateFile)
        check(restoredLayout.isGroupCollapsed("example.com") && restoredBytes==beforeRead,"merged site collapse survives restart without read-time preference migration")
        restoredLayout.query="Manual";check(!restoredLayout.isGroupCollapsed("example.com"),"search temporarily reveals site matches")
        let legacy=try SiteFixture("legacy",root:root,source:source)
        let legacyState:[String:Any]=["version":1,"groupBySite":true,"collapsedFolders":[],"collapsedSites":["docs.example.com","news.example.com"]]
        let legacyFile=legacy.directory.appendingPathComponent("native-quick-links-view.json");try JSONSerialization.data(withJSONObject:legacyState).write(to:legacyFile)
        let legacyStore=NativeQuickLinksStore();legacy.bind(legacyStore);await legacyStore.refresh();check(legacyStore.isGroupCollapsed("example.com"),"all formerly collapsed host groups stay collapsed in the merged site")
        legacyStore.toggleGroup("example.com");check(!legacyStore.isGroupCollapsed("example.com"),"one explicit toggle expands a legacy merged group without double-clicking")
        print("PASS: \(count) same-site grouping checks")
    }
}
