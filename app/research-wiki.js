/* Durable research memory lives in ordinary, source-linked Markdown notes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ResearchWiki=api;})(globalThis,()=>{
'use strict';
const TYPES={paper:{zh:'论文',en:'Papers',icon:'▤',fields:{question:'研究问题',method:'方法与贡献',evidence:'原文证据与定位',limitations:'局限与适用范围'}},method:{zh:'方法',en:'Methods',icon:'◇',fields:{principle:'核心原理',assumptions:'前提与适用条件',procedure:'实现与使用步骤',limitations:'局限与反例'}},experiment:{zh:'实验',en:'Experiments',icon:'◉',fields:{hypothesis:'实验假设',setup:'设置与对照',versions:'代码与数据版本',results:'指标与结果',interpretation:'解释与局限'}},failure:{zh:'失败经验',en:'Lessons',icon:'↺',fields:{symptom:'问题与症状',attempts:'尝试与结果',evidence:'日志与证据',conditions:'复现条件与边界'}},review:{zh:'Review 反馈',en:'Reviews',icon:'≋',fields:{feedback:'原始意见与来源',response:'回应与决策',validation:'验证动作与证据',status:'处理状态'}},idea:{zh:'问题与想法',en:'Ideas',icon:'✧',fields:{question:'研究问题',connections:'关联与启发来源',hypothesis:'待验证假设',validation:'验证路径'}}};
Object.assign(TYPES,{
 concept:{zh:'概念',en:'Concepts',icon:'◇',fields:{definition:'定义与范围',distinctions:'相近概念与区别',evidence:'来源与例证'}},
 dataset:{zh:'数据集',en:'Datasets',icon:'▦',fields:{description:'数据与任务',versions:'版本与获取方式',limitations:'许可、偏差与局限'}},
 benchmark:{zh:'评测',en:'Benchmarks',icon:'◷',fields:{task:'评测任务',protocol:'协议与指标',results:'结果与证据',limitations:'可比性与局限'}},
 output:{zh:'研究产出',en:'Outputs',icon:'▤',fields:{purpose:'目标与受众',results:'产出与结论',evidence:'来源与验证',nextSteps:'后续工作'}}
});
function resolveLink(state,id,target){
 if(typeof target!=='string'||/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(target))return null;
 const path=state._wikiFiles?.[id]?.path;if(!path)return null;
 let value;try{value=decodeURIComponent(target.split('#')[0]);}catch{return null;}
 if(!value)return id;
 const parts=path.split('/').slice(0,-1);
 for(const p of value.split('/')){if(!p||p==='.')continue;if(p==='..'){if(!parts.length)return null;parts.pop();}else parts.push(p);}
 const tracked=state._wikiFiles?.[id]?.links?.[target];
 const found=tracked?[tracked,state._wikiFiles[tracked]]:Object.entries(state._wikiFiles||{}).find(([,v])=>v.path===parts.join('/'));
 const note=found&&(state.notes||[]).find(n=>n.id===found[0]&&active(n));
 if(!note||note.projectId&&!(state.projects||[]).some(p=>p.id===note.projectId&&active(p)))return null;
 return note.id;
}
function resolveSource(state,id,href){const note=(state.notes||[]).find(n=>n.id===id&&active(n));if(!note||note.wikiFileError||note.projectId&&!(state.projects||[]).some(p=>p.id===note.projectId&&active(p)))return null;const target=note.wikiSourceLinks?.[href];if(!(note.sourceAttachmentIds||[]).includes(target))return null;const source=(state.imports||[]).find(i=>i.id===target&&active(i));return source&&(!source.projectId||(state.projects||[]).some(p=>p.id===source.projectId&&active(p)))?source:null;}
function linkedNotes(state,note){return [...String(note.content||'').matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(m=>resolveLink(state,note.id,m[1])).filter(Boolean);}
const reads=new WeakMap();
const revision=n=>JSON.stringify([n.id,n.title,n.content,n.kind,n.updatedAt,n.projectId,n.aiDraft]);
const COMMON={observations:'已有观察与依据',inferences:'推断与待验证结论',contradictions:'矛盾、失效结论与适用边界',nextSteps:'下一步与开放问题'};
const active=n=>n&&!n.archived&&!n.archivedAt&&!n.deleted&&!n.deletedAt&&!['archived','deleted'].includes(n.status);
const typeOf=n=>n?.paperId?'paper':n?.wikiFileBacked&&TYPES[n.wikiCategory]?n.wikiCategory:Object.keys(TYPES).find(type=>n?.kind===`科研 Wiki/${type}`)||null;
const fields=type=>({...TYPES[type]?.fields,...COMMON});
const entries=(state,{projectId,query='',type}={})=>(state.notes||[]).filter(n=>active(n)&&typeOf(n)&&(n.workspace==='科研'||(state.projects||[]).some(p=>p.id===n.projectId&&p.workspace==='科研'))&&(!n.projectId||(state.projects||[]).some(p=>p.id===n.projectId&&active(p)))&&(projectId===undefined||(n.projectId||null)===projectId)&&(!type||typeOf(n)===type)&&String(query).toLowerCase().trim().split(/\s+/).every(t=>`${n.title} ${n.content} ${(n.tags||[]).join(' ')}`.toLowerCase().includes(t))).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
function markdown(type,title,sections={}){if(!TYPES[type])throw Error('未知的科研 Wiki 类型');for(const [key,value] of Object.entries(sections)){if(!Object.hasOwn(fields(type),key)||typeof value!=='string')throw Error('Wiki 章节字段无效');}const body=`# ${title}\n\n> ${TYPES[type].zh} · 观察、推断与待验证结论分开记录。\n\n`+Object.entries(fields(type)).map(([key,label])=>`## ${label}\n\n${sections[key]?.trim()||'未记录。'}`).join('\n\n');if(body.length>200000)throw Error('Wiki 正文最多 200,000 字符');return body;}
function trackRead(state,run,result){
 if(result?.type!=='note'||typeof result.text!=='string'||!Number.isSafeInteger(result.offset)||result.offset<0)return;
 const note=entries(state).find(n=>n.id===result.id);if(!note)return;const draft=result.variant==='draft',bucket=draft?'wikiDraftReadVersions':'wikiReadVersions';const text=String(draft?note.aiDraft?.content||'':note.content||'');
 if(text.length!==result.totalChars||text.slice(result.offset,result.offset+result.text.length)!==result.text)return;
 const rev=revision(note),ledger=reads.get(run)||new Map();reads.set(run,ledger);const key=note.id+(draft?':draft':'');let row=ledger.get(key);
 if(!row||row.revision!==rev){row={revision:rev,ranges:[]};ledger.set(key,row);if(run[bucket])delete run[bucket][note.id];}
 row.ranges.push([result.offset,result.offset+result.text.length]);let end=0;for(const [a,b]of row.ranges.slice().sort((a,b)=>a[0]-b[0])){if(a>end)return;end=Math.max(end,b);}if(end>=text.length){run[bucket]||={};run[bucket][note.id]=rev;}
}
function apply(state,action,context){
 const {uid,now=Date.now(),projectId=null}=context,type=action.wikiType;
 if(!TYPES[type])throw Error('未知 wikiType，请使用知识目录提供的类型');
 const title=String(action.title||'').trim();if(!title||title.length>240)throw Error('Wiki 标题需为 1–240 个字符');
 const parent=projectId&&(state.projects||[]).find(p=>p.id===projectId&&active(p));if(projectId&&(!parent||parent.workspace!=='科研'))throw Error('Wiki 只能保存到有效的科研项目');
 const allowed=(kind,id)=>{const n=(state[kind==='note'?'notes':'imports']||[]).find(x=>x.id===id&&active(x));if(!n||n.wikiFileError||n.projectId&&!state.projects.some(p=>p.id===n.projectId&&active(p)))return false;return n.projectId===projectId&&n.workspace==='科研'||!n.projectId&&!projectId&&n.workspace==='科研'||(context.explicitReferences||[]).some(r=>r.type===kind&&r.id===id);};
 const ids=(value,kind)=>{if(!Array.isArray(value||[])||(value||[]).some(id=>typeof id!=='string'||!allowed(kind,id)))throw Error('Wiki 来源不存在、不可用或未被当前项目/明确引用授权');return [...new Set(value||[])];};
 const sourceNoteIds=ids(action.sourceNoteIds,'note'),sourceAttachmentIds=ids(action.sourceAttachmentIds,'import');
 let note=action.noteId?(state.notes||[]).find(n=>n.id===action.noteId):entries(state,{projectId,type}).find(n=>n.title.trim().toLowerCase()===title.toLowerCase());
 if(action.noteId&&!note)throw Error('要更新的 Wiki 已不存在');
 if(note&&(!active(note)||!typeOf(note)||note.paperId||typeOf(note)!==type||(note.projectId||null)!==projectId))throw Error('Wiki 类型或项目不匹配；论文导读请使用现有论文更新流程');
 if(note&&context.protectNoteUpdates!==false){if(context.wikiReadVersions?.[note.id]!==revision(note))throw Error('更新 Wiki 前必须读取当前版本的全部正文，不能遗漏未读章节');if(action.baseUpdatedAt!==note.updatedAt)throw Error('Wiki 版本已变化，请读取最新正文和 updatedAt 后再提出更新');if(note.aiDraft&&context.wikiDraftReadVersions?.[note.id]!==revision(note))throw Error('请用 read 的 variant:draft 读取现有完整草稿后合并补充，无需用户先采纳');for(const key of Object.keys(fields(type)))if(!Object.hasOwn(action.sections||{},key))throw Error('更新 Wiki 需保留全部章节，缺失章节：'+key);}
 const content=markdown(type,title,action.sections||{});if(context.protectNoteUpdates!==false&&!Object.values(action.sections||{}).some(x=>typeof x==='string'&&x.trim()))throw Error('Wiki 需要有实际记录内容');
 if(note){
  if(note.content===content&&note.title===title)return{note,operation:'matched'};
  // References are proposal input provenance; current approved body is unchanged.
  if(note.aiDraft)note.aiDraftHistory=[...(note.aiDraftHistory||[]),{draft:JSON.parse(JSON.stringify(note.aiDraft)),action:'extended',savedAt:now}];
  note.aiDraft={title,content,createdAt:now,sourceAttachmentIds:[...new Set([...(note.sourceAttachmentIds||[]),...(note.aiDraft?.sourceAttachmentIds||[]),...sourceAttachmentIds])],sourceNoteIds:[...new Set([...(note.sourceNoteIds||[]),...(note.aiDraft?.sourceNoteIds||[]),...sourceNoteIds])]};note.updatedAt=Math.max(now,(note.updatedAt||0)+1);
  return{note,operation:'drafted'};
 }
 if((state.notes||[]).some(n=>active(n)&&(n.projectId||null)===projectId&&n.workspace==='科研'&&n.title.trim().toLowerCase()===title.toLowerCase()))throw Error('已有同名笔记，请选择已有条目或使用不同标题');
 note={id:uid('note'),title,content,kind:`科研 Wiki/${type}`,workspace:'科研',projectId,folderPath:`科研 Wiki/${TYPES[type].zh}`,sourceNoteIds,sourceAttachmentIds,tags:['科研 Wiki',TYPES[type].zh],createdAt:now,updatedAt:now,sourceConversationId:context.conversationId,agentRunId:context.runId};state.notes.push(note);return{note,operation:'created'};
}
function related(state,note){const available=n=>active(n)&&(!n.projectId||(state.projects||[]).some(p=>p.id===n.projectId&&active(p)));const ids=[...new Set([...(note.sourceNoteIds||[]),...(note.relatedNoteIds||[]),...linkedNotes(state,note)])];return{sources:ids.map(id=>(state.notes||[]).find(n=>n.id===id&&available(n))||{id,unavailable:true}),backlinks:(state.notes||[]).filter(n=>available(n)&&n.id!==note.id&&[...(n.sourceNoteIds||[]),...(n.relatedNoteIds||[]),...linkedNotes(state,n)].includes(note.id))};}
function catalog(state,scope={},offset=0){if(!Number.isSafeInteger(offset)||offset<0)throw Error('Wiki 分页位置无效');if(scope.workspace&&!['auto','科研'].includes(scope.workspace))return{entries:[],total:0,nextOffset:null};const all=entries(state,scope.projectId?{projectId:scope.projectId}:{}).filter(n=>!scope.projectId||n.projectId===scope.projectId);return{entries:all.slice(offset,offset+20).map(n=>({id:n.id,title:n.title,wikiType:typeOf(n),projectId:n.projectId||null,updatedAt:n.updatedAt,pendingDraft:!!n.aiDraft,unavailable:!!n.wikiFileError})),total:all.length,offset,nextOffset:offset+20<all.length?offset+20:null,contentRead:false};}
function instructions(state,scope){return '\n科研 Wiki 是跨对话保存的研究记忆，以下只是目录而非已核验证据：'+JSON.stringify(catalog(state,scope))+'。用 knowledgeRequests:[{type:"wiki_list",offset:20}] 继续分页；用 read(recordType:"note",id,offset) 读取原文、再读取关联证据。不能把待审阅草稿或模型推断当作已验证事实。仅在用户要求沉淀/保存研究记忆时提交 actions:[{type:"upsert_wiki",wikiType:"experiment",title,projectId,sections:{...},sourceNoteIds:[],sourceAttachmentIds:[],noteId:更新时原ID,baseUpdatedAt:更新时读取版本}]。wikiType 与章节：'+JSON.stringify(Object.fromEntries(Object.entries(TYPES).map(([k,v])=>[k,fields(k)])))+'。缺少依据标明未记录；保留矛盾和失败证据，标明被推翻结论的边界及依据。更新必须读完现有正文、保留全部章节与用户内容，只保存待审阅草稿。已有草稿时使用 read(recordType:"note",id,variant:"draft",offset) 读完草稿并继续合并新材料，不要求用户先采纳；旧草稿由系统保留历史。已有 paperId 的论文导读使用 upsert_paper，不重复生成论文 Wiki。';}
return {TYPES,COMMON,fields,active,typeOf,entries,markdown,apply,related,catalog,instructions,revision,trackRead,resolveLink,resolveSource,linkedNotes};
});
