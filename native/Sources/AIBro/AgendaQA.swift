import Foundation
import AppKit
extension Workspace {
    func agendaQA(_ destination:String) async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] != nil else{return}
        let cal=Calendar.current,today=cal.startOfDay(for:Date())
        let specs=[("线性代数 · 矩阵与线性变换","course",9,"qa-course"),("研究进展讨论","meeting",14,"native-qa"),("周末行程确认","event",17,"qa-trip")]
        for (title,kind,hour,project) in specs {
            var event=AgendaEvent();event.id="qa-agenda-"+kind;event.title=title;event.kind=kind;event.start=cal.date(bySettingHour:hour,minute:0,second:0,of:today)!;event.end=event.start.addingTimeInterval(3600);event.projectID=project
            event.frequency="weekly";event.count=12;event.location=kind=="course" ? "教学楼 A201":kind=="meeting" ? "研究讨论室":"线上确认";if kind=="event"{event.documentID="qa-note-trip"}
            try agenda.save(event)
        }
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_DESKTOP"] == "1" {
            let safe=try await web.callAsyncJavaScript("return (await window.workstationDesktop.apiCredentials.status()).hasKey === false",arguments:[:],in:nil,contentWorld:.page)
            guard safe as? Bool == true else{throw CocoaError(.validationMissingMandatoryProperty)}
        }
        selection="agenda";try await Task.sleep(nanoseconds:800_000_000)
        guard selection=="agenda",agenda.events.count==3,agenda.occurrences(from:today,to:cal.date(byAdding:.day,value:1,to:today)!).count>=3 else{throw CocoaError(.validationMissingMandatoryProperty)}
        guard (try await web.evaluateJavaScript("typeof window.NativeAgendaAI.extract")) as? String == "function" else{throw CocoaError(.validationMissingMandatoryProperty)}
        if let window=NSApp.windows.first(where:{$0.isVisible && $0.frame.width>800}) {
            window.setContentSize(NSSize(width:1280,height:850));try await Task.sleep(nanoseconds:500_000_000)
            let capture=Process();capture.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture");capture.arguments=["-x","-l",String(window.windowNumber),destination+"-agenda.png"];try capture.run();capture.waitUntilExit()
        }
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_WORKFLOW"] == "1" && desktop != nil {
            let noteID=try await web.callAsyncJavaScript("showView('captures','随记');CaptureNotes.render();return document.querySelector('[data-capture-agenda]').dataset.captureAgenda",arguments:[:],in:nil,contentWorld:.page) as! String
            try await Task.sleep(nanoseconds:700_000_000)
            _ = try await web.callAsyncJavaScript("document.querySelector('[data-capture-agenda]').click();return true",arguments:[:],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:700_000_000)
            guard var draft=agendaDraft,draft.documentID==noteID,agenda.events.count==3,selection=="agenda" else{throw AgendaError.message("Capture draft bridge failed")}
            draft.start=Date().addingTimeInterval(86400);draft.end=draft.start.addingTimeInterval(1800);draft.frequency="weekly";draft.count=3;draft.reminderMinutes=15
            try agenda.save(draft);agendaDraft=nil
            guard agenda.events.count==4 else{throw AgendaError.message("Capture event save failed")}
            _ = try await web.callAsyncJavaScript("await CaptureAgenda.refresh(true);return true",arguments:[:],in:nil,contentWorld:.page)
            let linked=try await web.callAsyncJavaScript("return document.querySelectorAll('[data-capture-agenda-link]').length",arguments:[:],in:nil,contentWorld:.page)
            guard (linked as? Int ?? 0)>0 else{throw AgendaError.message("Capture calendar backlink missing")}
            _ = try await web.callAsyncJavaScript("document.querySelector('[data-capture-agenda-link]').click();return true",arguments:[:],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:400_000_000)
            guard agendaLinkedDetail?.event.id==draft.id else{throw AgendaError.message("Calendar detail navigation failed")}
            agendaLinkedDetail=nil
            let proposal=try await web.callAsyncJavaScript("const run=state.agentRuns.find(r=>r.agendaProposals?.length);openConversation(run.conversationId);renderConversation();return run.agendaProposals[0]",arguments:[:],in:nil,contentWorld:.page) as! [String:Any]
            try await Task.sleep(nanoseconds:700_000_000)
            _ = try await web.callAsyncJavaScript("document.querySelector('[data-agenda-proposal]').click();return true",arguments:[:],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:700_000_000)
            guard let proposed=agendaDraft,proposed.id==proposal["id"] as? String,proposed.frequency=="weekly",proposed.reminderMinutes==15,agenda.events.count==4 else{throw AgendaError.message("AI agenda review bridge failed")}
            try agenda.save(proposed);agendaDraft=nil
            try reviewAgendaProposal(proposal)
            guard agendaDraft==nil,agendaLinkedDetail?.event.id==proposed.id,agenda.events.count==5 else{throw AgendaError.message("Agenda proposal replay created duplicate")}
            agendaLinkedDetail=nil
        }
        try "Agenda QA passed: capture draft opens without saving, linked weekly event persistence and capture-to-detail navigation; isolated event persistence, native route remains selected, tasks/events visible, read-only AI import bridge installed. System notification authorization and live model requests are not performed in this fixture.\n".write(toFile:destination+"-agenda.txt",atomically:true,encoding:.utf8)
    }
}
