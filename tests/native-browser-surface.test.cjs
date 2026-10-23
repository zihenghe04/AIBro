const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/NativeBrowserView.swift'),'utf8');

test('production Swift layout reveals compact workspace overlays and preserves side-by-side browsers',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const policy=source.match(/struct NativeBrowserLayout \{[^]*?\n\}/)?.[0];
 assert.ok(policy,'The production policy, rather than a JavaScript copy, is executed');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-browser-layout-'));
 try {
  const script=path.join(directory,'main.swift'),binary=path.join(directory,'layout');
  fs.writeFileSync(script,`import Foundation\n${policy}\n
let widths:[CGFloat] = [0, 500, 999, 1000, 1280, 1600]
let preferredWidths:[CGFloat] = [300, 500, 1300]
var rows:[[String:Any]] = []
for width in widths { for preferred in preferredWidths { for visible in [false,true] { for overlay in [false,true] { for workspacePreferred in [false,true] {
 let layout=NativeBrowserLayout(width:width,preferredBrowserWidth:preferred,browserVisible:visible,workspaceOverlay:overlay,compactWorkspacePreferred:workspacePreferred)
 rows.append(["width":width,"preferred":preferred,"visible":visible,"overlay":overlay,"compactWorkspacePreferred":workspacePreferred,"compact":layout.compact,"browserPresented":layout.browserPresented,"workspaceVisible":layout.workspaceVisible,"browserWidth":layout.browserWidth,"workspaceWidth":layout.workspaceWidth,"dividerWidth":layout.dividerWidth])
}}}}}
print(String(data:try JSONSerialization.data(withJSONObject:rows),encoding:.utf8)!)
`);
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5',script,'-o',binary],{encoding:'utf8',timeout:90000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const rows=JSON.parse(result.stdout);
  assert.equal(rows.length,144);
  for(const row of rows){
   const context=JSON.stringify(row);
   assert.ok(row.workspaceWidth>=0&&row.browserWidth>=0,context);
   if(!row.visible){
    assert.equal(row.browserPresented,false,context);assert.equal(row.workspaceVisible,true,context);
    assert.equal(row.workspaceWidth,row.width,context);assert.equal(row.dividerWidth,0,context);
   }else if(row.width<1000){
    assert.equal(row.browserWidth,row.width,context);assert.equal(row.dividerWidth,0,context);
    const workspaceOwnsSurface=row.overlay||row.compactWorkspacePreferred;
    assert.equal(row.browserPresented,!workspaceOwnsSurface,context);assert.equal(row.workspaceVisible,workspaceOwnsSurface,context);
    assert.equal(row.workspaceWidth,workspaceOwnsSurface?row.width:0,context);
   }else{
    assert.equal(row.browserPresented,true,context);assert.equal(row.workspaceVisible,true,context);
    assert.equal(row.dividerWidth,1,context);assert.ok(row.browserWidth>=420,context);assert.ok(row.workspaceWidth>=560,context);
    assert.equal(row.workspaceWidth+row.browserWidth+row.dividerWidth,row.width,context);
    const withoutOverlay=rows.find(other=>other.width===row.width&&other.preferred===row.preferred&&other.visible&&!other.overlay&&!other.compactWorkspacePreferred);
    assert.equal(row.workspaceWidth,withoutOverlay.workspaceWidth,context);assert.equal(row.browserWidth,withoutOverlay.browserWidth,context);
   }
  }
  // Opening and cancelling an overlay returns the original compact geometry;
  // crossing the breakpoint while it is open keeps both surfaces available.
  const sample=(width,overlay,workspacePreferred=false)=>rows.find(row=>row.width===width&&row.preferred===500&&row.visible&&row.overlay===overlay&&row.compactWorkspacePreferred===workspacePreferred);
  assert.deepEqual([sample(999,false).browserPresented,sample(999,true).browserPresented,sample(1000,true).browserPresented,sample(999,false).browserPresented],[true,false,true,true]);
  assert.deepEqual([sample(999,false).workspaceVisible,sample(999,true).workspaceVisible,sample(1000,true).workspaceVisible],[false,true,true]);
  // A successful workspace navigation persists beyond search dismissal, then
  // an explicit browser return clears the preference without closing its tab.
  assert.deepEqual([sample(999,true).browserPresented,sample(999,false,true).browserPresented,sample(999,false).browserPresented],[false,false,true]);
  assert.equal(sample(999,false,true).workspaceWidth,999);
  assert.equal(sample(999,false,true).browserWidth,sample(999,false).browserWidth);
  assert.equal(sample(1000,false,true).browserPresented,true);
  assert.equal(sample(1000,false,true).workspaceWidth,sample(1000,false).workspaceWidth);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('compact coverage retains mounted browser controls and routes real WKWebView visibility through the native responder gate',()=>{
 assert.match(source,/var workspaceOverlay=false/);
 assert.match(source,/var compactWorkspacePreferred=false/);
 assert.match(source,/NativeBrowserLayout\(width:geometry\.size\.width,preferredBrowserWidth:preferredBrowserWidth,browserVisible:browser\.visible,workspaceOverlay:workspaceOverlay,compactWorkspacePreferred:compactWorkspacePreferred\)/);
 assert.match(source,/if browser\.visible \{/);
 assert.doesNotMatch(source,/if (?:layout\.)?browserPresented \{/);
 assert.match(source,/NativeBrowserPanel\(browser:browser,compact:compact,surfaceVisible:layout\.browserPresented\)/);
 assert.match(source,/NativeBrowserTabView\(tab:tab,surfaceVisible:surfaceVisible\)\.id\(tab\.id\)/);
 assert.match(source,/NativeBrowserWebView\(tab:tab,surfaceVisible:surfaceVisible\)\.id\(tab\.id\)/);
 assert.match(source,/makeNSView[^\n]+setNativeSurfaceVisibility\(tab\.web,visible:surfaceVisible\);return tab\.web/);
 assert.match(source,/updateNSView[^\n]+setNativeSurfaceVisibility\(view,visible:surfaceVisible\)/);
 assert.match(source,/\.frame\(width:browserWidth,height:geometry\.size\.height\)\s*\.frame\(width:layout\.browserPresented \? browserWidth:0,alignment:\.leading\)/);
 assert.match(source,/\.allowsHitTesting\(layout\.browserPresented\)\.disabled\(!layout\.browserPresented\)\.accessibilityHidden\(!layout\.browserPresented\)/);
 assert.match(source,/\.allowsHitTesting\(layout\.workspaceVisible\)\.disabled\(!layout\.workspaceVisible\)\.accessibilityHidden\(!layout\.workspaceVisible\)/);
 assert.doesNotMatch(source,/onChange\(of:(?:workspaceOverlay|surfaceVisible|layout\.browserPresented)/);
 assert.doesNotMatch(source,/stopAll\(|stopLoading\(|removeFromSuperview\(/);
});


test('workspace navigation preference follows explicit destinations and retains a compact return path',()=>{
 const main=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/AIBro.swift'),'utf8');
 const successfulSearch=main.slice(main.indexOf('private func revealSearchDestination'),main.indexOf('func consumeSearchSelection'));
 assert.match(successfulSearch,/compactWorkspacePreferred=true/);
 assert.match(main,/NativeBrowserWorkspace[^\n]+compactWorkspacePreferred:model\.compactWorkspacePreferred/);
 assert.match(main,/if !model\.browser\.tabs\.isEmpty && \(!model\.browser\.visible \|\| \(compactBrowserLayout && model\.compactWorkspacePreferred\)\) \{ ToolbarItem/,'a hidden browser with open tabs stays reachable in wide windows too');
 assert.doesNotMatch(main,/if compactBrowserLayout && !model\.browser\.tabs\.isEmpty/,'the way back is not limited to compact layouts');
 assert.match(main,/browserPresence=browser\.\$visible\.combineLatest\(browser\.\$tabs\.map\(\\\.isEmpty\)\)[^\n]*self\?\.objectWillChange\.send\(\)/,'the main toolbar redraws when the browser is hidden or its last tab closes');
 assert.match(main,/Button \{model\.browser\.visible=true\} label:\{Label\(nativeUI\("返回浏览器"/);
 const browser=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/NativeBrowser.swift'),'utf8');
 assert.match(browser,/action == "snapshot"[^\n]+tab\.web\.isHiddenOrHasHiddenAncestor[^\n]+NOT_VISIBLE/);
});
