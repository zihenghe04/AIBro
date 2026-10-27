/* Plugin host (P3): plugins are manifests over the one tool registry. A plugin
   adds declarations, one capability entry for the catalog and views; it never
   grants authority (approval stays in ApprovalBroker and the executors).
   Enable/disable is device-local (kept by the local service under the data
   directory, never synced) and applies to the next run: every run freezes its
   toolset when it starts, and the scheduler refuses a plugin tool outside it.
   The catalog is progressive: the model first sees a name and one sentence per
   plugin; the instructions (and tool schemas) come with capabilities{name}.
   No DOM. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroPlugins=api;})(globalThis,root=>{
  'use strict';
  const API_VERSION=1;
  const ID=/^[a-z][a-z0-9]{1,23}$/;
  const KINDS=['builtin','mcp'];
  // What a plugin may ask the host for. Unknown permissions are refused, so a
  // manifest cannot claim a capability this host does not know how to bound.
  const PERMISSIONS=['browser.control','network.http','process.spawn','network.loopback'];
  const NATIVE=['browser'];
  // Plugin tools never come from these families.
  const CORE_PLUGINS=new Set(['core','kernel']);
  const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const deepFreeze=x=>{if(x&&typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))deepFreeze(v);}return x;};
  const fail=message=>{throw TypeError('Invalid plugin manifest: '+message);};
  const label=(value,max,field)=>{
    if(!value||typeof value!=='object'||typeof value.zh!=='string'||!value.zh.trim()||value.zh.length>max)fail(field+' needs a zh text of at most '+max+' characters');
    if(value.en!==undefined&&(typeof value.en!=='string'||value.en.length>max))fail(field+'.en must be text of at most '+max+' characters');
    return {zh:value.zh.trim(),...(value.en?{en:value.en.trim()}:{})};
  };
  function validate(input){
    if(!input||typeof input!=='object'||Array.isArray(input))fail('not an object');
    const m=clone(input);
    if(!ID.test(m.id||''))fail('id must match '+ID);
    if(CORE_PLUGINS.has(m.id))fail('reserved id '+m.id);
    if(m.apiVersion!==API_VERSION)fail('apiVersion must be '+API_VERSION);
    if(typeof m.version!=='string'||!/^\d+\.\d+\.\d+$/.test(m.version))fail('version must be x.y.z');
    if(!KINDS.includes(m.kind))fail('kind must be one of '+KINDS.join('/'));
    m.name=label(m.name,40,'name');
    // One sentence: this is what the model sees before it asks for more.
    m.summary=label(m.summary,120,'summary');
    if(!Array.isArray(m.tools)||!m.tools.length||m.tools.some(name=>typeof name!=='string'))fail('tools must list tool names');
    if(new Set(m.tools).size!==m.tools.length)fail('duplicate tool names');
    m.prefix=m.prefix??(m.kind==='mcp'?m.id+'__':null);
    if(m.prefix!==null&&(typeof m.prefix!=='string'||!/^[a-z][a-z0-9_]{1,30}$/.test(m.prefix)))fail('invalid prefix');
    if(m.prefix&&m.tools.some(name=>!name.startsWith(m.prefix)))fail('every tool name must start with '+m.prefix);
    m.capability=m.capability||{name:m.id};
    if(!/^[a-z][a-z0-9_]{1,31}$/.test(m.capability.name||''))fail('invalid capability name');
    m.permissions=m.permissions||[];
    if(!Array.isArray(m.permissions)||m.permissions.some(p=>!PERMISSIONS.includes(p)))fail('unknown permission');
    m.requires={native:[],...(m.requires||{})};
    if(!Array.isArray(m.requires.native)||m.requires.native.some(n=>!NATIVE.includes(n)))fail('unknown native requirement');
    m.enabledByDefault=m.enabledByDefault!==false;
    m.builtin=m.kind==='builtin';
    return deepFreeze(m);
  }
  // Pure: may this run call this spec? Core tools always; a plugin tool only if
  // it is in the run's frozen toolset. A run saved before toolsets existed has
  // none: built-in plugin tools keep their old behaviour, external ones are out.
  function allows(toolset,spec){
    if(!spec)return false;
    if(CORE_PLUGINS.has(spec.plugin||'core'))return true;
    if(!toolset||!Array.isArray(toolset.tools))return !spec.external;
    return toolset.tools.includes(spec.name);
  }
  const hasPlugin=(toolset,id)=>!!toolset&&Array.isArray(toolset.plugins)&&toolset.plugins.some(p=>p.id===id);

  // transport: {load():Promise<config>, setEnabled(id,on):Promise<config>}.
  // config: {builtin:{[id]:{enabled}}, mcp:[...]} as kept by the local service.
  function create({registry,transport=null}={}){
    if(!registry)throw TypeError('Plugin host needs the tool registry');
    const installed=new Map(),listeners=new Set();
    let config={builtin:{},mcp:[]},loaded=false;
    const notify=()=>{for(const listener of listeners){try{listener();}catch{}}};
    function install(plugin){
      const manifest=validate(plugin?.manifest);
      if(installed.has(manifest.id))throw Error('Plugin already installed: '+manifest.id);
      for(const other of installed.values())if(other.manifest.capability.name===manifest.capability.name)throw Error('Capability name taken: '+manifest.capability.name);
      if(plugin.specs)for(const spec of plugin.specs)registry.register({...spec,plugin:manifest.id});
      // The manifest's list must be exactly what the registry holds for it.
      const registered=registry.list().filter(spec=>spec.plugin===manifest.id).map(spec=>spec.name).sort();
      const listed=[...manifest.tools].sort();
      if(registered.join('\n')!==listed.join('\n')){
        if(plugin.specs)registry.unregisterPlugin?.(manifest.id);
        throw Error('Plugin '+manifest.id+' lists tools '+listed.join(',')+' but registers '+registered.join(','));
      }
      // A plugin that brings its own declarations also brings its family defaults.
      if(plugin.specs)registry.plugin?.(manifest.id,{prefix:manifest.prefix,defaults:plugin.defaults||{}});
      installed.set(manifest.id,{manifest,instructions:plugin.instructions||null,nextStep:plugin.nextStep||null,
        available:typeof plugin.available==='function'?plugin.available:()=>true,views:plugin.views||{},external:manifest.kind==='mcp'});
      notify();return manifest;
    }
    // External plugins are replaced as a whole (add, re-test, remove).
    function uninstall(id){
      const plugin=installed.get(id);if(!plugin)return false;
      if(plugin.manifest.builtin)throw Error('Built-in plugins can be disabled, not removed');
      registry.unregisterPlugin(id);installed.delete(id);notify();return true;
    }
    const enabled=id=>{
      const plugin=installed.get(id);if(!plugin)return false;
      const saved=plugin.manifest.builtin?config.builtin?.[id]?.enabled:plugin.enabledFlag;
      return typeof saved==='boolean'?saved:plugin.manifest.enabledByDefault;
    };
    const available=id=>{const plugin=installed.get(id);if(!plugin)return false;try{return plugin.available()!==false;}catch{return false;}};
    const active=id=>enabled(id)&&available(id);
    function list(){
      return [...installed.values()].map(({manifest})=>({id:manifest.id,kind:manifest.kind,version:manifest.version,name:manifest.name,summary:manifest.summary,
        tools:[...manifest.tools],capability:manifest.capability.name,enabled:enabled(manifest.id),available:available(manifest.id)}));
    }
    // options.unattended: a run nobody watches may use only the external tools
    // its task declared (declaredTools). Built-in plugin tools are unchanged here;
    // the scheduler's own declaration check applies on top (see report §遗留).
    function freeze({unattended=false,declaredTools=null,at=Date.now()}={}){
      const declared=new Set(Array.isArray(declaredTools)?declaredTools:[]);
      const plugins=[],tools=[],off=[];
      for(const {manifest,external,toolFilter} of installed.values()){
        if(!enabled(manifest.id))off.push(manifest.id);
        if(!active(manifest.id))continue;
        let names=manifest.tools.filter(name=>registry.has(name)&&(!toolFilter||toolFilter(name)));
        if(external&&unattended)names=names.filter(name=>declared.has(name));
        if(!names.length)continue;
        plugins.push({id:manifest.id,kind:manifest.kind,version:manifest.version});tools.push(...names);
      }
      return deepFreeze({apiVersion:API_VERSION,frozenAt:new Date(at).toISOString(),...(unattended?{unattended:true}:{}),plugins,tools,off});
    }
    function entries(toolset){return [...installed.values()].filter(p=>hasPlugin(toolset,p.manifest.id));}
    // The catalog: one sentence per plugin in the run's toolset.
    function catalog(toolset){
      return entries(toolset).map(({manifest})=>({name:manifest.capability.name,plugin:manifest.id,summary:manifest.summary.zh}));
    }
    // The full protocol for one plugin capability, or null if it is not in the toolset.
    function capability(toolset,name){
      const plugin=entries(toolset).find(p=>p.manifest.capability.name===name);if(!plugin)return null;
      const tools=plugin.manifest.tools.filter(tool=>toolset.tools.includes(tool));
      const instructions=typeof plugin.instructions==='function'?plugin.instructions({tools,toolset}):String(plugin.instructions||'');
      return {plugin:plugin.manifest.id,instructions,nextStep:plugin.nextStep};
    }
    const view=(id,slot)=>installed.get(id)?.views?.[slot]||null;
    async function load(){
      if(!transport?.load)return config;
      const next=await transport.load();
      if(next&&typeof next==='object'){config={builtin:{...(next.builtin||{})},mcp:Array.isArray(next.mcp)?next.mcp:[]};loaded=true;notify();}
      return config;
    }
    async function setEnabled(id,on){
      const plugin=installed.get(id);if(!plugin)throw Error('Unknown plugin: '+id);
      if(typeof on!=='boolean')throw TypeError('enabled must be true or false');
      if(transport?.setEnabled){const next=await transport.setEnabled(id,on,plugin.manifest.kind);if(next&&typeof next==='object')config={builtin:{...(next.builtin||{})},mcp:Array.isArray(next.mcp)?next.mcp:[]};}
      else if(plugin.manifest.builtin)config={...config,builtin:{...config.builtin,[id]:{enabled:on}}};
      if(!plugin.manifest.builtin)plugin.enabledFlag=on;
      notify();return enabled(id);
    }
    // Internal hooks for the external-plugin adapter (plugin-mcp.js).
    function configure(id,{enabled:on,toolFilter}={}){
      const plugin=installed.get(id);if(!plugin)return;
      if(typeof on==='boolean')plugin.enabledFlag=on;
      if(toolFilter!==undefined)plugin.toolFilter=toolFilter;
    }
    return {install,uninstall,configure,list,enabled,available,active,freeze,catalog,capability,view,load,setEnabled,
      allows,hasPlugin,config:()=>clone(config),loaded:()=>loaded,
      plugin:id=>installed.get(id)?.manifest||null,
      onChange(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
  }
  // HTTP transport to the local service (same-origin, device-local file).
  function httpTransport(fetchImpl=root.fetch?.bind(root)){
    const call=async(path,body)=>{
      const response=await fetchImpl(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
      const value=await response.json().catch(()=>({}));
      if(!response.ok)throw Object.assign(Error(value.error||'插件设置请求失败'),{code:value.code,status:response.status});
      return value;
    };
    return {load:()=>call('/__plugins'),setEnabled:(id,enabled,kind)=>call(kind==='mcp'?'/__plugins/mcp/enable':'/__plugins/builtin',{id,enabled})};
  }
  const api={API_VERSION,PERMISSIONS,validate,allows,hasPlugin,create,httpTransport};
  // The window's host, over the window's registry. Plugin files loaded after
  // this one install themselves into it; the app loads the device settings.
  if(root.AIBroTools?.registry&&!(typeof module==='object'&&module.exports))api.default=create({registry:root.AIBroTools.registry,transport:root.fetch?httpTransport():null});
  return api;
});
