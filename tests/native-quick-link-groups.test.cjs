const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,randomUUID}=require('node:crypto');
const Core=require('../app/workstation-core.js'),CitationEvidence=require('../app/citation-evidence.js'),ContentLifecycle=require('../app/content-lifecycle.js');
const Library=require('../app/project-library.js');
const source=fs.readFileSync(require.resolve('../native/Resources/quick-links.js'),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value)),rid=()=> 'quick_link_'+randomUUID();
function fixture(options={}) {
 const events=[],state=options.state||{imports:[],notes:[],papers:[],attachments:[],tasks:[],links:[],trash:[],conversations:[],agentRuns:[],projects:[{id:'p',name:'Project',workspace:'科研'}],ui:{composerDraft:'keep'}};
 const context={state,storageHydrated:true,serverConflict:false,purgeTrash:{},URL,TextEncoder,CustomEvent:class{constructor(type,value){this.type=type;Object.assign(this,value);}},document:{dispatchEvent:event=>events.push(event)},saveDocumentDurably:async()=>options.save?options.save(context):true};
 context.window={crypto:webcrypto,WorkstationCore:Core,CitationEvidence,ContentLifecycle,PrivateMode:{isOn:()=>!!context.privateMode}};
 vm.runInNewContext(source,context);return {state,context,events,request:p=>context.window.NativeQuickLinks.request(p)};
}
const create=(patch={})=>({action:'folder-create',requestId:rid(),folder:'Reading',workspace:'科研',projectId:'p',...patch});
const listed=async(f,q='')=>copy(await f.request({action:'list',query:q}));
const group=async(f,path='Reading')=>(await listed(f)).groups.find(x=>x.folder===path);
const edit=(g,action,patch={})=>({action,requestId:rid(),folder:g.folder,workspace:g.workspace,projectId:g.projectId,folderId:g.folderId,expectedVersion:g.version,...patch});
const link=(id,folder='Reading',patch={})=>({id,url:'https://example.org/'+id,name:id,folderPath:folder,workspace:'科研',projectId:'p',...patch});

