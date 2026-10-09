// Textarea offsets are UTF-16 offsets. This module performs no DOM, persistence,
// navigation or network work; the controller owns IME, focus and undo history.
export const markdownCommands = Object.freeze([
  'h1', 'h2', 'h3', 'bold', 'italic', 'strike', 'link', 'quote',
  'bullet', 'number', 'checklist', 'code', 'code-block', 'rule',
]);
const aliases = { heading1: 'h1', heading2: 'h2', heading3: 'h3', 'inline-code': 'code' };
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const copy = (state, reason) => ({ ...state, changed: false, reason });
const result = (state, text, start, end) => ({ text, selectionStart: start, selectionEnd: end,
  selectionDirection: start === end ? 'none' : state.selectionDirection, changed: text !== state.text });
const replace = (state, start, end, value, selectionStart, selectionEnd) =>
  result(state, state.text.slice(0, start) + value + state.text.slice(end), selectionStart, selectionEnd);

function input(value) {
  if (!value || typeof value.text !== 'string') throw new TypeError('Markdown 文本必须是字符串');
  const { text, selectionStart: start, selectionEnd: end, selectionDirection = 'none' } = value;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length)
    throw new RangeError('Markdown 选区必须是文本内有序的 UTF-16 下标');
  if (!['none', 'forward', 'backward'].includes(selectionDirection)) throw new TypeError('Markdown 选区方向无效');
  return { text, selectionStart: start, selectionEnd: end, selectionDirection };
}

function safeBoundaries(text, start, end) {
  // Never silently widen a selection or split a CRLF, combining mark, surrogate
  // pair, flag, skin-tone sequence or ZWJ emoji. A controller can ask for reselection.
  if (!segmenter) return start === 0 && end === text.length;
  let foundStart = start === text.length, foundEnd = end === text.length;
  for (const part of segmenter.segment(text)) {
    if (part.index === start) foundStart = true;
    if (part.index === end) foundEnd = true;
    if (foundStart && foundEnd) return true;
    if (part.index > end) break;
  }
  return foundStart && foundEnd;
}

