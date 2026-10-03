const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({preferences={'workstation-api-base':'https://example.com/v1'},onPreferences=()=>{}}={}){const calls=[];class Storage {constructor(){this.map=new Map()}setItem(k,v){this.map.set(k,String(v))}getItem(k){return this.map.get(k)||null}removeItem(k){this.map.delete(k)}}const localStorage=new Storage(),window={__nativePreferences:preferences,webkit:{messageHandlers:{desktop:{postMessage:async b=>{calls.push(b);if(b.command==='preferences')onPreferences(b);return {ok:true}}}}}};vm.runInNewContext(fs.readFileSync('native/Resources/desktop.js','utf8'),{window,Storage,localStorage});return {window,localStorage,calls,Storage};}
test('native settings survive backend origin changes through initial preferences',()=>{const x=setup();assert.equal(x.localStorage.getItem('workstation-api-base'),'https://example.com/v1');assert.equal(x.calls.length,0)});
test('credential IPC uses separate namespaces and returns a promise',async()=>{const x=setup();await x.window.workstationDesktop.embeddingCredentials.read({base:'https://example.com/v1'});assert.equal(x.calls[0].channel,'embedding');assert.equal(x.calls[0].action,'read')});
test('native file storage capability and reentry errors reach both settings channels without a secret or extra request',async()=>{const x=setup();for(const channel of ['apiCredentials','embeddingCredentials']){assert.equal(x.window.workstationDesktop[channel].storageBackend,'encrypted-file');x.window.webkit.messageHandlers.desktop.postMessage=async()=>{throw Error('[CREDENTIAL_REENTRY_REQUIRED] Paste your Key again');};await assert.rejects(x.window.workstationDesktop[channel].read({base:'https://example.invalid/v1'}),e=>e.code==='CREDENTIAL_REENTRY_REQUIRED'&&e.message==='Paste your Key again');}assert.equal(x.calls.length,0);});
test('native vectors use a workspace store across changing browser origins',async()=>{const x=setup(),s=x.window.workstationDesktop.vectorIndex;await s.write('profile',[{id:'row'}],['old']);await s.load('profile');assert.equal(x.calls[0].command,'vector-index');assert.equal(x.calls[0].action,'write');assert.deepEqual(x.calls[0].removes,['old']);assert.equal(x.calls[1].action,'load');});
test('only preference allowlist persists; keys and workspace content never enter it',()=>{const x=setup();x.localStorage.setItem('workstation-api-key','synthetic');x.localStorage.setItem('workstation-state','private fixture');assert.equal(x.calls.length,0);x.localStorage.setItem('workstation-provider','openai-auth');assert.equal(x.calls[0].key,'workstation-provider');x.localStorage.removeItem('workstation-provider');assert.equal(x.calls[1].value,undefined)});

test('native startup restores explicit protocol and learned origins before settings configure without echoing writes',()=>{
 const learned=JSON.stringify({'https://fixture-one.invalid':'chat','https://fixture-two.invalid':'responses'});
 const x=setup({preferences:{'workstation-api-protocol':'chat','workstation-api-protocol-learned':learned,'workstation-api-key':'synthetic-excluded','workstation-state':'synthetic-excluded'}});
 assert.equal(x.localStorage.getItem('workstation-api-protocol'),'chat');
 assert.equal(x.localStorage.getItem('workstation-api-protocol-learned'),learned);
 assert.equal(x.localStorage.getItem('workstation-api-key'),null);
 assert.equal(x.localStorage.getItem('workstation-state'),null);
 assert.equal(x.calls.length,0);assert.equal(Object.hasOwn(x.window,'__nativePreferences'),false);
});

test('protocol preference changes and removal reach native once, while session storage stays local',()=>{
 const x=setup(),key='workstation-api-protocol',learnedKey='workstation-api-protocol-learned';
 for(const value of ['chat','responses','auto'])x.localStorage.setItem(key,value);
 const learned=JSON.stringify({'https://fixture.invalid':'chat'});x.localStorage.setItem(learnedKey,learned);
 x.localStorage.removeItem(key);x.localStorage.removeItem(learnedKey);
 assert.deepEqual(JSON.parse(JSON.stringify(x.calls)),[
  ...['chat','responses','auto'].map(value=>({command:'preferences',key,value})),
  {command:'preferences',key:learnedKey,value:learned},{command:'preferences',key},{command:'preferences',key:learnedKey}
 ]);
 const sessionStorage=new x.Storage();sessionStorage.setItem(key,'chat');sessionStorage.setItem(learnedKey,learned);sessionStorage.removeItem(key);
 assert.equal(x.calls.length,6);
});

