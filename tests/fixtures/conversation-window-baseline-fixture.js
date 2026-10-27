function seedConversationBaseline(count, variant) {
  const now=1790690400000, messages=[], runs=[];
  const rich = '# Synthetic research record\n\nThis benchmark paragraph describes **recorded context**, an [external reference](https://example.invalid/research), and $x^2 + y^2$. No provider was contacted.\n\n- Read the synthetic record\n- Preserve source context\n\n| Item | Count |\n| --- | ---: |\n| Evidence | 3 |\n| Tasks | 0 |\n\n```js\nconst result = { synthetic: true, value: 42 };\n// This code is fixture content, never executed.\n```\n\n> Synthetic quotation for layout measurement.\n\nFinal paragraph retains its complete source content.\n';
  for(let index=0;index<count;index++){
    const agent=index%2===1,id='baseline-message-'+index, runId='baseline-run-'+index;
    const message={id,role:agent?'agent':'user',text:agent&&variant==='rich-tools'?rich+'\nRecord '+index:'Synthetic message '+index+' / '+('Conversation history and document navigation. '.repeat(agent?5:2)),at:now+index*1000};
    if(agent&&variant==='rich-tools'){
      const heavy=index%20===1;
      const activities=heavy?Array.from({length:12},(_,a)=>({id:id+'-activity-'+a,kind:'tool',name:'read',text:'Synthetic source '+a+'\n'+('Evidence excerpt remains available for inspection. '.repeat(6)),status:'completed',at:now+index*1000+a,updatedAt:now+index*1000+a+1})):[];
      const run={id:runId,conversationId:'baseline-conversation',status:'completed',startedAt:now+index*1000,finishedAt:now+index*1000+100,steps:[],activities,
        toolCalls:heavy?Array.from({length:48},(_,t)=>({id:runId+'-tool-'+t,type:'read',status:'completed',startedAt:now+index*1000+t,finishedAt:now+index*1000+t+1,request:{type:'read',recordType:'note',id:'synthetic-source-'+t,offset:t*30},result:{title:'Synthetic source '+t,text:'Recorded fixture excerpt. '.repeat(32),offset:t*30,nextOffset:null}})):[]};
      runs.push(run);Object.assign(message,{runId,runStatus:'completed',activities,steps:[],startedAt:run.startedAt,finishedAt:run.finishedAt});
    }
    messages.push(message);
  }
  state.projects=[];state.notes=[];state.imports=[];state.tasks=[];state.papers=[];state.agentRuns=runs;
  state.conversations=[{id:'baseline-conversation',title:'Synthetic baseline · '+variant+' · '+count,workspace:'日常',messages,attachments:[],draftAttachmentIds:[],draft:'',createdAt:now,updatedAt:now+count*1000}];
  state.currentConversationId='baseline-conversation';state.ui.inspectorOpen=false;state.ui.theme='light';state.settings.reduceMotion=true;
  normalizeStateShape(state);applyUiPreferences();
  window.__baselineHeavyId=[...messages].reverse().find(m=>m.activities?.length)?.id||null;
  window.__baselineInstrumentation={messageCalls:0,messageMs:0,parserCalls:0,parserMs:0,parserCharacters:0};
  return {count,variant,textCharacters:messages.reduce((n,m)=>n+m.text.length,0),toolCalls:runs.reduce((n,r)=>n+r.toolCalls.length,0),activities:messages.reduce((n,m)=>n+(m.activities?.length||0),0),stateBytes:new Blob([JSON.stringify(state)]).size};
}
