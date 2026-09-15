(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FileReview=api;})(globalThis,root=>{
'use strict';
const clone=x=>x==null?null:JSON.parse(JSON.stringify(x));
const fields={note:['title','content','folderPath','projectId','workspace','sourceAttachmentIds','aiDraft','userEdited','userEditedAt','updatedAt'],import:['name','folderPath','projectId','workspace','updatedAt']};
function record(type,item){if(!item)return null;return Object.fromEntries(fields[type].filter(k=>Object.hasOwn(item,k)).map(k=>[k,clone(item[k])]));}
function body(type,value){if(!value)return '';return type==='note'?String(value.aiDraft?.content ?? value.content ?? ''):Object.entries(value).filter(([key])=>key!=='updatedAt').map(([key,val])=>`${key}: ${val??''}`).join('\n');}
function lines(value){return value===''?[]:String(value).split('\n');}
function diff(before,after){
 const a=lines(before),b=lines(after);let start=0,end=0;
 while(start<a.length&&start<b.length&&a[start]===b[start])start++;
 while(end<a.length-start&&end<b.length-start&&a[a.length-end-1]===b[b.length-end-1])end++;
 const x=a.slice(start,a.length-end),y=b.slice(start,b.length-end),middle=[];
 if(x.length*y.length<=1000000){
  const table=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i][j]=x[i]===y[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
  let i=0,j=0;while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){middle.push({type:'same',text:x[i++]});j++;}else if(j<y.length&&(i===x.length||table[i][j+1]>table[i+1][j]))middle.push({type:'add',text:y[j++]});else middle.push({type:'remove',text:x[i++]});}
 }else{for(const text of x)middle.push({type:'remove',text});for(const text of y)middle.push({type:'add',text});}
 let old=0,next=0;return [...a.slice(0,start).map(text=>({type:'same',text})),...middle,...a.slice(a.length-end).map(text=>({type:'same',text}))].map(row=>({...row,old:row.type==='add'?null:++old,next:row.type==='remove'?null:++next}));
}
function capture(before,after,results){
 const unique=new Map();for(const result of results||[]){if(!fields[result.type])continue;unique.set(`${result.type}:${result.id}`,result);}
 return [...unique.values()].flatMap(result=>{
  const key=result.type==='note'?'notes':'imports',old=(before[key]||[]).find(x=>x.id===result.id),next=(after[key]||[]).find(x=>x.id===result.id);if(!next)return [];
  const a=record(result.type,old),b=record(result.type,next);if(JSON.stringify(a)===JSON.stringify(b))return [];
  const rows=diff(body(result.type,a),body(result.type,b));
  return [{type:result.type,id:result.id,title:next.title||next.name,folderPath:next.folderPath||'',before:a,after:b,added:rows.filter(x=>x.type==='add').length,removed:rows.filter(x=>x.type==='remove').length,operation:result.operation||(!old?'created':'updated')}];
 });
}
function undo(state,change,now=Date.now()){
 if(change.undoneAt)throw Error('这项修改已经撤销。');
 const key=change.type==='note'?'notes':'imports',item=(state[key]||[]).find(x=>x.id===change.id);
 if(!item||JSON.stringify(record(change.type,item))!==JSON.stringify(change.after))throw Error('文件已有后续修改，不能覆盖。请查看当前文件后手动编辑。');
 if(!change.before){
  if(change.type!=='note')throw Error('原始资料请在资料详情中管理。');
  const links=(state.links||[]).filter(x=>x.sourceId===item.id||x.targetId===item.id);
  state.trash ||= [];state.trash.push({id:`trash_review_${now}_${Math.random().toString(36).slice(2)}`,type:'note',title:item.title,deletedAt:now,data:{notes:[clone(item)],links:clone(links)}});
  state.notes=state.notes.filter(x=>x.id!==item.id);state.links=(state.links||[]).filter(x=>x.sourceId!==item.id&&x.targetId!==item.id);
 }else{
  if(change.type==='note'){item.revisionHistory ||= [];item.revisionHistory.push({title:item.title,content:item.content,savedAt:now,updatedAt:item.updatedAt});}
  for(const field of fields[change.type]){if(Object.hasOwn(change.before,field))item[field]=clone(change.before[field]);else delete item[field];}
  item.updatedAt=now;
 }
 change.undoneAt=now;
}
let hooks;
const element=(tag,cls,text)=>{const el=root.document.createElement(tag);el.className=cls||'';if(text!==undefined)el.textContent=text;return el;};
const button=(text,action)=>{const el=element('button','secondary',text);el.type='button';el.onclick=action;return el;};
function card(run){
 if(!run?.fileChanges?.length)return null;
 const section=element('section','file-change-card');const header=element('header');header.append(element('strong','',`本轮文件 · ${run.fileChanges.length} 项`),button('审阅修改',()=>hooks.open(run.id)));section.append(header);
 const list=element('div','file-change-list');
 run.fileChanges.forEach(change=>{const row=button('',()=>hooks.openFile(change.type,change.id));row.className='file-change-row';row.append(element('span','file-change-name',`${change.folderPath?change.folderPath+'/':''}${change.title}${change.type==='note'?'.md':''}`),element('span','file-change-stat',change.undoneAt?'已撤销':`${change.operation==='drafted'?'待采纳 · ':''}+${change.added} −${change.removed}`));list.append(row);});section.append(list);return section;
}
function render(container,run){
 container.replaceChildren();const layout=element('section','file-review');
 const tree=element('nav','file-review-tree');tree.setAttribute('aria-label','本轮修改文件');const search=element('input');search.placeholder='筛选本轮文件…';search.setAttribute('aria-label','筛选本轮文件');tree.append(search);
 const viewer=element('div','file-review-viewer');layout.append(tree,viewer);container.append(layout);
 const entries=[];
 const select=change=>{
  for(const [entry,control] of entries)control.setAttribute('aria-pressed',String(entry===change));
  viewer.replaceChildren();const title=element('h3','',change.title);const actions=element('div','file-review-actions');
  const content=element('div','file-review-content');
  const show=mode=>{content.replaceChildren();if(mode==='diff'){
   const rows=diff(body(change.type,change.before),body(change.type,change.after));let shown=0;
   const table=element('div','file-review-diff');const more=button('继续显示',append);
   function append(){rows.slice(shown,shown+600).forEach(row=>{const line=element('div','diff-line '+row.type);line.append(element('span','diff-number',`${row.old??''}`),element('span','diff-number',`${row.next??''}`),element('span','diff-sign',row.type==='add'?'+':row.type==='remove'?'−':' '),element('code','',row.text));table.append(line);});shown+=600;more.hidden=shown>=rows.length;}
   append();content.append(table,more);
  }else if(mode==='preview'&&change.type==='note'){const article=element('article','note-document-preview');article.innerHTML=hooks.markdown(body(change.type,change.after));content.append(article);}else{content.append(element('pre','',body(change.type,change.after)));}};
  actions.append(button('Diff',()=>show('diff')),button('修改后源码',()=>show('source')));
  if(change.type==='note')actions.append(button('排版预览',()=>show('preview')));
  actions.append(button('打开当前文件',()=>hooks.openFile(change.type,change.id)));
  if(!change.undoneAt&&(change.before||change.type==='note'))actions.append(button('撤销此项',async()=>{if(!root.confirm('撤销这项修改？只有文件仍与本轮修改后版本一致时才会执行。新建笔记会进入回收站。'))return;try{await hooks.undo(run,change);select(change);}catch(error){hooks.toast(error.message);}}));
  viewer.append(title,element('p','muted',change.undoneAt?'已撤销 · 以下保留本轮历史变更':change.operation==='drafted'?'这是待采纳草稿，原正文尚未被替换。':'本轮变更快照 · 当前文件可能已有后续修改'),actions,content);show('diff');
 };
 for(const change of run.fileChanges){const b=button(change.title,()=>select(change));b.className='file-review-file';entries.push([change,b]);tree.append(b);}
 search.oninput=()=>entries.forEach(([entry,b])=>{b.hidden=!entry.title.toLowerCase().includes(search.value.toLowerCase());});
 if(run.fileChanges.length)select(run.fileChanges[0]);
}
return {capture,diff,undo,record,init(value){hooks=value;},card,render};
});
