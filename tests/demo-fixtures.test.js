const test=require('node:test'),assert=require('node:assert/strict');
const {createDemo}=require('../demo/fixtures/workspace.cjs');
const Core=require('../workstation-core');
const Analysis=require('../attachment-analysis');
for(const lang of ['zh-CN','en'])test('synthetic '+lang+' plans preserve one-note/source/task ownership and update the existing daily task',()=>{
 const demo=createDemo(lang,Date.parse('2026-09-12T04:00:00Z'));let sequence=0;
 const sourceId='demo-test-original',state=structuredClone(demo.state);state.imports.push({id:sourceId,name:'lesson.pdf',content:demo.pdf.pages.map(page=>page.body.join('\n')).join('\n'),workspace:'课程',analysis:{status:'pending'}});
 const result=Core.applyPlan(state,demo.coursePlan(sourceId).actions,{uid:prefix=>prefix+'-'+(++sequence),now:Date.parse('2026-09-12T04:01:00Z'),conversationId:'demo-start',workspace:'课程'});
 const notes=result.state.notes.filter(note=>note.sourceAttachmentIds?.includes(sourceId)),tasks=result.state.tasks.filter(task=>task.sourceAttachmentIds?.includes(sourceId));
 assert.equal(notes.length,1);assert.equal(tasks.length,1);assert.equal(notes[0].projectId,tasks[0].projectId);assert.equal(result.state.imports.find(source=>source.id===sourceId).projectId,notes[0].projectId);
 const analysis=Analysis.markCompleted(result.state,result,{id:'demo-scripted-run',status:'completed',mode:'ai'},Date.parse('2026-09-12T04:02:00Z'));assert.deepEqual(analysis.markedIds,[sourceId],'preset note contains actual synthesis, not just copied extraction');assert.equal(Analysis.derive(analysis.state,analysis.state.imports.find(source=>source.id===sourceId)).status,'analyzed');
 const updated=Core.applyPlan(result.state,demo.dailyPlan().actions,{workspace:'日常',projectId:demo.ids.daily,allowedTaskIds:[demo.ids.dailyTask]});assert.equal(updated.state.tasks.length,result.state.tasks.length);assert.ok(updated.state.tasks.find(task=>task.id===demo.ids.dailyTask).dueAt);
 assert.equal(demo.answerPlan().actions.length,0);assert.equal(demo.state.papers.length,3);assert.ok(demo.state.papers.every(paper=>!paper.doi&&!paper.url&&!paper.arxivId));
 if(lang==='en')for(const record of [...demo.state.projects,...demo.state.notes,...demo.state.tasks,...demo.state.papers])assert.doesNotMatch(record.title||record.name||'',/[\u3400-\u9fff]/,'English user-visible fixture titles are not partly Chinese');
});
