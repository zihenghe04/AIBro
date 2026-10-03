import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum CheckFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw CheckFailure.failed(message) }
}
func fileAt(_ directory: URL) -> URL { directory.appendingPathComponent("native-quick-capture-library-drafts.json") }
func objectAt(_ file: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as? [String:Any] else { throw CheckFailure.failed("Expected saved JSON") }
    return value
}
func draftsAt(_ file: URL) throws -> [String: Any] { try objectAt(file)["drafts"] as? [String:Any] ?? [:] }
func pendingAt(_ file: URL, _ id: String = "capture-1") throws -> NativeQuickCaptureLibraryEdit? {
    guard let row = try draftsAt(file)[id] as? [String:Any], let pending = row["pending"] else { return nil }
    return try JSONDecoder().decode(NativeQuickCaptureLibraryEdit.self,from:JSONSerialization.data(withJSONObject:pending))
}
func note(_ id: String = "capture-1", text: String = "Original capture", version: Double = 10, tags: [String] = ["research"], title: String? = nil) -> [String:Any] {
    ["id":id,"title":title ?? text.components(separatedBy:"\n").first ?? "Capture","excerpt":String(text.prefix(160)),"content":text,"tags":tags,"createdAt":1.0,"updatedAt":version,"attachments":[],"derived":[],"recordVersion":"sha256:full-record-\(version)"]
}
func edit(_ payload: [String:Any]) throws -> NativeQuickCaptureLibraryEdit {
    try JSONDecoder().decode(NativeQuickCaptureLibraryEdit.self,from:JSONSerialization.data(withJSONObject:payload))
}
func saved(_ value: NativeQuickCaptureLibraryEdit) -> [String:Any] {
    ["status":"saved","id":value.id,"requestId":value.requestId,"version":value.expectedVersion + 1,
     "note":note(value.id,text:value.text,version:value.expectedVersion + 1,tags:value.tags,title:value.title)]
}
func ready(_ value: [String:Any] = note()) -> [String:Any] { ["status":"ready","note":value] }
func listed(_ values: [[String:Any]]) -> [String:Any] { ["status":"ready","rows":values,"total":values.count] }
func lifecycleAt(_ file: URL) throws -> NativeQuickCaptureLibraryLifecycle? {
    guard let pending = try objectAt(file)["lifecycle"] else { return nil }
    return try JSONDecoder().decode(NativeQuickCaptureLibraryLifecycle.self,from:JSONSerialization.data(withJSONObject:pending))
}
func lifecycleSaved(_ payload: [String:Any]) -> [String:Any] {
    ["status":"saved","action":payload["action"]!,"requestId":payload["requestId"]!,"id":payload["id"] ?? "capture-1","trashId":payload["trashId"] ?? "trash-1"]
}
func trashEntry() -> NativeQuickCaptureLibraryTrash { .init(id:"trash-1",title:"My capture",deletedAt:20,version:"sha256:trash-1") }
func trashed(_ entries: [NativeQuickCaptureLibraryTrash]) throws -> [String:Any] {
    ["status":"ready","trash":try JSONSerialization.jsonObject(with:JSONEncoder().encode(entries))]
}

