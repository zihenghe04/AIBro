const test=require('node:test'),assert=require('node:assert/strict');
const Plugins=require('../app/plugin-host'),Tools=require('../app/tool-specs'),BrowserPlugin=require('../app/plugin-browser');
const AgentContext=require('../app/agent-context'),Scheduler=require('../app/tool-scheduler');

const manifest=(extra={})=>({id:'demo',version:'1.0.0',apiVersion:1,kind:'builtin',name:{zh:'演示'},summary:{zh:'一句话说明'},tools:['demo_ping'],...extra});
const demoSpec={name:'demo_ping',description:'ping',effect:'none',approval:'never',concurrency:'parallel',input:{type:'object',properties:{},additionalProperties:false}};
// A fake device-local settings service (the real one is /__plugins in server.py).
function transport(initial={}){
  const saved={builtin:{...initial},mcp:[]},calls=[];
  return {calls,saved,load:async()=>JSON.parse(JSON.stringify(saved)),setEnabled:async(id,enabled)=>{calls.push([id,enabled]);saved.builtin[id]={enabled};return JSON.parse(JSON.stringify(saved));}};
}
function host({available=true,settings}={}){
  const registry=Tools.build(),t=transport(settings),h=Plugins.create({registry,transport:t});
  h.install({...BrowserPlugin.plugin,available:()=>available,instructions:()=>'BROWSER PROTOCOL'});
  return {registry,host:h,transport:t};
}

test('manifest validation refuses what the host cannot bound',()=>{
  assert.equal(Plugins.validate(manifest()).enabledByDefault,true);
  for(const [extra,pattern] of [
    [{id:'Bad-Id'},/id must match/],[{id:'core'},/reserved/],[{apiVersion:2},/apiVersion/],[{version:'1'},/version/],
    [{kind:'native'},/kind/],[{summary:{zh:'x'.repeat(121)}},/summary/],[{summary:undefined},/summary/],[{tools:[]},/tools/],
    [{tools:['a','a']},/duplicate/],[{permissions:['fs.write']},/unknown permission/],[{requires:{native:['camera']}},/native/],
    [{kind:'mcp',tools:['other__x']},/must start with demo__/],
  ])assert.throws(()=>Plugins.validate(manifest(extra)),pattern,JSON.stringify(extra));
  assert.equal(Plugins.validate(manifest({kind:'mcp',tools:['demo__x']})).prefix,'demo__');
  assert.ok(Object.isFrozen(Plugins.validate(manifest()).name));
});

test('the manifest must list exactly the tools the plugin registers',()=>{
  const registry=Tools.build(),h=Plugins.create({registry});
  assert.throws(()=>h.install({manifest:manifest({tools:['demo_ping','demo_pong']}),specs:[demoSpec]}),/lists tools/);
  assert.equal(registry.has('demo_ping'),false,'a refused plugin leaves nothing registered');
  h.install({manifest:manifest(),specs:[demoSpec]});
  assert.equal(registry.get('demo_ping').plugin,'demo');
  // The browser manifest matches the declarations in tool-specs.js.
  const names=registry.list().filter(s=>s.plugin==='browser').map(s=>s.name).sort();
  assert.deepEqual([...BrowserPlugin.manifest.tools].sort(),names);
  h.install(BrowserPlugin.plugin);
  assert.throws(()=>h.install(BrowserPlugin.plugin),/already installed/);
  assert.throws(()=>h.uninstall('browser'),/disabled, not removed/);
});

test('enable/disable is device-local and applies from the next frozen run',async()=>{
  const {host:h,transport:t}=host();
  await h.load();
  const first=h.freeze();
  assert.deepEqual(first.plugins.map(p=>p.id),['browser']);
  assert.ok(first.tools.includes('browser_click'));
  assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.tools));
  assert.equal(await h.setEnabled('browser',false),false);
  assert.deepEqual(t.calls,[['browser',false]]);
  // The run that already started keeps its toolset; the next one does not get the browser.
  assert.ok(first.tools.includes('browser_click'));
  const second=h.freeze();
  assert.deepEqual(second.tools,[]);assert.deepEqual(second.off,['browser']);
  // A reload (another window, a restart) reads the same device setting.
  const again=Plugins.create({registry:Tools.build(),transport:t});again.install(BrowserPlugin.plugin);await again.load();
  assert.equal(again.enabled('browser'),false);
  await assert.rejects(h.setEnabled('browser','no'),/true or false/);
  await assert.rejects(h.setEnabled('nope',true),/Unknown plugin/);
});

