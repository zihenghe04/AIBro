// Executed only by the compiled Mac App's isolated WK QA branch. DOM events
// exercise the real Halaska surface/controllers; this is not pointer-driven QA.
const config = /* AIBRO_MAC_CONNECTION_CONFIG */ null;
const evidence = {fixture:'aibro-mac-native-connection-workflow-v1',passed:false,checks:[]};
const check = (condition,label) => {if(!condition)throw Error(label);evidence.checks.push(label);};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let currentStage = 'startup';
async function until(label,read,timeout=30000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){last=error.message;}await delay(300);}
  throw Error(currentStage+': '+label+(last?' ('+last+')':''));
}
async function control(op,value) {
  const response=await fetch(config.control+'/control',{method:'POST',credentials:'omit',cache:'no-store',
    headers:{'Content-Type':'application/json','X-AIBro-QA-Nonce':config.nonce},body:JSON.stringify({op,...(value===undefined?{}:{value})})});
  if(!response.ok)throw Error('QA control '+response.status);return response.json();
}
async function localPost(path,payload) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await response.json();if(!response.ok)throw Error('Local fixture operation failed '+response.status);return result;
}
try {
  check(config?.fixture==='aibro-mac-native-connection-workflow-v1','Exact isolated fixture configuration');
  check(window.workstationDesktop?.nativeWorkspacePersistence===true,'Actual native WK persistence bridge');
  check(state.projects.some(item=>item.id==='native-qa'),'Isolated native QA workspace');
  await until('isolated speech credential seed',async()=>(await control('ready')).ready);
  currentStage='connect-and-publish';
  window.WorkstationOnboarding?.close();window.WorkspaceTour?.close();
  await localPost('/__cloud/connect',{serverUrl:config.base,username:'connection-native-qa',password:'public-connection-native-fixture-only',deviceName:'Synthetic WK Mac',mergeConfirmed:true,autoSync:false});
  await workstationDesktop.apiCredentials.save({base:config.providerBase,token:'synthetic-api-key-not-a-real-secret',model:'synthetic-chat-model'});
  localStorage.setItem('workstation-api-protocol','chat');
  showView('settings');SettingsWorkspace.reveal('sync');
  const host=await until('real settings surface',()=>document.querySelector('#connectionSyncSettings'));
  const feedback=()=>host.querySelector('.connection-feedback')?.textContent||'';
  const find=(label,scope=host)=>[...scope.querySelectorAll('button')].find(button=>button.textContent.trim()===label&&!button.disabled);
  async function click(label,scope=host) {
    const button=await until('button '+label+' '+feedback(),()=>find(label,scope));button.click();
    await until('completion of '+label,()=>host.querySelector('[aria-busy]')?.getAttribute('aria-busy')==='false');
    if(host.querySelector('.connection-feedback[role=alert]'))throw Error(feedback());
  }
  await until('automatic capability refresh',()=>find('使用此地址')||find('从这台 Mac 开始'));
  check(true,'Entering real settings starts capability check');
  if(find('使用此地址'))await click('使用此地址');
  await click('从这台 Mac 开始');
  const field=await until('public pairing textarea',()=>host.querySelector('textarea[aria-label="公开配对信息"]'));
  const pairing=JSON.parse(field.value);
  check(pairing.serverOrigin===config.base&&pairing.accountId===config.accountId,'Mac owner bound to the same synthetic server/account');
  check(await AIBroConnectionVault.createConnectionVault().fingerprintPublicKey(pairing.publicJwk)===pairing.fingerprint,'Owner public key and displayed fingerprint agree');
  const select=host.querySelector('select');check(!!select,'Real protocol selector');
  select.value='chat-completions';select.dispatchEvent(new Event('change',{bubbles:true}));
  const speech=host.querySelector('#connectionShare-speech');check(!!speech,'Independent speech sharing control');
  if(!speech.checked)speech.click();
  await click('预览所选配置');
  check(host.querySelectorAll('.connection-preview').length===2,'Chat and independent speech previewed as one batch');
  check(host.textContent.includes('synthetic-chat-model')&&host.textContent.includes('synthetic-speech-model'),'Both saved models appear in the preview');
  check(!host.textContent.includes('synthetic-api-key-not-a-real-secret')&&!host.textContent.includes('synthetic-speech-key-not-a-real-secret'),'No synthetic API key exposed by the surface');
  await click('同步这些已保存配置');
  check(feedback().includes('已加密同步'),'Actual publish acknowledged');
  const adapter=await AIBroDesktopConnections.createDesktopConnectionSync();
  const profiles=await adapter.activeProfiles();
  check(Object.keys(profiles).length===2&&profiles['mac-chat']?.model==='synthetic-chat-model'&&profiles['mac-speech']?.model==='synthetic-speech-model','Actual native atomic vault has both profiles');
  check(profiles['mac-chat'].baseUrl===config.providerBase&&profiles['mac-speech'].baseUrl===config.providerBase+'/audio/transcriptions','Full speech endpoint preserved without double suffix');
  check(profiles['mac-chat'].apiKey==='synthetic-api-key-not-a-real-secret'&&profiles['mac-speech'].apiKey==='synthetic-speech-key-not-a-real-secret','Independent synthetic credentials exported from native storage');
  const follow=JSON.parse(workstationDesktop.connectionFollowing.getItem('aibro-connection-export-v1'));
  check(follow.apiFormat==='chat-completions'&&follow.speech===true,'Both purposes persist automatic sharing with native ACK');
  await control('pairing',pairing);
  currentStage='wait-for-android-phase1';
  const phase1=await until('Android phase1 fingerprint evidence',async()=>{const result=await control('phase1');return result.ready?result:null;},config.phaseTimeoutMs);
  check(phase1.ownerFingerprint===pairing.fingerprint,'Android pinned this exact Mac owner');
  currentStage='approve-exact-phone';
  await click('刷新');
  const device=await until('matching pending phone row',()=>[...host.querySelectorAll('.connection-device')].find(row=>row.querySelector('[aria-label="设备指纹"]')?.textContent.replace(/\s/g,'')===phase1.deviceFingerprint));
  check(device.querySelector('[aria-label="设备指纹"]').textContent.replace(/\s/g,'')===phase1.deviceFingerprint,'Mac displayed fingerprint matches independently returned Android fingerprint');
  const confirm=device.querySelector('input[type=checkbox]');check(!!confirm,'Real phone fingerprint confirmation');confirm.click();
  await click('批准并发送配置',device);
  check(feedback().includes('已批准这台手机'),'Actual Mac approval acknowledged');
  await control('approved',{deviceFingerprint:phase1.deviceFingerprint,ownerFingerprint:pairing.fingerprint});
  currentStage='wait-for-android-phase2';
  const phase2=await until('Android native chat and speech result',async()=>{const result=await control('phase2');return result.ready?result:null;},config.phaseTimeoutMs);
  check(phase2.deviceFingerprint===phase1.deviceFingerprint&&phase2.ownerFingerprint===pairing.fingerprint,'Phase2 retains the same approved device and owner');
  check(phase2.chatHttpsRequests===1&&phase2.speechHttpsRequests===1,'Android made actual native HTTPS chat and speech calls with synced profiles');
  evidence.passed=true;evidence.stage='completed';evidence.ownerFingerprint=pairing.fingerprint;evidence.deviceFingerprint=phase1.deviceFingerprint;
  evidence.scope='Compiled isolated Mac WK + real Halaska sharing/approval + NativeCredentials + real cloud HTTP/SQLite + Android WebCrypto/native vault/HTTPS fixture; no real account, microphone or model';
} catch(error) {
  evidence.stage=currentStage;
  // Only a bounded message, never a provider payload, credential or environment.
  evidence.message=String(error.message||'Fixture failed').replaceAll('synthetic-api-key-not-a-real-secret','[synthetic key]').replaceAll('synthetic-speech-key-not-a-real-secret','[synthetic key]').slice(0,600);
}
try{await control('result',evidence);}catch(_){/* The native report still records failure. */}
return JSON.stringify(evidence);
