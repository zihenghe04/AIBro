const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeLanguage } = require('../app/native-ui-language');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bro-native-locale-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frame = { url: 'http://127.0.0.1:12345/' }, menus = [];
  const contents = { mainFrame: frame };
  const options = { directory, platform: 'darwin', app: { showAboutPanel() {} }, Menu: { buildFromTemplate: v => v, setApplicationMenu: v => menus.push(v) }, getWindow: () => ({ webContents: contents }), getLocalOrigin: () => 'http://127.0.0.1:12345' };
  return { directory, menus, options, event: { sender: contents, senderFrame: frame }, ui: createNativeLanguage(options) };
}
test('native menus switch immediately and keep the language after a new process initializes', t => {
  const f=fixture(t); f.ui.apply();
  assert.equal(f.menus.at(-1)[1].label,'文件');
  assert.deepEqual(f.ui.setLanguage(f.event,'en'),{language:'en'});
  assert.equal(f.menus.at(-1)[1].label,'File');
  assert.equal(f.menus.at(-1)[0].submenu.at(-1).label,'Quit AI Bro');
  assert.equal(f.ui.text('返回编辑','Return to note'),'Return to note');
  const restarted=createNativeLanguage(f.options); restarted.apply();
  assert.equal(restarted.language,'en');
  restarted.setLanguage(f.event,'zh-CN');
  assert.equal(createNativeLanguage(f.options).language,'zh-CN');
});
test('external frames and unsupported locale strings cannot change the preference', t=>{
  const f=fixture(t);
  assert.throws(()=>f.ui.setLanguage({...f.event,senderFrame:{url:'https://example.org/'}},'en'),/sender/);
  assert.throws(()=>f.ui.setLanguage(f.event,'../en'),/Unsupported/);
  assert.equal(f.ui.language,'zh-CN');
  assert.equal(fs.readdirSync(f.directory).length,0);
});
test('native vibrancy matches the chosen app appearance and preserves language', t=>{
  const f=fixture(t), nativeTheme={themeSource:'system'};
  const ui=createNativeLanguage({...f.options,getNativeTheme:()=>nativeTheme});
  ui.setAppearance(f.event,'dark');
  assert.equal(nativeTheme.themeSource,'dark');
  ui.setLanguage(f.event,'en');
  const restarted=createNativeLanguage({...f.options,getNativeTheme:()=>nativeTheme});restarted.apply();
  assert.equal(nativeTheme.themeSource,'dark');assert.equal(restarted.language,'en');
  assert.throws(()=>ui.setAppearance(f.event,'arbitrary'),/Unsupported/);
  assert.throws(()=>ui.setAppearance({...f.event,sender:{}},'light'),/sender/);
});
