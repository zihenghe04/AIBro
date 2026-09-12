const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/electron-main.js'), 'utf8');

function harness(choice) {
  const handlers = {}, appHandlers = {}, prompts = [];
  const context = vm.createContext({ nativeUI: { text: (zh) => zh }, mainWindow: { webContents: { on: (name, handler) => { handlers[name] = handler; } } }, dialog: { showMessageBoxSync: (_, options) => { prompts.push(options); return choice; } }, app: { on: (name, callback) => { appHandlers[name] = callback; } }, localServer: { killed: false, kill() { this.killed = true; } }, quitting: true });
  const start = source.indexOf("  mainWindow.webContents.on('will-prevent-unload'");
  vm.runInContext(source.slice(start, source.indexOf('  // Preserve the existing desktop origin', start)), context);
  vm.runInContext(source.slice(source.indexOf("app.on('will-quit'")), context);
  return { context, handlers, appHandlers, prompts };
}

test('Cancel in the native unsaved-note prompt keeps the app and backend running and permits a later quit attempt', () => {
  const h = harness(0), event = { preventDefault() { this.allowed = true; } };
  h.handlers['will-prevent-unload'](event);
  assert.equal(event.allowed, undefined); assert.equal(h.context.quitting, false);
  assert.equal(h.context.localServer.killed, false); assert.equal(h.prompts[0].defaultId, 0); assert.equal(h.prompts[0].cancelId, 0);
  assert.doesNotMatch(source.slice(source.indexOf("app.on('before-quit'"), source.indexOf("app.on('will-quit'")), /localServer\.kill\(/);
});
test('only explicit discard allows the renderer unload; backend stops at committed will-quit', () => {
  const h = harness(1), event = { preventDefault() { this.allowed = true; } };
  h.handlers['will-prevent-unload'](event); assert.equal(event.allowed, true); assert.equal(h.context.localServer.killed, false);
  h.appHandlers['will-quit'](); assert.equal(h.context.localServer.killed, true);
});
