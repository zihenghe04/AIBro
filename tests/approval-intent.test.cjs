const test=require('node:test');
const assert=require('node:assert/strict');
const Intent=require('../app/approval-intent.js');
const Checkpoint=require('../app/run-checkpoint.js');

const capture=(text,extra={})=>Intent.capture({source:'current-user',role:'user',runId:'run',userMessageId:'user',text,...extra});

test('direct current-turn preview and personal-confirmation instructions narrow execution',()=>{
  const requests=[
    '请生成修改审阅让我确认',
    '请把任务分类改为日常。生成修改审阅让我确认。',
    '请先生成修改审阅，让我确认。',
    '请先给我看一下修改，等我确认后再应用。',
    '把这个任务改成日常分类，先让我确认。',
    '本轮请先不要执行，只生成计划。',
    '不要直接修改资料',
    '先不要修改任何文件',
    '不要执行，先给我方案',
    '修改前先让我确认',
    '等我批准之后才能执行',
    '只生成修改预览',
    '先预览修改再执行',
    'Please show me the proposed changes before applying them.',
    'Generate a change review for me to confirm.',
    'Let me review the edits first.',
    'Wait for my approval before updating it.',
    'Before applying changes, ask me to approve them.',
    "Please don't execute anything yet.",
    'Please don’t modify any records.',
    'Preview only',
  ];
  for(const text of requests)assert.ok(capture(text),text);
});

test('review nouns, research content, quoted examples and negative permission statements do not create intent',()=>{
  const requests=[
    '总结论文的同行审阅结论',
    '确认一下论文作者是谁',
    '帮我整理同行审阅意见并生成笔记',
    '查找标题为“先预览修改再执行”的笔记',
    '把任务标题改成“不要执行”，分类改为日常',
    '论文写道：“修改前先让我确认”。解释它的意思。',
    '请翻译：\n> Do not execute any changes.\n解释这段话。',
    '分析代码\n```text\n不要执行\n```\n然后总结。',
    'Read `do not apply changes` in this example.',
    'Explain the phrase “wait for my approval before updating it”.',
    'Explain the phrase ‘do not execute it’.',
    'The author says do not execute any changes.',
    'Summarize the peer review comments.',
    'Review the methods in this paper.',
    '无需确认，更新任务分类。',
    '不需要让我确认，请执行。',
    '我没有要求你不要执行。',
    'I do not need a preview. Update the task.',
    'No need to ask me for confirmation.',
    '先把计划写到笔记里',
    '把任务分类改成科研，不要修改项目、日期或内容',
    '创建新笔记，不要删除原文',
    'Update the category, do not modify the title',
    '修改任务标题，但不要更新截止日期',
  ];
  for(const text of requests)assert.equal(capture(text),null,text);
});

test('code, quotes and ordinary text cannot conceal a separate genuine instruction',()=>{
  for(const text of [
    '把“审阅论文”任务改成日常。先生成修改审阅让我确认。',
    'Example: `apply changes`\nPlease do not apply changes.',
    '```\nexecute it\n```\n等我确认后再执行。',
    '先不要执行。无需确认，直接执行。',
  ])assert.ok(capture(text),text);
});

test('only a host-labelled current user message can supply the one-run constraint',()=>{
  for(const source of ['attachment','quoted','history','model','tool','subagent','automation',undefined])
    assert.equal(capture('不要执行',{source}),null,source);
  for(const role of ['agent','assistant','system','tool',undefined])assert.equal(capture('不要执行',{role}),null,role);
  assert.throws(()=>capture('不要执行',{userMessageId:null}),{code:'REVIEW_INTENT_OWNER'});
  const intent=capture('不要执行');
  assert.equal(Object.isFrozen(intent),true);assert.equal(Object.isFrozen(intent.rules),true);
  assert.equal(Object.hasOwn(intent,'text'),false,'No duplicated user text stored in metadata');
  assert.equal(JSON.stringify(intent).includes('不要执行'),false);
});

