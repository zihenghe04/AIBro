'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Evidence=require('../app/citation-evidence.js');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing production section ${start}`);return source.slice(a,b);}
const kinds=[['notes','note'],['imports','import'],['tasks','task'],['papers','paper']];
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){return {projects:[{id:'p',name:'Needle public project',workspace:'日常'}],notes:[],imports:[],tasks:[],papers:[],conversations:[],agentRuns:[],trash:[],ui:{}};}
function add(state,type,id,extra={}){const collection=kinds.find(([,kind])=>kind===type)[0],record={id,title:`Needle ${id}`,name:`Needle ${id}`,content:`Needle BODY_${id}`,description:`Needle DESC_${id}`,projectId:'p',workspace:'日常',status:'todo',...extra};state[collection].push(record);return record;}
function harness(state,{evidence=Evidence,onNormalize=()=>{}}={}){
 const context=vm.createContext({state,window:{CitationEvidence:evidence},CitationEvidence:evidence,normalize:value=>{onNormalize(value);return String(value??'').trim().toLowerCase().replace(/[\s·_-]+/g,'');},workspaceName:value=>value||'日常',statusLabel:value=>value||'待开始',projectForTask:item=>state.projects.find(project=>project.id===item.projectId)||null,PrivateMode:{searchable:conversation=>!conversation.private&&!conversation.ephemeral&&!conversation.incognito}});
 vm.runInContext(section('const projectIsActive =','\nconst visibleRun ='),context);
 vm.runInContext(section('function searchEntities(','\nfunction renderSearchResults('),context);
 return {search:(query='Needle')=>plain(context.searchEntities(query))};
}
const docs=rows=>rows.filter(row=>['note','import','task','paper'].includes(row.type)).map(row=>`${row.type}:${row.id}`).sort();
test('actual global search keeps public approved record bodies searchable, including project records, without mutation',()=>{
 const state=fixture();for(const[,type]of kinds)add(state,type,type+'-public');add(state,'note','daily',{projectMemoryType:'daily',content:'A unique diary body token: PUBLIC_DIARY_BODY'});const before=JSON.stringify(state),h=harness(state);assert.deepEqual(docs(h.search()),['import:import-public','note:daily','note:note-public','paper:paper-public','task:task-public']);assert.deepEqual(h.search('PUBLIC_DIARY_BODY').map(row=>row.id),['daily']);assert.equal(JSON.stringify(state),before);
});
test('note/import/task/paper direct private, ephemeral and incognito entries never expose title, metadata or body',()=>{
 for(const flag of ['private','ephemeral','incognito']){const state=fixture();for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,{[flag]:true});}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),flag);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);}
});
test('privacy follows live and retired origin conversations/runs instead of trusting a public-looking output',()=>{
 for(const ancestry of ['conversation','run','retired-run','retired-conversation','captured-origin']){
  const state=fixture();if(ancestry==='conversation')state.conversations.push({id:'secret',ephemeral:true});if(ancestry==='run')state.agentRuns.push({id:'secret',private:true});if(ancestry==='retired-run')state.trash.push({data:{runs:[{id:'secret',private:true}]}});if(ancestry==='retired-conversation')state.trash.push({data:{conversations:[{id:'secret',incognito:true}]}});
  const extra=ancestry==='captured-origin'?{provenance:{origin:{private:true}}}:ancestry.includes('conversation')?{sourceConversationId:'secret'}:{provenance:{origin:{runId:'secret'}}};for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,extra);}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),ancestry);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);
 }
});
test('private or duplicate projects and their records do not enter global results or location metadata',()=>{
 for(const mode of ['private','duplicate','retired-private']){const state=fixture();const privateProject={id:'secret-project',name:'Needle SECRET_PROJECT',workspace:'日常'};state.projects.push(privateProject);if(mode==='private')privateProject.private=true;if(mode==='duplicate')state.projects.push({...privateProject});if(mode==='retired-private')state.trash.push({data:{projects:[{...privateProject,private:true}]}});for(const[,type]of kinds){add(state,type,type+'-safe');add(state,type,'SECRET_'+type,{projectId:'secret-project'});}const rows=harness(state).search();assert.deepEqual(docs(rows),kinds.map(([,type])=>type+':'+type+'-safe').sort(),mode);assert.doesNotMatch(JSON.stringify(rows),/SECRET_/);assert.equal(rows.some(row=>row.type==='project'&&row.id==='secret-project'),false);}
});
test('ambiguous typed record ids are rejected but a same-id record of another type remains independently searchable',()=>{
 const state=fixture();for(const[,type]of kinds){add(state,type,'duplicate-'+type);add(state,type,'duplicate-'+type);}add(state,'note','shared',{title:'Needle PUBLIC_SHARED_NOTE'});add(state,'import','shared',{private:true,name:'Needle SECRET_SHARED_IMPORT'});const rows=harness(state).search();assert.deepEqual(docs(rows),['note:shared']);assert.doesNotMatch(JSON.stringify(rows),/SECRET_SHARED_IMPORT|duplicate-/);
});
test('deleted, archived and unavailable records are not searchable even while retained in the arrays',()=>{
 const state=fixture();for(const[,type]of kinds)for(const [index,extra]of [{deleted:true},{deletedAt:5},{archived:true},{archivedAt:5},{status:'deleted'},{status:'archived'},{wikiFileError:'missing'}].entries())add(state,type,`${type}-gone-${index}`,extra);assert.deepEqual(docs(harness(state).search()),[]);
});
test('project task metadata counts only public unambiguous active tasks',()=>{
 const state=fixture();add(state,'task','public');add(state,'task','secret',{private:true});add(state,'task','duplicate');add(state,'task','duplicate');add(state,'task','gone',{deletedAt:5});const project=harness(state).search().find(row=>row.type==='project');assert.match(project.meta,/1 个任务/);assert.doesNotMatch(project.meta,/5 个任务/);
});
test('missing privacy dependency fails closed for workspace documents and project results',()=>{
 const state=fixture();for(const[,type]of kinds)add(state,type,type+'-public');assert.deepEqual(harness(state,{evidence:null}).search(),[]);
});


