// Policies shared by the real ProseMirror adapter and small deterministic tests.
// Parsing belongs to Milkdown's configured Remark processor, not a second parser.
const supportedNodes = new Set(['root', 'paragraph', 'heading', 'text', 'emphasis', 'strong', 'delete',
  'inlineCode', 'code', 'blockquote', 'list', 'listItem', 'break', 'thematicBreak', 'link', 'image',
  'table', 'tableRow', 'tableCell', 'math', 'inlineMath']);

export function splitFrontmatter(value) {
  const raw = String(value ?? '');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const rest = raw.slice(bom.length);
  const first = /^(---|\+\+\+)[ \t]*(?:\r\n|\n|\r)/.exec(rest);
  if (!first) return { raw, prefix: bom, body: rest, supported: true, reason: '' };
  const delimiter = first[1];
  const tail = rest.slice(first[0].length);
  const endPattern = delimiter === '---' ? /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/m : /^\+\+\+[ \t]*(?:\r\n|\n|\r|$)/m;
  const end = endPattern.exec(tail);
  if (!end) return { raw, prefix: bom, body: rest, supported: false, reason: '文档开头的元数据尚未闭合，请在 Markdown 源码中继续编辑。' };
  const length = first[0].length + end.index + end[0].length;
  return { raw, prefix: bom + rest.slice(0, length), body: rest.slice(length), supported: true, reason: '' };
}

export function safeDocumentUrl(value, { image = false } = {}) {
  const url = String(value ?? '').trim();
  if (!url) return true; // An unfinished URL is an editable placeholder.
  if (/[\u0000-\u0020\u007f]/.test(url)) return false;
  if (url.startsWith('//') || url.startsWith('\\')) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return true;
  return image ? ['http', 'https'].includes(scheme) : ['http', 'https', 'mailto', 'tel'].includes(scheme);
}

export function diagnoseMarkdown(ast) {
  let reason = '';
  function visit(node, parent) {
    if (!node || reason) return;
    // Milkdown 7.22 serializes an empty paragraph as this attribute-free HTML
    // marker. Its remarkPreserveEmptyLinePlugin converts the marker back to an
    // empty paragraph (or an empty table cell) before ProseMirror parsing. Our
    // preflight sees processor.parse(), before that transform. Admit only the
    // same whole-node/sole-child positions, never inline or attributed HTML.
    const emptyLine = node.type === 'html' && /^<br\s*\/?\s*>$/i.test(String(node.value || '').trim())
      && (['root', 'blockquote', 'listItem'].includes(parent?.type)
        || (['paragraph', 'tableCell'].includes(parent?.type) && parent.children?.length === 1));
    if (emptyLine) return;
    if (!supportedNodes.has(node.type)) {
      reason = node.type === 'html' ? '这份文档包含 HTML，使用 Markdown 源码可完整保留这些内容。'
        : /footnote/i.test(node.type) ? '这份文档包含脚注，请使用 Markdown 源码编辑以保留引用。'
          : /reference|definition/i.test(node.type) ? '这份文档包含引用式链接，请使用 Markdown 源码编辑以保留定义。'
            : `这份文档包含可视编辑器暂不支持的语法（${String(node.type || '未知')}），请使用 Markdown 源码。`;
      return;
    }
    if (node.type === 'text' && (/!?\[\[[^\]\r\n]+(?:\]\]|$)/.test(node.value || '') || /^\s*:::/m.test(node.value || ''))) {
      reason = '这份文档包含 Wiki 链接或扩展块，请使用 Markdown 源码编辑以保留语法。'; return;
    }
    if ((node.type === 'link' || node.type === 'image') && !safeDocumentUrl(node.url, { image: node.type === 'image' })) {
      reason = '这份文档包含暂不支持的链接地址，请在 Markdown 源码中检查；原文已保留。'; return;
    }
    if (node.type === 'code' && node.meta) {
      reason = '代码围栏包含额外属性，请使用 Markdown 源码编辑以完整保留。'; return;
    }
    for (const child of node.children || []) visit(child, node);
  }
  visit(ast);
  return { supported: !reason, reason };
}

// Match text leaves in document order, including repeated phrases. We only map
// literal source runs; escapes/entities/normalized whitespace remain explicit gaps.
export function sourceTextMappings(body, ast, proseLeaves, prefixLength = 0) {
  const leaves = [];
  let astText = '';
  function visit(node) {
    if (!node || ['image', 'inlineMath', 'definition'].includes(node.type)) return;
    if (['text', 'inlineCode', 'code', 'math'].includes(node.type)) {
      const value = String(node.value ?? '');
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      let source = -1;
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const span = body.slice(start, end);
        if (span === value) source = start;
        else if (node.type !== 'text' && value) {
          const at = span.indexOf(value);
          if (at >= 0 && span.indexOf(value, at + 1) < 0) source = start + at;
        }
      }
      leaves.push({ start: astText.length, end: astText.length + value.length, source });
      astText += value;
      return;
    }
    for (const child of node.children || []) visit(child);
  }
  visit(ast);
  if (proseLeaves.map(x => x.text).join('') !== astText) return [];
  const result = [];
  let global = 0;
  let cursor = 0;
  for (const leaf of proseLeaves) {
    const end = global + leaf.text.length;
    while (cursor < leaves.length && leaves[cursor].end <= global) cursor++;
    for (let i = cursor; i < leaves.length && leaves[i].start < end; i++) {
      const match = leaves[i];
      if (match.source < 0) continue;
      const lo = Math.max(global, match.start), hi = Math.min(end, match.end);
      if (hi > lo) result.push({ from: leaf.pos + lo - global, to: leaf.pos + hi - global,
        start: prefixLength + match.source + lo - match.start, end: prefixLength + match.source + hi - match.start });
    }
    global = end;
  }
  return result;
}

export function mapProsePosition(mappings, position, bias = 1) {
  const entries = mappings.filter(item => position >= item.from && position <= item.to);
  const entry = bias < 0 ? entries[0] : entries[entries.length - 1];
  return entry ? entry.start + position - entry.from : null;
}

export function mapSourcePosition(mappings, position, bias = 1) {
  const entries = mappings.filter(item => position >= item.start && position <= item.end);
  const entry = bias < 0 ? entries[0] : entries[entries.length - 1];
  return entry ? entry.from + position - entry.start : null;
}
