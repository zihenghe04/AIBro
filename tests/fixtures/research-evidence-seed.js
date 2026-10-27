(async()=>{
 WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};window.WorkspaceTour?.close();
 const now=Date.now();state.projects=[{id:'research-qa',name:'研究问题与证据 · 隔离验收',workspace:'科研',createdAt:now}];
 state.notes=[{id:'support-note',title:'小样本实验记录',content:'# 小样本实验\n\n固定随机种子后，三次独立复验均获得更低的验证误差。\n\n这只是当前数据集的结果，仍需独立验证。',workspace:'科研',projectId:'research-qa',createdAt:now,updatedAt:now},
 {id:'counter-note',title:'跨域验证与反例',content:'# 跨域验证\n\n迁移到新的数据集后，误差不再降低，部分样本表现更差。\n\n尚未隔离分布偏移和标注质量的影响。',workspace:'科研',projectId:'research-qa',createdAt:now,updatedAt:now}];
 state.imports=[];state.tasks=[];state.papers=[];state.links=[];state.trash=[];state.agentRuns=[];
 state.conversations=[{id:'research-qa-chat',title:'科研验证 · 隔离数据',workspace:'科研',projectId:'research-qa',messages:[],attachments:[],draftAttachmentIds:[],draft:'保留这份原对话草稿',createdAt:now}];
 state.currentProjectId='research-qa';state.currentConversationId='research-qa-chat';state.ui.inspectorOpen=false;
 normalizeStateShape(state);renderAll();showView('wiki');
 await saveDocumentDurably();return true;
})();
