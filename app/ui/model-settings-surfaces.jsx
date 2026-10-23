import React,{useEffect,useLayoutEffect,useRef} from 'react';
import {Card,Heading,Text,Badge,Label,TextInput,Select,Button} from './halaska-kit.jsx';
import {KitSelect,KitCheckbox} from './kit-controls.jsx';
import {Server,KeyRound,FlaskConical,Layers,Trash2,Download,Plus,ChevronDown} from 'lucide-react';
const t=(zh,en)=>/^en(?:-|$)/i.test(document.documentElement.lang)?en:zh;

// Slots deliberately contain DOM owned by app.js. React owns only the shell.
// Secret fields are neither read here nor copied into props/state/decorations.
function HostSlot({id,attach,className='',label}){
 const ref=useRef(null);
 useLayoutEffect(()=>{const release=attach(id,ref.current);const input=ref.current?.querySelector('input,select');if(input&&label)input.setAttribute('aria-label',label);return release;},[attach,id]);
 useLayoutEffect(()=>{const input=ref.current?.querySelector('input,select');if(input&&label)input.setAttribute('aria-label',label);},[label]);
 return <div ref={ref} className={`model-host-slot ${className}`} data-model-slot={id}/>;
}
function RetainedField({id,label,description,controls,attach,select=false,secret=false}){
 const state=controls[id]||{},ref=useRef(null);
 useLayoutEffect(()=>{const labelNode=ref.current?.querySelector('.model-setting-label label');if(labelNode)labelNode.htmlFor=id;const presentation=ref.current?.querySelector('.model-control-presentation');for(const input of presentation?.querySelectorAll('input,button,select')||[])input.tabIndex=-1;});
 return <div className="model-setting-field" ref={ref}>
  <div className="model-setting-label"><Label>{label}</Label></div>
  <div className={`model-retained-control${select?' model-retained-select':''}`} data-disabled={state.disabled||undefined}>
   <div className="model-control-presentation" aria-hidden="true" inert={true}>{select?<Select value={state.value} options={state.options||[]} disabled={state.disabled} size="md"/>:<TextInput value="" type={secret?'password':'text'} disabled={state.disabled} size="md"/>}</div>
   <HostSlot id={id} attach={attach} label={label} className="model-control-native"/>
  </div>
  {description&&<Text as="p" size="xs" secondary style={{margin:'6px 0 0',lineHeight:1.65}}>{description}</Text>}
 </div>;
}
function RetainedAction({id,controls,attach,variant='outline',icon}){
 const state=controls[id]||{};
 return <div className="model-retained-action" hidden={state.hidden} data-disabled={state.disabled||undefined}>
  <div className="model-action-presentation" aria-hidden="true" inert={true}><Button size="sm" variant={variant} disabled={state.disabled} icon={icon}>{state.label||t('操作','Action')}</Button></div>
  <HostSlot id={id} attach={attach} className="model-action-native"/>
 </div>;
}
const WORKSPACES=()=>[['daily',t('日常','Daily')],['course',t('课程','Courses')],['research',t('科研','Research')]];
const EFFORT_LABELS={none:['不推理','None'],minimal:['最少','Minimal'],low:['低','Low'],medium:['中','Medium'],high:['高','High'],xhigh:['很高','Extra high'],max:['最大','Max'],ultra:['极高','Ultra']};
const effortName=level=>{const pair=EFFORT_LABELS[level];return pair?`${level} · ${t(pair[0],pair[1])}`:level;};
// Default and workspace choices come only from the list; an unlisted saved value stays visible instead of being rewritten.
function CatalogChoice({id,label,value,entries,onChange,inherit,description}){
 const options=[...(inherit?[{value:'',label:inherit}]:[]),...entries.filter(e=>e.model).map(e=>({value:e.model,label:e.label&&e.label!==e.model?`${e.label} · ${e.model}`:e.model}))];
 if(value&&!options.some(o=>o.value===value))options.push({value,label:t(`${value}（不在模型列表）`,`${value} (not in model list)`)});
 return <div className="model-setting-field"><div className="model-setting-label"><Label>{label}</Label></div><div className="model-catalog-select"><KitSelect id={id} label={label} value={value||''} options={options} onChange={onChange} placeholder={t('先在模型列表里添加模型','Add a model to the list first')} size="md"/></div>{description&&<Text as="p" size="xs" secondary style={{margin:'6px 0 0',lineHeight:1.65}}>{description}</Text>}</div>;
}
function EffortPicker({row,protocolEfforts,onChange}){
 const chosen=row.efforts||[],summary=chosen.length?row.effortSummary:t('协议默认','Default');
 const toggle=(level,on)=>onChange(on?[...chosen,level]:chosen.filter(x=>x!==level));
 // A bare <details> stays open over the rows below until its summary is
 // clicked again. Close it on an outside press, focus move or Escape.
 // Listeners are attached in the toggle handler itself, not a passive effect,
 // so they are live before the next press even when painting is throttled.
 const ref=useRef(null),release=useRef(null);
 const onToggle=event=>{
  release.current?.();release.current=null;
  if(!event.currentTarget.open)return;
  const outside=e=>{if(ref.current&&!ref.current.contains(e.target))ref.current.open=false;};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);
  release.current=()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);};
 };
 useEffect(()=>()=>release.current?.(),[]);
 const onKeyDown=event=>{if(event.key==='Escape'&&ref.current?.open){event.preventDefault();event.stopPropagation();ref.current.open=false;ref.current.querySelector('summary')?.focus();}};
 return <details ref={ref} className="model-catalog-efforts" onToggle={onToggle} onKeyDown={onKeyDown}><summary aria-label={t(`${row.model||'新模型'} 的思考等级`,`Reasoning levels for ${row.model||'new model'}`)}><span>{summary}</span><ChevronDown size={14} aria-hidden="true"/></summary>
  <div className="model-catalog-effort-menu" role="group">{protocolEfforts.map(level=><KitCheckbox key={level} checked={chosen.includes(level)} label={effortName(level)} onChange={on=>toggle(level,on)}/>)}
   {chosen.length>0&&<button type="button" className="model-catalog-link" onClick={()=>onChange([])}>{t('清空，按协议默认','Clear, use protocol default')}</button>}
   <p>{t('只列出当前接口协议能发送的档位；留空时对话里显示全部可用档位。','Only levels the current protocol can send are listed. Leave empty to offer all of them in chat.')}</p></div></details>;
}
function FetchedChooser({catalog}){
 const [picked,setPicked]=React.useState(()=>new Set());
 const [query,setQuery]=React.useState('');
 const existing=new Set(catalog.entries.map(e=>e.model)),ids=catalog.fetched.filter(id=>!query||id.toLowerCase().includes(query.toLowerCase()));
 const flip=(id,on)=>setPicked(prev=>{const next=new Set(prev);on?next.add(id):next.delete(id);return next;});
 return <div className="model-catalog-chooser" role="group" aria-label={t('服务返回的模型','Models returned by the service')}>
  <div className="model-catalog-chooser-head"><Text as="p" size="xs" secondary style={{margin:0}}>{t(`服务返回 ${catalog.fetched.length} 个模型，勾选要加入列表的。`,`The service returned ${catalog.fetched.length} models. Select the ones to add.`)}</Text><input className="model-catalog-input" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('筛选','Filter')} aria-label={t('筛选模型','Filter models')}/></div>
  <div className="model-catalog-chooser-list">{ids.map(id=><KitCheckbox key={id} checked={existing.has(id)||picked.has(id)} disabled={existing.has(id)} label={existing.has(id)?t(`${id}（已在列表）`,`${id} (already listed)`):id} onChange={on=>flip(id,on)}/>)}{!ids.length&&<Text as="p" size="xs" secondary>{t('没有匹配的模型。','No matching models.')}</Text>}</div>
  <div className="model-catalog-chooser-actions"><Button size="sm" variant="ghost" onClick={catalog.onCloseChooser}>{t('取消','Cancel')}</Button><Button size="sm" variant="accent" disabled={!picked.size} onClick={()=>catalog.onAddFetched([...picked])}>{t(`加入 ${picked.size} 个`,`Add ${picked.size}`)}</Button></div>
 </div>;
}
function ModelCatalogEditor({catalog}){
 const rows=catalog.entries;
 return <div className="model-catalog">
  <div className="model-catalog-heading"><div><Heading level={4} style={{fontSize:13,margin:0}}>{t('模型列表','Model list')}</Heading><Text as="p" size="xs" secondary style={{margin:'4px 0 0',lineHeight:1.6}}>{t('对话里的模型选择器列出这些模型。改动点“保存模型与权限”后生效。','The chat model picker lists these models. Changes apply after Save models & permissions.')}</Text></div>
   <div className="model-catalog-actions"><Button size="sm" variant="outline" icon={<Download size={14} aria-hidden="true"/>} loading={catalog.fetching} disabled={catalog.fetching} onClick={catalog.onFetch}>{t('获取模型列表','Fetch models')}</Button><Button size="sm" variant="outline" icon={<Plus size={14} aria-hidden="true"/>} onClick={catalog.onAdd}>{t('手动添加','Add manually')}</Button></div></div>
  {catalog.status&&<p className="model-catalog-status" role="status">{catalog.status}</p>}
  {catalog.chooser&&catalog.fetched.length>0&&<FetchedChooser catalog={catalog}/>}
  {rows.length?<div className="model-catalog-table" role="table" aria-label={t('模型列表','Model list')}>
   <div className="model-catalog-row model-catalog-head" role="row"><span role="columnheader">{t('菜单显示名','Menu name')}</span><span role="columnheader">{t('实际请求模型','Request model')}</span><span role="columnheader">{t('上下文窗口','Context window')}</span><span role="columnheader">{t('思考等级','Reasoning levels')}</span><span role="columnheader" className="model-catalog-sr">{t('操作','Actions')}</span></div>
   {rows.map(row=><div key={row.key} className="model-catalog-group" role="rowgroup">
    <div className="model-catalog-row" role="row">
     <input className="model-catalog-input" role="cell" value={row.label} placeholder={row.model||t('显示名','Display name')} maxLength={80} aria-label={t('菜单显示名','Menu name')} onChange={e=>catalog.onUpdate(row.key,{label:e.target.value})}/>
     <input className="model-catalog-input" role="cell" value={row.model} placeholder={t('例如 deepseek-v4.1-flash','e.g. deepseek-v4.1-flash')} maxLength={200} spellCheck={false} autoComplete="off" aria-label={t('实际请求模型','Request model')} aria-invalid={row.duplicate||undefined} onChange={e=>catalog.onUpdate(row.key,{model:e.target.value})}/>
     <input className="model-catalog-input" role="cell" value={row.contextWindow} inputMode="numeric" placeholder={t('自动','Auto')} aria-label={t('上下文窗口（token）','Context window (tokens)')} aria-invalid={row.windowInvalid||undefined} onChange={e=>catalog.onUpdate(row.key,{contextWindow:e.target.value})}/>
     <div role="cell"><EffortPicker row={row} protocolEfforts={catalog.protocolEfforts} onChange={efforts=>catalog.onUpdate(row.key,{efforts})}/></div>
     <div role="cell"><button type="button" className="model-catalog-remove" disabled={row.isDefault} title={row.isDefault?t('这是默认模型；先换一个默认模型再删除。','This is the default model. Choose another default before removing it.'):t('从列表删除','Remove from list')} aria-label={t(`删除 ${row.label||row.model||'这一行'}`,`Remove ${row.label||row.model||'this row'}`)} onClick={()=>catalog.onRemove(row.key)}><Trash2 size={15} aria-hidden="true"/></button></div>
    </div>
    {row.hints.map(h=><p key={h.code} className="model-catalog-hint" role="note">{t(h.zh,h.en)}</p>)}
   </div>)}
  </div>:<p className="model-catalog-empty">{t('还没有模型。点“获取模型列表”从服务读取，或“手动添加”。','No models yet. Fetch them from the service or add one manually.')}</p>}
 </div>;
}
export function ModelSettingsSurface({controls={},attach,catalog=null}){
 const props={controls,attach};
 return <div className="model-settings-kit">
  <Card padding={0} style={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:18,boxShadow:'none'}}>
   <div className="model-section-heading"><span className="model-section-icon"><Server size={18} aria-hidden="true"/></span><div><Heading level={3} style={{fontSize:17,margin:0}}>{t('API 连接','API connection')}</Heading><Text as="p" size="xs" secondary style={{margin:'5px 0 0',lineHeight:1.6}}>{t('填写服务地址和凭据，再验证当前连接。','Enter the service address and credentials, then test this connection.')}</Text></div></div>
   <div className="model-section-body"><RetainedField {...props} id="apiBase" label={t('API 地址','API address')}/><RetainedField {...props} id="apiProtocol" label={t('接口协议','API protocol')} select/>
    <div className="model-key-field"><RetainedField {...props} id="apiKey" label="API Key" secret/><div className="model-credential-notice"><KeyRound size={13} aria-hidden="true"/><HostSlot id="apiCredentialStatus" attach={attach}/></div><div className="model-key-actions"><HostSlot id="apiCredentialUnlock" attach={attach}/><RetainedAction {...props} id="clearApiKey" variant="ghost" icon={<Trash2 size={13} aria-hidden="true"/>}/></div></div>
    <div className="model-connection-test"><RetainedAction {...props} id="testApi" icon={<FlaskConical size={14} aria-hidden="true"/>}/><HostSlot id="apiStatus" attach={attach} className="model-connection-status"/></div>
    <Text as="p" size="xs" secondary style={{margin:0,lineHeight:1.7}}>{t('测试只读取模型列表，不验证生成能力，也不会保存输入。地址、协议、Key 和默认模型需要点击本分区上方“保存模型与权限”后保留。','Testing only reads the model list; it does not verify generation or save your input. Use Save models & permissions above to keep the address, protocol, key and default model.')}</Text>
   </div>
  </Card>
  <Card padding={0} style={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:18,boxShadow:'none'}}>
   <div className="model-section-heading"><span className="model-section-icon"><Layers size={18} aria-hidden="true"/></span><div><Heading level={3} style={{fontSize:17,margin:0}}>{catalog?t('模型列表与默认值','Models & defaults'):t('模型默认值','Model defaults')}</Heading><Text as="p" size="xs" secondary style={{margin:'5px 0 0',lineHeight:1.6}}>{catalog?t('维护这个服务可用的模型，再选默认模型和工作区覆盖。','Keep the models this service offers, then choose the default and workspace overrides.'):t('先设置全局模型，再按工作区覆盖。','Set a global model, then override it by workspace.')}</Text></div></div>
   <div className="model-section-body">{catalog?<ModelCatalogEditor catalog={catalog}/>:null}
    <div className={catalog?'model-retained-hidden':undefined}><RetainedField {...props} id="model" label={t('默认模型','Default model')} description={t('可以输入模型名称，也可以从测试返回的列表中选择。','Enter a model name or choose from the list returned by the connection test.')}/></div><HostSlot id="apiModelOptions" attach={attach}/>
    {catalog&&<CatalogChoice id="catalogDefaultModel" label={t('默认模型','Default model')} value={catalog.defaultModel} entries={catalog.entries} onChange={catalog.onDefault} description={t('新对话和没有单独设定的工作区使用它。只能从上面的模型列表里选。','Used by new chats and workspaces without their own setting. Choose from the model list above.')}/>}
    <div className="model-workspace-heading"><Heading level={4} style={{fontSize:13,margin:0}}>{t('工作区模型','Workspace models')}</Heading><Badge>{t('修改后立即生效','Applies immediately')}</Badge></div>
    <div className={catalog?'model-workspace-fields model-retained-hidden':'model-workspace-fields'}>{WORKSPACES().map(([key,label])=><RetainedField key={key} {...props} id={'workspaceModel-'+key} label={label}/>)}</div>
    {catalog&&<div className="model-workspace-fields">{WORKSPACES().map(([key,label])=><CatalogChoice key={key} id={'catalogWorkspace-'+key} label={label} value={catalog.workspace?.[key]||''} entries={catalog.entries} onChange={value=>catalog.onWorkspace(key,value)} inherit={t('跟随默认','Use default')}/>)}</div>}
    <Text as="p" size="xs" secondary style={{margin:0,lineHeight:1.7}}>{t('工作区留空时跟随全局默认。对话设定 → 项目设定 → 工作区设定 → 全局默认；修改只影响新的执行。','Blank workspaces use the global default. Conversation → project → workspace → global default; changes affect new runs only.')}</Text>
   </div>
  </Card>
 </div>;
}
