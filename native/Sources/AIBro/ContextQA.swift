import Foundation
import AppKit
extension Workspace {
    func contextQA(_ destination:String) async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_CONTEXT"] == "1", Bundle.main.bundleIdentifier == "app.aibro.reminder-qa" else {throw AgendaError.message("Context QA requires isolated bundle")}
        let script=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-context.js"),encoding:.utf8)
        let report=try await web.callAsyncJavaScript(script,arguments:[:],in:nil,contentWorld:.page)
        let vectors=try NativeVectorStore(folder:dataDirectory).load(String(repeating:"a",count:64))
        guard vectors.count==1,vectors.first?["id"] as? String == "qa-vector" else {throw AgendaError.message("Native vector data did not survive store reopen")}
        for _ in 0..<40 {if agendaDraft != nil {break};try await Task.sleep(nanoseconds:100_000_000)}
        guard let draft=agendaDraft,draft.frequency=="weekly",draft.weekdays==[5],draft.count==nil,draft.until==nil,draft.location.contains("123-4567-8901"),agenda.events.isEmpty else {throw AgendaError.message("Recurring review did not open, has an invented end, or saved too early")}
        try agenda.save(draft);agendaDraft=nil
        let occurrences=agenda.occurrences(from:draft.start,to:draft.start.addingTimeInterval(21*86400-1)).filter{$0.event.id==draft.id}
        guard occurrences.count==3 else {throw AgendaError.message("Weekly expansion failed")}
        var cal=Calendar(identifier:.gregorian);cal.timeZone=TimeZone(identifier:"Asia/Shanghai")!
        guard occurrences.allSatisfy({cal.component(.weekday,from:$0.start)==5 && cal.component(.hour,from:$0.start)==14 && cal.component(.minute,from:$0.start)==30}) else {throw AgendaError.message("Recurring local time drifted")}
        let laterStart=draft.start.addingTimeInterval(52*7*86400)
        let later=agenda.occurrences(from:laterStart,to:laterStart.addingTimeInterval(4*7*86400-1)).filter{$0.event.id==draft.id}
        guard later.count==4,later.allSatisfy({cal.component(.weekday,from:$0.start)==5 && cal.component(.hour,from:$0.start)==14 && cal.component(.minute,from:$0.start)==30}) else {throw AgendaError.message("Open-ended recurrence stopped before the following year")}
        let archive=try JSONDecoder().decode(AgendaArchive.self,from:Data(contentsOf:dataDirectory.appendingPathComponent("agenda.json")))
        guard archive.events.count==1,archive.events.contains(where:{$0.id==draft.id && $0.frequency=="weekly" && $0.count==nil && $0.until==nil}) else {throw AgendaError.message("Single open-ended recurring rule was not persisted")}
        let bytes=try JSONSerialization.data(withJSONObject:["status":"PASS","web":report,"checkedFirstThreeWeeks":occurrences.count,"checkedFourWeeksNextYear":later.count,"recurrence":"weekly, no count or end date","savedRules":archive.events.count,"savedEvent":draft.id],options:[.prettyPrinted,.sortedKeys])
        try bytes.write(to:URL(fileURLWithPath:destination),options:.atomic)
        NSApp.terminate(nil)
    }
}
