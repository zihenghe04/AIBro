/* Tool registry: one declaration (ToolSpec) per tool. The scheduler's
   read/view classification, the argument whitelist, the evidence cache key,
   ledger labels, the text protocol and the MCP tool list are all derived from
   these declarations. Pure data and functions: no DOM, no authority. Executors
   and approval live elsewhere (tool-gateway.js); nothing here grants a call. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./json-schema-lite'):root.JsonSchemaLite);if(typeof module==='object'&&module.exports)module.exports=api;else root.ToolRegistry=api;})(globalThis,Schema=>{
  'use strict';
  const NAME=/^[a-z][a-z0-9_]{0,63}$/;
  const EFFECTS=['none','view','local','external'];
  const APPROVALS=['never','policy','always','host'];
  // opaque: an external tool (MCP plugin) whose arguments the registry cannot
  // check; they pass as given (bounded by the executor) and its server validates them.
  const GATES=['strip','keys','schema','opaque'];
  const CACHE_MODES=['reuse','live'];
  const clone=x=>JSON.parse(JSON.stringify(x));
  const freeze=x=>{if(x&&typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))freeze(v);}return x;};
  // Undeclared fields take the strictest value: an undeclared effect can act
  // on the outside world, needs a person's approval and runs alone.
  function normalize(input){
    if(!input||typeof input!=='object')throw TypeError('ToolSpec must be an object');
    const spec=clone(input);
    if(!NAME.test(spec.name||''))throw TypeError('Invalid tool name: '+spec.name);
    spec.plugin=spec.plugin||'core';
    spec.effect=spec.effect??'external';
    if(!EFFECTS.includes(spec.effect))throw TypeError(spec.name+': invalid effect '+spec.effect);
    spec.approval=spec.approval??'always';
    if(!APPROVALS.includes(spec.approval))throw TypeError(spec.name+': invalid approval '+spec.approval);
    spec.destructive=spec.destructive===true;
    spec.concurrency=spec.concurrency??'serial';
    if(!/^(parallel|serial|exclusive:[a-z_]+)$/.test(spec.concurrency))throw TypeError(spec.name+': invalid concurrency '+spec.concurrency);
    // Parallel execution is only for calls that cannot change anything.
    if(spec.concurrency==='parallel'&&spec.effect!=='none')throw TypeError(spec.name+': only effect "none" tools may run in parallel');
    spec.cache={mode:'live',key:null,normalize:{},...(spec.cache||{})};
    if(!CACHE_MODES.includes(spec.cache.mode))throw TypeError(spec.name+': invalid cache mode');
    spec.input={type:'object',properties:{},additionalProperties:false,...(spec.input||{})};
    if(spec.input.type!=='object')throw TypeError(spec.name+': input must be an object schema');
    if(Object.hasOwn(spec.input.properties,'type'))throw TypeError(spec.name+': "type" is the tool name, not an argument');
    Schema.check(spec.input);
    if(spec.cache.key&&spec.cache.key.some(field=>!Object.hasOwn(spec.input.properties,field)))throw TypeError(spec.name+': cache key uses an undeclared field');
    spec.gate=spec.gate??'strip';
    if(!GATES.includes(spec.gate))throw TypeError(spec.name+': invalid gate');
    if(['keys','schema'].includes(spec.gate)&&!(spec.gateError?.code&&spec.gateError?.message))throw TypeError(spec.name+': a rejecting gate needs gateError');
    if(spec.gate==='opaque'&&(spec.effect==='none'||spec.concurrency==='parallel'||spec.cache.mode!=='live'||spec.approval!=='host'))throw TypeError(spec.name+': an opaque tool is serial, live and asks through its executor');
    spec.legacyFields=spec.legacyFields||[];
    spec.hosts=spec.hosts||['webview'];
    spec.modelCallable=spec.modelCallable!==false;
    spec.splittable=spec.splittable!==false;
    spec.timeoutMs=spec.timeoutMs??60000;
    spec.receipt=spec.receipt||'none';
    spec.untrustedOutput=spec.untrustedOutput===true;
    spec.evidence=spec.evidence===true;
    spec.citations=spec.citations||null;
    if(spec.citations&&!(Array.isArray(spec.citations.fields)&&spec.citations.fields.every(f=>Object.hasOwn(spec.input.properties,f))))throw TypeError(spec.name+': citation fields must be declared inputs');
    spec.prompt=spec.prompt||{};
    return freeze(spec);
  }
  function create({fieldOrder=[]}={}){
    const specs=new Map(),plugins=new Map(),disabled=new Set();
    function plugin(id,{prefix=null,defaults={}}={}){plugins.set(id,freeze({id,prefix,defaults:clone(defaults)}));}
    function register(input){
      const spec=normalize(input);
      if(specs.has(spec.name))throw Error('Tool already registered: '+spec.name);
      specs.set(spec.name,spec);generic=null;return spec;
    }
    const enabled=spec=>!disabled.has(spec.plugin);
    const get=name=>{const spec=specs.get(name);return spec&&enabled(spec)?spec:null;};
    const all=()=>[...specs.values()].filter(enabled);
    const names=filter=>all().filter(filter).map(spec=>spec.name);
    // A type with no spec of its own inherits its plugin family's defaults
    // (e.g. any browser_* type is a live observation, never a cached one).
    const family=type=>[...plugins.values()].find(p=>p.prefix&&!disabled.has(p.id)&&String(type).startsWith(p.prefix))||null;
    function cacheMode(type){const spec=get(type);if(spec)return spec.cache.mode;return family(type)?.defaults?.cache||null;}
    function genericFields(){
      const seen=[];
      for(const spec of all())if(spec.gate==='strip')for(const field of [...Object.keys(spec.input.properties),...spec.legacyFields])if(!seen.includes(field))seen.push(field);
      // Field order fixes the key order of persisted requests; it adds nothing.
      const rank=field=>{const i=fieldOrder.indexOf(field);return i<0?fieldOrder.length:i;};
      return ['type',...seen.map((field,i)=>({field,i})).sort((a,b)=>rank(a.field)-rank(b.field)||a.i-b.i).map(x=>x.field)];
    }
    let generic=null;const fields=()=>generic||=genericFields();
    function validate(name,args){const spec=get(name);if(!spec)return [{path:'',message:'unknown tool'}];if(spec.gate==='opaque')return args&&typeof args==='object'&&!Array.isArray(args)?[]:[{path:'',message:'arguments must be an object'}];return Schema.validate(spec.input,args);}
    // The scheduler's copy of a model request. Rejecting gates refuse a
    // request carrying anything beyond the declaration; other tools keep only
    // whitelisted fields, so provider-supplied authority is dropped.
    function safeRequest(request){
      const spec=get(request.type);
      if(spec&&spec.gate==='opaque')return clone(request);
      if(spec&&spec.gate!=='strip'){
        const {type,...args}=request,allowed=Object.keys(spec.input.properties);
        const reject=()=>{throw Object.assign(Error(spec.gateError.message),{code:spec.gateError.code});};
        if(Object.keys(args).some(key=>!allowed.includes(key)))reject();
        if(spec.gate==='schema'&&Schema.validate(spec.input,args).length)reject();
        return clone(request);
      }
      const out={};for(const key of fields())if(request[key]!==undefined)out[key]=clone(request[key]);
      return out;
    }
    function mcpTools({host}={}){
      return all().filter(spec=>spec.modelCallable&&spec.hosts.includes(host)).map(spec=>({
        name:spec.name,
        title:spec.title?.en||spec.title?.zh||spec.name,
        description:String(spec.description||spec.title?.zh||spec.name),
        inputSchema:clone(spec.input),
        annotations:{readOnlyHint:['none','view'].includes(spec.effect),destructiveHint:spec.destructive,idempotentHint:spec.effect==='none',openWorldHint:spec.effect==='external'||spec.untrustedOutput},
      }));
    }
    return {
      plugin,register,get,has:name=>!!get(name),list:()=>all(),
      setPluginEnabled(id,on){if(on)disabled.delete(id);else disabled.add(id);generic=null;},
      // Removing an external plugin removes its declarations and its family.
      unregisterPlugin(id){if(id==='core')throw Error('Core tools cannot be removed');for(const [name,spec] of specs)if(spec.plugin===id)specs.delete(name);plugins.delete(id);disabled.delete(id);generic=null;},
      // Derived tables (each replaces a hand-maintained list; see tests/tool-registry-equivalence.test.js).
      readTypes:()=>new Set(names(s=>s.effect==='none')),
      viewTypes:()=>new Set(names(s=>s.effect==='view')),
      parallelTypes:()=>new Set(names(s=>s.concurrency==='parallel')),
      chunkableTypes:()=>new Set(names(s=>s.effect==='none'&&s.splittable&&s.modelCallable)),
      label:type=>get(type)?.title?.zh||type,
      cacheMode,isLive:type=>cacheMode(type)==='live',
      keyFields:type=>get(type)?.cache.key||null,
      normalizers:type=>get(type)?.cache.normalize||{},
      genericFields:()=>fields().slice(),
      validate,safeRequest,mcpTools,
      exportSpecs:()=>all().map(clone),
    };
  }
  return {create,normalize};
});
