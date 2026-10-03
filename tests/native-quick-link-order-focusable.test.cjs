const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('link ordering uses the native grip after ACK instead of the unconfirmed SwiftUI Menu focus chain', {skip:process.platform!=='darwin',timeout:120000},()=>{
 const file=path.join(root,'native/Sources/AIBro/NativeQuickLinksView.swift');
 const source=fs.readFileSync(file,'utf8');
 const menu=source.slice(source.indexOf('    private func linkRow('),source.indexOf('    private func reorder('));
 assert.match(menu,/NativeQuickLinkDragHandle/);
 assert.doesNotMatch(menu,/focusedMenuID/);
 const arrange=source.slice(source.indexOf('    private func arrange('),source.indexOf('    private var editor:'));
 assert.match(arrange,/guard saved,orderFocus\.owns\(token\)/);
 assert.match(arrange,/orderFocus\.restore\(token,id:row\.id\).*drag\.focus\(row\.id\)/);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-link-menu-focus-'));
 try{
  const stub=path.join(temp,'NativeL10n.swift');fs.writeFileSync(stub,'func nativeUI(_ zh:String,_ en:String)->String { en }\n');
  const names=['NativeQuickRecordFocus','NativeQuickLinkIcon','NativeQuickLinkSitePolicy','NativeQuickLinksStore','NativeQuickLinkDrag','NativeQuickLinksView'];
  const result=spawnSync('xcrun',['swiftc','-typecheck','-parse-as-library','-swift-version','5',...names.map(name=>path.join(root,'native/Sources/AIBro',name+'.swift')),stub],{encoding:'utf8',timeout:110000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  console.log('PASS actual View routes confirmed ordering to the native grip; hidden-window responder behavior is covered by native-quick-link-drag, panel UX still needs QA');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
