(()=>{
 const rpc=body=>window.webkit.messageHandlers.desktop.postMessage(body);
 const keys=new Set(['workstation-api-base','workstation-api-model','workstation-openai-model','workstation-provider','aibro-embedding-settings-v1','ai-bro-language','workstation-ui']);
 for(const [key,value] of Object.entries(window.__nativePreferences||{}))if(keys.has(key))localStorage.setItem(key,value);
 delete window.__nativePreferences;
 const originalSet=Storage.prototype.setItem,originalRemove=Storage.prototype.removeItem;
 Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key,value:String(value)}).catch(()=>{});};
 Storage.prototype.removeItem=function(key){originalRemove.call(this,key);if(this===localStorage&&keys.has(key))rpc({command:'preferences',key}).catch(()=>{});};
 const credentials=channel=>Object.fromEntries(['status','read','save','remove'].map(action=>[action,options=>rpc({command:'credentials',channel,action,options:options||{}})]));
 window.workstationDesktop={isDesktop:true,platform:'darwin',agendaProposal:proposal=>rpc({command:'agenda-proposal',proposal}),agendaDraft:id=>rpc({command:'agenda-draft',id}),agendaOpen:id=>rpc({command:'agenda-open',id}),agendaRelated:()=>rpc({command:'agenda-related'}),agendaNotifications:enable=>rpc({command:'agenda-notifications',enable:enable===true}),apiCredentials:credentials('api'),embeddingCredentials:credentials('embedding'),setLanguage:value=>rpc({command:'language',value}),setAppearance:value=>rpc({command:'appearance',value}),openAuthURL:url=>rpc({command:'auth',url})};
 window.workstationDesktop.nativeWorkspacePersistence=true;
 window.workstationDesktop.vectorIndex={load:profile=>rpc({command:'vector-index',action:'load',profile}),write:(profile,puts=[],removes=[])=>rpc({command:'vector-index',action:'write',profile,puts,removes})};
})();
