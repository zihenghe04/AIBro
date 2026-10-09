import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { applyMarkdownEdit, markdownCommands } from '../src/markdown-edit.js';

const edit = (text, command, start = 0, end = text.length, direction = 'forward') =>
  applyMarkdownEdit({ text, selectionStart: start, selectionEnd: end, selectionDirection: direction }, command);
const selected = result => result.text.slice(result.selectionStart, result.selectionEnd);
const again = (result, command) => applyMarkdownEdit(result, command);

test('every toolbar command inserts usable Markdown into an empty textarea', () => {
  const expected = {
    h1: '# 标题', h2: '## 标题', h3: '### 标题', bold: '**加粗文字**', italic: '*斜体文字*', strike: '~~删除线文字~~',
    link: '[链接文字](https://)', quote: '> 引用文字', bullet: '- 列表项', number: '1. 列表项', checklist: '- [ ] 待办事项',
    code: '`代码`', 'code-block': '```\n代码\n```', rule: '---\n\n',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...markdownCommands].sort());
  for (const [command, value] of Object.entries(expected)) {
    const output = edit('', command);
    assert.equal(output.text, value, command); assert.equal(output.changed, true, command);
    assert.ok(output.selectionStart <= output.selectionEnd && output.selectionEnd <= value.length);
    if (command !== 'rule') assert.ok(selected(output).length > 0, command + ' placeholder is selected');
  }
});

test('inline edits and immediate toggle preserve Chinese, emoji, unrelated bytes and backwards selection', () => {
  const body = '中文👩🏽‍💻', prefix = '前文 ', suffix = ' 后文\r\n下一段';
  for (const command of ['bold', 'italic', 'strike', 'code', 'link']) {
    const source = prefix + body + suffix;
    const output = edit(source, command, prefix.length, prefix.length + body.length, 'backward');
    assert.ok(output.text.startsWith(prefix)); assert.ok(output.text.endsWith(suffix));
    assert.equal(selected(output), body); assert.equal(output.selectionDirection, 'backward');
    const restored = again(output, command);
    assert.equal(restored.text, source, command); assert.equal(selected(restored), body);
    assert.equal(restored.selectionStart, prefix.length); assert.equal(restored.selectionDirection, 'backward');
  }
});

test('selecting complete wrappers removes them without deleting content', () => {
  for (const [command, text] of [['bold', '**事实**'], ['italic', '*事实*'], ['strike', '~~事实~~'], ['code', '`事实`'], ['link', '[事实](https://example.test/a)']]) {
    const output = edit(text, command);
    assert.equal(output.text, '事实', command); assert.equal(selected(output), '事实');
  }
  assert.equal(edit('**事实**', 'italic').text, '***事实***');
  assert.equal(edit('***事实***', 'italic').text, '**事实**');
  assert.equal(edit('***事实***', 'bold').text, '*事实*');
  assert.equal(edit('**事实**', 'italic', 2, 4).text, '***事实***');
});

test('inline whitespace stays outside delimiters; an empty caret inserts a replaceable placeholder', () => {
  const value = edit('前  中文  后', 'bold', 1, 7);
  assert.equal(value.text, '前  **中文**  后'); assert.equal(selected(value), '中文');
  const empty = edit('前后', 'bold', 1, 1);
  assert.equal(empty.text, '前**加粗文字**后'); assert.equal(selected(empty), '加粗文字');
  const spaces = edit('  ', 'italic');
  assert.equal(spaces.text, '  '); assert.equal(spaces.reason, 'blank-inline-selection');
});

