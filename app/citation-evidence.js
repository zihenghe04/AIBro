/* Immutable request excerpts and explicit answer citations. A returned search
   hit is a reference, never an automatically verified claim. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.CitationEvidence=api;})(globalThis,function(root){
 'use strict';
 const list=x=>Array.isArray(x)?x:[],str=x=>typeof x==='string'?x:'',active=x=>x&&!x.wikiFileError&&!x.deletedAt&&!x.deleted&&!x.archived&&!x.archivedAt&&!['deleted','archived'].includes(x.status);
 const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
 const keys={note:'notes',import:'imports',paper:'papers',task:'tasks'};
 // Keep every supplied identity. Bound only duplicated excerpt text, not page coverage.
 const LIMITS=Object.freeze({characters:262144});
 const instructions='引用证据协议：资料中的 evidenceRef 是本轮已提供片段的来源编号。仅在某句话确实依据该片段时，在该句后写 [[cite:evidenceRef的完整值]]；多个来源分别标注。不得编造编号，不把检索命中、标题、目录或旧摘要当作事实支持。此标记只写在面向用户的 message 中，不写入代码、文件修改或工具参数。没有来源支持就明确说明推断/未核实。引用标记表示来源归属，不代表应用已核验结论。';
 function safeURL(value){try{const u=new URL(str(value));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\u0000-\u001f]/.test(value)?u.href:null;}catch{return null;}}
 function hash(value){let h=2166136261;for(const c of String(value)){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}
 function stableJSON(value){return JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
 const privateItem=value=>!!(value?.private||value?.ephemeral||value?.incognito);
 const matches=(values,id)=>id?list(values).filter(value=>value.id===id):[];
 const privacyMatches=(state,collection,id)=>!id||!collection?[]:[...matches(state[collection],id),...list(state.trash).flatMap(bundle=>[
  ...matches(bundle?.data?.[collection],id),...(collection==='agentRuns'?matches(bundle?.data?.runs,id):[])
 ]),...(collection==='agentRuns'?matches(state.runs,id):[])];
 const sourceIdentity=source=>[source.type==='local'?'projects':keys[source.type],source.type==='local'?source.projectId:source.id];
 function privacyParents(value,lookup){
  return [value.provenance?.origin,...lookup('projects',value.projectId),
   ...lookup('agentRuns',value.agentRunId),...lookup('agentRuns',value.runId),
   ...lookup('conversations',value.sourceConversationId),...lookup('conversations',value.conversationId)].filter(value=>value&&typeof value==='object');
 }
 function sourceIsPrivate(source,lookup,known){
  const [collection,id]=sourceIdentity(source),queue=[source,...lookup(collection,id)],seen=new Set();
  for(let at=0;at<queue.length;at++){
   const value=queue[at];if(!value||seen.has(value))continue;seen.add(value);
   if(known?.nodes.has(value)){if(known.privateNodes.has(value))return true;continue;}
   if(privateItem(value))return true;
   queue.push(...privacyParents(value,lookup));
  }
  return false;
 }
 function resolveAccess(source,lookup,isPrivate){
  const [collection,id]=sourceIdentity(source),records=lookup(collection,id);
  const record=records.length===1?records[0]:null;
  const projectId=source.type==='local'?source.projectId:record?.projectId,projects=lookup('projects',projectId);
  const project=projects.length===1?projects[0]:null;
  if(isPrivate(source))return {kind:'private',available:false,record:null};
  if(source.type==='web')return {kind:'external',available:!!safeURL(source.url),record:null};
  if(!active(record)||projectId&&!active(project)||source.type==='local'&&project?.localFolder?.id!==source.candidateId)return {kind:'missing',available:false,record:null};
  return {kind:'available',available:true,record};
 }
 // Build once per synchronous render/action. Index every duplicate identity,
 // including retired owners, and propagate privacy through the reverse graph.
 // Never retain this context across state changes or an await.
 function createAccessContext(state={}){
  const collections=['projects','notes','imports','papers','tasks','agentRuns','conversations'];
  const live=new Map(),all=new Map(),nodes=new Set(),reverse=new Map(),privateNodes=new Set();
  const insert=(index,name,value)=>{if(!value||typeof value!=='object')return;nodes.add(value);if(!value.id)return;let bucket=index.get(name);if(!bucket)index.set(name,bucket=new Map());let values=bucket.get(value.id);if(!values)bucket.set(value.id,values=[]);values.push(value);};
  for(const name of collections)for(const value of list(state[name])){insert(live,name,value);insert(all,name,value);}
  for(const value of list(state.runs))insert(all,'agentRuns',value);
  for(const bundle of list(state.trash)){
   for(const name of collections)for(const value of list(bundle?.data?.[name]))insert(all,name,value);
   for(const value of list(bundle?.data?.runs))insert(all,'agentRuns',value);
  }
  const lookup=(index,name,id)=>id&&name?index.get(name)?.get(id)||[]:[];
  const parents=value=>privacyParents(value,(name,id)=>lookup(all,name,id));
  const pending=[...nodes];
  for(let at=0;at<pending.length;at++){
   const value=pending[at];if(privateItem(value))privateNodes.add(value);
   for(const parent of parents(value)){
    if(!nodes.has(parent)){nodes.add(parent);pending.push(parent);}
    let children=reverse.get(parent);if(!children)reverse.set(parent,children=new Set());children.add(value);
   }
  }
  const privateQueue=[...privateNodes];
  for(let at=0;at<privateQueue.length;at++)for(const child of reverse.get(privateQueue[at])||[]){if(privateNodes.has(child))continue;privateNodes.add(child);privateQueue.push(child);}
  const current=(name,id)=>lookup(live,name,id),inherited=(name,id)=>lookup(all,name,id);
  return {
   access:(source={})=>resolveAccess(source,current,value=>sourceIsPrivate(value,inherited,{nodes,privateNodes})),
   isAmbiguous:(source={})=>{
    const [collection,id]=sourceIdentity(source),records=current(collection,id);
    if(records.length>1)return true;
    const projectId=source.type==='local'?source.projectId:records[0]?.projectId;
    return !!projectId&&current('projects',projectId).length>1;
   }
  };
 }
 // One access decision for both live previews and immutable request evidence.
 // Resolve privacy before availability, including an archived/deleted owner, so
 // a saved excerpt cannot expose a source merely because its original is gone.
 function access(state={},source={}){
  return resolveAccess(source,(name,id)=>matches(state[name],id),value=>sourceIsPrivate(value,(name,id)=>privacyMatches(state,name,id)));
 }
 function redact(source,state){
  if(access(state,source).kind!=='private')return source;
  return {type:source.type,id:source.id,sourceId:source.sourceId,runId:source.runId,projectId:source.projectId,candidateId:source.candidateId,provided:!!source.provided,number:source.number,private:true,title:t('私密来源','Private source'),excerpt:null};
 }
 function recordFor(state,type,id){const found=access(state,{type,id});return found.available?found.record:null;}
 function body(record,type){if(!record)return '';if(type==='paper')return stableJSON({sections:record.structured||record.sections||{},edits:record.userEdits||{},content:record.content||record.summary||''});return list(record.pages).length?record.pages.map(p=>`[page ${p.page||p.pageNumber||'?'}]\n${p.text||p.content||''}`).join('\n'):String(record.content||record.text||record.extractedText||record.summary||'');}
 function sourceBody(record,source){return source.variant==='draft'?source.type==='note'&&typeof record.aiDraft?.content==='string'?record.aiDraft.content:null:body(record,source.type);}
 const nonnegative=n=>Number.isSafeInteger(n)&&n>=0?n:null;
 function sourceKey(source){return JSON.stringify([source.type,source.id,source.url,source.refKey,source.page,source.offset,source.end,source.variant,source.version,source.excerpt,source.media,source.bodyVariant||'current',source.bodyVariant==='draft'||source.type==='paper'?source.bodyHash:null,source.bodyFormat]);}
 // A capture batch is synchronous. Cache record fingerprints only inside this
 // call, never across a save/edit, and index exact retained strings, not hashes.
 function captureContext(run){
  const values=list(run?.evidenceSources).slice(),known=new Map();let characters=0;
  for(const source of values){characters+=str(source.excerpt).length;if(source.excerptState!=='omitted')known.set(sourceKey(source),source);}
  return {values,known,characters,records:new Map()};
 }
 function capture(run,value,state,context){
  if(!run?.id||!value||!['note','import','paper','task','local','web'].includes(value.type))return null;
  const source={type:value.type,id:str(value.id)||null,title:str(value.title)||str(value.name)||str(value.path)||'Untitled',url:safeURL(value.url),refKey:str(value.refKey)||null,
   page:Number.isSafeInteger(value.page)&&value.page>0?value.page:null,offset:nonnegative(value.offset),end:nonnegative(value.end),variant:value.variant==='draft'?'draft':'current',version:str(value.version)||null,
   excerpt:typeof value.excerpt==='string'?value.excerpt:null,media:['page_image','original_file','original_image'].includes(value.media)?value.media:null,
   projectId:str(value.projectId)||null,candidateId:str(value.candidateId)||null,path:str(value.path)||null,origin:str(value.origin)||'request',capturedAt:Date.now(),provided:true};
  if(!source.id&&!source.url&&!source.refKey)return null;
  if(!source.excerpt&&!source.media)return null; // No fabricated text for identities or empty reads.
  context||=captureContext(run);
  const recordKey=JSON.stringify([source.type,source.id,source.variant]);
  if(!context.records.has(recordKey)){
   const record=recordFor(state,source.type,source.id),content=record?sourceBody(record,source):null;
   context.records.set(recordKey,{record,bodyHash:content===null?null:hash(content)});
  }
  const {record,bodyHash}=context.records.get(recordKey);
  if(record){source.projectId||=str(record.projectId)||null;source.bodyVariant=source.variant;if(bodyHash!==null)source.bodyHash=bodyHash;if(source.type==='paper'&&bodyHash!==null)source.bodyFormat='canonical-v1';source.recordUpdatedAt=record.updatedAt??null;source.url||=safeURL(record.finalUrl||record.url);}
  if(value.textRepresentation==='normalized-page')source.textRepresentation='normalized-page';
  if(source.offset!==null&&source.end===null&&typeof source.excerpt==='string')source.end=source.offset+(source.type==='local'?Array.from(source.excerpt).length:source.excerpt.length);
  const {values,known}=context,key=sourceKey(source),previous=known.get(key);if(previous)return previous;
  if(source.excerpt){
   source.excerptCharacters=source.excerpt.length;
   if(context.characters+source.excerpt.length>LIMITS.characters){
    // The identity is still true: the caller passes only post-budget content.
    // Do not fabricate an old excerpt from current text, or deduplicate an
    // unretained excerpt using a weak fingerprint that cannot prove equality.
    source.excerpt=null;source.excerptState='omitted';run.evidenceExcerptLimitReached=true;
   }else{context.characters+=source.excerpt.length;source.excerptState='retained';}
  }
  source.sourceId=`ev${hash(run.id)}-${values.length+1}`;source.number=values.length+1;
  values.push(source);if(source.excerptState!=='omitted')known.set(key,source);
  run.evidenceSources=values;return source;
 }
 function referenceFor(run,refKey){return list(run.fileReferences).find(ref=>ref.refKey===refKey||JSON.stringify(ref.type==='local'?['local',ref.candidateId,ref.path]:[ref.type,ref.id])===refKey)||{};}
 function captureRetained(run,retained,state,{validateOnly=false}={}){
  const context=validateOnly?null:captureContext(run),accessContext=createAccessContext(state);
  const Knowledge=typeof module==='object'&&module.exports?require('./knowledge-access'):root.KnowledgeAccess;
  const readFailures=Knowledge?.readValidationFailures(list(retained).map(entry=>entry.result),state);
  const denied=entry=>({request:entry.request,result:{error:'资料归属、原文或可读范围已变化，请重新检索',code:'KNOWLEDGE_SOURCE_CHANGED'},...(entry.imagesIncluded!==undefined?{imagesIncluded:false}:{})});
  const allowed=source=>{
   if(!['note','import','paper','task','local'].includes(source.type))return true;
   const current=accessContext.access(source);
   return current.available&&(source.type==='local'||source.projectId===undefined||(source.projectId||null)===(current.record?.projectId||null));
  };
  return list(retained).map(entry=>{
   const request=entry.request||{},result=entry.result||{};if(result.error)return entry;
   if(readFailures?.has(result))return denied(entry);
   const ref=referenceFor(run,result.refKey||request.refKey),base={type:result.type||request.recordType,id:result.id||request.id||ref.id,title:result.title||ref.title,page:result.page,offset:result.offset,version:result.version,variant:result.variant,refKey:result.refKey||request.refKey,projectId:Object.hasOwn(result,'projectId')?result.projectId:ref.projectId,candidateId:ref.candidateId,path:ref.path,origin:request.type};
   if(['read','read_file','read_page'].includes(request.type)&&!allowed(base))return denied(entry);
   if(result.contextPreview!==undefined)return entry;
   if(validateOnly&&!['search','neighbors'].includes(request.type))return entry;
   if(['read','read_file','read_page'].includes(request.type)&&typeof result.text==='string'){
    const end = Number.isSafeInteger(result.offset) ? result.offset + (base.type === 'local' || result.cursorUnit === 'unicode_codepoints' ? Array.from(result.text).length : result.text.length) : undefined;
    const source=capture(run,{...base,end,excerpt:result.text},state,context);return source?{...entry,result:{...result,evidenceRef:source.sourceId}}:entry;
   }
   if(request.type==='read_page'&&entry.imagesIncluded===true){
    const source=capture(run,{...base,type:'import',media:'page_image'},state,context);return source?{...entry,result:{...result,evidenceRef:source.sourceId}}:entry;
   }
   if(['search','neighbors'].includes(request.type)&&Array.isArray(result.entries)){
    const entries=result.entries.filter(row=>allowed({...row,id:row.recordId||row.id})).map(row=>{if(validateOnly)return row;const source=capture(run,{type:row.type,id:row.recordId||row.id,title:row.title,page:row.page,offset:row.chunkOffset??row.offset,end:row.chunkEnd??row.end,version:row.version,excerpt:typeof row.excerpt==='string'?row.excerpt:row.text,projectId:row.projectId,origin:request.type},state,context);return source?{...row,evidenceRef:source.sourceId}:row;});
    return {...entry,result:{...result,entries}};
   }
   return entry;
  });
 }
 // Check every cached result, including those omitted by the model budget,
 // without claiming they were supplied or adding them to the citation archive.
 function validateRetained(run,retained,state){
  const checked=captureRetained(run,retained,state,{validateOnly:true});
  return list(retained).every((entry,i)=>entry.result?.error||checked[i]?.result?.code!=='KNOWLEDGE_SOURCE_CHANGED'&&(!Array.isArray(entry.result?.entries)||!Array.isArray(checked[i]?.result?.entries)||entry.result.entries.length===checked[i].result.entries.length));
 }
 function captureInitial(run,{fileContext,preparedAttachments,recalled,delivery}={},state){
  const found=[],context=captureContext(run);
  for(const part of list(fileContext?.initial)){
   const ref=list(fileContext.snapshots).find(r=>JSON.stringify(r.type==='local'?['local',r.candidateId,r.path]:[r.type,r.id])===part.refKey)||{};
   const source=capture(run,{...ref,...part,id:ref.id||part.refKey,excerpt:part.text,origin:'explicit_reference'},state,context);if(source)found.push(source);
  }
  for(const item of (!delivery||list(delivery?.textAttachments).length?list(preparedAttachments?.attachments):[]))for(const part of list(item.pages)){
   const source=capture(run,{type:'import',id:item.id,title:item.name,page:part.page,excerpt:part.text,origin:'attachment_text',textRepresentation:'normalized-page'},state,context);if(source)found.push(source);
  }
  for(const part of list(recalled?.entries)){
   const source=capture(run,{...part,id:part.recordId||part.id,excerpt:part.text??part.excerpt,origin:'retrieval'},state,context);if(source)found.push(source);
  }
  for(const part of list(delivery?.metadata)){
   if(part.readMode==='pdf_page_images')for(const page of list(part.includedPages)){const source=capture(run,{type:'import',id:part.attachmentId,title:part.name,page,media:'page_image',origin:'attachment_image'},state,context);if(source)found.push(source);}
   else if(['original_file','original_image'].includes(part.readMode)){const source=capture(run,{type:'import',id:part.attachmentId,title:part.name,media:part.readMode,origin:'attachment_original'},state,context);if(source)found.push(source);}
  }
  // Group repeated document identities and omit duplicate body text. All page
  // identifiers remain in the prompt without repeating titles 184+ times.
  const groups=new Map(),seen=new Set();
  for(const source of found){
   if(seen.has(source.sourceId))continue;seen.add(source.sourceId);
   const identity=Object.fromEntries(Object.entries({type:source.type,id:source.id,refKey:source.refKey,title:source.title,variant:source.variant,version:source.version,media:source.media}).filter(([,v])=>v!==null));
   const key=JSON.stringify(identity);if(!groups.has(key))groups.set(key,{...identity,parts:[]});
   const part=Object.fromEntries(Object.entries({evidenceRef:source.sourceId,page:source.page,offset:source.offset,end:source.end}).filter(([,v])=>v!==null));
   if(source.page===null&&source.offset===null&&source.excerpt)part.excerptStart=source.excerpt.slice(0,80);
   groups.get(key).parts.push(part);
  }
  return found.length?'\n本轮已提供的引用编号（各来源 parts 对应已提供片段；仅标识资料，不代表已验证结论）：'+JSON.stringify([...groups.values()]):'';
 }
 const matchingRun=(message,run)=>run?.id&&[message?.runId,message?.pendingRunId,message?.retryRunId].includes(run.id)?run:null;
 // A copied answer keeps attribution without inheriting execution state. This
 // explicit receipt is created only at the branch boundary, never inferred by
 // searching all conversations for a possibly duplicated message identifier.
 function branchOrigin(message){
  const origin=message?.citationOrigin;
  return !message?.runId&&!message?.pendingRunId&&!message?.retryRunId&&!message?.live&&
   ['agent','assistant'].includes(message?.role)&&origin?.version===1&&origin.messageId===message.id&&
   str(origin.runId)&&str(origin.conversationId)?origin:null;
 }
 function runForCitations(message,run,state={}){
  const direct=matchingRun(message,run);if(direct)return direct;
  const origin=branchOrigin(message);if(!origin)return null;
  const runs=matches(state.agentRuns,origin.runId),owners=matches(state.conversations,origin.conversationId);
  return runs.length===1&&owners.length===1&&active(runs[0])&&active(owners[0])&&
   runs[0].conversationId===origin.conversationId?runs[0]:null;
 }
 function originForBranch(message,conversation,state={}){
  if(!message?.id||message.live||!['agent','assistant'].includes(message.role)||
   matches(state.conversations,conversation?.id).length!==1||matches(state.conversations,conversation?.id)[0]!==conversation||
   !list(conversation?.messages).includes(message))return null;
  const id=message.runId||message.pendingRunId||message.retryRunId;
  const candidates=matches(state.agentRuns,id);
  const direct=candidates.length===1&&candidates[0].conversationId===conversation.id?candidates[0]:null;
  const run=runForCitations(message,direct,state);
  if(!active(run)||!list(run.evidenceSources).some(source=>source?.provided===true&&source.sourceId))return null;
  return {version:1,conversationId:run.conversationId,messageId:message.id,runId:run.id};
 }
 // Selecting identities is deliberately independent of the workspace. A closed
 // disclosure needs its count, not source bodies, privacy graphs or fingerprints.
 function sourceEntries(message,run){
  const sources=list(run?.evidenceSources).filter(s=>s?.sourceId&&s.provided===true);
  const refs=[];const add=(value)=>{if(!value.type||(!value.id&&!value.url))return;if(sources.some(s=>s.type===value.type&&(s.id===value.id&&s.page===value.page||s.url&&s.url===value.url)))return;const key=JSON.stringify([value.type,value.id,value.page,value.offset,value.url]);if(refs.some(s=>s.key===key))return;refs.push({...value,key,sourceId:`legacy${hash(key)}`,runId:run?.id||null,provided:false,excerpt:null,number:null});};
  for(const row of list(message?.retrievedSources))add({type:row.type,id:row.id,title:row.title,page:row.page||null,offset:row.offset??null,origin:'legacy_retrieval'});
  for(const row of list(run?.knowledgeReads))if(!row.error&&['read','read_page','neighbors'].includes(row.type))add({type:row.recordType||'import',id:row.id,title:row.title,page:row.page||null,offset:row.offset??null,origin:'legacy_read'});
  for(const row of list(message?.webSources||run?.webSources)){const url=safeURL(row.url);if(url)add({type:'web',url,title:row.title||url,origin:'provider_reference'});}
  return [...sources,...refs];
 }
 function sourcesFor(message,run,state){
  run=runForCitations(message,run,state);
  const origin=branchOrigin(message);
  return sourceEntries(message,run).map(s=>redact({...s,runId:run?.id||origin?.runId||null,
   ...(origin?{sourceConversationId:origin.conversationId}:{}),...(privateItem(run)?{private:true}:{}),title:s.title||recordFor(state,s.type,s.id)?.title||recordFor(state,s.type,s.id)?.name||'Untitled'},state));
 }
 function status(source,state,cache){
  const visibility=access(state,source);
  if(visibility.kind==='private')return {kind:'private',canOpen:false,notice:t('该来源已设为私密，标题与摘录已隐藏。','This source is private. Its title and excerpt are hidden.')};
  if(source.excerptState==='omitted')return {kind:'unretained',canOpen:visibility.available,notice:visibility.available?t('本轮已提供此来源，编号和位置已保留；正文超过摘录保存预算，未留存当时的片段。打开显示当前版本，不能还原或核对旧摘录。','This source was supplied and its identifier and location were saved. Its text exceeded the excerpt storage budget and was not retained. Opening shows the current version, not the old excerpt.'):t('本轮已提供此来源，编号和位置已保留，但未留存正文摘录；原来源现已不可用。','This source was supplied and its identifier and location were saved, but its excerpt was not retained. The original is now unavailable.')};
  if(source.type==='web')return {kind:'external',canOpen:!!safeURL(source.url),notice:t('网页内容可能已变化；本应用未保存该来源的正文摘录。','The web page may have changed. No source excerpt was supplied to this app.')};
  if(source.type==='local'){
   const connected=visibility.available;
   return {kind:connected?'snapshot':'missing',canOpen:connected,notice:connected?t('本轮读取的文件快照；打开后显示磁盘当前版本。','Request-time file snapshot. Opening shows the current disk version.'):t('原项目目录已断开或归档；保留的是本轮旧摘录。','The project folder is disconnected or archived. This is the saved request excerpt.')};
  }
  const record=visibility.record;if(!visibility.available)return {kind:'missing',canOpen:false,notice:t('原来源或所属项目已归档、删除或不可用；保留的是本轮旧摘录。','The original or its project is archived, deleted or unavailable. This is the saved request excerpt.')};
  // Older draft snapshots hashed the approved body. Without an explicit draft
  // marker that hash says nothing about the draft supplied to the request.
  if(source.variant==='draft'&&(!source.provided||source.bodyVariant!=='draft'||!source.bodyHash))return {kind:'draft',canOpen:true,notice:t('这是当时读取的待确认草稿摘录；未保存可用于比较的草稿版本，无法判断当前草稿是否变化。打开原文显示当前笔记。','This is the draft excerpt supplied at request time. No comparable draft version was saved, so changes to the current draft are unknown. Opening shows the current note.')};
  if(source.type==='paper'&&source.bodyHash&&source.bodyFormat!=='canonical-v1')return {kind:source.provided?'snapshot':'reference',canOpen:true,notice:t('这是当时提供的论文摘录；旧版指纹受存储键序影响，无法可靠判断论文内容是否变化。打开显示当前版本。','This is the saved paper excerpt. Its legacy fingerprint depends on storage key order, so content changes cannot be determined reliably. Opening shows the current version.')};
  const key=JSON.stringify([source.type,source.id,source.variant==='draft'?'draft':'current']);let currentHash=cache?.get(key);if(!currentHash&&source.bodyHash){const content=sourceBody(record,source);currentHash=content===null?null:hash(content);cache?.set(key,currentHash);}
  if(source.variant==='draft'&&currentHash!==source.bodyHash)return {kind:'changed',canOpen:true,notice:t('当时读取的草稿已变化或移除；下方保留的是本轮读取的旧草稿摘录。打开原文显示当前笔记。','The draft supplied at request time changed or was removed. The excerpt below is the saved draft excerpt; opening shows the current note.')};
  if(source.provided&&source.bodyHash&&currentHash!==source.bodyHash)return {kind:'changed',canOpen:true,notice:t('原文已变化；下方保留的是本轮读取的旧摘录。打开原文将显示当前版本。','The original changed. The excerpt below is from this request; opening shows the current version.')};
  if(source.variant==='draft')return {kind:'draft',canOpen:true,notice:t('这是当时读取的待确认草稿摘录，打开原文显示当前笔记。','This is the draft excerpt supplied at request time. Opening shows the current note.')};
  return {kind:source.provided?'snapshot':'reference',canOpen:true,notice:source.provided?t('本轮实际提供的来源。引用表示回答的来源标注，请核对摘录是否支持原句。','Source supplied in this request. A citation is attribution; check whether the excerpt supports the claim.'):t('历史记录未保存引用映射与实际摘录，仅作为参考资料。','This historical record has no citation mapping or saved request excerpt. Reference only.')};
 }
 function location(source){if(source.private)return '';return [source.page?t(`第 ${source.page} 页`,`Page ${source.page}`):'',source.offset!==null&&source.offset!==undefined?t(`字符位置 ${source.offset}${source.end!==null&&source.end!==undefined?'–'+source.end:''}`,`Character ${source.offset}${source.end!==null&&source.end!==undefined?'–'+source.end:''}`):'',source.path||'',source.url||''].filter(Boolean).join(' · ');}
 function markers(text,sources){const known=new Map(list(sources).filter(s=>s.provided).map(s=>[s.sourceId,s]));return [...str(text).matchAll(/\[\[cite:([^\]\n]{1,120})\]\]/g)].map(m=>({index:m.index,length:m[0].length,id:m[1],source:known.get(m[1])||null}));}
 function replaceProseMarkers(value,replace){
  // Code spans and fenced blocks are literal content, including unclosed
  // fences during streaming. The export should not rewrite example markers.
  let result='',prose='',fence=null;const flush=()=>{result+=replace(prose);prose='';};
  for(const line of str(value).split(/(?<=\n)/)){
   const match=line.match(/^\s{0,3}(`{3,}|~{3,})/);
   if(fence){result+=line;if(match&&match[1][0]===fence[0]&&match[1].length>=fence.length)fence=null;continue;}
   if(match){flush();fence=match[1];result+=line;continue;}
   let start=0;const pattern=/(`+)([^\n]*?)\1/g;let code;
   while((code=pattern.exec(line))){prose+=line.slice(start,code.index);flush();result+=code[0];start=code.index+code[0].length;}
   prose+=line.slice(start);
  }
  flush();
  return result;
 }
 const documentPrefix='#aibro-source-';
 function documentText(message,run,state){
  const sources=sourcesFor(message,run,state);
  return replaceProseMarkers(message?.text,text=>text.replace(/\[\[cite:([^\]\n]{1,120})\]\]/g,(_,id)=>{
   const matches=sources.filter(source=>source.provided===true&&source.sourceId===id),source=matches.length===1?matches[0]:null;
   if(!source||!access(state,source).available)return t('[引用不可用]','[Source unavailable]');
   const label=Number.isSafeInteger(source.number)&&source.number>0?source.number:t('来源','Source');
   if(source.type==='web'){const url=safeURL(source.url);return url?`[${label}](<${url}>)`:t('[引用不可用]','[Source unavailable]');}
   return ['import','note','paper','task','local'].includes(source.type)?`[${label}](${documentPrefix}${encodeURIComponent(id)})`:t('[引用不可用]','[Source unavailable]');
  }));
 }
 // A document link is authority only within its own durable receipt. Never
 // look up a marker in another run or guess an attachment from a page label.
 function documentSource(state,noteId,href,{variant='body'}={}){
  if(!['body','draft'].includes(variant)||typeof href!=='string'||!href.startsWith(documentPrefix))return null;
  let sourceId;try{sourceId=decodeURIComponent(href.slice(documentPrefix.length));}catch(_){return null;}
  if(!sourceId||sourceId.length>200||/[\u0000-\u0020\u007f]/.test(sourceId))return null;
  const noteAccess=access(state,{type:'note',id:noteId});if(!noteAccess.available)return null;
  const note=noteAccess.record,record=variant==='draft'?note.aiDraft:note,saved=record?.provenance;
  if(saved?.version!==1||saved.output?.type!=='note'||saved.output.id!==noteId||saved.output.variant!==variant||saved.origin?.recorded!==true||!str(saved.origin.runId))return null;
  const matches=list(saved.inputs).filter(input=>input?.sourceId===sourceId),input=matches.length===1?matches[0]:null;
  if(!input||input.provided!==true||!['import','note','paper','task','local'].includes(input.type))return null;
  const source={type:input.type,id:str(input.id)||null,sourceId,provided:true,excerpt:null,
   runId:saved.origin.runId,conversationId:str(saved.origin.conversationId)||null,
   title:str(input.title),projectId:str(input.projectId)||null,variant:input.variant==='draft'?'draft':'current',
   page:Number.isSafeInteger(input.page)&&input.page>0?input.page:null,offset:nonnegative(input.offset),end:nonnegative(input.end),
   ...(saved.origin.private||input.private?{private:true}:{})};
  for(const key of ['candidateId','refKey','path','version','bodyHash','bodyVariant','bodyFormat','excerptState','textRepresentation','media'])if(typeof input[key]==='string')source[key]=input[key];
  for(const key of ['capturedAt','excerptCharacters'])if(nonnegative(input[key])!==null)source[key]=input[key];
  const current=access(state,source);if(!current.available)return null;
  source.title=source.type==='local'?source.path||source.title:str(current.record?.title)||str(current.record?.name)||source.title;
  return source;
 }
 function exportText(message,run,state){
  const sources=sourcesFor(message,run,state),used=new Map();
  const result=replaceProseMarkers(message?.text,text=>text.replace(/\[\[cite:([^\]\n]{1,120})\]\]/g,(_,id)=>{const source=sources.find(s=>s.provided&&s.sourceId===id);if(!source)return t('[引用不可用]','[Source unavailable]');used.set(id,source);return `[${source.number}]`;}));
  if(!used.size)return result;
  return result+'\n\n'+t('引用来源（保存的请求摘录；来源标注不代表结论已经核验）','Sources (saved request excerpts; attribution does not verify a claim)')+'\n\n'+[...used.values()].map(s=>`[${s.number}] ${s.title.replace(/\n/g,' ')}${location(s)?' · '+location(s):''}\n${s.private?t('该来源已设为私密，摘录已隐藏。','This source is private. Its excerpt is hidden.'):s.excerpt?s.excerpt.split('\n').map(line=>'> '+line).join('\n'):s.excerptState==='omitted'?t('本轮已提供此来源，正文超过摘录保存预算，未留存当时片段。','This source was supplied, but its text exceeded the excerpt storage budget and was not retained.'):s.media?t('本轮提供原件或页面图像；未保存文字摘录。','Original or page image supplied; no text excerpt saved.'):t('未保存文字摘录。','No text excerpt saved.')}`).join('\n\n');
 }
 const targets=new WeakMap();
 function bind(button,source,siblings){button.dataset.citationSource=source.sourceId;button.dataset.citationRun=source.runId||'';targets.set(button,{source,siblings});}
 function resolveTarget(state,target){const found=targets.get(target);if(found)return found;const run=list(state?.agentRuns).find(r=>r.id===target?.dataset.citationRun);const source=list(run?.evidenceSources).find(s=>s.sourceId===target?.dataset.citationSource);return source?{source:{...source,runId:run.id},siblings:list(run.evidenceSources).map(s=>({...s,runId:run.id}))}:null;}
 function decorate(bodyElement,message,run,state){
  const sources=sourcesFor(message,run,state),doc=bodyElement.ownerDocument,walker=doc.createTreeWalker(bodyElement,root.NodeFilter?.SHOW_TEXT||4),nodes=[];let node;while((node=walker.nextNode()))if(!node.parentElement.closest('pre,code,a,button,[data-citation-invalid]'))nodes.push(node);
  let count=0;
  const chip=source=>{const button=doc.createElement('button');button.type='button';button.className='citation-chip';button.textContent=source.number||'↗';button.setAttribute('aria-label',t(`查看来源 ${source.number||''}：${source.title}`,`Inspect source ${source.number||''}: ${source.title}`));bind(button,source,sources);return button;};
  for(const node of nodes){const matches=markers(node.data,sources);if(!matches.length)continue;const fragment=doc.createDocumentFragment();let start=0;for(const match of matches){fragment.append(doc.createTextNode(node.data.slice(start,match.index)));if(match.source){fragment.append(chip(match.source));count++;}else{const missing=doc.createElement('span');missing.className='citation-invalid';missing.dataset.citationInvalid='';missing.textContent=t('〔引用不可用〕','[Source unavailable]');missing.title=t('此编号没有对应的本轮来源记录。','No source from this request matches this identifier.');fragment.append(missing);}start=match.index+match.length;}fragment.append(doc.createTextNode(node.data.slice(start)));node.replaceWith(fragment);}
  // An answer's explicit Markdown URL is attribution. Provider offsets refer
  // to raw response JSON, so never guess a claim span from those offsets.
  for(const link of bodyElement.querySelectorAll('a[href]')){const url=safeURL(link.getAttribute('href')),source=sources.find(s=>s.url===url);if(!source||link.dataset.citationLinked)continue;link.dataset.citationLinked='true';const button=chip(source);button.classList.add('citation-web-chip');link.after(button);count++;}
  return {count,sources};
 }
 // Presentation-only evidence metadata. Attachment delivery records describe
 // prepared representations, not proof that the provider received or read them.
 function evidenceModel(message,run,state={}){
  run=matchingRun(message,run);
  const cache=new Map(),sources=sourcesFor(message,run,state).map(source=>({...source,location:location(source),status:status(source,state,cache)}));
  const coverage=run?.retrievalCoverage,delivery=run?.attachmentDelivery,textCoverage=run?.attachmentCoverage;
  const metric=(label,value)=>nonnegative(value)===null?null:{label,value};
  const compact=values=>values.filter(Boolean);
  const recordedEntries=Array.isArray(message?.retrievedSources)?[...new Map(message.retrievedSources.filter(x=>x&&typeof x==='object').map(x=>[x.chunkId||JSON.stringify([x.type,x.id,x.page,x.offset]),x])).values()]:null;
  const indexed=['hybrid-rrf','local-bm25'].includes(coverage?.strategy);
  let retrieval=null;
  if(indexed||coverage&&coverage.strategy!=='not-requested'&&['eligibleRecords','returnedChunks','returnedRecords'].some(key=>nonnegative(coverage[key])!==null)||recordedEntries?.length){
   retrieval={strategy:str(coverage?.strategy),metrics:compact([
    metric(t('索引条目','Indexed records'),coverage?.eligibleRecords),
    metric(t('原始文件','Original files'),coverage?.originalFiles),
    metric(t('正文已索引','Text indexed'),coverage?.textIndexedRecords),
    metric(t('仅文件信息','Metadata only'),coverage?.metadataOnlyRecords),
    metric(t('保存的检索段落','Saved search excerpts'),recordedEntries?.length??coverage?.returnedChunks),
    metric(t('检索来源条目','Search source records'),recordedEntries?.every(x=>x.type&&x.id)?new Set(recordedEntries.map(x=>JSON.stringify([x.type,x.id]))).size:coverage?.returnedRecords)
   ]),notes:[t('索引范围与返回段落不代表已核对原件；来源摘录中的编号用于核对回答归属。','Index coverage and returned excerpts do not establish that originals were checked. Source identifiers let you inspect attribution.')]};
   if(coverage?.semanticStatus==='unavailable')retrieval.notes.push(t('语义服务暂不可用，本轮使用关键词检索。','Semantic search was unavailable; this request used keyword search.'));
   else if(coverage?.semanticStatus==='not-indexed')retrieval.notes.push(t('向量索引尚未建立，本轮使用关键词检索。','The vector index was not ready; this request used keyword search.'));
   else if(coverage?.strategy==='hybrid-rrf'){
    const ready=nonnegative(coverage.vectorReady),total=nonnegative(coverage.vectorTotal);
    if(ready!==null&&total!==null)retrieval.notes.push(t(`混合检索：有效向量段落 ${ready} / ${total}。`,`Hybrid search: ${ready} / ${total} vector excerpts ready.`));
   }
   if(nonnegative(coverage?.nextOffset)!==null)retrieval.notes.push(t('还有搜索结果可继续检索。','More search results are available.'));
   if(coverage?.truncated===true)retrieval.notes.push(t('本轮检索内容为部分摘录。','Only partial search excerpts were retained.'));
  }
  let attachments=null;
  const deliveryKnown=delivery&&typeof delivery==='object'&&(['prepared_representations'].includes(delivery.scope)||['totalAttachments','originalFiles','originalImages','pdfPageImages','textAttachments'].some(key=>nonnegative(delivery[key])!==null));
  const textKnown=textCoverage?.scope==='extracted_text'&&nonnegative(textCoverage.totalAttachments)>0;
  if(textKnown||deliveryKnown&&(list(run?.attachmentIds).length||['totalAttachments','originalFiles','originalImages','pdfPageImages','textAttachments'].some(key=>nonnegative(delivery[key])>0))){
   const refs=[...new Set(list(run.attachmentIds).filter(id=>typeof id==='string'&&id))].map(id=>{
    const record=recordFor(state,'import',id),source=redact({type:'import',id,sourceId:`attachment${hash(id)}`,runId:run.id,private:privateItem(run),provided:false,number:null,excerpt:null,title:record?.name||record?.originalName||t('附件原件不可用','Attachment original unavailable'),origin:'attachment_metadata'},state);
    return {...source,status:status(source,state,cache),location:''};
   });
   attachments={metrics:compact([
    metric(t('附件记录','Attachment records'),delivery?.totalAttachments),
    metric(t('文件原件','Original files'),delivery?.originalFiles),
    metric(t('原始图片','Original images'),delivery?.originalImages),
    metric(t('PDF 页面图像','PDF page images'),delivery?.pdfPageImages),
    metric(t('文字模式附件','Text-mode attachments'),delivery?.textAttachments)
   ]),sources:refs,notes:[t('以下记录的是本轮准备的附件形式；准备完成不代表模型已经收到或逐份读完。','These records describe the attachment representations prepared for this request, not confirmation that the model received or read each one.')]};
   if(textCoverage?.scope==='extracted_text'&&(nonnegative(delivery?.textAttachments)>0||nonnegative(textCoverage.totalAttachments)>0)){
    attachments.textMetrics=compact([metric(t('文字模式附件','Text-mode attachments'),textCoverage.totalAttachments),metric(t('包含文字的附件','Attachments with included text'),textCoverage.includedAttachments),metric(t('包含文字的页面','Pages with included text'),textCoverage.includedPages)]);
    if(textCoverage.complete===false)attachments.notes.push(t('附件文字只覆盖部分内容，请结合原件核对缺页和提取限制。','Attachment text covers only part of the content. Check the originals for missing pages and extraction limits.'));
    else if(textCoverage.complete===true)attachments.notes.push(t('记录中的提取文字已完整纳入；这不证明原件中的图像、公式或版面已被读取。','All recorded extracted text was included. This does not establish that images, formulas or layout in the original were read.'));
   }
   if(nonnegative(delivery?.pdfTextAttachments)>0)attachments.notes.push(t('本轮选择 PDF 文字读取：不发送 PDF 原件或页面图像，也不执行 OCR。首轮提取索引可能不完整，后续按页读取的范围见来源记录。','PDF text reading was selected: no PDF originals, page images, or OCR. The initial extraction may be incomplete; see the source records for subsequent page reads.'));
   if(Array.isArray(delivery?.textUnavailable)&&delivery?.textUnavailable.length)attachments.notes.push(t(`${delivery?.textUnavailable.length} 份文字模式附件没有可用文字。`,`${delivery?.textUnavailable.length} text-mode attachments had no available text.`));
  }
  return {sources,retrieval,attachments,limited:!!run?.evidenceLimitReached,excerptLimited:!!run?.evidenceExcerptLimitReached,hasContent:!!(sources.length||retrieval||attachments)};
 }
 function evidenceOutline(message,run,state){
  run=matchingRun(message,run);
  const coverage=run?.retrievalCoverage,delivery=run?.attachmentDelivery,textCoverage=run?.attachmentCoverage;
  const sourceCount=sourceEntries(message,runForCitations(message,run,state)).length;
  const retrieval=['hybrid-rrf','local-bm25'].includes(coverage?.strategy)||
   !!(coverage&&coverage.strategy!=='not-requested'&&['eligibleRecords','returnedChunks','returnedRecords'].some(key=>nonnegative(coverage[key])!==null))||
   list(message?.retrievedSources).some(value=>value&&typeof value==='object');
  const deliveryKnown=delivery&&typeof delivery==='object'&&(['prepared_representations'].includes(delivery.scope)||['totalAttachments','originalFiles','originalImages','pdfPageImages','textAttachments'].some(key=>nonnegative(delivery[key])!==null));
  const attachments=textCoverage?.scope==='extracted_text'&&nonnegative(textCoverage.totalAttachments)>0||
   !!(deliveryKnown&&(list(run?.attachmentIds).length||['totalAttachments','originalFiles','originalImages','pdfPageImages','textAttachments'].some(key=>nonnegative(delivery[key])>0)));
  return {sourceCount,hasContent:!!(sourceCount||retrieval||attachments)};
 }
 const panels=new WeakMap();
 function panelProps(model){
  const all=[...model.sources,...(model.attachments?.sources||[])];
  const bindCurrent=(source,target)=>{const current=all.find(value=>value.sourceId===source?.sourceId);if(!current||!target)return false;bind(target,current,model.sources.some(value=>value.sourceId===current.sourceId)?model.sources:all);return true;};
  return {...model,onBind:bindCurrent,onInspect:(source,target)=>{if(bindCurrent(source,target))root.SourcePeek?.show?.(target);}};
 }
 const outlineLabel=outline=>outline.sourceCount?t(`来源与证据 · ${outline.sourceCount} 项`,`Sources and evidence · ${outline.sourceCount}`):t('来源与证据','Sources and evidence');
 function emptyPanel(host){for(const child of [...(host.childNodes||host.children||[])])child.remove();host.textContent='';}
 function clearPanel(record){
  for(const button of record.host.querySelectorAll('[data-citation-source]'))targets.delete(button);
  record.island?.unmount();record.island=null;record.model=null;record.props=null;emptyPanel(record.host);record.details.dataset.citationDeferred='';
 }
 function panelContext(record){
  if(record.disposed)return null;
  // A host callback must resolve the current owning conversation/message/run.
  // Missing or ambiguous owners fail closed rather than reviving a saved object.
  let value;try{value=record.getContext?record.getContext():record.context;}catch{return null;}
  return value?.message?.id===record.messageId&&value.state&&typeof value.state==='object'?value:null;
 }
 function populatePanel(record){
  if(record.disposed||record.deferred)return;
  const context=panelContext(record);
  const model=context?evidenceModel(context.message,context.run,context.state):null;
  if(!model?.hasContent){
   clearPanel(record);const text=root.document.createElement('p');text.textContent=t('来源记录已不可用。','The source record is no longer available.');record.host.append(text);return;
  }
  const props=panelProps(model);record.model=model;record.props=props;delete record.details.dataset.citationDeferred;
  record.summary.textContent=outlineLabel({sourceCount:model.sources.length});
  if(record.island)record.island.update(props);
  else if(root.HalaskaUI?.componentNames?.includes('CitationSourceList')){emptyPanel(record.host);record.island=root.HalaskaUI.mount(record.host,'CitationSourceList',props);}
  else {emptyPanel(record.host);const text=root.document.createElement('p');text.textContent=t('来源界面尚未加载。','The source viewer is not loaded.');record.host.append(text);}
  // An already focused button may not receive another focus event after a
  // streaming update. Refresh its binding against this exact model as well.
  const sources=[...model.sources,...(model.attachments?.sources||[])];
  for(const button of record.host.querySelectorAll('[data-citation-source]')){
   const source=sources.find(value=>value.sourceId===button.dataset.citationSource);
   if(source)props.onBind(source,button);else targets.delete(button);
  }
 }
 function retirePanel(record,{preserveHost=false}={}){
  record.disposed=true;record.details.removeEventListener?.('toggle',record.onToggle);
  if(!preserveHost)clearPanel(record);
  record.context=null;record.getContext=null;record.model=null;record.props=null;
 }
 function section(message,run,state,{previous,getContext,search=false}={}){
  const outline=evidenceOutline(message,run,state);if(!outline.hasContent)return null;
  const doc=root.document,details=doc.createElement('details');details.className='message-steps citation-sources';details.dataset.citationPanel=message?.id||'';details.dataset.citationDeferred='';details.dataset.liveKey='citation-evidence';details.open=message?.evidenceOpen===true;
  const summary=doc.createElement('summary');summary.textContent=outlineLabel(outline);details.append(summary);
  summary.addEventListener('keydown',event=>{if(event.target!==summary||event.key!=='Enter'||event.repeat||event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;event.preventDefault();summary.click();});
  const host=doc.createElement('div');host.className='citation-panel-content';details.append(host);
  const priorDetails=previous?.matches?.('details[data-citation-panel]')?previous:previous?.querySelector?.(':scope > details[data-citation-panel]');
  const prior=priorDetails?.dataset.citationPanel===details.dataset.citationPanel?panels.get(priorDetails):null;
  const record={details,summary,host,messageId:message?.id,context:typeof getContext==='function'?null:{message,run,state},getContext:typeof getContext==='function'?getContext:null,props:null,model:null,island:null,deferred:false,disposed:false};
  // A staged live render is not a second owner. The retained panel decides
  // whether it is open when patchSection commits the new context.
  if(prior&&!prior.deferred&&(prior.island||!priorDetails.open))record.deferred=true;
  record.onToggle=event=>{
   if(event.target!==details||record.disposed||record.deferred||details.isConnected===false)return;
   if(details.open){if(!record.model)populatePanel(record);}else clearPanel(record);
  };
  details.addEventListener('toggle',record.onToggle);
  panels.set(details,record);
  // Search has always included source titles inside closed disclosures. Its
  // detached scratch renderer explicitly opts in; ordinary closed rows do not.
  if((details.open||search)&&!record.deferred)populatePanel(record);
  return details;
 }
 function patchSection(previous,next){
  const old=panels.get(previous),fresh=panels.get(next);
  if(!old||!fresh||previous.dataset.citationPanel!==next.dataset.citationPanel)return false;
  old.context=fresh.context;old.getContext=fresh.getContext;old.deferred=false;
  const oldSummary=previous.querySelector(':scope > summary'),newSummary=next.querySelector(':scope > summary');
  if(oldSummary&&newSummary&&oldSummary.textContent!==newSummary.textContent)oldSummary.textContent=newSummary.textContent;
  let transferred=false;
  if(!previous.open)clearPanel(old);
  else if(!old.island&&fresh.island){
   // If the kit became available after the fallback rendered, transfer the
   // entire owned host and its root; never transplant React-owned children.
   old.host.replaceWith(fresh.host);old.host=fresh.host;old.island=fresh.island;old.model=fresh.model;old.props=fresh.props;delete previous.dataset.citationDeferred;fresh.island=null;transferred=true;
  }
  else populatePanel(old);
  // Keep outer/secondary disclosures, pagination, selection and focus in the
  // retained open React root. A closed panel retains no expensive model/root.
  retirePanel(fresh,{preserveHost:transferred});panels.delete(next);
  return true;
 }
 function discard(wrapper){
  if(!wrapper)return;
  const found=[...(wrapper.querySelectorAll?.('details[data-citation-panel]')||[])];
  if(wrapper.matches?.('details[data-citation-panel]'))found.unshift(wrapper);
  for(const details of found){const record=panels.get(details);if(!record)continue;retirePanel(record);panels.delete(details);}
 }
 function materializeForSearch(wrapper){
  // Search indexing uses a scratch model. Only selecting a result that cannot
  // be found in the current DOM should expand the real source disclosure.
  if(!wrapper)return false;let changed=false;
  const found=[...(wrapper.querySelectorAll?.('details[data-citation-panel]')||[])];
  if(wrapper.matches?.('details[data-citation-panel]'))found.unshift(wrapper);
  for(const details of found){
   const record=panels.get(details);if(!record||record.disposed||record.deferred||details.isConnected===false||details.dataset.citationDeferred===undefined)continue;
   populatePanel(record);if(record.model?.hasContent){details.open=true;changed=true;}
  }
  return changed;
 }
 function reveal(source,container){
  if(!container||!source.excerpt)return false;
  const doc=container.ownerDocument,walker=doc.createTreeWalker(container,root.NodeFilter?.SHOW_TEXT||4),parts=[];let node,text='';while((node=walker.nextNode())){if(node.parentElement.closest('button,script,style,[hidden]'))continue;parts.push({node,start:text.length});text+=node.data;}
  const candidates=source.excerpt.replace(/^\[第 \d+ 页\]\n/,'').split('\n').map(s=>s.trim().replace(/^#{1,6}\s+|^[-*]\s+/,'')).filter(s=>s.length>=8).sort((a,b)=>b.length-a.length);let at=-1,quote='';for(const candidate of candidates){quote=candidate.slice(0,180);at=text.indexOf(quote);if(at>=0&&text.indexOf(quote,at+1)===-1)break;at=-1;}if(at<0)return false;
  const first=parts.find(p=>p.start<=at&&p.start+p.node.data.length>at),last=parts.find(p=>p.start<at+quote.length&&p.start+p.node.data.length>=at+quote.length);if(!first||!last)return false;
  const range=doc.createRange();range.setStart(first.node,at-first.start);range.setEnd(last.node,at+quote.length-last.start);if(root.CSS?.highlights&&root.Highlight)root.CSS.highlights.set('citation-location',new root.Highlight(range));first.node.parentElement.scrollIntoView({block:'center',behavior:'instant'});return true;
 }
 return {LIMITS,instructions,safeURL,access,createAccessContext,redact,capture,captureInitial,captureRetained,validateRetained,runForCitations,originForBranch,sourcesFor,status,location,markers,documentText,documentSource,exportText,recordFor,body,decorate,evidenceModel,evidenceOutline,section,patchSection,discard,materializeForSearch,bind,resolveTarget,reveal};
});