test('empty folders are canonical shared metadata, survive reload and render as zero sources in the main project tree',async()=>{
 const f=fixture(),command=create(),r=await f.request(command);assert.equal(r.status,'saved');assert.deepEqual(copy(r.ids),[]);assert.equal(r.folderId,command.requestId);
 assert.equal(f.state.imports.length,0);assert.equal(f.state.ui.composerDraft,'keep');assert.equal(f.state.folders.library[0].folderPath,'Reading');
 const reloaded=fixture({state:copy(f.state)}),g=await group(reloaded);assert.equal(g.canRename,true);assert.equal(g.canDelete,true);
 const folders=Library.publicFolders(reloaded.state,'p',CitationEvidence.createAccessContext(reloaded.state));const tree=Library.buildModel([],'Reading',{},folders);
 assert.equal(tree.selected,'Reading');assert.equal(tree.count,0);assert.equal(tree.roots[0].count,0);
 assert.deepEqual(copy(f.events[0].detail.folderIds),[command.requestId]);assert.equal(f.events[0].detail.collection,'folders');
});
test('scoped uniqueness refuses duplicates without merging another workspace/project and normalizes paths',async()=>{
 const f=fixture();await f.request(create());assert.equal((await f.request(create({folder:' /Reading/ '}))).reason,'folder_exists');
 assert.equal((await f.request(create({projectId:null}))).status,'saved');assert.equal((await f.request(create({workspace:'日常',projectId:null}))).status,'saved');
 f.state.imports.push(link('x','Occupied/Child'));assert.equal((await f.request(create({folder:'Occupied'}))).reason,'folder_exists');assert.equal(f.state.folders.library.length,3);
});
test('create and rename exact envelopes survive lost ACK without duplication or later overwrites',async()=>{
 let saved;const f=fixture({save:ctx=>{saved=copy(ctx.state);return false;}}),command=create();assert.equal((await f.request(command)).reason,'storage_failed');
 const next=fixture({state:saved});assert.equal((await next.request(command)).status,'saved');assert.equal(next.state.folders.library.length,1);
 const g=await group(next),rename=edit(g,'folder-rename',{newFolder:'Renamed',expectedIDs:[]});assert.equal((await next.request(rename)).status,'saved');
 assert.equal((await next.request(rename)).status,'saved');next.state.folders.library[0].folderPath='Human change';assert.equal((await next.request(rename)).reason,'changed');assert.equal(next.state.folders.library[0].folderPath,'Human change');
});
test('rename covers every link in the shared scope, preserves content/order and rejects a stale whole-group version',async()=>{
 const f=fixture();f.state.imports.push(link('a','Reading',{content:'original',quickLinkOrder:4}),link('b','Reading',{quickLinkOrder:7}));
 const g=await group(f),request=edit(g,'folder-rename',{newFolder:'Methods',expectedIDs:g.linkIDs});const result=await f.request(request);
 assert.equal(result.status,'saved');assert.deepEqual(copy(result.ids),['a','b']);assert.deepEqual(f.state.imports.map(x=>x.folderPath),['Methods','Methods']);assert.equal(f.state.imports[0].content,'original');assert.equal(f.state.imports[0].quickLinkOrder,4);
 const current=await group(f,'Methods');f.state.imports.push(link('late','Methods'));const before=copy(f.state);
 assert.equal((await f.request(edit(current,'folder-rename',{newFolder:'Stale'}))).reason,'changed');assert.deepEqual(copy(f.state),before);
});
for(const [type,row,reason] of [
 ['notes',{id:'note',title:'Source note',content:'keep',folderPath:'Reading',workspace:'科研',projectId:'p'},'folder_shared'],
 ['papers',{id:'paper',title:'Paper',folderPath:'Reading',workspace:'科研',projectId:'p'},'folder_shared'],
 ['imports',link('pdf','Reading',{url:null,content:'PDF'}),'folder_shared'],
 ['imports',link('nested','Reading/Child'),'folder_children'],
 ['imports',link('private','Reading',{private:true}),'folder_protected'],
]) test('shared folder refuses partial rename or deletion: '+type+' '+reason,async()=>{
 const f=fixture();await f.request(create());f.state.imports.push(link('visible'));f.state[type].push(row);const g=await group(f);
 assert.equal(g.canRename,false);assert.equal(g.canDelete,false);assert.equal(g.blockedReason,reason);const before=copy(f.state);
 assert.equal((await f.request(edit(g,'folder-rename',{newFolder:'Wrong'}))).reason,reason);assert.equal((await f.request(edit(g,'folder-delete'))).reason,reason);assert.deepEqual(copy(f.state),before);
});
test('delete applies only to actually empty shared metadata, catches a late note and never deletes sources or a new same-name folder',async()=>{
 const f=fixture();await f.request(create());const g=await group(f);f.state.notes.push({id:'n',title:'new note',folderPath:'Reading',workspace:'科研',projectId:'p'});
 assert.equal((await f.request(edit(g,'folder-delete'))).reason,'changed');assert.equal(f.state.notes.length,1);f.state.notes=[];
 const current=await group(f),command=edit(current,'folder-delete');assert.equal((await f.request(command)).status,'saved');assert.equal(f.state.folders.library.length,0);
 await f.request(create());assert.equal((await f.request(command)).status,'saved');assert.equal(f.state.folders.library.length,1);
});
test('metadata is searchable but hidden owners/members and ambiguous owners never leak empty names',async()=>{
 const f=fixture();await f.request(create({folder:'Empty notes'}));assert.equal((await listed(f,'EMPTY')).groups.length,1);assert.equal((await listed(f,'unrelated')).groups.length,0);
 f.state.projects[0].private=true;assert.equal((await listed(f)).groups.length,0);assert.equal(Library.publicFolders(f.state,'p',CitationEvidence.createAccessContext(f.state)).length,0);
 delete f.state.projects[0].private;f.state.imports.push(link('secret','Empty notes',{private:true}));assert.equal((await listed(f)).groups.length,0);
 f.state.imports=[];f.state.projects.push({...f.state.projects[0]});assert.equal((await listed(f)).groups.length,0);
});
test('owner replacement or late permission revocation refuses a successful empty-folder receipt',async()=>{
 for (const update of [ctx=>{ctx.state=copy(ctx.state);},ctx=>{ctx.state.projects[0].private=true;}]) {
  const f=fixture({save:ctx=>{update(ctx);return true;}}),result=await f.request(create());assert.notEqual(result.status,'saved');assert.equal(f.events.length,0);
 }
});
test('empty-folder drop keeps record identity/content and destination CAS stops dropping into a removed group',async()=>{
 const f=fixture();await f.request(create({folder:'Empty'}));f.state.imports.push(link('source','Old',{content:'keep'}));let g=await group(f,'Empty'),row=(await listed(f)).rows[0];
 const payload={action:'update',requestId:rid(),destination:{folder:g.folder,workspace:g.workspace,projectId:g.projectId,expectedVersion:g.version},items:[{id:row.id,expectedVersion:row.version,patch:{folder:g.folder,workspace:g.workspace,projectId:g.projectId,order:0}}]};
 assert.equal((await f.request(payload)).status,'saved');assert.equal(f.state.imports[0].id,'source');assert.equal(f.state.imports[0].content,'keep');assert.equal(f.state.folders.library.length,1);
 const other=fixture();await other.request(create());other.state.imports.push(link('source','Old'));g=await group(other);row=(await listed(other)).rows[0];await other.request(edit(g,'folder-delete'));
 const result=await other.request({...payload,requestId:rid(),destination:{folder:g.folder,workspace:g.workspace,projectId:g.projectId,expectedVersion:g.version},items:[{id:row.id,expectedVersion:row.version,patch:{folder:g.folder,workspace:g.workspace,projectId:g.projectId}}]});
 assert.equal(result.reason,'changed');assert.equal(other.state.imports[0].folderPath,'Old');
});
test('folder permission errors never disclose names or create private scoped metadata',async()=>{
 const f=fixture();f.context.privateMode=true;assert.equal((await f.request(create())).reason,'private');assert.equal(f.state.folders,undefined);
 f.context.privateMode=false;f.state.projects[0].private=true;assert.equal((await f.request(create())).reason,'changed');assert.equal(f.state.folders,undefined);
});