test('review cannot be erased by session allowances, full mode or delegated-review preferences',()=>{
  for(const permissionMode of ['legacy','smart','full','request']){
    const run={id:'run',userMessageId:'user',approvalIntent:capture('请生成修改审阅让我确认'),permissionMode,
      pendingActions:[{type:'update_task'}],sessionAllows:{update_task:1},reviewerApprove:true,approvedBy:'reviewer'};
    assert.equal(Intent.requiresHumanReview(run),true);
    assert.throws(()=>Intent.assertAutomaticAllowed(run,run.pendingActions),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  }
  const next={id:'next',userMessageId:'next-user',pendingActions:[{type:'update_task'}]};
  assert.equal(Intent.requiresHumanReview(next),false,'A subsequent unrelated run retains its normal policy');
  assert.equal(Intent.requiresHumanReview({approvalIntent:capture('不要执行')},[]),false,'Read-only answers do not grow an empty approval card');
});

test('persisted constraint owner/version corruption fails closed for automatic effects',()=>{
  const base={id:'run',userMessageId:'user',pendingActions:[{type:'update_task'}],approvalIntent:capture('不要执行')};
  for(const change of [{runId:'other'},{userMessageId:'other'},{version:2},{scope:'shell'},{requireHumanReview:false},{rules:['model-approved']},{rules:[]}]){
    const run={...base,approvalIntent:{...base.approvalIntent,...change}};
    assert.equal(Intent.requiresHumanReview(run),true);
    assert.throws(()=>Intent.assertAutomaticAllowed(run,run.pendingActions),{code:'REVIEW_INTENT_CHANGED'});
  }
});

function checkpointFixture(saved){
  let state=saved?structuredClone(saved):{tasks:[{id:'task',workflowCategory:'P1'}],conversations:[{id:'chat',messages:[{id:'answer',text:'partial',live:true}]}],
    agentRuns:[{id:'run',userMessageId:'user',conversationId:'chat',status:'running',permissionMode:'full',
      approvalIntent:capture('请生成修改审阅让我确认'),pendingActions:[{type:'update_task',taskId:'task',patch:{workflowCategory:'P3'}}]}]};
  const calls={apply:0,persist:0};
  const api=Checkpoint.create({getState:()=>state,persist:async()=>{calls.persist++;return true;},
    validate:(run,actions)=>Intent.assertAutomaticAllowed(run,actions),
    apply:(actions,run,beforeCommit)=>{calls.apply++;beforeCommit();state.tasks[0].workflowCategory=actions[0].patch.workflowCategory;run.results=[{type:'task',id:'task',operation:'updated'}];return run.results;}});
  return {api,calls,get state(){return state;},get run(){return state.agentRuns[0];}};
}

test('real checkpoint preserves preview and never applies on preparation, retry or restored continuation',async()=>{
  const f=checkpointFixture();
  await assert.rejects(f.api.prepare('run','answer',{answer:'请审阅确认'}),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  assert.equal(f.calls.apply,0);assert.equal(f.state.tasks[0].workflowCategory,'P1');
  assert.equal(f.run.executionReceipt.phase,'prepared');
  assert.deepEqual(f.run.executionReceipt.actions,f.run.pendingActions);
  await assert.rejects(f.api.continue('run'),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  const restored=checkpointFixture(f.state);restored.api.recover(restored.state);
  await assert.rejects(restored.api.continue('run'),{code:'CHECKPOINT_REVIEW_REQUIRED'});
  assert.equal(restored.calls.apply,0);assert.equal(restored.state.tasks[0].workflowCategory,'P1');
});

test('host receipt wording replaces stale waiting prose after approval and saving',()=>{
  const run={approvalIntent:capture('不要执行')};
  assert.match(Intent.messageFor(run,'pending','分类 P1 → P3'),/尚未执行[\s\S]*P1 → P3/);
  assert.match(Intent.messageFor(run,'saving'),/正在保存/);
  assert.match(Intent.messageFor(run,'completed'),/执行并保存/);
  assert.doesNotMatch(Intent.messageFor(run,'completed'),/等待|待确认|尚未执行|请核对/);
  assert.equal(Intent.messageFor({},'completed'),null,'Ordinary responses are unchanged');
});