@main struct LibraryTests {
    @MainActor static func main() async {
        do {
            let name = CommandLine.arguments[1], directory = URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            try await run(name,directory)
            print("PASS: " + name)
        } catch { FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1) }
    }
    @MainActor static func run(_ name: String, _ directory: URL) async throws {
        let file = fileAt(directory)
        switch name {
        case "draft-restart":
            var writes = 0
            let first = NativeQuickCaptureLibraryStore()
            first.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "update" { writes += 1 }
                return ready()
            },open:{ _,_ in true })
            await first.select("capture-1"); first.beginEditing()
            first.text = "Draft 🌱\n  preserve indentation\n"; first.tags = "研究， notes,研究"
            try check(first.flushDraft() && first.flushForQuit(),"Unpublished durable edits should permit ordinary quit")
            let second = NativeQuickCaptureLibraryStore()
            second.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await second.select("capture-1")
            try check(second.text == first.text && second.tags == first.tags && second.editing,"Selecting after restart must restore exact editable input")
            try check(second.hasChanges && second.canSave && second.pending == nil && writes == 0,"Local draft persistence must not update workspace notes")
            let mode = try FileManager.default.attributesOfItem(atPath:file.path)[.posixPermissions] as? NSNumber
            try check(mode?.intValue == 0o600,"The edit draft must be owner-readable only")

        case "pending-before-request":
            let store = NativeQuickCaptureLibraryStore(); var calls = 0
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                calls += 1; let sent = try edit(payload)
                try check(store.saving && !store.flushForQuit(),"An active mutation must block ordinary quit")
                try check(try pendingAt(file) == sent,"Immutable request must be durable before calling workspace")
                try check(sent.expectedVersion == 10 && sent.tags == ["研究","notes"],"Request keeps expected version and normalizes only tags")
                try check(sent.text == "  exact\n正文\n","Publishing must preserve text whitespace")
                return saved(sent)
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "  exact\n正文\n"; store.tags = "研究，notes,研究"
            await store.save()
            try check(calls == 1 && !store.editing && store.pending == nil && !store.hasChanges,"Exact durable ACK should end editing")
            try check(try draftsAt(file).isEmpty,"Successful edit must remove its local unpublished draft")

        case "lost-ack-restart":
            let first = NativeQuickCaptureLibraryStore(); var committed: NativeQuickCaptureLibraryEdit?
            first.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                committed = try edit(payload); throw NativeQuickCaptureError.unconfirmed
            },open:{ _,_ in true })
            await first.select("capture-1"); first.beginEditing(); first.text = "Committed before ACK vanished"; await first.save()
            try check(first.inputLocked && first.canSave && first.editError != nil,"Unknown outcome must expose a locked retry")
            let second = NativeQuickCaptureLibraryStore(); var calls = 0
            second.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready(saved(committed!)["note"] as! [String:Any]) }
                calls += 1; let sent = try edit(payload)
                try check(sent == committed,"Restart must resend original identity, expected version, content and tags")
                return saved(sent)
            },open:{ _,_ in true })
            await second.select("capture-1")
            try check(second.conflicted && second.pending == committed && second.canSave,"New server version cannot discard an uncertain retry envelope")
            await second.save()
            try check(calls == 1 && second.pending == nil && !second.editing,"Matching idempotent receipt should resolve an uncertain save")

        case "wrong-ack":
            let store = NativeQuickCaptureLibraryStore(); var sent: NativeQuickCaptureLibraryEdit?
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                sent = try edit(payload); var result = saved(sent!); result["requestId"] = "another-request"; return result
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "Keep on mismatched receipt"; await store.save()
            try check(store.pending == sent && store.editing && store.editError != nil,"Unrelated receipt must never acknowledge an edit")
            try check(try pendingAt(file) == sent,"Wrong receipt keeps exact durable retry")

        case "conflict-retains-draft":
            let first = NativeQuickCaptureLibraryStore()
            first.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await first.select("capture-1"); first.beginEditing(); first.text = "User's unsent local work"; try check(first.flushDraft(),"Fixture draft should save")
            let second = NativeQuickCaptureLibraryStore(); var calls = 0
            second.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "update" { calls += 1 }
                return ready(note(text:"New content elsewhere",version:22))
            },open:{ _,_ in true })
            await second.select("capture-1"); await second.save()
            try check(second.conflicted && second.text == first.text && second.hasChanges && calls == 0,"Version conflict must retain draft without sending an overwrite")
            try check(second.selected?.content == "New content elsewhere" && second.editError != nil,"Latest source must remain distinct from edited draft")

        case "disk-error-before-request":
            var broken = true, calls = 0
            let store = NativeQuickCaptureLibraryStore(write:{ data,file in
                if broken { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to:file,options:.atomic)
            })
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                calls += 1; return saved(try edit(payload))
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "Disk full cannot lose this"; await store.save()
            let pending = store.pending
            try check(calls == 0 && pending != nil && store.draftError != nil && !store.flushForQuit(),"Nondurable request must not reach workspace or permit ordinary quit")
            broken = false; await store.save()
            try check(calls == 1 && store.pending == nil && store.selected?.content == pending?.text,"Recovered disk should permit exact pending request")

        case "disk-error-after-ack":
            var writes = 0, broken = false; var committed: NativeQuickCaptureLibraryEdit?
            let store = NativeQuickCaptureLibraryStore(write:{ data,file in
                writes += 1; if broken { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to:file,options:.atomic)
            })
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                committed = try edit(payload); broken = true; return saved(committed!)
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "ACK clear must also be durable"; await store.save()
            try check(writes >= 2 && store.pending == committed && store.draftError != nil,"Failed ACK clear must roll back memory envelope")
            try check(try pendingAt(file) == committed,"Failed clear must preserve recoverable disk envelope")
            try check(!store.flushForQuit(),"Post-ACK local persistence failure must block ordinary quit")
            let second = NativeQuickCaptureLibraryStore()
            second.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                try check(try edit(payload) == committed,"Restart must recover same uncertain edit")
                return saved(committed!)
            },open:{ _,_ in true })
            await second.select("capture-1"); await second.save()
            try check(second.pending == nil && !second.hasChanges,"Recovery must finish only once envelope removal is durable")

        case "privacy-during-read":
            let store = NativeQuickCaptureLibraryStore(); var release: CheckedContinuation<[String:Any],Error>?
            store.configure(directory:directory,request:{ _ in try await withCheckedThrowingContinuation { release = $0 } },open:{ _,_ in true })
            let task = Task { @MainActor in await store.select("capture-1") }
            while release == nil { await Task.yield() }
            store.setAvailable(false)
            try check(store.selected == nil && store.text.isEmpty && store.rows.isEmpty && !store.selecting,"Private mode must immediately hide data and stop busy state")
            release!.resume(returning:ready(note(text:"Late private content"))); await task.value
            try check(store.selected == nil && store.text.isEmpty && !store.editing,"Late read must not repopulate private content")

        case "privacy-during-save":
            let store = NativeQuickCaptureLibraryStore(); var release: CheckedContinuation<[String:Any],Error>?, sent: NativeQuickCaptureLibraryEdit?
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                sent = try edit(payload); return try await withCheckedThrowingContinuation { release = $0 }
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "Draft before private mode"
            let task = Task { @MainActor in await store.save() }; while release == nil { await Task.yield() }
            store.setAvailable(false)
            try check(store.selected == nil && store.text.isEmpty && store.tags.isEmpty && store.saving,"Privacy hides content while preserving active write state")
            release!.resume(returning:saved(sent!)); await task.value
            try check(store.selected == nil && store.text.isEmpty && store.rows.isEmpty && !store.saving,"Late save ACK must never restore private data")
            try check(try draftsAt(file).isEmpty,"Exact durable ACK may clear only that confirmed unpublished draft")

        case "stale-query":
            let store = NativeQuickCaptureLibraryStore(); var release: CheckedContinuation<[String:Any],Error>?
            store.configure(directory:directory,request:{ payload in
                if payload["query"] as? String == "old" { return try await withCheckedThrowingContinuation { release = $0 } }
                return listed([note("new-result",text:"New search")])
            },open:{ _,_ in true })
            store.query = "old"; let task = Task { @MainActor in await store.refresh() }; while release == nil { await Task.yield() }
            store.query = "new"; await store.refresh()
            release!.resume(returning:listed([note("old-result",text:"Obsolete search")])); await task.value
            try check(store.rows.map(\.id) == ["new-result"] && !store.loading,"Older request must not replace current results or busy state")

        case "corrupt-file-readonly":
            let original = Data("{malformed draft".utf8); try original.write(to:file)
            let store = NativeQuickCaptureLibraryStore(); var updates = 0
            store.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "update" { updates += 1 }
                return ready()
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "Programmatic text cannot overwrite original"; await store.save()
            try check(store.selected?.content == "Original capture" && !store.editing,"Unreadable draft permits read-only browsing")
            try check(store.inputLocked && !store.flushDraft() && updates == 0,"Corrupt draft must block writes")
            try check(store.flushForQuit(),"A read-only corrupt file is already preserved and must not prevent every quit")
            try check(try Data(contentsOf:file) == original,"Corrupt bytes must stay intact")

        case "workspace-rebind":
            let store = NativeQuickCaptureLibraryStore(); var wrongCalls = 0
            store.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.text = "Belongs to original workspace"
            store.configure(directory:directory.appendingPathComponent("other"),request:{ _ in wrongCalls += 1; return ready() },open:{ _,_ in true })
            store.setAvailable(true)
            await store.refresh(); await store.save()
            try check(wrongCalls == 0 && store.selected == nil && store.text.isEmpty && store.inputLocked,"Rebinding must hide old data and never send it into new workspace")
            try check(try draftsAt(file)["capture-1"] != nil,"Original workspace draft must be retained")

        case "no-second-notes-database":
            let store = NativeQuickCaptureLibraryStore()
            store.configure(directory:directory,request:{ payload in payload["action"] as? String == "list" ? listed([note(),note("capture-2",text:"Unedited source")]) : ready() },open:{ _,_ in true })
            await store.refresh(); await store.select("capture-1")
            try check(store.flushForQuit() && !FileManager.default.fileExists(atPath:file.path),"Browsing published data must not create a second persisted library")
            store.beginEditing(); store.text = "Only this changed draft belongs on disk"; try check(store.flushDraft(),"Edited draft should persist")
            try check(Set(try draftsAt(file).keys) == ["capture-1"],"Disk should contain only explicitly edited notes")
            await store.discardSelectedDraft()
            try check(try draftsAt(file).isEmpty,"Discard must remove the unpublished copy without changing source")
            try check(store.selected?.content == "Original capture" && !store.hasChanges,"Reload must return authoritative workspace note")

        case "independent-title-restart":
            let first = NativeQuickCaptureLibraryStore()
            first.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await first.select("capture-1"); first.beginEditing(); first.title = "My independent title"
            try check(first.hasChanges && first.canSave && first.flushDraft(),"Title-only changes must be durable editable drafts")
            let second = NativeQuickCaptureLibraryStore(); var sent: NativeQuickCaptureLibraryEdit?
            second.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                sent = try edit(payload); return saved(sent!)
            },open:{ _,_ in true })
            await second.select("capture-1")
            try check(second.title == first.title && second.text == "Original capture" && second.canSave,"Restart must recover the title without changing the body")
            await second.save()
            try check(sent?.title == first.title && sent?.text == "Original capture" && second.selected?.title == first.title && !second.hasChanges,"Only exact title/body ACK may publish and clear the draft")

        case "title-validation-and-ack":
            let store = NativeQuickCaptureLibraryStore(); var calls = 0
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready() }
                calls += 1; let sent = try edit(payload); var reply = saved(sent)
                reply["note"] = note(text:sent.text,version:11,tags:sent.tags,title:"Wrong title")
                return reply
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.title = "  "
            await store.save()
            try check(calls == 0 && !store.canSave && store.hasChanges && store.flushDraft(),"An empty title stays recoverable but cannot publish")
            store.title = "Correct title"; await store.save()
            try check(calls == 1 && store.pending?.title == "Correct title" && store.editing && store.editError != nil,"Wrong-title ACK must retain exact retry and input")
            try check(try pendingAt(file) == store.pending,"Wrong-title ACK must not consume the journal")

        case "legacy-title-free-retry":
            let legacy = NativeQuickCaptureLibraryEdit(requestId:"quick_capture_edit_" + UUID().uuidString.lowercased(),id:"capture-1",expectedVersion:10,text:"Old pending body",tags:["research"])
            let record: [String:Any] = ["id":"capture-1","version":10,"originalText":"Original capture","originalTags":["research"],"text":legacy.text,"tags":"research","pending":legacy.payload.filter { $0.key != "action" }]
            try JSONSerialization.data(withJSONObject:["version":1,"drafts":["capture-1":record]]).write(to:file)
            let store = NativeQuickCaptureLibraryStore(); var calls = 0
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "update" else { return ready(note(text:legacy.text,version:11,title:"Current saved title")) }
                calls += 1
                try check(payload["title"] == nil && (try edit(payload)) == legacy,"V1 retry identity must not gain a title field")
                return saved(legacy)
            },open:{ _,_ in true })
            await store.select("capture-1"); await store.save()
            try check(calls == 1 && store.pending == nil && !store.hasChanges,"Legacy uncertain edit must still resolve through its original ACK")

        case "invalid-title-draft-restart":
            let first = NativeQuickCaptureLibraryStore()
            first.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await first.select("capture-1"); first.beginEditing(); first.title = String(repeating:"title",count:130) + "\nkeep pasted text"
            try check(!first.canSave && first.flushDraft(),"Oversize pasted title must be retained locally while publishing is disabled")
            let second = NativeQuickCaptureLibraryStore()
            second.configure(directory:directory,request:{ _ in ready() },open:{ _,_ in true })
            await second.select("capture-1")
            try check(second.title == first.title && second.editing && !second.inputLocked && !second.canSave,"Restart must restore invalid draft input for correction instead of locking the library")
            second.title = "Corrected title"
            try check(second.canSave && second.flushForQuit(),"Correcting the recovered input re-enables save")

        case "delete-durable-before-request":
            let store = NativeQuickCaptureLibraryStore(); var calls = 0, deleted = false
            store.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "list" { return listed(deleted ? [] : [note()]) }
                guard payload["action"] as? String == "remove" else { return ready() }
                calls += 1
                let journal = try lifecycleAt(file)
                try check(journal == store.pendingLifecycle && journal?.action == "remove" && journal?.id == "capture-1","Delete identity must be durable before mutation")
                try check(payload["expectedVersion"] as? Double == 10 && payload["expectedRecordVersion"] as? String == "sha256:full-record-10.0","Delete must carry timestamp and whole-record CAS")
                try check(store.saving && !store.flushForQuit() && store.inputLocked,"Active delete must lock edits and ordinary quit")
                deleted = true; return lifecycleSaved(payload)
            },open:{ _,_ in true })
            await store.refresh(); await store.select("capture-1"); await store.removeSelected()
            try check(calls == 1 && store.selected == nil && store.rows.isEmpty && store.pendingLifecycle == nil && store.notice != nil,"Durable delete ACK clears selection and refreshes authoritative list")
            try check(try lifecycleAt(file) == nil,"Confirmed deletion must durably clear only its journal")

        case "delete-lost-ack-restart":
            let first = NativeQuickCaptureLibraryStore(); var sent: [String:Any]?
            first.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "remove" else { return ready() }
                sent = payload; throw NativeQuickCaptureError.unconfirmed
            },open:{ _,_ in true })
            await first.select("capture-1"); await first.removeSelected()
            let pending = first.pendingLifecycle
            try check(pending != nil && first.inputLocked && first.lifecycleError != nil && first.flushForQuit(),"Uncertain delete must retain a durable retry and allow safe quit")
            let second = NativeQuickCaptureLibraryStore(); var calls = 0
            second.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "remove" else { return listed([]) }
                calls += 1
                try check(NSDictionary(dictionary:payload).isEqual(to:sent!),"Restart must resend exact delete identity and CAS without reselecting a now absent note")
                return lifecycleSaved(payload)
            },open:{ _,_ in true })
            try check(second.pendingLifecycle == pending && second.selected == nil,"Reload must expose uncertain action without an available note")
            await second.retryLifecycle()
            try check(calls == 1 && second.pendingLifecycle == nil && second.flushForQuit(),"Matching receipt resolves restarted delete")

        case "restore-exact-ack":
            let store = NativeQuickCaptureLibraryStore(); var calls = 0, restored = false
            store.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "trash" { return try trashed(restored ? [] : [trashEntry()]) }
                guard payload["action"] as? String == "restore" else { return listed([]) }
                calls += 1
                try check(try lifecycleAt(file) == store.pendingLifecycle,"Restore must persist before sending")
                try check(payload["expectedVersion"] as? String == "sha256:trash-1" && payload["trashId"] as? String == "trash-1","Restore uses exact trash version")
                var result = lifecycleSaved(payload)
                if calls == 1 { result["trashId"] = "unrelated-trash" } else { restored = true }
                return result
            },open:{ _,_ in true })
            await store.toggleTrash(); try check(store.trash.count == 1,"Trash view must list authoritative recoverable rows")
            await store.restore(store.trash[0])
            let pending = store.pendingLifecycle
            try check(pending != nil && store.trash.count == 1 && store.lifecycleError != nil,"Wrong trash ACK cannot dismiss pending restore")
            await store.retryLifecycle()
            try check(calls == 2 && store.pendingLifecycle == nil && store.trash.isEmpty && store.notice != nil,"Exact retry clears only restored trash entry")

        case "lifecycle-disk-failures":
            var blocked = true, afterWriteFailure = false, calls = 0
            let store = NativeQuickCaptureLibraryStore(write:{ data,file in
                if blocked { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to:file,options:.atomic)
                if afterWriteFailure { throw CocoaError(.fileWriteOutOfSpace) }
            })
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "remove" else { return payload["action"] as? String == "get" ? ready() : listed([]) }
                calls += 1; afterWriteFailure = true; return lifecycleSaved(payload)
            },open:{ _,_ in true })
            await store.select("capture-1"); await store.removeSelected()
            let pending = store.pendingLifecycle
            try check(calls == 0 && pending != nil && !store.flushForQuit(),"Nondurable lifecycle request must never reach main state")
            blocked = false; await store.retryLifecycle()
            try check(calls == 1 && store.pendingLifecycle == pending && store.draftError != nil,"Post-ACK write failure must keep pending state")
            try check(try lifecycleAt(file) == pending,"Even a writer which writes then throws cannot remove the last durable envelope")
            afterWriteFailure = false
            let second = NativeQuickCaptureLibraryStore()
            second.configure(directory:directory,request:{ payload in payload["action"] as? String == "remove" ? lifecycleSaved(payload) : listed([]) },open:{ _,_ in true })
            await second.retryLifecycle()
            try check(second.pendingLifecycle == nil && (try lifecycleAt(file)) == nil,"Restart receipt retry must resolve after disk recovers")

        case "dirty-editor-delete-guard":
            let store = NativeQuickCaptureLibraryStore(); var mutations = 0
            store.configure(directory:directory,request:{ payload in
                if ["remove","restore"].contains(payload["action"] as? String ?? "") { mutations += 1 }
                return ready()
            },open:{ _,_ in true })
            await store.select("capture-1"); store.beginEditing(); store.title = "Do not discard this title"
            await store.removeSelected(); await store.restore(trashEntry())
            try check(mutations == 0 && store.pendingLifecycle == nil && store.hasChanges,"Delete/restore cannot take over an active changed editor")
            store.endEditing(); await store.removeSelected()
            try check(mutations == 0 && store.hasChanges && store.title == "Do not discard this title","A dismissed but retained draft must still block deletion of its note")

        case "privacy-during-delete":
            let store = NativeQuickCaptureLibraryStore(); var release: CheckedContinuation<[String:Any],Error>?, sent: [String:Any]?
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "remove" else { return ready() }
                sent = payload; return try await withCheckedThrowingContinuation { release = $0 }
            },open:{ _,_ in true })
            await store.select("capture-1")
            let task = Task { @MainActor in await store.removeSelected() }; while release == nil { await Task.yield() }
            store.setAvailable(false)
            try check(store.selected == nil && store.title.isEmpty && store.text.isEmpty && store.saving,"Privacy must hide title/body immediately while mutation completes")
            release!.resume(returning:lifecycleSaved(sent!)); await task.value
            try check(store.pendingLifecycle == nil && store.selected == nil && store.rows.isEmpty && store.notice == nil && store.lifecycleError == nil,"Late ACK may clear journal but never reveal private note data")

        case "lifecycle-recovery-record":
            let store = NativeQuickCaptureLibraryStore()
            store.configure(directory:directory,request:{ payload in
                guard payload["action"] as? String == "remove" else { return ready() }
                throw NativeQuickCaptureError.unconfirmed
            },open:{ _,_ in true })
            await store.select("capture-1"); await store.removeSelected()
            let pending = store.pendingLifecycle!
            try check(store.keepLifecycleRecovery() && store.pendingLifecycle == nil && !store.inputLocked,"Explicitly keeping a recovery record may unlock interface without claiming rollback")
            let recovery = directory.appendingPathComponent(pending.requestId + "-recovery.json")
            let kept = try JSONDecoder().decode(NativeQuickCaptureLibraryLifecycle.self,from:Data(contentsOf:recovery))
            try check(kept == pending && (try lifecycleAt(file)) == nil && store.selected?.id == "capture-1","Recovery record retains exact uncertain operation and does not mutate main note")
            try check(try objectAt(recovery)["text"] == nil,"Lifecycle recovery must not make a second copy of published note body")

        case "stale-trash-read":
            let store = NativeQuickCaptureLibraryStore(); var release: CheckedContinuation<[String:Any],Error>?
            store.configure(directory:directory,request:{ payload in
                if payload["action"] as? String == "trash" { return try await withCheckedThrowingContinuation { release = $0 } }
                return listed([note()])
            },open:{ _,_ in true })
            let task = Task { @MainActor in await store.toggleTrash() }; while release == nil { await Task.yield() }
            await store.toggleTrash(); release!.resume(returning:try trashed([trashEntry()])); await task.value
            try check(!store.showingTrash && store.trash.isEmpty && store.rows.map(\.id) == ["capture-1"] && !store.loading,"A stale trash reply cannot replace current list or restore hidden deleted titles")

        default: throw CheckFailure.failed("Unknown case: " + name)
        }
    }
}
