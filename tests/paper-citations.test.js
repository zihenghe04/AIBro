const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../workstation-core');
const fixture = () => ({ projects: [{ id:'research', name:'控制研究', workspace:'科研' }], tasks:[], notes:[], papers:[], links:[], trash:[], conversations:[], agentRuns:[], imports:[
  {id:'pdf-main',name:'Paper.pdf',pages:[{page:1,text:'Introduction'},{page:3,text:'Method claim'}]},
  {id:'pdf-other',name:'Other paper.pdf',pages:[{page:1,text:'Unrelated'}]},
  {id:'pdf-unknown',name:'Unparsed source.pdf'},
] });
const plan = citations => ({type:'upsert_paper',title:'Control paper',workspace:'科研',projectId:'research',sourceAttachmentIds:['pdf-main'],structured:{methods:{text:'Method analysis',citations,verified:false}}});

function assertRejectedWithoutMutation(state, action, pattern) {
  const before=JSON.stringify(state);
  // Include a preceding write so the assertion covers whole-plan atomicity.
  assert.throws(()=>Core.applyPlan(state,[{type:'create_task',title:'Must roll back',projectId:'research'},action],{workspace:'科研'}),pattern);
  assert.equal(JSON.stringify(state),before);
}

test('paper citations reject unknown, unrelated or archived attachment references atomically', () => {
  for(const id of ['ghost','pdf-other']) {
    const state=fixture();
    assertRejectedWithoutMutation(state,plan([{attachmentId:id,page:1,quote:'Invented source'}]),/未关联的来源附件/);
  }
  const state=fixture();
  const existing=Core.applyPlan(state,[plan([{attachmentId:'pdf-main',page:3}])],{workspace:'科研'}).state;
  existing.imports.find(item=>item.id==='pdf-main').archived=true;
  const update={...plan([{attachmentId:'pdf-main',page:3}]),id:existing.papers[0].id,sourceAttachmentIds:['pdf-unknown']};
  assertRejectedWithoutMutation(existing,update,/不存在或已归档/);
});

test('known source page bounds reject impossible pages and invalid page types', () => {
  for(const page of [0,-1,1.5,4,999,'',true,[1],{},'1.5','1e2']) {
    assertRejectedWithoutMutation(fixture(),plan([{attachmentId:'pdf-main',page}]),/页码/);
  }
  for(const citation of [null,'not-an-object',{}, {attachmentId:'pdf-main',sourceAttachmentId:'pdf-other',page:1}]) {
    assertRejectedWithoutMutation(fixture(),plan([citation]),/引用/);
  }
  assertRejectedWithoutMutation(fixture(),plan({attachmentId:'pdf-main',page:1}),/引用必须是数组/);
});

test('valid citation metadata is preserved without claiming a quote has been verified', () => {
  const citations=[{attachmentId:'pdf-main',page:3,quote:'Method claim'},{sourceAttachmentId:'pdf-main',page:'1',quote:'Introduction'}];
  const result=Core.applyPlan(fixture(),[plan(citations)],{workspace:'科研'}).state;
  assert.deepEqual(result.papers[0].structured.methods.citations,citations);
  assert.equal(result.papers[0].structured.methods.verified,false);
  assert.equal(result.papers[0].reviewed,false);
  assert.match(result.notes[0].content,/第 3 页/);
});

test('missing page metadata allows positive page references but never creates a verification claim', () => {
  const action={...plan([{attachmentId:'pdf-unknown',page:999}]),sourceAttachmentIds:['pdf-unknown']};
  const result=Core.applyPlan(fixture(),[action],{workspace:'科研'}).state;
  assert.equal(result.papers[0].structured.methods.citations[0].page,999);
  assert.equal(result.papers[0].structured.methods.verified,false);
  assert.equal(result.papers[0].reviewed,false);
  assertRejectedWithoutMutation(fixture(),{...action,structured:{methods:{text:'Bad page',citations:[{attachmentId:'pdf-unknown',page:0}]}}},/正整数/);
});

test('incremental analysis validates old source references and retains human edits untouched', () => {
  const state=Core.applyPlan(fixture(),[plan([{attachmentId:'pdf-main',page:3,quote:'Method claim'}])],{workspace:'科研'}).state;
  const paper=state.papers[0];
  paper.userEdits={methods:{text:'Human correction',citations:[{attachmentId:'pdf-main',page:3,quote:'Method claim'}],verified:false}};
  paper.structured.methods=paper.userEdits.methods;paper.reviewed=true;paper.reviewedAt=1234;
  const update={...plan([{attachmentId:'pdf-unknown',page:1}]),id:paper.id,sourceAttachmentIds:['pdf-unknown'],userEdits:{methods:'Do not apply model-supplied edits'}};
  const result=Core.applyPlan(state,[update],{workspace:'科研'}).state;
  assert.equal(result.papers.length,1);assert.equal(result.papers[0].id,paper.id);
  assert.deepEqual(result.papers[0].userEdits,paper.userEdits);
  assert.deepEqual(result.papers[0].structured.methods,paper.userEdits.methods);
  assert.equal(result.papers[0].reviewed,true);assert.equal(result.papers[0].reviewedAt,1234);
  assert.deepEqual(result.papers[0].sourceAttachmentIds,['pdf-main','pdf-unknown']);
  // New fabricated evidence must not be silently hidden by an existing edit.
  assertRejectedWithoutMutation(state,{...update,structured:{methods:{text:'New analysis',citations:[{attachmentId:'ghost',page:1}]}}},/未关联/);
});

test('invalid retained human citation rejects increment instead of deleting or rewriting evidence', () => {
  const state=Core.applyPlan(fixture(),[plan([{attachmentId:'pdf-main',page:1}])],{workspace:'科研'}).state;
  state.papers[0].userEdits={methods:{text:'Do not destroy this correction',citations:[{attachmentId:'ghost',page:1}]}};
  const update={...plan([{attachmentId:'pdf-main',page:1}]),id:state.papers[0].id};
  assertRejectedWithoutMutation(state,update,/未关联/);
  assert.equal(state.papers[0].userEdits.methods.text,'Do not destroy this correction');
});
