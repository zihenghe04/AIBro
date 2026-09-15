(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.TaskDependencies=api;})(globalThis,root=>{
 'use strict';const active=t=>t&&!t.archived&&!t.deletedAt;const same=(a,b)=>(a.projectId||null)===(b.projectId||null)&&a.workspace===b.workspace;
 function validate(state,task,values){
  if(!Array.isArray(values)||values.length>100||values.some(x=>typeof x!=='string'))throw Error('依赖必须是最多100个任务ID的数组');const ids=[...new Set(values)];
  const tasks=new Map((state.tasks||[]).filter(active).map(t=>[t.id,t]));tasks.set(task.id,{...task,dependsOn:ids});
  for(const id of ids)if(id===task.id||!tasks.has(id)||!same(task,tasks.get(id)))throw Error('依赖必须是同一项目与空间中的其他有效任务；移动前请先清除依赖。');
  for(const other of tasks.values())if(other.id!==task.id&&(other.dependsOn||[]).includes(task.id)&&!same(task,other))throw Error('其他任务仍依赖此任务，请先解除依赖再移动。');
  const visiting=new Set(),done=new Set();const walk=id=>{if(visiting.has(id))throw Error('任务依赖不能形成循环');if(done.has(id))return;visiting.add(id);for(const dep of tasks.get(id)?.dependsOn||[])walk(dep);visiting.delete(id);done.add(id);};walk(task.id);return ids;
 }
 function readiness(state,task){const blocked=(task.dependsOn||[]).filter(id=>!state.tasks.some(t=>active(t)&&t.id===id&&same(t,task)&&t.status==='done'));return {ready:!blocked.length,blockedBy:blocked};}
 function editor(state,task){
  const old=root.document.querySelector('#taskDependencyFields');old?.remove();const box=root.document.createElement('div');box.className='task-field';box.id='taskDependencyFields';
  const label=root.document.createElement('label');label.textContent='前置任务';label.dataset.i18n='';box.append(label);
  for(const t of state.tasks.filter(t=>active(t)&&t.id!==task.id&&same(t,task))){const row=root.document.createElement('label');row.className='check-item';const input=root.document.createElement('input');input.type='checkbox';input.dataset.dependencyId=t.id;input.checked=(task.dependsOn||[]).includes(t.id);const title=root.document.createElement('span');title.dataset.userContent='';title.textContent=t.title;row.append(input,title);if(t.status==='done'){const status=root.document.createElement('span');status.dataset.i18n='';status.textContent='已完成';row.append(root.document.createTextNode(' · '),status);}box.append(row);}
  const missing=(task.dependsOn||[]).filter(id=>!state.tasks.some(t=>active(t)&&same(t,task)&&t.id===id));for(const id of missing){const row=root.document.createElement('label'),input=root.document.createElement('input');input.type='checkbox';input.dataset.dependencyId=id;input.checked=true;const label=root.document.createElement('span');label.dataset.i18n='';label.textContent='已不可用的前置任务，可取消此关联';row.append(input,label);box.append(row);}
  root.document.querySelector('#taskDialogBody')?.append(box);
 }
 return {validate,readiness,editor};
});
