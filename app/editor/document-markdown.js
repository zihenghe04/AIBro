import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { decodeString } from 'micromark-util-decode-string';
import katex from 'katex';
import { splitFrontmatter } from './visual-policy.mjs';

// This synchronous, document-only renderer deliberately does not own streaming
// chat state. Parse Markdown once, then render against the current access scope.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
let recent = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const localImage = value => typeof value === 'string' && !/[\u0000-\u0020\u007f\\]/.test(value)
  && (/^\/__files\/[A-Za-z0-9_-]+$/.test(value) || /^\/__local\/document-images\/read\?[^#]+$/.test(value));
const plain = node => typeof node.value === 'string' ? node.value : node.type === 'image' || node.type === 'imageReference' ? node.alt || '' : (node.children || []).map(plain).join('');
const slug = value => String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
const prefix = value => 'dm-' + (String(value || 'document').normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'document');
function visit(node, callback) { callback(node); for (const child of node.children || []) visit(child, callback); }
function parsed(value) {
  const raw = String(value ?? '');
  if (recent?.raw === raw) return recent;
  const split = splitFrontmatter(raw);
  const ast = parser.parse(split.body), headingNodes = [], definitions = new Map(), footnotes = new Map();
  visit(ast, node => {
    if (node.type === 'heading') headingNodes.push(node);
    if (node.type === 'definition' && !definitions.has(normalize(node.identifier))) definitions.set(normalize(node.identifier), node);
    if (node.type === 'footnoteDefinition' && !footnotes.has(normalize(node.identifier))) footnotes.set(normalize(node.identifier), node);
  });
  const metadata = split.prefix.replace(/^\uFEFF/, '');
  recent = { raw, body: split.body, offset: split.prefix.length, ast, headingNodes, definitions, footnotes,
    frontmatter: metadata ? { format: metadata.startsWith('+++') ? 'toml' : 'yaml', raw: metadata, start: raw.startsWith('\uFEFF') ? 1 : 0, end: split.prefix.length } : null };
  return recent;
}
function headingRecords(document, idPrefix) {
  const used = new Set(), byNode = new Map(), byFragment = new Map();
  const items = document.headingNodes.map(node => {
    const title = plain(node), base = slug(title); let fragment = base, count = 0;
    while (used.has(fragment)) fragment = `${base}-${++count}`;
    used.add(fragment);
    const item = { id: `${prefix(idPrefix)}-heading-${fragment}`, depth: node.depth, text: title,
      start: document.offset + (node.position?.start?.offset || 0), end: document.offset + (node.position?.end?.offset || 0) };
    byNode.set(node, item); byFragment.set(fragment, item.id);
    return item;
  });
  return { items, byNode, byFragment };
}
export function headings(text, options = {}) {
  return headingRecords(parsed(text), options.idPrefix).items;
}
const anchorId = (heading, fragment) => heading.byFragment.get(fragment) || heading.byFragment.get(slug(fragment)) || heading.items.find(item => item.id === fragment)?.id || null;
// Fragment is already decoded by the link owner. Share the renderer's slug and
// duplicate-heading rules without interpreting it as another URL.
export function resolveFragment(text, fragment, options = {}) {
  return typeof fragment === 'string' ? anchorId(headingRecords(parsed(text), options.idPrefix), fragment) : null;
}
function safeExternal(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    if (['http:', 'https:'].includes(url.protocol) && (!url.hostname || url.username || url.password)) return null;
    return value;
  } catch (_) { return null; }
}
export function renderWithMetadata(text, options = {}) {
  const document = parsed(text), heading = headingRecords(document, options.idPrefix), images = [], warnings = [];
  const warned = new Set(), usedFootnotes = [], footnoteRecords = new Map();
  const warn = code => { if (!warned.has(code)) { warned.add(code); warnings.push(code); } };
  function trusted(callback, args) {
    if (typeof callback !== 'function') return null;
    try { const value = callback(...args); return typeof value === 'string' && value ? value : null; }
    catch (_) { warn('renderer-callback-failed'); return null; }
  }
  function resolve(callback, value) {
    if (typeof callback !== 'function') return null;
    try { return callback(value); } catch (_) { warn('resolver-failed'); return null; }
  }
  function link(url, label, title) {
    if (typeof url === 'string' && url.startsWith('#aibro-source-')) {
      const context = options.documentSource, source = resolve(options.resolveDocumentSource, url);
      if (source && ['import', 'note', 'paper', 'task', 'local'].includes(source.type)
        && typeof context?.noteId === 'string' && context.noteId && !/[\u0000-\u001f\u007f]/.test(context.noteId)
        && ['body', 'draft'].includes(context.variant) && !/[\u0000-\u0020\u007f\\]/.test(url)) {
        const english = globalThis.WorkstationI18n?.getLanguage?.() === 'en';
        const number = label.replace(/<[^>]*>/g, ''), page = Number.isSafeInteger(source.page) && source.page > 0 ? (english ? `, page ${source.page}` : `，第 ${source.page} 页`) : '';
        const accessible = (english ? `Open source ${number}: ` : `查看来源 ${number}：`) + String(source.title || (english ? 'Source' : '来源')) + page;
        return `<button type="button" class="citation-chip document-source-link" data-document-source-href="${escape(url)}" data-document-source-note="${escape(context.noteId)}" data-document-source-variant="${context.variant}" aria-label="${escape(accessible)}"${title ? ` title="${escape(title)}"` : ''}>${label}</button>`;
      }
      warn('unavailable-citation');
      return `<span class="document-unavailable-link" title="引用来源已不可用">${label}</span>`;
    }
    if (typeof url === 'string' && url.startsWith('#') && !/[\u0000-\u0020\u007f\\]/.test(url)) {
      let fragment;
      try { fragment = decodeURIComponent(url.slice(1)); } catch (_) { fragment = url.slice(1); }
      const id = anchorId(heading, fragment);
      if (id) return `<a class="document-anchor-link" data-document-anchor="${escape(id)}" href="#${escape(id)}"${title ? ` title="${escape(title)}"` : ''}>${label}</a>`;
      return `<span class="document-unavailable-link"${title ? ` title="${escape(title)}"` : ''}>${label}</span>`;
    }
    const documentLink = resolve(options.resolveDocumentLink, url);
    if (documentLink && typeof documentLink.path === 'string' && documentLink.path
      && !/[\u0000-\u001f\u007f\\%?#]/.test(documentLink.path) && !/^[a-z][a-z\d+.-]*:/i.test(documentLink.path)
      && !documentLink.path.split('/').some(part => !part || part === '.' || part === '..')
      && (documentLink.fragment == null || typeof documentLink.fragment === 'string' && !/[\u0000-\u001f\u007f]/.test(documentLink.fragment))) {
      return `<button type="button" class="wiki-inline-link document-local-link" data-document-local-path="${escape(documentLink.path)}"${documentLink.fragment == null ? '' : ` data-document-fragment="${escape(documentLink.fragment)}"`}${title ? ` title="${escape(title)}"` : ''}>${label}</button>`;
    }
    const resolved = resolve(options.resolveLink, url);
    if (resolved && ['note', 'import', 'conversation'].includes(resolved.kind) && typeof resolved.id === 'string' && resolved.id && !/[\u0000-\u001f\u007f]/.test(resolved.id)) {
      return `<button type="button" class="wiki-inline-link" data-open-${resolved.kind}="${escape(resolved.id)}"${title ? ` title="${escape(title)}"` : ''}>${label}</button>`;
    }
    const safe = safeExternal(url);
    if (safe) return `<a href="${escape(safe)}"${/^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : ''}${title ? ` title="${escape(title)}"` : ''}>${label}</a>`;
    warn('unavailable-link');
    return `<span class="document-unavailable-link" title="链接暂不可用">${label}</span>`;
  }
  function image(node, definition = node) {
    const url = String(definition.url || ''), rawAlt = String(node.alt || '');
    const alt = definition.title && /^\d+(?:\.\d+)?$/.test(rawAlt) ? String(definition.title) : rawAlt;
    const resolved = resolve(options.resolveImage, url), available = localImage(resolved);
    images.push({ url, alt, available });
    if (!available) {
      warn('unavailable-image');
      return `<span class="document-image-unavailable" role="img" aria-label="${escape(alt || '图片')}：暂不可用">${escape(alt || '图片')}<span class="document-image-unavailable-status"> · 图片暂不可用</span></span>`;
    }
    return `<img class="document-managed-image" loading="lazy" decoding="async" alt="${escape(alt)}" src="${escape(resolved)}"${definition.title ? ` title="${escape(definition.title)}"` : ''}>`;
  }
  function renderText(node, context) {
    const value = node.value || '', raw = document.body.slice(node.position?.start?.offset || 0, node.position?.end?.offset || 0);
    if (context.inLink) return escape(value);
    const pattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]|\[(note|task|project):([A-Za-z0-9_-]{1,256})\]/g;
    // Decode disjoint authored segments once, not the whole preceding paragraph
    // for every reference. This also keeps long reference lists linear in size.
    const authoredTokens = new Map();
    let rawCursor = 0, decodedCursor = 0;
    for (const token of raw.matchAll(pattern)) {
      const end = token.index + token[0].length;
      decodedCursor += decodeString(raw.slice(rawCursor, end)).replace(/\r\n?/g, '\n').length;
      let slashes = 0; for (let i = token.index - 1; i >= 0 && raw[i] === '\\'; i--) slashes++;
      if (!(slashes % 2)) authoredTokens.set(decodedCursor - token[0].length, token[0]);
      rawCursor = end;
    }
    let html = '', cursor = 0;
    for (const match of value.matchAll(pattern)) {
      html += escape(value.slice(cursor, match.index));
      // CommonMark decodes escapes/entities in text nodes. Match the authored
      // position as well as the decoded text so an escaped example cannot borrow
      // a later, genuinely authored reference's permission to become a link.
      const authored = authoredTokens.get(match.index) === match[0];
      if (match[3]) {
        if (authored && typeof options.resolveReference === 'function') {
          const kind = match[3], id = match[4], resolved = resolve(options.resolveReference, `${kind}:${id}`);
          const english = globalThis.WorkstationI18n?.getLanguage?.() === 'en';
          const noun = ({ note: english ? 'Note' : '笔记', task: english ? 'Task' : '任务', project: english ? 'Project' : '项目' })[kind];
          if (resolved?.kind === kind && resolved.id === id && typeof resolved.title === 'string') {
            const title = resolved.title.trim() || noun;
            html += `<button type="button" class="wiki-inline-link document-record-link" data-open-${kind}="${escape(id)}" aria-label="${escape(english ? `Open ${noun.toLowerCase()}: ${title}` : `打开${noun}：${title}`)}">${escape(title)}</button>`;
          } else {
            warn('unavailable-reference');
            html += `<span class="document-unavailable-link">${escape(english ? `${noun} unavailable` : `${noun}不可用`)}</span>`;
          }
        } else html += escape(match[0]);
        cursor = match.index + match[0].length;
        continue;
      }
      const target = match[1].trim();
      // Escaped Wiki examples remain literal. Only plain text AST nodes enter
      // here, so inline code, fenced code and raw HTML never become Wiki links.
      const resolved = authored && target ? resolve(options.resolveLink, target) : null;
      if (resolved && ['note', 'import', 'conversation'].includes(resolved.kind) && typeof resolved.id === 'string' && resolved.id && !/[\u0000-\u001f\u007f]/.test(resolved.id)) {
        html += `<button type="button" class="wiki-inline-link" data-open-${resolved.kind}="${escape(resolved.id)}">${escape(match[2] || match[1])}</button>`;
      } else html += escape(match[0]);
      cursor = match.index + match[0].length;
    }
    return html + escape(value.slice(cursor));
  }
  function math(node, block) {
    const callback = block ? options.blockMath : options.inlineMath;
    if (typeof callback === 'function') {
      const rendered = trusted(callback, [node.value]);
      return rendered || `<${block ? 'pre' : 'code'} class="document-math-source">${escape(node.value)}</${block ? 'pre' : 'code'}>`;
    }
    try {
      return katex.renderToString(node.value, { displayMode: block, trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 30, output: 'htmlAndMathml' });
    } catch (_) {
      warn('math-render-failed');
      return `<${block ? 'pre' : 'code'} class="document-math-source">${escape(node.value)}</${block ? 'pre' : 'code'}>`;
    }
  }
  function footnote(node) {
    const key = normalize(node.identifier);
    if (!document.footnotes.has(key)) return escape(`[^${node.label || node.identifier}]`);
    let record = footnoteRecords.get(key);
    if (!record) { record = { key, number: usedFootnotes.length + 1, refs: [] }; usedFootnotes.push(record); footnoteRecords.set(key, record); }
    const id = `${prefix(options.idPrefix)}-fnref-${record.number}-${record.refs.length + 1}`;
    record.refs.push(id);
    return `<sup class="document-footnote-reference"><a id="${id}" data-document-anchor="${prefix(options.idPrefix)}-fn-${record.number}" href="#${prefix(options.idPrefix)}-fn-${record.number}" aria-label="脚注 ${record.number}">${record.number}</a></sup>`;
  }
  function children(node, context = {}, depth = 0) { return (node.children || []).map(child => renderNode(child, context, depth + 1)).join(''); }
  function renderNode(node, context = {}, depth = 0) {
    if (depth > 128) {
      warn('deep-markdown-fallback');
      return escape(document.body.slice(node.position?.start?.offset || 0, node.position?.end?.offset || 0));
    }
    switch (node.type) {
      case 'root': return children(node, context, depth);
      case 'text': return renderText(node, context);
      case 'paragraph': return context.tight ? children(node, context, depth) : `<p>${children(node, context, depth)}</p>`;
      case 'heading': { const item = heading.byNode.get(node); return `<h${node.depth} id="${escape(item.id)}" data-document-source-start="${item.start}">${children(node, {}, depth)}</h${node.depth}>`; }
      case 'emphasis': return `<em>${children(node, context, depth)}</em>`;
      case 'strong': return `<strong>${children(node, context, depth)}</strong>`;
      case 'delete': return `<del>${children(node, context, depth)}</del>`;
      case 'break': return '<br>';
      case 'thematicBreak': return '<hr>';
      case 'blockquote': return `<blockquote>${children(node, {}, depth)}</blockquote>`;
      case 'inlineCode': return `<code>${escape(node.value)}</code>`;
      case 'code': {
        const language = typeof node.lang === 'string' && /^[a-zA-Z0-9_+-]{1,40}$/.test(node.lang) ? node.lang : '';
        const highlighted = trusted(options.highlight, [node.value, language]);
        return `<pre class="message-code document-markdown-code document-code" data-document-code><code${language ? ` data-language="${escape(language)}" class="language-${escape(language)}"` : ''}>${highlighted || escape(node.value)}</code></pre>`;
      }
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul', task = node.children.some(item => typeof item.checked === 'boolean');
        return `<${tag}${node.ordered && Number.isInteger(node.start) && node.start !== 1 ? ` start="${node.start}"` : ''}${task ? ' class="markdown-task-list"' : ''}>${children(node, { tight: !node.spread }, depth)}</${tag}>`;
      }
      case 'listItem': return `<li${typeof node.checked === 'boolean' ? ' class="markdown-task-item"' : ''}>${typeof node.checked === 'boolean' ? `<input type="checkbox" disabled${node.checked ? ' checked' : ''} aria-label="${node.checked ? '已完成' : '未完成'}"> ` : ''}${children(node, { tight: context.tight && !node.spread }, depth)}</li>`;
      case 'link': return link(node.url, children(node, { ...context, inLink: true }, depth), node.title);
      case 'linkReference': { const definition = document.definitions.get(normalize(node.identifier)); return definition ? link(definition.url, children(node, { ...context, inLink: true }, depth), definition.title) : escape(document.body.slice(node.position.start.offset, node.position.end.offset)); }
      case 'image': return image(node);
      case 'imageReference': { const definition = document.definitions.get(normalize(node.identifier)); return definition ? image(node, definition) : escape(document.body.slice(node.position.start.offset, node.position.end.offset)); }
      case 'definition': case 'footnoteDefinition': return '';
      case 'footnoteReference': return context.inLink ? escape(`[^${node.label || node.identifier}]`) : footnote(node);
      case 'html': return /^<br\s*\/?\s*>$/i.test(node.value.trim()) ? '<br>' : `<span class="document-html-source">${escape(node.value)}</span>`;
      case 'inlineMath': return math(node, false);
      case 'math': return math(node, true);
      case 'table': {
        const rows = node.children || [], width = rows[0]?.children?.length || 0;
        const row = (item, header) => `<tr>${Array.from({ length: width }, (_, index) => {
          const tag = header ? 'th' : 'td', align = ['left', 'center', 'right'].includes(node.align?.[index]) ? node.align[index] : 'left';
          return `<${tag}${header ? ' scope="col"' : ''} style="text-align:${align}">${item.children?.[index] ? children(item.children[index], {}, depth) : ''}</${tag}>`;
        }).join('')}</tr>`;
        return `<div class="markdown-table-scroll"><table>${rows.length ? `<thead>${row(rows[0], true)}</thead><tbody>${rows.slice(1).map(item => row(item, false)).join('')}</tbody>` : ''}</table></div>`;
      }
      default: warn('unknown-markdown-node'); return escape(document.body.slice(node.position?.start?.offset || 0, node.position?.end?.offset || 0) || plain(node));
    }
  }
  let html = document.frontmatter ? `<details class="document-markdown-properties document-frontmatter"><summary>文档属性</summary><pre>${escape(document.frontmatter.raw)}</pre></details>` : '';
  html += renderNode(document.ast);
  // Footnote bodies can themselves refer to a later footnote. Each definition
  // renders once; backlink counts are assembled only after this queue settles.
  const footnoteBodies = new Map();
  for (let index = 0; index < usedFootnotes.length; index++) {
    const record = usedFootnotes[index];
    footnoteBodies.set(record.key, children(document.footnotes.get(record.key)));
  }
  if (usedFootnotes.length) html += `<section class="document-footnotes" aria-label="脚注"><hr><ol>${usedFootnotes.map(record => `<li id="${prefix(options.idPrefix)}-fn-${record.number}">${footnoteBodies.get(record.key)}<span class="document-footnote-backlinks">${record.refs.map((id, index) => `<a data-document-anchor="${id}" href="#${id}" aria-label="返回脚注 ${record.number} 的第 ${index + 1} 处引用">↩${index ? `<sup>${index + 1}</sup>` : ''}</a>`).join(' ')}</span></li>`).join('')}</ol></section>`;
  return { html, headings: heading.items, images, warnings, frontmatter: document.frontmatter ? { ...document.frontmatter } : null };
}
export function render(text, options = {}) { return renderWithMetadata(text, options).html; }

if (typeof window !== 'undefined') window.DocumentMarkdown = Object.freeze({ render, renderWithMetadata, headings, resolveFragment });
