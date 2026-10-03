const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const swift=fs.readFileSync(path.join(root,'native/Sources/AIBro/AIBro.swift'),'utf8');
const method=name=>{
 const match=swift.match(new RegExp(`    (?:@discardableResult )?(?:private )?func ${name}\\([^]*?\\n    \\}`));
 assert.ok(match,`Production ${name} method exists`);return match[0];
};
const settings=method('openWorkspaceSettings');
const scripts=[...settings.matchAll(/callAsyncJavaScript\("""\n([^]*?)\n\s*"""/g)].map(match=>match[1]);
const run=(script,env)=>vm.runInNewContext(`(async()=>{${script}})()`,env);

test('sidebar, toolbar, Command-comma and quick entry share one workspace destination and preserve Appearance',()=>{
 assert.equal((swift.match(/model\.openWorkspaceSettings\(\)/g)||[]).length,4);
 assert.match(swift,/CommandGroup\(replacing:\.appSettings\)[^\n]+keyboardShortcut\(",",modifiers:\.command\)/);
 assert.doesNotMatch(swift,/\\\.openSettings|struct Preferences:View|Settings\s*\{Preferences|NSApp\.keyWindow\?\.close/);
 assert.match(swift,/ToolbarItem \{ AppearanceControl\(model:model\) \}/);
 for(const value of ['system','light','dark'])assert.ok(swift.includes(`["${value}",`)||swift.includes(`("${value}",nativeUI`));
 assert.match(settings,/let mainWindow=web\.window \?\? glassHost\?\.window/);
 assert.doesNotMatch(settings,/NSApp\.(keyWindow|mainWindow|windows)|\.close\(/);
});

test('draft prompts are visible above native dashboards while the asynchronous settings request owns navigation',()=>{
 const visibility=swift.match(/var nativeContent:Bool \{([^\n]+)/)[1];
 assert.match(visibility,/if workspaceOverlay \{return false\}/);
 assert.match(swift,/var workspaceOverlay:Bool \{model\.settingsNavigationPending/);
 assert.match(swift,/if !workspaceOverlay \{/);
 assert.match(swift,/consumeSettingsSelection\(value\) \|\| model\.consumeSearchSelection\(value\)/);
});

test('legacy preflight waits for both actual editor gates, and cancellation never invokes local-file gate',async()=>{
 assert.equal(scripts.length,1);
 const app=fs.readFileSync(path.join(root,'app/app.js'),'utf8');
 const before=app.match(/function beforePreviewLeave\(\) \{[^]*?\n\}/)[0];
 let doneNote,doneFile;let localCalls=0;
 const env={requestID:'request-1',document:{querySelector:()=>null},window:{NoteEditor:{beforeLeave:()=>new Promise(resolve=>doneNote=resolve)},ProjectFiles:{beforeLeave:()=>{localCalls++;return new Promise(resolve=>doneFile=resolve)}}}};
 vm.runInNewContext(before,env);let settled=false;
 const pending=run(scripts[0],env).then(result=>{settled=true;return result});
 await Promise.resolve();assert.equal(settled,false);assert.equal(localCalls,0);
 doneNote(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(localCalls,1);assert.equal(settled,false);
 doneFile(false);assert.equal(await pending,'cancelled');
 const cancelled=run(scripts[0],env);doneNote(false);assert.equal(await cancelled,'cancelled');assert.equal(localCalls,1);
});

test('retaining readers route through the actual native bridge and showView without invoking or saving editor gates',async()=>{
 const app=fs.readFileSync(path.join(root,'app/app.js'),'utf8'),bridge=fs.readFileSync(path.join(root,'native/Resources/bridge.js'),'utf8');
 const show=app.slice(app.indexOf('function showView('),app.indexOf('\nconst viewLabels ='));
 const shell=bridge.slice(bridge.indexOf('let nativeNavigationVersion='),bridge.indexOf("\nwindow.addEventListener('aibro-native-space-navigation'"));
 for(const type of ['note','local-file','import']){
  const draft={id:'original',type,content:'尚未保存的正文',page:2,scrollTop:347};
  const reader={visible:true,retained:false,draft};let gates=0,saves=0,renders=0,parks=0;
  const env={requestID:'request-1',storageHydrated:true,settingsHydrated:false,
   state:{ui:{lastView:'agent'},previewRecord:{type,id:draft.id}},
   document:{body:{dataset:{view:'agent'},classList:{toggle(){}}},querySelector:()=>null},
   $:selector=>selector==='#currentContext'?{removeAttribute(){}}:null,$$:()=>[],
   save(){saves++;},renderSettings(){renders++;},renderSidebar(){},snapshot(){},
   beforePreviewLeave(){gates++;throw Error('Retained documents must not leave');},
   window:{ReadingPane:{resume(){reader.visible=true;reader.retained=false;},revealWorkspace(options){assert.equal(options.force,true);parks++;reader.visible=false;reader.retained=true;}}},
  };
  const context=vm.createContext(env);vm.runInContext(show+shell,context);
  assert.equal(await run(scripts[0],context),'opened');
  assert.equal(gates,0);assert.equal(parks,1);assert.equal(renders,1);assert.equal(saves,1,'route metadata is saved through showView');
  assert.equal(env.document.body.dataset.view,'settings');assert.equal(env.state.ui.lastView,'settings');
  assert.equal(reader.visible,false);assert.equal(reader.retained,true);assert.equal(reader.draft,draft);
  assert.deepEqual(draft,{id:'original',type,content:'尚未保存的正文',page:2,scrollTop:347});
  assert.deepEqual(env.state.previewRecord,{type,id:'original'});
  assert.equal(Object.hasOwn(env.window,'__aibroSettingsRequest'),false);
 }
});

test('incomplete retention support uses the legacy gate and preserves cancellation',async()=>{
 for(const reader of [undefined,{}, {resume(){}}, {revealWorkspace(){}}]){
  let gates=0,routes=0;const env={requestID:'request-1',document:{querySelector:()=>null},beforePreviewLeave:()=>{gates++;return false;},window:{ReadingPane:reader,NativeShell:{perform:()=>{routes++;return true;}}}};
  assert.equal(await run(scripts[0],env),'cancelled');assert.equal(gates,1);assert.equal(routes,0);
  assert.equal(Object.hasOwn(env.window,'__aibroSettingsRequest'),false);
 }
});

test('settings preflight fails closed for modals; missing or failed editor hooks are errors',async()=>{
 let calls=0;const env={requestID:'request-1',window:{},document:{querySelector:()=>({})},beforePreviewLeave:()=>{calls++;return true}};
 assert.equal(await run(scripts[0],env),'cancelled');assert.equal(calls,0);
 await assert.rejects(run(scripts[0],{requestID:'request-1',window:{},document:{querySelector:()=>null}}),/Workspace is not ready/);
 await assert.rejects(run(scripts[0],{requestID:'request-1',window:{},document:{querySelector:()=>null},beforePreviewLeave:async()=>{throw Error('durable save failed')}}),/durable save failed/);
 const retaining={resume(){},revealWorkspace(){}};
 assert.equal(await run(scripts[0],{requestID:'request-1',window:{ReadingPane:retaining,NativeShell:{perform(){throw Error('Modal must remain in control');}}},document:{querySelector:()=>({})}}),'cancelled');
 await assert.rejects(run(scripts[0],{requestID:'request-1',window:{ReadingPane:retaining,NativeShell:{perform(){throw Error('route failed');}}},document:{querySelector:()=>null}}),/route failed/);
});

test('a modal opened while the legacy gate waits keeps control after save completes',async()=>{
 let allow,modal=null,routes=0;const env={requestID:'request-1',document:{querySelector:()=>modal},beforePreviewLeave:()=>new Promise(resolve=>allow=resolve),window:{NativeShell:{perform:()=>{routes++;return true;}}}};
 const pending=run(scripts[0],env);modal={};allow(true);
 assert.equal(await pending,'cancelled');assert.equal(routes,0);assert.equal(Object.hasOwn(env.window,'__aibroSettingsRequest'),false);
});

test('consent and routing use one script and accept only an actual NativeShell success',async()=>{
 const calls=[];const env={requestID:'request-1',document:{querySelector:()=>null},beforePreviewLeave:()=>true,window:{NativeShell:{perform:command=>{calls.push(command);return true}}}};
 assert.equal(await run(scripts[0],env),'opened');assert.equal(calls.length,1);assert.equal(calls[0].type,'view');assert.equal(calls[0].id,'settings');
 assert.equal(Object.hasOwn(env.window,'__aibroSettingsRequest'),false);
 env.window.NativeShell.perform=()=>false;assert.equal(await run(scripts[0],env),'unavailable');
 env.window.NativeShell=null;assert.equal(await run(scripts[0],env),'unavailable');
 env.window.ReadingPane={resume(){},revealWorkspace(){}};env.beforePreviewLeave=()=>{throw Error('Do not invoke the old gate');};
 assert.equal(await run(scripts[0],env),'unavailable');env.window.NativeShell={perform:()=>false};assert.equal(await run(scripts[0],env),'unavailable');
});

test('newer native intent invalidates the pending JS request before it can submit settings',async()=>{
 let allow,calls=0;const env={requestID:'request-1',document:{querySelector:()=>null},beforePreviewLeave:()=>new Promise(resolve=>allow=resolve),window:{NativeShell:{perform:()=>{calls++;return true}}}};
 const pending=run(scripts[0],env);
 const cancelScript=method('cancelSettingsNavigation').match(/evaluateJavaScript\("([^"\n]+)"/)[1];
 vm.runInNewContext(cancelScript,env);allow(true);
 assert.equal(await pending,'cancelled');assert.equal(calls,0);
 // A stale completion must not remove a later request's ownership.
 const older=run(scripts[0],env);env.window.__aibroSettingsRequest='request-2';allow(true);
 assert.equal(await older,'cancelled');assert.equal(env.window.__aibroSettingsRequest,'request-2');
});

test('actual Swift navigation methods handle ACK, cancel, reentry, newer intents, exact window ownership and blocked sheets',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-settings-unit-'));
 try{
  const names=['focusWebContent','command','documentOpenOrigin','openWorkspaceSettings','cancelSettingsNavigation','settingsBrowserVisibilityChanged','consumeSettingsSelection','dismissTransientModelPicker','navigate','openProject','rememberNavigationOrigin','cancelPendingWorkspaceNavigation','adoptReportedWorkspaceDestination','openWorkspace','navigateWorkspace'];
  const schema=fs.readFileSync(path.join(root,'native/Sources/AIBro/WorkspaceNavigation.swift'),'utf8').split('struct NativeWorkspaceLocation:')[1].split('\nstruct SpaceNavigation:')[0];
  const template=fs.readFileSync(path.join(__dirname,'native-settings.swift'),'utf8').replace('// LOCATION_SCHEMA','struct NativeWorkspaceLocation:'+schema).replace('    // PRODUCTION_METHODS',names.map(method).join('\n'));
  const source=path.join(directory,'Settings.swift'),binary=path.join(directory,'settings-tests');fs.writeFileSync(source,template);
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',source,'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PASS: 34 native settings navigation scenarios/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
