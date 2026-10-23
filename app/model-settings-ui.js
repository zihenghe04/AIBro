/* Retain host inputs/actions: no secret values enter the React bridge. */
(function(root){'use strict';
 let record=null,catalogProvider=null;
 // The model list is plain public metadata supplied by app.js; it never carries a key.
 const catalog=()=>{try{return catalogProvider?.()||null;}catch(_){return null;}};
 const IDS=['apiBase','apiProtocol','apiKey','model','apiModelOptions','apiCredentialStatus','apiCredentialUnlock','clearApiKey','testApi','apiStatus','workspaceModel-daily','workspaceModel-course','workspaceModel-research'];
 const BUTTONS=new Set(['testApi','clearApiKey']);
 const SELECTS=new Set(['apiProtocol']);
 function snapshot(nodes){
  const controls={};
  for(const [id,node] of nodes){
   const control={disabled:!!node.disabled,hidden:!!node.hidden};
   if(BUTTONS.has(id))control.label=node.textContent.trim();
   if(SELECTS.has(id)){control.value=node.value;control.options=[...node.options].map(option=>({value:option.value,label:option.textContent,disabled:!!option.disabled}));}
   controls[id]=control;
  }
  return controls;
 }
 function refresh(){if(record)record.island.update({controls:snapshot(record.nodes),catalog:catalog()});}
 function setCatalogProvider(fn){catalogProvider=typeof fn==='function'?fn:null;refresh();}
 function mount(){
  const host=document.getElementById('apiCredentials');if(!host||!root.HalaskaUI)return false;
  if(record?.host===host){refresh();return true;}if(record)unmount();
  const nodes=new Map(IDS.map(id=>[id,document.getElementById(id)]));if([...nodes.values()].some(node=>!node||!host.contains(node)))return false;
  const active=document.activeElement,focused=host.contains(active),children=[...host.childNodes],markers=new Map();
  // Mark original positions before mounting an empty, explicitly owned root.
  for(const [id,node] of nodes){const marker=document.createComment('model-setting:'+id);node.before(marker);markers.set(id,marker);}
  const parking=document.createElement('div');parking.hidden=true;parking.className='model-settings-retained';parking.append(...host.childNodes);
  const islandHost=document.createElement('div');islandHost.className='model-settings-root';host.append(parking,islandHost);
  const attach=(id,slot)=>{const node=nodes.get(id),marker=markers.get(id);if(!node||!slot)return;slot.append(node);return()=>{if(marker.parentNode)marker.after(node);};};
  let island;
  try{island=root.HalaskaUI.mount(islandHost,'ModelSettingsSurface',{controls:snapshot(nodes),attach,catalog:catalog()});}
  catch(_){
   // Restore the original form even if a component fails after taking slots.
   for(const [id,node]of nodes){const marker=markers.get(id);if(marker.parentNode)marker.after(node);}
   try{root.HalaskaUI.unmount?.(islandHost);}catch(_){}
   host.replaceChildren(...children);for(const marker of markers.values())marker.remove();
   if(focused&&active.isConnected)active.focus({preventScroll:true});return false;
  }
  record={host,nodes,markers,parking,islandHost,children,island,observer:null};
  let queued=false;
  const observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(record?.island===island)refresh();});});
  // Observe only public presentation state; never inspect input values or storage.
  for(const [id,node] of nodes)if(BUTTONS.has(id)||SELECTS.has(id)||id==='apiCredentialUnlock')observer.observe(node,{attributes:true,attributeFilter:['hidden','disabled'],childList:BUTTONS.has(id)||SELECTS.has(id),subtree:BUTTONS.has(id)||SELECTS.has(id),characterData:BUTTONS.has(id)||SELECTS.has(id)});
  const onChange=()=>refresh();nodes.get('apiProtocol').addEventListener('change',onChange);
  record.observer=observer;record.onChange=onChange;
  if(focused&&active.isConnected)active.focus({preventScroll:true});return true;
 }
 function unmount(){
  if(!record)return;const old=record;record=null;old.observer.disconnect();old.nodes.get('apiProtocol').removeEventListener('change',old.onChange);
  for(const [id,node]of old.nodes){const marker=old.markers.get(id);if(marker.parentNode)marker.after(node);}
  old.island.unmount();old.host.replaceChildren(...old.children);for(const marker of old.markers.values())marker.remove();
 }
 root.ModelSettingsUI={mount,refresh,unmount,setCatalogProvider};
})(globalThis);
