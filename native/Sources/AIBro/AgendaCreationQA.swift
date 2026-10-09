import Foundation
import AppKit
extension Workspace {
    func agendaCreationQA(_ destination:String) async throws {
        guard ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA"] != nil,desktop != nil else{throw AgendaError.message("Isolated desktop QA required")}
        let setup="""
        const quote='创建这批示例讲座，日期、时间与地点按表格保存。';
        const c={id:'qa-agenda-review-chat',title:'日程批量审阅测试',workspace:'auto',permissionMode:'full',messages:[{id:'qa-agenda-review-user',role:'user',text:quote,at:Date.now()}],attachments:[],draftAttachmentIds:[]};
        state.conversations.push(c);state.currentConversationId=c.id;
        const r={id:'qa-agenda-review-run',status:'completed',conversationId:c.id,userMessageId:c.messages[0].id,contextWorkspace:'auto',projectId:null,workspace:'日常',executionReceipt:{phase:'committed'},pendingActions:[],steps:[],startedAt:Date.now()};
        const values=Array.from({length:9},(_,i)=>({title:'示例讲座 '+(i+1),sourceMessageId:r.userMessageId,quote,start:'2026-10-'+String(10+i).padStart(2,'0')+'T15:00:00+08:00',end:'2026-10-'+String(10+i).padStart(2,'0')+'T16:00:00+08:00',timeZone:'Asia/Shanghai',location:'示例教学楼 A201',reminderMinutes:15}));
        r.agendaProposals=AgendaProposals.validate(values,state,r);state.agentRuns.push(r);
        c.messages.push({id:'qa-agenda-review-assistant',role:'assistant',text:'已整理这批讲座。',runId:r.id,at:Date.now()});
        openConversation(c.id);await saveDocumentDurably();renderAll();return true;
        """
        _ = try await web.callAsyncJavaScript(setup,arguments:[:],in:nil,contentWorld:.page)
        try await Task.sleep(nanoseconds:700_000_000)
        let initialSelection=selection
        let response=try await web.callAsyncJavaScript("const r=state.agentRuns.find(r=>r.id==='qa-agenda-review-run');return await workstationDesktop.agendaCreateBatch(r.agendaProposals,r.id,true);",arguments:[:],in:nil,contentWorld:.page) as? [String:Any]
        guard response?["status"] as? String == "committed",agenda.events.count==9,selection==initialSelection,agendaCreationReview==nil else{throw AgendaError.message("Automatic calendar creation or retained chat failed")}
        _ = try await web.callAsyncJavaScript("const r=state.agentRuns.find(r=>r.id==='qa-agenda-review-run');return await workstationDesktop.agendaCreateBatch(r.agendaProposals,r.id,true);",arguments:[:],in:nil,contentWorld:.page)
        guard agenda.events.count==9 else{throw AgendaError.message("Duplicate events on retry")}
        let forbidden=try await web.callAsyncJavaScript("const r=state.agentRuns.find(r=>r.id==='qa-agenda-review-run');currentConversation().permissionMode='request';try{await workstationDesktop.agendaCreateBatch(r.agendaProposals,r.id,true);return false;}catch{return true;}",arguments:[:],in:nil,contentWorld:.page)
        guard forbidden as? Bool == true,agenda.events.count==9 else{throw AgendaError.message("Revoked automatic permission accepted")}
        let loaded=AgendaStore();loaded.load(folder:dataDirectory,qa:true)
        guard loaded.events.count==9 else{throw AgendaError.message("Created events not durable")}
        let review=try await web.callAsyncJavaScript("const r=state.agentRuns.find(r=>r.id==='qa-agenda-review-run');r.agendaProposals=r.agendaProposals.slice(0,3).map((p,i)=>({...p,id:'agenda_manual_'+i,title:'待审阅示例讲座 '+(i+1)}));await saveDocumentDurably();renderConversation();return await workstationDesktop.agendaCreateBatch(r.agendaProposals,r.id,false);",arguments:[:],in:nil,contentWorld:.page) as? [String:Any]
        guard review?["status"] as? String == "pending_review",agenda.events.count==9,agendaCreationReview?.events.count==3,selection==initialSelection else{throw AgendaError.message("Batch review navigated or saved before confirmation")}
        let report="PASS: real WKWebView → native bridge → durable calendar; 9 automatic creations, retry deduplication, permission revocation, independent disk reload, 3-event manual review without navigation or premature writes. Synthetic workspace only. Manual sheet controls are inspected separately.\n"
        try report.write(toFile:destination+"-creation.txt",atomically:true,encoding:.utf8)
    }
}
