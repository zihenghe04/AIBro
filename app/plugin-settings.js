/* Settings → Plugins: one list for built-in and external plugins; a detail page
   per plugin with a plugin-wide permission tier (tools are only overridden one
   by one when needed) and, for the browser, its site lists; one import page with
   three entrances (paste, a plugin folder, another app's config file).
   Importing never installs or runs anything: every server is tested first
   (listing its tools with what the server itself declares, which AI Bro cannot
   enforce) and added only after the user confirms. Commands that would download
   packages (npx, uvx, …) are shown with a command to copy into the user's own
   terminal. Everything applies from the next run (plugin-host.js). The local
   service (mcp_plugins.py) holds the settings and parses what is imported;
   nothing here grants authority. Environment values never come back to this
   page: only their names are shown. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AIBroPluginSettings=api;})(globalThis,root=>{
  'use strict';
  const t=(zh,en)=>/^en(?:-|$)/i.test(root.document?.documentElement?.lang||'')?en:zh;
  const TIERS=[['ask','每次询问','Ask each time'],['readonly','只读免审','Read-only, no approval'],['disabled','关闭','Off']];
  const STATUS={ok:['就绪','Ready'],exited:['不可用','Unavailable']};
  const CAND={ready:['可测试','Ready to test'],needs_install:['需要先安装到本机','Install it first'],needs_path:['需要完整路径','Needs a full path'],unsupported:['不支持','Not supported']};
  const MAX_DB_BYTES=10*1024*1024;
  async function post(path,body,fetchImpl=root.fetch?.bind(root)){
    const response=await fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(Error(value.error||t('插件设置请求失败。','The plugin request failed.')),{code:value.code});
    return value;
  }
  // "/path/to/server --flag value" → {command,args}. Quotes group words; no shell runs.
  function parseCommand(text){
    const words=[];let word='',quote=null,any=false;
    for(const ch of String(text||'').trim()){
      if(quote){if(ch===quote)quote=null;else word+=ch;continue;}
      if(ch==='"'||ch==="'"){quote=ch;any=true;continue;}
      if(/\s/.test(ch)){if(any||word){words.push(word);word='';any=false;}continue;}
      word+=ch;
    }
    if(any||word)words.push(word);
    return {command:words[0]||'',args:words.slice(1)};
  }
  function transportOf(kind,text){
    return kind==='http'?{kind:'http',url:String(text||'').trim()}:{kind:'stdio',...parseCommand(text)};
  }
  // Choose a <select> option; option selectedness also works where select.value is read-only.
  const choose=(select,value)=>{try{select.value=value;}catch{}for(const option of select.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);};
  const describeTransport=transport=>transport?.kind==='http'?transport.url:[transport?.command,...(transport?.args||[])].filter(Boolean).join(' ');
  const WARN_HINT=/写入|删除|writes|delete/;
  const hints=annotations=>{
    const a=annotations||{},out=[];
    if(a.readOnlyHint===true)out.push(t('声明：只读','Declares: read-only'));
    if(a.readOnlyHint===false)out.push(t('声明：会写入','Declares: writes'));
    if(a.destructiveHint===true)out.push(t('声明：可能删除或覆盖','Declares: may delete or overwrite'));
    if(a.openWorldHint===true)out.push(t('声明：访问外部','Declares: reaches outside'));
    return out;
  };
  const declaresReadOnly=tool=>tool.annotations?.readOnlyHint===true&&tool.annotations?.destructiveHint!==true;
  const defaultOf=entry=>TIERS.some(([v])=>v===entry.defaultTier)?entry.defaultTier:'ask';
  const tierLabel=value=>{const found=TIERS.find(([v])=>v===value);return found?t(found[1],found[2]):value;};
  const followsDefault=(entry,tool)=>tool.tier===defaultOf(entry)&&!tool.changed;
  function toBase64(buffer){
    const bytes=new Uint8Array(buffer);let binary='';
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return root.btoa(binary);
  }
  // Only these files of a picked folder are read; every other path is sent as a name for counting.
  const WANTED=/(^|\/)(\.claude-plugin\/plugin\.json|\.mcp\.json|hooks\/hooks\.json)$/;
  async function readFolder(files){
    const out={};let count=0;
    for(const file of files){
      const path=file.webkitRelativePath||file.name;
      if(/(^|\/)(node_modules|\.git)\//.test(path))continue;
      if(++count>3000)break;
      out[path]=WANTED.test(path)&&file.size<262144?await file.text():null;
    }
    return out;
  }

  function mount(panel,{host=root.AIBroPlugins?.default,request=post,confirm=message=>root.confirm?root.confirm(message):false,toast=()=>{},pickFiles,copy}={}){
    const doc=panel.ownerDocument||root.document;
    const el=(tag,props={},...children)=>{const n=doc.createElement(tag);for(const [k,v] of Object.entries(props)){if(k==='dataset')Object.assign(n.dataset,v);else if(k in n)n[k]=v;else n.setAttribute(k,v);}n.append(...children.filter(c=>c!=null));return n;};
    const button=(text,props,onClick)=>{const b=el('button',{type:'button',textContent:text,...props});b.addEventListener('click',onClick);return b;};
    const chip=(text,kind='')=>el('span',{className:'plugin-chip'+(kind?' '+kind:''),textContent:text});
    const pick=pickFiles||(({directory=false,accept=''}={})=>new Promise(resolve=>{
      const input=el('input',{type:'file'});if(directory)input.webkitdirectory=true;if(accept)input.accept=accept;input.hidden=true;
      input.addEventListener('change',()=>{resolve([...input.files]);input.remove();});
      input.addEventListener('cancel',()=>{resolve([]);input.remove();});
      doc.body.append(input);input.click();
    }));
    const copyText=copy||(async text=>{await root.navigator?.clipboard?.writeText(text);});
    const card=el('article',{className:'card plugin-settings-card',id:'pluginSettingsCard'});
    panel.append(card);
    let view={name:'list'},busy=false,error='';
    const imp={tab:'paste',text:'',folderPath:'',parsed:null,check:null,commands:{},notice:''};
    const config=()=>host?.config?.()||{builtin:{},mcp:[]};
    const mcpEntries=()=>Array.isArray(config().mcp)?config().mcp:[];
    const reload=async()=>{try{await host?.load?.();}catch(e){error=e.message;}render();};
    async function act(work){
      if(busy)return;busy=true;error='';render();
      try{await work();}catch(e){error=e.message||String(e);toast(error);}
      finally{busy=false;await reload();}
    }
    const go=next=>{view=next;error='';render();};
    const lowerOk=tool=>confirm(t(`把「${tool.name}」改为“只读免审”？之后它的调用不再逐次询问你。只读是服务器自己的声明，AI Bro 无法强制。`,`Let "${tool.name}" run without asking? Its read-only label comes from the server; AI Bro cannot enforce it.`));
    const defaultOk=name=>confirm(t(`把「${name}」整体改为“只读免审”？只有声明为只读的工具之后不再逐次询问你；其余工具仍然每次询问。只读是服务器自己的声明，AI Bro 无法强制。`,`Let the tools of "${name}" that declare themselves read-only run without asking? The other tools still ask. Read-only labels come from the server; AI Bro cannot enforce them.`));
    const backButton=onClick=>button(t('‹ 返回','‹ Back'),{className:'plugin-back',id:'pluginBack'},onClick);

    // ---- list ----------------------------------------------------------
    const logoOf=(id,name)=>id==='browser'?'🌐':(String(name||'?').trim()[0]||'?').toUpperCase();
    function listRow({id,name,badge,badgeKind,summary,status,statusKind,enabled,onToggle,onOpen,mcpId}){
      const row=el('div',{className:'plugin-row',dataset:mcpId?{mcpPlugin:mcpId}:{plugin:id}});
      const toggle=el('input',{type:'checkbox',checked:enabled,disabled:busy,dataset:{plugin:id},'aria-label':t('启用 ','Enable ')+name});
      toggle.addEventListener('change',()=>onToggle(toggle.checked));
      const label=el('label',{className:'sound-toggle'},toggle);
      label.addEventListener('click',event=>event.stopPropagation());
      row.append(el('span',{className:'plugin-logo',textContent:logoOf(id,name)}),
        el('button',{type:'button',className:'plugin-row-main plugin-row-open','aria-label':t('查看 ','Open ')+name},el('b',{textContent:name}),' ',chip(badge,badgeKind),el('span',{className:'muted plugin-row-sub',textContent:summary})),
        status?chip(status,statusKind):null,label);
      row.addEventListener('click',onOpen);
      return row;
    }
    function renderList(){
      const list=el('div',{className:'plugin-list'});
      for(const plugin of (host?.list?.()||[]).filter(p=>p.kind==='builtin')){
        const name=t(plugin.name.zh,plugin.name.en||plugin.name.zh);
        list.append(listRow({id:plugin.id,name,badge:t('内置','Built-in'),summary:plugin.summary.zh,enabled:plugin.enabled,
          status:plugin.enabled?(plugin.available?t('就绪','Ready'):t('不可用','Unavailable')):t('已关闭','Off'),statusKind:plugin.enabled&&plugin.available?'ok':'',
          onToggle:on=>act(()=>host.setEnabled(plugin.id,on)),onOpen:()=>go({name:'detail',id:plugin.id,builtin:true})}));
      }
      for(const entry of mcpEntries()){
        const state=entry.status?.state||'ok',[zh,en]=STATUS[state]||[state,state];
        const toolCount=(entry.tools||[]).length;
        list.append(listRow({id:entry.id,mcpId:entry.id,name:entry.name,badge:entry.source?.kind==='folder'?t('文件夹','Folder'):'MCP',badgeKind:'acc',
          summary:`${entry.description||describeTransport(entry.transport)} · ${t(`${toolCount} 个工具`,`${toolCount} tools`)} · ${tierLabel(defaultOf(entry))}`,
          enabled:entry.enabled,status:entry.enabled?t(zh,en):t('已关闭','Off'),statusKind:entry.enabled?(state==='ok'?'ok':'warn'):'',
          onToggle:on=>act(()=>request('/__plugins/mcp/enable',{id:entry.id,enabled:on})),onOpen:()=>go({name:'detail',id:entry.id})}));
      }
      const head=el('div',{className:'plugin-head'},el('div',{},el('p',{className:'muted',textContent:t('启停、改权限都从下一次运行开始生效；正在进行的运行继续用开始时的工具。','Changes apply from the next run; a run in progress keeps the tools it started with.')})),
        button(t('＋ 导入','+ Import'),{className:'primary',id:'pluginImportOpen',disabled:busy},()=>go({name:'import'})));
      return [head,list];
    }

    // ---- detail --------------------------------------------------------
    function seg(options,current,onPick,{id}={}){
      const box=el('div',{className:'plugin-seg',role:'group',...(id?{id}:{})});
      for(const [value,zh,en] of options){
        const b=el('button',{type:'button',textContent:t(zh,en),disabled:busy,dataset:{value},'aria-pressed':String(value===current)});
        b.classList.toggle('on',value===current);b.addEventListener('click',()=>{if(value!==current)onPick(value);});box.append(b);
      }
      return box;
    }
    function toolRow(entry,tool){
      const base=defaultOf(entry);
      const canFollow=base!=='readonly'||declaresReadOnly(tool);
      const follows=followsDefault(entry,tool)&&canFollow;
      const select=el('select',{className:'plugin-tier',dataset:{tool:tool.name},disabled:busy,'aria-label':t('权限：','Tier: ')+tool.name});
      if(canFollow)select.append(el('option',{value:'follow',textContent:t(`跟随默认（${tierLabel(base)}）`,`Follow default (${tierLabel(base)})`)}));
      for(const [value,zh,en] of TIERS)select.append(el('option',{value,textContent:t(zh,en)}));
      choose(select,follows?'follow':tool.tier);
      select.addEventListener('change',()=>{
        const next=select.value==='follow'?base:select.value;
        if(next==='readonly'&&!lowerOk(tool)){choose(select,follows?'follow':tool.tier);return;}
        act(()=>request('/__plugins/mcp/tier',{id:entry.id,tool:tool.name,tier:next,confirm:next==='readonly'}));
      });
      const flags=[...hints(tool.annotations).map(text=>chip(text,WARN_HINT.test(text)?'warn':'')),
        tool.changed?chip(t('说明已变，已退回每次询问','Description changed; back to ask each time'),'warn'):null];
      return el('li',{dataset:{tool:tool.name}},el('code',{textContent:tool.name}),' ',...flags,
        el('span',{className:'muted',textContent:String(tool.description||'').slice(0,160)}),select);
    }
    function browserSites(){
      const state=config().builtin?.browser||{},sites=state.sites||{allow:[],deny:[]};
      const box=el('div',{className:'plugin-block',id:'browserSites'},el('h3',{textContent:t('站点权限','Site permissions')}),
        el('p',{className:'muted',textContent:t('浏览器只在你允许的范围内读取网页。未列出的网站按下面的默认处理；“禁止”优先于“允许”。','The browser only reads pages within what you allow. Sites that are not listed follow the default below; "deny" wins over "allow".')}));
      box.append(el('div',{className:'plugin-field'},el('span',{textContent:t('未列出的网站','Sites not listed')}),
        seg([['auto','自动允许','Allow'],['ask','每次询问','Ask']],state.unknownSites==='ask'?'ask':'auto',value=>act(()=>request('/__plugins/browser/settings',{unknownSites:value})),{id:'browserUnknownSites'})));
      for(const [key,zh,en] of [['allow','允许的网站','Allowed sites'],['deny','禁止的网站','Blocked sites']]){
        const items=sites[key]||[];
        const list=el('ul',{className:'plugin-sites',dataset:{list:key}});
        if(!items.length)list.append(el('li',{className:'muted',textContent:t('（空）','(none)')}));
        for(const origin of items)list.append(el('li',{dataset:{origin}},el('code',{textContent:origin}),
          button(t('移除','Remove'),{className:'secondary',disabled:busy},()=>act(()=>request('/__plugins/browser/sites',{origin,decision:'remove'})))));
        box.append(el('h4',{textContent:t(zh,en)}),list);
      }
      const origin=el('input',{id:'browserSiteInput',type:'text',spellcheck:false,placeholder:'https://example.org',disabled:busy,'aria-label':t('网站地址','Site address')});
      const add=decision=>()=>{const value=origin.value.trim();if(value)act(()=>request('/__plugins/browser/sites',{origin:value,decision}));};
      box.append(el('div',{className:'plugin-add-row plugin-site-add'},origin,button(t('允许','Allow'),{className:'secondary',id:'browserSiteAllow',disabled:busy},add('allow')),button(t('禁止','Block'),{className:'secondary',id:'browserSiteDeny',disabled:busy},add('deny'))));
      return box;
    }
    // Web search: the service and, where it needs them, its address or key. A key goes to
    // the keychain (web_search.py) and never comes back; this page only learns that one is saved.
    function webSearchService(){
      const state=config().builtin?.websearch||{},services=root.AIBroWebSearchPlugin?.BACKENDS||[];
      const current=services.find(s=>s.id===state.backend)||services[0];
      if(!current)return null;
      const save=body=>act(()=>request('/__plugins/websearch/settings',{backend:current.id,...body}));
      const box=el('div',{className:'plugin-block',id:'webSearchService'},el('h3',{textContent:t('搜索服务','Search service')}),
        el('p',{className:'muted',textContent:t('只有检索词会发给所选的服务，不发送对话或资料。','Only the search terms go to the chosen service, never the conversation or your files.')}));
      box.append(el('div',{className:'plugin-field'},el('span',{textContent:t('服务','Service')}),
        seg(services.map(s=>[s.id,s.name,s.name]),current.id,value=>act(()=>request('/__plugins/websearch/settings',{backend:value})),{id:'webSearchBackend'})),
        el('p',{className:'muted',textContent:t(current.note.zh,current.note.en)}));
      if(current.endpoint){
        const address=el('input',{id:'webSearchEndpoint',type:'text',spellcheck:false,value:state.endpoints?.[current.id]||'',placeholder:'http://127.0.0.1:8888',disabled:busy,'aria-label':t('服务地址','Service address')});
        box.append(el('div',{className:'plugin-add-row plugin-site-add'},address,button(t('保存','Save'),{className:'secondary',id:'webSearchEndpointSave',disabled:busy},()=>save({endpoint:address.value.trim()}))));
      }
      if(current.key&&current.key!=='none'){
        const saved=(state.keys||[]).includes(current.id);
        const key=el('input',{id:'webSearchKey',type:'password',autocomplete:'off',spellcheck:false,disabled:busy,'aria-label':'Key',
          placeholder:saved?t('Key 已保存在钥匙串','Key saved in the keychain'):current.key==='optional'?t('Key（可选）','Key (optional)'):'Key'});
        box.append(el('div',{className:'plugin-add-row plugin-site-add'},key,
          button(t('保存 Key','Save key'),{className:'secondary',id:'webSearchKeySave',disabled:busy},()=>{const value=key.value.trim();if(value)save({key:value});}),
          saved?button(t('清除','Clear'),{className:'secondary',id:'webSearchKeyClear',disabled:busy},()=>save({key:''})):null));
      }
      return box;
    }
    function renderDetail(){
      const back=backButton(()=>go({name:'list'}));
      if(view.builtin){
        const plugin=(host?.list?.()||[]).find(p=>p.id===view.id);
        if(!plugin)return [back,el('p',{className:'muted',textContent:t('没有这个插件。','No such plugin.')})];
        const name=t(plugin.name.zh,plugin.name.en||plugin.name.zh);
        const toggle=el('input',{type:'checkbox',checked:plugin.enabled,disabled:busy,'aria-label':t('启用 ','Enable ')+name});
        toggle.addEventListener('change',()=>act(()=>host.setEnabled(plugin.id,toggle.checked)));
        return [back,el('div',{className:'plugin-head'},el('div',{},el('h2',{textContent:name}),el('p',{className:'muted',textContent:plugin.summary.zh})),el('label',{className:'sound-toggle'},toggle)),
          plugin.id==='browser'?browserSites():plugin.id==='websearch'?webSearchService():null].filter(Boolean);
      }
      const entry=mcpEntries().find(e=>e.id===view.id);
      if(!entry)return [back,el('p',{className:'muted',textContent:t('没有这个插件。','No such plugin.')})];
      const base=defaultOf(entry),tools=entry.tools||[];
      const own=tools.filter(x=>!followsDefault(entry,x));
      const toggle=el('input',{type:'checkbox',checked:entry.enabled,disabled:busy,'aria-label':t('启用 ','Enable ')+entry.name});
      toggle.addEventListener('change',()=>act(()=>request('/__plugins/mcp/enable',{id:entry.id,enabled:toggle.checked})));
      const out=[back,el('div',{className:'plugin-head'},el('div',{},el('h2',{},entry.name,' ',chip(entry.source?.kind==='folder'?t('文件夹','Folder'):'MCP','acc')),
        el('p',{className:'muted',textContent:[describeTransport(entry.transport),t(`${tools.length} 个工具`,`${tools.length} tools`),entry.serverInfo?.version?('v'+entry.serverInfo.version):''].filter(Boolean).join(' · ')})),
        el('label',{className:'sound-toggle'},toggle))];
      if(entry.status?.error)out.push(el('p',{className:'plugin-error plugin-status',textContent:entry.status.error}));
      const perm=el('div',{className:'plugin-block',id:'pluginPermission'},el('h3',{textContent:t('权限','Permissions')}),
        seg(TIERS,base,value=>{
          if(value==='readonly'&&!defaultOk(entry.name))return;
          act(()=>request('/__plugins/mcp/default-tier',{id:entry.id,tier:value,confirm:value==='readonly'}));
        },{id:'pluginDefaultTier'}),
        el('p',{className:'muted',textContent:t('整个插件的默认档。工具的说明和标注由服务器自己声明，AI Bro 无法强制，所以默认每次询问。','The default for the whole plugin. Tool descriptions and labels come from the server and AI Bro cannot enforce them, so the default asks each time.')}));
      const details=el('details',{className:'plugin-tools-more',id:'pluginTools',open:own.length>0&&own.length<=8});
      details.append(el('summary',{textContent:t(`工具（${tools.length}）· ${own.length} 个单独设置，${tools.length-own.length} 个跟随默认`,`Tools (${tools.length}) · ${own.length} set individually, ${tools.length-own.length} follow the default`)}));
      const list=el('ul',{className:'plugin-tools'});
      for(const tool of [...own,...tools.filter(x=>!own.includes(x))])list.append(toolRow(entry,tool));
      details.append(list);perm.append(details);out.push(perm);
      if(entry.env?.length)out.push(el('div',{className:'plugin-block'},el('h3',{textContent:t('环境变量','Environment')}),
        el('p',{className:'muted',textContent:t(`只给这个服务器：${entry.env.join('、')}（值保存在钥匙串里）。`,`Only for this server: ${entry.env.join(', ')} (values are kept in the keychain).`)})));
      out.push(el('div',{className:'setting-actions'},
        button(t('重新试连','Test again'),{className:'secondary',disabled:busy,dataset:{action:'retest'}},()=>act(()=>request('/__plugins/mcp/retest',{id:entry.id}))),
        button(t('删除','Remove'),{className:'secondary danger',disabled:busy,dataset:{action:'remove'}},()=>{
          if(!confirm(t(`删除外部插件「${entry.name}」？它的工具从下次运行起消失，数据目录保留在本机。`,`Remove "${entry.name}"? Its tools leave from the next run; its data folder stays on this Mac.`)))return;
          act(async()=>{await request('/__plugins/mcp/remove',{id:entry.id});view={name:'list'};});
        })));
      return out;
    }

    // ---- import --------------------------------------------------------
    const SOURCE={text:'paste',app:'app',ccswitch:'ccswitch',folder:'folder','folder-path':'folder'};
    async function parse(kind,body){
      imp.parsed=null;imp.check=null;imp.commands={};imp.notice='';
      const parsed=await request('/__plugins/import/parse',{kind,...body});
      imp.parsed={...parsed,added:{}};
      if(!parsed.servers.length)imp.notice=parsed.plugin?t('这个文件夹里没有可添加的 MCP 服务器。','This folder has no MCP servers to add.'):t('没有识别到 MCP 服务器。','No MCP servers found.');
    }
    async function chooseFolder(){
      const files=await pick({directory:true});
      if(files.length)await act(async()=>parse('folder',{files:await readFolder(files)}));
    }
    async function chooseAppFile(){
      const file=(await pick({accept:'.json,.db,.sqlite,.sqlite3,application/json'}))[0];
      if(!file)return;
      await act(async()=>{
        const head=new Uint8Array(await file.slice(0,15).arrayBuffer());
        if(String.fromCharCode(...head)==='SQLite format 3'){
          if(file.size>MAX_DB_BYTES)throw Error(t('这个数据库文件太大。','This database file is too large.'));
          await parse('ccswitch',{data:toBase64(await file.arrayBuffer())});
        }else{
          if(file.size>8*1024*1024)throw Error(t('这个配置文件太大。','This config file is too large.'));
          await parse('app',{text:await file.text()});
        }
      });
    }
    // Test one candidate. With a command line the user typed after installing, the service classifies it again first.
    const check=(index,commandLine)=>act(async()=>{
      const probe=await request('/__plugins/import/probe',{importId:imp.parsed.importId,index,...(commandLine!=null?{commandLine}:{})});
      imp.parsed.servers[index]=probe.candidate;
      imp.check={index,probe,name:(imp.parsed.plugin&&imp.parsed.servers.length===1?imp.parsed.plugin.name:probe.candidate.name),defaultTier:'ask',confirmDefault:false,env:Object.fromEntries((probe.candidate.env||[]).map(n=>[n,true]))};
    });
    function candidateRow(c){
      const index=c.index,added=imp.parsed.added[index];
      const [zh,en]=CAND[c.status]||[c.status,c.status];
      const row=el('div',{className:'plugin-cand',dataset:{candidate:c.name,status:c.status}},
        el('div',{className:'plugin-row-main'},el('b',{textContent:c.name}),el('div',{className:'muted plugin-row-sub plugin-code',textContent:describeTransport(c.transport)||'—'})),
        added?chip(t('已添加','Added'),'ok'):chip(t(zh,en),c.status==='ready'?'ok':c.status==='unsupported'?'':'warn'));
      const body=el('div',{className:'plugin-cand-body'});
      if(!added){
        if(c.status==='ready'&&imp.check?.index!==index)body.append(button(t('试连并查看工具','Test and list tools'),{className:'secondary',disabled:busy,dataset:{action:'check'}},()=>check(index)));
        if(c.status==='needs_install'||c.status==='needs_path'){
          body.append(el('p',{className:'plugin-note',textContent:c.reason||''}));
          if(c.installCommand)body.append(el('div',{className:'plugin-copy'},el('code',{textContent:c.installCommand}),
            button(t('复制安装命令','Copy command'),{className:'secondary',dataset:{action:'copy'}},async()=>{try{await copyText(c.installCommand);toast(t('已复制，请到终端里运行。','Copied. Run it in your own terminal.'));}catch{toast(t('复制失败，请手动选择命令。','Copy failed; select the command by hand.'));}})));
          const input=el('input',{type:'text',spellcheck:false,value:imp.commands[index]||'',disabled:busy,placeholder:'/usr/local/bin/my-mcp-server --flag',dataset:{field:'command'},'aria-label':t('完整路径和参数','Full path and arguments')});
          input.addEventListener('input',()=>{imp.commands[index]=input.value;});
          body.append(el('label',{className:'plugin-add-row'},el('span',{textContent:t('装好后填写','After installing')}),input),
            button(t('重新检查','Check again'),{className:'secondary',disabled:busy,dataset:{action:'recheck'}},()=>{if((imp.commands[index]||'').trim())check(index,imp.commands[index]);}));
        }
        if(c.status==='unsupported')body.append(el('p',{className:'plugin-note',textContent:c.reason||''}));
        if(imp.check?.index===index)body.append(checkPanel(c));
      }
      row.append(body);
      return row;
    }
    function checkPanel(c){
      const state=imp.check,probe=state.probe;
      const box=el('div',{className:'plugin-check',id:'pluginCheck'});
      box.append(el('p',{className:'plugin-notice',textContent:probe.notice||t('工具的说明和标注由服务器自己声明，AI Bro 无法强制。','Descriptions and labels come from the server; AI Bro cannot enforce them.')}));
      const name=el('input',{id:'pluginCheckName',type:'text',value:state.name,maxLength:40,disabled:busy,'aria-label':t('插件名称','Plugin name')});
      name.addEventListener('input',()=>{state.name=name.value;});
      box.append(el('label',{className:'plugin-add-row'},el('span',{textContent:t('名称','Name')}),name));
      const list=el('ul',{className:'plugin-tools',id:'pluginCheckTools'});
      for(const tool of probe.tools||[])list.append(el('li',{dataset:{tool:tool.name}},el('code',{textContent:tool.name}),' ',
        ...hints(tool.annotations).map(text=>chip(text,WARN_HINT.test(text)?'warn':'')),el('span',{className:'muted',textContent:String(tool.description||'').slice(0,200)})));
      box.append(el('h4',{textContent:t(`工具（${(probe.tools||[]).length}）`,`Tools (${(probe.tools||[]).length})`)}),list);
      box.append(el('div',{className:'plugin-field'},el('span',{textContent:t('权限','Permissions')}),
        seg(TIERS,state.defaultTier,value=>{
          if(value==='readonly'){if(!defaultOk(state.name))return;state.confirmDefault=true;}else state.confirmDefault=false;
          state.defaultTier=value;render();
        },{id:'pluginCheckTier'})));
      const names=Object.keys(state.env);
      if(names.length){
        const wrap=el('div',{className:'plugin-note',id:'pluginCheckEnv'},el('p',{textContent:t('这个服务器的配置里带有环境变量（只显示名称）：','This server\'s config carries environment variables (names only):')}));
        for(const key of names){
          const cb=el('input',{type:'checkbox',checked:state.env[key],disabled:busy,dataset:{env:key}});
          cb.addEventListener('change',()=>{state.env[key]=cb.checked;});
          wrap.append(el('label',{className:'plugin-env'},cb,' ',el('code',{textContent:key}),' ',el('span',{className:'muted',textContent:t('带上它（值存入钥匙串，只给这个服务器）','Include it (stored in the keychain, given to this server only)')})));
        }
        box.append(wrap);
      }
      const add=button(t('确认添加（下次运行生效）','Add (applies from the next run)'),{className:'primary',id:'pluginCheckConfirm',disabled:busy||!(probe.tools||[]).length},()=>act(async()=>{
        const plugin=imp.parsed.plugin;
        await request('/__plugins/mcp/add',{probeId:probe.probeId,name:state.name,defaultTier:state.defaultTier,confirmDefault:state.confirmDefault,
          includeEnv:names.filter(k=>state.env[k]),source:{kind:SOURCE[imp.parsed.source]||'paste',...(plugin?.name?{label:plugin.name}:{})},...(plugin?.description?{description:plugin.description}:{})});
        imp.parsed.added[c.index]=true;imp.check=null;toast(t('已添加，下次运行生效。','Added. It applies from the next run.'));
      }));
      box.append(el('div',{className:'setting-actions'},add,button(t('取消','Cancel'),{className:'secondary',id:'pluginCheckCancel',disabled:busy},()=>{imp.check=null;render();})));
      return box;
    }
    function folderPathInput(){
      const input=el('input',{id:'pluginImportFolderPath',type:'text',spellcheck:false,value:imp.folderPath,disabled:busy,placeholder:'/Users/me/plugins/my-plugin','aria-label':t('文件夹路径','Folder path')});
      input.addEventListener('input',()=>{imp.folderPath=input.value;});
      return input;
    }
    function renderImport(){
      const out=[backButton(()=>{imp.parsed=null;imp.check=null;go({name:'list'});}),el('h2',{textContent:t('导入插件','Import plugins')})];
      const tabs=el('div',{className:'plugin-seg plugin-tabs',role:'tablist'});
      for(const [value,zh,en] of [['paste','粘贴','Paste'],['folder','选择文件夹','Choose a folder'],['app','从其他应用','From another app']]){
        const b=el('button',{type:'button',textContent:t(zh,en),disabled:busy,dataset:{tab:value},role:'tab','aria-selected':String(imp.tab===value)});
        b.classList.toggle('on',imp.tab===value);
        b.addEventListener('click',()=>{imp.tab=value;imp.parsed=null;imp.check=null;render();});tabs.append(b);
      }
      out.push(tabs);
      if(imp.tab==='paste'){
        const text=el('textarea',{id:'pluginImportText',rows:7,spellcheck:false,value:imp.text,disabled:busy,placeholder:'{ "mcpServers": { "name": { "command": "/usr/local/bin/server", "args": [] } } }',
          'aria-label':t('MCP 配置或启动命令','MCP config or start command')});
        text.addEventListener('input',()=>{imp.text=text.value;});
        out.push(el('p',{className:'muted',textContent:t('粘贴 mcpServers 配置（Claude Desktop、Cursor 等常见格式）、单个服务器的 JSON，或一条 claude mcp add … 命令、可执行文件路径。','Paste an mcpServers config (the common Claude Desktop or Cursor format), a single server\'s JSON, a claude mcp add … command or an executable path.')}),text,
          el('div',{className:'setting-actions'},button(t('识别','Recognize'),{id:'pluginImportParse',disabled:busy},()=>act(()=>parse('text',{text:imp.text})))));
      }else if(imp.tab==='folder'){
        out.push(el('p',{className:'muted',textContent:t('选择含 .claude-plugin/plugin.json 的插件文件夹。只读取清单和 .mcp.json；技能、commands、agents、hooks 只显示数量，不加载，也不运行任何脚本。','Pick a plugin folder with .claude-plugin/plugin.json. Only the manifest and .mcp.json are read; skills, commands, agents and hooks are only counted, nothing is loaded or run.')}),
          el('div',{className:'setting-actions'},button(t('选择文件夹…','Choose folder…'),{id:'pluginImportFolder',disabled:busy},chooseFolder)),
          el('p',{className:'muted',textContent:t('或者直接填写文件夹的完整路径（清单里的 ${CLAUDE_PLUGIN_ROOT} 会换成这个路径）：','Or type the folder\'s full path (${CLAUDE_PLUGIN_ROOT} in the manifest becomes this path):')}),
          el('div',{className:'plugin-add-row plugin-site-add'},folderPathInput(),button(t('读取','Read'),{className:'secondary',id:'pluginImportFolderPathGo',disabled:busy},()=>{if(imp.folderPath.trim())act(()=>parse('folder-path',{path:imp.folderPath.trim()}));})));
      }else{
        out.push(el('p',{className:'muted',textContent:t('选一个配置文件：Claude Desktop 的 claude_desktop_config.json、~/.claude.json、Cursor 的 mcp.json，或 CC Switch 的数据库（“从 CC Switch 读取”会只读它默认位置的数据库）。只读取其中的 MCP 服务器列表。','Pick a config file: Claude Desktop\'s claude_desktop_config.json, ~/.claude.json, Cursor\'s mcp.json, or the CC Switch database. Only its MCP server list is read.')}),
          el('div',{className:'setting-actions'},button(t('从 CC Switch 读取','Read from CC Switch'),{id:'pluginImportCcDefault',disabled:busy},()=>act(()=>parse('ccswitch-default',{}))),button(t('选择文件…','Choose file…'),{id:'pluginImportFile',className:'secondary',disabled:busy},chooseAppFile)));
      }
      const parsed=imp.parsed;
      if(parsed){
        if(parsed.plugin){
          const p=parsed.plugin,counts=p.counts||{};
          const extra=[counts.commands&&`commands ${counts.commands}`,counts.agents&&`agents ${counts.agents}`,counts.hooks&&`hooks ${counts.hooks}`].filter(Boolean).join(' / ');
          out.push(el('div',{className:'plugin-block',id:'pluginFolderInfo'},el('h3',{},p.name,' ',p.version?chip('v'+p.version):null),
            p.description?el('p',{className:'muted',textContent:p.description}):null,
            el('p',{className:'muted',textContent:[t(`${counts.skills||0} 个技能`,`${counts.skills||0} skills`),extra&&t(`${extra}（仅显示数量，不加载）`,`${extra} (counted only, not loaded)`)].filter(Boolean).join(' · ')}),
            p.skills?.length?el('p',{className:'muted',textContent:t('技能：','Skills: ')+p.skills.join('、')+t('（暂不加载）',' (not loaded yet)')}):null));
        }
        if(imp.notice)out.push(el('p',{className:'muted',id:'pluginImportNotice',textContent:imp.notice}));
        if(parsed.servers.length){
          out.push(el('p',{className:'muted',textContent:t(`识别到 ${parsed.servers.length} 个服务器：`,`Found ${parsed.servers.length} server(s):`)}));
          const list=el('div',{className:'plugin-cands',id:'pluginCandidates'});
          for(const c of parsed.servers)list.append(candidateRow(c));
          out.push(list);
        }
      }
      return out;
    }

    function render(){
      card.setAttribute('aria-busy',String(busy));
      card.dataset.view=view.name;
      const body=view.name==='import'?renderImport():view.name==='detail'?renderDetail():renderList();
      card.replaceChildren(...[...body,error?el('p',{className:'plugin-error',role:'alert',textContent:error}):null].filter(Boolean));
    }
    host?.onChange?.(()=>{if(!busy)render();});
    doc.addEventListener?.('workstation-language-change',render);
    render();
    return {render,reload,element:card};
  }
  return {mount,parseCommand,transportOf,post};
});