test('actual global search finds page-only PDF text through the last page and shows its readable excerpt and page',()=>{
 const state=fixture();add(state,'import','three-pages',{name:'校园接驳演示.pdf',title:'',content:'',pages:[{page:1,text:'信息的不确定性。'},{page:2,text:'明确倒计时与模糊提示。'},{page:3,text:'下一步是在接驳站完成二十分钟的\n结构化观察。把阅读变为行动。'}],parser:'pymupdf-local',indexStatus:'ready'});
 const before=JSON.stringify(state),rows=harness(state).search('二十分钟的结构化观察');assert.equal(rows.length,1);assert.equal(rows[0].id,'three-pages');assert.equal(rows[0].matchPage,3);assert.match(rows[0].meta,/第 3 页/);assert.match(rows[0].excerpt,/二十分钟的 结构化观察/);assert.equal(JSON.stringify(state),before);
});
test('PDF pages after 500 and text after old character limits stay searchable without full-file haystacks',()=>{
 const state=fixture(),pages=Array.from({length:502},(_,index)=>({page:index+1,text:'普通页 '+index}));pages[501].text='长正文'.repeat(30000)+' 尾页独有的观察结论';add(state,'import','large',{name:'large.pdf',content:'',pages});
 const rows=harness(state).search('尾页独有的观察结论');assert.equal(rows.length,1);assert.equal(rows[0].matchPage,502);assert.match(rows[0].excerpt,/尾页独有的观察结论/);assert.ok(rows[0].haystack.length<200);assert.ok(rows[0].excerpt.length<170);
});
test('unchanged PDF page text is normalized once across keystrokes, then invalidated by an in-place edit or new snapshot',()=>{
 const state=fixture(),original='缓存页文字：校园接驳等待与可观察行为。',edited='更新页文字：候车观察的后续行动。';const record=add(state,'import','cached',{name:'cached.pdf',content:'',pages:[{page:1,text:original}]});const normalized=[];const h=harness(state,{onNormalize:value=>normalized.push(value)});
 assert.equal(h.search('校园').length,1);assert.equal(h.search('校园接驳').length,1);assert.equal(h.search('接驳等待').length,1);assert.equal(normalized.filter(text=>text===original).length,1,'do not rebuild the same page for every input');
 record.pages[0].text=edited;assert.equal(h.search('校园接驳').length,0);assert.equal(h.search('后续行动').length,1);assert.equal(normalized.filter(text=>text===edited).length,1);
 record.pages=[{page:7,content:'替换快照的独特末页'}];assert.equal(h.search('后续行动').length,0);assert.equal(h.search('独特末页')[0].matchPage,7);
});
test('warming the PDF cache never bypasses subsequent privacy, duplicate-id, deletion or project ownership checks',()=>{
 for(const mutate of [s=>s.imports[0].private=true,s=>s.imports[0].deletedAt=10,s=>s.imports.push({...s.imports[0]}),s=>s.projects[0].private=true,s=>s.imports[0].projectId='missing']){
  const state=fixture();add(state,'import','cached-private',{name:'neutral.pdf',content:'',pages:[{page:9,text:'只在正文存在的隐私短语'}]});const h=harness(state);assert.equal(h.search('隐私短语').length,1);mutate(state);assert.equal(h.search('隐私短语').length,0);
 }
 const state=fixture();const record=add(state,'import','never-read',{private:true,content:''});Object.defineProperty(record,'pages',{get(){throw Error('private pages must never be inspected');}});assert.equal(harness(state).search('any').length,0);
});
test('legacy import content remains searchable while excerpts preserve English spacing and stay bounded',()=>{
 const state=fixture();add(state,'import','legacy',{name:'neutral.txt',content:'Background before the Waiting Time comparison and a later result.'});const rows=harness(state).search('waiting time');assert.equal(rows.length,1);assert.equal(rows[0].matchPage,null);assert.match(rows[0].excerpt,/Waiting Time comparison/);assert.match(rows[0].meta,/正文/);
 const huge='long'.repeat(500);state.imports[0].content=huge;const long=harness(state).search(huge);assert.equal(long.length,1);assert.ok(long[0].excerpt.length<=162);
});
test('single pages larger than the normalization cache budget still match their tail with no search-content cap',()=>{
 const state=fixture();add(state,'import','oversized',{name:'huge.pdf',content:'',pages:[{page:73,text:'x'.repeat(4300000)+'UNCACHED_TAIL_MATCH'}]});const h=harness(state);assert.equal(h.search('UNCACHED_TAIL_MATCH')[0].matchPage,73);assert.equal(h.search('TAIL_MATCH')[0].id,'oversized');
});
