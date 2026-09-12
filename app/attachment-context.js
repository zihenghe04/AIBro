/* Bounded, read-only extracted-text context. Original file bytes are not read here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AttachmentContext = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const string = value => typeof value === 'string' ? value : '';
  const array = value => Array.isArray(value) ? value : [];
  const pageNumber = value => ['number', 'string'].includes(typeof value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 10000 ? Number(value) : null;
  const compact = value => string(value).replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const short = (value, length) => { let end = Math.min(value.length, Math.max(0, length)); if (end && /[\uD800-\uDBFF]/.test(value[end - 1])) end--; return value.slice(0, end); };
  function normalize(item, index) {
    const pages = [], seen = new Set();
    for (const [position, entry] of array(item.pages).entries()) {
      if (!entry || typeof entry !== 'object') continue;
      const page = pageNumber(entry.page ?? entry.pageNumber) || position + 1;
      // Duplicate page metadata must not pretend to be an additional page.
      const text = compact(entry.text ?? entry.content);
      if (seen.has(page)) { const original = pages.find(part => part.page === page); if (text && !original.text.includes(text)) original.text = [original.text, text].filter(Boolean).join('\n'); continue; }
      seen.add(page); pages.push({ page, text });
    }
    pages.sort((a, b) => a.page - b.page);
    const declared = pageNumber(item.pageCount);
    const observed = pages.length ? Math.max(...pages.map(part => part.page)) : null;
    const count = declared || observed ? Math.max(declared || 0, observed || 0) : null;
    if (!pages.length) pages.push({ page: null, text: compact(item.content ?? item.text ?? item.extractedText) });
    return { index, id: string(item.id), name: string(item.name || item.originalName) || '未命名附件', pageCount: count, pages };
  }
  function universe(source) { return source.pageCount ? Array.from({ length: source.pageCount }, (_, i) => i + 1) : source.pages.map(part => part.page).filter(Boolean); }
  function record(source, lengths) {
    const included = source.pages.filter((part, index) => part.text && (lengths.get(index) || 0) > 0);
    const includedPages = included.map(part => part.page).filter(Boolean);
    const includedSet = new Set(includedPages);
    const omittedPages = universe(source).filter(page => !includedSet.has(page));
    const truncatedPages = included.filter(part => lengths.get(source.pages.indexOf(part)) < part.text.length).map(part => part.page).filter(Boolean);
    const pagesWithoutText = source.pages.filter(part => part.page && !part.text).map(part => part.page);
    const allTextIncluded = source.pages.every((part, index) => part.text && lengths.get(index) >= part.text.length);
    const complete = allTextIncluded && omittedPages.length === 0 && pagesWithoutText.length === 0;
    return {
      id: source.id, name: source.name,
      coverage: { scope: 'extracted_text', pageCount: source.pageCount, includedPages, omittedPages, truncatedPages, pagesWithoutText, complete, textTruncated: !allTextIncluded },
      pages: source.pages.flatMap((part, index) => {
        const size = lengths.get(index) || 0; if (!part.text || !size) return [];
        return [{ page: part.page, text: `${part.page ? `[第 ${part.page} 页]\n` : ''}${short(part.text, size)}`, truncated: size < part.text.length }];
      })
    };
  }
  const requirements = /考核|考勤|实践|作业|成绩|评分|课程要求|提交|截止|考试|选题|注意事项|学习目标|assessment|grading|assignment|requirement|deadline|due date|submission|evaluation/i;
  const date = /(?:20\d{2}[-/.年]\s*\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|\b(?:deadline|due|schedule)\b)/i;
  function ranked(source, query) {
    const terms = (string(query).toLocaleLowerCase().match(/[\p{Script=Han}]{2,10}|[a-z][a-z0-9-]{2,}/gu) || []).slice(0, 32);
    return source.pages.map((part, index) => {
      const text = part.text.toLocaleLowerCase();
      let score = (index === 0 ? 10000 : 0) + (index === source.pages.length - 1 ? 9000 : 0);
      if (requirements.test(text)) score += 8000;
      if (date.test(text)) score += 4000;
      score += terms.filter(term => text.includes(term)).length * 100;
      return { index, score };
    }).filter(item => source.pages[item.index].text).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.index);
  }
  function fit(source, budget, query) {
    const full = new Map(source.pages.map((part, index) => [index, part.text.length]));
    const whole = record(source, full);
    if (JSON.stringify(whole).length <= budget) return whole;
    const lengths = new Map(), order = ranked(source, query);
    if (JSON.stringify(record(source, lengths)).length > budget) return null;
    const setLength = (index, proposed) => {
      const previous = lengths.get(index) || 0; let low = previous, high = proposed;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2); lengths.set(index, mid);
        if (JSON.stringify(record(source, lengths)).length <= budget) low = mid; else high = mid - 1;
      }
      if (low) lengths.set(index, low); else lengths.delete(index);
      return low > previous;
    };
    // Give multiple significant pages an initial excerpt before expanding any
    // long page. First/last pages and concrete requirements stay discoverable.
    for (const index of order) setLength(index, Math.min(source.pages[index].text.length, 240));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const index of order) {
        const previous = lengths.get(index) || 0;
        if (previous && previous < source.pages[index].text.length) expanded = setLength(index, Math.min(source.pages[index].text.length, previous + 512)) || expanded;
      }
    }
    return record(source, lengths);
  }
  function build(attachments, options = {}) {
    const requested = options.maxChars === undefined ? 48000 : Number(options.maxChars);
    const maxChars = Number.isFinite(requested) ? Math.min(48000, Math.max(0, Math.floor(requested))) : 48000;
    const sources = array(attachments).filter(item => item && typeof item === 'object').map(normalize);
    const aggregate = records => {
      const present = new Set(records.map(item => item.index));
      const omittedAttachments = sources.filter(source => !present.has(source.index)).map(source => ({ id: source.id, name: source.name }));
      return { scope: 'extracted_text', maxChars, totalAttachments: sources.length, includedAttachments: records.length, totalPages: sources.reduce((sum, source) => sum + (source.pageCount || 0), 0), includedPages: records.reduce((sum, item) => sum + item.value.coverage.includedPages.length, 0), complete: omittedAttachments.length === 0 && records.every(item => item.value.coverage.complete), omittedAttachments };
    };
    const envelope = records => ({ coverage: aggregate(records), attachments: records.map(item => item.value) });
    const encode = records => JSON.stringify(envelope(records));
    const full = sources.map(source => ({ index: source.index, value: record(source, new Map(source.pages.map((part, index) => [index, part.text.length]))) }));
    let records = full;
    if (encode(full).length > maxChars) {
      records = [];
      // Reserve envelope/omission metadata first, then allocate equal shares.
      const overhead = encode([]).length;
      const quota = Math.max(0, Math.floor((maxChars - overhead) / Math.max(1, sources.length)));
      for (const source of sources) {
        const value = fit(source, quota, options.query);
        if (value) records.push({ index: source.index, value });
      }
      // Reuse spare space from short attachments. Each round shares it across
      // incomplete attachments, so one large PDF cannot monopolize the budget.
      for (let round = 0; round < 12; round++) {
        const left = maxChars - encode(records).length;
        const partial = sources.filter(source => !records.some(item => item.index === source.index && item.value.coverage.complete));
        if (left < 32 || !partial.length) break;
        const addition = Math.max(1, Math.floor(left / partial.length)); let changed = false;
        for (const source of partial) {
          const old = records.find(item => item.index === source.index);
          const oldSize = old ? JSON.stringify(old.value).length : 0;
          const value = fit(source, oldSize + addition, options.query); if (!value) continue;
          const next = [...records.filter(item => item.index !== source.index), { index: source.index, value }].sort((a, b) => a.index - b.index);
          if (encode(next).length <= maxChars && JSON.stringify(value).length > oldSize) { records = next; changed = true; }
        }
        if (!changed) break;
      }
    }
    let text = encode(records), coverage = aggregate(records);
    if (text.length > maxChars) {
      // A budget too small even for source identities must not produce invalid
      // JSON or silently imply that the omitted documents were read.
      records = []; coverage = aggregate(records);
      const minimal = JSON.stringify({ coverage: { scope:'extracted_text', complete:false, omittedAttachments:sources.length, reason:'context_budget_too_small' }, attachments:[] });
      text = minimal.length <= maxChars ? minimal : '';
    }
    coverage = { ...coverage, chars: text.length, truncated: !coverage.complete };
    return { text, coverage, attachments: records.map(item => item.value) };
  }
  return { build, compact };
}));
