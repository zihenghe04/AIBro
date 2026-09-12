/* Evidence-based attachment analysis status. No parser/model calls or mutations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttachmentAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  const ids = values => [...new Set(list(values).filter(id))];
  const active = value => !!value && id(value.id) && !value.archived && !value.archivedAt && !value.deleted && !value.deletedAt;
  const sections = ['tldr', 'abstract', 'motivation', 'methods', 'derivations', 'experiments', 'ablations', 'limitations', 'implications', 'openQuestions'];
  const analysisKind = value => /^(?:论文分析|资料分析|课程分析|分析笔记|资料摘要|文献摘要|内容分析|分析总结|研究分析|analysis|paper analysis|document analysis|summary)$/i.test(String(value || '').trim());
  const fallbackPattern = /基于已提取文本的初步摘要|当前解析器没有提取到论文正文|当前使用本地整理模式|本地模拟(?:分析|摘要)|仅为本地(?:模拟|整理)|local (?:simulation|fallback)(?: analysis| summary)?/i;
  const placeholder = /^(?:未核验|待核验|未验证|待分析|尚未分析|未分析|暂无(?:内容|分析|笔记)?|未提供|未提取|待补充|待确认|未说明|无|n\/?a|none|unknown|pending|not (?:provided|verified|analyzed)|todo)(?:[。.!！:：\s-]*)$/i;
  const sourceIds = item => ids([...(Array.isArray(item?.sourceAttachmentIds) ? item.sourceAttachmentIds : []), item?.sourceAttachmentId]);
  const linked = (record, sourceId) => sourceIds(record).includes(sourceId);
  function visible(state, record) {
    if (!active(record)) return false;
    return !record.projectId || list(state.projects).some(project => project.id === record.projectId && active(project));
  }
  function realCompleted(run) {
    if (!run || run.status !== 'completed' || run.error || run.cancelled) return false;
    if (run.mode === 'local' || /(?:local|fallback|simulat)/i.test(String(run.mode || '')) || /(?:local|fallback|simulat)/i.test(String(run.modelConfig?.provider || ''))) return false;
    if (run.mode === 'ai') return true;
    // Legacy successful live runs predate mode. Provider + model identifies the
    // live configuration; local completion statuses above never qualify.
    return ['api', 'openai-auth'].includes(run.modelConfig?.provider) && typeof run.modelConfig.model === 'string' && !!run.modelConfig.model.trim();
  }
  function bodyLines(value) {
    if (typeof value !== 'string') return [];
    return value.slice(0, 60000).replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/(?:^|\n)来源：\s*\n(?:[-*] [^\n]*(?:\n|$))+/g, '\n').split(/\r?\n/)
      .map(line => line.trim()).filter(line => line && !/^#{1,6}\s/.test(line) && !/^```/.test(line) && !/^(?:作者|来源(?:附件)?|审阅状态|DOI|arXiv|sourceAttachmentIds|reviewed)\s*[:：]/i.test(line))
      .map(line => line.replace(/^(?:[-*+>]\s+|\d+[.)、]\s*)+/, '').replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim())
      .filter(line => line && !placeholder.test(line) && !/^[-|\s:]+$/.test(line));
  }
  const compact = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  function originalTexts(state, record, source) {
    const sources = new Map(list(state.imports).map(item => [item.id, item])); if (source) sources.set(source.id, source);
    return sourceIds(record).map(sourceId => sources.get(sourceId)).filter(Boolean).flatMap(item => {
      const text = typeof item.content === 'string' && item.content.trim() ? item.content : list(item.pages).map(page => typeof page.text === 'string' ? page.text : '').join('\n');
      return [compact(text.slice(0, 240000)), compact(item.name), compact(item.originalName)];
    }).filter(Boolean);
  }
  function meaningfulText(value, originals = []) {
    if (typeof value !== 'string' || fallbackPattern.test(value.slice(0, 60000))) return false;
    const lines = bodyLines(value), normalized = compact(lines.join('\n'));
    if (normalized.length < 12) return false;
    if (originals.some(original => original.includes(normalized))) return false;
    // Raw extraction split into bullets/sections is still indexing. Keep a
    // note only when it adds at least one substantive non-copied statement.
    const substantive = lines.map(compact).filter(line => line.length >= 6);
    return substantive.some(line => !originals.some(original => original.includes(line)));
  }
  function sectionText(value, depth = 0) {
    if (typeof value === 'string') return value;
    if (!value || depth > 3) return '';
    if (Array.isArray(value)) return value.slice(0, 100).map(item => sectionText(item, depth + 1)).join('\n');
    return typeof value === 'object' ? sectionText(value.text || value.content || value.summary, depth + 1) : '';
  }
  function meaningfulPaper(state, paper, source) {
    const originals = originalTexts(state, paper, source);
    return sections.some(key => meaningfulText(sectionText(paper.structured?.[key]), originals));
  }
  function meaningfulNote(state, note, source) {
    if (note.paperId) {
      const paper = list(state.papers).find(item => item.id === note.paperId && visible(state, item));
      // Generated paper Markdown includes metadata and empty-section labels.
      // It is not evidence of analysis when every actual section is empty.
      if (paper) return meaningfulPaper(state, paper, source) && meaningfulText(note.content, originalTexts(state, note, source));
    }
    return meaningfulText(note.content, originalTexts(state, note, source));
  }
  function resultMatches(state, result, record, type) {
    if (!['created', 'updated'].includes(result?.operation)) return false;
    if (result.type === type && result.id === record.id) return true;
    if (type === 'paper' && result.type === 'note') return list(state.notes).some(note => note.id === result.id && note.paperId === record.id && record.noteId === note.id && record.updatedAt === note.updatedAt);
    return false;
  }
  function stamped(state, source, record, type) {
    const analysis = source.analysis;
    if (!analysis || analysis.status !== 'analyzed' || !id(analysis.runId) || !Number.isFinite(analysis.analyzedAt) || analysis.analyzedAt < 0 || !ids(analysis[type === 'note' ? 'noteIds' : 'paperIds']).includes(record.id)) return false;
    const run = list(state.agentRuns).find(item => item.id === analysis.runId);
    // Run history is device-local. The bounded explicit output references can
    // survive sync, but known failed/local provenance must never be trusted.
    return !run || realCompleted(run);
  }
  function provenance(state, source, record, type) {
    if (stamped(state, source, record, type)) return true;
    if (record.mode === 'local' || record.analysisMode === 'local' || record.localSimulation || record.simulated) return false;
    const runs = list(state.agentRuns);
    const owning = id(record.agentRunId) && runs.find(run => run.id === record.agentRunId);
    if (owning) {
      if (!realCompleted(owning)) return false;
      if (Object.hasOwn(source, 'analysis') || Array.isArray(owning.results)) return list(owning.results).some(result => resultMatches(state, result, record, type));
      return analysisKind(record.kind) || type === 'paper';
    }
    const exactRuns = runs.filter(run => list(run.results).some(result => resultMatches(state, result, record, type)));
    if (exactRuns.length) return exactRuns.some(realCompleted);
    // New imports must not be promoted by an unrelated successful reply or a
    // matched/drafted result while metadata is still pending (including sync).
    if (Object.hasOwn(source, 'analysis')) return false;
    if (id(record.sourceConversationId)) {
      const conversationRuns = runs.filter(run => run.conversationId === record.sourceConversationId && (!Array.isArray(run.attachmentIds) || run.attachmentIds.includes(source.id)));
      if (conversationRuns.some(run => !realCompleted(run) || Array.isArray(run.results))) return false;
    }
    // Before execution provenance was persisted, explicit analysis kinds and
    // structured papers are the only conservative legacy fallback.
    return !Object.hasOwn(source, 'analysis') && (analysisKind(record.kind) || type === 'paper');
  }
  function derive(state = {}, item) {
    const source = item && list(state.imports).find(entry => entry.id === item.id);
    const pending = (taskIds = []) => ({ status: 'pending', label: '待 AI 分析', detail: taskIds.length ? `已关联 ${taskIds.length} 个任务；尚无可用的分析笔记或论文记录。` : '尚无可用的分析笔记或论文记录；文字索引、改名和归档不代表已分析。', noteIds: [], paperIds: [], taskIds });
    if (!source || !visible(state, source)) return pending();
    const tasks = list(state.tasks).filter(record => visible(state, record) && linked(record, source.id));
    const notes = list(state.notes).filter(record => visible(state, record) && linked(record, source.id) && meaningfulNote(state, record, source) && provenance(state, source, record, 'note'));
    const papers = list(state.papers).filter(record => visible(state, record) && linked(record, source.id) && meaningfulPaper(state, record, source) && provenance(state, source, record, 'paper'));
    const noteIds = ids(notes.map(note => note.id)), paperIds = ids(papers.map(paper => paper.id)), taskIds = ids(tasks.map(task => task.id));
    if (!noteIds.length && !paperIds.length) return pending(taskIds);
    return { status: 'analyzed', label: '已分析 · 已关联', detail: `已关联${noteIds.length ? ` ${noteIds.length} 篇分析笔记` : ''}${noteIds.length && paperIds.length ? '、' : ''}${paperIds.length ? ` ${paperIds.length} 篇论文分析` : ''}；可打开核对与补充。`, noteIds, paperIds, taskIds };
  }
  function markCompleted(state = {}, results, run, now = Date.now()) {
    if (!id(run?.id) || !realCompleted(run) || run.archived || run.archivedAt || run.deleted || run.deletedAt || !Number.isFinite(now) || now < 0) return { state, markedIds: [] };
    const rows = Array.isArray(results) ? results : Array.isArray(results?.results) ? results.results : [];
    const outputs = new Map();
    for (const result of rows) {
      if (!id(result?.id) || !['created', 'updated'].includes(result.operation)) continue;
      if (result.type === 'note') {
        const note = list(state.notes).find(item => item.id === result.id && visible(state, item));
        if (!note) continue;
        outputs.set(`note:${note.id}`, { type: 'note', record: note });
        const paper = note.paperId && list(state.papers).find(item => item.id === note.paperId && item.noteId === note.id && item.updatedAt === note.updatedAt && visible(state, item));
        if (paper) outputs.set(`paper:${paper.id}`, { type: 'paper', record: paper });
      } else if (result.type === 'paper') {
        const paper = list(state.papers).find(item => item.id === result.id && visible(state, item));
        if (paper) outputs.set(`paper:${paper.id}`, { type: 'paper', record: paper });
      }
    }
    const markedIds = [];
    const imports = list(state.imports).map(source => {
      if (!visible(state, source)) return source;
      const notes = [], papers = [];
      for (const { type, record } of outputs.values()) {
        if (!linked(record, source.id)) continue;
        if (type === 'note' ? meaningfulNote(state, record, source) : meaningfulPaper(state, record, source)) (type === 'note' ? notes : papers).push(record.id);
      }
      if (!notes.length && !papers.length) return source;
      const previous = derive(state, source);
      const analysis = { status: 'analyzed', runId: run.id, analyzedAt: now, noteIds: ids([...previous.noteIds, ...notes]), paperIds: ids([...previous.paperIds, ...papers]) };
      if (JSON.stringify(source.analysis) === JSON.stringify(analysis)) return source;
      markedIds.push(source.id); return { ...source, analysis, updatedAt: now };
    });
    return { state: markedIds.length ? { ...state, imports } : state, markedIds };
  }
  function timestamp(value) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
    return Number.isFinite(number) && number >= 0 && Number.isFinite(new Date(number).getTime()) ? number : null;
  }
  function migrateLegacy(state = {}, now = Date.now()) {
    const fallbackAt = timestamp(now); if (fallbackAt === null) return { state, markedIds: [] };
    const legacyIds = new Set(list(state.imports).filter(source => !Object.hasOwn(source, 'analysis')).map(source => source.id));
    if (!legacyIds.size) return { state, markedIds: [] };
    const runs = list(state.agentRuns).filter(run => id(run.id) && realCompleted(run) && list(run.results).some(result => ['note', 'paper'].includes(result.type) && ['created', 'updated'].includes(result.operation)))
      .map((run, index) => ({ run, at: timestamp(run.finishedAt) ?? fallbackAt, index })).sort((a, b) => a.at - b.at || a.index - b.index);
    let next = state; const marked = new Set();
    for (const { run, at } of runs) {
      // Suppress kind-only legacy inference while constructing proof. Retain
      // all originals in the view so raw-copy checks also see modern sources.
      const proof = { ...next, imports: list(next.imports).map(source => legacyIds.has(source.id) && !Object.hasOwn(source, 'analysis') ? { ...source, analysis: { status: 'pending' } } : source) };
      const outcome = markCompleted(proof, run.results, run, at);
      const candidates = new Map(outcome.state.imports.map(source => [source.id, source]));
      const changed = new Set(outcome.markedIds.filter(sourceId => legacyIds.has(sourceId)));
      if (!changed.size) continue;
      const imports = list(next.imports).map(source => {
        if (!changed.has(source.id)) return source;
        const candidate = candidates.get(source.id); marked.add(source.id);
        const previousAt = timestamp(source.updatedAt);
        return { ...candidate, updatedAt: previousAt !== null && previousAt >= at ? source.updatedAt : at };
      });
      next = { ...next, imports };
    }
    return { state: next, markedIds: list(state.imports).filter(source => marked.has(source.id)).map(source => source.id) };
  }
  return { derive, markCompleted, migrateLegacy };
});
