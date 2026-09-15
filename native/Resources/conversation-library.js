/* Pure workspace operations shared by the native sidebar and its regression tests. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NativeConversationLibrary=api;})(globalThis,()=>{
'use strict';
const list=v=>Array.isArray(v)?v:[];
const archived=x=>!!(x.archived||x.archivedAt||x.status==='archived');
const active=x=>x&&!x.deletedAt&&!x.deleted;
function apply(original,command,now=Date.now(),makeId=()=>`folder_${now}_${Math.random().toString(36).slice(2)}`){
 const s=JSON.parse(JSON.stringify(original)),{action,id,kind}=command;
 if(!['conversation','folder'].includes(kind))throw Error('无效的管理对象。');
 s.folders ||= {conversations:[],projects:[]};s.folders.conversations ||= [];s.trash ||= [];
 const folders=s.folders.conversations,chats=list(s.conversations),collection=kind==='folder'?folders:chats;
 let item=collection.find(x=>x.id===id&&active(x));
 if(action==='create'&&kind==='folder'){
  const name=String(command.name||'').trim();if(!name)throw Error('请填写文件夹名称。');
  folders.push({id:makeId(),name,createdAt:now,updatedAt:now});return s;
 }
 if(!item)throw Error('对象已不存在，请刷新后重试。');
 if(action==='save'){
  const name=String(command.name||'').trim();if(!name)throw Error('名称不能为空。');
  if(kind==='folder')item.name=name;else{
   const folder=command.folderId?folders.find(x=>x.id===command.folderId&&active(x)&&!archived(x)):null;
   if(command.folderId&&!folder)throw Error('目标文件夹不可用。');
   item.title=name;item.folderId=folder?.id||null;
   // A user rename must not be replaced by an automatically generated title.
   item.titleEdited=true;
  }
 }else if(action==='archive'||action==='restore'){
  const value=action==='archive';item.archived=value;delete item.archivedAt;if(item.status==='archived')delete item.status;
  if(kind==='folder')for(const chat of chats.filter(x=>x.folderId===id)){
   if(value&&!archived(chat)){chat.archived=true;chat.folderArchivedBy=id;chat.updatedAt=now;}
   else if(!value&&chat.folderArchivedBy===id){chat.archived=false;delete chat.folderArchivedBy;chat.updatedAt=now;}
  }
  else if(!value){delete item.folderArchivedBy;if(folders.some(f=>f.id===item.folderId&&archived(f)))item.folderId=null;}
 }else if(action==='delete'){
  const removed=kind==='folder'?chats.filter(x=>x.folderId===id):[item],ids=new Set(removed.map(x=>x.id));
  const runs=list(s.agentRuns).filter(x=>ids.has(x.conversationId)),linked=new Set([...ids,...runs.map(x=>x.id)]);
  const links=list(s.links).filter(x=>linked.has(x.sourceId)||linked.has(x.targetId));
  s.trash.push({id:`trash_${makeId()}`,type:kind==='folder'?'conversationFolder':'conversation',title:kind==='folder'?item.name:item.title,deletedAt:now,data:{conversations:removed,runs,links,...(kind==='folder'?{conversationFolders:[item]}:{})}});
  s.conversations=chats.filter(x=>!ids.has(x.id));s.agentRuns=list(s.agentRuns).filter(x=>!ids.has(x.conversationId));s.links=list(s.links).filter(x=>!linked.has(x.sourceId)&&!linked.has(x.targetId));
  if(kind==='folder')s.folders.conversations=folders.filter(x=>x.id!==id);
  if(ids.has(s.currentConversationId))s.currentConversationId=null;
  return s;
 }else throw Error('不支持的操作。');
 item.updatedAt=now;return s;
}
return {apply};
});
