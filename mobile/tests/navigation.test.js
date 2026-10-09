import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NavigationMemory, captureConversationPosition, conversationScrollTarget } from '../src/navigation.js';
import { Store, MemoryAdapter, putRecord } from '../src/store.js';

test('sheet history keeps read-only identities and positions without replaying form actions', () => {
  const n = new NavigationMemory();
  n.openSheet({ kind: 'projects', id: 'p', ignored: 'no record snapshots' });
  n.openSheet({ kind: 'tasks', id: 't' }, 250);
  n.openSheet({ kind: 'tasks', id: 't' }, 100); // Same editor refresh is not another level.
  n.openSheet(null, 80); // A review is transient; return opens the task, never approval.
  assert.deepEqual(n.backSheet(), { destination: { kind: 'tasks', id: 't' }, scrollTop: 80 });
  n.openSheet({ kind: 'tasks', id: 't' });
  assert.deepEqual(n.backSheet(), { destination: { kind: 'projects', id: 'p' }, scrollTop: 250 });
  assert.equal(n.backSheet(), null);
  assert.throws(() => n.openSheet({ kind: 'apply-plan', id: 'write' }), /标识无效/);
  n.clearSheets(); assert.equal(n.hasParentSheet, false);
});

test('conversation positions prefer wire-key anchors and fall back to saved scroll on removal', () => {
  const node = (key, id, top, bottom) => ({ dataset: { messageKey: key, message: id }, getBoundingClientRect: () => ({ top, bottom }) });
  const document = { querySelectorAll: () => [node('messages:old', 'same', -100, -1), node('messages:real', 'same', -20, 120)] };
  const n = new NavigationMemory(), position = captureConversationPosition(document, 500);
  n.rememberConversation('c', position); position.y = 1;
  const shifted = { querySelectorAll: () => [node('messages:other', 'same', 0, 200), node('messages:real', 'same', 100, 240)] };
  assert.equal(conversationScrollTarget(shifted, n.conversation('c'), 40), 160);
  assert.equal(conversationScrollTarget({ querySelectorAll: () => [] }, n.conversation('c')), 500);
  assert.equal(conversationScrollTarget(document, null), 0);
});

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const helpers = main.slice(main.indexOf('async function preserveSheetDraftForNavigation()'), main.indexOf('\nfunction countConflicts()'));
const create = main.slice(main.indexOf('function openConversation('), main.indexOf('\nasync function submitChatText('));
async function runtime({ open = false, guard = async () => true } = {}) {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put('conversations', { id: 'old', title: '原会话' });
  const original = store.tx.bind(store); let release;
  const held = new Promise(resolve => release = resolve);
  store.tx = async fn => { await held; return original(fn); };
  const run = new Function('store', 'putRecord', 'NavigationMemory', 'retainSheetFormDraft', 'open', `
    let navigationRevision=0,tab='chat',currentConversation='old',currentProject=null,selectedRefs=new Set(),homeDraftRevision=0,homeDraft='';
    const navigation=new NavigationMemory(),refsByConversation=new Map(),voiceDialog={open:false},voice={},native=true;
    const sheet={open,querySelector:()=>null,close(){this.open=false}},taskSaving=false,editorSaving=false,planReviewBusy=false,syncGroupBusy=false;
    const createConversationContext=()=>({version:1,keys:[],source:null}),restoreConversationContext=()=>({keys:[]});
    const id=()=> 'new_synthetic',render=()=>{},error=e=>{throw e},App={minimizeApp(){}};
    ${helpers}
    ${create}
    return {create:()=>newChat(),back:navigateBack,close:()=>closeSheetNavigation({all:true}),url:openAppURL,state:()=>({navigationRevision,tab,currentConversation,sheetOpen:sheet.open})};
  `)(store, putRecord, NavigationMemory, guard, open);
  return { ...run, release, store };
}

for (const action of ['back', 'deeplink']) test(`actual ${action} callback invalidates an in-flight newChat navigation`, async () => {
  const r = await runtime();
  const pending = r.create();
  if (action === 'back') await r.back(); else await r.url({ url: 'aibro://today' });
  const destination = r.state();
  r.release(); await pending;
  assert.equal(r.store.list('conversations').length, 2, 'authorized creation is still durable');
  assert.deepEqual(r.state(), destination, 'completion never hijacks the page left by Back/deep link');
});

test('actual Back and explicit Close keep sheet open if draft guard refuses or durable retention fails', async () => {
  for (const action of ['back', 'close']) for (const guard of [async () => false, async () => { throw Error('synthetic draft write failed'); }]) {
    const r = await runtime({ open: true, guard });
    try { await r[action](); } catch (e) { assert.match(e.message, /draft write failed/); }
    assert.equal(r.state().sheetOpen, true);
    assert.equal(r.state().currentConversation, 'old');
  }
});
