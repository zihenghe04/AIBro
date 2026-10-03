const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('shortcut replacement, conflicts, inactive persistence and recording preserve user control', {skip:process.platform !== 'darwin',timeout:90000}, () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-shortcut-'));
  try {
    const swift=path.join(tmp,'Checks.swift'), binary=path.join(tmp,'checks');
    fs.writeFileSync(swift, `
import AppKit
import Carbon.HIToolbox
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class Ticket:NativeQuickShortcutRegistration {
 let id:Int; let action:()->Void; let log:(String)->Void
 init(_ id:Int,_ action:@escaping()->Void,_ log:@escaping(String)->Void){self.id=id;self.action=action;self.log=log}
 func cancel(){log("cancel-\\(id)")}
}
@MainActor final class Driver:NativeQuickShortcutService {
 var tickets:[Ticket]=[];var events:[String]=[];var failure=false
 func register(_ shortcut:NativeQuickShortcut,action:@escaping()->Void)throws->NativeQuickShortcutRegistration {
  events.append("attempt-"+shortcut.label)
  if failure { throw NSError(domain:"test.conflict",code:1) }
  let id=tickets.count, ticket=Ticket(id,action,{[weak self] in self?.events.append($0)})
  tickets.append(ticket);events.append("registered-\\(id)");return ticket
 }
}
@main struct Checks {
 @MainActor static func main(){
  let suite="test.aibro.shortcut."+UUID().uuidString, prefs=UserDefaults(suiteName:suite)!
  defer{prefs.removePersistentDomain(forName:suite)}
  var count=0
  func check(_ condition:Bool,_ label:String){precondition(condition,label);count+=1}
  let driver=Driver(), store=NativeQuickShortcutStore(preferences:prefs,service:driver)
  let next=NativeQuickShortcut(keyCode:40,modifiers:UInt32(controlKey|optionKey|shiftKey))
  check(store.shortcut == .standard && !store.active,"default init is inactive")
  check(driver.events.isEmpty,"init never registers a key")
  check(!NativeQuickShortcut(keyCode:40,modifiers:0).valid,"bare typing not intercepted")
  check(!NativeQuickShortcut(keyCode:40,modifiers:UInt32(shiftKey)).valid,"shift typing not intercepted")
  check(!NativeQuickShortcut(keyCode:12,modifiers:UInt32(cmdKey)).valid,"Cmd Q reserved")
  check(!NativeQuickShortcut(keyCode:48,modifiers:UInt32(cmdKey)).valid,"Cmd Tab reserved")
  check(!NativeQuickShortcut(keyCode:999,modifiers:UInt32(controlKey)).valid,"unknown key rejected")
  check(!NativeQuickShortcut(keyCode:40,modifiers:0xffffffff).valid,"unknown modifiers rejected")
  check(next.valid && next.label == "⌃⌥⇧K","labels describe actual normalized shortcut")
  check(store.apply(next),"inactive preference can be chosen")
  check(driver.events.isEmpty,"off entry does not register")
  check(NativeQuickShortcutStore(preferences:prefs,service:driver).shortcut==next,"choice survives new store")
  store.setActive(true)
  check(driver.tickets.count==1 && store.active,"activation registers chosen shortcut")
  var invoked=0;store.onInvoke={invoked+=1};driver.tickets[0].action()
  check(invoked==1,"registered action invokes panel")
  store.setRecording(true);driver.tickets[0].action()
  check(!store.recording && invoked==1,"recording existing chord finishes without toggling panel")
  store.setActive(true);check(driver.tickets.count==1,"idempotent activation avoids duplicate registrations")
  driver.failure=true
  check(!store.apply(.standard),"conflict fails honestly")
  check(store.shortcut==next && store.issue != nil,"conflict retains old choice")
  check(!driver.events.contains("cancel-0"),"conflict retains working registration")
  check(NativeQuickShortcutStore(preferences:prefs,service:driver).shortcut==next,"conflict not persisted")
  driver.failure=false
  check(store.apply(.standard),"successful replacement accepted")
  let cancel=driver.events.firstIndex(of:"cancel-0")!, registered=driver.events.firstIndex(of:"registered-1")!
  check(registered<cancel,"replacement registered before old release")
  check(store.shortcut == .standard && store.issue==nil,"success clears conflict")
  check(store.apply(.standard) && driver.tickets.count==2,"same shortcut not re-registered")
  store.setRecording(true);store.setActive(false)
  check(!store.active && !store.recording && driver.events.last=="cancel-1","off cancels registration and recording")
  driver.tickets[1].action();check(invoked==1,"late callback while disabled cannot open panel")
  driver.failure=true;store.setActive(true)
  check(store.issue != nil && store.shortcut == .standard,"startup conflict preserves preference")
  driver.failure=false;check(store.apply(store.shortcut) && driver.tickets.count==3,"explicit retry recovers")
  store.setActive(false)
  prefs.set(Data("bad json".utf8),forKey:NativeQuickShortcutStore.preferenceKey)
  check(NativeQuickShortcutStore(preferences:prefs,service:driver).shortcut == .standard,"malformed saved data safe default")
  prefs.set(try! JSONEncoder().encode(NativeQuickShortcut(keyCode:0,modifiers:0)),forKey:NativeQuickShortcutStore.preferenceKey)
  check(NativeQuickShortcutStore(preferences:prefs,service:driver).shortcut == .standard,"invalid saved key safe default")
  print("PASS: \\(count) shortcut lifecycle assertions")
 }
}
`);
    const compiled=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',path.join(root,'native/Sources/AIBro/NativeQuickShortcut.swift'),swift,'-o',binary],{encoding:'utf8',timeout:60000});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/PASS: 30 shortcut lifecycle assertions/);process.stdout.write(run.stdout);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
