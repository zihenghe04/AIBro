const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
test('the island voice panel footer reads the configured voice-command shortcut and mode, never a literal key', () => {
  const view = read('native/Sources/AIBro/NativeVoiceCommandPanel.swift');
  const footer = view.slice(view.indexOf('private var footer'), view.indexOf('var body'));
  assert.match(footer, /shortcut\.shortcut\.label/);
  assert.match(footer, /shortcut\.mode == \.hold/);
  assert.doesNotMatch(footer, /⌥|⌘|⇧|⌃|右侧/);
  assert.match(view, /@ObservedObject var shortcut:NativeSpeechShortcutStore/, 'observed, so a change updates the open panel');
});
test('the dictate trigger and the voice-command shortcut are described as two different things', () => {
  const pages = read('app/settings-pages.js');
  assert.match(pages, /不会打开灵动岛的语音面板/);
  assert.match(pages, /不会往其他应用里打字/);
  assert.match(pages, /does not open the island voice panel/);
  assert.match(pages, /does not type into other apps/);
});