function lines(text) {
  const output = []; let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    output.push({ start, end: match.index, content: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  output.push({ start, end: text.length, content: text.slice(start), eol: '' });
  return output;
}

function lineRange(state) {
  const all = lines(state.text), at = position => {
    let index = 0;
    while (index + 1 < all.length && all[index + 1].start <= position) index++;
    return index;
  };
  const first = at(state.selectionStart), last = at(state.selectionEnd > state.selectionStart ? state.selectionEnd - 1 : state.selectionEnd);
  return { all, first, last, selected: all.slice(first, last + 1) };
}

function newline(state) {
  return state.text.match(/\r\n|\r|\n/)?.[0] || '\n';
}

function escaped(text, position) {
  let count = 0;
  while (position > 0 && text[--position] === '\\') count++;
  return count % 2 === 1;
}

function marked(text, start, end, marker) {
  const length = marker.length;
  if (text.slice(start, start + length) !== marker || text.slice(end - length, end) !== marker
      || end - start < length * 2 || escaped(text, start) || escaped(text, end - length)) return false;
  // A pair of strong-emphasis delimiters is not two independent italic wrappers.
  if (marker === '*') {
    const left = text.slice(start, end).match(/^\*+/)?.[0].length;
    const right = text.slice(start, end).match(/\*+$/)?.[0].length;
    return left !== 2 && right !== 2;
  }
  return true;
}

function emphasis(state, marker, placeholder) {
  const { text, selectionStart: start, selectionEnd: end } = state;
  const value = text.slice(start, end), width = marker.length;
  if (start >= width && marked(text, start - width, end + width, marker)
      && !(marker === '*' && (text[start - 2] === '*' && text[start - 3] !== '*' || text[end + 1] === '*' && text[end + 2] !== '*')))
    return replace(state, start - width, end + width, value, start - width, end - width);
  if (marked(value, 0, value.length, marker) && (!/[\r\n]/.test(value) || !value.slice(width, -width).includes(marker))) {
    const inner = value.slice(width, -width);
    return replace(state, start, end, inner, start, start + inner.length);
  }
  if (/\r|\n/.test(value)) {
    // Each selected nonblank line gets valid inline syntax. Blank paragraph
    // separators and every original EOL remain byte-for-byte unchanged.
    const parts = lines(value), nonblank = parts.filter(part => part.content.trim());
    if (!nonblank.length) return copy(state, 'blank-inline-selection');
    const remove = nonblank.every(part => {
      const body = part.content.trim(); return marked(body, 0, body.length, marker);
    });
    const changed = parts.map(part => {
      const leading = part.content.match(/^[\t ]*/)[0], trailing = part.content.match(/[\t ]*$/)[0];
      const body = part.content.slice(leading.length, part.content.length - trailing.length);
      if (!body) return part.content + part.eol;
      const wrapped = marked(body, 0, body.length, marker);
      return leading + (remove ? body.slice(width, -width) : wrapped ? body : marker + body + marker) + trailing + part.eol;
    }).join('');
    return replace(state, start, end, changed, start, start + changed.length);
  }
  const leading = value.match(/^[\t ]*/)[0], trailing = value ? value.match(/[\t ]*$/)[0] : '';
  if (value && !value.trim()) return copy(state, 'blank-inline-selection');
  const body = value ? value.slice(leading.length, value.length - trailing.length) : placeholder;
  const inserted = leading + marker + body + marker + trailing, selectedStart = start + leading.length + width;
  return replace(state, start, end, inserted, selectedStart, selectedStart + body.length);
}

function lineEdit(state, command) {
  const { selected } = lineRange(state), heading = /^h[123]$/.test(command), level = heading ? Number(command[1]) : null;
  const parsed = selected.map(line => {
    const indent = line.content.match(/^[\t ]*/)[0], body = line.content.slice(indent.length);
    const current = heading ? body.match(/^(#{1,6})[\t ]+/)
      : command === 'quote' ? body.match(/^>[\t ]?/)
      : body.match(/^(?:[-+*][\t ]+\[[ xX]\][\t ]+|[-+*][\t ]+|\d+[.)][\t ]+)/);
    const prefix = current?.[0] || '';
    const matches = heading ? current?.[1].length === level
      : command === 'quote' ? !!current
      : command === 'checklist' ? /^[-+*][\t ]+\[[ xX]\]/.test(prefix)
      : command === 'number' ? /^\d/.test(prefix) : !!prefix && !/\[|^\d/.test(prefix);
    return { ...line, indent, body, prefix, matches };
  });
  const nonblank = parsed.filter(line => line.body.trim()), remove = nonblank.length > 0 && nonblank.every(line => line.matches);
  let number = 0, placeholderRange = null;
  const transformed = parsed.map((line, index) => {
    if (!line.body.trim() && state.selectionStart !== state.selectionEnd) return line.content;
    const body = line.body.slice(line.prefix.length);
    let prefix;
    if (remove) prefix = '';
    else if (heading) prefix = '#'.repeat(level) + ' ';
    else if (command === 'quote') prefix = '> ';
    else if (command === 'number') prefix = ++number + '. ';
    else if (command === 'checklist') prefix = line.matches ? line.prefix : '- [ ] ';
    else prefix = '- ';
    const placeholder = !body && !remove ? heading ? '标题' : command === 'quote' ? '引用文字' : command === 'checklist' ? '待办事项' : '列表项' : '';
    if (placeholder) placeholderRange = { index, start: line.indent.length + prefix.length, length: placeholder.length };
    return line.indent + prefix + (body || placeholder);
  });
  const start = selected[0].start, end = selected.at(-1).end;
  const value = transformed.map((line, index) => line + (index + 1 < selected.length ? selected[index].eol : '')).join('');
  if (value === state.text.slice(start, end)) return copy(state, 'blank-block-selection');
  if (placeholderRange) {
    let offset = start;
    for (let i = 0; i < placeholderRange.index; i++) offset += transformed[i].length + selected[i].eol.length;
    return replace(state, start, end, value, offset + placeholderRange.start, offset + placeholderRange.start + placeholderRange.length);
  }
  if (state.selectionStart === state.selectionEnd) {
    const line = parsed[0], difference = transformed[0].length - line.content.length;
    const position = Math.max(start + line.indent.length, Math.min(start + transformed[0].length, state.selectionStart + difference));
    return replace(state, start, end, value, position, position);
  }
  return replace(state, start, end, value, start, start + value.length);
}

function code(state) {
  const { text, selectionStart: start, selectionEnd: end } = state, value = text.slice(start, end);
  if (/\r|\n/.test(value)) return copy(state, 'multiline-code-use-block');
  const before = text.slice(0, start).match(/(`+)( ?)$/), after = text.slice(end).match(/^( ?)(`+)/);
  if (before && after && before[1] === after[2] && before[2] === after[1] && !escaped(text, start - before[0].length))
    return replace(state, start - before[0].length, end + after[0].length, value, start - before[0].length, start - before[0].length + value.length);
  const enclosed = value.match(/^(`+)([\s\S]*?)\1$/);
  if (enclosed && enclosed[2] && !enclosed[2].startsWith('`') && !enclosed[2].endsWith('`')) {
    let body = enclosed[2];
    if (body.startsWith(' ') && body.endsWith(' ') && body.trim()) body = body.slice(1, -1);
    return replace(state, start, end, body, start, start + body.length);
  }
  const body = value || '代码', runs = [...body.matchAll(/`+/g)].map(match => match[0].length);
  const marker = '`'.repeat(Math.max(0, ...runs) + 1), padding = /^[` ]|[` ]$/.test(body) ? ' ' : '';
  const selectedStart = start + marker.length + padding.length;
  return replace(state, start, end, marker + padding + body + padding + marker, selectedStart, selectedStart + body.length);
}

function link(state) {
  const { text, selectionStart: start, selectionEnd: end } = state, value = text.slice(start, end);
  if (/\r|\n/.test(value)) return copy(state, 'multiline-link-label');
  const full = value.match(/^\[([^\[\]\r\n]*)\]\([^\r\n]*\)$/);
  if ((full && text[start - 1] === '!') || (text[start - 1] === '[' && text[start - 2] === '!'))
    return copy(state, 'image-link-context');
  if (full) return replace(state, start, end, full[1], start, start + full[1].length);
  const tail = text.slice(end).match(/^\]\([^\r\n)]*\)/);
  if (start > 0 && text[start - 1] === '[' && !escaped(text, start - 1) && tail)
    return replace(state, start - 1, end + tail[0].length, value, start - 1, end - 1);
  // Do not manufacture malformed Markdown from an ambiguous nested label.
  if (/[\[\]\\]/.test(value)) return copy(state, 'ambiguous-link-label');
  const label = value || '链接文字';
  return replace(state, start, end, '[' + label + '](https://)', start + 1, start + 1 + label.length);
}

function fence(state) {
  const { all, first, last, selected } = lineRange(state);
  const opening = line => line?.content.match(/^(`{3,}|~{3,})([^`\r\n]*)$/);
  const paired = (open, close) => {
    const match = opening(open);
    return !!match && !!close && new RegExp('^' + match[1][0] + '{' + match[1].length + ',}[\\t ]*$').test(close.content);
  };
  let openIndex = first, closeIndex = last;
  if (!(first < last && paired(all[first], all[last]))) { openIndex = first - 1; closeIndex = last + 1; }
  if (openIndex >= 0 && closeIndex < all.length && paired(all[openIndex], all[closeIndex])) {
    const start = all[openIndex].start, end = all[closeIndex].end;
    const body = state.text.slice(all[openIndex].end + all[openIndex].eol.length, all[closeIndex - 1].end);
    return replace(state, start, end, body, start, start + body.length);
  }
  const start = selected[0].start, end = selected.at(-1).end;
  const original = state.text.slice(start, end), body = original || '代码';
  const width = Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1));
  const marker = '`'.repeat(width), eol = newline(state), offset = start + marker.length + eol.length;
  return replace(state, start, end, marker + eol + body + eol + marker, offset, offset + body.length);
}

