import Foundation
import UserNotifications
import AppKit

extension Workspace {
    // Runs only with an isolated QA workspace and distinct bundle identifier.
    func reminderQA(_ destination:String) async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_NOTIFICATIONS"] == "1",
              Bundle.main.bundleIdentifier == "app.aibro.reminder-qa" else {throw AgendaError.message("Reminder QA requires its isolated bundle")}
        await agenda.requestNotifications()
        let permission=await agenda.center.notificationSettings()
        guard permission.authorizationStatus == .authorized else {throw AgendaError.message("QA notification permission not authorized: \(permission.authorizationStatus.rawValue); \(agenda.error ?? "no request error")")}
        var preferences=agenda.preferences;preferences.notifications=true;preferences.showTitles=true;preferences.taskReminderMinutes=60;try agenda.updatePreferences(preferences)
        let js="""
        const now=Date.now();
        const plan=[{type:'create_task',title:'Synthetic shopping reminder',dueAt:new Date(now+12000).toISOString(),reminderMinutes:0,checklist:['Synthetic item A','Synthetic item B']}];
        const outcome=Core.applyPlan(state,plan,{workspace:'日常',uid:()=> 'qa-reminder-live'});
        state=outcome.state;await saveDocumentDurably();renderAll();return state.tasks.find(x=>x.id==='qa-reminder-live').id;
        """
        _ = try await web.callAsyncJavaScript(js,arguments:[:],in:nil,contentWorld:.page)
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds:250_000_000)
            if (await agenda.center.pendingNotificationRequests()).contains(where:{$0.identifier.contains("qa-reminder-live")}) {break}
        }
        let scheduled=await agenda.center.pendingNotificationRequests()
        guard scheduled.contains(where:{$0.identifier.contains("qa-reminder-live")}) else {throw AgendaError.message("No task reminder scheduled through bridge")}
        try "SCHEDULED: synthetic task reminder; awaiting OS delivery".write(toFile:destination,atomically:true,encoding:.utf8)
        try await Task.sleep(nanoseconds:15_000_000_000)
        let delivered=await agenda.center.deliveredNotifications()
        guard delivered.contains(where:{$0.request.identifier.contains("qa-reminder-live")}) else {throw AgendaError.message("OS delivery not observed")}
        _ = try await web.callAsyncJavaScript("const t=state.tasks.find(x=>x.id==='qa-reminder-live');t.dueAt=new Date(Date.now()+3600000).toISOString();t.updatedAt=Date.now();await saveDocumentDurably();renderAll();return true",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:2_000_000_000)
        guard (await agenda.center.pendingNotificationRequests()).contains(where:{$0.identifier.contains("qa-reminder-live")}) else {throw AgendaError.message("Rescheduling failed")}
        _ = try await web.callAsyncJavaScript("state.tasks.find(x=>x.id==='qa-reminder-live').status='done';await saveDocumentDurably();renderAll();return true",arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:2_000_000_000)
        guard !(await agenda.center.pendingNotificationRequests()).contains(where:{$0.identifier.contains("qa-reminder-live")}) else {throw AgendaError.message("Completed task still has pending notification")}
        agenda.center.removeDeliveredNotifications(withIdentifiers:delivered.map{$0.request.identifier})
        try "PASS: isolated workspace, validated task action, durable save, native bridge, OS authorization, OS pending request, actual delivered notification, reschedule, completion cancellation".write(toFile:destination,atomically:true,encoding:.utf8)
    }
}
