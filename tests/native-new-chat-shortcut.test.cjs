'use strict';
// ⌘N 只由菜单「新对话」承担；工具栏按钮不再重复注册同一快捷键。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const main=fs.readFileSync(path.join(__dirname,'../native/Sources/AIBro/AIBro.swift'),'utf8');
test('⌘N is bound exactly once, on the File menu command',()=>{
 const bindings=main.match(/\.keyboardShortcut\("n"\)/g)||[];
 assert.equal(bindings.length,1,'one ⌘N binding');
 assert.match(main,/CommandGroup\(replacing:\.newItem\)\{Button\(nativeUI\("新对话", "New chat"\)\)\{model\.command\("new"\)\}\.keyboardShortcut\("n"\)/);
 assert.match(main,/ToolbarItem \{ Button \{ model\.command\("new"\) \}[^\n]*\.help\(nativeUI\("新对话 ⌘N"/,'the toolbar button still advertises the shortcut');
});
