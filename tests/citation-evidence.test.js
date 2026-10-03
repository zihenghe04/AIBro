const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../app/citation-evidence'),K=require('../app/knowledge-access');
const state=()=>({notes:[{id:'n1',title:'证据文档',content:'开头不相关。\n这里是实际读取的证据。\n末尾。',updatedAt:1}],imports:[{id:'pdf1',name:'报告.pdf',pages:[{page:7,text:'实际第七页。'}]}],projects:[]});
test('paper evidence uses canonical body keys across JSON persistence and captures real changes separately',()=>{
 const s=state(),run={id:'r'};s.papers=[{id:'p1',title:'论文',structured:{z:{second:2,first:1},a:'方法'},userEdits:{summary:'总结',problem:'问题'}}];
 const value={type:'paper',id:'p1',excerpt:'方法'},source=E.capture(run,value,s);
 const restored=JSON.parse(JSON.stringify(s,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item));
 assert.equal(source.bodyFormat,'canonical-v1');assert.equal(E.status(source,restored).kind,'snapshot');assert.equal(E.capture(run,value,restored).sourceId,source.sourceId);
 restored.papers[0].structured.z.first=8;assert.equal(E.status(source,restored).kind,'changed');
 const current=E.capture(run,value,restored);assert.notEqual(current.sourceId,source.sourceId);assert.equal(E.status(current,restored).kind,'snapshot');
});
test('legacy paper evidence remains available but its key-order-dependent version is explicitly unknown',()=>{
 const s=state(),run={id:'r'};s.papers=[{id:'p1',title:'论文',structured:{z:1,a:2}}];const value={type:'paper',id:'p1',excerpt:'旧摘录'},source=E.capture(run,value,s);delete source.bodyFormat;
 const result=E.status(source,s);assert.equal(result.kind,'snapshot');assert.equal(result.canOpen,true);assert.match(result.notice,/无法可靠判断/);
 const fresh=E.capture(run,value,s);assert.notEqual(fresh.sourceId,source.sourceId);assert.equal(fresh.bodyFormat,'canonical-v1');
});
const read=(text='这里是实际读取的证据。')=>({request:{type:'read',recordType:'note',id:'n1'},result:{type:'note',id:'n1',title:'证据文档',offset:7,text,version:'v1'}});
test('PDF page text becomes exact retained evidence with page and Unicode cursor, never an image claim',()=>{
 const s=state(),run={id:'text-run'},entry={request:{type:'read_page',recordType:'import',id:'pdf1',page:7,offset:4},result:{type:'import',id:'pdf1',page:7,offset:4,text:'A😀B',cursorUnit:'unicode_codepoints',readMode:'extracted_text',imagesIncluded:false}};
 const supplied=E.captureRetained(run,[entry],s);
 assert.ok(supplied[0].result.evidenceRef);
 assert.equal(run.evidenceSources[0].excerpt,'A😀B');assert.equal(run.evidenceSources[0].page,7);
 assert.equal(run.evidenceSources[0].offset,4);assert.equal(run.evidenceSources[0].end,7);
 assert.equal(run.evidenceSources[0].media,null);
 const empty={id:'empty'};E.captureRetained(empty,[{...entry,result:{...entry.result,text:'',textAvailable:false}}],s);
 assert.equal((empty.evidenceSources||[]).length,0);
});
test('only exact retained text is snapshotted and stable IDs survive repeat inclusion',()=>{const s=state(),run={id:'run1'},input=[read()];const a=E.captureRetained(run,input,s),b=E.captureRetained(run,input,s);assert.equal(run.evidenceSources.length,1);assert.equal(a[0].result.evidenceRef,b[0].result.evidenceRef);assert.equal(run.evidenceSources[0].excerpt,input[0].result.text);assert.equal(input[0].result.evidenceRef,undefined);s.notes[0].content='new';assert.equal(run.evidenceSources[0].excerpt,'这里是实际读取的证据。');assert.equal(E.status(run.evidenceSources[0],s).kind,'changed');});
test('modified and deleted source never replaces the request excerpt',()=>{const s=state(),run={id:'run1'};E.captureRetained(run,[read()],s);const source=run.evidenceSources[0];s.notes[0].deletedAt=99;const status=E.status(source,s);assert.equal(status.kind,'missing');assert.equal(status.canOpen,false);assert.match(status.notice,/旧摘录/);assert.equal(source.excerpt,'这里是实际读取的证据。');});
test('draft captures hash the actual pending draft and detect draft-only edits',()=>{
 const s=state(),run={id:'r'};s.notes[0].aiDraft={content:'待确认草稿的原始证据。'};
 const entry=read(s.notes[0].aiDraft.content);entry.request.variant='draft';entry.result.variant='draft';
 E.captureRetained(run,[entry],s);const source=run.evidenceSources[0],saved=JSON.stringify(source);
 const approved=E.capture(run,{type:'note',id:'n1',excerpt:s.notes[0].content},s);
 assert.equal(source.bodyVariant,'draft');assert.equal(approved.bodyVariant,'current');assert.notEqual(source.bodyHash,approved.bodyHash);assert.equal(E.status(source,s).kind,'draft');
 s.notes[0].aiDraft.content='仅草稿改变，正式正文保持原样。';
 assert.equal(E.status(source,s).kind,'changed');assert.equal(E.status(source,s).canOpen,true);assert.equal(E.status(approved,s).kind,'snapshot');assert.equal(JSON.stringify(source),saved);
});
test('removed or invalid pending drafts are changed without replacing saved excerpts',()=>{
 for(const replacement of [undefined,null,{}, {content:null}]){const s=state(),run={id:'r'};s.notes[0].aiDraft={content:'当时读取的草稿。'};const source=E.capture(run,{type:'note',id:'n1',variant:'draft',excerpt:s.notes[0].aiDraft.content},s);s.notes[0].aiDraft=replacement;const status=E.status(source,s);assert.equal(status.kind,'changed');assert.equal(status.canOpen,true);assert.match(status.notice,/草稿已变化或移除/);assert.equal(source.excerpt,'当时读取的草稿。');}
});
test('approved and draft comparisons use independent bodies and cache entries',()=>{
 for(const order of ['current-first','draft-first']){const s=state(),run={id:'r'};s.notes[0].aiDraft={content:'独立的待确认草稿。'};
  const current=E.capture(run,{type:'note',id:'n1',excerpt:s.notes[0].content},s),draft=E.capture(run,{type:'note',id:'n1',variant:'draft',excerpt:s.notes[0].aiDraft.content},s);
  s.notes[0].content='只修改正式正文。';s.notes[0].updatedAt=2;const cache=new Map(),sources=order==='current-first'?[current,draft]:[draft,current];
  for(const source of sources)assert.equal(E.status(source,s,cache).kind,source.variant==='draft'?'draft':'changed',order);
 }
});
test('legacy draft hashes never compare the approved body as evidence of draft changes',()=>{
 const s=state(),run={id:'r'};const source={...E.capture(run,{type:'note',id:'n1',excerpt:'历史草稿摘录。'},s),variant:'draft'};delete source.bodyVariant;const saved=JSON.stringify(source);
 for(const draft of [{content:'当前草稿。'},null]){s.notes[0].aiDraft=draft;for(const body of [s.notes[0].content,'正式正文后来也变化了。']){s.notes[0].content=body;const status=E.status(source,s,new Map());assert.equal(status.kind,'draft');assert.equal(status.canOpen,true);assert.match(status.notice,/无法判断当前草稿是否变化/);}}
 assert.equal(JSON.stringify(source),saved);
});
test('fresh draft versions do not reuse legacy or older draft version identities',()=>{
 const s=state(),run={id:'r'};s.notes[0].aiDraft={content:'同一摘录。草稿的其他内容。'};
 const value={type:'note',id:'n1',variant:'draft',excerpt:'同一摘录。'},legacy={...E.capture(run,value,s)};delete legacy.bodyVariant;run.evidenceSources=[legacy];
 const current=E.capture(run,value,s);assert.notEqual(current.sourceId,legacy.sourceId);assert.equal(current.bodyVariant,'draft');assert.equal(E.capture(run,value,s).sourceId,current.sourceId);
 s.notes[0].aiDraft.content+='新增内容。';const revised=E.capture(run,value,s);assert.notEqual(revised.sourceId,current.sourceId);assert.equal(E.status(current,s).kind,'changed');assert.equal(E.status(revised,s).kind,'draft');assert.equal(legacy.bodyVariant,undefined);
});
test('draft snapshots without an available draft body preserve unknown comparison',()=>{
 const s=state(),run={id:'r'},source=E.capture(run,{type:'note',id:'n1',variant:'draft',excerpt:'已经送入请求的草稿摘录。'},s);
 assert.equal(source.bodyVariant,'draft');assert.equal(source.bodyHash,undefined);assert.equal(E.status(source,s).kind,'draft');assert.match(E.status(source,s).notice,/无法判断当前草稿是否变化/);
 s.notes[0].aiDraft={content:source.excerpt};assert.equal(E.status(source,s).kind,'draft');assert.match(E.status(source,s).notice,/无法判断当前草稿是否变化/);
});
test('text revisions on the same page get distinct evidence IDs',()=>{const s=state(),run={id:'r'};const a=E.captureRetained(run,[read('A')],s)[0].result.evidenceRef,b=E.captureRetained(run,[read('B')],s)[0].result.evidenceRef;assert.notEqual(a,b);assert.equal(run.evidenceSources.length,2);});
test('read-page image is attributable only when image blocks were retained',()=>{const s=state(),run={id:'r'},base={request:{type:'read_page',recordType:'import',id:'pdf1'},result:{type:'import',id:'pdf1',page:7,title:'报告.pdf',originalRead:true}};E.captureRetained(run,[{...base,imagesIncluded:false}],s);assert.equal(run.evidenceSources,undefined);const out=E.captureRetained(run,[{...base,imagesIncluded:true}],s);assert.ok(out[0].result.evidenceRef);assert.equal(run.evidenceSources[0].page,7);assert.equal(run.evidenceSources[0].excerpt,null);assert.equal(run.evidenceSources[0].media,'page_image');});
test('search excerpts and neighbor text capture positions, not fake verification',()=>{const s=state(),run={id:'r'},out=E.captureRetained(run,[{request:{type:'search'},result:{entries:[{type:'import',id:'pdf1',chunkId:'c7',page:7,chunkOffset:101,chunkEnd:108,excerpt:'实际第七页。'}]}}],s);assert.ok(out[0].result.entries[0].evidenceRef);assert.equal(run.evidenceSources[0].offset,101);assert.equal(run.evidenceSources[0].end,108);assert.equal(run.evidenceSources[0].verified,undefined);assert.match(E.location(run.evidenceSources[0]),/第 7 页.*101–108/);});
test('errors, catalogs, empty reads, bounded generic previews never create citations',()=>{const run={id:'r'},s=state();E.captureRetained(run,[{...read(),result:{error:'missing'}},{request:{type:'list'},result:{entries:[{id:'n1',type:'note',title:'Title'}]}},read(''),{...read(),result:{text:'huge',contextPreview:'truncated'}}],s);assert.equal(run.evidenceSources,undefined);});
test('historical reference lists have no invented excerpts or inline mappings',()=>{const s=state(),run={id:'old',knowledgeReads:[{type:'read',recordType:'note',id:'n1',offset:7}]},message={runId:'old',retrievedSources:[{type:'note',id:'n1'}],webSources:[{url:'https://example.com/doc',title:'Web'},{url:'javascript:evil'}]};const sources=E.sourcesFor(message,run,s);assert.equal(sources.length,3);assert.ok(sources.every(x=>!x.provided&&x.excerpt===null&&x.number===null));assert.equal(E.markers('Claim [[cite:'+sources[0].sourceId+']]',sources)[0].source,null);});
test('a different run cannot resolve a marker even if its source ID exists',()=>{const s=state(),run={id:'r1'};E.captureRetained(run,[read()],s);const id=run.evidenceSources[0].sourceId;assert.equal(E.sourcesFor({runId:'other'},run,s).length,0);assert.equal(E.sourcesFor({},run,s).length,0);const sources=E.sourcesFor({runId:'r1'},run,s);assert.equal(E.markers(`原句 [[cite:${id}]]`,sources)[0].source.sourceId,id);assert.equal(E.markers('无映射 [[cite:invented]]',sources)[0].source,null);});
test('initial manifest includes only actual supplied attachment mode and exact explicit text',()=>{const s=state(),run={id:'r'},initial={fileContext:{initial:[{type:'note',refKey:'["note","n1"]',text:'片段',offset:11}],snapshots:[{type:'note',id:'n1',title:'Saved',version:'v'}]},preparedAttachments:{attachments:[{id:'pdf1',name:'P',pages:[{page:7,text:'this was not sent'}]}]},delivery:{textAttachments:[],metadata:[{attachmentId:'pdf1',name:'P',readMode:'pdf_page_images',includedPages:[7]}]}};const manifest=E.captureInitial(run,initial,s);assert.match(manifest,/evidenceRef/);assert.equal(run.evidenceSources.length,2);assert.equal(run.evidenceSources[0].excerpt,'片段');assert.equal(run.evidenceSources[1].media,'page_image');assert.ok(!run.evidenceSources.some(x=>x.excerpt==='this was not sent'));});
test('raw unsafe or credentialed URLs cannot become clickable sources',()=>{for(const url of ['javascript:alert(1)','data:text/html,hi','https://user:pass@example.com','https://example.com/\nfoo'])assert.equal(E.safeURL(url),null);assert.equal(E.safeURL('https://example.com/a#part'),'https://example.com/a#part');});
test('all supplied page identities survive the former 128-source cutoff and JSON restart',()=>{
 const A=require('../app/attachment-context'),s=state(),run={id:'four-chapters'};
 const attachments=Array.from({length:4},(_,chapter)=>({id:'chapter'+chapter,name:'Chapter '+chapter,pageCount:60,pages:Array.from({length:60},(_,n)=>({page:n+1,text:'page '+(n+1)+'\nword  spacing 😀 '.repeat(4)}))}));
 s.imports=attachments;
 const prepared=A.build(attachments,{maxChars:48000});
 const expected=prepared.attachments.flatMap(item=>item.pages.map(part=>({id:item.id,...part})));
 assert.ok(expected.length>128);
 const manifest=E.captureInitial(run,{preparedAttachments:prepared,delivery:{textAttachments:attachments}},s);
 assert.equal(run.evidenceSources.length,expected.length);
 expected.forEach((part,index)=>{const source=run.evidenceSources[index];assert.equal(source.id,part.id);assert.equal(source.page,part.page);assert.equal(source.excerpt,part.text);assert.equal(source.offset,null);assert.equal(source.end,null);assert.equal(source.textRepresentation,'normalized-page');assert.ok(manifest.includes(source.sourceId));});
 assert.ok(run.evidenceSources.some(x=>x.id==='chapter3'&&x.page===1));
 const grouped=JSON.parse(manifest.slice(manifest.indexOf('[')));
 assert.equal(grouped.length,4);assert.equal(grouped.flatMap(g=>g.parts).length,expected.length);
 assert.ok(manifest.length<expected.length*85,'grouped manifest must not repeat titles and excerpts on every page');
 const restored=JSON.parse(JSON.stringify(run));
 assert.equal(E.sourcesFor({runId:run.id},restored,s).length,expected.length);
 assert.equal(E.captureInitial(restored,{preparedAttachments:prepared,delivery:{textAttachments:attachments}},s),manifest);
 assert.equal(restored.evidenceSources.length,expected.length);
 assert.equal(restored.evidenceLimitReached,undefined);assert.equal(restored.evidenceExcerptLimitReached,undefined);
});
test('text budget bounds excerpt storage while retaining attributable identities and honest export',()=>{
 const s=state(),run={id:'bounded'};
 const full=E.capture(run,{type:'note',id:'n1',excerpt:'x'.repeat(E.LIMITS.characters)},s);
 const out=E.captureRetained(run,[read('overflow'),read('different')],s);
 assert.equal(run.evidenceSources.length,3);assert.ok(out.every(row=>row.result.evidenceRef));
 const source=run.evidenceSources[1];assert.equal(source.excerpt,null);assert.equal(source.excerptState,'omitted');assert.equal(source.excerptCharacters,8);
 assert.equal(run.evidenceSources.reduce((n,s)=>n+(s.excerpt?.length||0),0),E.LIMITS.characters);
 assert.equal(run.evidenceLimitReached,undefined);assert.equal(run.evidenceExcerptLimitReached,true);
 assert.equal(E.capture(run,{type:'note',id:'n1',excerpt:'x'.repeat(E.LIMITS.characters)},s).sourceId,full.sourceId);
 const restored=JSON.parse(JSON.stringify(run)),message={runId:run.id,text:'Claim [[cite:'+source.sourceId+']]'};
 assert.equal(E.markers(message.text,E.sourcesFor(message,restored,s))[0].source.sourceId,source.sourceId);
 const model=E.evidenceModel(message,restored,s);assert.equal(model.limited,false);assert.equal(model.excerptLimited,true);
 assert.equal(model.sources[1].status.kind,'unretained');assert.equal(model.sources[1].status.canOpen,true);
 assert.match(E.exportText(message,restored,s),/未留存当时片段/);assert.doesNotMatch(E.exportText(message,restored,s),/overflow|这里是实际读取/);
 // No excerpt retained means no proven equality across repeated reads.
 assert.notEqual(E.captureRetained(restored,[read('overflow')],s)[0].result.evidenceRef,source.sourceId);
 s.notes[0].deletedAt=99;assert.equal(E.status(source,s).canOpen,false);assert.match(E.status(source,s).notice,/原来源现已不可用/);
 s.notes[0].private=true;assert.equal(E.status(source,s).kind,'private');assert.equal(E.sourcesFor(message,restored,s)[1].excerptCharacters,undefined);
 const large={id:'large'};const receipt=E.capture(large,{type:'note',id:'n1',excerpt:'x'.repeat(E.LIMITS.characters+1)},s);
 assert.equal(receipt.excerptState,'omitted');assert.equal(receipt.excerpt,null);assert.ok(receipt.sourceId);
});
test('a synchronous page batch hashes each source body once without carrying stale versions to the next batch',()=>{
 const s=state(),run={id:'batch'};let reads=0,revision='A';
 s.imports=[{id:'pdf1',name:'PDF',pages:[{page:1,get text(){reads++;return revision;}}]}];
 const entries=Array.from({length:200},(_,index)=>({request:{type:'read_page',recordType:'import',id:'pdf1'},result:{type:'import',id:'pdf1',page:index+1,offset:0,text:'body '+index}}));
 E.captureRetained(run,entries,s);assert.equal(reads,1);assert.equal(run.evidenceSources.length,200);
 const oldHash=run.evidenceSources[0].bodyHash;revision='B';
 E.captureRetained(run,[{...entries[0],result:{...entries[0].result,text:'changed supplied text'}}],s);
 assert.equal(reads,2);assert.notEqual(run.evidenceSources.at(-1).bodyHash,oldHash);
});
test('local file snapshots preserve the exact project and file identity',()=>{const s=state();s.projects=[{id:'p',localFolder:{id:'folder'}}];const run={id:'r',fileReferences:[{type:'local',projectId:'p',candidateId:'folder',path:'src/file.ts',title:'file.ts',version:'V'}]};const refKey='["local","folder","src/file.ts"]';const out=E.captureRetained(run,[{request:{type:'read_file',refKey},result:{type:'local',id:refKey,refKey,offset:12,text:'😀 supplied',version:'V'}}],s);assert.ok(out[0].result.evidenceRef);assert.equal(run.evidenceSources[0].end,22);assert.equal(run.evidenceSources[0].path,'src/file.ts');assert.equal(E.status(run.evidenceSources[0],s).canOpen,true);s.projects[0].localFolder=null;assert.equal(E.status(run.evidenceSources[0],s).canOpen,false);});
test('knowledge continuation captures post-budget excerpts before durable checkpoint and request',async()=>{const run={id:'r'},s=state();let supplied,checkpointSawSaved=false;await K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'read',recordType:'note',id:'n1'}]}),{evidenceChars:750,execute:async()=>({type:'note',id:'n1',offset:0,text:'Exact '.repeat(1000),totalChars:6000}),mapRetained:retained=>{supplied=structuredClone(retained);return E.captureRetained(run,retained,s);},onCheckpoint:async()=>{checkpointSawSaved=!!run.evidenceSources?.length;},ask:async text=>{assert.match(text,/evidenceRef/);assert.ok(checkpointSawSaved);return '{"message":"Done","actions":[]}';}});assert.equal(run.evidenceSources.length,1);assert.equal(run.evidenceSources[0].excerpt,supplied[0].result.text);assert.ok(run.evidenceSources[0].excerpt.length<6000);assert.equal(run.evidenceSources[0].end,run.evidenceSources[0].excerpt.length);});
test('omitted tool result is not included in the source archive',async()=>{const run={id:'r'},s=state();s.notes.push({id:'n2',title:'Second current source',content:'Z'.repeat(300)});await K.continuePlan(JSON.stringify({knowledgeRequests:[{type:'read',recordType:'note',id:'n1'},{type:'read',recordType:'note',id:'n2'}]}),{evidenceChars:500,execute:async request=>({type:'note',id:request.id,offset:0,text:'Z'.repeat(300)}),mapRetained:retained=>E.captureRetained(run,retained,s),ask:async()=>'{"message":"Done","actions":[]}'});assert.equal(run.evidenceSources.length,1);assert.equal(run.evidenceSources[0].id,'n2');});
test('portable reply exports resolve citations and keep original code examples literal',()=>{const s=state(),run={id:'r'};E.captureRetained(run,[read()],s);const id=run.evidenceSources[0].sourceId,message={runId:'r',text:`事实。[[cite:${id}]]\n\n例子 \`[[cite:${id}]]\`\n\n\`\`\`txt\n[[cite:${id}]]\n\`\`\`\n无来源 [[cite:unknown]]`};const out=E.exportText(message,run,s);assert.match(out,/事实。\[1\]/);assert.match(out,/引用来源/);assert.match(out,/这里是实际读取的证据/);assert.match(out,/无来源 \[引用不可用\]/);assert.ok(out.includes('`[[cite:'+id+']]`'));assert.ok(out.includes('```txt\n[[cite:'+id+']]\n```'));assert.equal((out.match(/\[1\] 证据文档/g)||[]).length,1);assert.match(message.text,/\[\[cite:/);});
test('original and owning-project lifecycle both gate opening while request excerpts stay immutable',()=>{
 for(const flag of [{archived:true},{archivedAt:1},{deleted:true},{deletedAt:1},{status:'archived'},{status:'deleted'},{wikiFileError:'unreadable'}])for(const target of ['record','project']){
  const s=state(),run={id:'r'};s.projects=[{id:'p'}];s.notes[0].projectId='p';E.captureRetained(run,[read()],s);const source=run.evidenceSources[0];Object.assign(target==='record'?s.notes[0]:s.projects[0],flag);
  assert.equal(E.status(source,s).canOpen,false,JSON.stringify({flag,target}));assert.equal(E.status(source,s).kind,'missing');assert.equal(source.excerpt,'这里是实际读取的证据。');assert.equal(E.recordFor(s,'note','n1'),null);
 }
});
test('private source ancestry is redacted from lists, locations and portable source exports',()=>{
 const setups=[s=>s.notes[0].private=true,s=>s.projects[0].incognito=true,s=>{s.notes[0].agentRunId='origin';s.agentRuns.push({id:'origin',private:true})},s=>{s.notes[0].sourceConversationId='secret';s.conversations.push({id:'secret',ephemeral:true})},s=>{s.agentRuns[0].conversationId='secret';s.conversations.push({id:'secret',private:true})}];
 for(const setup of setups){const s=state(),run={id:'r'};s.projects=[{id:'p'}];s.notes[0].projectId='p';s.agentRuns=[run];s.conversations=[];E.capture(run,{type:'note',id:'n1',title:'SECRET_TITLE',excerpt:'SECRET_BODY',url:'https://secret.example/',path:'SECRET_PATH'},s);const source=run.evidenceSources[0];const message={runId:'r',text:`A statement.[[cite:${source.sourceId}]]`};setup(s);const visible=E.sourcesFor(message,run,s)[0];assert.equal(visible.private,true);assert.equal(E.location(visible),'');assert.equal(E.status({...source,runId:run.id},s).kind,'private');assert.doesNotMatch(JSON.stringify(visible),/SECRET_|secret\.example/);assert.doesNotMatch(E.exportText(message,run,s),/SECRET_|secret\.example/);assert.equal(source.excerpt,'SECRET_BODY');}
});
test('deleted original still inherits snapshot project privacy without exposing old excerpts',()=>{const s=state(),run={id:'r'};s.projects=[{id:'p',private:true}];E.capture(run,{type:'note',id:'gone',projectId:'p',title:'SECRET_TITLE',excerpt:'SECRET_BODY'},s);const source=E.sourcesFor({runId:'r'},run,s)[0];assert.equal(source.private,true);assert.doesNotMatch(JSON.stringify(source),/SECRET_/);});
test('duplicate identity fails closed and a private duplicate cannot leak an arbitrary public match',()=>{const s=state(),source={type:'note',id:'n1',title:'SECRET_TITLE',excerpt:'SECRET_BODY'};s.notes.push({...s.notes[0]});assert.equal(E.status(source,s).canOpen,false);s.notes[1].private=true;assert.equal(E.status(source,s).kind,'private');assert.doesNotMatch(JSON.stringify(E.redact(source,s)),/SECRET_/);s.notes.pop();s.notes[0].projectId='p';s.projects=[{id:'p'},{id:'p'}];assert.equal(E.status(source,s).canOpen,false);});
test('local snapshots require the exact active connected folder and inherit private project ownership',()=>{const s=state(),source={type:'local',projectId:'p',candidateId:'folder',path:'SECRET_PATH',title:'SECRET_TITLE',excerpt:'SECRET_BODY'};s.projects=[{id:'p',localFolder:{id:'folder'}}];assert.equal(E.status(source,s).canOpen,true);s.projects[0].localFolder.id='replacement';assert.equal(E.status(source,s).canOpen,false);s.projects[0].private=true;assert.equal(E.status(source,s).kind,'private');assert.doesNotMatch(JSON.stringify(E.redact(source,s)),/SECRET_/);});

test('unified evidence model preserves actual delivery modes and never infers originals from attached IDs',()=>{
 const s=state(),message={runId:'r'},run={id:'r',status:'completed',attachmentIds:['pdf1']};
 assert.equal(E.evidenceModel(message,run,s).attachments,null);
 run.attachmentDelivery={scope:'prepared_representations',totalAttachments:1,originalFiles:0,originalImages:0,pdfPageImages:0,textAttachments:1};
 run.attachmentCoverage={scope:'extracted_text',totalAttachments:1,includedAttachments:1,includedPages:3,complete:false};
 const model=E.evidenceModel(message,run,s);assert.equal(model.sources.length,0);assert.equal(model.hasContent,true);
 assert.equal(model.attachments.metrics.find(x=>x.label==='文件原件').value,0);assert.equal(model.attachments.metrics.find(x=>x.label==='文字模式附件').value,1);
 assert.equal(model.attachments.sources[0].provided,false);assert.equal(model.attachments.sources[0].status.canOpen,true);
 assert.match(model.attachments.notes.join('\n'),/准备.*不代表模型/);assert.match(model.attachments.notes.join('\n'),/只覆盖部分/);
 run.attachmentDelivery={scope:'prepared_representations',totalAttachments:1,pdfPageImages:48};
 const images=E.evidenceModel(message,run,s).attachments;assert.equal(images.metrics.find(x=>x.label==='PDF 页面图像').value,48);assert.ok(!images.metrics.find(x=>x.label==='文件原件'));
});
test('coverage-only historical runs render metadata without made-up unknown counts',()=>{
 const model=E.evidenceModel({runId:'r'},{id:'r',retrievalCoverage:{strategy:'hybrid-rrf',eligibleRecords:10,nextOffset:undefined,vectorReady:2}},state());
 assert.equal(model.hasContent,true);assert.equal(model.sources.length,0);assert.deepEqual(model.retrieval.metrics,[{label:'索引条目',value:10}]);
 assert.doesNotMatch(model.retrieval.notes.join('\n'),/还有搜索结果|有效向量段落|undefined|NaN/);
 const knownZero=E.evidenceModel({runId:'r',retrievedSources:[]},{id:'r',retrievalCoverage:{strategy:'local-bm25',eligibleRecords:0,nextOffset:0}},state());
 assert.equal(knownZero.retrieval.metrics.find(x=>x.label==='保存的检索段落').value,0);assert.match(knownZero.retrieval.notes.join('\n'),/还有搜索结果/);
 assert.equal(E.evidenceModel({runId:'r'},{id:'r',retrievalCoverage:{strategy:'not-requested'}},state()).hasContent,false);
});
test('saved retrieval entries deduplicate chunks while record counts do not invent absent identities',()=>{
 const run={id:'r',retrievalCoverage:{strategy:'local-bm25',eligibleRecords:9}},message={runId:'r',retrievedSources:[{chunkId:'a',type:'import',id:'pdf1',page:7},{chunkId:'a',type:'import',id:'pdf1',page:7},{chunkId:'b',type:'import',id:'pdf1',page:8}]};
 const values=E.evidenceModel(message,run,state()).retrieval.metrics;assert.equal(values.find(x=>x.label==='保存的检索段落').value,2);assert.equal(values.find(x=>x.label==='检索来源条目').value,1);
 message.retrievedSources=[{chunkId:'x'}];assert.ok(!E.evidenceModel(message,run,state()).retrieval.metrics.find(x=>x.label==='检索来源条目'));
});
test('unified evidence accepts only the associated current pending or retry run',()=>{
 const s=state(),run={id:'r',retrievalCoverage:{strategy:'local-bm25',eligibleRecords:4},attachmentDelivery:{totalAttachments:1,textAttachments:1},attachmentIds:['pdf1']};
 E.captureRetained(run,[read()],s);
 for(const field of ['runId','pendingRunId','retryRunId']){const model=E.evidenceModel({[field]:'r'},run,s);assert.equal(model.sources.length,1);assert.equal(model.retrieval.metrics[0].value,4);assert.equal(model.attachments.sources.length,1);}
 const unassociated=E.evidenceModel({runId:'other'},run,s);assert.equal(unassociated.hasContent,false);
 assert.equal(E.evidenceModel({},run,s).hasContent,false);
});
test('attachment metadata respects record and owner privacy and availability without leaking names',()=>{
 for(const mode of ['private','private-project','deleted','archived-project','private-run']){
  const s=state(),run={id:'r',attachmentIds:['pdf1'],attachmentDelivery:{scope:'prepared_representations',totalAttachments:1,textAttachments:1,textUnavailable:[{attachmentId:'pdf1',name:'SECRET_NAME'}]}};
  s.imports[0].name='SECRET_NAME';s.imports[0].projectId='p';s.projects=[{id:'p'}];s.agentRuns=[run];
  if(mode==='private')s.imports[0].private=true;if(mode==='private-project')s.projects[0].private=true;if(mode==='deleted')s.imports[0].deletedAt=1;if(mode==='archived-project')s.projects[0].archived=true;if(mode==='private-run')run.private=true;
  const model=E.evidenceModel({runId:'r'},run,s),source=model.attachments.sources[0];assert.equal(source.status.canOpen,false,mode);assert.doesNotMatch(JSON.stringify(model),/SECRET_NAME/,mode);
 }
});
test('historical extracted-text metadata remains inspectable when delivery modes were not saved',()=>{
 const model=E.evidenceModel({runId:'r'},{id:'r',attachmentIds:['pdf1'],attachmentCoverage:{scope:'extracted_text',totalAttachments:1,includedAttachments:1,includedPages:4,complete:true}},state());
 assert.equal(model.hasContent,true);assert.deepEqual(model.attachments.metrics,[]);assert.equal(model.attachments.textMetrics.find(x=>x.label==='包含文字的页面').value,4);assert.match(model.attachments.notes.join('\n'),/不证明原件中的图像/);
});

test('evidence model does not mutate request evidence or workspace data',()=>{
 const s=state(),run={id:'r',attachmentIds:['pdf1'],attachmentDelivery:{totalAttachments:1,textAttachments:1},retrievalCoverage:{strategy:'local-bm25',eligibleRecords:10}};E.captureRetained(run,[read()],s);
 const message={id:'m',runId:'r',evidenceOpen:true},before=JSON.stringify({s,run,message});E.evidenceModel(message,run,s);assert.equal(JSON.stringify({s,run,message}),before);
});

test('evidence ownership stages updates without extra roots and refreshes retained source bindings',()=>{
 // This small DOM contract checks ownership only. Real Kit pagination, focus,
 // keyboard and text selection are validated by evidence-panel-smoke.cjs.
 class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.parentElement=null;this.open=false;this.textContent='';}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  remove(){if(this.parentElement){const owner=this.parentElement;owner.children.splice(owner.children.indexOf(this),1);this.parentElement=null;}}
  replaceWith(node){const owner=this.parentElement,index=owner.children.indexOf(this);node.remove();owner.children[index]=node;node.parentElement=owner;this.parentElement=null;}
  matches(selector){if(selector==='details[data-citation-panel]')return this.tagName==='DETAILS'&&Object.hasOwn(this.dataset,'citationPanel');if(selector==='[data-citation-source]')return Object.hasOwn(this.dataset,'citationSource');return this.tagName===selector.toUpperCase();}
  querySelectorAll(selector){if(selector.startsWith(':scope > '))return this.children.filter(node=>node.matches(selector.slice(9)));return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  addEventListener(){}
 }
 const oldDocument=globalThis.document,oldKit=globalThis.HalaskaUI;let mounts=0,updates=0,unmounts=0,lastProps;
 globalThis.document={createElement:tag=>new Element(tag)};
 const kit={componentNames:['CitationSourceList'],mount(host,name,props){mounts++;lastProps=props;return{update(next){updates++;lastProps=next;},unmount(){unmounts++;}};}};
 globalThis.HalaskaUI=kit;
 try{
  const s=state(),run={id:'r'},message={id:'m',runId:'r',evidenceOpen:true};E.captureRetained(run,[read()],s);
  const wrapper=new Element('article'),initial=E.section(message,run,s);wrapper.append(initial);const host=initial.children[1],button=new Element('button');host.append(button);
  // The real Kit bridge clones plain-object props; handlers must resolve IDs,
  // not depend on referential equality with their originally supplied props.
  lastProps.onBind(structuredClone(lastProps.sources[0]),button);assert.equal(E.resolveTarget(s,button).siblings.length,1);
  E.captureRetained(run,[read('第二段实际摘录')],s);s.notes[0].content='A revised original';
  const staged=E.section({...message,evidenceOpen:false},run,s,{previous:wrapper});assert.equal(mounts,1);assert.equal(staged.children[1].children.length,0);
  assert.equal(E.patchSection(initial,staged),true);assert.equal(mounts,1);assert.equal(updates,1);assert.equal(initial.children[1],host);assert.equal(initial.open,true);assert.equal(host.children[0],button);assert.match(initial.children[0].textContent,/2 项/);
  const bound=E.resolveTarget(s,button);assert.equal(bound.siblings.length,2);assert.equal(bound.source.status.kind,'changed');
  E.discard(staged);assert.equal(unmounts,0);const abandoned=E.section(message,run,s,{previous:wrapper});E.discard(abandoned);assert.equal(unmounts,0);
  E.discard(wrapper);assert.equal(unmounts,1);E.discard(wrapper);assert.equal(unmounts,1);
  // Late Kit availability transfers the entire new host, not its children.
  globalThis.HalaskaUI=null;const fallback=E.section(message,run,s);const oldHost=fallback.children[1];globalThis.HalaskaUI=kit;
  const ready=E.section(message,run,s,{previous:fallback}),readyHost=ready.children[1];assert.equal(mounts,2);assert.equal(E.patchSection(fallback,ready),true);assert.notEqual(fallback.children[1],oldHost);assert.equal(fallback.children[1],readyHost);assert.equal(unmounts,1);
  E.discard(ready);assert.equal(unmounts,1);E.discard(fallback);assert.equal(unmounts,2);
 }finally{globalThis.document=oldDocument;globalThis.HalaskaUI=oldKit;}
});
