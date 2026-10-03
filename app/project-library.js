/* Project library navigation: records are already scoped and privacy filtered
 * by the caller. Folder metadata is an index, never a filesystem lookup. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ProjectLibrary=api;})(globalThis,root=>{
  'use strict';
  const scopes=new Set(['content','records','all']),memoryTypes=new Set(['daily','plan','long']);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const own=(value,key)=>object(value)&&Object.hasOwn(value,key)?value[key]:undefined;
  const put=(target,key,value)=>{Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});return value;};
  const map=(target,key)=>{const current=own(target,key);return object(current)?current:put(target,key,{});};
  const cleanPath=value=>typeof value==='string'?value.replace(/\\/g,'/').split('/').filter(Boolean).join('/'):'';
  const safeExpansion=value=>Object.fromEntries(Object.entries(object(value)?value:{}).filter(([path,open])=>!!path&&typeof open==='boolean'));
  const isProjectRecord=record=>own(record,'_type')==='note'&&memoryTypes.has(own(record,'projectMemoryType'));
  const ancestors=path=>typeof path==='string'&&path?path.split('/').slice(0,-1).map((_,i)=>path.split('/').slice(0,i+1).join('/')):[];
  function buildModel(records=[],selected=null,expansion={},folders=[]){
    const rows=Array.isArray(records)?records.filter(item=>item&&typeof item==='object'):[],index=new Map(),roots=[];
    let uncategorized=0;
    for(const record of rows){const path=cleanPath(record.folderPath);if(!path){uncategorized++;continue;}
      let children=roots;
      const parts=path.split('/');
      for(let i=0;i<parts.length;i++){
        const key=parts.slice(0,i+1).join('/');let node=index.get(key);
        if(!node){node={path:key,label:parts[i],count:0,children:[]};index.set(key,node);children.push(node);}
        node.count++;children=node.children;
      }
    }
    // Explicit shared directories survive with zero records; they never count
    // as a source or a project-memory record.
    for (const folder of Array.isArray(folders)?folders:[]) {
      const path=cleanPath(folder.folderPath);if(!path)continue;
      let children=roots;const parts=path.split('/');
      for(let i=0;i<parts.length;i++){
        const key=parts.slice(0,i+1).join('/');let node=index.get(key);
        if(!node){node={path:key,label:parts[i],count:0,children:[]};index.set(key,node);children.push(node);}children=node.children;
      }
    }
    const requested=selected===null?null:cleanPath(selected);
    const current=requested===null||requested===''&&uncategorized>0||index.has(requested)?requested:null;
    const overrides=safeExpansion(expansion),parents=ancestors(current),parentSet=new Set(parents);
    function arrange(nodes){nodes.sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'));for(const node of nodes){node.selected=node.path===current;node.expanded=node.children.length>0&&(Object.hasOwn(overrides,node.path)?overrides[node.path]:parentSet.has(node.path));arrange(node.children);}}
    arrange(roots);
    const breadcrumbs=current===null?[]:current===''?[{path:'',label:''}]:[...parents,current].map(path=>({path,label:index.get(path).label}));
    return {roots,count:rows.length,uncategorized,selected:current,expansion:overrides,breadcrumbs,hiddenSelection:parents.some(path=>!index.get(path).expanded)};
  }
  // Only explicit note metadata identifies a project record. Folder names and
  // titles are user content, including names resembling the built-in folders.
  function publicFolders(state,projectId,access){
    const projects=Array.isArray(state?.projects)?state.projects.filter(row=>row?.id===projectId):[];
    const project=projects[0],hidden=row=>['private','ephemeral','incognito','deleted','deletedAt','archived','archivedAt'].some(key=>row?.[key])||['deleted','archived'].includes(row?.status);
    if(projects.length!==1||hidden(project)||!access)return [];
    const ref={type:'local',projectId,candidateId:project.localFolder?.id};
    if(!access.access(ref).available||access.isAmbiguous(ref))return [];
    const rows=Array.isArray(state.folders?.library)?state.folders.library:[];
    return rows.filter(row=>{
      if(!row?.id||hidden(row)||row.projectId!==projectId||row.workspace!==project.workspace||typeof row.folderPath!=='string'||!row.folderPath)return false;
      if(rows.filter(item=>item?.id===row.id).length!==1||rows.filter(item=>item?.projectId===projectId&&item.workspace===row.workspace&&item.folderPath===row.folderPath).length!==1)return false;
      return !['imports','notes','papers'].some(type=>(Array.isArray(state[type])?state[type]:[]).some(item=>{
        const path=cleanPath(item.folderPath);if(item.projectId!==projectId||!(path===row.folderPath||path.startsWith(row.folderPath+'/')))return false;
        const ref={type:{imports:'import',notes:'note',papers:'paper'}[type],id:item.id};
        return hidden(item)||!access.access(ref).available||access.isAmbiguous(ref);
      }));
    });
  }
  function scopeModel(records=[],ui={},projectId,folders=[]){
    const all=Array.isArray(records)?records.filter(object):[],recordRows=all.filter(isProjectRecord),content=all.filter(record=>!isProjectRecord(record));
    const counts={content:content.length,records:recordRows.length,all:all.length};
    const legacy=own(own(ui,'projectLibraryFolders'),projectId),legacyFolder=typeof legacy==='string'?cleanPath(legacy):null;
    const storedScope=own(own(ui,'projectLibraryScopes'),projectId);
    let scope=scopes.has(storedScope)?storedScope:'content';
    if(!scopes.has(storedScope)&&legacyFolder!==null&&buildModel(recordRows,legacyFolder).selected===legacyFolder&&buildModel(content,legacyFolder).selected!==legacyFolder)scope='records';
    const rows=scope==='records'?recordRows:scope==='all'?all:content;
    const location=own(own(own(ui,'projectLibraryLocations'),projectId),scope);
    const selected=object(location)?own(location,'folder'):legacyFolder;
    const expansion=object(location)?own(location,'expansion'):own(own(ui,'projectLibraryExpansion'),projectId);
    const model=buildModel(rows,typeof selected==='string'?selected:null,expansion,scope==='records'?[]:folders);
    return {scope,counts,records:rows,selected:model.selected,expansion:model.expansion};
  }
  function rememberLocation(ui,projectId,scope,{selected=null,expansion={}}={}){
    if(!object(ui)||typeof projectId!=='string'||!projectId||!scopes.has(scope))return null;
    const location={folder:typeof selected==='string'?cleanPath(selected):null,expansion:safeExpansion(expansion)};
    put(map(map(ui,'projectLibraryLocations'),projectId),scope,location);
    put(map(ui,'projectLibraryScopes'),projectId,scope);
    put(map(ui,'projectLibraryFolders'),projectId,location.folder);
    put(map(ui,'projectLibraryExpansion'),projectId,{...location.expansion});
    return location;
  }
  function selectScope(ui,projectId,next,publicTypedRecords=[],folders=[]){
    const current=scopeModel(publicTypedRecords,ui,projectId,folders);
    if(!object(ui)||typeof projectId!=='string'||!projectId||!scopes.has(next))return current;
    rememberLocation(ui,projectId,current.scope,current);
    const locations=map(map(ui,'projectLibraryLocations'),projectId);
    // An unvisited scope starts at its root; the compatibility mirror belongs
    // to the scope we just left and must not become its initial location.
    if(!object(own(locations,next)))put(locations,next,{folder:null,expansion:{}});
    put(map(ui,'projectLibraryScopes'),projectId,next);
    const result=scopeModel(publicTypedRecords,ui,projectId,folders);
    rememberLocation(ui,projectId,next,result);
    return result;
  }
  const hosts=new WeakMap();
  function mount(host,initial={}){
    if(!host||!root.HalaskaUI)return null;
    if(hosts.has(host)){const existing=hosts.get(host);existing.update(initial);return existing;}
    let props={...initial},disposed=false,model,oldBreadcrumb=null;
    const clearBreadcrumb=()=>{if(oldBreadcrumb){root.HalaskaUI.unmount(oldBreadcrumb);oldBreadcrumb=null;}};
    function render(){
      if(disposed)return;
      model=buildModel(props.records,props.selected,props.expansion,props.scope==='records'?[]:props.folders);
      const common={projectId:String(props.projectId||''),model,scope:scopes.has(props.scope)?props.scope:'content',counts:props.counts||{content:model.count,records:0,all:model.count},onScope:changeScope,onSelect:select,onToggle:toggle,onReveal:revealSelection};
      root.HalaskaUI.mount(host,'ProjectLibraryNavigation',common);
      if(oldBreadcrumb&&oldBreadcrumb!==props.breadcrumbHost)clearBreadcrumb();
      if(props.breadcrumbHost){root.HalaskaUI.mount(props.breadcrumbHost,'ProjectLibraryBreadcrumb',common);oldBreadcrumb=props.breadcrumbHost;}
    }
    function changeScope(next){
      if(disposed||!scopes.has(next)||next===(scopes.has(props.scope)?props.scope:'content'))return;
      props.onScope?.(next,{projectId:props.projectId});
    }
    function select(path){
      if(disposed)return;
      const next=buildModel(props.records,path,props.expansion,props.scope==='records'?[]:props.folders),expansion={...next.expansion};
      for(const parent of ancestors(next.selected))Object.defineProperty(expansion,parent,{value:true,enumerable:true,writable:true,configurable:true});
      props={...props,selected:next.selected,expansion};render();
      props.onSelect?.(next.selected,{projectId:props.projectId,expansion});
    }
    function toggle(path,expanded){
      if(disposed)return;
      const expansion=safeExpansion(props.expansion);Object.defineProperty(expansion,path,{value:!!expanded,enumerable:true,writable:true,configurable:true});
      props={...props,expansion};render();props.onToggle?.(path,!!expanded,expansion,{projectId:props.projectId});
    }
    function revealSelection(){
      if(disposed)return;
      const expansion=safeExpansion(props.expansion);
      for(const parent of ancestors(model.selected))Object.defineProperty(expansion,parent,{value:true,enumerable:true,writable:true,configurable:true});
      props={...props,expansion};render();
      props.onToggle?.(model.selected,true,expansion,{projectId:props.projectId,reveal:true});
      host.querySelector('[aria-current="page"]')?.focus();
    }
    const api={update(next={}){
      const changed=Object.hasOwn(next,'projectId')&&next.projectId!==props.projectId;
      props={...props,...(changed?{selected:null,expansion:{},scope:'content',counts:undefined,folders:[]}:{}),...next};render();return api;
    },revealSelection,unmount(){if(disposed)return;disposed=true;root.HalaskaUI.unmount(host);clearBreadcrumb();hosts.delete(host);}};
    hosts.set(host,api);render();return api;
  }
  return {cleanPath,buildModel,publicFolders,scopeModel,rememberLocation,selectScope,mount};
});
