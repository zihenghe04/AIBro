/* Local persisted vectors. Provider credentials are injected, never stored here. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./context-retrieval'):root.ContextRetrieval);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.VectorIndex=api;
})(globalThis,function(R){
  'use strict';
  const cancelled=()=>Object.assign(Error('向量更新已停止'),{code:'CANCELLED'});
  const check=signal=>{if(signal?.aborted)throw cancelled();};
  function configuration(value={}) {
    const model=String(value.model||'').trim();let url;
    try {url=new URL(String(value.base||'').trim());} catch {throw Error('请填写 embedding API 地址');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw Error('Embedding 地址仅支持无账号、查询参数的 HTTP/HTTPS URL');
    if(!model||model.length>512)throw Error('请填写 embedding 模型名称');
    if(/\/(responses|chat\/completions)\/?$/.test(url.pathname))throw Error('请填写 embedding 服务的基础地址或 /embeddings 地址');
    url.pathname=url.pathname.replace(/\/$/,'');
    if(!url.pathname.endsWith('/embeddings'))url.pathname+='/embeddings';
    const dimensions=value.dimensions===''||value.dimensions==null?null:Number(value.dimensions);
    if(dimensions!==null&&(!Number.isSafeInteger(dimensions)||dimensions<1))throw Error('向量维度必须为正整数或留空');
    return {base:url.href,model,dimensions,enabled:value.enabled===true,autoUpdate:value.autoUpdate===true,noKey:value.noKey===true};
  }
  const hashes=new Map();
  async function hash(text) {
    if(hashes.has(text))return hashes.get(text);
    const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    const value=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
    hashes.set(text,value);if(hashes.size>4096)hashes.delete(hashes.keys().next().value);return value;
  }
  const profile=cfg=>hash(JSON.stringify([cfg.base,cfg.model,cfg.dimensions,'chunks-v2-headings']));
  const content=e=>`${e.title || ''}\n${e.heading || ''}\n${e.text || ''}`.trim();
  async function snapshot(state,scope={}) {
    const entries=R.indexEntries(state,{...scope,allowedTaskIds:[]}).filter(e=>content(e));
    return Promise.all(entries.map(async e=>({...e,input:content(e),hash:await hash(content(e))})));
  }
  function validate(vectors,count,dimensions=null) {
    if(!Array.isArray(vectors)||vectors.length!==count)throw Error('Embedding 服务返回的向量数量不匹配');
    let size=dimensions;
    for(const v of vectors){
      if(!Array.isArray(v)||!v.length||v.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw Error('Embedding 服务返回了无效向量');
      size ||= v.length;
      if(v.length!==size)throw Error('向量维度不匹配，请确认模型并重新更新索引');
      if(!v.some(x=>x!==0))throw Error('Embedding 服务返回了全零向量');
    }
    return size;
  }
  function cosine(a,b) {
    if(a.length!==b.length)return null;
    let dot=0,x=0,y=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}
    return x&&y?dot/Math.sqrt(x*y):null;
  }
  function indexedDBStore(indexedDB=globalThis.indexedDB) {
    let opening;
    const db=()=>opening ||= new Promise((resolve,reject)=>{
      const request=indexedDB.open('aibro-vector-index',1);
      request.onupgradeneeded=()=>{const s=request.result.createObjectStore('vectors',{keyPath:'key'});s.createIndex('profile','profile');};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('本机向量数据库无法打开'));
    });
    return {
      async load(profileId){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('vectors','readonly'),r=tx.objectStore('vectors').index('profile').getAll(profileId);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('读取本机向量数据库失败'));});},
      async write(profileId,puts=[],removes=[]){const d=await db();return new Promise((resolve,reject)=>{
        const tx=d.transaction('vectors','readwrite'),s=tx.objectStore('vectors');
        for(const id of removes)s.delete(`${profileId}:${id}`);
        for(const item of puts)s.put({...item,profile:profileId,key:`${profileId}:${item.id}`});
        tx.oncomplete=()=>resolve();tx.onerror=()=>reject(Error('保存向量索引失败，已完成的批次仍保留'));tx.onabort=()=>reject(Error('向量保存事务未完成'));
      });}
    };
  }
  function create({getState,store,embed,onProgress=()=>{}}) {
    const queryCache=new Map();let updating=false;
    async function status(cfg) {
      const id=await profile(cfg),[items,stored]=await Promise.all([snapshot(getState()),store.load(id)]),byId=new Map(stored.map(x=>[x.id,x]));
      const live=new Set(items.map(e=>e.id)),ready=items.filter(e=>byId.get(e.id)?.hash===e.hash).length;
      return {total:items.length,ready,pending:items.length-ready,obsolete:stored.filter(v=>!live.has(v.id)).length,updatedAt:stored.reduce((n,x)=>Math.max(n,x.updatedAt||0),0)};
    }
    async function update(cfg,{signal}={}) {
      if(updating)throw Error('向量索引正在更新');updating=true;
      try {
        check(signal);const id=await profile(cfg),items=await snapshot(getState()),stored=await store.load(id),old=new Map(stored.map(x=>[x.id,x]));
        const live=new Set(items.map(e=>e.id)),removed=stored.filter(x=>!live.has(x.id)).map(x=>x.id);
        check(signal);await store.write(id,[],removed);
        const pending=items.filter(e=>old.get(e.id)?.hash!==e.hash),complete=items.length-pending.length;
        let done=0,dimensions=cfg.dimensions||stored[0]?.vector.length||null;
        onProgress({total:items.length,ready:complete,pending:pending.length,phase:'updating'});
        for(let offset=0;offset<pending.length;offset+=16){
          check(signal);const batch=pending.slice(offset,offset+16),vectors=await embed(cfg,batch.map(e=>e.input),signal);
          check(signal);dimensions=validate(vectors,batch.length,dimensions);
          const current=new Map((await snapshot(getState())).map(e=>[e.id,e.hash]));check(signal);
          const puts=batch.map((e,i)=>({id:e.id,hash:e.hash,vector:vectors[i],updatedAt:Date.now()})).filter(e=>current.get(e.id)===e.hash);
          await store.write(id,puts);done+=puts.length;onProgress({total:items.length,ready:complete+done,pending:pending.length-done,phase:'updating'});
        }
        check(signal);const result=await status(cfg);onProgress({...result,phase:'idle'});return result;
      } finally {updating=false;}
    }
    async function search(cfg,query,scope={},offset=0,{signal}={}) {
      check(signal);if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid knowledge cursor');
      const lexical=R.searchIndex(getState(),{...scope,query,offset:0,allowedTaskIds:[],all:true});
      const id=await profile(cfg),items=await snapshot(getState(),{...scope,query}),stored=new Map((await store.load(id)).map(v=>[v.id,v]));
      const eligible=items.filter(e=>stored.get(e.id)?.hash===e.hash);
      let semantic=[],semanticStatus=eligible.length?'ready':'not-indexed';
      if(eligible.length&&query.trim()){
        const key=id+':'+query;let vector=queryCache.get(key);
        if(!vector){const values=await embed(cfg,[query],signal);check(signal);validate(values,1,cfg.dimensions);vector=values[0];queryCache.set(key,vector);if(queryCache.size>100)queryCache.delete(queryCache.keys().next().value);}
        if(eligible.some(e=>stored.get(e.id).vector.length!==vector.length))throw Error('查询向量与索引维度不匹配，请检查模型或重建索引');
        semantic=eligible.map(e=>({...e,similarity:cosine(vector,stored.get(e.id).vector)})).filter(e=>e.similarity>0).sort((a,b)=>b.similarity-a.similarity||a.id.localeCompare(b.id));
      }
      const fused=new Map();
      for(const ranking of [lexical.entries,semantic])ranking.forEach((e,i)=>{
        if(!fused.has(e.id))fused.set(e.id,{...e,score:0});fused.get(e.id).score+=1/(60+i+1);
      });
      // Recheck after the provider await: deleted/moved/edited evidence cannot leak back in.
      const now=new Map((await snapshot(getState(),{...scope,query})).map(e=>[e.id,e.hash]));
      const original=new Map(items.map(e=>[e.id,e.hash]));check(signal);
      const ranked=[...fused.values()].filter(e=>now.has(e.id)&&now.get(e.id)===original.get(e.id)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
      const Window=typeof module==='object'&&module.exports?require('./context-window'):globalThis.ContextWindow;
      const page=Window&&scope.maxTokens!==undefined?Window.page(Window.diversify(ranked.map(({input,hash,similarity,...e})=>e)),{offset,maxTokens:scope.maxTokens}):null;
      const entries=(page?page.entries:ranked.slice(offset,offset+20)).map(({input,hash,similarity,...e})=>e);
      return {entries,coverage:{...lexical.coverage,strategy:'hybrid-rrf',semanticStatus,vectorReady:eligible.length,vectorTotal:items.length,totalChunks:ranked.length,returnedChunks:entries.length,returnedRecords:new Set(entries.map(e=>`${e.type}:${e.recordId}`)).size,offset,nextOffset:offset+entries.length<ranked.length?offset+entries.length:null,...(page?{estimatedTokens:page.estimatedTokens,tokenBudget:page.tokenBudget}: {})}};
    }
    return {status,update,search};
  }
  return {configuration,hash,profile,snapshot,validate,cosine,indexedDBStore,create};
});
