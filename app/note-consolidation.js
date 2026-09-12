/* Deterministic, reviewable consolidation. Originals remain recoverable. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteConsolidation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const clone = value => JSON.parse(JSON.stringify(value));
  const ids = values => [...new Set(list(values).filter(value => typeof value === 'string' && value))];
  const sourceIds = note => ids([...list(note.sourceAttachmentIds), note.sourceAttachmentId]);
  const active = item => !!item && !item.archived && !item.archivedAt && !item.deleted && !item.deletedAt && !['archived', 'deleted'].includes(item.status);
  const line = value => text(value).replace(/[\r\n]+/g, ' ').trim();
  const normalized = value => line(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const owner = (state, note) => note.projectId ? list(state.projects).find(project => project.id === note.projectId) : null;
  const available = (state, note) => active(note) && (!note.projectId || active(owner(state, note)));
  const timestamp = (value, now) => Math.max(Number(value) || Date.parse(value) || 0, now);
  function owners(state) {
    const map = new Map();
    for (const [type, key] of Object.entries({note:'notes',task:'tasks',import:'imports',paper:'papers',project:'projects',conversation:'conversations'})) {
      for (const item of list(state[key])) if (item?.id) { if (!map.has(item.id)) map.set(item.id, new Set()); map.get(item.id).add(type); }
    }
    return map;
  }
  function selected(state, noteIds, options) {
    if (!state || typeof state !== 'object' || !Array.isArray(noteIds) || noteIds.length > 100 || noteIds.some(id => !text(id))) throw new Error('请选择 2 至 100 篇有效笔记。');
    const selection = ids(noteIds).map(id => {
      const matches = list(state.notes).filter(note => note?.id === id);
      if (matches.length !== 1 || !available(state, matches[0])) throw new Error('所选笔记已删除、归档或 ID 不唯一，请重新选择。');
      return matches[0];
    });
    if (selection.length < 2) throw new Error('至少选择两篇笔记才能合并。');
    const first = selection[0], projectId = first.projectId || null, workspace = owner(state, first)?.workspace || first.workspace;
    if (!['日常','课程','科研'].includes(workspace)) throw new Error('笔记空间无效，请先调整归属。');
    const checkScope = note => {
      if (!available(state, note) || (note.projectId || null) !== projectId || (owner(state, note)?.workspace || note.workspace) !== workspace) throw new Error('只能合并同一空间、同一项目的笔记。');
    };
    selection.forEach(checkScope);
    const sources = new Set(selection.flatMap(sourceIds)), knownPaperIds = new Set(selection.map(note => note.paperId).filter(Boolean));
    for (const paper of list(state.papers)) if (selection.some(note => paper.noteId === note.id) || sourceIds(paper).some(id => sources.has(id))) knownPaperIds.add(paper.id);
    if (knownPaperIds.size > 1) throw new Error('不同论文的笔记不能合并为同一主笔记。');
    const paperId = [...knownPaperIds][0] || null, paper = paperId && list(state.papers).find(item => item.id === paperId);
    if (paperId && (!paper || !available(state, paper))) throw new Error('关联论文已删除或归档，请先恢复。');
    let canonical = options.canonicalId ? selection.find(note => note.id === options.canonicalId) : first;
    if (options.canonicalId && !canonical) throw new Error('主笔记必须来自当前选择。');
    let includedMain = false;
    const paperMain = paper?.noteId && list(state.notes).find(note => note.id === paper.noteId);
    if (paper?.noteId && !paperMain) throw new Error('论文主笔记已不在当前内容中，请先恢复后再合并。');
    if (paperMain) {
      checkScope(paperMain); canonical = paperMain;
      if (!selection.some(note => note.id === paperMain.id)) { selection.unshift(paperMain); includedMain = true; }
    }
    if (paper && ((paper.projectId || null) !== projectId || (owner(state, paper)?.workspace || paper.workspace || '科研') !== workspace)) throw new Error('论文主笔记与所选内容不在同一项目，不能合并。');
    const ordered = [canonical, ...selection.filter(note => note.id !== canonical.id)];
    if (ordered.length > 100) throw new Error('计入论文主笔记后超过 100 篇，请减少本次选择。');
    if (ordered.reduce((sum, note) => sum + text(note.content).length, 0) > 2 * 1024 * 1024) throw new Error('本次正文过多，请分批合并笔记。');
    const removed = new Set(ordered.slice(1).map(note => note.id)), identities = owners(state);
    for (const link of list(state.links)) for (const side of ['source','target']) {
      const id = link?.[side+'Id'], type = link?.[side+'Type'];
      if (removed.has(id) && !type && (identities.get(id)?.size || 0) !== 1) throw new Error('旧关联没有内容类型，且 ID 存在歧义；请先修正关联后合并。');
    }
    return {ordered,canonical,projectId,workspace,paper,includedMain};
  }
  function blocks(content) {
    const result = []; let current = [], fence = null;
    for (const row of text(content).replace(/\r\n/g, '\n').split('\n')) {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(row);
      if (match && !fence) fence = {char:match[1][0],length:match[1].length};
      else if (fence && new RegExp('^ {0,3}'+fence.char+'{'+fence.length+',}\\s*$').test(row)) fence = null;
      if (!row.trim() && !fence) { if (current.length) result.push(current.join('\n')); current = []; }
      else current.push(row);
    }
    if (current.length) result.push(current.join('\n'));
    return result;
  }
  const paragraph = block => !block.split('\n').some(row => /^(?: {4}| {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-*+]\s|\d+[.)]\s|\||(?:=+|-+)\s*$))/.test(row));
  function nestHeadings(content) {
    let fence = null;
    return content.split('\n').map(row => {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(row);
      if (mark && !fence) { fence={char:mark[1][0],length:mark[1].length}; return row; }
      if (fence && new RegExp('^ {0,3}'+fence.char+'{'+fence.length+',}\\s*$').test(row)) { fence=null; return row; }
      return !fence ? row.replace(/^( {0,3})(#{1,6})(\s+)/, (_all,indent,hashes,space) => indent+'#'.repeat(Math.min(6,hashes.length+2))+space) : row;
    }).join('\n');
  }
  function reviewVersion(state, selection) {
    const selectedIds = new Set(selection.ordered.map(note => note.id));
    const sourceSet = new Set(selection.ordered.flatMap(sourceIds));
    return JSON.stringify({notes:selection.ordered, project:owner(state, selection.canonical), paper:selection.paper,
      noteRefs:list(state.notes).map(note=>[note.id,note.sourceNoteIds,note.relatedNoteIds,note.mergedNoteIds]),
      taskRefs:list(state.tasks).map(task=>[task.id,task.sourceNoteIds]),links:state.links,
      papers:list(state.papers).map(paper=>[paper.id,paper.noteId,paper.sourceAttachmentIds,paper.sourceAttachmentId,paper.archived,paper.deletedAt]),
      sources:list(state.imports).filter(item=>sourceSet.has(item.id)).map(item=>[item.id,item.name,item.analysis,item.folderPath,item.workspace,item.projectId,item.archived,item.archivedAt,item.deleted,item.deletedAt,item.status]),
      attachments:list(state.attachments).filter(item=>selectedIds.has(item.noteId)),
      identities:[...owners(state)].filter(([id])=>selectedIds.has(id)).map(([id,kinds])=>[id,[...kinds]])});
  }
  function sharedSourceFolder(state, selection) {
    const {ordered,workspace,projectId}=selection, firstSources=sourceIds(ordered[0]).slice().sort();
    if (!firstSources.length || !ordered.every(note=>JSON.stringify(sourceIds(note).slice().sort())===JSON.stringify(firstSources))) return null;
    const paths=firstSources.map(id=>{
      const matches=list(state.imports).filter(item=>item.id===id), item=matches.length===1?matches[0]:null;
      if (!available(state,item) || (item.projectId||null)!==projectId || (owner(state,item)?.workspace||item.workspace)!==workspace) return null;
      return typeof item.folderPath==='string' && item.folderPath.trim() || null;
    });
    return paths.every(path=>path && path===paths[0]) ? paths[0] : null;
  }
  function preview(state, noteIds, options = {}) {
    const selection = selected(state, noteIds, options), {ordered,canonical,workspace,projectId,paper,includedMain} = selection;
    const title = Object.hasOwn(options, 'title') ? line(options.title) : line(canonical.title) || '合并笔记';
    if (!title || title.length > 500) throw new Error('请输入不超过 500 字的主笔记标题。');
    const seen = new Set(blocks(canonical.content).filter(paragraph)), sections = [], additions = [], groups = new Map();
    const categories = {summary:'摘要与脉络',materials:'材料与关键内容',timeline:'时间与安排',notes:'分析与注意事项'};
    const names = sourceList => sourceList.map(id=>line(list(state.imports).find(item=>item.id===id)?.name)||id).join('、');
    let duplicateParagraphs = 0;
    for (const [index,note] of ordered.entries()) {
      const sourceAttachmentIds = sourceIds(note), section = {noteId:note.id,title:line(note.title)||'未命名笔记',sourceAttachmentIds,userEdited:note.userEdited===true};
      sections.push(section);
      if (!index) continue;
      const kept = blocks(note.content).filter(block => {
        if (!paragraph(block)) return true;
        if (seen.has(block)) { duplicateParagraphs++; return false; }
        seen.add(block); return true;
      });
      const kind = categories[note.kind], heading = kind || section.title;
      const key = JSON.stringify([normalized(heading),sourceAttachmentIds.slice().sort()]);
      if (!groups.has(key)) { const group={heading,parts:[]};groups.set(key,group);additions.push(group); }
      const provenance = sourceAttachmentIds.length ? `> 来源资料：${names(sourceAttachmentIds)}` : '> 原笔记没有关联来源资料。';
      const body = kept.length ? nestHeadings(kept.join('\n\n')) : '正文与上文完全相同的段落已合并，原笔记保留在回收站。';
      groups.get(key).parts.push(`${kind && normalized(section.title)!==normalized(heading) ? `### ${section.title}\n\n` : ''}${provenance}\n\n${body}`);
    }
    const mainSources = sourceIds(canonical), main = text(canonical.content);
    const content = [main,mainSources.length ? `> 主笔记来源资料：${names(mainSources)}` : '',...additions.map(group=>`## ${group.heading}\n\n${group.parts.join('\n\n')}`)].filter(Boolean).join('\n\n');
    const warnings = ['将保留全部不同段落；只有完全相同的普通段落会去重，代码块和清单保持原样。', '次笔记及其历史版本进入回收站，可恢复；恢复次笔记不会覆盖主笔记后续的人工修改。'];
    if (includedMain) warnings.push('已同时纳入论文现有主笔记，并继续使用其稳定 ID。');
    if (ordered.some(note=>note.aiDraft)) warnings.push('尚未采纳的 AI 草稿不会混入正文，仍随对应原笔记保留。');
    if (!ordered.every(note=>sourceIds(note).some(id=>mainSources.includes(id)))) warnings.push('所选笔记并非全部共享同一来源；每节将分别标注原始来源。');
    const folderPath=sharedSourceFolder(state,selection)||canonical.folderPath||null;
    if (folderPath && folderPath!==canonical.folderPath) warnings.push(`主笔记将放入来源资料的共同目录「${folderPath}」；原目录保存在合并历史中，原件不会移动。`);
    return {noteIds:ordered.map(note=>note.id),canonicalId:canonical.id,title,content,workspace,projectId,paperId:paper?.id||null,
      folderPath,sections,sourceAttachmentIds:ids(ordered.flatMap(sourceIds)),removedIds:ordered.slice(1).map(note=>note.id),duplicateParagraphs,warnings,version:reviewVersion(state,selection)};
  }
  function resolveId(state, noteId) {
    if (!text(noteId)) return null;
    const direct = list(state.notes).filter(note=>note?.id===noteId);
    if (direct.length) return direct.length===1 && available(state,direct[0]) ? noteId : null;
    const aliases = list(state.notes).filter(note=>available(state,note)&&list(note.mergedNoteIds).includes(noteId));
    return aliases.length===1 ? aliases[0].id : null;
  }
  function apply(original, approved, context = {}) {
    if (!approved || typeof approved.version!=='string') throw new Error('请先预览并确认合并内容。');
    const current = preview(original,approved.noteIds,{canonicalId:approved.canonicalId,title:approved.title});
    if (current.version!==approved.version || current.content!==approved.content || current.canonicalId!==approved.canonicalId || current.folderPath!==approved.folderPath) throw new Error('预览后笔记或关联已变化，请重新预览再合并。');
    const now = context.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error('合并时间无效。');
    const state = clone(original), removed = new Set(current.removedIds), canonical = state.notes.find(note=>note.id===current.canonicalId);
    const oldCanonical = clone(canonical), archived = state.notes.filter(note=>removed.has(note.id)), beforeOwners = owners(state);
    const trashId = context.uid ? context.uid('trash') : `trash_${now}_${Math.random().toString(36).slice(2,12)}`;
    if (!text(trashId) || list(state.trash).some(entry=>entry.id===trashId)) throw new Error('回收站记录 ID 无效或已存在。');
    const rewritten = value => ids(list(value).map(id=>removed.has(id)?canonical.id:id));
    canonical.title=current.title;canonical.content=current.content;canonical.sourceAttachmentIds=current.sourceAttachmentIds;
    if (current.folderPath) canonical.folderPath=current.folderPath;
    canonical.mergedNoteIds=ids([...list(canonical.mergedNoteIds),...archived.flatMap(note=>[note.id,...list(note.mergedNoteIds)])]).filter(id=>id!==canonical.id);
    canonical.consolidatedSections=[...list(canonical.consolidatedSections),...current.sections];
    canonical.tags=ids([oldCanonical,...archived].flatMap(note=>list(note.tags)));
    for (const field of ['sourceNoteIds','relatedNoteIds']) {
      const references=ids([oldCanonical,...archived].flatMap(note=>list(note[field])));
      if (references.length) canonical[field]=rewritten(references).filter(id=>id!==canonical.id);
    }
    canonical.revisionHistory=[...list(canonical.revisionHistory),{title:text(oldCanonical.title),content:text(oldCanonical.content),folderPath:oldCanonical.folderPath||null,updatedAt:oldCanonical.updatedAt||oldCanonical.createdAt||null,savedAt:now,userEdited:oldCanonical.userEdited===true}];
    canonical.userEdited=true;canonical.userEditedAt=now;canonical.updatedAt=timestamp(canonical.updatedAt,now);
    if (current.paperId) { canonical.paperId=current.paperId;const paper=state.papers.find(item=>item.id===current.paperId);paper.noteId=canonical.id; }
    state.notes=state.notes.filter(note=>!removed.has(note.id));
    const rewired = [];
    if (canonical.folderPath!==oldCanonical.folderPath) rewired.push({collection:'notes',id:canonical.id,field:'folderPath',before:oldCanonical.folderPath||null,after:canonical.folderPath});
    for (const [collection,fields] of [['tasks',['sourceNoteIds']],['notes',['sourceNoteIds','relatedNoteIds']]]) {
      for (const item of list(state[collection])) for (const field of fields) if (list(item[field]).some(id=>removed.has(id))) {
        rewired.push({collection,id:item.id,field,before:clone(item[field])});item[field]=rewritten(item[field]).filter(id=>collection!=='notes'||id!==item.id);item.updatedAt=timestamp(item.updatedAt,now);
      }
    }
    for (const item of list(state.imports)) if (list(item.analysis?.noteIds).some(id=>removed.has(id))) {
      rewired.push({collection:'imports',id:item.id,field:'analysis.noteIds',before:clone(item.analysis.noteIds)});item.analysis.noteIds=rewritten(item.analysis.noteIds);item.updatedAt=timestamp(item.updatedAt,now);
    }
    for (const item of list(state.attachments)) if (removed.has(item.noteId)) { rewired.push({collection:'attachments',id:item.id,field:'noteId',before:item.noteId});item.noteId=canonical.id;item.updatedAt=timestamp(item.updatedAt,now); }
    const linkHistory=[],removedLinks=[],resultLinks=[];
    const effectiveType=(link,side) => link[side+'Type'] || (beforeOwners.get(link[side+'Id'])?.size===1 ? [...beforeOwners.get(link[side+'Id'])][0] : '');
    const signature=link=>JSON.stringify([link.sourceId,link.targetId,effectiveType(link,'source'),effectiveType(link,'target'),link.relation||'related']);
    const mapped=list(state.links).map(link => {
      const before=clone(link);let changed=false;
      for (const side of ['source','target']) if (removed.has(link[side+'Id']) && (link[side+'Type']==='note'||(!link[side+'Type']&&beforeOwners.get(link[side+'Id'])?.has('note')))) {link[side+'Id']=canonical.id;link[side+'Type']='note';changed=true;}
      if (changed) {linkHistory.push(before);link.updatedAt=timestamp(link.updatedAt,now);}
      return {link,before,changed};
    });
    const linkKeys=new Set(mapped.filter(item=>!item.changed).map(item=>signature(item.link)));
    for (const {link,before,changed} of mapped) {
      const key=signature(link);
      const self=link.sourceId===link.targetId&&effectiveType(link,'source')===effectiveType(link,'target');
      if (changed && (self||linkKeys.has(key))) {removedLinks.push(before);continue;}
      linkKeys.add(key);resultLinks.push(link);
    }
    state.links=resultLinks;
    const counts={total:archived.length,task:0,note:archived.length,import:0,paper:0};
    const entry={id:trashId,type:'content',title:`合并前的 ${archived.length} 篇笔记`,deletedAt:now,counts,
      data:{notes:archived,tasks:[],imports:[],papers:[],attachments:[],links:removedLinks,attachmentMemberships:[],consolidation:{canonicalId:canonical.id,mergedAt:now,sections:current.sections,linkHistory,rewired}}};
    state.trash=[...list(state.trash),entry];
    return {state,canonicalId:canonical.id,entry,removedIds:current.removedIds,warnings:current.warnings};
  }
  return Object.freeze({preview,apply,resolveId});
}));
