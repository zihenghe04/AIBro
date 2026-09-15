const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../app/context-retrieval'),K=require('../app/knowledge-access');
const fixture=()=>({projects:[{id:'p',name:'Research',workspace:'科研'},{id:'other',name:'Other',workspace:'课程'}],notes:Array.from({length:150},(_,i)=>({id:'n'+i,projectId:'p',title:'Reading '+i,content:'calibration evidence '+('baseline observations '.repeat(70))})),imports:[{id:'pdf',projectId:'p',name:'Scan.pdf',rawBase64:'DO_NOT_INDEX_RAW_BYTES'}]});
test('initial indexed context exceeds old character ceiling; every result remains reachable',async()=>{
 const s=fixture(),before=JSON.stringify(s),options={projectId:'p',query:'calibration',allowedTaskIds:[]};
 const first=R.buildIndexedContext(s,options);assert.ok(first.text.length>12000);assert.equal(first.coverage.eligibleRecords,151);assert.equal(first.coverage.metadataOnlyRecords,1);assert.equal(first.coverage.originalFiles,1);
 assert.equal(first.entries.length,20);assert.notEqual(first.coverage.nextOffset,null);assert.equal(first.coverage.truncated,false);
 const ids=new Set(first.entries.map(e=>e.id));let offset=first.coverage.nextOffset;
 do{const result=await K.execute(s,{projectId:'p'},{type:'search',query:'calibration',offset});for(const e of result.entries){assert.ok(!ids.has(e.chunkId));ids.add(e.chunkId);}offset=result.nextOffset;}while(offset!==null);
 assert.equal(ids.size,150);assert.equal(JSON.stringify(s),before);assert.doesNotMatch(first.text,/DO_NOT_INDEX_RAW_BYTES/);
});
test('all chunks of a long document are searchable, including late evidence beyond token prefixes',async()=>{
 const s=fixture();s.notes=[{id:'long',projectId:'p',title:'Study',pages:Array.from({length:145},(_,i)=>({page:i+1,text:'commoncontext '+('ordinary '.repeat(120))+(i===144?' zirconium':'')}))}];
 const all=[];let offset=0;do{const r=R.searchIndex(s,{projectId:'p',query:'commoncontext',offset});all.push(...r.entries);offset=r.coverage.nextOffset;}while(offset!==null);
 assert.equal(all.length,145);assert.equal(new Set(all.map(e=>e.page)).size,145);
 const late=R.searchIndex(s,{projectId:'p',query:'zirconium'});assert.equal(late.entries.length,1);assert.equal(late.entries[0].page,145);assert.match(late.entries[0].text,/zirconium/);
});
test('edits, source moves, deletions and human paper edits invalidate cached postings',()=>{
 const s=fixture();s.notes=[{id:'a',projectId:'p',content:'quasar evidence'}];
 assert.equal(R.searchIndex(s,{projectId:'p',query:'quasar'}).entries.length,1);
 s.notes[0].content='neutrino evidence';assert.equal(R.searchIndex(s,{projectId:'p',query:'quasar'}).entries.length,0);
 assert.equal(R.searchIndex(s,{projectId:'p',query:'neutrino'}).entries.length,1);
 s.notes[0].projectId='other';assert.equal(R.searchIndex(s,{projectId:'p',query:'neutrino'}).entries.length,0);
 s.notes[0].deletedAt=1;assert.equal(R.searchIndex(s,{query:'neutrino'}).entries.length,0);
 s.papers=[{id:'paper',projectId:'p',structured:{methods:{text:'oldfinding'}},userEdits:{methods:{text:'correctedfinding',citations:[{attachmentId:'pdf',page:9}]}}}];
 assert.equal(R.searchIndex(s,{projectId:'p',query:'oldfinding'}).entries.length,0);
 assert.equal(R.searchIndex(s,{projectId:'p',query:'correctedfinding'}).entries[0].page,9);
 s.projects[0].archived=true;assert.equal(R.searchIndex(s,{query:'correctedfinding'}).entries.length,0);
});
test('Chinese names and English word boundaries retain scope; catalogs paginate consistently',async()=>{
 const s=fixture();s.notes.push({id:'chinese',projectId:'p',content:'稀疏矩阵特征值使用迭代求解。'},{id:'bad',projectId:'other',content:'inattention only'});
 assert.ok(R.searchIndex(s,{projectId:'p',query:'稀疏矩阵特征值'}).entries.some(e=>e.recordId==='chinese'));
 assert.equal(R.searchIndex(s,{query:'attention'}).entries.length,0);
 const c=R.buildIndexedContext(s,{projectId:'p',query:'calibration',allowedTaskIds:[]}),data=JSON.parse(c.text.split('\n')[1]);
 const seen=new Set(data.catalog.map(e=>e.id));let req=data.catalogNextRequest;
 while(req){const page=await K.execute(s,{projectId:'p'},req);for(const e of page.entries){assert.ok(!seen.has(e.id));seen.add(e.id);}req=page.nextOffset===null?null:{...req,offset:page.nextOffset};}
 assert.equal(seen.size,152);assert.equal(seen.has('bad'),false);
});
test('zero text hits still expose a catalog and metadata-only coverage without calling original read',()=>{
 const s=fixture();s.notes=[];
 const result=R.buildIndexedContext(s,{projectId:'p',query:'unknown evidence'});
 assert.equal(result.entries.length,0);assert.equal(result.coverage.metadataOnlyRecords,1);assert.match(result.text,/Scan.pdf/);assert.doesNotMatch(result.text,/DO_NOT_INDEX_RAW_BYTES/);
});
test('heading context follows chunks while offsets preserve exact text and code fences do not become headings',async()=>{
 const s=fixture(),body='# Study\n\n## Calibration\n'+('setting evidence '.repeat(230))+'\n```\n# Fake title\n```\n## Conclusion\nother result';s.notes=[{id:'head',projectId:'p',content:body}];
 const entries=R.indexEntries(s,{projectId:'p'});assert.equal(entries.map(e=>e.text).join(''),body);for(const e of entries){assert.equal(body.slice(e.offset,e.end),e.text);assert.ok(!e.heading.includes('Fake'));}
 const result=await K.execute(s,{projectId:'p'},{type:'search',query:'calibration'});assert.ok(result.entries.length>1);assert.ok(result.entries.every(e=>e.heading==='Study › Calibration'));const e=result.entries[1];const neighbors=await K.execute(s,{projectId:'p'},{type:'neighbors',chunkId:e.chunkId,version:e.version});assert.ok(neighbors.entries.some(n=>n.matched));assert.equal(neighbors.originalRead,false);
 await assert.rejects(K.execute(s,{projectId:'other'},{type:'neighbors',chunkId:e.chunkId,version:e.version}),/范围/);s.notes[0].content+='changed';await assert.rejects(K.execute(s,{projectId:'p'},{type:'neighbors',chunkId:e.chunkId,version:e.version}),/更新|失效/);
});
test('neighbor radius is bounded and never crosses to another source',()=>{const s=fixture();s.notes=[{id:'a',projectId:'p',content:'alpha '.repeat(1000)},{id:'b',projectId:'p',content:'beta '.repeat(1000)}];const e=R.searchIndex(s,{projectId:'p',query:'alpha'}).entries[0];assert.ok(R.neighbors(s,{projectId:'p'},{chunkId:e.id,version:e.version,radius:2}).entries.every(n=>n.recordId==='a'));assert.throws(()=>R.neighbors(s,{}, {chunkId:e.id,version:e.version,radius:99}),/范围/);});
test('original offsets include leading whitespace and preserve Unicode characters',()=>{const s=fixture(),content='\n\n  # Results\n'+('😀 calibration '.repeat(200))+'\n\n';s.notes=[{id:'a',projectId:'p',content}];const r=R.indexEntries(s,{projectId:'p'});assert.equal(r.map(e=>e.text).join(''),content);for(const e of r){assert.equal(content.slice(e.offset,e.end),e.text);assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(e.text));}});