test('empty-folder deletion loses its success ACK if a shared note appears while saving, without deleting that note',async()=>{
 let late=false;const f=fixture({save:ctx=>{if(late)ctx.state.notes.push({id:'late',title:'keep',folderPath:'Reading',workspace:'科研',projectId:'p'});return true;}});
 await f.request(create());const g=await group(f);late=true;const result=await f.request(edit(g,'folder-delete'));
 assert.equal(result.reason,'changed');assert.equal(f.state.notes.length,1);assert.equal(f.events.length,1);
});
test('duplicate metadata identities cannot rename or delete another shared folder',async()=>{
 const f=fixture();await f.request(create());f.state.folders.library.push({...f.state.folders.library[0],folderPath:'Other'});
 f.state.imports.push(link('visible'));const g=await group(f);assert.equal(g.canRename,false);assert.equal(g.canDelete,false);
 const before=copy(f.state);assert.equal((await f.request(edit(g,'folder-rename',{newFolder:'Wrong'}))).reason,'changed');assert.deepEqual(copy(f.state),before);
});
test('actual durable folder events rebuild the shared project tree after create, rename and delete without refreshing an editor',async()=>{
 const f=fixture(),models=[],ctx=f.context;let editor=false;
 Object.assign(f.state,{currentProjectId:'p'});f.state.ui.projectTab='knowledge';
 Object.assign(ctx.document,{body:{dataset:{view:'project'}},querySelector:()=>null});
 Object.assign(ctx,{$:()=>({dataset:{projectId:'p'}}),taskEditorHasDrafts:()=>editor,
  renderProject:()=>models.push(Library.buildModel([],null,{},Library.publicFolders(f.state,'p',CitationEvidence.createAccessContext(f.state))))});
 const app=fs.readFileSync(require.resolve('../app/app.js'),'utf8'),start=app.indexOf('function refreshNativeCommittedLinkSurfaces(event) {'),end=app.indexOf("document.addEventListener('records-committed', refreshNativeCommittedLinkSurfaces);",start);
 vm.runInNewContext(app.slice(start,end),ctx);
 ctx.document.dispatchEvent=event=>{f.events.push(event);ctx.refreshNativeCommittedLinkSurfaces(event);};
 const command=create();await f.request(command);assert.deepEqual(models.at(-1).roots.map(x=>x.path),['Reading']);
 const g=await group(f);await f.request(edit(g,'folder-rename',{newFolder:'Updated',expectedIDs:[]}));
 assert.deepEqual(models.at(-1).roots.map(x=>x.path),['Updated']);
 await f.request(edit(await group(f,'Updated'),'folder-delete'));assert.deepEqual(models.at(-1).roots,[]);
 assert.equal(models.length,3);for(const event of f.events){assert.equal(event.detail.owner,f.state);assert.deepEqual(copy(event.detail.ids),[]);assert.deepEqual(copy(event.detail.folderIds),[command.requestId]);}
 editor=true;await f.request(create({folder:'Saved without disrupting editor'}));assert.equal(models.length,3);assert.equal(f.state.folders.library.length,1);
});
