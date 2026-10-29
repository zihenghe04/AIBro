const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Plugins=require('../app/plugin-host'),Tools=require('../app/tool-specs'),ReadTools=require('../app/read-tools');
const WebSearch=require('../app/plugin-websearch');

function transport(initial={}){
  const saved={builtin:{...initial},mcp:[]};
  return {saved,load:async()=>JSON.parse(JSON.stringify(saved)),setEnabled:async(id,enabled)=>{saved.builtin[id]={...saved.builtin[id],enabled};return JSON.parse(JSON.stringify(saved));}};
}

test('web search is a built-in plugin that stays off until the user turns it on',async()=>{
  const registry=Tools.build(),t=transport(),host=Plugins.create({registry,transport:t});
  assert.equal(registry.has('websearch_query'),false,'other hosts keep the same registry');
  WebSearch.install(host);
  const spec=registry.get('websearch_query');
  assert.equal(spec.plugin,'websearch');
  assert.deepEqual([spec.effect,spec.approval,spec.concurrency,spec.cache.mode],['view','never','serial','reuse']);
  assert.equal(spec.untrustedOutput,true);
  await host.load();
  assert.equal(host.enabled('websearch'),false);
  assert.equal(host.freeze().tools.includes('websearch_query'),false);
  assert.deepEqual(host.freeze().off,['websearch']);
  assert.equal(Plugins.allows(host.freeze(),spec),false);
  await host.setEnabled('websearch',true);
  const toolset=host.freeze();
  assert.deepEqual(toolset.tools,['websearch_query']);
  assert.equal(Plugins.allows(toolset,spec),true);
  assert.deepEqual(host.catalog(toolset).map(entry=>entry.name),['websearch']);
  assert.match(host.capability(toolset,'websearch').instructions,/websearch_query/);
  assert.ok(registry.validate('websearch_query',{query:'x',limit:11}).length);
  assert.deepEqual(registry.validate('websearch_query',{query:'x',limit:3}),[]);
});

test('websearch_query does not clash with the provider-side web_search entry',()=>{
  const registry=Tools.build(),host=Plugins.create({registry});
  const provider=registry.get('web_search');
  assert.deepEqual([provider.hosts,provider.modelCallable],[['provider'],false]);
  WebSearch.install(host);
  assert.equal(registry.get('web_search'),provider,'the provider entry is untouched');
  assert.deepEqual(registry.list().filter(spec=>/web_?search/.test(spec.name)).map(spec=>[spec.name,spec.plugin]).sort(),[['web_search','core'],['websearch_query','websearch']]);
  assert.deepEqual(WebSearch.manifest.tools,['websearch_query']);
});

test('the settings page lists the services the local service knows',()=>{
  assert.deepEqual(WebSearch.BACKENDS.map(b=>[b.id,b.name,!!b.endpoint,b.key]),[['keenable','Keenable',false,'optional'],['searxng','SearXNG',true,'none']]);
  const python=fs.readFileSync('app/web_search.py','utf8');
  assert.match(python,/BACKENDS = \{backend\.id: backend for backend in \(Keenable\(\), SearXNG\(\)\)\}/);
  for(const backend of WebSearch.BACKENDS)assert.match(python,new RegExp(`id, name(?:, \\w+)* = '${backend.id}', '${backend.name}'`));
});

test('the executor sends only the query and returns titles, links and excerpts',async()=>{
  const sent=[];
  const execute=WebSearch.createExecutor({request:async body=>{sent.push(body);return {query:body.query,backend:'searxng',results:[{title:'T',url:'https://example.org/a',excerpt:'text'}]};},confirm:()=>null});
  const result=await execute({type:'websearch_query',query:'transformer survey',limit:3},{run:{id:'r1',permissionMode:'smart'}});
  assert.deepEqual(sent,[{query:'transformer survey',limit:3}]);
  assert.deepEqual(result,{type:'websearch_query',query:'transformer survey',backend:'searxng',externalContentIsUntrusted:true,results:[{title:'T',url:'https://example.org/a',excerpt:'text'}]});
  await execute({type:'websearch_query',query:'q'},{run:{id:'r1'}});
  assert.deepEqual(sent[1],{query:'q'},'no limit unless the model gave one');
});

test('request mode asks once per run and names the chosen service; a refusal sends nothing',async()=>{
  const sent=[],asked=[];let answer=false;
  const execute=WebSearch.createExecutor({request:async body=>{sent.push(body);return {query:body.query,results:[]};},confirm:()=>async options=>{asked.push(options);return answer;},backend:()=>WebSearch.BACKENDS[1]});
  const run={id:'r2',permissionMode:'request'};
  await assert.rejects(execute({type:'websearch_query',query:'a'},{run}),error=>error.code==='APPROVAL_DENIED');
  assert.deepEqual(sent,[]);
  assert.match(asked[0].detail,/SearXNG/);
  answer=true;
  await execute({type:'websearch_query',query:'a'},{run});
  await execute({type:'websearch_query',query:'b'},{run});
  assert.equal(asked.length,2,'one refused question, then one approval for the run');
  assert.deepEqual(sent.map(x=>x.query),['a','b']);
  const missing=WebSearch.createExecutor({request:async()=>{throw Error('must not run');},confirm:()=>undefined});
  await assert.rejects(missing({type:'websearch_query',query:'a'},{run:{id:'r3',permissionMode:'request'}}),error=>error.code==='APPROVAL_DENIED');
  const controller=new AbortController();controller.abort();
  await assert.rejects(execute({type:'websearch_query',query:'a'},{run,signal:controller.signal}),error=>error.code==='CANCELLED');
});

test('the local service call reports the service error code',async()=>{
  const calls=[];
  const ok=async(path,init)=>{calls.push([path,JSON.parse(init.body)]);return {ok:true,json:async()=>({query:'q',results:[]})};};
  assert.deepEqual(await WebSearch.post({query:'q'},null,ok),{query:'q',results:[]});
  assert.deepEqual(calls,[['/__plugins/websearch/search',{query:'q'}]]);
  const off=async()=>({ok:false,json:async()=>({error:'网页搜索插件未开启。',code:'plugin_disabled'})});
  await assert.rejects(WebSearch.post({query:'q'},null,off),error=>error.code==='PLUGIN_DISABLED'&&/未开启/.test(error.message));
  const format=async()=>({ok:false,json:async()=>({error:'SearXNG 拒绝了 JSON 请求',code:'websearch_format'})});
  await assert.rejects(WebSearch.post({query:'q'},null,format),error=>error.code==='WEBSEARCH_FORMAT');
});

test('read tools route websearch_query to the plugin',async()=>{
  const seen=[];
  const plugin={execute:async(request,ctx)=>{seen.push([request.type,ctx.run.id]);return {type:request.type,results:[]};}};
  const tools=ReadTools.create({run:{id:'r4'},getState:()=>({}),validate:()=>{},lookup:name=>name==='AIBroWebSearchPlugin'?plugin:null,agentContext:()=>null,fallback:()=>{throw Error('fallback');}});
  assert.deepEqual(await tools.execute({type:'websearch_query',query:'q'}),{type:'websearch_query',results:[]});
  assert.deepEqual(seen,[['websearch_query','r4']]);
});
