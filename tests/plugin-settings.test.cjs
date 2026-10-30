const test=require('node:test'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const Plugins=require('../app/plugin-host'),Tools=require('../app/tool-specs'),Mcp=require('../app/plugin-mcp'),BrowserPlugin=require('../app/plugin-browser');
const WebSearchPlugin=require('../app/plugin-websearch');
const Settings=require('../app/plugin-settings');

// A fake local service with the same answers as server.py /__plugins/*.
function service(){
  const state={builtin:{},mcp:[]},posts=[];
  const tools=[
    {name:'lookup_word',description:'Look up a saved word.',inputSchema:{type:'object'},annotations:{readOnlyHint:true},hash:'a'},
    {name:'add_word',description:'Save a word.',inputSchema:{type:'object'},annotations:{readOnlyHint:false},hash:'b'},
  ];
  const servers=[
    {index:0,name:'words',transport:{kind:'stdio',command:'/usr/local/bin/words',args:['--x']},status:'ready',env:['WORDS_KEY']},
    {index:1,name:'search',transport:{kind:'stdio',command:'npx',args:['-y','some-pkg']},status:'needs_install',reason:'会在运行时下载软件包。',installCommand:'npm install -g some-pkg',env:[]},
    {index:2,name:'remote',transport:{kind:'http',url:'https://x.example/mcp'},status:'unsupported',reason:'只支持本机回环地址。',env:[]},
  ];
  const tierOf=(entry,tool)=>tool.tier;
  const request=async(path,body)=>{posts.push([path,JSON.parse(JSON.stringify(body))]);
    if(path==='/__plugins/import/parse'){
      if(body.kind==='text'&&!body.text.trim())return {importId:'imp_1',source:'text',plugin:null,servers:[]};
      const plugin=body.kind==='folder'?{name:'latex-tools',version:'1.2.0',description:'LaTeX helpers',counts:{skills:2,commands:3,agents:1,hooks:0},skills:['proof','bib']}:null;
      return {importId:'imp_1',source:body.kind,plugin,servers:JSON.parse(JSON.stringify(servers))};
    }
    if(path==='/__plugins/import/probe'){
      if(body.index===1&&body.commandLine==null)throw Object.assign(Error('不支持会临时下载或安装软件包的命令'),{code:'mcp_installer_refused'});
      const candidate=body.index===1?{...servers[1],transport:{kind:'stdio',command:body.commandLine,args:[]},status:'ready'}:servers[body.index];
      return {probeId:'probe_1',serverInfo:{name:'Words'},tools,notice:'由这个服务器自己声明，AI Bro 无法强制。',candidate};
    }
    if(path==='/__plugins/mcp/add'){state.mcp.push({id:'words',name:body.name,kind:'mcp',transport:{kind:'stdio',command:'/usr/local/bin/words',args:['--x']},enabled:true,available:true,status:{state:'ok'},
      defaultTier:body.defaultTier,env:body.includeEnv,source:body.source,description:body.description||'',
      tools:tools.map(t=>({...t,localName:'words__'+t.name,tier:body.defaultTier==='readonly'&&t.annotations.readOnlyHint===false?'ask':body.defaultTier}))});return state.mcp.at(-1);}
    if(path==='/__plugins/mcp/enable'){state.mcp.find(e=>e.id===body.id).enabled=body.enabled;return {};}
    if(path==='/__plugins/mcp/tier'){state.mcp.find(e=>e.id===body.id).tools.find(t=>t.name===body.tool).tier=body.tier;return {};}
    if(path==='/__plugins/mcp/default-tier'){const e=state.mcp.find(x=>x.id===body.id);for(const t of e.tools)if(t.tier===e.defaultTier&&!(body.tier==='readonly'&&t.annotations.readOnlyHint===false))t.tier=body.tier;e.defaultTier=body.tier;return {};}
    if(path==='/__plugins/mcp/remove'){state.mcp=state.mcp.filter(e=>e.id!==body.id);return {};}
    if(path==='/__plugins/browser/sites'){const b=state.builtin.browser=state.builtin.browser||{enabled:true};const s=b.sites=b.sites||{allow:[],deny:[]};
      for(const k of ['allow','deny'])s[k]=s[k].filter(o=>o!==body.origin);if(body.decision!=='remove')s[body.decision].push(body.origin);return {};}
    if(path==='/__plugins/browser/settings'){const b=state.builtin.browser=state.builtin.browser||{enabled:true};if(body.unknownSites==='ask')b.unknownSites='ask';else delete b.unknownSites;return {};}
    if(path==='/__plugins/websearch/settings'){const w=state.builtin.websearch=state.builtin.websearch||{enabled:false};w.backend=body.backend;
      if(body.endpoint!==undefined)w.endpoints={...w.endpoints,[body.backend]:body.endpoint};
      if(body.key!==undefined){w.keys=(w.keys||[]).filter(k=>k!==body.backend);if(body.key)w.keys.push(body.backend);}return {};}
    throw Error('unexpected '+path);};
  const transport={load:async()=>JSON.parse(JSON.stringify(state)),setEnabled:async(id,on)=>{state.builtin[id]={...state.builtin[id],enabled:on};return JSON.parse(JSON.stringify(state));}};
  return {state,posts,request,transport,tierOf};
}
function setup({answers=[],files=[]}={}){
  const {document}=parseHTML('<!doctype html><html lang="zh"><body><section id="panel"></section></body></html>');
  const s=service(),registry=Tools.build(),host=Plugins.create({registry,transport:s.transport});
  host.install(BrowserPlugin.plugin);
  let syncing=false;host.onChange(()=>{if(syncing)return;syncing=true;try{Mcp.sync(host,host.config());}finally{syncing=false;}});
  const asked=[],copied=[],picks=[];
  const confirm=message=>{asked.push(message);return answers.length?answers.shift():true;};
  const view=Settings.mount(document.getElementById('panel'),{host,request:s.request,confirm,copy:async text=>{copied.push(text);},pickFiles:async opts=>{picks.push(opts);return files;}});
  return {document,s,host,registry,view,asked,copied,picks,q:sel=>document.querySelector(sel),qa:sel=>[...document.querySelectorAll(sel)]};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const change=(node,value)=>{if(value!==undefined){if(node.type==='checkbox')node.checked=value;else for(const o of node.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);}node.dispatchEvent(new node.ownerDocument.defaultView.Event('change'));};
const input=(node,value)=>{node.value=value;node.dispatchEvent(new node.ownerDocument.defaultView.Event('input'));};
const fileOf=(path,text)=>({webkitRelativePath:path,name:path.split('/').pop(),size:text.length,text:async()=>text});

async function addWords(h,{tier}={}){
  h.q('#pluginImportOpen').click();
  input(h.q('#pluginImportText'),'{"mcpServers":{}}');
  h.q('#pluginImportParse').click();await settle();
  h.q('[data-candidate="words"] [data-action="check"]').click();await settle();
  if(tier)h.q(`#pluginCheckTier [data-value="${tier}"]`).click();
  h.q('#pluginCheckConfirm').click();await settle();
}

test('command text splits into an executable and arguments without a shell',()=>{
  assert.deepEqual(Settings.parseCommand(`/opt/x/server --dir "/a b" 'c d'`),{command:'/opt/x/server',args:['--dir','/a b','c d']});
  assert.deepEqual(Settings.transportOf('http',' http://127.0.0.1:8765/mcp '),{kind:'http',url:'http://127.0.0.1:8765/mcp'});
});

test('one list for built-in and external plugins, no old split sections',async()=>{
  const h=setup();await addWords(h);
  h.q('#pluginBack').click();
  assert.ok(h.q('[data-plugin="browser"]'),'built-in plugin row');
  assert.ok(h.q('[data-mcp-plugin="words"]'),'external plugin row');
  assert.doesNotMatch(h.q('#pluginSettingsCard').textContent,/内置插件|外部 MCP 插件|null|undefined/);
  assert.equal(h.qa('.plugin-list').length,1);
  // The switch works without opening the detail.
  change(h.q('[data-mcp-plugin="words"] input[type="checkbox"]'),false);await settle();
  assert.equal(h.s.state.mcp[0].enabled,false);
  assert.equal(h.host.freeze().tools.some(n=>n.startsWith('words__')),false);
});

test('paste import: recognize, test with the server\'s own claims, nothing is added before confirming',async()=>{
  const h=setup({answers:[true]});
  h.q('#pluginImportOpen').click();
  input(h.q('#pluginImportText'),'{"mcpServers":{"words":{"command":"/usr/local/bin/words"}}}');
  h.q('#pluginImportParse').click();await settle();
  assert.deepEqual(h.s.posts[0],['/__plugins/import/parse',{kind:'text',text:'{"mcpServers":{"words":{"command":"/usr/local/bin/words"}}}'}]);
  assert.equal(h.qa('[data-candidate]').length,3);
  assert.equal(h.s.state.mcp.length,0);
  h.q('[data-candidate="words"] [data-action="check"]').click();await settle();
  assert.match(h.q('.plugin-notice').textContent,/无法强制/);
  assert.match(h.q('#pluginCheckTools [data-tool="lookup_word"]').textContent,/声明：只读/);
  assert.match(h.q('#pluginCheckTools [data-tool="add_word"]').textContent,/声明：会写入/);
  assert.equal(h.q('#pluginCheckTier .on').dataset.value,'ask','default tier is ask');
  // Only the names of environment variables are shown; ticked by default.
  assert.ok(h.q('#pluginCheckEnv [data-env="WORDS_KEY"]').hasAttribute('checked'));
  assert.doesNotMatch(h.q('#pluginCheckEnv').textContent,/sk-|=/);
  // A plugin-wide read-only tier needs the user's confirmation.
  h.q('#pluginCheckTier [data-value="readonly"]').click();
  assert.equal(h.asked.length,1);assert.match(h.asked[0],/只有声明为只读的工具/);
  change(h.q('[data-env="WORDS_KEY"]'),false);
  h.q('#pluginCheckConfirm').click();await settle();
  const [,added]=h.s.posts.find(([p])=>p==='/__plugins/mcp/add');
  assert.deepEqual(added,{probeId:'probe_1',name:'words',defaultTier:'readonly',confirmDefault:true,includeEnv:[],source:{kind:'paste'}});
  assert.match(h.q('[data-candidate="words"]').textContent,/已添加/);
  assert.deepEqual(h.host.freeze().tools.filter(n=>n.startsWith('words__')).sort(),['words__add_word','words__lookup_word']);
});

test('declining the plugin-wide read-only confirmation keeps ask',async()=>{
  const h=setup({answers:[false]});
  h.q('#pluginImportOpen').click();input(h.q('#pluginImportText'),'x');h.q('#pluginImportParse').click();await settle();
  h.q('[data-candidate="words"] [data-action="check"]').click();await settle();
  h.q('#pluginCheckTier [data-value="readonly"]').click();
  assert.equal(h.q('#pluginCheckTier .on').dataset.value,'ask');
  h.q('#pluginCheckConfirm').click();await settle();
  assert.equal(h.s.posts.find(([p])=>p==='/__plugins/mcp/add')[1].confirmDefault,false);
});

test('a package-runner command shows a copyable install command and takes the real path afterwards',async()=>{
  const h=setup();
  h.q('#pluginImportOpen').click();input(h.q('#pluginImportText'),'x');h.q('#pluginImportParse').click();await settle();
  const row=h.q('[data-candidate="search"]');
  assert.equal(row.dataset.status,'needs_install');
  assert.equal(row.querySelector('[data-action="check"]'),null,'cannot be tested before installing');
  assert.equal(row.querySelector('code').textContent,'npm install -g some-pkg');
  row.querySelector('[data-action="copy"]').click();await settle();
  assert.deepEqual(h.copied,['npm install -g some-pkg']);
  assert.equal(h.s.posts.some(([p])=>p==='/__plugins/mcp/add'),false,'AI Bro never installs it for the user');
  input(row.querySelector('[data-field="command"]'),'/opt/homebrew/bin/some-pkg');
  row.querySelector('[data-action="recheck"]').click();await settle();
  assert.deepEqual(h.s.posts.at(-1),['/__plugins/import/probe',{importId:'imp_1',index:1,commandLine:'/opt/homebrew/bin/some-pkg'}]);
  assert.equal(h.q('[data-candidate="search"]').dataset.status,'ready');
  assert.ok(h.q('#pluginCheck'),'then the normal check step follows');
});

test('unsupported servers explain why and offer nothing',async()=>{
  const h=setup();
  h.q('#pluginImportOpen').click();input(h.q('#pluginImportText'),'x');h.q('#pluginImportParse').click();await settle();
  const row=h.q('[data-candidate="remote"]');
  assert.match(row.textContent,/回环地址/);assert.equal(row.querySelector('button'),null);
});

test('plugin folder: reads only the manifest and .mcp.json, counts the rest',async()=>{
  const files=[fileOf('latex/.claude-plugin/plugin.json','{"name":"latex-tools"}'),fileOf('latex/.mcp.json','{}'),fileOf('latex/skills/proof/SKILL.md','# secret skill body'),
    fileOf('latex/node_modules/x/.claude-plugin/plugin.json','{}'),fileOf('latex/commands/a.md','body')];
  const h=setup({files});
  h.q('#pluginImportOpen').click();h.q('[data-tab="folder"]').click();
  h.q('#pluginImportFolder').click();await settle();
  assert.deepEqual(h.picks[0],{directory:true});
  const [path,body]=h.s.posts[0];
  assert.equal(path,'/__plugins/import/parse');assert.equal(body.kind,'folder');
  assert.deepEqual(Object.keys(body.files).sort(),['latex/.claude-plugin/plugin.json','latex/.mcp.json','latex/commands/a.md','latex/skills/proof/SKILL.md']);
  assert.equal(body.files['latex/skills/proof/SKILL.md'],null,'skill bodies are not read');
  assert.equal(body.files['latex/commands/a.md'],null);
  assert.match(h.q('#pluginFolderInfo').textContent,/latex-tools/);
  assert.match(h.q('#pluginFolderInfo').textContent,/2 个技能/);
  assert.match(h.q('#pluginFolderInfo').textContent,/commands 3 \/ agents 1.*不加载/);
});

test('plugin folder by typed path goes to the service, which reads it',async()=>{
  const h=setup();
  h.q('#pluginImportOpen').click();h.q('[data-tab="folder"]').click();
  input(h.q('#pluginImportFolderPath'),' /Users/me/plugins/latex ');h.q('#pluginImportFolderPathGo').click();await settle();
  assert.deepEqual(h.s.posts[0],['/__plugins/import/parse',{kind:'folder-path',path:'/Users/me/plugins/latex'}]);
  assert.ok(h.q('#pluginCandidates'));
});

test('another app\'s config file: JSON is sent as text, a database as base64, nothing else is read',async()=>{
  const json='{"mcpServers":{}}';
  let h=setup({files:[{name:'claude_desktop_config.json',size:json.length,slice:()=>({arrayBuffer:async()=>new TextEncoder().encode(json.slice(0,15)).buffer}),text:async()=>json,arrayBuffer:async()=>new TextEncoder().encode(json).buffer}]});
  h.q('#pluginImportOpen').click();h.q('[data-tab="app"]').click();h.q('#pluginImportFile').click();await settle();
  assert.deepEqual(h.s.posts[0],['/__plugins/import/parse',{kind:'app',text:json}]);
  const db=new TextEncoder().encode('SQLite format 3\0rest');
  h=setup({files:[{name:'cc-switch.db',size:db.length,slice:()=>({arrayBuffer:async()=>db.buffer.slice(0,15)}),text:async()=>{throw Error('must not read a database as text');},arrayBuffer:async()=>db.buffer}]});
  h.q('#pluginImportOpen').click();h.q('[data-tab="app"]').click();h.q('#pluginImportFile').click();await settle();
  assert.equal(h.s.posts[0][1].kind,'ccswitch');assert.equal(Buffer.from(h.s.posts[0][1].data,'base64').toString('latin1'),'SQLite format 3\0rest');
});

test('detail: plugin-wide tier, one override, then follow the default again',async()=>{
  const h=setup({answers:[true,true]});await addWords(h);
  h.q('#pluginBack').click();h.q('[data-mcp-plugin="words"]').click();
  assert.equal(h.q('#pluginDefaultTier .on').dataset.value,'ask');
  h.q('#pluginDefaultTier [data-value="readonly"]').click();await settle();
  assert.deepEqual(h.s.posts.at(-1),['/__plugins/mcp/default-tier',{id:'words',tier:'readonly',confirm:true}]);
  assert.equal(h.s.state.mcp[0].tools.find(t=>t.name==='lookup_word').tier,'readonly');
  assert.equal(h.s.state.mcp[0].tools.find(t=>t.name==='add_word').tier,'ask');
  assert.match(h.q('#pluginTools summary').textContent,/1 个单独设置，1 个跟随默认/,'the write tool that stays at ask is the individual one');
  const writeSelect=h.q('select[data-tool="add_word"]');
  assert.equal(writeSelect.querySelector('option[value="follow"]'),null,'a write-declaring tool cannot follow a blanket read-only default');
  change(h.q('select[data-tool="lookup_word"]'),'disabled');await settle();
  assert.equal(h.s.state.mcp[0].tools.find(t=>t.name==='lookup_word').tier,'disabled');
  assert.deepEqual(h.host.freeze().tools.filter(n=>n.startsWith('words__')),['words__add_word']);
  change(h.q('select[data-tool="lookup_word"]'),'follow');await settle();
  assert.deepEqual(h.s.posts.at(-1),['/__plugins/mcp/tier',{id:'words',tool:'lookup_word',tier:'readonly',confirm:true}]);
});

test('detail: remove asks first and returns to the list',async()=>{
  const h=setup({answers:[false,true]});await addWords(h);
  h.q('#pluginBack').click();h.q('[data-mcp-plugin="words"]').click();
  h.q('[data-action="remove"]').click();await settle();
  assert.equal(h.s.state.mcp.length,1,'declined');
  h.q('[data-action="remove"]').click();await settle();
  assert.equal(h.s.state.mcp.length,0);assert.equal(h.q('[data-mcp-plugin="words"]'),null);assert.ok(h.q('#pluginImportOpen'),'back on the list');
  assert.equal(h.registry.has('words__lookup_word'),false);
});

test('browser detail: site lists and the default for unlisted sites',async()=>{
  const h=setup();
  h.q('[data-plugin="browser"]').click();
  input(h.q('#browserSiteInput'),'https://docs.example.org');h.q('#browserSiteAllow').click();await settle();
  assert.deepEqual(h.s.posts.at(-1),['/__plugins/browser/sites',{origin:'https://docs.example.org',decision:'allow'}]);
  assert.ok(h.q('[data-list="allow"] [data-origin="https://docs.example.org"]'));
  input(h.q('#browserSiteInput'),'https://bad.example.org');h.q('#browserSiteDeny').click();await settle();
  assert.ok(h.q('[data-list="deny"] [data-origin="https://bad.example.org"]'));
  h.q('#browserUnknownSites [data-value="ask"]').click();await settle();
  assert.equal(h.s.state.builtin.browser.unknownSites,'ask');
  h.q('[data-list="allow"] button').click();await settle();
  assert.equal(h.q('[data-list="allow"] [data-origin]'),null);
});

test('web search detail: the service, its address and an optional key that never comes back',async()=>{
  globalThis.AIBroWebSearchPlugin=WebSearchPlugin;
  try{
    const h=setup();h.host.install(WebSearchPlugin.plugin);
    assert.match(h.q('div[data-plugin="websearch"]').textContent,/已关闭/,'off by default');
    h.q('[data-plugin="websearch"]').click();
    assert.equal(h.q('#webSearchBackend [aria-pressed="true"]').dataset.value,'keenable');
    assert.equal(h.q('#webSearchEndpoint'),null,'Keenable needs no address');
    input(h.q('#webSearchKey'),' kn-ui-key ');h.q('#webSearchKeySave').click();await settle();
    assert.deepEqual(h.s.posts.at(-1),['/__plugins/websearch/settings',{backend:'keenable',key:'kn-ui-key'}]);
    assert.equal(h.q('#webSearchKey').value,'','the key is not shown again');
    assert.match(h.q('#webSearchKey').placeholder,/钥匙串/);
    h.q('#webSearchKeyClear').click();await settle();
    assert.deepEqual(h.s.posts.at(-1),['/__plugins/websearch/settings',{backend:'keenable',key:''}]);
    assert.equal(h.q('#webSearchKeyClear'),null);
    h.q('#webSearchBackend [data-value="searxng"]').click();await settle();
    assert.deepEqual(h.s.posts.at(-1),['/__plugins/websearch/settings',{backend:'searxng'}]);
    assert.equal(h.q('#webSearchKey'),null,'SearXNG takes no key');
    input(h.q('#webSearchEndpoint'),' http://127.0.0.1:8888 ');h.q('#webSearchEndpointSave').click();await settle();
    assert.deepEqual(h.s.posts.at(-1),['/__plugins/websearch/settings',{backend:'searxng',endpoint:'http://127.0.0.1:8888'}]);
    assert.equal(h.q('#webSearchEndpoint').value,'http://127.0.0.1:8888');
    assert.equal(h.s.state.builtin.websearch.enabled,false,'configuring does not switch it on');
  }finally{delete globalThis.AIBroWebSearchPlugin;}
});

test('an unrecognized paste shows a notice, not an empty list',async()=>{
  const h=setup();
  h.q('#pluginImportOpen').click();input(h.q('#pluginImportText'),'  ');h.q('#pluginImportParse').click();await settle();
  assert.match(h.q('#pluginImportNotice').textContent,/没有识别到/);
  assert.equal(h.q('#pluginCandidates'),null);
});