test('multiline emphasis uses independent valid wrappers while preserving blank lines and CRLF', () => {
  const source = '  第一行👨‍👩‍👧‍👦  \r\n\r\n第二行\n尾行';
  for (const [command, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~']]) {
    const output = edit(source, command, 0, source.length, 'backward');
    assert.equal(output.text, `  ${marker}第一行👨‍👩‍👧‍👦${marker}  \r\n\r\n${marker}第二行${marker}\n${marker}尾行${marker}`);
    assert.equal(again(output, command).text, source);
    assert.equal(output.selectionDirection, 'backward');
  }
});

test('multiline selection ending at next line start does not format that next line', () => {
  const source = '甲\r\n乙\r\n丙';
  assert.equal(edit(source, 'h2', 0, 3).text, '## 甲\r\n乙\r\n丙');
  assert.equal(edit(source, 'quote', 3, 3).text, '甲\r\n> 乙\r\n丙');
  assert.equal(edit(source, 'bullet', 3, 6).text, '甲\r\n- 乙\r\n丙');
  assert.equal(edit('甲\n', 'h1', 0, 2).text, '# 甲\n');
  const eof = edit('甲\n', 'h1', 2, 2);
  assert.equal(eof.text, '甲\n# 标题'); assert.equal(selected(eof), '标题');
});

test('headings replace the existing level and toggle uniformly across selected lines', () => {
  const output = edit('# 甲\r\n### 乙\r\n丙', 'h2');
  assert.equal(output.text, '## 甲\r\n## 乙\r\n## 丙');
  assert.equal(again(output, 'h2').text, '甲\r\n乙\r\n丙');
  const caret = edit('标题正文', 'h3', 2, 2);
  assert.equal(caret.text, '### 标题正文'); assert.equal(caret.selectionStart, 6); assert.equal(caret.selectionEnd, 6);
  assert.equal(again(caret, 'h3').text, '标题正文');
  assert.equal(edit('内容', 'heading1').text, '# 内容');
});

test('lists convert existing markers, preserve indentation and check state, and never create task records', () => {
  const checklist = edit('- [x] 已完成\r\n  2. 待处理\r\n\r\n+ 下一项', 'checklist');
  assert.equal(checklist.text, '- [x] 已完成\r\n  - [ ] 待处理\r\n\r\n- [ ] 下一项');
  assert.equal(again(checklist, 'checklist').text, '已完成\r\n  待处理\r\n\r\n下一项');
  const numbers = edit('- 甲\n\n  - [X] 乙\n丙', 'number');
  assert.equal(numbers.text, '1. 甲\n\n  2. 乙\n3. 丙');
  assert.equal(again(numbers, 'number').text, '甲\n\n  乙\n丙');
  assert.equal(edit('1) 甲\n2. 乙', 'bullet').text, '- 甲\n- 乙');
});

test('quotes toggle one level without disturbing nested quotes or unrelated lines', () => {
  assert.equal(edit('> 甲\n>> 乙', 'quote').text, '甲\n> 乙');
  assert.equal(edit('> 甲\n乙', 'quote').text, '> 甲\n> 乙');
  const source = '前\n甲\n乙\n后', output = edit(source, 'quote', 2, 5, 'backward');
  assert.equal(output.text, '前\n> 甲\n> 乙\n后');
  assert.equal(output.selectionDirection, 'backward');
  assert.equal(again(output, 'quote').text, source);
});

test('inline code grows its delimiter around backticks and toggles the selected original payload', () => {
  for (const body of ['a`b', '`边缘', '末尾`', '  空格内容 ', '👩🏽‍💻']) {
    const output = edit(body, 'code');
    assert.equal(selected(output), body);
    assert.equal(again(output, 'code').text, body);
    assert.match(marked.parse(output.text), /<code>/);
  }
  assert.equal(edit('甲\r\n乙', 'code').reason, 'multiline-code-use-block');
  assert.equal(edit('内容', 'inline-code').text, '`内容`');
});

test('code blocks preserve selected full lines, mixed EOLs and surrounding text; safe fences cannot close inside code', () => {
  const body = '第一行\r\n```\r\n末行', source = '前文\r\n' + body + '\r\n后文';
  const output = edit(source, 'code-block', 4, 4 + body.length);
  assert.equal(output.text, '前文\r\n````\r\n' + body + '\r\n````\r\n后文');
  assert.equal(selected(output), body); assert.equal(again(output, 'code-block').text, source);
  const tokens = marked.lexer(output.text).filter(token => token.type === 'code');
  assert.equal(tokens.length, 1); assert.equal(tokens[0].text, body.replaceAll('\r\n', '\n'));
  assert.equal(edit('```js\nconst x = 1;\n```', 'code-block').text, 'const x = 1;');
  assert.equal(edit('~~~\r\n代码\r\n~~~', 'code-block').text, '代码');
});

test('links insert only a literal HTTPS placeholder and can be removed via selected label or full syntax', () => {
  const output = edit('资料名称', 'link');
  assert.equal(output.text, '[资料名称](https://)'); assert.equal(selected(output), '资料名称');
  assert.equal(again(output, 'link').text, '资料名称');
  assert.equal(edit('javascript:alert(1)', 'link').text, '[javascript:alert(1)](https://)');
  assert.equal(edit('甲\n乙', 'link').reason, 'multiline-link-label');
  assert.equal(edit('![图片](https://example.test/a.png)', 'link', 2, 4).reason, 'image-link-context');
  for (const text of ['[未配对', 'a]b', '\\[字]']) {
    const blocked = edit(text, 'link'); assert.equal(blocked.text, text); assert.equal(blocked.reason, 'ambiguous-link-label');
  }
});

test('a rule preserves selected prose and inserts blank lines, including CRLF boundaries', () => {
  const output = edit('第一段\r\n后段', 'rule', 0, 3);
  assert.equal(output.text, '第一段\r\n\r\n---\r\n\r\n后段');
  const tokens = marked.lexer(output.text);
  assert.equal(tokens.filter(token => token.type === 'hr').length, 1);
  assert.equal(tokens.filter(token => token.type === 'heading').length, 0);
  assert.equal(edit('第一段\r\n', 'rule', 5, 5).text, '第一段\r\n\r\n---\r\n\r\n');
  assert.equal(edit('---', 'rule').reason, 'already-rule');
});

test('split grapheme, surrogate, combining-mark and CRLF selections are explicit no-ops', () => {
  for (const [text, start, end] of [
    ['A😀B', 1, 2], ['A😀B', 2, 2], ['A👩🏽‍💻B', 3, 3], ['A🇨🇳B', 1, 3],
    ['Ae\u0301B', 1, 2], ['甲\r\n乙', 2, 2], ['甲\r\n乙', 0, 2],
  ]) for (const command of markdownCommands) {
    const output = edit(text, command, start, end, 'backward');
    assert.equal(output.text, text, command); assert.equal(output.changed, false);
    assert.equal(output.selectionStart, start); assert.equal(output.selectionEnd, end);
    assert.equal(output.selectionDirection, 'backward'); assert.equal(output.reason, 'invalid-grapheme-boundary');
  }
});

test('complete grapheme selections remain valid output offsets for every command', () => {
  for (const text of ['中文', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301']) {
    for (const command of markdownCommands) {
      const output = edit(text, command);
      assert.ok(output.text.includes(text), command);
      assert.equal(output.text.isWellFormed(), true, command);
      const boundaries = new Set([output.text.length, ...[...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(output.text)].map(part => part.index)]);
      assert.ok(boundaries.has(output.selectionStart)); assert.ok(boundaries.has(output.selectionEnd));
    }
  }
});

test('invalid inputs reject before editing; unknown commands and blank blocks preserve exact state', () => {
  const input = Object.freeze({ text: '原文', selectionStart: 0, selectionEnd: 2, selectionDirection: 'backward' });
  assert.equal(applyMarkdownEdit(input, 'unknown').reason, 'unsupported-command');
  assert.deepEqual(input, { text: '原文', selectionStart: 0, selectionEnd: 2, selectionDirection: 'backward' });
  for (const changes of [{ text: 42 }, { selectionStart: -1 }, { selectionEnd: 3 }, { selectionStart: 2, selectionEnd: 1 }, { selectionStart: 0.5 }, { selectionDirection: 'sideways' }])
    assert.throws(() => applyMarkdownEdit({ ...input, ...changes }, 'bold'));
  const blank = edit(' \r\n\t', 'h1');
  assert.equal(blank.text, ' \r\n\t'); assert.equal(blank.changed, false); assert.equal(blank.reason, 'blank-block-selection');
});
