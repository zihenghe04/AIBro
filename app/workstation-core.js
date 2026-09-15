(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const Research = typeof module === 'object' && module.exports ? require('./research-library.js') : globalThis.ResearchLibrary;
  const Wiki = typeof module === 'object' && module.exports ? require('./research-wiki.js') : globalThis.ResearchWiki;
  const Dependencies=typeof module==='object'&&module.exports?require('./task-dependencies'):globalThis.TaskDependencies;
  const spaces = ['日常', '课程', '科研'];
  const norm = value => String(value || '').trim().toLowerCase().replace(/[\s·_-]+/g, '');
  const clone = value => JSON.parse(JSON.stringify(value));
  const folderPath = value => String(value || '').split(/[\\/]+/).map(x => x.trim()).filter(x => x && x !== '.' && x !== '..').slice(0, 6).join('/');
  const runLabel = status => ({ completed: '已完成', 'completed-local': '已完成 · 本地', 'completed-local-fallback': '已完成 · 本地', failed: '执行失败', cancelled: '已停止', interrupted: '已中断', rejected: '已拒绝', 'awaiting-approval': '等待审批', running: '执行中' }[status] || '已结束');
  function endpoint(base, resource = 'responses') {
    const url = new URL(String(base || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 http 或 https');
    url.pathname = url.pathname.replace(/\/(responses|chat\/completions|models)\/?$/, '').replace(/\/$/, '') + '/' + resource;
    url.hash = ''; return url.toString();
  }
  function parsePlan(raw) {
    const source = String(raw || '').trim();
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : source).trim();
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (_) {
      // Gateways occasionally prepend a short sentence or append a code
      // fence marker even when the actual response is valid JSON. Extract the
      // first balanced object/array while respecting quoted strings so one
      // malformed prefix does not turn a valid plan into a text-only reply.
      const start = candidate.search(/[\[{]/);
      if (start >= 0) {
        let depth = 0; let quote = false; let escaped = false; let end = -1;
        for (let index = start; index < candidate.length; index += 1) {
          const char = candidate[index];
          if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quote = false; continue; }
          if (char === '"') { quote = true; continue; }
          if (char === '{' || char === '[') depth += 1;
          else if (char === '}' || char === ']') { depth -= 1; if (depth === 0) { end = index + 1; break; } }
        }
        if (end > start) { try { parsed = JSON.parse(candidate.slice(start, end)); } catch (_) {} }
      }
      if (parsed === undefined) {
        if (/^\s*[\[{]/.test(candidate)) throw new Error('模型返回的操作计划不完整，尚未执行。请重试。');
        return { message: source, actions: [] };
      }
    }
    if (Array.isArray(parsed)) return { message: '', actions: parsed };
    if (!parsed || typeof parsed !== 'object') throw new Error('模型返回了无效的操作计划');
    if (parsed.actions !== undefined && !Array.isArray(parsed.actions)) throw new Error('操作计划 actions 必须是数组');
    return { ...parsed, actions: parsed.actions || [] };
  }
  // Reveal the user-facing message while structured actions are still streaming.
  // Incomplete JSON and tool arguments never spill into the transcript.
  function partialMessage(raw) {
    const source = String(raw || '');
    const match = /"message"\s*:\s*"/.exec(source);
    if (!match) return /^\s*[\[{`]/.test(source) ? '' : source;
    let result = ''; let escaped = false;
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const char = source[i];
      if (escaped) {
        if (char === 'u') {
          const hex = source.slice(i + 1, i + 5); if (!/^[\da-f]{4}$/i.test(hex)) break;
          result += String.fromCharCode(parseInt(hex, 16)); i += 4;
        } else result += ({ n: '\n', r: '\r', t: '\t' }[char] || char);
        escaped = false;
      } else if (char === '\\') escaped = true;
      else if (char === '"') break;
      else result += char;
    }
    return result;
  }
  function dueInWeek(task, now = Date.now()) {
    if (!task.dueAt || task.status === 'done') return false;
    const due = new Date(task.dueAt).getTime();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + 7);
    return Number.isFinite(due) && due >= today.getTime() && due < end.getTime();
  }
  function taskSources(state, task) {
    const ids = new Set(task.sourceAttachmentIds || []);
    return {
      materials: state.imports.filter(item => !item.archived && ids.has(item.id)),
      knowledge: state.notes.filter(note => !note.archived && ((task.sourceNoteIds || []).includes(note.id) || (ids.size && (note.sourceAttachmentIds || []).some(id => ids.has(id)))))
    };
  }
  const labels = { link_local_project: '关联本机项目', set_workspace: '设置空间', create_project: '创建项目', rename_attachment: '重命名资料', assign_attachment: '归档资料', create_knowledge_item: '保存知识', create_note: '保存笔记', update_note: '更新笔记', append_note: '追加笔记', upsert_paper: '保存论文分析', create_task: '创建任务', update_task: '更新任务', delete_task: '删除任务', delete_note: '删除笔记', add_tag: '添加标签', create_link: '建立关联', link_items: '建立关联' };
  labels.upsert_wiki = '保存科研 Wiki';
  labels.upsert_paper = '保存论文分析';
  function applyPlan(original, actions, context = {}) {
    if (!Array.isArray(actions) || actions.length > 80) throw new Error('单次最多执行 80 个动作，请分批整理');
    const state = clone(original); const results = []; const refs = new Map(); const touchedProjects = new Set();
    const now = context.now || Date.now(); let counter = 0;
    const uid = prefix => context.uid ? context.uid(prefix) : `${prefix}_${now}_${++counter}_${Math.random().toString(36).slice(2, 7)}`;
    const space = value => { if (value && !spaces.includes(value)) throw new Error(`未知空间：${value}`); return value || context.workspace || '日常'; };
    const required = (value, label) => { const text = String(value || '').trim(); if (!text) throw new Error(`${label}不能为空`); return text; };
    const findProject = (name, workspace) => state.projects.find(p => !p.archived && p.workspace === workspace && norm(p.name) === norm(name));
    const projectFor = (action, workspace) => {
      // Omitted destination inherits the conversation; explicit null is a
      // deliberate standalone record, including a research source opened from
      // a course conversation. Conflicting legacy name fields are not guesses.
      if (Object.hasOwn(action, 'projectId') && action.projectId === null) {
        if (action.project || action.projectName) throw new Error('项目归属不一致：独立入库时 projectId=null，不能同时指定项目名称');
        return null;
      }
      const ref = action.projectId || action.project || action.projectName;
      const id = refs.get(ref) || ref || context.projectId;
      const project = id ? state.projects.find(p => !p.archived && p.id === id) || findProject(id, workspace) : null;
      if (ref && !project) throw new Error(`找不到目标项目：${ref}。请先创建项目，再引用它的名称。`);
      if (project && action.workspace && project.workspace !== workspace) throw new Error(`项目「${project.name}」属于${project.workspace}空间，计划中的归属不一致`);
      if (project) touchedProjects.add(project.id);
      return project || null;
    };
    const getSources = action => {
      const ids = Array.isArray(action.sourceAttachmentIds) ? [...new Set(action.sourceAttachmentIds)] : [];
      if (ids.some(id => !state.imports.some(item => item.id === id && !item.archived))) throw new Error('计划引用了不存在或已删除的附件');
      return ids;
    };
    const route = (item, project, workspace) => { item.workspace = project?.workspace || workspace; item.projectId = project?.id || null; item.project = project?.name || null; };
    const record = (type, item, text, operation) => results.push({ type, id: item?.id, text, operation, projectId: item?.projectId || (type === 'project' ? item.id : null) });
    const linkSources = (ids, target, project, workspace) => ids.forEach(id => {
      const item = state.imports.find(x => x.id === id);
      if (project && !item.projectId) { route(item, project, workspace); record('import', item, `归档资料：${item.name}`, 'assigned'); }
      if (!state.links.some(link => link.sourceId === id && link.targetId === target.id)) state.links.push({ id: uid('link'), sourceId: id, targetId: target.id, relation: 'source', createdAt: now });
    });
    function validatePaperCitations(sections, sourceAttachmentIds) {
      if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return;
      const allowed = new Set(sourceAttachmentIds || []);
      for (const [sectionName, section] of Object.entries(sections)) {
        if (!section || typeof section !== 'object' || Array.isArray(section) || section.citations == null) continue;
        if (!Array.isArray(section.citations)) throw new Error(`论文「${sectionName}」的引用必须是数组`);
        for (const citation of section.citations) {
          if (!citation || typeof citation !== 'object' || Array.isArray(citation)) throw new Error(`论文「${sectionName}」包含无效的引用`);
          const sourceId = citation.attachmentId || citation.sourceAttachmentId;
          if (typeof sourceId !== 'string' || !sourceId || (citation.attachmentId && citation.sourceAttachmentId && citation.attachmentId !== citation.sourceAttachmentId)) throw new Error(`论文「${sectionName}」的引用缺少一致的来源附件 ID`);
          if (!allowed.has(sourceId)) throw new Error(`论文「${sectionName}」引用了未关联的来源附件：${sourceId}`);
          const source = state.imports.find(item => item.id === sourceId && !item.archived);
          if (!source) throw new Error(`论文「${sectionName}」引用的来源附件不存在或已归档：${sourceId}`);
          if (citation.page == null) continue;
          // Numeric strings from compatible models are accepted, but coercion
          // must not turn booleans, empty strings or arrays into page numbers.
          if (!['number', 'string'].includes(typeof citation.page) || typeof citation.page === 'string' && !/^[1-9]\d*$/.test(citation.page)) throw new Error(`论文「${sectionName}」的引用页码必须是正整数`);
          const page = Number(citation.page);
          if (!Number.isSafeInteger(page) || page < 1) throw new Error(`论文「${sectionName}」的引用页码必须是正整数`);
          const knownPages = (Array.isArray(source.pages) ? source.pages : []).map(entry => Number(entry?.page ?? entry?.pageNumber)).filter(value => Number.isSafeInteger(value) && value > 0);
          const declaredCount = Number(source.pageCount);
          const upperBound = Number.isSafeInteger(declaredCount) && declaredCount > 0 ? declaredCount : knownPages.length ? Math.max(...knownPages) : null;
          if (upperBound !== null && page > upperBound) throw new Error(`论文「${sectionName}」的引用页码超出已知来源范围：${sourceId} 第 ${page} 页`);
          // With no page metadata we can validate syntax only. This never
          // certifies that a quote is present, or marks analysis as reviewed.
        }
      }
    }
    function applyNoteProposal(item, proposal, sources) {
      if(item.kind?.startsWith('科研 Wiki/')&&context.protectNoteUpdates)throw new Error('科研 Wiki 更新请使用 upsert_wiki，先完整读取正文与已有草稿。');
      if(item.kind==='随记'&&context.protectNoteUpdates)throw new Error('原始随记不可由 Agent 改写，请创建独立整理笔记并使用不同标题。');
      const content = typeof proposal.content === 'string' ? proposal.content : String(item.content || '');
      const title = typeof proposal.title === 'string' ? proposal.title : String(item.title || '');
      if (item.userEdited || context.protectNoteUpdates === true || item.aiDraft) {
        // An incremental analysis proposes a separate draft. Human wording and
        // its title remain authoritative until the user edits and saves it.
        if (content === String(item.content || '') && (context.protectNoteUpdates !== true || title === String(item.title || ''))) return 'matched';
        const next = { content, title, createdAt: now, sourceAttachmentIds: [...sources] };
        const previous = item.aiDraft;
        if (!previous || previous.content !== content || previous.title !== title || JSON.stringify(previous.sourceAttachmentIds || []) !== JSON.stringify(next.sourceAttachmentIds)) {
          item.aiDraft = next; item.updatedAt = now;
        }
        return 'drafted';
      }
      if (content === String(item.content || '') && title === String(item.title || '')) return 'matched';
      const history = Array.isArray(item.revisionHistory) ? item.revisionHistory.slice(-19).map(clone) : [];
      history.push({ title: String(item.title || ''), content: String(item.content || ''), updatedAt: item.updatedAt || item.createdAt || null, savedAt: now, userEdited: item.userEdited === true });
      Object.assign(item, { title, content, revisionHistory: history, updatedAt: now });
      return 'updated';
    }
    function taskDate(value, label) {
      if (value === null || value === '') return { value: null, at: null, end: null };
      if (typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) return { value, at: value, end: value };
      const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/.exec(value);
      if (!match) throw new Error(`任务${label}时间无效`);
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(0, 0, 0, 0);
      if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number(match[4] || 0) > 23 || Number(match[5] || 0) > 59 || Number(match[6] || 0) > 59 || Number(match[7] || 0) > 23 || Number(match[8] || 0) > 59) throw new Error(`任务${label}时间无效`);
      if (value.length === 10) {
        const local = new Date(0); local.setFullYear(year, month - 1, day); local.setHours(0, 0, 0, 0);
        const end = new Date(local); end.setDate(end.getDate() + 1);
        return { value, at: local.getTime(), end: end.getTime() - 1 };
      }
      const at = Date.parse(value); if (!Number.isFinite(at)) throw new Error(`任务${label}时间无效`);
      return { value, at, end: at };
    }
    function cleanTaskPatch(patch, previous = {}) {
      const result = {};
      for (const key of ['title', 'description', 'status', 'priority', 'startAt', 'dueAt', 'checklist', 'dependsOn']) if (Object.prototype.hasOwnProperty.call(patch, key)) result[key] = patch[key];
      if ('title' in result) result.title = required(result.title, '任务名称');
      if ('status' in result && !['todo', 'in_progress', 'done', 'blocked'].includes(result.status)) throw new Error('任务状态无效');
      if ('priority' in result && !['low', 'medium', 'high'].includes(result.priority)) throw new Error('任务优先级无效');
      for (const [field, label] of [['startAt', '开始'], ['dueAt', '截止']]) if (Object.hasOwn(result, field)) result[field] = taskDate(result[field], label).value;
      if (Object.hasOwn(result, 'startAt') || Object.hasOwn(result, 'dueAt')) {
        const start = Object.hasOwn(result, 'startAt') ? result.startAt : previous.startAt;
        const due = Object.hasOwn(result, 'dueAt') ? result.dueAt : previous.dueAt;
        if (start !== null && start !== undefined && start !== '' && due !== null && due !== undefined && due !== '' && taskDate(start, '开始').at > taskDate(due, '截止').end) throw new Error('任务截止时间不能早于开始时间');
      }
      if ('dependsOn' in result) result.dependsOn=Dependencies.validate(state,{...previous,...result},Array.isArray(result.dependsOn)?result.dependsOn.map(id=>refs.get(id)||id):result.dependsOn);
      if ('checklist' in result) {
        if (!Array.isArray(result.checklist)) throw new Error('检查清单必须是数组');
        result.checklist = result.checklist.map(x => typeof x === 'string' ? { text: x, done: false } : { text: String(x.text || ''), done: !!x.done }).filter(x => x.text.trim());
      }
      return result;
    }
    for (const action of actions) {
      if (!action || !labels[action.type]) throw new Error(`暂不支持操作：${action?.type || '空操作'}`);
      const type = action.type; let workspace = space(action.workspace);
      if (type === 'set_workspace') { context = { ...context, workspace }; continue; }
      if (type === 'create_project') {
        const name = required(action.name || action.title, '项目名称'); let project = findProject(name, workspace); const existing = !!project;
        if (!project) { project = { id: uid('project'), name, workspace, description: String(action.description || ''), createdAt: now, updatedAt: now, sourceConversationId: context.conversationId }; state.projects.push(project); }
        [name, action.id, action.ref].filter(Boolean).forEach(ref => refs.set(ref, project.id)); touchedProjects.add(project.id);
        record('project', project, `${existing ? '匹配已有项目' : '创建项目'}：${name}`, existing ? 'matched' : 'created'); continue;
      }
      if (type === 'link_local_project') {
        const folder = (context.localCandidates || []).find(item => item.id === action.candidateId);
        if (!folder || !folder.rootId || !folder.path || !folder.name) throw new Error('只能关联本次已验证的本机候选目录');
        const project = projectFor(action, workspace);
        if (!project) throw new Error('关联本机目录前必须先创建或指定项目');
        const existing = state.projects.find(item => item.localFolder && (item.localFolder.id === folder.id || item.localFolder.path === folder.path));
        if (existing?.archived || existing?.deletedAt) throw new Error(`该目录属于已归档的项目「${existing.name}」，请先恢复项目`);
        if (existing && existing.id !== project.id) throw new Error(`该目录已关联「${existing.name}」，请使用已有项目`);
        if (project.localFolder?.id && project.localFolder.id !== folder.id && project.localFolder.path !== folder.path) throw new Error('项目已有本机目录，请手动调整关联');
        project.localFolder = { id: folder.id, rootId: folder.rootId, name: folder.name, path: folder.path, connectedAt: project.localFolder?.connectedAt || now };
        project.updatedAt = now;
        record('project', project, `关联本机目录：${folder.name}`, 'linked'); continue;
      }
      if (type === 'rename_attachment' || type === 'assign_attachment' || type === 'add_tag') {
        const id = action.attachmentId || action.sourceAttachmentId || action.targetId;
        const item = state.imports.find(x => x.id === id && !x.archived); if (!item) throw new Error('找不到要整理的资料');
        if (type === 'rename_attachment') { item.originalName ||= item.name; item.name = required(action.newName, '资料名称').replace(/[\\/]/g, '-'); item.updatedAt = now; record('import', item, `重命名资料：${item.name}`, 'renamed'); }
        else if (type === 'assign_attachment') { const project = projectFor(action, workspace); route(item, project, workspace); item.folderPath = folderPath(action.folderPath || item.folderPath); item.updatedAt = now; record('import', item, `归档资料：${item.name}`, 'assigned'); }
        else { item.tags = [...new Set([...(item.tags || []), required(action.tag, '标签')])]; item.updatedAt = now; record('import', item, `添加标签：${action.tag}`, 'updated'); }
        continue;
      }
      if (type === 'upsert_wiki') {
        const project = projectFor(action, '科研');
        const result = Wiki.apply(state, action, {...context, projectId:project?.id||null, uid, now});
        record('note', result.note, `${result.operation==='drafted'?'生成 Wiki 待审阅修改':'保存科研 Wiki'}：${result.note.title}`, result.operation);
        if(action.id)refs.set(action.id,result.note.id);
        continue;
      }
      if (type === 'upsert_paper') {
        if (!Research) throw new Error('文献模块尚未加载，请重启应用');
        const title = required(action.title, '论文标题');
        const sources = getSources(action);
        if (!sources.length) throw new Error('论文分析必须关联已导入的来源附件');
        const project = projectFor(action, '科研');
        if (project && project.workspace !== '科研') throw new Error('论文必须归属科研项目');
        const source = state.imports.find(item => item.id === sources[0]);
        const paperReference = action.paperId || refs.get(action.id) || action.id;
        const previous = (state.papers || []).find(item => item.id === paperReference);
        if (action.paperId && !previous) throw new Error('找不到要更新的论文');
        const input = { ...action, id: previous?.id, title, workspace: '科研', projectId: project?.id || previous?.projectId || null, sourceAttachmentId: sources[0], sourceAttachmentIds: sources, url: action.url || source?.url || previous?.url || null, updatedAt: now };
        // Agent output cannot silently certify itself as a human-reviewed paper.
        delete input.reviewed; delete input.reviewedAt; delete input.userEdits;
        const result = Research.upsertPaper(state.papers || [], input, { now });
        state.papers = result.papers;
        const paper = result.paper;
        // Identity deduplication may find a paper which was deliberately
        // archived. Do not create invisible results or resurrect it on retry.
        const retainedProject = paper.projectId && state.projects.find(item => item.id === paper.projectId);
        const unavailable = item => item && (item.archived || item.archivedAt || item.deleted || item.deletedAt);
        if (unavailable(paper) || (paper.projectId && (!retainedProject || unavailable(retainedProject)))) throw new Error('该论文或所属科研项目已归档、删除或不可用，请先恢复后再更新');
        const paperProject = state.projects.find(item => item.id === paper.projectId && !item.archived) || project;
        paper.sourceAttachmentIds = [...new Set([...(paper.sourceAttachmentIds || []), ...sources])];
        // Validate both the new proposal and retained human evidence. A bad
        // citation aborts the cloned transaction; never silently drop user edits.
        validatePaperCitations(action.structured || action.sections, paper.sourceAttachmentIds);
        validatePaperCitations(paper.structured, paper.sourceAttachmentIds);
        validatePaperCitations(paper.userEdits, paper.sourceAttachmentIds);
        if (previous) {
          paper.userEdits = previous.userEdits || {};
          paper.reviewed = previous.reviewed || false;
          paper.reviewedAt = previous.reviewedAt || null;
        }
        paper.sourceConversationId ||= context.conversationId;
        paper.noteId ||= `note_${paper.id}`;
        const markdown = Research.paperMarkdown(paper);
        let note = state.notes.find(item => item.id === paper.noteId);
        if (unavailable(note)) throw new Error('论文主笔记已归档或删除，请先恢复后再更新');
        const newNote = !note;
        if (newNote) { note = { id: paper.noteId, title: paper.title, content: markdown, createdAt: now }; state.notes.push(note); }
        const noteSources = [...new Set([...(note.sourceAttachmentIds || []), ...paper.sourceAttachmentIds])];
        const sourceFolders = paper.sourceAttachmentIds.map(id => {
          const matches = state.imports.filter(item => item.id === id);
          const item = matches.length === 1 ? matches[0] : null;
          const sourceProject = item?.projectId && state.projects.find(project => project.id === item.projectId);
          if (!item || unavailable(item) || (item.projectId || null) !== (paper.projectId || null) || (sourceProject?.workspace || item.workspace) !== '科研') return '';
          return typeof item.folderPath === 'string' ? item.folderPath.trim() : '';
        });
        const commonSourceFolder = sourceFolders.length && sourceFolders.every(path => path && path === sourceFolders[0]) ? sourceFolders[0] : '';
        // Existing folder choices can be manual even without a body edit.
        const noteFolder = (!newNote && typeof note.folderPath === 'string' && note.folderPath.trim())
          ? note.folderPath : commonSourceFolder || `文献库/${paper.year || '未注明年份'}/${folderPath(paper.title)}`;
        const noteOperation = newNote ? 'created' : applyNoteProposal(note, { title: paper.title, content: markdown }, noteSources);
        // Full Markdown edits, including consolidated notes, are authoritative.
        // Structured paper updates may propose aiDraft but cannot replace them.
        Object.assign(note, { paperId: paper.id, kind: '论文分析', workspace: '科研', projectId: paper.projectId, project: paperProject?.name || previous?.project || null, sourceAttachmentIds: noteSources, sourceConversationId: note.sourceConversationId || paper.sourceConversationId, tags: [...new Set([...(note.tags || []), ...(paper.tags || [])])], folderPath: noteFolder, updatedAt: now });
        linkSources(sources, note, paperProject, '科研');
        record('note', note, `${noteOperation === 'drafted' ? '生成论文待合并草稿' : noteOperation === 'matched' ? '保留现有论文笔记' : newNote ? '保存论文分析' : '增量更新论文'}：${note.title}`, noteOperation);
        if (action.id) refs.set(action.id, paper.id);
        continue;
      }
      if (type === 'create_task' || type === 'create_knowledge_item' || type === 'create_note') {
        const project = projectFor(action, workspace); workspace = project?.workspace || workspace; const sources = getSources(action); const title = required(action.title, '名称');
        const collection = type === 'create_task' ? state.tasks : state.notes;
        let item = collection.find(x => !x.archived && (x.projectId || null) === (project?.id || null) && x.workspace === workspace && norm(x.title) === norm(title)); const existing = !!item; let noteOperation = existing ? 'matched' : 'created';
        if (!item) {
          item = { id: uid(type === 'create_task' ? 'task' : 'note'), title, sourceAttachmentIds: sources, createdAt: now, updatedAt: now, sourceConversationId: context.conversationId, agentRunId: context.runId };
          route(item, project, workspace);
          if (type === 'create_task') Object.assign(item, { description: '', status: 'todo', priority: 'medium', dueAt: null, checklist: [] }, cleanTaskPatch(action,item));
          else Object.assign(item, { content: String(action.content || action.body || ''), kind: String(action.kind || '笔记'), tags: action.tags || [], folderPath: folderPath(action.folderPath) });
          collection.push(item);
        } else {
          // A repeated task is the same work, with possibly new evidence. Keep
          // the user's dates, progress and checklist while adding its sources.
          const mergedSources = [...new Set([...(item.sourceAttachmentIds || []), ...sources])];
          if (type !== 'create_task') {
            const content = Object.hasOwn(action, 'content') ? String(action.content ?? '') : Object.hasOwn(action, 'body') ? String(action.body ?? '') : String(item.content || '');
            noteOperation = applyNoteProposal(item, { title, content }, mergedSources);
          }
          if (mergedSources.length !== (item.sourceAttachmentIds || []).length) item.updatedAt = now;
          item.sourceAttachmentIds = mergedSources;
        }
        linkSources(sources, item, project, workspace);
        if (type === 'create_task') record('task', item, `${existing ? '已有任务' : '创建任务'}：${item.title}`, existing ? 'matched' : 'created');
        else record('note', item, `${noteOperation === 'drafted' ? '生成待合并草稿' : noteOperation === 'matched' ? '保留现有知识' : existing ? '更新知识' : '保存知识'}：${item.title}`, noteOperation);
        if (action.id) refs.set(action.id, item.id); continue;
      }
      if (type === 'update_task' || type === 'update_note' || type === 'append_note' || type === 'delete_task' || type === 'delete_note') {
        const isTask = type.endsWith('task'); const key = isTask ? 'tasks' : 'notes'; const id = type === 'append_note' ? action.noteId : action.taskId || action.noteId;
        if (isTask && Object.hasOwn(context, 'allowedTaskIds')) {
          if (!Array.isArray(context.allowedTaskIds) || context.allowedTaskIds.some(taskId => typeof taskId !== 'string' || !taskId)) throw new Error('可更新任务范围无效');
          if (!context.allowedTaskIds.includes(id)) throw new Error('任务不在当前允许更新范围内，请使用当前任务的 ID');
        }
        if ((type === 'update_note' || type === 'append_note') && Object.hasOwn(context, 'allowedNoteIds')) {
          if (!Array.isArray(context.allowedNoteIds) || context.allowedNoteIds.some(noteId => typeof noteId !== 'string' || !noteId)) throw new Error('可更新笔记范围无效');
          if (!context.allowedNoteIds.includes(id)) throw new Error('笔记不在当前允许更新范围内，请使用当前笔记的 ID');
        }
        const item = state[key].find(x => x.id === id && !x.archived); if (!item) throw new Error(`找不到${isTask ? '任务' : '笔记'}：${id || '缺少 ID'}`);
        if ((type === 'update_note' || type === 'append_note') && (item.archivedAt || item.deleted || item.deletedAt || (item.projectId && !state.projects.some(project => project.id === item.projectId && !project.archived && !project.archivedAt && !project.deleted && !project.deletedAt)))) throw new Error(`笔记已归档、删除或不可用：${id}`);
        if (isTask && (item.archivedAt || item.deleted || item.deletedAt || (item.projectId && !state.projects.some(project => project.id === item.projectId && !project.archived && !project.archivedAt && !project.deleted && !project.deletedAt)))) throw new Error(`任务已归档、删除或不可用：${id}`);
        if(type==='delete_note'&&item.kind==='随记'&&context.protectNoteUpdates)throw new Error('原始随记请由用户在界面中删除。');
        if (type.startsWith('delete')) { state.trash.push({ type: isTask ? 'task' : 'note', title: item.title, deletedAt: now, data: { [key]: [item], links: state.links.filter(x => x.sourceId === id || x.targetId === id) } }); state[key] = state[key].filter(x => x.id !== id); state.links = state.links.filter(x => x.sourceId !== id && x.targetId !== id); record(isTask ? 'task' : 'note', item, `移入回收站：${item.title}`, 'deleted'); }
        else {
          const patch = type === 'append_note' ? {} : { ...(action.patch || {}) }; if (type !== 'append_note' && Object.hasOwn(action, 'status')) patch.status = action.status;
          let operation = 'updated';
          if (isTask) Object.assign(item, cleanTaskPatch(patch, item));
          else {
            if (type === 'append_note') {
              if (typeof action.content !== 'string' || !action.content.trim()) throw new Error('追加笔记必须提供非空的新增 Markdown 正文');
              const approved = String(item.content || ''), addition = action.content;
              const alreadyApproved = approved === addition || approved.endsWith('\n\n' + addition);
              const body = alreadyApproved ? approved : typeof item.aiDraft?.content === 'string' ? item.aiDraft.content : approved;
              patch.content = body === addition || body.endsWith('\n\n' + addition)
                ? body : body ? body + '\n\n' + addition : addition;
              if (!alreadyApproved && item.aiDraft) {
                patch.title = item.aiDraft.title || item.title;
                if (patch.content !== body) item.aiDraftHistory = [...(item.aiDraftHistory || []), { ...clone(item.aiDraft), savedAt: now, reason: 'extended' }];
              }
            }
            const sources = getSources(action);
            const mergedSources = [...new Set([...(item.sourceAttachmentIds || []), ...(item.aiDraft?.sourceAttachmentIds || []), ...sources])];
            operation = applyNoteProposal(item, patch, mergedSources);
            item.sourceAttachmentIds = mergedSources;
            if (typeof patch.kind === 'string') item.kind = patch.kind;
            const project = state.projects.find(entry => entry.id === item.projectId && !entry.archived) || null;
            linkSources(sources, item, project, item.workspace || workspace);
          }
          if (type !== 'append_note' && (action.projectId || action.project || action.projectName)) route(item, projectFor(action, workspace), workspace);
          item.updatedAt = now; if (isTask && Object.hasOwn(patch, 'status')) item.completedAt = item.status === 'done' ? (item.completedAt ?? now) : null;
          record(isTask ? 'task' : 'note', item, `${operation === 'drafted' ? '生成待合并草稿' : operation === 'matched' ? '保留现有笔记' : isTask ? '更新任务' : type === 'append_note' ? '追加笔记' : '更新笔记'}：${item.title}`, operation);
        }
        if (item.projectId) touchedProjects.add(item.projectId); continue;
      }
      if (type === 'create_link' || type === 'link_items') {
        const sourceId = refs.get(action.sourceId) || action.sourceId; const targetId = refs.get(action.targetId) || action.targetId;
        const all = [...state.tasks, ...state.notes, ...state.imports, ...state.projects];
        if (!all.some(x => x.id === sourceId) || !all.some(x => x.id === targetId)) throw new Error('关联引用了不存在的内容');
        if (!state.links.some(x => x.sourceId === sourceId && x.targetId === targetId)) state.links.push({ id: uid('link'), sourceId, targetId, relation: String(action.relation || 'related'), createdAt: now });
      }
    }
    touchedProjects.forEach(id => { const project = state.projects.find(item => item.id === id); if (project) project.updatedAt = now; });
    const uniqueResults = [...new Map(results.map(r => [`${r.type}:${r.id}:${r.operation}`, r])).values()];
    return { state, results: uniqueResults, projectIds: [...touchedProjects] };
  }
  return { endpoint, folderPath, runLabel, parsePlan, partialMessage, dueInWeek, taskSources, applyPlan, actionLabels: labels };
});
