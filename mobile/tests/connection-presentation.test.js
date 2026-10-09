import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {connectionSelectionView, paintConnectionSelection, revealSettingsTarget} from '../src/connection-presentation.js';
import {createConnectionManager} from '../src/connection-sync.js';
import {Store,MemoryAdapter} from '../src/store.js';

const binding={base:'https://sync.example.test/subpath',accountID:'synthetic-account'};
const selection={serverOrigin:'https://sync.example.test',accountId:'synthetic-account',profileId:'chat'};
const settings={connectionProfiles:{chat:selection}};
const profile={id:'chat',purpose:'chat',model:'合成对话模型',supported:true};
const view=(state,config=settings,b=binding)=>connectionSelectionView({profiles:[],...state},config,b);

test('synced chat distinguishes removal, revocation, binding change and unsupported interface without borrowing speech status',()=>{
  assert.match(view({stage:'ready'}).detail,/停止共享/);
  assert.match(view({stage:'ready',profiles:[profile]}, {...settings,connectionBlocked:selection}).label,/未授权/);
  assert.match(view({stage:'ready',profiles:[profile]},settings,{...binding,accountID:'another'}).label,/需连接/);
  assert.match(view({stage:'ready',profiles:[{...profile,supported:false,limitation:'不支持此接口'}]}).detail,/不支持此接口/);
  assert.equal(view({stage:'ready',profiles:[profile,{id:'speech',purpose:'speech',supported:false}]}).state,'available');
  assert.equal(view({stage:'blocked'}, {model:{model:'手动模型'},connectionProfiles:{speech:selection}}).target,'#model-form');
  for(const stage of ['blocked','ready','disconnected','pending','error']) assert.equal(view({stage}).target,'#connection-sync-root');
});

test('production manager cached resolve remains usable on network failure; removal and auth failure are unavailable',async()=>{
  const store=await new Store(new MemoryAdapter()).load();
  await store.tx(s=>{s.binding=binding;s.settings=structuredClone(settings);});
  let failure=null,profiles={chat:{format:'aibro.connection-profile.v1',purpose:'chat',provider:'openai-compatible',authKind:'api-key',apiFormat:'chat-completions',baseUrl:'https://provider.example.test/v1',model:'合成模型',apiKey:'public-synthetic-only'}};
  const manager=createConnectionManager({store,vault:{get:async()=> 'synthetic-session'},native:true,
    createTransport:async()=>({capabilities:async()=>{if(failure)throw Object.assign(Error('synthetic'),{code:failure});return true;},activeProfiles:async()=>structuredClone(profiles),client:{pairingInfo:async()=>({ownerFingerprint:'owner',deviceId:'phone'}),pull:async()=>({ownerFingerprint:'owner',deviceId:'phone'})}})});
  const current=()=>connectionSelectionView(manager.snapshot(),store.state.settings,store.state.binding);
  await manager.refresh();assert.equal(current().state,'available');
  failure='NETWORK';await assert.rejects(manager.refresh());
  assert.equal((await manager.resolve('chat')).profile.model,'合成模型');
  assert.equal(current().state,'available');assert.match(current().detail,/本机已有/);
  failure=null;profiles={};await manager.refresh();await assert.rejects(manager.resolve('chat'),/移除/);
  assert.match(current().label,/已移除/);
  failure='FORBIDDEN';await assert.rejects(manager.refresh());await assert.rejects(manager.resolve('chat'));
  assert.match(current().label,/未授权/);
});

test('network failure before a public profile read is uncertain, never a claim that cached credentials were erased',()=>{
  const result=view({stage:'error'});assert.equal(result.state,'pending');assert.match(result.detail,/不会因网络中断而清除/);
});

test('in-place chip update never touches the composing textarea, focus or selection',()=>{
  const textarea={value:'正在输入🙂',selectionStart:4,selectionEnd:4};
  const chip={dataset:{},setAttribute(k,v){this[k]=v;}},hint={};
  const document={activeElement:textarea,querySelector:q=>q==='[data-action="model-settings"]'?chip:q==='[data-model-connection-hint]'?hint:assert.fail('must not query/replace composer')};
  const before=structuredClone(textarea);paintConnectionSelection(document,view({stage:'blocked'}));
  assert.equal(chip.dataset.connectionState,'unavailable');assert.match(chip.textContent,/未授权/);
  assert.equal(hint.hidden,false);assert.deepEqual(textarea,before);assert.equal(document.activeElement,textarea);
});

const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function navigationFixture() {
  let release;const gate=new Promise(r=>release=r),scrolls=[];
  const details={tagName:'DETAILS',open:false,parentElement:null};
  const root={parentElement:null,scrollIntoView:()=>scrolls.push('sync')},form={parentElement:details,scrollIntoView:()=>scrolls.push('manual')};
  const document={querySelector:q=>q==='#connection-sync-root'?root:q==='#model-form'?form:null};
  const helper=main.slice(main.indexOf('async function openSettingsSection('),main.indexOf('\nconst sessions ='));
  assert.ok(helper.includes('revealSettingsTarget'));
  const handler=main.match(/"model-settings": (.+),\n/)[1];
  const run=new Function('document','revealSettingsTarget','gate',`
    let tab='chat',navigationRevision=0,connectionSettingsMount=gate,choice='#connection-sync-root';
    const requestAnimationFrame=fn=>fn(),navigatePage=t=>{tab=t;navigationRevision++},modelConnectionView=()=>({target:choice});
    ${helper}
    return {click:${handler},manual:()=>choice='#model-form',leave:()=>navigatePage('today')};
  `)(document,revealSettingsTarget,gate);
  return {...run,release,scrolls,details};
}
test('actual model handler waits for its Kit island and opens synced destination; manual remains explicit',async()=>{
  const n=navigationFixture(),pending=n.click();assert.deepEqual(n.scrolls,[]);n.release();await pending;assert.deepEqual(n.scrolls,['sync']);
  n.manual();await n.click();assert.deepEqual(n.scrolls,['sync','manual']);assert.equal(n.details.open,true);
});
test('actual late settings island never scrolls a different page after navigation',async()=>{
  const n=navigationFixture(),pending=n.click();n.leave();n.release();await pending;assert.deepEqual(n.scrolls,[]);
});