test('an unavailable host requirement keeps the plugin out without an error',()=>{
  const {host:h}=host({available:false});
  assert.equal(h.enabled('browser'),true);assert.equal(h.active('browser'),false);
  assert.deepEqual(h.freeze().tools,[]);assert.deepEqual(h.freeze().off,[]);
  assert.equal(h.list()[0].available,false);
});

test('allows: core always, plugin tools only inside the frozen toolset',()=>{
  const registry=Tools.build(),click=registry.get('browser_click'),read=registry.get('read');
  const withBrowser={tools:['browser_click']},without={tools:[]};
  assert.equal(Plugins.allows(without,read),true);
  assert.equal(Plugins.allows(withBrowser,click),true);
  assert.equal(Plugins.allows(without,click),false);
  assert.equal(Plugins.allows(undefined,click),true,'runs saved before toolsets keep built-in behaviour');
  assert.equal(Plugins.allows(undefined,{name:'x__y',plugin:'x',external:true}),false,'but never get external tools');
  assert.equal(Plugins.allows(withBrowser,null),false);
});

test('catalog is progressive: one sentence per plugin, the protocol only on request',()=>{
  const {host:h}=host();const toolset=h.freeze();
  assert.deepEqual(h.catalog(toolset),[{name:'browser',plugin:'browser',summary:BrowserPlugin.manifest.summary.zh}]);
  assert.equal(h.capability(toolset,'browser').instructions,'BROWSER PROTOCOL');
  assert.equal(h.capability({plugins:[],tools:[]},'browser'),null);
  // Through AgentContext: the catalog lists the summary only; capabilities loads the protocol.
  const plugins=h.catalog(toolset).map(e=>({...e,instructions:()=>h.capability(toolset,e.name).instructions,nextStep:BrowserPlugin.plugin.nextStep}));
  const ctx=AgentContext.create({fullInstruction:'你是个人助手。',plugins});
  assert.match(ctx.instructions(),/"browser":"受控内置网页：打开、观察、点击、填写、截图和人工接管；不操作其他桌面应用"/);
  assert.doesNotMatch(ctx.instructions(),/BROWSER PROTOCOL/);
  const loaded=ctx.capability('browser');
  assert.equal(loaded.instructions,'BROWSER PROTOCOL');assert.match(ctx.instructions(),/BROWSER PROTOCOL/);
  const off=AgentContext.create({fullInstruction:'你是个人助手。',plugins:[]});
  assert.doesNotMatch(off.instructions(),/"browser":/);
  assert.throws(()=>off.capability('browser'),/未提供受控内置浏览器/);
});

test('legacy hasBrowser options render the same catalog as the browser plugin',()=>{
  const legacy=AgentContext.create({fullInstruction:'你是个人助手。',hasBrowser:true,browserInstructions:'P'});
  const viaPlugin=AgentContext.create({fullInstruction:'你是个人助手。',plugins:[{name:'browser',summary:BrowserPlugin.manifest.summary.zh,instructions:'P',nextStep:BrowserPlugin.plugin.nextStep}]});
  assert.equal(legacy.instructions(),viaPlugin.instructions());
  assert.deepEqual(legacy.capability('browser'),viaPlugin.capability('browser'));
});

test('the scheduler refuses a plugin tool outside the run toolset before approval or execution',async()=>{
  const run={toolset:{plugins:[],tools:[]}},executed=[],events=[];
  const s=Scheduler.create({run,execute:async request=>{executed.push(request.type);return {ok:true};},events:{emit:(type,payload)=>events.push(type)}});
  const results=await s.batch([{type:'browser_click',snapshotId:'s',ref:'e1'},{type:'read',id:'n1'}]);
  assert.deepEqual(executed,['read']);
  assert.equal(results[0].code,'UNKNOWN_TOOL');
  assert.equal(run.toolCalls[0].outcome,'not-started');assert.equal(run.toolCalls[0].errorCode,'UNKNOWN_TOOL');
  // The same request in a run whose toolset has the browser goes to the executor.
  const run2={toolset:{plugins:[{id:'browser'}],tools:['browser_snapshot']}},seen=[];
  await Scheduler.create({run:run2,execute:async request=>{seen.push(request.type);return {};}}).batch([{type:'browser_snapshot'}]);
  assert.deepEqual(seen,['browser_snapshot']);
});
