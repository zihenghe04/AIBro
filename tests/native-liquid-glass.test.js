const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createNativeGlass,normalizeRegions}=require('../app/native-liquid-glass');
const {headerDirectory}=require('../app/build-native-glass');
const region=(extra={})=>({id:'composer',x:10,y:20,width:100,height:80,radius:20,style:'regular',...extra});
function fixture(extra={}) {
  const frame={url:'http://127.0.0.1:8765/index.html'},calls=[];
  const wc={mainFrame:frame,getZoomFactor:()=>1};
  const win={webContents:wc,isDestroyed:()=>false,getContentBounds:()=>({width:800,height:600}),getNativeWindowHandle:()=>Buffer.alloc(8,1)};
  const addon={isSupported:()=>true,setRegions:(handle,regions)=>{calls.push({handle,regions});return regions.length;},clear:(...args)=>calls.push({clear:args})};
  let loads=0;
  const native=createNativeGlass({getWindow:()=>win,getLocalOrigin:()=> 'http://127.0.0.1:8765',platform:'darwin',release:'25.4.0',loadAddon:()=>{loads++;return addon;},...extra});
  return{native,win,wc,frame,event:{sender:wc,senderFrame:frame},calls,addon,get loads(){return loads;}};
}
test('regions use public styles, CSS zoom conversion, viewport clipping and bounded radii',()=>{
  assert.deepEqual(normalizeRegions([region({x:-5,y:-5,width:50,height:50,radius:99,style:'clear'})],{width:80,height:60},2),[{id:'composer',x:0,y:0,width:80,height:60,radius:30,style:'clear'}]);
  assert.deepEqual(normalizeRegions([region({x:900})],{width:800,height:600}),[]);
  const h=fixture();h.wc.getZoomFactor=()=>1.5;assert.equal(h.native.setRegions(h.event,[region()]).active,true);assert.equal(h.calls[0].regions[0].x,15);assert.equal(h.calls[0].regions[0].height,120);
});
test('invalid or private geometry is rejected atomically before any native call',()=>{
  for(const payload of [null,{},Array(17).fill(region()),[region(),region()],[region({id:'../x'})],[region({x:Infinity})],[region({y:NaN})],[region({width:0})],[region({height:-1})],[region({radius:-1})],[region({x:'1'})],[region({style:'dock'})],[region({variant:2})],[region({tintColor:'#fff'})],[region({width:40000})]]){
    const h=fixture();h.native.setRegions(h.event,[region()]);assert.throws(()=>h.native.setRegions(h.event,payload),TypeError);assert.equal(h.calls.length,1);assert.equal(h.native.status().regions,1);
  }
});
test('only the current trusted main frame can change regions or query privileged status',()=>{
  const h=fixture();
  const foreign=[{sender:{},senderFrame:h.frame},{sender:h.wc,senderFrame:{url:h.frame.url}},{sender:h.wc,senderFrame:{url:'https://example.org/'}},{}];
  for(const event of foreign){assert.throws(()=>h.native.setRegions(event,[region()]),/Untrusted/);assert.throws(()=>h.native.status(event),/Untrusted/);}
  h.frame.url='http://127.0.0.1:8765/__files/arbitrary';assert.throws(()=>h.native.setRegions(h.event,[region()]),/Untrusted/);
  assert.equal(h.loads,0);assert.deepEqual(h.calls,[]);
});
test('status checks capability without creating views or obtaining a native handle',()=>{
  const h=fixture();h.win.getNativeWindowHandle=()=>{throw Error('must not run');};assert.deepEqual(h.native.status(h.event),{supported:true,active:false,regions:0});assert.deepEqual(h.calls,[]);assert.equal(h.loads,1);h.native.status();assert.equal(h.loads,1);
});
test('unsupported platform, older macOS and missing addon retain fallback without native calls',()=>{
  for(const extra of [{platform:'linux'},{release:'24.6.0'}]){const h=fixture(extra);const state=h.native.setRegions(h.event,[region()]);assert.equal(state.supported,false);assert.equal(state.active,false);assert.equal(h.loads,0);}
  const h=fixture({loadAddon:()=>{throw Error('/private/path should never leak');}});const state=h.native.status();assert.equal(state.supported,false);assert.equal(state.reason,'native-unavailable');assert.doesNotMatch(JSON.stringify(state),/private\/path/);
});
test('full replacement and empty list let native update and remove region identities',()=>{
  const h=fixture();assert.equal(h.native.setRegions(h.event,[region(),region({id:'sidebar'})]).regions,2);
  assert.equal(h.native.setRegions(h.event,[region({x:60})]).regions,1);assert.equal(h.calls[1].regions[0].x,60);
  assert.deepEqual(h.native.setRegions(h.event,[]),{supported:true,active:false,regions:0});assert.deepEqual(h.calls[2].regions,[]);
});
test('failed native update clears its views and returns an explicit inactive fallback',()=>{
  const h=fixture();h.native.setRegions(h.event,[region()]);h.addon.setRegions=()=>{throw Error('untrusted path');};const result=h.native.setRegions(h.event,[region({x:30})]);assert.deepEqual(result,{supported:true,active:false,regions:0,reason:'native-failure'});assert.deepEqual(h.calls.at(-1),{clear:[]});
});
test('closed-window disposal never reads its stale handle and is safe to repeat',()=>{
  const h=fixture();h.native.setRegions(h.event,[region()]);h.win.isDestroyed=()=>true;h.win.getNativeWindowHandle=()=>{throw Error('stale');};h.native.dispose();h.native.dispose();assert.equal(h.native.status().active,false);assert.ok(h.calls.slice(1).every(call=>call.clear.length===0));
});
test('source uses SDK public NSGlassEffectView properties, click-through views and weak owner cleanup',()=>{
  const source=fs.readFileSync(require.resolve('../app/native-glass.mm'),'utf8');assert.match(source,/NSGlassEffectViewStyleRegular/);assert.match(source,/NSGlassEffectViewStyleClear/);assert.match(source,/glass\.cornerRadius/);assert.match(source,/glass\.tintColor = nil/);assert.match(source,/hitTest:[^\n]+return nil/);assert.match(source,/weakToStrongObjectsMapTable/);assert.match(source,/positioned:NSWindowBelow/);
  assert.doesNotMatch(source,/objc_msgSend|sel_registerName|setValue:.*forKey:|unstable|_variant|scrimState|NSClassFromString/);
});
test('build can use explicit Node-API headers without a package installation',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ai-bro-glass-headers-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));for(const name of ['node_api.h','js_native_api.h','js_native_api_types.h'])fs.writeFileSync(path.join(directory,name),'');assert.equal(headerDirectory({env:{NODE_INCLUDE_DIR:directory},home:directory}),directory);
});
