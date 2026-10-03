const test=require('node:test'),assert=require('node:assert/strict');
// Minimal lifecycle-only DOM. Keyboard behavior uses conversation-tool-text's DOM.
const mkNode=tag=>{const node={tagName:String(tag).toUpperCase(),className:'',children:[],dataset:{},textContent:'',open:false,addEventListener(){},append(...kids){node.children.push(...kids);},querySelectorAll(){return[];}};return node;};
globalThis.document={createElement:tag=>mkNode(tag)};
const S=require('../app/tool-scheduler');
const shell=()=>({toolCalls:[
  {id:'t1',type:'read',status:'running',request:{type:'read'},startedAt:1},
  {id:'t2',type:'read',status:'completed',request:{type:'read'},startedAt:1,finishedAt:2}
]});
const rows=box=>box.children.filter(node=>String(node.className).includes('tool-ledger-row'));

test('执行中工具记录自动展开、终态自动收敛成一行',()=>{
  const running=shell();
  const box=S.card(running);
  assert.equal(box.open,true,'执行中的工具记录应自动展开，实时看到正在调用什么');
  assert.equal(rows(box)[0].open,true,'正在执行的工具行应自动展开');
  assert.equal(rows(box)[1].open,false,'已完成的工具行应保持收起');

  const settled=shell();settled.status='completed';settled.finishedAt=Date.now();
  const folded=S.card(settled);
  assert.equal(folded.open,false,'终态工具记录应收敛成“工具执行记录 · N”一行，把正文让给最终答案');
  assert.equal(rows(folded).every(row=>row.open===false),true,'终态所有工具行都收起');
});

test('刚创建、尚未写入状态的轮次按执行中处理',()=>{
  const fresh=shell(); // 无 status、无 finishedAt：run 创建后即处于执行中
  assert.equal(S.card(fresh).open,true);
});

test('等待审批视为已结算：工具记录收起，注意力交给审批卡片',()=>{
  const run=shell();run.status='awaiting-approval';
  assert.equal(S.card(run).open,false);
});

test('用户手动开合优先于自动状态，流式重绘与完成收束都不覆盖',()=>{
  const settled=shell();settled.status='completed';settled.finishedAt=Date.now();
  settled.toolLedgerPins={ledger:true,t2:true};
  const pinnedOpen=S.card(settled);
  assert.equal(pinnedOpen.open,true,'用户固定展开后，终态也不得自动收起');
  assert.equal(rows(pinnedOpen)[1].open,true,'用户固定展开的工具行同样保持展开');

  const live=shell();live.toolLedgerPins={ledger:false};
  assert.equal(S.card(live).open,false,'用户固定收起后，执行中也不得自动展开');
});

test('pin 只认显式布尔值；未记录过的键继续走自动逻辑',()=>{
  const run=shell();run.toolLedgerPins={t2:true};
  const box=S.card(run);
  assert.equal(box.open,true,'ledger 未 pin 时按执行中自动展开');
  assert.equal(rows(box)[1].open,true,'被 pin 的已完成行保持展开');
  assert.equal(rows(box)[0].open,true,'未 pin 的进行中行按自动逻辑展开');
});
