/* Public profile catalog + in-memory editor drafts. Keys never enter UI props/storage. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.APIProfiles=api;})(globalThis,function(root){
 'use strict';
 const managers=new Set();
 const copy=value=>JSON.parse(JSON.stringify(value));
 const fail=message=>Object.assign(Error(message),{code:'CREDENTIAL_PROFILE_CHANGED'});
 function create({bridge,readForm,writeForm,fromProfile,toProfile,onActivate=()=>{},onChange=()=>{},isBusy=()=>false,makeID=()=>root.crypto.randomUUID()}){
  let catalog=null,selected='',name='',busy=false,error='',island=null,changed=false,loading=null;
  const drafts=new Map();
  function view(){return {ready:!!catalog,revision:catalog?.revision,busy:busy||isBusy(),selected,name,dirty:changed,error,active:catalog?.activeProfileID||'',profiles:[...(catalog?.profiles||[]).map(p=>({id:p.id,name:p.name})),...[...drafts].filter(([id])=>!metadata(id)&&id!==selected).map(([id,d])=>({id,name:d.name+' · 未保存'}))],isNew:!!selected&&!catalog?.profiles.some(p=>p.id===selected)};}
  function paint(){island?.update({...view()});}
  function formIdentity(){const form=copy(readForm());delete form.profileId;delete form.profileRevision;delete form.awaitingRestore;return JSON.stringify(form);}
  function stash(){if(selected)drafts.set(selected,{name,form:copy(readForm()),dirty:changed});}
  function metadata(id){return catalog?.profiles.find(p=>p.id===id);}
  function receipt(value){
   if(!value||!Array.isArray(value.profiles)||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.activeProfileID!=='string')throw Error('无法读取已保存方案；当前输入已保留。');
   return {revision:value.revision,activeProfileID:value.activeProfileID,profiles:value.profiles.map(p=>({id:p.id,name:p.name,base:p.base,model:p.model,settings:p.settings&&copy(p.settings)}))};
  }
  function show(id){selected=id;const draft=drafts.get(id),p=metadata(id);name=draft?.name||p?.name||'新方案';changed=!!draft?.dirty;writeForm(copy(draft?.form||fromProfile(p||null)));onChange(changed);}
  async function load(){
   if(catalog)return view();if(loading)return loading;
   // Opening settings only fetches public metadata, never a stored Key.
   const before=formIdentity();busy=true;paint();
   loading=(async()=>{try{const result=await bridge.profiles(),edited=before!==formIdentity()||changed;catalog=receipt(result);selected=catalog.activeProfileID||makeID();const p=metadata(selected);name=p?.name||'新方案';
    await onActivate(p||null,{initial:true,preserveDraft:edited});
    if(!edited&&before===formIdentity())show(selected);else{changed=true;stash();}error='';return view();
   }catch(e){error=e.message;throw e;}finally{busy=false;loading=null;paint();}})();return loading;
  }
  async function reload(){if(busy||isBusy())return false;stash();busy=true;paint();try{catalog=receipt(await bridge.profiles());error='方案列表已刷新；当前未保存输入仍保留，请检查后再保存。';return true;}catch(e){error=e.message;return false;}finally{busy=false;paint();}}
  async function choose(id){
   if(busy||isBusy()||id===selected)return false;if(!catalog)throw fail('方案尚未加载，请稍后重试。');stash();busy=true;error='';paint();
   try{
    const p=metadata(id);if(!p&&!drafts.has(id))throw fail('此方案已经移除，请重新打开设置。');
    if(p){catalog=receipt(await bridge.selectProfile({id,expectedRevision:catalog.revision}));await onActivate(metadata(id),{initial:false});}
    stash();show(id);return true;
   }catch(e){error=e.message;return false;}finally{busy=false;paint();}
  }
  function add(){if(busy||isBusy()||!catalog)return false;stash();selected=makeID();name='新方案';changed=true;writeForm(copy(fromProfile(null)));onChange(true);error='';paint();return true;}
  function editName(value){name=String(value).slice(0,80);changed=true;onChange(true);paint();}
  function touch(){changed=true;onChange(true);paint();}
  function hasPending(){return busy||changed||[...drafts.values()].some(d=>d.dirty);}
  function discard(){if(busy||isBusy())return false;drafts.delete(selected);if(metadata(selected)){show(selected);changed=false;onChange(false);paint();return true;}return remove();}
  function capture(){return catalog?{profileId:selected,profileRevision:catalog.revision}:{};}
  async function save(form){
   if(busy||!catalog)throw fail('方案尚未就绪，请稍后重试。');
   const id=selected,savedName=name.trim();if(!savedName)throw Error('请给这个方案起一个名称。');
   busy=true;error='';paint();
   try{const next=await bridge.saveProfile({...toProfile(copy(form)),id,name:savedName,expectedRevision:catalog.revision});catalog=receipt(next);return metadata(id);}
   catch(e){error=e.message;throw e;}finally{busy=false;paint();}
  }
  function acknowledge(form){if(JSON.stringify(toProfile(readForm()))===JSON.stringify(toProfile(form))){changed=false;drafts.delete(selected);}paint();}
  async function remove(){
   if(busy||isBusy()||!catalog)return false;
   if(!metadata(selected)){drafts.delete(selected);show(catalog.activeProfileID||makeID());paint();return true;}
   busy=true;error='';paint();try{const id=selected;catalog=receipt(await bridge.removeProfile({id,expectedRevision:catalog.revision}));drafts.delete(id);const next=catalog.activeProfileID||makeID();await onActivate(metadata(next)||null,{initial:false});show(next);return true;}catch(e){error=e.message;return false;}finally{busy=false;paint();}
  }
  async function read(captured,base){
   if(!catalog)await load();
   const id=captured?.profileId,revision=captured?.profileRevision;
   if(!id||!Number.isSafeInteger(revision)||!metadata(id))throw fail('此方案尚未保存，请填写 Key 并保存。');
   // Native validates the complete endpoint and revision while holding its lock.
   return bridge.readProfile({id,base,expectedRevision:revision});
  }
  function mount(host,{label,onSave,confirmRemove=()=>root.confirm('删除这个 API 方案及其 Key？其他方案和资料会保留。')}={}){
   if(!root.HalaskaUI?.mount||!host)return false;
   island=root.HalaskaUI.mount(host,'APIProfileBar',{...view(),label,onDiscard:discard,onReload:()=>void reload(),onChoose:id=>void choose(id),onName:editName,onNew:add,onSave,onRemove:()=>{if(confirmRemove())void remove();}});return true;
  }
  const api={load,reload,choose,add,save,read,remove,discard,hasPending,capture,touch,acknowledge,paint,mount,view};managers.add(api);return api;
 }
 return {create,hasPending:()=>[...managers].some(manager=>manager.hasPending())};
});
