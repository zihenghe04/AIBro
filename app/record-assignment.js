/* Existing-record ownership transactions. No store, persistence or model authorization. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./context-retrieval'):root.ContextRetrieval);if(typeof module==='object'&&module.exports)module.exports=api;else root.RecordAssignment=api;})(globalThis,function(Retrieval){
 'use strict';
 const list=x=>Array.isArray(x)?x:[],spaces=new Set(['日常','课程','科研']);
 const id=x=>typeof x==='string'&&!!x.trim()&&x===x.trim()&&x.length<=200&&!/[\u0000-\u001f\u007f]/.test(x);
 const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
 function canonical(value){if(Array.isArray(value))return value.map(canonical);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));}
 // Compact full-record concurrency stamp, not an authorization token. Include
 // timestamps, provenance, drafts and unknown future fields; never hash excerpts.
 function version(record){const text=JSON.stringify(canonical(record));if(typeof text!=='string')fail('ASSIGN_RECORD_VERSION','无法取得记录版本');let a=0x811c9dc5,b=0x9e3779b9;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^c,0x85ebca6b)>>>0;}return `record-v1-${text.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;}
 const actionKeys=['type','recordType','recordId','targetProjectId','expectedRecordVersion'];
 function validateAction(action){
  if(!action||typeof action!=='object'||Array.isArray(action)||action.type!=='assign_record'||Object.keys(action).some(k=>!actionKeys.includes(k))||actionKeys.some(k=>!Object.hasOwn(action,k)))fail('ASSIGN_RECORD_SCHEMA','归属操作仅接受 type、recordType、recordId、targetProjectId 和 expectedRecordVersion；目标必须明确填写 ID 或 null');
  if(!['note','task'].includes(action.recordType)||!id(action.recordId)||(action.targetProjectId!==null&&!id(action.targetProjectId))||typeof action.expectedRecordVersion!=='string'||!/^record-v1-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(action.expectedRecordVersion))fail('ASSIGN_RECORD_SCHEMA','归属操作的记录类型、ID、目标或完整版本无效；请重新读取');
  return action;
 }
 function projectIdentity(project){return project?{id:project.id,name:project.name,workspace:project.workspace}:null;}
 function inspect(state,action,context={}){
  validateAction(action);
  if(!Retrieval?.readableRecords||!Retrieval?.accessibleProjects)fail('ASSIGN_RECORD_UNAVAILABLE','归属访问校验尚未加载');
  const allowed=context[action.recordType==='task'?'allowedTaskIds':'allowedNoteIds'];
  if(!Array.isArray(allowed)||!allowed.includes(action.recordId))fail('ASSIGN_RECORD_SCOPE','记录不在本轮已读取的允许范围内，请先读取原记录');
  const record=Retrieval.readableRecords(state,{}).find(x=>x.type===action.recordType&&x.record.id===action.recordId)?.record;
  if(!record)fail('ASSIGN_RECORD_SCOPE','原记录重复、已删除、已归档或不可访问');
  const projects=Retrieval.accessibleProjects(state),sourceProject=record.projectId?projects.find(p=>p.id===record.projectId):null;
  if(record.projectId&&!sourceProject)fail('ASSIGN_RECORD_SCOPE','原项目已不可访问');
  const scope={projectId:context.projectId||null,workspace:context.workspace||'日常',...(context.recordAssignmentScope||{})};
  if(scope.projectId&&!projects.some(p=>p.id===scope.projectId))fail('ASSIGN_RECORD_SCOPE','本轮绑定项目已不可访问');
  if(!Retrieval.readScopeCurrent(state,scope))fail('ASSIGN_RECORD_SCOPE','本轮授权读取的项目已变化，请重新读取');
  const explicit=list(context.explicitReferences).some(ref=>ref?.type===action.recordType&&ref.id===record.id);
  // task_list already admits standalone tasks in the bound project's space.
  const taskCatalog=action.recordType==='task'&&!record.projectId&&record.workspace===(projects.find(p=>p.id===scope.projectId)?.workspace||scope.workspace);
  if(!explicit&&!taskCatalog&&!Retrieval.readableRecords(state,{...scope,query:'',allowedTaskIds:allowed}).some(x=>x.type===action.recordType&&x.record.id===record.id))fail('ASSIGN_RECORD_SCOPE','原记录已离开本轮可读范围，请重新读取');
  if(version(record)!==action.expectedRecordVersion)fail('ASSIGN_RECORD_STALE','原记录在读取后已变化，请重新读取版本并核对归属');
  const target=action.targetProjectId===null?null:projects.find(p=>p.id===action.targetProjectId);
  if(action.targetProjectId!==null&&(!target||!id(target.id)||typeof target.name!=='string'||!target.name.trim()||!spaces.has(target.workspace)))fail('ASSIGN_RECORD_TARGET','目标项目重复、已删除、已归档或不可访问');
  const sourceWorkspace=sourceProject?.workspace||record.workspace;
  if(!spaces.has(sourceWorkspace))fail('ASSIGN_RECORD_SCOPE','原记录空间无效，请先修复原记录');
  const before={projectId:record.projectId??null,project:record.project??null,workspace:record.workspace??null};
  const after={projectId:target?.id??null,project:target?.name??null,workspace:target?.workspace||sourceWorkspace};
  const changed=['projectId','project','workspace'].some(key=>!Object.hasOwn(record,key)||record[key]!==after[key]);
  const requiresReview=(record.projectId||null)!==after.projectId;
  const approvalKey=version({action,sourceProject:projectIdentity(sourceProject),targetProject:projectIdentity(target)});
  return {record,sourceProject,target,before,after,changed,requiresReview,approvalKey};
 }
 function preflight(state,action,context={}){
  const result=inspect(state,action,context);
  if(result.requiresReview&&context.recordAssignmentPreview!==true&&!list(context.recordAssignmentApprovals).includes(result.approvalKey))fail('ASSIGN_RECORD_APPROVAL','跨项目或解除归属需先审阅原归属与新归属并批准');
  return result;
 }
 // Only the host's explicit human-approval path may call this. Never merge model
 // fields into context; these stamps bind the exact reviewed action and routing.
 function approvalKeys(state,actions,context={}){return list(actions).filter(a=>a?.type==='assign_record').map(a=>inspect(state,a,context)).filter(r=>r.requiresReview).map(r=>r.approvalKey);}
 function contextForRun(run={},options={}){
  return {recordAssignmentScope:run.recordAssignmentScope||{projectId:run.projectId||null,workspace:run.contextWorkspace||run.workspace||'日常'},recordAssignmentPreview:options.preview===true,recordAssignmentApprovals:list(run.recordAssignmentApprovals)};
 }
 const instructions='既有记录归属：只迁移现有笔记（包括原始随记）或任务时使用 actions:[{type:"assign_record",recordType:"note或task",recordId:"原记录ID",targetProjectId:"目标项目ID或明确null",expectedRecordVersion:"读取结果的recordVersion"}]。笔记先 read(recordType:note,id)，任务先 task_list；list 可定位笔记并返回版本，但仍需 read 加入本轮可操作范围。recordVersion 是完整记录版本，不能用 updatedAt、搜索片段 version 或自己推算代替。仅改变 projectId/project/workspace，保留原 ID、正文、来源、草稿及修订；不得添加 patch、workspace 或其他字段。targetProjectId:null 明确解除项目归属并保留原空间，不能省略或写空串；目标只支持已存在的唯一活跃可访问项目。跨项目与解除归属都需用户审阅；可读项目或候选目录不代表写权限，不能自报批准。用户已明确原记录与目标且读到有效版本时，直接提交 assign_record 进入计划审阅卡，不要先在聊天里再问一次确认；只有身份或目标确有歧义时才澄清。无实际变化返回 unchanged；变更后需等待持久保存回执才可声称完成。该动作不修改正文；更新随记正文的既有保护仍有效。';
 return {version,validateAction,inspect,preflight,approvalKeys,contextForRun,instructions,accessibleProjects:state=>Retrieval.accessibleProjects(state)};
});
