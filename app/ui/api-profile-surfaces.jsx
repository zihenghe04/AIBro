import React,{useLayoutEffect,useRef} from 'react';
import {Button,TextInput,Text} from './halaska-kit.jsx';
import {KitSelect} from './kit-controls.jsx';
import {Plus,Trash2,Save} from 'lucide-react';
export function APIProfileBar({label='连接方案',ready,busy,profiles=[],selected,name,active,isNew,dirty,error,onChoose,onName,onNew,onSave,onRemove,onReload,onDiscard}){
 const ref=useRef(null);
 useLayoutEffect(()=>{const input=ref.current?.querySelector('input');if(input){input.setAttribute('aria-label',`${label}名称`);input.maxLength=80;}},[label]);
 const options=profiles.map(p=>({value:p.id,label:p.name+(p.id===active?' · 使用中':'')}));
 if(isNew)options.push({value:selected,label:name||'未保存的新方案'});
 return <div className="api-profile-bar" ref={ref} aria-busy={busy}>
  <div className="api-profile-selection"><span className="api-profile-label">{label}</span><KitSelect value={selected} options={options} label={label} disabled={busy||!ready} onChange={onChoose} size="lg"/><Button variant="ghost" icon={<Plus size={16}/>} disabled={busy||!ready} onClick={onNew} style={{minHeight:44}}>新建</Button></div>
  <div className="api-profile-edit"><TextInput value={name} onChange={onName} placeholder="例如：日常使用、公司服务" disabled={busy||!ready} size="lg"/><Button variant="outline" icon={<Save size={15}/>} disabled={busy||!ready} onClick={onSave} style={{minHeight:44}}>保存方案</Button><Button variant="ghost" icon={<Trash2 size={15}/>} disabled={busy||!ready} onClick={onRemove} style={{minHeight:44}}>{isNew?'丢弃':'删除'}</Button>{dirty&&!isNew&&<Button variant="ghost" disabled={busy} onClick={onDiscard} style={{minHeight:44}}>还原修改</Button>}</div>
  {error&&<Button variant="ghost" disabled={busy} onClick={onReload} style={{minHeight:44}}>重新读取方案</Button>}
  <Text as="p" size="xs" secondary style={{margin:'8px 0 0'}} role="status">{error||(dirty?'有未保存修改 · 切换方案会暂存当前输入，关闭 App 后不保留。':'地址、模型和 Key 按方案独立保存。')}</Text>
 </div>;
}
