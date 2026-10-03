const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto, randomUUID} = require('node:crypto');
const Core = require('../app/workstation-core.js');
const CitationEvidence = require('../app/citation-evidence.js');
const ContentLifecycle = require('../app/content-lifecycle.js');
const source = fs.readFileSync(require.resolve('../native/Resources/quick-links.js'),'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const rid = () => 'quick_link_' + randomUUID();
const create = (patch={}) => ({action:'add',requestId:rid(),url:'https://example.org/paper?q=1#methods',title:'Transit study',folder:'Research',workspace:'科研',projectId:'p',...patch});
function fixture(options={}) {
  const calls={save:0,events:0,network:0};
  const state=options.state || {imports:[],notes:[],tasks:[],papers:[],links:[],trash:[],attachments:[],agentRuns:[],conversations:[],projects:[{id:'p',name:'Research project',workspace:'科研'}],ui:{composerDraft:'keep me'},currentConversationId:'existing'};
  const context={state,storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class {constructor(type,detail){this.type=type;this.detail=detail;}},
    document:{dispatchEvent(){calls.events++;}},
    saveDocumentDurably:async()=>{calls.save++; return options.save ? options.save(context,calls) : true;},
    fetch:()=>{calls.network++; throw Error('No network allowed');}};
  context.window={crypto:webcrypto,WorkstationCore:Core,CitationEvidence,ContentLifecycle,PrivateMode:{isOn:()=>!!context.privateMode}};
  vm.runInNewContext(source,context);
  return {state,context,calls,request:payload=>context.window.NativeQuickLinks.request(payload)};
}
async function list(f) { return copy(await f.request({action:'list'})); }
async function update(f,id,patch,other={}) { const row=(await list(f)).rows.find(row=>row.id===id); return f.request({action:'update',requestId:rid(),items:[{id,expectedVersion:row.version,patch}],...other}); }

test('offline link saves into real imports with exact scope; does not fetch, navigate, alter composer or claim original bytes',async()=>{
  const f=fixture(), input=create(); const result=await f.request(input);
  assert.equal(result.status,'saved'); assert.equal(result.ids[0],input.requestId); assert.equal(f.state.imports.length,1);
  const row=f.state.imports[0]; assert.equal(row.url,input.url); assert.equal(row.projectId,'p'); assert.equal(row.workspace,'科研'); assert.equal(row.fileStored,false); assert.equal(row.parser,'bookmark');
  assert.equal(f.state.ui.composerDraft,'keep me'); assert.equal(f.state.currentConversationId,'existing'); assert.equal(f.calls.network,0); assert.equal(f.calls.events,1);
});
test('dedup normalizes host/default port/root slash within destination; query and fragment remain meaningful',async()=>{
  const f=fixture(); const one=await f.request(create({url:'HTTPS://EXAMPLE.ORG:443'}));
  const dup=await f.request(create({url:'https://example.org/'})); assert.equal(dup.duplicate,true); assert.deepEqual(copy(dup.ids),copy(one.ids));
  await f.request(create({url:'https://example.org/?paper=1'})); await f.request(create({url:'https://example.org/#section'}));
  await f.request(create({url:'https://example.org/',projectId:null})); assert.equal(f.state.imports.length,4);
});
test('existing webpage sources appear and title/folder/project updates preserve original content and same identity',async()=>{
  const f=fixture(); f.state.imports.push({id:'existing',name:'An existing web source',url:'https://example.org/source',content:'Saved original text',fileStored:true,projectId:'p',workspace:'科研',folderPath:'原始资料'});
  assert.equal((await list(f)).rows[0].hasContent,true);
  assert.equal((await update(f,'existing',{title:'My title',folder:'Methods',workspace:'日常',projectId:null})).status,'saved');
  assert.equal(f.state.imports[0].content,'Saved original text'); assert.equal(f.state.imports[0].name,'My title'); assert.equal(f.state.imports[0].projectId,null);
});
test('rejects script/file/data URLs, credentials, control characters and malformed inputs without mutation',async()=>{
  const f=fixture(); for(const url of ['javascript:alert(1)','file:///tmp/key','data:text/plain,x','https://a:b@example.org/','https://example.org/a\nb','https://']) {
    assert.equal((await f.request(create({url}))).reason,'invalid',url);
  }
  assert.equal(f.state.imports.length,0); assert.equal(f.calls.save,0);
});
test('local HTTP links can be bookmarked but never trigger a network request',async()=>{
  const f=fixture(); assert.equal((await f.request(create({url:'http://127.0.0.1:18940'}))).status,'saved'); assert.equal(f.calls.network,0);
});
test('private or ambiguously owned sources never project/search/open or mutate',async()=>{
  const f=fixture(); const input=create(); await f.request(input); const row=f.state.imports[0];
  f.state.projects[0].private=true;
  assert.equal((await list(f)).rows.length,0); assert.equal((await f.request({action:'open',id:row.id})).reason,'private');
  assert.equal((await f.request(input)).reason,'private');
  delete f.state.projects[0].private; f.state.projects.push({...f.state.projects[0]}); assert.equal((await list(f)).rows.length,0);
});
test('private duplicate is neither revealed nor aliased when adding a public bookmark',async()=>{
  const f=fixture(); await f.request(create()); f.state.imports[0].private=true;
  const r=await f.request(create()); assert.equal(r.status,'saved'); assert.equal(r.duplicate,false); assert.equal((await list(f)).rows.length,1);
});
test('search checks URL, title, folder and project, without exposing private titles',async()=>{
  const f=fixture(); await f.request(create());
  for(const query of ['study','example.org','Research']) assert.equal((await f.request({action:'list',query})).rows.length,1);
  f.state.imports[0].private=true; assert.equal((await f.request({action:'list',query:'study'})).rows.length,0);
});
test('changed version aborts an entire multi-link update before any member is edited',async()=>{
  const f=fixture(); await f.request(create()); await f.request(create({url:'https://example.org/two'})); const snapshot=await list(f);
  f.state.imports[1].name='Changed by user'; const before=copy(f.state.imports);
  const r=await f.request({action:'update',requestId:rid(),items:snapshot.rows.map(row=>({id:row.id,expectedVersion:row.version,patch:{folder:'New group'}}))});
  assert.equal(r.reason,'changed'); assert.deepEqual(copy(f.state.imports),before);
});
test('invalid destination or mixed invalid patches abort before mutation',async()=>{
  const f=fixture(); await f.request(create()); const row=(await list(f)).rows[0], before=copy(f.state.imports);
  assert.equal((await f.request({action:'update',requestId:rid(),items:[{id:row.id,expectedVersion:row.version,patch:{workspace:'日常',projectId:'p'}}]})).reason,'changed');
  assert.equal((await update(f,row.id,{url:'https://evil.org'})).reason,'invalid'); assert.deepEqual(copy(f.state.imports),before);
});
test('same request after failed/lost ACK reuses identity across bridge restart and does not overwrite later edits',async()=>{
  let durable; const f=fixture({save:ctx=>{durable=copy(ctx.state); throw Error('Lost ACK');}}), input=create();
  assert.equal((await f.request(input)).reason,'storage_failed'); const next=fixture({state:durable}); next.state.imports[0].name='Human title';
  const reordered=Object.fromEntries(Object.entries(input).reverse()); assert.equal((await next.request(reordered)).status,'saved');
  assert.equal(next.state.imports.length,1); assert.equal(next.state.imports[0].name,'Human title');
  assert.equal((await next.request({...input,title:'different payload'})).reason,'collision');
});
test('update retry after ACK loss is idempotent and preserves later content edits',async()=>{
  const f=fixture(); const input=create(); await f.request(input); const row=(await list(f)).rows[0];
  const command={action:'update',requestId:rid(),items:[{id:row.id,expectedVersion:row.version,patch:{title:'New'}}]};
  const r=await f.request(command); assert.equal(r.status,'saved'); f.state.imports[0].name='Later';
  assert.equal((await f.request(command)).status,'saved'); assert.equal(f.state.imports[0].name,'Later');
});
test('remove/restore uses main ContentLifecycle and keeps source memberships, links, current streaming message identities intact',async()=>{
  const f=fixture(), input=create(); await f.request(input); const row=(await list(f)).rows[0];
  const message={id:'m',live:true,text:'streaming'}, conversation={id:'c',attachments:[row.id],messages:[message],draft:'keep'};
  f.state.conversations.push(conversation); f.state.attachments.push({id:row.id,conversationId:'c'}); f.state.notes.push({id:'derived',content:'keep derived',sourceAttachmentIds:[row.id]});
  f.state.links.push({id:'edge',sourceId:row.id,sourceType:'import',targetId:'derived',targetType:'note'});
  const remove={action:'remove',requestId:rid(),items:[{id:row.id,expectedVersion:row.version}]};
  const deleted=await f.request(remove); assert.equal(deleted.status,'saved'); assert.equal(f.state.imports.length,0); assert.equal(f.state.links.length,0);
  assert.equal(f.state.conversations[0],conversation); assert.equal(f.state.conversations[0].messages[0],message); assert.equal(f.state.notes[0].content,'keep derived');
  assert.equal(f.state.conversations[0].attachments.length,0); assert.equal(f.state.trash[0].type,'content');
  const entry=(await list(f)).trash[0]; const restored=await f.request({action:'restore',requestId:rid(),trashId:entry.id,expectedVersion:entry.version});
  assert.equal(restored.status,'saved'); assert.equal(f.state.imports[0].id,row.id); assert.equal(f.state.links[0].id,'edge'); assert.equal(f.state.conversations[0].attachments[0],row.id); assert.equal(f.state.conversations[0],conversation);
  assert.equal((await f.request(remove)).reason,'removed'); assert.equal(f.state.imports.length,1);
});
test('remove retry after failure does not re-delete a new copy; restore retry does not resurrect after subsequent purge',async()=>{
  const f=fixture(); await f.request(create()); const row=(await list(f)).rows[0];
  await f.request({action:'remove',requestId:rid(),items:[{id:row.id,expectedVersion:row.version}]});
  const entry=(await list(f)).trash[0], command={action:'restore',requestId:rid(),trashId:entry.id,expectedVersion:entry.version};
  await f.request(command); f.state.imports=[]; assert.equal((await f.request(command)).reason,'removed'); assert.equal(f.state.imports.length,0);
});
test('trashed links inherit newly private original project and are hidden from restore UI',async()=>{
  const f=fixture(); await f.request(create()); const row=(await list(f)).rows[0];
  await f.request({action:'remove',requestId:rid(),items:[{id:row.id,expectedVersion:row.version}]});
  const entry=(await list(f)).trash[0]; f.state.projects[0].private=true;
  assert.equal((await list(f)).trash.length,0); assert.equal((await f.request({action:'restore',requestId:rid(),trashId:entry.id,expectedVersion:entry.version})).reason,'removed');
});
test('restore validates whole entry and refuses collisions without partial resurrection',async()=>{
  const f=fixture(); await f.request(create()); await f.request(create({url:'https://example.org/two'})); const rows=(await list(f)).rows;
  await f.request({action:'remove',requestId:rid(),items:rows.map(row=>({id:row.id,expectedVersion:row.version}))});
  const entry=(await list(f)).trash[0]; f.state.imports.push({id:rows[0].id,name:'Other',url:'https://example.org/other'});
  assert.equal((await f.request({action:'restore',requestId:rid(),trashId:entry.id,expectedVersion:entry.version})).reason,'collision'); assert.equal(f.state.imports.length,1); assert.equal(f.state.trash.length,1);
});
test('private mode, hydration, conflicts and purge busy refuse reads and writes',async()=>{
  for(const change of [ctx=>ctx.privateMode=true,ctx=>ctx.storageHydrated=false,ctx=>ctx.serverConflict=true,ctx=>ctx.purgeTrash.busy=true]) {
    const f=fixture(); change(f.context); assert.equal((await list(f)).rows.length,0); assert.notEqual((await f.request(create())).status,'saved'); assert.equal(f.calls.save,0);
  }
});
test('owner replacement during persistence never receives a false successful acknowledgement',async()=>{
  const f=fixture({save:ctx=>{ctx.state=copy(ctx.state);return true;}});
  assert.equal((await f.request(create())).reason,'changed'); assert.equal(f.calls.events,0);
});
test('late privacy change during durable save prevents payload being returned as saved',async()=>{
  const f=fixture({save:ctx=>{ctx.state.projects[0].private=true;return true;}});
  assert.equal((await f.request(create())).reason,'private'); assert.equal((await list(f)).rows.length,0);
});
test('only one mutation is in flight and exact duplicate joins the same promise',async()=>{
  let resolve, started; const began=new Promise(done=>started=done), gate=new Promise(done=>resolve=done);
  const f=fixture({save:()=>{started();return gate;}}), input=create();
  const one=f.request(input), same=f.request(input); assert.equal(one,same); await began;
  assert.equal((await f.request(create({url:'https://example.org/other'}))).reason,'busy'); resolve(true); assert.equal((await one).status,'saved'); assert.equal(f.state.imports.length,1);
});
test('a replaced record with the same ID cannot impersonate a previously committed link',async()=>{
  const f=fixture(), command=create(); await f.request(command);
  const replacement={...f.state.imports[0]}; delete replacement.quickLinkIdentity; f.state.imports=[replacement];
  assert.equal((await f.request(command)).reason,'collision');
});
