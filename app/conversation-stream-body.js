/* DOM frontiers for the existing conversation Markdown parser. The parser's
 * stable prefix is authoritative; this adapter never defines Markdown grammar.
 * Performance cache only: uncertain grammar, ownership or external mutation
 * returns to the ordinary complete rendering path. */
(function(root,factory){const api=factory(root);root.ConversationStreamBody=api;if(typeof module==='object'&&module.exports)module.exports=api;})(globalThis,root=>{
 'use strict';
 function create({maxEntries=4,maxCharacters=2*1024*1024}={}){
  const owners=new Map();let staged=new WeakMap(),plans=new WeakMap(),serial=0;
  const dependenciesEqual=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>value===b[index]);
  const uncertain=text=>/(^|\n)[ \t]{0,3}\[[^\]\n]+\]:|\[\^[^\]\n]+\]|(?:wiki:|aibro:\/\/)/.test(text);
  function release(owner){const value=owners.get(owner);value?.observer.disconnect();owners.delete(owner);}
  function valid(value,previous){
   if(!value||owners.get(value.owner)!==value||value.body!==previous||!previous.isConnected)return false;
   if(value.observer.takeRecords().length)value.dirty=true;
   return !value.dirty;
  }
  function adopt(previous,next){
   const value=staged.get(next);staged.delete(next);if(!value)return;
   release(value.owner);
   if(!previous.isConnected||!value.prefix||!value.count||value.text.length+value.prefix.length>maxCharacters)return;
   const record={...value,body:previous,dirty:false};
   record.observer=new root.MutationObserver(()=>{record.dirty=true;});
   record.observer.observe(previous,{subtree:true,childList:true,characterData:true,attributes:true});
   owners.set(value.owner,record);
   const weight=()=>[...owners.values()].reduce((sum,item)=>sum+item.text.length+item.prefix.length,0);
   while(owners.size>maxEntries||weight()>maxCharacters)release(owners.keys().next().value);
  }
  function stage({owner,previous,host,html,text,prefix,dependencies,refresh,decorate}){
   if(typeof root.MutationObserver!=='function'||typeof prefix!=='string'||!prefix||!html.startsWith(prefix)||uncertain(text)){
    release(owner);return false;
   }
   let old=owners.get(owner);
   if(!valid(old,previous)||!text.startsWith(old.text)||!prefix.startsWith(old.prefix)||!dependenciesEqual(old.dependencies,dependencies)||!refresh)old=null;
   const skipped=old?.count||0,cut=old?.prefix.length||0;
   const marker=`aibro-stream-frontier-${++serial}`;
   const materialize=(skip)=>{
    host.innerHTML=prefix.slice(skip?cut:0)+`<!--${marker}-->`+html.slice(prefix.length);
    const boundaries=[...host.childNodes].filter(node=>node.nodeType===8&&node.nodeValue===marker);
    if(boundaries.length!==1){host.innerHTML=html;decorate?.(host);staged.delete(host);return false;}
    const boundary=boundaries[0],count=(skip?skipped:0)+[...host.childNodes].indexOf(boundary);boundary.remove();
    decorate?.(host);
    staged.set(host,{owner,text,prefix,count,dependencies});return true;
   };
   if(!materialize(!!old))return true;
   if(old)plans.set(host,{old,previous,skipped,refresh,materialize});
   return true;
  }
  function unchanged({owner,previous,host,text,verify,fallback}){
   const old=owners.get(owner);
   if(!valid(old,previous)||text!==old.text)return false;
   const refresh=verify(old.dependencies);if(typeof refresh!=='function')return false;
   // No parser/DOM work for a status-only update. The live observer catches
   // foreign edits, and prepare() rechecks ownership before committing.
   plans.set(host,{old,previous,unchanged:true,refresh,materialize:fallback});return true;
  }
  function prepare(previous,next,canPatch){
   const plan=plans.get(next);if(!plan)return;
   if(plan.previous!==previous||!valid(plan.old,previous)||!canPatch()){
    plans.delete(next);plan.materialize(false);
   }
  }
  function commit(previous,next,selection,patchTail){
   const plan=plans.get(next);if(!plan)return false;
   if(plan.unchanged){plans.delete(next);plan.refresh();plan.old.observer.takeRecords();return true;}
   // Highlighting changes a selected code block's Text nodes. Its existing
   // canonical path owns UTF-16 selection remapping; do not bypass that guard.
   const selectedCode=selection&&[selection.anchor,selection.focus].some(node=>node?.parentElement?.closest('pre.message-code'));
   if(!patchTail||selectedCode){plans.delete(next);plan.materialize(false);return false;}
   plans.delete(next);patchTail(plan.skipped);plan.refresh();adopt(previous,next);return true;
  }
  return{stage,unchanged,prepare,commit,adopt,release,clear(){for(const owner of owners.keys())release(owner);staged=new WeakMap();plans=new WeakMap();},inspect(){return{entries:owners.size,characters:[...owners.values()].reduce((sum,item)=>sum+item.text.length+item.prefix.length,0)};}};
 }
 return{create};
});
