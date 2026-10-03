'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const V=require('../app/vector-index');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(overrides={}){
  const nodes=new Map(),calls=[],stored=new Map(),props=new Map();let embed;
  function element(id=''){
    const node={id,value:'',checked:false,hidden:false,disabled:false,textContent:'',handlers:{},append(child){nodes.set(child.id,child);},querySelectorAll(selector){return selector==='input'?[...nodes.values()].filter(x=>x.id.startsWith('embedding')&&/Base|Model|Key$|Dimensions|Enabled|Auto$|NoKey/.test(x.id)):[];},addEventListener(name,fn){this.handlers[name]=fn;}};
    Object.defineProperty(node,'innerHTML',{set(html){for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)){const child=element(match[1]);child.hidden=/\bhidden(?:\s|>)/.test(match[0]);nodes.set(match[1],child);}}});return node;
  }
  nodes.set('settings',element('settings'));
  const api={status:async()=>{calls.push('status');return {hasKey:true};},read:async()=>{calls.push('read');return {base:'https://example.invalid/v1/embeddings',token:'synthetic'};},unlock:async()=>{calls.push('unlock');return {hasKey:true,requiresUnlock:false};},save:async()=>calls.push('save'),authorizeSave:async()=>calls.push('authorizeSave'),remove:async()=>calls.push('remove'),authorizeRemove:async()=>calls.push('authorizeRemove'),...overrides};
  const context={document:{getElementById:id=>nodes.get(id)||null,createElement:()=>element()},localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},VectorIndex:{configuration:V.configuration,validate:V.validate,create:options=>{embed=options.embed;return {status:async()=>({total:0,ready:0,pending:0}),update:async cfg=>{await embed(cfg,['synthetic excerpt']);return {total:1,ready:1,pending:0};}};}},workstationDesktop:{embeddingCredentials:api,vectorIndex:{}},HalaskaUI:{mount(host,_name,initial){const button=element(initial.id);nodes.set(button.id,button);props.set(button.id,{...initial});button.onclick=()=>props.get(button.id).onClick();return {update(next){Object.assign(props.get(button.id),next);button.disabled=next.disabled;}};}},AbortController,setTimeout:()=>0,clearTimeout(){},fetch:async()=>{calls.push('fetch');return {ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]})};}};
  vm.runInNewContext(fs.readFileSync('app/vector-knowledge-ui.js','utf8'),context);context.VectorKnowledge.init({getState:()=>({}),isBusy:()=>false});
  nodes.get('embeddingBase').value='https://example.invalid/v1';nodes.get('embeddingModel').value='synthetic-model';
  return {context,nodes,calls,stored,props,api,async click(id){nodes.get(id).onclick();await settle();}};
}
test('encrypted-file embedding store has no unlock button and only uses ordinary save/remove',async()=>{
 const f=fixture({storageBackend:'encrypted-file',authorizeSave:async()=>{throw Error('Keychain not allowed');},authorizeRemove:async()=>{throw Error('Keychain not allowed');}});
 assert.equal(f.nodes.get('embeddingUnlockHost').hidden,true);assert.equal(f.nodes.has('embeddingUnlockKey'),false);
 assert.match(f.nodes.get('embeddingKeyHelp').textContent,/无需钥匙串密码/);
 f.nodes.get('embeddingKey').value='file-fixture';await f.click('embeddingSave');await f.click('embeddingClearKey');
 assert.deepEqual(f.calls,['save','status','remove']);assert.ok([...f.stored.values()].every(v=>!v.includes('file-fixture')));
});
test('embedding explicit unlock preserves unsaved key and uses the Kit button',async()=>{
 const f=fixture();f.nodes.get('embeddingKey').value='unsaved-synthetic';assert.equal(f.nodes.get('embeddingUnlockHost').hidden,false);
 await f.click('embeddingUnlockKey');assert.deepEqual(f.calls,['unlock']);assert.equal(f.nodes.get('embeddingKey').value,'unsaved-synthetic');assert.match(f.nodes.get('embeddingStatus').textContent,/已解锁/);assert.equal(f.stored.size,0);
});
test('embedding normal connection test remains silent and reports a locked key without retrying unlock',async()=>{
 const f=fixture({read:async()=>{f.calls.push('read');throw Object.assign(Error('请在设置中解锁已保存的 Key'),{code:'KEYCHAIN_LOCKED'});}});
 await f.click('embeddingTest');assert.deepEqual(f.calls,['status','read']);assert.match(f.nodes.get('embeddingStatus').textContent,/设置中解锁/);assert.equal(f.nodes.get('embeddingTest').disabled,false);
});
test('embedding unlock cancellation is not retried and leaves the supplied form untouched',async()=>{
 const f=fixture({unlock:async()=>{f.calls.push('unlock');throw Object.assign(Error('已取消钥匙串授权'),{code:'KEYCHAIN_CANCELLED'});}});f.nodes.get('embeddingKey').value='unsaved';
 await f.click('embeddingUnlockKey');await settle();assert.deepEqual(f.calls,['unlock']);assert.equal(f.nodes.get('embeddingKey').value,'unsaved');assert.match(f.nodes.get('embeddingStatus').textContent,/已取消/);assert.equal(f.nodes.get('embeddingUnlockKey').disabled,false);
});
test('embedding explicit save and remove use authorized actions while preserving the legacy bridge fallback',async()=>{
 const f=fixture();f.nodes.get('embeddingKey').value='synthetic-new';await f.click('embeddingSave');await f.click('embeddingClearKey');assert.deepEqual(f.calls,['authorizeSave','status','authorizeRemove']);assert.equal(f.nodes.get('embeddingKey').value,'');assert.ok([...f.stored.values()].every(value=>!value.includes('synthetic-new')));
 const old=fixture({unlock:undefined,authorizeSave:undefined,authorizeRemove:undefined});old.nodes.get('embeddingKey').value='synthetic';await old.click('embeddingSave');await old.click('embeddingClearKey');assert.deepEqual(old.calls,['save','status','remove']);assert.equal(old.nodes.get('embeddingUnlockHost').hidden,true);
});
test('embedding pending authorization blocks duplicate unlock, test, save and delete operations',async()=>{
 let resolve;const pending=new Promise(done=>{resolve=done;});const f=fixture({unlock:async()=>{f.calls.push('unlock');return pending;}});
 f.nodes.get('embeddingUnlockKey').onclick();f.nodes.get('embeddingUnlockKey').onclick();f.nodes.get('embeddingSave').onclick();f.nodes.get('embeddingTest').onclick();f.nodes.get('embeddingClearKey').onclick();assert.deepEqual(f.calls,['unlock']);assert.equal(f.nodes.get('embeddingTest').disabled,true);
 resolve({hasKey:true,requiresUnlock:false});await settle();assert.equal(f.nodes.get('embeddingTest').disabled,false);
});
