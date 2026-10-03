/* Editable local action plans. Preview is transactional; this module never executes actions. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PlanReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  const Assignment=typeof module==='object'&&module.exports?require('./record-assignment'):root.RecordAssignment;
  const taskWorkflow = () => typeof module === 'object' && module.exports ? require('./task-workflow.js') : root.TaskWorkflow;
  const workflowLabel = (state, value) => taskWorkflow().names(state)[value] || (value == null || value === '' ? t('未分类', 'Uncategorized') : String(value));
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const t = (zh, en) => /^en(?:-|$)/i.test(root.document?.documentElement.lang || '') ? en : zh;
  const fault = (code, zh, en) => Object.assign(new Error(t(zh, en)), { code });
  const collections = ['projects', 'tasks', 'notes', 'imports', 'papers', 'attachments'];
  const unavailable = item => !item || item.archived || item.archivedAt || item.deleted || item.deletedAt;
  function stable(value) { if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined && typeof value[key] !== 'function').map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'; return JSON.stringify(value); }
  function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
  const names = {
    create_project: ['创建项目', 'Create project'], set_workspace: ['切换后续步骤空间', 'Set space for following steps'],
    assign_record: ['修改记录归属', 'Move existing record'],
    create_task: ['创建任务', 'Create task'], update_task: ['更新任务', 'Update task'], delete_task: ['任务移入回收站', 'Move task to trash'],
    create_note: ['保存笔记', 'Save note'], create_knowledge_item: ['保存知识', 'Save knowledge'], update_note: ['更新笔记', 'Update note'], append_note: ['追加笔记', 'Append to note'], delete_note: ['笔记移入回收站', 'Move note to trash'],
    rename_attachment: ['重命名资料', 'Rename material'], assign_attachment: ['整理资料归属', 'Assign material'], add_tag: ['添加标签', 'Add tag'], delete_attachment: ['资料移入回收站', 'Move material to trash'],
    create_link: ['建立关联', 'Create link'], link_items: ['建立关联', 'Create link'], link_local_project: ['关联本机目录', 'Link local folder'], upsert_wiki: ['保存科研 Wiki', 'Save research wiki'], upsert_paper: ['保存论文分析', 'Save paper analysis']
  };
  const field = (key, zh, en, type = 'text', options) => ({ key, zh, en, type, options });
  const project = field('projectId', '归属项目', 'Project', 'project');
  const workspace = field('workspace', '空间', 'Space', 'select', ['日常', '课程', '科研']);
  const title = field('title', '标题', 'Title'), content = field('content', 'Markdown 正文', 'Markdown content', 'textarea');
  const taskFields = [title, field('description', '任务说明', 'Description', 'textarea'), field('status', '状态', 'Status', 'select', ['todo', 'in_progress', 'done', 'blocked']), field('priority', '优先级', 'Priority', 'select', ['low', 'medium', 'high']), field('workflowCategory', '任务分类', 'Task category', 'select', ['P0', 'P1', 'P2', 'P3']), field('startAt', '开始时间', 'Start time', 'date'), field('dueAt', '截止时间', 'Due time', 'date'), field('dependsOn', '前置任务', 'Dependencies', 'tasks')];
  const noteFields = [title, content, field('kind', '笔记类型', 'Note kind')];
  const reviewTaskFields = [...taskFields, field('reminderMinutes', '提前提醒（分钟）', 'Reminder (minutes)'), field('checklist', '检查清单', 'Checklist')];
  const reviewTaskKeys = reviewTaskFields.map(spec => spec.key);
  const schemas = {
    create_project: [field('name', '项目名称', 'Project name'), field('description', '项目说明', 'Description', 'textarea'), workspace], set_workspace: [workspace],
    assign_record: [field('targetProjectId', '新归属项目', 'Destination project', 'project')],
    create_task: [...taskFields, project, workspace], update_task: [...taskFields.map(item => ({ ...item, key: 'patch.' + item.key })), project],
    create_note: [...noteFields, field('folderPath', '资料夹', 'Folder'), project, workspace], create_knowledge_item: [...noteFields, field('folderPath', '资料夹', 'Folder'), project, workspace],
    update_note: [...noteFields.map(item => ({ ...item, key: 'patch.' + item.key })), project], append_note: [content],
    rename_attachment: [field('newName', '资料名称', 'Material name')], assign_attachment: [project, workspace, field('folderPath', '资料夹', 'Folder')], add_tag: [field('tag', '标签', 'Tag')],
    create_link: [field('sourceId', '起点', 'From', 'record'), field('targetId', '终点', 'To', 'record'), field('relation', '关系', 'Relation')], link_items: [field('sourceId', '起点', 'From', 'record'), field('targetId', '终点', 'To', 'record'), field('relation', '关系', 'Relation')],
    link_local_project: [project, field('candidateId', '已验证本机目录', 'Verified local folder', 'candidate')]
  };
  const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
  function set(object, path, value) { const keys = path.split('.'); const key = keys.pop(); let target = object; for (const part of keys) target = target[part] ||= {}; target[key] = copy(value); }
  function stamp(text) { let a = 0x811c9dc5, b = 0x9e3779b9; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x85ebca6b) >>> 0; } return `${text.length}:${a}:${b}`; }
  function normalizedProposal(action) { const proposal = copy(action); if (proposal.type === 'update_task' && Object.hasOwn(proposal, 'status')) { proposal.patch = { ...(proposal.patch || {}), status: proposal.status }; delete proposal.status; } return proposal; }
  function proposalFields(action) { const result = {}; if (action.type === 'update_task') for (const key of reviewTaskKeys) { if (Object.hasOwn(action.patch || {}, key)) result['patch.' + key] = copy(action.patch[key]); } else if (action.type === 'rename_attachment' && Object.hasOwn(action, 'newName')) result.newName = action.newName; return result; }
  function reviewBase(state, rows) {
    const taskIds = new Set(rows.filter(row => row.action.type === 'update_task').map(row => row.action.taskId));
    const importIds = new Set(rows.filter(row => ['rename_attachment','assign_attachment'].includes(row.action.type)).map(row => row.action.attachmentId || row.action.sourceAttachmentId || row.action.targetId));
    const pick = (item, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, copy(item[key])]));
    return { tasks: (state.tasks || []).filter(item => taskIds.has(item.id)).map(item => ({ ...pick(item, ['id','workspace','projectId','project',...reviewTaskKeys]), workflowCategory: taskWorkflow().category(item) })), imports: (state.imports || []).filter(item => importIds.has(item.id)).map(item => pick(item, ['id','name','workspace','projectId','project','folderPath'])), projects: (state.projects || []).map(item => pick(item, ['id','name','workspace','archived','archivedAt','deleted','deletedAt'])) };
  }
  function normalizeTaskValue(key, value) {
    if (key === 'title') return String(value || '').trim();
    if (['startAt','dueAt'].includes(key) && value === '') return null;
    if (key === 'dependsOn' && Array.isArray(value)) return [...new Set(value)];
    if (key === 'checklist' && Array.isArray(value)) {
      // A null item throws in Core. Keep it visible and let the real validator
      // reject it; treating it as an empty checklist would hide an invalid plan.
      if (value.some(item => item == null)) return copy(value);
      return value.map(item => typeof item === 'string' ? { text: item, done: false } : { text: String(item.text || ''), done: !!item.done }).filter(item => item.text.trim());
    }
    return copy(value);
  }
  // Compile field decisions in execution order. Only known Core task fields and
  // scalar renames can be rejected here; all other parameters are preserved.
  // The real Core validates the resulting full plan after this presentation pass.
  function compileRows(rows, base, context) {
    const tasks = new Map((base.tasks || []).map(item => [item.id, copy(item)])), imports = new Map((base.imports || []).map(item => [item.id, copy(item)]));
    const projects = new Map((base.projects || []).flatMap(item => [[item.id,item], [item.name,item]]));
    let space = context.workspace || '日常'; const actions = [], reviews = new Map();
    for (const row of rows) {
      const action = normalizedProposal(row.action), originalFields = row.originalFields || proposalFields(action), decisions = row.decisions || {}, fields = []; let suppressed = false;
      if (action.type === 'update_task') {
        const target = tasks.get(action.taskId), patch = { ...(action.patch || {}) };
        for (const key of reviewTaskKeys) if (Object.hasOwn(patch,key)) {
          const path = 'patch.' + key, before = copy(target?.[key]), after = normalizeTaskValue(key,patch[key]), unchanged = !!target && stable(before) === stable(after), accepted = decisions[path] !== 'reject';
          fields.push({ path, label: t(...[reviewTaskFields.find(spec=>spec.key===key).zh,reviewTaskFields.find(spec=>spec.key===key).en]), before, proposed: copy(patch[key]), after, accepted, unchanged, edited: !Object.hasOwn(originalFields,path) || stable(originalFields[path]) !== stable(patch[key]), original: copy(originalFields[path]) });
          if (!accepted || unchanged) delete patch[key];
        }
        action.patch = patch;
        const reference = action.projectId || action.project || action.projectName, destination = projects.get(reference);
        const routeChanged = !!reference && (!target || !destination || (target.projectId || null) !== destination.id || target.workspace !== destination.workspace);
        const changedKeys = reviewTaskKeys.filter(key => Object.hasOwn(patch,key));
        suppressed = !!target && !changedKeys.length && !routeChanged;
        if (row.included && !suppressed && target) { for (const key of changedKeys) target[key] = normalizeTaskValue(key, patch[key]); if (destination && reference) Object.assign(target,{projectId:destination.id,project:destination.name,workspace:destination.workspace}); }
      } else if (action.type === 'rename_attachment') {
        const target = imports.get(action.attachmentId || action.sourceAttachmentId || action.targetId), after = String(action.newName || '').trim().replace(/[\\/]/g,'-'), unchanged = !!target && target.name === after, accepted = decisions.newName !== 'reject';
        fields.push({ path:'newName',label:t('资料名称','Material name'),before:target?.name,proposed:action.newName,after,accepted,unchanged,edited:stable(originalFields.newName)!==stable(action.newName),original:originalFields.newName });
        suppressed = !accepted || unchanged; if (row.included && !suppressed && target) target.name = after;
      }
      reviews.set(row.key,{ fields, suppressed, effective: row.included && !suppressed, action: suppressed ? null : action });
      if (!row.included || suppressed) continue;
      actions.push(action);
      if (action.type === 'set_workspace') space = action.workspace || space;
      if (action.type === 'create_project') { const name = String(action.name || action.title || '').trim(); const existing = (base.projects || []).find(p=>!unavailable(p)&&p.workspace===(action.workspace||space)&&String(p.name||'').trim().toLowerCase().replace(/[\s·_-]+/g,'')===name.toLowerCase().replace(/[\s·_-]+/g,'')); const project = existing || {id:action.id||action.ref||name,name,workspace:action.workspace||space}; for (const ref of [name,action.id,action.ref]) if(ref) projects.set(ref,project); }
      if (action.type === 'delete_task') tasks.delete(action.taskId);
      if (action.type === 'delete_attachment') imports.delete(action.attachmentId);
      if (action.type === 'assign_attachment') { const item = imports.get(action.attachmentId || action.sourceAttachmentId || action.targetId); if(item) { const explicitNull=Object.hasOwn(action,'projectId')&&action.projectId===null; const p=explicitNull?null:projects.get(action.projectId||action.project||action.projectName||context.projectId); item.projectId=p?.id||null;item.project=p?.name||null;item.workspace=p?.workspace||action.workspace||space;item.folderPath=String(action.folderPath||item.folderPath||'').split(/[\\/]+/).map(x=>x.trim()).filter(x=>x&&x!=='.'&&x!=='..').slice(0,6).join('/'); } }
    }
    return { actions, reviews };
  }
  const rowsRecord = rows => rows.map(row => ({ key:row.key,action:copy(row.action),included:!!row.included,decisions:copy(row.decisions || {}),originalFields:copy(row.originalFields || {}) }));
  function restoreFieldReview(value, actions, context) {
    if (!value || value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > 80 || !value.base || !Array.isArray(value.base.tasks) || !Array.isArray(value.base.imports) || !Array.isArray(value.base.projects)) return null;
    const data = copy(value); delete data.checksum;
    if (stable(data).length > 4_000_000 || value.checksum !== stamp(stable(data)) || value.pendingFingerprint !== stamp(stable(actions)) || value.contextFingerprint !== stamp(stable(context))) return null;
    const keys = new Set();
    for (const row of value.rows) {
      if (!row || typeof row.key !== 'string' || !row.key || keys.has(row.key) || typeof row.included !== 'boolean' || !row.action || typeof row.action !== 'object' || Array.isArray(row.action) || !names[row.action.type] || !row.decisions || typeof row.decisions !== 'object' || Array.isArray(row.decisions) || !row.originalFields || typeof row.originalFields !== 'object' || Array.isArray(row.originalFields)) return null;
      keys.add(row.key); const allowed = row.action.type === 'update_task' ? reviewTaskKeys.map(key=>'patch.'+key) : row.action.type === 'rename_attachment' ? ['newName'] : [];
      if (Object.entries(row.decisions).some(([key,value])=>!allowed.includes(key)||!['accept','reject'].includes(value)) || Object.keys(row.originalFields).some(key=>!allowed.includes(key))) return null;
    }
    try { if (stable(compileRows(value.rows,value.base,context).actions) !== stable(actions)) return null; } catch (_) { return null; }
    return copy(value);
  }
  function contextFor(host, run) { const context = copy(host.contextForRun?.(run) || { workspace: run.workspace, projectId: run.projectId, conversationId: run.conversationId, runId: run.id }); delete context.now; delete context.uid; return context; }
  function preview(host, state, actions, context) {
    let serial = 0;
    const taken = new Set(collections.flatMap(key => (state[key] || []).map(item => item.id)));
    return host.applyPlan(state, copy(actions), { ...copy(context), recordAssignmentPreview:true, now: 1, uid: prefix => { let id; do { id = '__plan_preview_' + prefix + '_' + ++serial; } while (taken.has(id)); taken.add(id); return id; } });
  }
  // Capture only read / written objects, all project identities used for name routing,
  // and deduplication candidates. Unrelated note edits do not invalidate a task plan.
  // Complex wiki/paper operations depend on their full specialised collections.
  function scope(state, actions, context, outcome) {
    const ids = new Set([context.projectId, ...(context.allowedTaskIds || []), ...(context.allowedNoteIds || []), ...(context.explicitReferences || []).map(ref => ref.id || ref.recordId)] .filter(Boolean));
    const lookup = new Map(collections.flatMap(key => (state[key] || []).map(item => [item.id, item])));
    const visit = value => { if (typeof value === 'string' && lookup.has(value)) ids.add(value); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
    actions.forEach(visit);
    const normalization = value => String(value || '').trim().toLowerCase().replace(/[\s·_-]+/g, '');
    const taskNames = actions.filter(a => a.type === 'create_task').map(a => normalization(a.title));
    const noteNames = actions.filter(a => ['create_note', 'create_knowledge_item'].includes(a.type)).map(a => normalization(a.title));
    for (const item of state.tasks || []) if (taskNames.includes(normalization(item.title))) ids.add(item.id);
    for (const item of state.notes || []) if (noteNames.includes(normalization(item.title))) ids.add(item.id);
    // Dependency validation reads transitive prerequisites; source associations
    // and task deliverables may also name records outside the direct action.
    for (const id of ids) { const item = lookup.get(id); if (item?.projectId) ids.add(item.projectId); if (item?.attachmentId) ids.add(item.attachmentId); for (const source of [...(item?.sourceAttachmentIds || []), ...(item?.sourceNoteIds || []), ...(item?.dependsOn || [])]) ids.add(source); }
    const complex = actions.some(a => ['upsert_wiki', 'upsert_paper'].includes(a.type));
    const completingTask = actions.some(a => a.type === 'update_task' && (a.status || a.patch?.status) === 'done');
    return stable({
      records: collections.flatMap(key => (state[key] || []).filter(item => ids.has(item.id) || key === 'tasks' && taskNames.includes(normalization(item.title)) || key === 'notes' && (noteNames.includes(normalization(item.title)) || completingTask) || complex && ['notes', 'papers', 'imports'].includes(key)).map(item => [key, item])).sort((a, b) => stable([a[0], a[1].id]).localeCompare(stable([b[0], b[1].id]))),
      projects: [...(state.projects || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      links: (state.links || []).filter(link => ids.has(link.sourceId) || ids.has(link.targetId)).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      conversation: (state.conversations || []).filter(c => c.id === context.conversationId).map(({ id, projectId, workspace, archived, archivedAt, deleted, deletedAt }) => ({ id, projectId, workspace, archived, archivedAt, deleted, deletedAt }))
    });
  }
  function createController(host = {}) {
    if (typeof host.applyPlan !== 'function' || typeof host.getState !== 'function' || typeof host.getRun !== 'function') throw Error('PlanReview requires getState, getRun and applyPlan.');
    const drafts = new Map(), tokens = new WeakMap();
    const locked = d => d.busy || !!host.isBusy?.(d.runId);
    function resolve(id) { const run = host.getRun(id); if (!run || run.status !== 'awaiting-approval' || run.archived || run.deletedAt) throw fault('PLAN_GONE', '本轮已不再等待批准。', 'This run is no longer awaiting approval.'); return run; }
    const compiled = d => compileRows(d.rows,d.reviewBase,d.context);
    const actionsOf = d => compiled(d).actions;
    const scopeActions = d => d.rows.map(row => copy(row.action));
    const metadataFor = (d, actions) => { const data = {version:1,pendingFingerprint:stamp(stable(actions)),contextFingerprint:stamp(d.contextKey),scopeFingerprint:stamp(d.baseline || ''),base:copy(d.reviewBase),rows:rowsRecord(d.rows)}; if(stable(data).length>4_000_000) throw fault('PLAN_REVIEW_SIZE','审阅记录超过 4 MB，请拆分计划后保存。','The review record exceeds 4 MB. Split this plan before saving.'); return {...data,checksum:stamp(stable(data))}; };
    function validate(draft) {
      const actions = actionsOf(draft), state = host.getState();
      const validationKey = stable(actions) + '\n' + scope(state, scopeActions(draft), draft.context);
      if (validationKey === draft.validationKey) return draft.validation.ok ? { results: draft.validation.results } : null;
      draft.validationKey = validationKey;
      try { if (!actions.length) { const fieldOnly = draft.rows.some(row => row.included && compiled(draft).reviews.get(row.key)?.fields.length); draft.validation = {ok:false,empty:true,canSaveEmpty:fieldOnly,results:[],error:t('没有保留任何实际修改。可以保存审阅选择或拒绝执行；不会运行空操作。','No actual changes remain. Save these review choices or reject the plan; no empty action will run.')}; return null; } const outcome = preview(host, state, actions, draft.context); draft.validation = { ok: true, results: copy(outcome.results || []) }; return outcome; }
      catch (error) { draft.validation = { ok: false, error: error.message }; return null; }
    }
    function make(id) {
      const run = resolve(id), context = contextFor(host, run), original = copy(run.pendingActions || []);
      const restored = restoreFieldReview(run.planFieldReview,original,context);
      const rows = restored?.rows || original.map((action,index)=>{const proposal=normalizedProposal(action);return{key:id+':'+index,action:proposal,included:true,decisions:{},originalFields:proposalFields(proposal)};});
      const draft = { runId: id, original, originalKey: stable(original), originalMetadataKey:stable(run.planFieldReview ?? null), context, contextKey: stable(context), rows, reviewBase:restored?.base || reviewBase(host.getState(),rows), originalRowsKey:stable(rowsRecord(rows)), revision: 0, savedRevision: 0, busy: false, error: '', notice: '', stale: false };
      const outcome = validate(draft);
      draft.baselineActions = scopeActions(draft); draft.baseline = scope(host.getState(), draft.baselineActions, context, outcome);
      if (restored && restored.scopeFingerprint !== stamp(draft.baseline)) { draft.baseline = null; draft.stale = true; draft.error=t('保存审阅后相关对象已改变，请重新核对。先前的字段选择仍保留。','Related objects changed after this review was saved. Review them again; your prior field choices are retained.'); }
      if (run.planFieldReview && !restored) draft.notice=t('先前的审阅记录与待执行计划不一致，已只载入实际待执行动作。','The prior review record does not match the pending plan. Only the actual pending actions were loaded.');
      drafts.set(id, draft); return draft;
    }
    function draft(id) { return drafts.get(id) || make(id); }
    function assertBase(d, actions = d.baselineActions) {
      const run = resolve(d.runId);
      if (stable(run.pendingActions || []) !== d.originalKey) throw fault('PLAN_CHANGED', '待执行计划已在别处改变。请重新载入计划；当前草稿可先复制保留。', 'The pending plan changed elsewhere. Reload it; you can first copy your draft.');
      if (stable(run.planFieldReview ?? null) !== d.originalMetadataKey) throw fault('PLAN_CHANGED','字段审阅决定已在别处改变。请重新载入核对。','Field review decisions changed elsewhere. Reload and review them.');
      if (stable(contextFor(host, run)) !== d.contextKey) throw fault('PLAN_SCOPE_CHANGED', '本轮允许范围已变化。请重新载入并核对计划。', 'The allowed scope changed. Reload and review the plan.');
      if (scope(host.getState(), actions, d.context) !== d.baseline) throw fault('PLAN_TARGET_CHANGED', '计划涉及的对象已变化。请核对最新对象后再保存或批准；草稿仍保留。', 'An object in this plan changed. Review the latest objects before saving or approving; your draft is retained.');
      return run;
    }
    function refresh(id) { const d = draft(id); try { assertBase(d); d.stale = false; } catch (e) { d.stale = true; d.error = e.message; } validate(d); return d; }
    function mutate(id, callback) {
      const d = draft(id); if (locked(d)) throw fault('PLAN_BUSY', '正在保存或批准计划，请稍候。', 'The plan is being saved or approved.');
      try { assertBase(d); } catch (error) { d.stale = true; d.error = error.message; host.onChanged?.(id, 'draft'); throw error; }
      callback(d); d.revision++; d.error = ''; d.notice = ''; const outcome = validate(d);
      // Include newly selected targets in what the user sees, without acknowledging
      // changes to the prior view. The old view was checked immediately above.
      d.baselineActions = scopeActions(d); d.baseline = scope(host.getState(), d.baselineActions, d.context, outcome);
      host.onChanged?.(id, 'draft'); return d;
    }
    function edit(id, key, path, value) { return mutate(id, d => { const row = d.rows.find(row => row.key === key); const spec = schemas[row?.action.type]?.find(field => field.key === path); if (!spec) throw fault('PLAN_FIELD', '此字段不能在计划中修改。', 'This field cannot be edited in the plan.');
      if (spec.type === 'tasks') { if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw Error('Invalid dependency selection'); }
      else if (value !== null && typeof value !== 'string' && !(spec.type === 'date' && typeof value === 'number')) throw Error('Invalid field value');
      if (typeof value === 'string' && value.length > (spec.type === 'textarea' ? 200000 : 4000)) throw fault('PLAN_FIELD_LONG', '内容过长，请缩短后保存。', 'This value is too long. Shorten it before saving.');
      if (spec.type === 'select' && value && !spec.options.includes(value)) throw Error('Invalid selection');
      if (path === 'projectId') { delete row.action.project; delete row.action.projectName; }
      if (path === 'name' && row.action.type === 'create_project') delete row.action.title;
      if (path === 'content') delete row.action.body;
      if (path === 'patch.status') delete row.action.status;
      if (['workflowCategory', 'patch.workflowCategory'].includes(path) && value === '') value = null;
      set(row.action, path, value);
    }); }
    function toggle(id, key, included) { return mutate(id, d => { const row = d.rows.find(row => row.key === key); if (!row) throw Error('Step unavailable'); row.included = !!included; }); }
    function decideField(id,key,path,accept) { return mutate(id,d=>{const row=d.rows.find(row=>row.key===key);const field=compiled(d).reviews.get(key)?.fields.find(field=>field.path===path);if(!row||!field)throw fault('PLAN_FIELD','此字段不能单独审阅。','This field cannot be reviewed separately.');row.decisions ||= {};row.decisions[path]=accept?'accept':'reject';}); }
    function move(id, key, offset) { return mutate(id, d => { if (![1, -1].includes(offset)) throw Error('Invalid move'); const index = d.rows.findIndex(row => row.key === key), target = index + offset; if (index < 0 || target < 0 || target >= d.rows.length) return; const [row] = d.rows.splice(index, 1); d.rows.splice(target, 0, row); }); }
    const dirty = d => stable(actionsOf(d)) !== d.originalKey || stable(rowsRecord(d.rows)) !== d.originalRowsKey;
    async function save(id) {
      const d = draft(id); if (locked(d)) throw fault('PLAN_BUSY', '正在保存或批准计划，请稍候。', 'The plan is being saved or approved.');
      let run; try { run = assertBase(d); } catch (error) { d.error = error.message; d.stale = true; throw error; }
      const outcome = validate(d); if (!outcome && !d.validation.canSaveEmpty) throw fault('PLAN_INVALID', d.validation.error, d.validation.error);
      if (typeof host.save !== 'function') throw fault('PLAN_SAVE', '计划保存接口尚未连接。', 'Plan saving is not connected.');
      const before = copy(run.pendingActions), beforeMetadata = copy(run.planFieldReview), next = actionsOf(d), metadata = metadataFor(d,next), priorKey = d.originalKey, priorMetadataKey=d.originalMetadataKey; let durable = false; d.busy = true; d.error = ''; run.pendingActions = copy(next); run.planFieldReview=copy(metadata); host.onChanged?.(id, 'saving');
      try {
        if (await host.save() === false) throw fault('PLAN_SAVE', '本机保存未完成，请重试。草稿仍保留。', 'Local saving did not complete. Retry; your draft is retained.');
        durable = true;
        const current = resolve(id);
        if (stable(current.pendingActions) !== stable(next) || stable(current.planFieldReview) !== stable(metadata)) throw fault('PLAN_CHANGED', '保存期间计划或字段审阅决定已改变，请重新载入核对。', 'The plan or field review decisions changed while saving. Reload and review them.');
        d.original = copy(next); d.originalKey = stable(next); d.originalMetadataKey=stable(metadata);d.originalRowsKey=stable(rowsRecord(d.rows)); d.savedRevision = d.revision; host.onChanged?.(id, 'saved');
        if (stable(contextFor(host, current)) !== d.contextKey || scope(host.getState(), d.baselineActions, d.context) !== d.baseline) throw fault('PLAN_TARGET_CHANGED', '计划已保存，但保存期间相关对象已变化，请重新核对。', 'The plan was saved, but a related object changed while saving. Review it again.');
        d.stale = false; d.error = ''; d.notice = t('计划已保存。批准将只执行当前保留的步骤。', 'Plan saved. Approval will execute only the retained steps.'); return copy(next);
      } catch (error) {
        const current = host.getRun(id); if (!durable && current) { if(stable(current.pendingActions) === stable(next)) current.pendingActions = before; if(stable(current.planFieldReview)===stable(metadata)){if(beforeMetadata===undefined)delete current.planFieldReview;else current.planFieldReview=beforeMetadata;} }
        if (!durable) {d.originalKey = priorKey;d.originalMetadataKey=priorMetadataKey;} d.error = error.message; throw error;
      } finally { d.busy = false; host.onChanged?.(id, 'settled'); }
    }
    function capture(id) {
      const d = draft(id); if (d.busy) throw fault('PLAN_BUSY', '请等待计划保存完成。', 'Wait until the plan is saved.');
      assertBase(d); if (dirty(d)) throw fault('PLAN_UNSAVED', '先保存计划修改，再批准当前范围。', 'Save the plan changes before approving this scope.');
      if (!validate(d)) throw fault('PLAN_INVALID', d.validation.error, d.validation.error);
      const token = frozen({ runId: id, revision: d.revision, fingerprint: d.originalKey, actions: copy(d.original), context: copy(d.context) });
      tokens.set(token, { draft: d, baseline: d.baseline, baselineActions: copy(d.baselineActions), contextKey: d.contextKey }); return token;
    }
    function assertCurrent(token) {
      const stored = tokens.get(token); if (!stored) throw fault('PLAN_TOKEN', '批准凭据已失效，请重新核对。', 'This approval token is unavailable. Review the plan again.');
      const d = draft(token.runId); if (stored.draft !== d || d.busy || dirty(d) || d.revision !== token.revision) throw fault('PLAN_CHANGED', '批准等待期间计划已修改，请重新批准。', 'The plan changed while approval was pending. Approve it again.');
      const run = assertBase(d); if (stable(run.pendingActions) !== token.fingerprint || stable(contextFor(host, run)) !== stored.contextKey) throw fault('PLAN_CHANGED', '批准的范围已变化，请重新核对。', 'The approved scope changed. Review it again.');
      if (scope(host.getState(), stored.baselineActions, token.context) !== stored.baseline) throw fault('PLAN_TARGET_CHANGED', '批准等待期间对象已改变，尚未执行。请重新核对。', 'An object changed while approval was pending. Nothing was executed. Review it again.');
      return copy(token.actions);
    }
    function recheck(id) {
      const d = draft(id), run = resolve(id);
      if (locked(d)) throw fault('PLAN_BUSY', '正在保存或批准。', 'Saving or approving.');
      if (stable(run.pendingActions || []) !== d.originalKey || stable(run.planFieldReview ?? null) !== d.originalMetadataKey || stable(contextFor(host, run)) !== d.contextKey) throw fault('PLAN_CHANGED', '原计划、字段决定或允许范围已变化，请重新载入。', 'The original plan, field decisions or allowed scope changed. Reload it.');
      let outcome; const previousBase=d.reviewBase; d.reviewBase=reviewBase(host.getState(),d.rows); d.validationKey=null;
      try { if (typeof host.recheckPlan === 'function') {
        let validated = false;
        const validateRechecked = () => { d.validationKey = null; outcome = validate(d); if (!outcome && d.validation.canSaveEmpty) outcome=preview(host,host.getState(),[],d.context); if (!outcome) throw fault('PLAN_INVALID', d.validation.error, d.validation.error); validated = true; return outcome; };
        try {
          // Suppressed fields may later be accepted again. Refresh only the
          // already-authorized task versions, without making them executable.
          const reviewTargets = scopeActions(d).filter(action => ['update_task','delete_task'].includes(action.type) && d.context.allowedTaskIds?.includes(action.taskId));
          const result = host.recheckPlan(run, actionsOf(d), validateRechecked, reviewTargets);
          if (result && typeof result.then === 'function' || !validated) throw fault('PLAN_RECHECK', '重新核对尚未完成，原批准版本保持不变。', 'Rechecking did not complete. The prior approval version is unchanged.');
        } catch (error) { d.validationKey = null; d.error = error.message; d.stale = true; throw error; }
      } else {outcome=validate(d);if(!outcome&&!d.validation.canSaveEmpty)throw fault('PLAN_INVALID',d.validation.error,d.validation.error);} }
      catch(error){d.reviewBase=previousBase;d.validationKey=null;d.error=error.message;d.stale=true;throw error;}
      d.revision++; d.baselineActions = scopeActions(d); d.baseline = scope(host.getState(), d.baselineActions, d.context, outcome); d.stale = false; d.error = ''; d.notice = t('已载入最新对象，请重新检查各步内容与结果。', 'Latest objects loaded. Review each step and its effects again.'); host.onChanged?.(id, 'rechecked'); return d;
    }
    function reload(id) { const previous = draft(id); if (locked(previous)) throw fault('PLAN_BUSY', '正在保存或批准。', 'Saving or approving.'); const saved = dirty(previous) ? actionsOf(previous) : previous.previousDraft; const next = make(id); next.previousDraft = saved; next.revision = previous.revision + 1; host.onChanged?.(id, 'reloaded'); return next; }
    function reportError(id, error) { const d = drafts.get(id); if (d) { d.error = error?.message || String(error); if (String(error?.code || '').startsWith('PLAN_') && !['PLAN_BUSY','PLAN_UNSAVED','PLAN_INVALID'].includes(error.code)) d.stale = true; host.onChanged?.(id, 'error'); } }
    function cleanup() { for (const [id,d] of drafts) if (!d.busy && host.getRun(id)?.status !== 'awaiting-approval') drafts.delete(id); }
    return { draft, refresh, edit, decideField, toggle, move, save, capture, assertCurrent, recheck, reload, reportError, cleanup, fieldReview: id => compiled(draft(id)), dirty: id => dirty(draft(id)), actions: id => actionsOf(draft(id)), anyBusy: () => [...drafts.values()].some(d => d.busy), isEditing: () => [...drafts.values()].some(d => host.getRun(d.runId)?.status === 'awaiting-approval' && dirty(d)), forget: id => { if (!drafts.get(id)?.busy) drafts.delete(id); } };
  }

  function describe(action, state, context, allActions) {
    const all = collections.flatMap(key => state[key] || []), find = id => all.find(item => item.id === id);
    let currentWorkspace = context.workspace || '日常'; const proposedProjects = [];
    for (const previous of allActions) { if (previous === action) break; if (previous.type === 'set_workspace') currentWorkspace = previous.workspace || currentWorkspace; if (previous.type === 'create_project') proposedProjects.push({ ...previous, workspace: previous.workspace || currentWorkspace }); }
    const assigning = action.type === 'assign_record';
    const target = assigning ? (state[action.recordType==='task'?'tasks':'notes']||[]).find(item=>item.id===action.recordId) : find(action.taskId || action.noteId || action.attachmentId || action.sourceAttachmentId || action.targetId);
    const projectRef = assigning ? action.targetProjectId : Object.hasOwn(action, 'projectId') ? action.projectId : action.project || action.projectName || target?.projectId || context.projectId;
    const p = action.type === 'create_project' ? { ...action, workspace: action.workspace || currentWorkspace } : state.projects?.find(p => p.id === projectRef || p.name === projectRef) || proposedProjects.find(a => [a.id, a.ref, a.name].includes(projectRef));
    const deletion = action.type.startsWith('delete_');
    const sourceIds = action.sourceAttachmentIds || [];
    const changes = [];
    if(assigning){
      const old=state.projects?.find(project=>project.id===target?.projectId),standalone=t('独立内容','Standalone');
      changes.push({label:t('归属项目','Project'),before:old?.name||target?.project||standalone,after:p?.name||(projectRef?String(projectRef):standalone)});
      changes.push({label:t('空间','Space'),before:old?.workspace||target?.workspace,after:p?.workspace||old?.workspace||target?.workspace});
    }
    const fieldName = key => { const spec = [...taskFields, ...noteFields, workspace, field('newName','资料名称','Material name'), field('tag','标签','Tag'), field('folderPath','资料夹','Folder'), field('relation','关系','Relation')].find(field => field.key === key); return spec ? t(spec.zh,spec.en) : key; };
    const compact = value => Array.isArray(value) ? value.join(', ') : value == null || value === '' ? t('未设置','Not set') : String(value);
    const short = value => { const text = compact(value); return text.length > 160 ? text.slice(0,157) + '…' : text; };
    if (action.type.startsWith('update_')) for (const [key,value] of Object.entries(action.patch || {})) changes.push({ label: fieldName(key), before: key === 'workflowCategory' ? workflowLabel(state, taskWorkflow().category(target)) : short(target?.[key]), after: key === 'workflowCategory' ? workflowLabel(state, value) : short(value) });
    else for (const key of ['newName','tag','relation','priority','workflowCategory','status','startAt','dueAt','folderPath']) if (Object.hasOwn(action,key)) changes.push({ label: fieldName(key), after: key === 'workflowCategory' ? workflowLabel(state, action[key]) : short(action[key]) });
    if (action.type === 'set_workspace') changes.push({ label: fieldName('workspace'), before: currentWorkspace, after: action.workspace });
    if (action.type === 'link_local_project') { const folder = (context.localCandidates || []).find(item => item.id === action.candidateId); changes.push({ label: t('本机目录','Local folder'), after: folder?.path || action.candidateId }); }
    if (Object.hasOwn(action,'status') && action.type === 'update_task') changes.push({label:fieldName('status'),before:short(target?.status),after:short(action.status)});
    const excerpt = action.type === 'append_note' ? action.content : action.description || action.content || action.body || '';
    const endpoint = id => find(id)?.title || find(id)?.name || allActions.find(a => a.id === id)?.title || allActions.find(a => a.id === id)?.name || id;
    return { label: names[action.type] ? t(...names[action.type]) : action.type, title: ['create_link','link_items'].includes(action.type) ? endpoint(action.sourceId) + ' → ' + endpoint(action.targetId) : action.name || action.title || action.patch?.title || target?.title || target?.name || action.newName || t('工作区操作', 'Workspace action'), project: p?.name || p?.title || (projectRef ? String(projectRef) : t('独立内容', 'Standalone')), workspace: action.workspace || p?.workspace || target?.workspace || currentWorkspace, targetId: target?.id || '', sources: sourceIds.map(id => find(id)?.name || find(id)?.title || id), danger: deletion,
      changes, excerpt: excerpt.length > 240 ? excerpt.slice(0,237) + '…' : excerpt,
      consequence: assigning ? t('仅修改此记录归属；原 ID、正文、来源、草稿与修订历史保持不变。解除项目归属时保留原空间。','Changes only ownership. Keeps the original ID, content, sources, draft and revisions; detaching keeps the original space.') : deletion ? t('移入回收站，并移除关联。可从回收站恢复。', 'Moves the object to trash and removes its links. Restore it from Trash.') : ['update_note','append_note','upsert_wiki','upsert_paper'].includes(action.type) ? t('保留人工正文；需要时生成待合并草稿。', 'Preserves human edits and creates a proposal when required.') : action.type === 'link_local_project' ? t('保存目录关联；此步骤不会执行终端命令。', 'Saves the folder link. This step does not run terminal commands.') : ['create_link','link_items'].includes(action.type) ? t('保存两个对象之间的关联。', 'Saves a link between the two objects.') : t('将按下方字段更新本机工作区，结果遵循现有同步设置。', 'Updates the local workspace using the fields below and follows existing sync settings.') };
  }
  function fieldsFor(action, state, context, allActions) {
    const current = [...(state.tasks || []), ...(state.notes || [])].find(item => item.id === (action.taskId || action.noteId));
    const earlier = allActions.slice(0, allActions.indexOf(action));
    const records = collections.slice(0, 4).flatMap(key => (state[key] || []).filter(item => !unavailable(item)).map(item => ({ value: item.id, label: item.name || item.title || item.id })));
    return (schemas[action.type] || []).map(spec => {
      let value = get(action, spec.key), inherited = value === undefined;
      if (value === undefined) value = spec.key.startsWith('patch.') ? current?.[spec.key.slice(6)] : spec.key === 'name' ? action.title : spec.key === 'content' ? action.body : undefined;
      let options = spec.options?.map(value => ({ value, label: value }));
      if (['workflowCategory', 'patch.workflowCategory'].includes(spec.key)) {
        if (inherited && spec.key.startsWith('patch.')) value = taskWorkflow().category(current);
        options = [{ value: '', label: t('未分类', 'Uncategorized') }, ...taskWorkflow().keys.map(value => ({ value, label: workflowLabel(state, value) }))];
      }
      if (spec.type === 'project' && action.type === 'assign_record') {
        options=[{value:'__standalone',label:t('独立内容 · 保留原空间','Standalone · keep original space')},...(Assignment?.accessibleProjects(state)||[]).map(p=>({value:p.id,label:p.name+' · '+p.workspace}))];
        if(value===null)value='__standalone';
      } else if (spec.type === 'project') {
        const updating = ['update_task','update_note'].includes(action.type), requested = action.project || action.projectName || (updating ? '' : context.projectId);
        if (value === undefined) value = requested || '';
        options = [{ value: '', label: updating ? t('保留现有归属', 'Keep current project') : t('沿用当前范围', 'Inherit current scope') }, ...(!updating ? [{ value: '__standalone', label: t('独立内容', 'Standalone') }] : []), ...(state.projects || []).filter(item => !unavailable(item)).map(p => ({ value: p.id, label: p.name + ' · ' + p.workspace })), ...earlier.filter(a => a.type === 'create_project').map(a => ({ value: a.id || a.ref || a.name || a.title, label: (a.name || a.title) + t(' · 前面步骤创建', ' · created earlier') }))];
        if (value === null) value = updating ? '' : '__standalone';
      }
      if (spec.type === 'tasks') { options = (state.tasks || []).filter(item => !unavailable(item) && item.id !== action.taskId).map(item => ({ value: item.id, label: item.title })); options.push(...earlier.filter(a => a.type === 'create_task' && a.id).map(a => ({ value: a.id, label: a.title + t(' · 前面步骤创建', ' · created earlier') }))); }
      if (spec.type === 'record') { options = records.concat(earlier.filter(a => a.id && ['create_project','create_task','create_note','create_knowledge_item'].includes(a.type)).map(a => ({ value: a.id, label: (a.name || a.title) + t(' · 前面步骤创建', ' · created earlier') }))); }
      if (spec.type === 'candidate') options = (context.localCandidates || []).map(item => ({ value: item.id, label: item.name + ' · ' + item.path }));
      if (options && value && !options.some(option => option.value === value) && spec.type !== 'tasks') options = [{ value, label: String(value) + t(' · 原计划', ' · original plan') }, ...options];
      return { ...spec, label: t(spec.zh, spec.en), value: value ?? (spec.type === 'tasks' ? [] : ''), inherited, options };
    });
  }
  let controller, hooks = {}; const mounts = new Map();
  function init(host) { hooks = host; controller = createController({ ...host, onChanged: (id, reason) => { host.onChanged?.(id, reason); refresh(id); } }); return controller; }
  function invoke(id, callback) { Promise.resolve().then(callback).catch(error => controller.reportError(id, error)); }
  function draw(element, id) {
    if (!element.isConnected) { mounts.delete(element); return; }
    let d; try { d = controller.refresh(id); } catch (_) { root.HalaskaUI?.unmount(element); mounts.delete(element); element.replaceChildren(); return; }
    const state = hooks.getState(), allActions = d.rows.map(row => row.action), retainedActions = d.rows.filter(row => row.included).map(row => row.action), review=controller.fieldReview(id);
    root.HalaskaUI.mount(element, 'PlanReviewSurface', { runId: id, draft: { ...d, busy: d.busy || !!hooks.isBusy?.(id), dirty: controller.dirty(id) }, rows: d.rows.map(row => { const actions = row.included ? retainedActions : allActions; return { ...row, ...describe(row.action, state, d.context, actions), fields: fieldsFor(row.action, state, d.context, actions), fieldReview:review.reviews.get(row.key) }; }),
      canSessionApprove: !!hooks.canSessionApprove?.(hooks.getRun(id)), canReview: !!hooks.review,
      onEdit: (key, field, value) => { try { controller.edit(id, key, field, value); } catch (error) { controller.reportError(id, error); } }, onToggle: (key, included) => { try { controller.toggle(id, key, included); } catch (error) { controller.reportError(id, error); } }, onMove: (key, offset) => { try { controller.move(id, key, offset); } catch (error) { controller.reportError(id, error); } },
      onDecideField:(key,path,accept)=>{try{controller.decideField(id,key,path,accept);}catch(error){controller.reportError(id,error);}},
      onSave: () => invoke(id, () => controller.save(id)), onApprove: () => invoke(id, () => hooks.approve?.(id, controller.capture(id))), onSessionApprove: () => invoke(id, () => hooks.sessionApprove?.(id, controller.capture(id))), onReject: () => invoke(id, () => hooks.reject?.(id)), onReview: () => invoke(id, () => hooks.review?.(id, controller.capture(id))),
      onRecheck: () => invoke(id, () => controller.recheck(id)), onReload: () => invoke(id, () => controller.reload(id)), onCopy: () => invoke(id, async () => { await root.navigator.clipboard.writeText(JSON.stringify(d.previousDraft || controller.actions(id), null, 2)); d.notice = t('计划草稿已复制。','Plan draft copied.'); refresh(id); }) });
  }
  function mount(element, id) { if (!controller || !root.HalaskaUI?.mount) return null; mounts.set(element, id); draw(element, id); return { update: () => draw(element, id), dispose: () => { root.HalaskaUI.unmount(element); mounts.delete(element); } }; }
  function refresh(id) { controller?.cleanup(); for (const [element, runId] of mounts) if (!id || id === runId) draw(element, runId); }
  function dispose(element) { if (element) { root.HalaskaUI?.unmount(element); mounts.delete(element); } else { for (const target of mounts.keys()) root.HalaskaUI?.unmount(target); mounts.clear(); } }
  return { createController, init, mount, refresh, dispose, getController: () => controller, capture: id => controller.capture(id), assertCurrent: token => controller.assertCurrent(token), reportError: (id, error) => controller.reportError(id, error), isEditing: () => controller?.isEditing() || false, isBusy: () => controller?.anyBusy() || false, describe, fieldsFor, schemas, stable, compileRows, restoreFieldReview };
});
