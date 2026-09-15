/* Manual composition preserves every input; approval uses the existing editor. */
(function(root,factory){const api=factory(root,typeof module==='object'&&module.exports?require('./research-wiki'):root.ResearchWiki,typeof module==='object'&&module.exports?require('./wiki-maintenance'):root.WikiMaintenance);if(typeof module==='object'&&module.exports)module.exports=api;else root.WikiMerge=api;})(globalThis,(root,W,M)=>{
'use strict';
const unique=x=>[...new Set(x)],clone=x=>JSON.parse(JSON.stringify(x));
const relative=(from,to)=>{const a=from.split('/').slice(0,-1),b=to.split('/');while(a.length&&b.length&&a[0]===b[0]){a.shift();b.shift();}return [...a.map(()=> '..'),...b.map(encodeURIComponent)].join('/');};
function eligible(state,id){const n=W.entries(state).find(n=>n.id===id);if(!n||n.wikiFileError)throw Error('条目已不可用，请刷新 Wiki。');if(n.aiDraft)throw Error('参与合并的条目有待审阅草稿，请先处理该草稿。');return n;}
function prepare(state,targetId,sourceIds){
 const target=eligible(state,targetId),sources=unique(sourceIds).filter(id=>id!==targetId).map(id=>eligible(state,id));
 if(!sources.length)throw Error('请选择至少一篇要合入的条目。');
 if(sources.some(n=>(n.projectId||null)!==(target.projectId||null)))throw Error('合并限于同一项目或同属独立条目的页面。');
 const targetPath=state._wikiFiles?.[target.id]?.path;
 if(!targetPath)throw Error('请先将目标条目迁入 Markdown Wiki。');
 const sourceLinks={...(target.wikiSourceLinks||{})};
 const bodies=sources.map(n=>{
  const path=state._wikiFiles?.[n.id]?.path;if(!path)throw Error('请先将参与合并的条目迁入 Markdown Wiki。');
  const body=String(n.content||''),edits=[];
  for(const m of M.mask(body).matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)){
   const href=m[1];if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href))continue;
   const source=W.resolveSource(state,n.id,href),linked=W.resolveLink(state,n.id,href);
   let newHref;
   if(source){if(!source.wikiVaultPath)throw Error('来源缺少可导出的文件路径，请先检查：'+n.title);newHref=relative(targetPath,source.wikiVaultPath);sourceLinks[newHref]=source.id;}
   else if(linked&&state._wikiFiles?.[linked])newHref=relative(targetPath,state._wikiFiles[linked].path)+(href.includes('#')?'#'+href.split('#').slice(1).join('#'):'');
   else throw Error('请先修复本地链接再合并：'+n.title+' · '+href);
   const start=m.index+m[0].lastIndexOf('('+href+')')+1;edits.push({start,end:start+href.length,text:newHref});
  }
  let content=body;for(const e of edits.reverse())content=content.slice(0,e.start)+e.text+content.slice(e.end);
  return '\n\n---\n\n## 合入：'+String(n.title).replace(/[\r\n]/g,' ')+'\n\n'+content;
 });
 const content=String(target.content||'')+bodies.join('');if(content.length>1000000)throw Error('合并后的正文超过单篇容量，请拆分合并。');
 return {targetId,sourceIds:sources.map(n=>n.id),versions:[target,...sources].map(n=>({id:n.id,value:JSON.stringify(n),file:JSON.stringify(state._wikiFiles?.[n.id])})),before:target.content,after:content,sourceNoteIds:unique([...(target.sourceNoteIds||[]),...sources.flatMap(n=>[n.id,...(n.sourceNoteIds||[])])]).filter(id=>id!==targetId),sourceAttachmentIds:unique([...(target.sourceAttachmentIds||[]),...sources.flatMap(n=>n.sourceAttachmentIds||[])]),wikiSourceLinks:sourceLinks};
}
function apply(state,proposal,now=Date.now()){
 for(const v of proposal.versions){const n=eligible(state,v.id);if(JSON.stringify(n)!==v.value||JSON.stringify(state._wikiFiles?.[v.id])!==v.file)throw Error('条目或路径已变化，请重新预览合并。');}
 const n=state.notes.find(n=>n.id===proposal.targetId),before=clone(n);
 n.aiDraft={title:n.title,content:proposal.after,sourceNoteIds:proposal.sourceNoteIds,sourceAttachmentIds:proposal.sourceAttachmentIds,wikiSourceLinks:proposal.wikiSourceLinks,origin:'manual-wiki-merge',createdAt:now,mergeSources:proposal.sourceIds.map(id=>({id,updatedAt:state.notes.find(n=>n.id===id).updatedAt||null}))};n.updatedAt=now;
 return {note:n,before};
}
let hooks;
async function open(targetId){try{
 await hooks.refresh();const state=hooks.getState(),target=eligible(state,targetId),d=document.createElement('dialog');d.className='wiki-dialog';d.id='wikiMergeDialog';
 const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;},button=(text,fn)=>{const b=el('button',text);b.className='secondary';b.type='button';b.onclick=fn;return b;};
 d.append(el('h2','合并到「'+target.title+'」'),el('p','选择同一项目的页面，预览后保存为可编辑草稿。原页面、原件和历史均保留；采纳后可按需将旧页面移入回收站。'));
 const selected=new Set(),choices=el('div',''),preview=el('pre',''),status=el('p','');preview.className='research-excerpt';let proposal=null;
 const stage=button('保存合并草稿',async()=>{stage.disabled=true;let change;try{if(hooks.busy())throw Error('请等待当前执行完成。');change=apply(hooks.getState(),proposal);await hooks.persist();d.close();hooks.open(targetId);}catch(e){if(change&&change.note.aiDraft?.origin==='manual-wiki-merge'){Object.keys(change.note).forEach(k=>delete change.note[k]);Object.assign(change.note,change.before);}status.textContent=e.message;}finally{stage.disabled=!proposal;}});stage.disabled=true;
 for(const n of W.entries(state).filter(n=>n.id!==targetId&&(n.projectId||null)===(target.projectId||null))){const label=el('label',''),check=el('input','');label.className='research-source-row';check.type='checkbox';check.disabled=!!n.aiDraft||!!n.wikiFileError;check.onchange=()=>{check.checked?selected.add(n.id):selected.delete(n.id);proposal=null;stage.disabled=true;preview.textContent='';};label.append(check,el('span',n.title+(n.aiDraft?' · 待审阅':'')));choices.append(label);}
 const inspect=button('预览合并',()=>{try{proposal=prepare(hooks.getState(),targetId,[...selected]);preview.textContent=proposal.after;status.textContent='原文完整保留，新增 '+proposal.sourceIds.length+' 篇。可在审阅编辑器中进一步整合。';stage.disabled=false;}catch(e){status.textContent=e.message;stage.disabled=true;proposal=null;}});
 const footer=el('footer','');footer.append(button('取消',()=>d.close()),inspect,stage);d.append(choices,status,preview,footer);d.addEventListener('close',()=>d.remove(),{once:true});document.body.append(d);d.showModal();
 }catch(e){hooks.toast(e.message);}}
return {prepare,apply,relative,init:h=>{hooks=h;},open};
});
