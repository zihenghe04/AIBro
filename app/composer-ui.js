/* Early, explicit ownership transfer. Run before app.js binds input actions. */
(function(root){
 'use strict';
 const controls=new Map();let editor=null,booted=false,sending=false;
 const t=(zh,en)=>/^en(?:-|$)/i.test(root.document.documentElement.lang||'')?en:zh;
 const defaults=()=>({
  chatAttach:{label:t('添加附件','Add files'),title:t('添加文件或网页','Add files or webpages'),icon:'attach',iconOnly:true},
  composerContext:{label:t('自动归属','Automatic scope'),icon:'folder',hasPopup:'dialog'},
  composerModel:{label:t('选择模型','Choose model'),icon:'model',hasPopup:'dialog',variant:'secondary'},
  composerPermission:{label:t('跟随空间设置','Workspace permissions'),icon:'shield',hasPopup:'dialog'},
  composerLocal:{label:t('本机项目','Local projects'),icon:'folder',hasPopup:'dialog'},
  composerVoice:{label:t('语音输入','Voice input'),icon:'mic',iconOnly:true},
  composerVoiceSettings:{label:t('语音 API 与 Key…','Speech API and Key…'),icon:'mic'},
  composerMore:{label:t('更多工具','More tools'),icon:'more',iconOnly:true},
  agentSend:{label:sending?t('停止执行','Stop run'):t('发送','Send'),icon:sending?'stop':'send',iconOnly:true,variant:sending?'secondary':'accent'}
 });
 function update(id,props){const record=controls.get(id);if(!record)return false;record.dynamic={...record.dynamic,...props};record.island.update({...defaults()[id],...record.dynamic});return true;}
 function createAction(id,options={}){
  if(controls.has(id))return controls.get(id);
  const host=root.document.createElement('span');host.dataset.composerControl=id;host.setAttribute('data-user-content','');
  const island=root.HalaskaUI.mount(host,'ComposerAction',{id,...defaults()[id],...options});
  const record={host,island,button:host.querySelector('button'),dynamic:{...options}};controls.set(id,record);return record;
 }
 function init(){
  if(booted||!root.HalaskaUI||!root.document.getElementById('composer'))return;
  const input=root.document.getElementById('agentInput'),main=input?.parentElement;if(!input||!main)return;
  const initialValue=input.value,initialPlaceholder=input.getAttribute('placeholder');
  input.remove();main.setAttribute('data-user-content','');editor=root.HalaskaUI.mount(main,'ComposerEditor',{initialValue,initialPlaceholder});
  for(const id of ['chatAttach','composerContext','composerModel','composerPermission','composerLocal','agentSend']){
   const old=root.document.getElementById(id);if(!old)continue;
   const attrs=[...old.attributes].filter(attr=>!['id','class','style','title','aria-label','data-i18n-attrs'].includes(attr.name));
   const record=createAction(id,{className:old.className});old.replaceWith(record.host);
   for(const attr of attrs)record.button.setAttribute(attr.name,attr.value);
  }
  booted=true;root.document.getElementById('composer').classList.add('composer-kit');
  root.document.addEventListener('workstation-language-change',()=>{editor?.update({});for(const [id,record]of controls)record.island.update({...defaults()[id],...record.dynamic});});
 }
 root.ComposerUI={init,createAction,rootFor:node=>node?.closest?.('[data-composer-control]')||node,
  setContext:props=>update('composerContext',props),setModel:props=>update('composerModel',props),setPermission:props=>update('composerPermission',props),
  setVoice:props=>update('composerVoice',props),
  setSending:value=>{sending=!!value;return update('agentSend',{});},get mounted(){return booted;}};
 init();
})(globalThis);