function rule(state) {
  const { selected } = lineRange(state), last = selected.at(-1);
  if (/^[\t ]*(?:-{3,}|\*{3,}|_{3,})[\t ]*$/.test(last.content)) return copy(state, 'already-rule');
  // A divider never deletes a selected paragraph: insert after its final line.
  const at = last.end, before = state.text.slice(0, at), after = state.text.slice(at), eol = newline(state);
  const count = sequence => sequence?.match(/\r\n|\r|\n/g).length || 0;
  const beforeBreaks = count(before.match(/[\r\n]+$/)?.[0]), afterBreaks = count(after.match(/^[\r\n]+/)?.[0]);
  const gapBefore = !before || beforeBreaks >= 2 ? '' : beforeBreaks === 1 ? eol : eol + eol;
  const gapAfter = afterBreaks >= 2 ? '' : afterBreaks === 1 ? eol : eol + eol;
  const inserted = gapBefore + '---' + gapAfter, position = at + inserted.length;
  return replace(state, at, at, inserted, position, position);
}

/**
 * Format a textarea selection, using UTF-16 indices and preserving its direction.
 * Inline edits select their body; block edits select affected complete lines.
 * A collapsed block edit retains its caret, or selects a new placeholder.
 * Existing delimiters/prefixes toggle off; selecting exactly to the next line's
 * start does not modify that line. Newlines already present are never normalized.
 *
 * No-op returns changed:false + reason for unknown commands, split grapheme/CRLF
 * boundaries, blank text, image/ambiguous/multiline link labels, multiline inline
 * code (use code-block), or an existing rule. Invalid argument shapes throw before
 * editing. Input objects are never changed. No markup is rendered or executed.
 */
export function applyMarkdownEdit(value, requestedCommand) {
  const state = input(value), command = aliases[requestedCommand] || requestedCommand;
  if (!markdownCommands.includes(command)) return copy(state, 'unsupported-command');
  if (!safeBoundaries(state.text, state.selectionStart, state.selectionEnd)) return copy(state, 'invalid-grapheme-boundary');
  if (command === 'bold') return emphasis(state, '**', '加粗文字');
  if (command === 'italic') return emphasis(state, '*', '斜体文字');
  if (command === 'strike') return emphasis(state, '~~', '删除线文字');
  if (command === 'code') return code(state);
  if (command === 'link') return link(state);
  if (command === 'code-block') return fence(state);
  if (command === 'rule') return rule(state);
  return lineEdit(state, command);
}
