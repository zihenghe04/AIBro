'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require.resolve('../app/connection-sync-settings.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ visible = false, hidden = false, following = false, request, connect, storage } = {}) {
  const observers = [], calls = [], mounts = [];
  const events = new EventTarget(), documentEvents = new EventTarget();
  const classes = new Set(visible ? ['view', 'active-view'] : ['view']);
  const settings = { classList: { contains: name => classes.has(name) }, children: [], append(node) { this.children.push(node); } };
  // The card only counts as on screen once the Sync page has moved it into .st-shell.
  const panel = { hidden, children: settings.children };
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Map(); observers.push(this); }
    observe(target, options) { assert.ok(target); this.targets.set(target, options); }
    disconnect() { this.targets.clear(); }
  }
  const doc = { getElementById: id => ({ settings })[id],
    createElement: () => ({ closest: selector => selector === '.st-shell' && !panel.hidden ? {} : null }), addEventListener: documentEvents.addEventListener.bind(documentEvents) };
  const context = vm.createContext({ document: doc, workstationDesktop: { connections: {} },
    localStorage: storage || { getItem: () => following ? JSON.stringify(typeof following === 'object' ? following : {serverOrigin:'https://sync.example.test',accountId:'fixture',apiFormat:'chat-completions'}) : null }, structuredClone, queueMicrotask, MutationObserver: Observer,
    addEventListener: events.addEventListener.bind(events),
    HalaskaUI: { mount(host, component, props) { const mount = { host, component, props }; mounts.push(mount); return { update(patch) { Object.assign(mount.props, patch); } }; } } });
  vm.runInContext(code, context);
  const notify = (target, attribute) => observers.forEach(observer => {
    if (observer.targets.get(target)?.attributeFilter.includes(attribute)) observer.callback([{ target, attributeName: attribute }]);
  });
  return { calls, mounts, panel, observers,
    init: () => context.ConnectionSyncSettings.init({ connect, request: async (path, payload) => { calls.push({ path, payload }); return request ? request(calls.length) : { supported: false }; } }),
    route(active, className = 'active-view') { if (active) classes.add(className); else classes.delete(className); notify(settings, 'class'); },
    hidden(value) { panel.hidden = value; notify(settings, 'class'); },
    ready() { documentEvents.dispatchEvent(new Event('aibro-agenda-changed')); },
    event(name) { events.dispatchEvent(new Event(name)); },
    pagehide() { events.dispatchEvent(new Event('pagehide')); },
  };
}
test('mount in the actual active-view settings route checks capability immediately and mounts once', async () => {
  const f = fixture({ visible: true }); f.init(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/__cloud/connections/capabilities');
  assert.equal(f.mounts[0].component, 'ConnectionSyncSettingsSurface');
  assert.equal(f.mounts[0].props.state.phase, 'unsupported');
  f.init(); await settle(); assert.equal(f.mounts.length, 1); assert.equal(f.calls.length, 1);
});
test('actual route entry refreshes once; leaving and unrelated class mutations do not refresh', async () => {
  const f = fixture(); f.init(); await settle(); assert.equal(f.calls.length, 0);
  f.route(true, 'active'); await settle(); assert.equal(f.calls.length, 0, 'old active class is not a visible view');
  f.route(true); await settle(); assert.equal(f.calls.length, 1);
  f.route(true, 'settings-sectioned'); await settle(); assert.equal(f.calls.length, 1);
  f.route(false); await settle(); assert.equal(f.calls.length, 1);
  f.route(true); await settle(); assert.equal(f.calls.length, 2);
});
test('sync tab hidden state combines with route visibility and returning to it refreshes', async () => {
  const f = fixture({ visible: true, hidden: true }); f.init(); await settle(); assert.equal(f.calls.length, 0);
  f.hidden(false); await settle(); assert.equal(f.calls.length, 1);
  f.hidden(true); await settle(); assert.equal(f.calls.length, 1);
  f.route(false); f.hidden(false); await settle(); assert.equal(f.calls.length, 1, 'revealing a tab in an inactive page does not connect');
  f.route(true); await settle(); assert.equal(f.calls.length, 2);
});
test('pagehide disconnects visibility observers and does not resurrect a disposed controller', async () => {
  const f = fixture(); f.init(); f.pagehide(); f.route(true); f.hidden(false); await settle();
  assert.equal(f.calls.length, 0); assert.ok(f.observers.every(observer => observer.targets.size === 0));
});

const stale = () => Object.assign(Error('synthetic pre-ready lease'), { code: 'STALE_SESSION' });
test('native ready retries a visible failed first check without requiring API following', async () => {
  const f = fixture({ visible:true, request:n=>({supported:n===1}), connect:async()=>{throw stale();} });
  f.init(); await settle(); assert.equal(f.mounts[0].props.state.phase,'disconnected');
  f.ready(); await settle(); assert.equal(f.calls.length,2); assert.equal(f.mounts[0].props.state.phase,'unsupported');
  f.ready(); await settle(); assert.equal(f.calls.length,2,'the one-shot readiness check is not an agenda polling loop');
});
for (const following of [false,true]) test(`native ready during an in-flight stale failure retains one fresh check (following=${following})`, async () => {
  let reject; const pending = new Promise((_resolve,r)=>{reject=r;});
  const f=fixture({visible:true,following,request:n=>({supported:n===1}),connect:()=>pending});
  f.init(); await settle(); assert.equal(f.mounts[0].props.state.busy,true);
  f.ready(); f.ready(); await settle(); assert.equal(f.calls.length,1,'ready does not overlap an existing operation');
  reject(stale()); await settle(); assert.equal(f.calls.length,2); assert.equal(f.mounts[0].props.state.phase,'unsupported');
  await settle(); assert.equal(f.calls.length,2,'a second failure must not poll indefinitely');
});
test('native ready does not connect a hidden sync tab or inactive page without following', async () => {
  for (const options of [{visible:false},{visible:true,hidden:true}]) {
    const f=fixture(options); f.init(); f.ready(); await settle(); assert.equal(f.calls.length,0);
    f.route(true); f.hidden(false); await settle(); assert.equal(f.calls.length,1);
  }
});
test('pagehide cancels a pending ready check instead of reviving the old controller', async () => {
  let reject;const pending=new Promise((_resolve,r)=>{reject=r;});
  const f=fixture({visible:true,request:()=>({supported:true}),connect:()=>pending});
  f.init(); await settle(); f.ready(); f.pagehide(); reject(stale()); await settle(); assert.equal(f.calls.length,1);
});
test('a ready follow-up after session loss uses a fresh check and never revives the old adapter', async () => {
  let reject, disposed=0, connects=0;
  const firstRead=new Promise((_resolve,r)=>{reject=r;});
  const f=fixture({visible:true,following:true,
    request:n=>{if(n===1)return {supported:true};throw Object.assign(Error(),{code:'AUTH_REQUIRED'});},
    connect:async()=>{connects++;return {dispose(){disposed++;},client:{pairingInfo:()=>firstRead}};}});
  f.init();await settle();f.ready();reject(stale());await settle();
  assert.equal(f.calls.length,2);assert.equal(connects,1);assert.equal(disposed,1);
  const state=f.mounts[0].props.state;assert.equal(state.phase,'disconnected');assert.equal(state.preview,null);
  assert.equal(state.pairingCode,'');assert.equal(state.profiles.length,0);assert.equal(state.following,false);
  await settle();assert.equal(f.calls.length,2,'a failed fresh auth check is final until another user or lifecycle action');
});

test('saved credential events follow only their explicitly opted-in purpose; focus checks either purpose',async()=>{
  for (const purpose of ['chat','speech']) {
    const following={serverOrigin:'https://sync.example.test',accountId:'fixture',...(purpose==='chat'?{apiFormat:'chat-completions'}:{speech:true})};
    const f=fixture({following});f.init();await settle();const count=f.calls.length;
    f.event(purpose==='chat'?'aibro-speech-credentials-saved':'aibro-api-credentials-saved');await settle();assert.equal(f.calls.length,count);
    f.event(purpose==='chat'?'aibro-api-credentials-saved':'aibro-speech-credentials-saved');await settle();assert.equal(f.calls.length,count+1);
    f.event('focus');await settle();assert.equal(f.calls.length,count+2);
  }
});

for(const event of ['aibro-api-credentials-saved','aibro-speech-credentials-saved','focus'])test(`first publish receives the real ${event} event before follow exists`,async()=>{
  const purpose=event==='aibro-speech-credentials-saved'?'speech':'chat',data=new Map(),sent=[];
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  let saved={format:'aibro.connection-profile.v1',purpose,provider:'openai-compatible',authKind:'api-key',apiFormat:purpose==='speech'?'audio-transcriptions':'chat-completions',baseUrl:'https://api.example.test/v1',model:'before',apiKey:'synthetic-only'},profiles={};
  let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const client={pairingInfo:async()=>({}),ownerState:async()=>({devices:[]}),saveProfiles:async changes=>{
    sent.push(structuredClone(changes));if(sent.length===1){entered();await held;}
    for(const item of changes)profiles[item.profileId]=structuredClone(item.profile);
  }};
  const exportSaved=async()=>({profile:structuredClone(saved),sourceDigest:saved.model});
  const f=fixture({visible:true,storage,request:()=>({supported:true}),connect:async()=>({client,binding:{serverOrigin:'https://sync.example.test',accountId:'fixture'},dispose(){},activeProfiles:async()=>structuredClone(profiles),pairingCode:async()=>'',exportSavedAPI:exportSaved,exportSavedSpeech:exportSaved,verifySavedAPI:async()=>{},verifySavedSpeech:async()=>{}})});
  f.init();await settle();const props=f.mounts[0].props;props.onProtocol('chat-completions');props.onPurpose('chat',purpose==='chat');props.onPurpose('speech',purpose==='speech');
  await props.onPreview();const publishing=props.onPublish();await started;
  saved={...saved,model:'after'};f.event(event);await settle();assert.equal(sent.length,1);assert.equal(storage.getItem('aibro-connection-export-v1'),null);
  release();await publishing;await settle();assert.equal(sent.length,2);assert.equal(sent[1][0].profile.model,'after');f.pagehide();
});
