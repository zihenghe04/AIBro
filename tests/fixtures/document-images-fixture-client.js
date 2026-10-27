;(async function documentImageFixture(){
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));while(!storageHydrated)await wait(25);
 if(!state.projects.some(p=>p.id==='image-project')){
  const now=Date.now();state.projects=[{id:'image-project',name:'图片写作 · 隔离验收',workspace:'科研',createdAt:now}];
  state.notes=[{id:'image-note',title:'插图研究笔记',content:'# 插图研究笔记\n\n在这里记录研究过程。',projectId:'image-project',workspace:'科研',createdAt:now,updatedAt:now},{id:'image-wiki',title:'插图 Wiki',kind:'Wiki',content:'# 插图 Wiki\n\n知识条目与图示。',projectId:'image-project',workspace:'科研',createdAt:now,updatedAt:now}];
  state.imports=[];state.tasks=[];state.papers=[];state.trash=[];state.conversations=[];state.agentRuns=[];
  state.currentProjectId='image-project';state.currentConversationId=null;state.ui.workspaceNavigation={projects:{}};state.ui.projectTab='materials';
  state.ui.onboarding={version:1,status:'skipped'};state.ui.workspaceTour={version:1,status:'skipped'};state.ui.theme='light';state.ui.inspectorOpen=false;
  normalizeStateShape(state);await saveDocumentDurably();
 }
 WorkstationOnboarding.close();window.WorkspaceTour?.close?.();applyUiPreferences();showView('project','图片写作');renderAll();
 await openPreview('note','image-note');ReadingPane.setExpanded(true);window.__documentImageFixtureReady=true;
})();
