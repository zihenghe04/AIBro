const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('same-title window selection, geometry identity and late-result protection',{skip:process.platform!=='darwin',timeout:90000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-window-selection-'));
 try {
  const source=fs.readFileSync(path.join(root,'native/Sources/AIBro/NativeQuickMedia.swift'),'utf8');
  const start=source.indexOf('struct NativeQuickWindowItem:'),end=source.indexOf('@MainActor final class NativeQuickMusicStore');
  assert(start>=0&&end>start);const extracted=path.join(tmp,'WindowProduction.swift');
  fs.writeFileSync(extracted,'import AppKit\nimport SwiftUI\nimport Combine\n'+source.slice(start,end));
  const files=['NativeQuickWindowSnapshot.swift','NativeQuickWindowActivation.swift', 'NativeQuickWindowInteraction.swift', 'NativeQuickWindowInteractionView.swift','NativeQuickPresentation.swift','NativeQuickWidgetContext.swift'].map(p=>path.join(root,'native/Sources/AIBro',p));
  const binary=path.join(tmp,'checks');
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',...files,extracted,path.join(root,'tests/native-quick-window-selection.swift'),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:15000});process.stdout.write(run.stdout);assert.equal(run.status,0,run.stdout+run.stderr);
  assert.match(run.stdout,/window selection assertions passed/);
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
