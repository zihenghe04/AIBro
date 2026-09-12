/* Pure research-library helpers. Browser builds receive window.ResearchLibrary;
 * Node tests can require this file. Functions never mutate their inputs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResearchLibrary = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const clean = value => String(value ?? '').trim();
  const slug = value => clean(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^doi:\s*/i, '').replace(/\/$/, '').replace(/\s+/g, ' ');
  const asArray = value => Array.isArray(value) ? value.filter(Boolean).map(clean) : (clean(value) ? [clean(value)] : []);
  const PAPER_TYPES = Object.freeze(['method', 'survey', 'benchmark', 'system', 'theory', 'other']);
  const SECTION_LABELS = { tldr: '一句话概览', abstract: '摘要', motivation: '研究动机', methods: '方法', derivations: '公式与推导', training: '损失函数与训练策略', experiments: '实验', ablations: '消融实验', relatedWork: '与现有知识的关联', limitations: '局限性', implications: '启示', criticalAnalysis: '批判性分析', counterArguments: '反方观点', dataGaps: '证据与数据缺口', reproduction: '复现要点', openQuestions: '待解决问题' };
  const OPTIONAL_SECTIONS = Object.freeze(['training', 'relatedWork', 'criticalAnalysis', 'counterArguments', 'dataGaps', 'reproduction']);
  const SECTION_ALIASES = { tldr:['summary'], motivation:['background'], methods:['method'], derivations:['math','equations'], experiments:['results'], implications:['researchImplications'], openQuestions:['questions'] };
  const TYPE_LABELS = {
    method:{methods:'核心方法',experiments:'实验结果与分析'},
    survey:{methods:'分类体系与覆盖范围',training:'文献检索与筛选策略',derivations:'概念与理论基础',experiments:'证据比较与覆盖分析',ablations:'分类与覆盖敏感性',reproduction:'文献筛选复核'},
    benchmark:{methods:'数据集构建与设计',training:'基线训练与评测设置',derivations:'指标定义与形式化',experiments:'数据统计与基准结果',ablations:'评测消融与敏感性',reproduction:'数据与评测复现'},
    system:{methods:'系统架构',training:'系统实现与优化',experiments:'性能与可扩展性评估',ablations:'组件与工程权衡',reproduction:'系统部署与复现'},
    theory:{methods:'理论框架',derivations:'定理与证明',training:'假设与推导条件',experiments:'理论验证与示例',ablations:'假设敏感性',reproduction:'证明核验与复现'},
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const paperType = value => PAPER_TYPES.includes(clean(value).toLowerCase()) ? clean(value).toLowerCase() : 'other';
  const sectionLabels = type => ({ ...SECTION_LABELS, ...(TYPE_LABELS[paperType(typeof type === 'object' ? type?.paperType : type)] || {}) });
  const sectionText = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(sectionText).filter(text=>text.trim()).map(text=>'- '+text).join('\n');
    if (typeof value === 'object') { const key=['text','content','summary'].find(key=>Object.hasOwn(value,key)); return key ? sectionText(value[key]) : ''; }
    return clean(value);
  };
  function normalizeConfidence(value) {
    const levels=['high','medium','low','uncertain'];
    if (typeof value === 'string') return {overall:levels.includes(clean(value).toLowerCase())?clean(value).toLowerCase():'uncertain',reason:''};
    const result={...object(value)};
    if (typeof result.overall==='string') { const overall=clean(result.overall).toLowerCase();result.overall=levels.includes(overall)?overall:'uncertain';if (!Object.hasOwn(result,'reason')) result.reason=''; }
    if (Object.hasOwn(result,'reason')) result.reason=typeof result.reason==='string'?result.reason.trim():'';
    // Numeric overall and per-section evidence are legacy data, not a new
    // confidence claim. Preserve them rather than inventing a conversion.
    return result;
  }
  function normalizeSections(input) {
    const sections={...object(input.sections),...object(input.structured)};
    for (const key of Object.keys(SECTION_LABELS)) {
      if (Object.hasOwn(sections,key)) continue;
      const alias=(SECTION_ALIASES[key]||[]).find(alias=>Object.hasOwn(sections,alias));
      if (alias) sections[key]=sections[alias];
      else { const source=[key,...(SECTION_ALIASES[key]||[])].find(name=>Object.hasOwn(input,name));if(source)sections[key]=input[source]; }
    }
    const edits=object(input.userEdits);
    for (const key of Object.keys(SECTION_LABELS)) { const edit=[key,...(SECTION_ALIASES[key]||[])].find(name=>Object.hasOwn(edits,name));if(edit)sections[key]=edits[edit]; }
    return {...sections,...edits};
  }

  function canonicalIdentifiers(input = {}) {
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
    let url = clean(input.url || metadata.url || input.sourceUrl);
    if (url) { try { const parsed = new URL(url); parsed.hash = ''; for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) parsed.searchParams.delete(key); url = parsed.href.replace(/\/$/, ''); } catch (_) {} }
    const doiUrl = url.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i);
    const arxivUrl = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i);
    const doi = slug(input.doi || metadata.doi || doiUrl?.[1]).replace(/^doi:\s*/i, '').replace(/^(?:dx\.)?doi\.org\//i, '').replace(/[?#].*$/, '');
    const arxivId = clean(input.arxivId || metadata.arxivId || metadata.arxiv_id || arxivUrl?.[1]).replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, '').replace(/^arxiv:/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
    const title = clean(input.title || metadata.title).replace(/\s+/g, ' ').toLowerCase();
    const year = clean(input.year || metadata.year || metadata.published).slice(0, 4);
    const key = doi ? `doi:${doi}` : arxivId ? `arxiv:${arxivId.toLowerCase()}` : url ? `url:${url}` : title ? `title:${title}|${year}` : input.sourceAttachmentId || input.attachmentId ? `attachment:${input.sourceAttachmentId || input.attachmentId}` : `id:${input.id || ''}`;
    return { doi: doi || null, arxivId: arxivId || null, url: url || null, key };
  }

  function normalizePaper(input = {}, options = {}) {
    const now = options.now ?? Date.now();
    const identifiers = canonicalIdentifiers(input);
    const metadata = { ...(input.metadata || {}) };
    const structured = normalizeSections(input);
    const userEdits = { ...(input.userEdits || {}) };
    const confidence = normalizeConfidence(input.confidence);
    const relations = Array.isArray(input.relations) ? input.relations.map(relation => ({ type: clean(relation.type || 'related'), targetId: clean(relation.targetId || relation.target || ''), targetKey: clean(relation.targetKey || ''), label: clean(relation.label || ''), source: relation.source || 'unknown' })).filter(relation => relation.targetId || relation.targetKey) : [];
    const sourceAttachmentIds = [...new Set([...asArray(input.sourceAttachmentIds), ...asArray(input.sourceAttachmentId || input.attachmentId)])];
    return { ...input, id: clean(input.id) || `paper_${now}_${Math.random().toString(36).slice(2, 8)}`, canonicalKey: identifiers.key, title: clean(input.title || metadata.title) || '未命名论文', authors: asArray(input.authors || metadata.authors), year: clean(input.year || metadata.year || metadata.published).slice(0, 4) || null, venue: clean(input.venue || metadata.venue || metadata.journal) || null, doi: identifiers.doi, arxivId: identifiers.arxivId, url: identifiers.url, sourceAttachmentId: sourceAttachmentIds[0] || null, sourceAttachmentIds, projectId: clean(input.projectId) || null, workspace: clean(input.workspace) || '科研', paperType: paperType(input.paperType || metadata.paperType), tags: [...new Set(asArray(input.tags))], metadata, structured, userEdits, confidence, reviewed: input.reviewed === true, relations, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
  }

  function mergePaper(existing, incoming) {
    const merged = { ...existing, ...incoming, id: existing.id, createdAt: existing.createdAt, updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0) };
    ['sourceAttachmentId', 'projectId', 'url', 'doi', 'arxivId', 'venue', 'year'].forEach(field => { if (incoming[field] == null || incoming[field] === '') merged[field] = existing[field] ?? null; });
    if ((!merged.authors || !merged.authors.length) && existing.authors?.length) merged.authors = existing.authors.slice();
    merged.metadata = { ...(existing.metadata || {}), ...(incoming.metadata || {}) };
    merged.structured = { ...(existing.structured || {}), ...(incoming.structured || {}) };
    merged.userEdits = { ...(existing.userEdits || {}), ...(incoming.userEdits || {}) };
    merged.structured = normalizeSections(merged);
    merged.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])];
    merged.sourceAttachmentIds = [...new Set([...(existing.sourceAttachmentIds || []), ...(incoming.sourceAttachmentIds || [])])];
    merged.confidence = { ...(existing.confidence || {}), ...(incoming.confidence || {}) };
    const seen = new Set(); merged.relations = [...(existing.relations || []), ...(incoming.relations || [])].filter(relation => { const key = JSON.stringify([relation.type, relation.targetId, relation.targetKey]); if (seen.has(key)) return false; seen.add(key); return true; });
    return merged;
  }

  function upsertPaper(collectionOrState, rawPaper, options = {}) {
    const stateMode = !Array.isArray(collectionOrState) && collectionOrState && typeof collectionOrState === 'object';
    const source = stateMode ? (Array.isArray(collectionOrState.papers) ? collectionOrState.papers : []) : (Array.isArray(collectionOrState) ? collectionOrState : []);
    const incoming = normalizePaper(rawPaper, options);
    const index = source.findIndex(paper => {
      const previous = canonicalIdentifiers(paper);
      if (rawPaper.id && paper.id === rawPaper.id) return true;
      if (previous.doi && incoming.doi && previous.doi !== incoming.doi) return false;
      if (previous.arxivId && incoming.arxivId && previous.arxivId !== incoming.arxivId) return false;
      if (previous.key === incoming.canonicalKey && incoming.canonicalKey !== 'id:') return true;
      return !!((previous.arxivId && previous.arxivId === incoming.arxivId) || (previous.url && previous.url === incoming.url) || (incoming.sourceAttachmentId && incoming.sourceAttachmentId === paper.sourceAttachmentId));
    });
    const papers = source.map(item => ({ ...item }));
    if (index < 0) { papers.push(incoming); return stateMode ? { ...collectionOrState, papers, paper: incoming, created: true, updated: false } : { papers, paper: incoming, created: true, updated: false }; }
    const merged = mergePaper(normalizePaper(papers[index]), incoming);
    if (!Object.hasOwn(rawPaper,'paperType') && !Object.hasOwn(object(rawPaper.metadata),'paperType')) merged.paperType=paperType(papers[index].paperType || papers[index].metadata?.paperType);
    if (rawPaper.reviewed === undefined) merged.reviewed = papers[index].reviewed === true;
    if (!rawPaper.title && !rawPaper.metadata?.title) merged.title = papers[index].title;
    merged.canonicalKey = canonicalIdentifiers(merged).key;
    papers[index] = merged;
    return stateMode ? { ...collectionOrState, papers, paper: merged, created: false, updated: true } : { papers, paper: merged, created: false, updated: true };
  }

  function paperMarkdown(paperInput = {}) {
    const paper = normalizePaper(paperInput); const yaml = ['---', ...['id', 'title', 'year', 'doi', 'arxivId', 'url', 'projectId', 'paperType'].map(key => `${key}: ${JSON.stringify(paper[key] || '')}`), `confidence: ${JSON.stringify(paper.confidence)}`, `reviewed: ${paper.reviewed}`, `tags: ${JSON.stringify(paper.tags)}`, `sourceAttachmentIds: ${JSON.stringify(paper.sourceAttachmentIds)}`, '---'].join('\n');
    const sections = paper.structured || {};
    const body = Object.entries(sectionLabels(paper.paperType)).filter(([key])=>!OPTIONAL_SECTIONS.includes(key)||sectionText(sections[key]).trim()).map(([key, label]) => {
      const raw = sections[key]; const citations = raw && typeof raw === 'object' && Array.isArray(raw.citations) ? raw.citations : [];
      return `## ${label}\n${sectionText(raw) || '未核验'}${citations.length ? `\n\n来源：\n${citations.map(citation => `- ${clean(citation.attachmentId || citation.sourceAttachmentId || paper.sourceAttachmentId)}${citation.page ? ` · 第 ${citation.page} 页` : ''}${citation.quote ? `：${clean(citation.quote)}` : ''}`).join('\n')}` : ''}`;
    }).join('\n\n');
    return `${yaml}\n\n# ${paper.title}\n\n作者：${paper.authors.join('、') || '未提取'}\n\n${body}\n\n## 来源与审阅\n来源附件：${paper.sourceAttachmentIds.join('、') || '未关联'}\n审阅状态：${paper.reviewed ? '已审阅' : '待审阅'}\n`;
  }

  function explicitRelationEdges(papers = []) {
    const byKey = new Map(); papers.forEach(raw => { const paper = normalizePaper(raw); byKey.set(paper.id, paper.id); byKey.set(paper.canonicalKey, paper.id); });
    const edges = []; const seen = new Set();
    papers.forEach(raw => { const paper = normalizePaper(raw); (paper.relations || []).forEach(relation => { if (relation.source !== 'explicit') return; const target = byKey.get(relation.targetId) || byKey.get(relation.targetKey); if (!target || target === paper.id) return; const type = String(relation.type || 'related').toLowerCase(); const edge = type === 'cited_by' ? { source: target, target: paper.id, type: 'citation' } : { source: paper.id, target, type: type === 'cites' || type === 'citation' ? 'citation' : type, label: relation.label || undefined }; const key = `${edge.source}->${edge.target}:${edge.type}`; if (!seen.has(key)) { seen.add(key); edges.push(edge); } }); }); return edges;
  }

  function citationEdges(papers = []) {
    const byKey = new Map(); papers.forEach(raw => { const paper = normalizePaper(raw); byKey.set(paper.id, paper.id); byKey.set(paper.canonicalKey, paper.id); }); const edges = []; const seen = new Set();
    papers.forEach(raw => { const paper = normalizePaper(raw); (paper.relations || []).forEach(relation => { if (!['cites', 'cited_by', 'citation'].includes(String(relation.type).toLowerCase()) || relation.source !== 'explicit') return; const target = byKey.get(relation.targetId) || byKey.get(relation.targetKey); if (!target || target === paper.id) return; const edge = relation.type.toLowerCase() === 'cited_by' ? { source: target, target: paper.id, type: 'citation' } : { source: paper.id, target, type: 'citation' }; const key = `${edge.source}->${edge.target}`; if (!seen.has(key)) { seen.add(key); edges.push(edge); } }); }); return edges;
  }

  return { canonicalIdentifiers, normalizePaper, upsertPaper, mergePaper, paperMarkdown, citationEdges, explicitRelationEdges, sectionText, sectionLabels, normalizeConfidence, SECTION_LABELS, OPTIONAL_SECTIONS, PAPER_TYPES };
}));