test('independent webview instances retain both protocols through native JSON fixture roundtrip and honor removal',()=>{
 // The real bridge runs in fresh VMs; only the native JSON file boundary is simulated.
 let savedJSON='{}';
 const restart=()=>setup({preferences:JSON.parse(savedJSON),onPreferences:({key,value})=>{const stored=JSON.parse(savedJSON);if(value===undefined)delete stored[key];else stored[key]=value;savedJSON=JSON.stringify(stored);}});
 const first=restart(),learned=JSON.stringify({'https://fixture-one.invalid':'chat','https://fixture-two.invalid':'responses'});
 first.localStorage.setItem('workstation-api-protocol','chat');first.localStorage.setItem('workstation-api-protocol-learned',learned);
 const second=restart();assert.notEqual(first.localStorage,second.localStorage);assert.equal(second.calls.length,0);
 assert.equal(second.localStorage.getItem('workstation-api-protocol'),'chat');assert.equal(second.localStorage.getItem('workstation-api-protocol-learned'),learned);
 second.localStorage.removeItem('workstation-api-protocol');second.localStorage.removeItem('workstation-api-protocol-learned');
 const third=restart();assert.equal(third.localStorage.getItem('workstation-api-protocol'),null);assert.equal(third.localStorage.getItem('workstation-api-protocol-learned'),null);assert.equal(third.calls.length,0);
});

test('native receiver and desktop bridge allowlists agree on the exact nonsecret preferences',()=>{
 const bridge=fs.readFileSync('native/Resources/desktop.js','utf8'),native=fs.readFileSync('native/Sources/AIBro/NativeDesktop.swift','utf8');
 const jsKeys=vm.runInNewContext(bridge.match(/const keys=new Set\((\[[^\n]+\])\);/)[1]);
 const nativeKeys=JSON.parse(native.match(/static let preferenceKeys=Set\((\[[^\n]+\])\)/)[1]);
 const expected=['workstation-api-base','workstation-api-model','workstation-api-protocol','workstation-api-protocol-learned','workstation-openai-model','workstation-provider','aibro-embedding-settings-v1','ai-bro-language','workstation-ui'].sort();
 assert.deepEqual(Array.from(jsKeys).sort(),expected);assert.deepEqual(nativeKeys.sort(),expected);
});

test('explicit credential authorization is distinct from automatic reads and saves',async()=>{const x=setup(),a=x.window.workstationDesktop.apiCredentials,e=x.window.workstationDesktop.embeddingCredentials;await a.unlock({base:'https://example.invalid/v1'});await a.authorizeSave({base:'https://example.invalid/v1',token:'synthetic'});await e.authorizeRemove();await e.read({base:'https://example.invalid/v1'});assert.deepEqual(x.calls.map(c=>[c.channel,c.action]),[['api','unlock'],['api','authorizeSave'],['embedding','authorizeRemove'],['embedding','read']]);});
test('native credential errors preserve lock and cancellation codes without exposing transport markers',async()=>{const x=setup();x.window.webkit.messageHandlers.desktop.postMessage=async()=>{throw Error('[KEYCHAIN_LOCKED] Open settings to unlock');};await assert.rejects(x.window.workstationDesktop.apiCredentials.read({base:'https://example.invalid/v1'}),e=>e.code==='KEYCHAIN_LOCKED'&&e.message==='Open settings to unlock');x.window.webkit.messageHandlers.desktop.postMessage=async()=>{throw Error('[KEYCHAIN_CANCELLED] Cancelled');};await assert.rejects(x.window.workstationDesktop.embeddingCredentials.unlock({base:'https://example.invalid/v1'}),e=>e.code==='KEYCHAIN_CANCELLED');});
