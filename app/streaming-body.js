/* Retain the plain DOM produced by renderRichText while accepting each fresh
 * render as the semantic authority. This is not a second Markdown parser.
 * No source HTML, text limit, output timer or controller-owned subtree is added.
 */
(function (root, factory) {
  const api = factory(root);
  root.StreamingBody = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  // SafePreview handlers close over their exact host and render invocation.
  // Moving its controls into another host would preserve the wrong callback.
  // React/controller roots likewise need their own explicit lifecycle adapter.
  const owned = '[data-safe-preview], [data-preview-action], .safe-preview-restore, [data-halaska-root], [data-halaska-conversation], [data-citation-panel]';
  const elements = node => [...(node.querySelectorAll?.('[data-citation-source]') || [])];
  const citationKey = node => JSON.stringify([node.getAttribute('data-citation-run'), node.getAttribute('data-citation-source')]);
  function canPatch(previous, next) {
    return !!previous && !!next && previous.nodeType === 1 && next.nodeType === 1
      && previous.nodeName === next.nodeName && previous.namespaceURI === next.namespaceURI
      && !previous.matches?.(owned) && !next.matches?.(owned)
      && !previous.querySelector?.(owned) && !next.querySelector?.(owned)
      && (!elements(previous).length || (typeof root.CitationEvidence?.resolveTarget === 'function' && typeof root.CitationEvidence?.bind === 'function'));
  }
  function attributes(previous, next) {
    for (const attr of [...previous.attributes]) if (!next.hasAttribute(attr.name)) previous.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (previous.getAttribute(attr.name) !== attr.value) {
      if (attr.namespaceURI) previous.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      else previous.setAttribute(attr.name, attr.value);
    }
  }
  function action(node) {
    if (node.nodeType !== 1) return '';
    // A focused link/button must not silently become a different destination.
    return JSON.stringify(['href', 'data-open-note', 'data-open-import', 'data-open-conversation', 'data-citation-run', 'data-citation-source'].map(name => node.getAttribute(name)));
  }
  function compatible(previous, next) {
    return !!previous && previous.nodeType === next.nodeType && previous.nodeName === next.nodeName
      && previous.namespaceURI === next.namespaceURI && action(previous) === action(next);
  }
  function signature(node) {
    return node.nodeType === 1 ? 'e:' + node.outerHTML : node.nodeType + ':' + node.nodeValue;
  }
  // Remap only endpoints in a retained body Text node. The caller still owns
  // selection restoration for its progress/ledger reparenting. A new suffix
  // must not extend the old selection; unchanged text shifted by an earlier
  // edit keeps its selected characters, in either selection direction.
  function remapSelection(selection, node, edit) {
    if (!selection || node.nodeType !== 3) return;
    const { start, removed, inserted, beforeLength } = edit;
    const end = start + removed, shift = inserted - removed;
    const both = selection.anchor === node && selection.focus === node;
    const low = Math.min(selection.anchorOffset, selection.focusOffset), high = Math.max(selection.anchorOffset, selection.focusOffset);
    if (both && low === high) {
      // A caret at the removed interval's end belongs to the surviving suffix,
      // not the replaced text. Keep it collapsed and shift that boundary; an
      // appended delta still leaves a caret at the former end where it was.
      const offset = low < start || (removed === 0 && start === beforeLength)
        ? low : low >= end ? low + shift : start;
      selection.anchorOffset = selection.focusOffset = offset; return;
    }
    if (both && removed > 0 && low >= start && high <= end) {
      // The selected content itself was replaced. Collapse rather than select
      // unrelated replacement text (or invert a partially removed selection).
      selection.anchorOffset = selection.focusOffset = start; return;
    }
    const anchorFirst = selection.anchorIsStart ?? (both ? selection.anchorOffset <= selection.focusOffset : true);
    const map = (offset, edge) => {
      if (offset < start || (removed === 0 && start === beforeLength)) return offset;
      if (offset > end) return offset + shift;
      if (removed === 0) return offset + inserted;
      return edge === 'start' ? start + inserted : start;
    };
    if (selection.anchor === node) selection.anchorOffset = map(selection.anchorOffset, anchorFirst ? 'start' : 'end');
    if (selection.focus === node) selection.focusOffset = map(selection.focusOffset, anchorFirst ? 'end' : 'start');
  }
  function text(previous, next, onTextEdit) {
    const before = previous.nodeValue, after = next.nodeValue;
    if (before === after) return;
    // CharacterData edits preserve an existing Range for an appended delta.
    // For a correction, touch only its changed middle, not the shared prefix.
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
    onTextEdit?.(previous, { start, removed: before.length - start - end, inserted: after.length - start - end, beforeLength: before.length });
    previous.replaceData(start, before.length - start - end, after.slice(start, after.length - end));
  }
  function sync(previous, next, onTextEdit, frozen = 0) {
    if (!frozen && previous.isEqualNode(next)) return;
    if (previous.nodeType === 3 || previous.nodeType === 8) { text(previous, next, onTextEdit); return; }
    attributes(previous, next);
    const before = [...previous.childNodes].slice(frozen), after = [...next.childNodes];
    const byContent = new Map(), signatures = new Map(), remaining = new Map();
    for (const child of before) {
      const value = signature(child); signatures.set(child, value);
      if (!byContent.has(value)) byContent.set(value, { nodes: [], index: 0 });
      byContent.get(value).nodes.push(child);
    }
    for (const child of after) {
      const value = signature(child); signatures.set(child, value);
      remaining.set(value, (remaining.get(value) || 0) + 1);
    }
    const used = new Set();
    let cursor = before[0] || null;
    for (const fresh of after) {
      const value = signatures.get(fresh);
      remaining.set(value, remaining.get(value) - 1);
      const candidates = byContent.get(value);
      while (candidates && candidates.index < candidates.nodes.length && used.has(candidates.nodes[candidates.index])) candidates.index += 1;
      let current = candidates?.nodes[candidates.index++];
      // Keep exact surviving blocks reserved. A new paragraph before a stable
      // paragraph must be inserted, not overwrite that paragraph and its Range.
      if (!current && compatible(cursor, fresh) && !remaining.get(signatures.get(cursor))) current = cursor;
      if (!current) {
        previous.insertBefore(fresh, cursor);
        continue;
      }
      used.add(current);
      if (current !== cursor) previous.insertBefore(current, cursor);
      sync(current, fresh, onTextEdit);
      cursor = current.nextSibling;
    }
    for (const child of before) if (!used.has(child) && child.parentNode === previous) previous.removeChild(child);
  }
  function patch(previous, next, options = {}) {
    root.StreamMarkdown?.prepareCommit?.(previous, next);
    if (!canPatch(previous, next)) return false;
    if (root.StreamMarkdown?.commitBody?.(previous, next, options.selection, frozen => sync(previous,next,options.onTextEdit,frozen))) {
      attributes(previous, next); return true;
    }
    // Token spans may replace plain code Text nodes at a fence boundary. Keep
    // each selected endpoint in UTF-16 text coordinates, including selections
    // whose other endpoint belongs to a stable paragraph or another message.
    const selectedCode = root.StreamCode && options.selection ?
      [...previous.querySelectorAll('pre.message-code > code')].map(code => ({ code,
        saved: root.StreamCode.capture(code, options.selection), before: code.textContent })).filter(value => value.saved) : [];
    // Equal labels/markup can still carry a newer, redacted excerpt or sibling
    // list. Refresh the WeakMap binding before the isEqualNode fast path.
    const freshSources = new Map(elements(next).map(button => [citationKey(button), button]));
    for (const button of elements(previous)) {
      const fresh = freshSources.get(citationKey(button));
      if (!fresh) continue;
      const target = root.CitationEvidence.resolveTarget({}, fresh);
      if (target) root.CitationEvidence.bind(button, target.source, target.siblings);
    }
    sync(previous, next, options.onTextEdit);
    for (const value of selectedCode) {
      if (!previous.contains(value.code)) continue;
      const after = value.code.textContent, before = value.before;
      if (before !== after) {
        let start = 0, end = 0;
        while (start < before.length && start < after.length && before[start] === after[start]) start++;
        while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
        const virtual = { nodeType: 3 }, selection = { ...options.selection };
        for (const key of ['anchor', 'focus']) if (value.saved[key] !== null) { selection[key] = virtual; selection[key + 'Offset'] = value.saved[key]; }
        remapSelection(selection, virtual, { start, removed: before.length - start - end, inserted: after.length - start - end, beforeLength: before.length });
        for (const key of ['anchor', 'focus']) if (value.saved[key] !== null) value.saved[key] = selection[key + 'Offset'];
      }
      root.StreamCode.restore(value.code, options.selection, value.saved);
    }
    root.StreamMarkdown?.adoptBody?.(previous, next);
    return true;
  }
  return { canPatch, patch, remapSelection };
});
