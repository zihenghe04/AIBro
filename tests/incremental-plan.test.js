const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/workstation-core');
const empty = () => ({ projects: [], imports: [], tasks: [], notes: [], papers: [], links: [], conversations: [], trash: [], agentRuns: [] });

test('matching an existing task merges new sources without resetting user progress', () => {
  const state = empty();
  state.projects.push({id:'project',name:'签证准备',workspace:'日常'});
  state.imports.push({id:'old',name:'原材料.txt'},{id:'new',name:'新增材料.txt'});
  const first = Core.applyPlan(state,[{type:'create_task',title:'准备材料',workspace:'日常',projectId:'project',sourceAttachmentIds:['old']}],{now:1000}).state;
  Object.assign(first.tasks[0], {status:'done',completedAt:1500,priority:'high',dueAt:'2026-10-01',description:'用户填写的要求',checklist:[{text:'原件已核验',done:true}]});
  const taskId = first.tasks[0].id;
  const next = Core.applyPlan(first,[{type:'create_task',title:'准备材料',workspace:'日常',projectId:'project',sourceAttachmentIds:['new','old'],status:'todo',priority:'low',dueAt:'2030-01-01',checklist:['覆盖内容']}],{now:2000}).state;
  assert.equal(next.tasks.length,1); assert.equal(next.tasks[0].id,taskId);
  assert.deepEqual(next.tasks[0].sourceAttachmentIds,['old','new']);
  for(const field of ['status','completedAt','priority','dueAt','description','checklist']) assert.deepEqual(next.tasks[0][field],first.tasks[0][field],field);
  assert.equal(next.tasks[0].updatedAt,2000);
  assert.equal(Core.taskSources(next,next.tasks[0]).materials.length,2,'both attachments appear in task details');
  assert.equal(next.links.filter(x=>x.targetId===taskId).length,2);
  const repeat = Core.applyPlan(next,[{type:'create_task',title:'准备材料',workspace:'日常',projectId:'project',sourceAttachmentIds:['new']}],{now:3000}).state;
  assert.equal(repeat.tasks.length,1);assert.equal(repeat.tasks[0].updatedAt,2000);assert.equal(repeat.links.length,2);
  assert.deepEqual(first.tasks[0].sourceAttachmentIds,['old'],'input state is never mutated');
});

function researchFixture() {
  const state=empty();state.projects.push({id:'research',name:'控制研究',workspace:'科研'});state.imports.push({id:'pdf1',name:'Paper.pdf'},{id:'pdf2',name:'Updated.pdf'});
  return Core.applyPlan(state,[{type:'upsert_paper',id:'paper-ref',title:'Original title',workspace:'科研',projectId:'research',doi:'10.1234/example',sourceAttachmentIds:['pdf1'],structured:{tldr:'AI draft'}}],{now:1000}).state;
}
test('paper id in model actions updates stable identity and preserves human revisions', () => {
  const state=researchFixture();const paper=state.papers[0];paper.reviewed=true;paper.reviewedAt=1500;paper.userEdits={tldr:'人工修订'};paper.structured.tldr='人工修订';
  const next=Core.applyPlan(state,[{type:'upsert_paper',id:paper.id,title:'Corrected full title',workspace:'科研',projectId:'research',sourceAttachmentIds:['pdf2'],structured:{tldr:'New AI draft',methods:'New method'},reviewed:false,userEdits:{tldr:'Injected'}}],{now:2000}).state;
  assert.equal(next.papers.length,1);assert.equal(next.papers[0].id,paper.id);assert.equal(next.notes.length,1);assert.equal(next.notes[0].paperId,paper.id);
  assert.equal(next.papers[0].reviewed,true);assert.equal(next.papers[0].reviewedAt,1500);assert.equal(next.papers[0].structured.tldr,'人工修订');assert.equal(next.papers[0].structured.methods,'New method');assert.match(next.notes[0].content,/人工修订/);
  assert.deepEqual(next.papers[0].sourceAttachmentIds,['pdf1','pdf2']);
});
test('DOI-matched updates retain project routing for new originals and analysis note', () => {
  const state=researchFixture();
  const next=Core.applyPlan(state,[{type:'upsert_paper',title:'Published title',workspace:'科研',doi:'10.1234/example',sourceAttachmentIds:['pdf2'],structured:{methods:'Updated'}}],{now:2000}).state;
  assert.equal(next.papers.length,1);assert.equal(next.papers[0].projectId,'research');
  assert.equal(next.imports.find(x=>x.id==='pdf2').projectId,'research');
  assert.equal(next.notes[0].project,'控制研究');assert.equal(next.notes[0].projectId,'research');
  assert.throws(()=>Core.applyPlan(state,[{type:'upsert_paper',paperId:'missing',title:'Invalid target',workspace:'科研',sourceAttachmentIds:['pdf2']}]),/找不到要更新的论文/);
});
