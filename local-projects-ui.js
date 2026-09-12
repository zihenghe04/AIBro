(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LocalProjects = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const text = value => String(value ?? '');
  const active = item => !!item && !item.archived && !item.deletedAt;
  const projectForFolder = (state, folder) => list(state.projects).find(project => project.localFolder && ((folder?.id && project.localFolder.id === folder.id) || (folder?.path && project.localFolder.path === folder.path))); 
  function connectionPlan(state, folder, options = {}, now = Date.now()) {
    if (!folder?.id || !folder.rootId || !folder.path) throw new Error('本机目录信息不完整，请重新搜索。');
    const target = options.projectId ? list(state.projects).find(project => project.id === options.projectId) : null;
    if (options.projectId && !active(target)) throw new Error('目标项目已删除或归档，无法连接。');
    if (target && Object.hasOwn(options, 'expectedFolderId') && (target.localFolder?.id || null) !== options.expectedFolderId) throw new Error('项目的本机目录连接已经变化，请重新打开后再连接。');
    const existing = projectForFolder(state, folder);
    if (existing) {
      if (!active(existing)) throw new Error(`此目录已连接到已归档的项目「${existing.name}」，请先恢复该项目。`);
      if (existing.localFolder.id === folder.id && existing.localFolder.rootId === folder.rootId && existing.localFolder.path === folder.path) return { project: existing, reused: true, created: false };
      const localFolder = { id: text(folder.id), rootId: text(folder.rootId), name: text(folder.name), path: text(folder.path), connectedAt: now };
      return { project: { ...existing, localFolder, updatedAt: now }, reused: false, created: false, previous: existing }; 
    }
    const name = text(options.name || folder.name).trim();
    if (!target && !name) throw new Error('请填写工作站项目名称。');
    if (name.length > 160) throw new Error('项目名称最多 160 个字符。');
    const workspace = ['日常', '课程', '科研'].includes(options.workspace) ? options.workspace : '日常';
    const localFolder = { id: text(folder.id), rootId: text(folder.rootId), name: text(folder.name), path: text(folder.path), connectedAt: now };
    const project = target ? { ...target, localFolder, updatedAt: now } : { id: options.id || `project_${now}_${Math.random().toString(36).slice(2, 9)}`, name, workspace, description: '连接本机目录，按需读取最新源码。', localFolder, createdAt: now, updatedAt: now };
    return { project, reused: false, created: !target, previous: target };
  }
  function createController(hooks, environment = root) {
    if (typeof hooks?.getState !== 'function' || typeof hooks?.save !== 'function') throw new Error('本机项目需要 getState 和 save 接口。');
    const doc = environment.document;
    const fetcher = hooks.fetch || environment.fetch?.bind(environment);
    let dialog, heading, subtitle, scopeDetails, scopes, suggestions, allowButton, manualPath, searchForm, queryInput, searchButton, candidatesBox, previewBox, treeBox, sourceTitle, sourceBody, snapshotInfo, nameInput, workspaceInput, attachButton, continueButton, refreshButton, backButton, status, cancelButton;
    let rootsData = { roots: [], suggestedRoots: [] }, selected = null, preview = null, targetId = null, expectedFolderId = null, returnFocus, pendingAccess = null, epoch = 0, committing = false;
    const unsavedIds = new Set();
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (value, className, action) => { const node = element('button', className, value); node.type = 'button'; node.addEventListener('click', action); return node; };
    const report = message => { if (status) status.textContent = message; };
    const isAbort = error => error?.name === 'AbortError';
    async function request(path, payload, options = {}) {
      if (!fetcher) throw new Error('请在桌面应用或本地服务中使用本机目录连接。');
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        const response = await fetcher(path, { method: options.method || (payload === undefined ? 'GET' : 'POST'), headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `本机目录请求失败（${response.status}）`);
        return data;
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    }
    async function ensureAccess(mode, options = {}) {
      if (mode && typeof mode === 'object') { options = mode; mode = undefined; }
      if (mode && mode !== 'common-projects') throw new Error('未知的目录授权方式。');
      const data = mode === 'common-projects' ? await request('/__local/roots', { preset: 'common-projects' }, options) : await request('/__local/roots', undefined, options);
      rootsData = { ...data, roots: list(data.roots), suggestedRoots: list(data.suggestedRoots) };
      return { ...rootsData, ready: rootsData.roots.length > 0 };
    }
    async function discover(query, options = {}) {
      const access = await ensureAccess(undefined, options);
      if (!access.ready) return { ...access, requiresAccess: true, candidates: [] };
      return { ...(await request('/__local/search', { query: text(query).trim(), limit: 30 }, options)), requiresAccess: false };
    }
    async function snapshot(project, options = {}) {
      if (!project?.localFolder?.id) throw new Error('这个项目尚未连接本机目录。');
      return request('/__local/snapshot', { candidateId: project.localFolder.id }, options);
    }
    function finishAccess(value) {
      const pending = pendingAccess; if (!pending) return;
      pendingAccess = null; pending.signal?.removeEventListener('abort', pending.abort);
      if (dialog?.open) dialog.close(); pending.resolve(value);
    }
    function close() { if (committing) { report('正在保存项目连接，请稍候。'); return; } epoch++; if (pendingAccess) finishAccess(false); else if (dialog?.open) dialog.close(); }
    async function requestAccess(options = {}) {
      if (options.signal?.aborted) return false;
      if (pendingAccess) return pendingAccess.promise;
      try { if ((await ensureAccess(undefined, options)).ready) return true; }
      catch (error) { if (!isAbort(error)) hooks.toast?.(error.message); return false; }
      if (options.signal?.aborted) return false;
      if (pendingAccess) return pendingAccess.promise;
      mount(); epoch++; targetId = null; selected = preview = null;
      if (!dialog.open) returnFocus = doc.activeElement;
      dialog.dataset.accessOnly = 'true'; heading.textContent = '允许查找本机项目？'; subtitle.textContent = '只在下面列出的目录内查找并只读源文件。对话分析时，会将需要的代码片段提供给当前选择的模型；本机原件不会被修改或移动。';
      previewBox.hidden = true; renderScopes(); scopeDetails.open = true; report('选择允许后，当前对话会继续查找项目。取消则不读取本机项目内容。');
      let resolve; const promise = new Promise(done => { resolve = done; });
      pendingAccess = { promise, resolve, signal: options.signal, abort: () => finishAccess(false) };
      options.signal?.addEventListener('abort', pendingAccess.abort, { once: true });
      if (!dialog.open) dialog.showModal(); allowButton.focus(); return promise;
    }
    function renderScopes() {
      scopes.replaceChildren(); suggestions.replaceChildren();
      list(rootsData.roots).forEach(scope => {
        const row = element('div', 'local-projects-scope'); const copy = element('div'); copy.append(element('strong', '', text(scope.name)), element('small', 'local-projects-path', text(scope.path)));
        const revoke = button('断开', 'local-projects-link', async () => {
          const current = ++epoch; revoke.disabled = true;
          try {
            await request(`/__local/roots/${encodeURIComponent(scope.id)}`, undefined, { method: 'DELETE' }); await ensureAccess();
            if (current !== epoch || !dialog.open) return;
            candidatesBox.replaceChildren();
            if (preview?.folder.rootId === scope.id) { preview = selected = null; previewBox.hidden = true; }
            renderScopes(); report('已断开此目录。工作站项目仍保留，下次读取需重新连接。');
          } catch (error) { if (current === epoch) report(error.message); } finally { revoke.disabled = false; }
        }); revoke.setAttribute('aria-label', `断开目录 ${text(scope.name)}`); row.append(copy, revoke); scopes.append(row);
      });
      if (!rootsData.roots.length) scopes.append(element('p', 'local-projects-muted', '尚未授权任何本机目录。'));
      const proposed = list(rootsData.suggestedRoots);
      proposed.forEach(scope => suggestions.append(element('li', 'local-projects-path', `${text(scope.name)} · ${text(scope.path)}`)));
      if (!proposed.length) suggestions.append(element('li', '', '没有检测到常用目录，可在下方选择其他范围。'));
      allowButton.disabled = !proposed.length; allowButton.textContent = rootsData.roots.length ? '连接其他常用目录' : '允许搜索常用目录';
      scopeDetails.querySelector('summary').textContent = `搜索范围 · ${rootsData.roots.length} 个已连接目录`;
    }
    async function authorize(payload) {
      const current = epoch; allowButton.disabled = true; report('正在连接所选目录…');
      try {
        const result = await request('/__local/roots', payload, { signal: pendingAccess?.signal });
        await ensureAccess();
        if (current !== epoch || !dialog.open) return;
        renderScopes();
        if (!rootsData.roots.length) throw new Error('没有可连接的常用目录，请在下方指定其他范围。');
        if (pendingAccess) { finishAccess(true); return; }
        scopeDetails.open = false;
        if (result.candidate && !queryInput.value.trim()) await selectCandidate(result.candidate); else await search();
      } catch (error) { if (current === epoch && !isAbort(error)) { report(error.message); renderScopes(); } }
    }
    async function search(event) {
      event?.preventDefault(); const current = ++epoch; preview = selected = null; previewBox.hidden = true; candidatesBox.hidden = false; candidatesBox.replaceChildren(); searchButton.disabled = true; report('正在已授权目录中查找…');
      try {
        const result = await discover(queryInput.value);
        if (current !== epoch || !dialog.open) return result;
        renderScopes();
        if (result.requiresAccess) { scopeDetails.open = true; report('先允许搜索常用目录，无需知道项目的准确路径。'); return result; }
        const candidates = list(result.candidates);
        if (!candidates.length) candidatesBox.append(element('p', 'local-projects-empty', '没有找到匹配项目。可以换一个名称或用途关键词，也可以增加搜索范围。'));
        candidates.forEach(candidate => {
          const row = button('', 'local-projects-candidate', () => selectCandidate(candidate)); row.dataset.candidateId = text(candidate.id);
          const linked = projectForFolder(hooks.getState(), candidate);
          row.append(element('strong', '', text(candidate.name)), element('small', 'local-projects-path', text(candidate.path)), element('span', '', linked ? `已连接「${linked.name}」${active(linked) ? '' : ' · 已归档'}` : text(candidate.reason) || '本机项目目录'));
          candidatesBox.append(row);
        });
        report(`找到 ${candidates.length} 个候选${result.truncated ? ' · 搜索已达到范围或数量上限' : ''}${list(result.warnings).length ? ` · ${result.warnings.length} 个目录暂不可访问` : ''}。选中后可先预览，再连接项目。`); return result;
      } catch (error) { if (current === epoch) report(error.message); }
      finally { if (current === epoch) searchButton.disabled = false; }
    }
    async function selectCandidate(candidate) {
      const current = ++epoch; selected = candidate; preview = null; previewBox.hidden = true; report(`正在只读查看 ${text(candidate.name)}…`);
      try {
        const result = await request('/__local/snapshot', { candidateId: candidate.id });
        if (current !== epoch || !dialog.open) return;
        preview = result; candidatesBox.hidden = true; previewBox.hidden = false; renderPreview();
        report('仅查看当前源文件；连接时只保存目录引用，不会拷贝代码。');
      } catch (error) { if (current === epoch) report(error.message); }
    }
    function renderPreview() {
      const state = hooks.getState(), folder = preview.folder, existing = projectForFolder(state, folder), target = list(state.projects).find(project => project.id === targetId);
      nameInput.value = existing?.name || target?.name || folder.name; nameInput.disabled = !!existing || !!target;
      workspaceInput.value = existing?.workspace || target?.workspace || '日常'; workspaceInput.disabled = !!existing || !!target;
      attachButton.textContent = existing ? '打开已连接项目' : target ? (target.localFolder ? '更换本机目录连接' : '连接到此项目') : '创建工作站项目';
      attachButton.disabled = !!existing && !active(existing); continueButton.disabled = attachButton.disabled;
      snapshotInfo.textContent = `${text(folder.path)}\n${text(preview.summary)}${preview.truncated ? '\n快照有截取；文件树和正文仅覆盖已读取部分。' : ''}\n读取于 ${new Date().toLocaleTimeString()} · 点击“重新读取”获取最新内容`;
      const fileMap = new Map(list(preview.files).map(file => [file.path, file]));
      const nodes = { children: new Map() };
      list(preview.tree).forEach(entry => {
        let node = nodes; const parts = text(entry.path).split('/').filter(Boolean);
        parts.forEach((part, index) => { if (!node.children.has(part)) node.children.set(part, { name: part, path: parts.slice(0,index+1).join('/'), children: new Map(), directory: index < parts.length-1 }); node = node.children.get(part); }); node.directory = entry.type === 'directory';
      });
      treeBox.replaceChildren();
      const appendNodes = (parent, node) => [...node.children.values()].sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)).forEach(child => {
        if (child.directory) { const details = element('details', 'local-projects-directory'); details.open = true; details.append(element('summary', '', child.name)); appendNodes(details, child); parent.append(details); }
        else { const row = button(child.name, 'local-projects-file', () => showFile(child.path, fileMap)); row.title = child.path; row.dataset.filePath = child.path; parent.append(row); }
      }); appendNodes(treeBox, nodes);
      if (!preview.tree?.length) treeBox.append(element('p', 'local-projects-muted', '该目录没有可列出的源文件。'));
      const first = list(preview.files)[0]; showFile(first?.path || '', fileMap);
    }
    function showFile(path, fileMap) {
      sourceTitle.textContent = path || '源文件预览'; const file = fileMap.get(path);
      sourceBody.textContent = file ? `${file.content}${file.truncated ? '\n\n——此文件已按快照大小限制截取——' : ''}` : path ? '此文件没有纳入本次只读正文快照。当前最多读取 12 个重点文件；文件仍保留在本机原目录。' : '选择文件查看只读正文。';
      sourceBody.scrollTop = 0;
      treeBox.querySelectorAll('[data-file-path]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.filePath === path)));
    }
    async function connectSelected(startConversation = false) {
      if (committing || !preview?.folder) return false;
      const requestedFolder = { ...preview.folder }, openedAt = epoch;
      committing = true; attachButton.disabled = continueButton.disabled = true;
      try {
        report('正在核对目录权限和最新源文件…');
        const access = await ensureAccess();
        if (!access.roots.some(scope => scope.id === requestedFolder.rootId)) throw new Error('目录访问权限已撤销，请重新授权后再连接。');
        const fresh = await snapshot({ localFolder: requestedFolder });
        if (['id', 'rootId', 'path'].some(key => fresh.folder?.[key] !== requestedFolder[key])) throw new Error('目录位置已经变化，请重新查找。');
        const latestAccess = await ensureAccess();
        if (!latestAccess.roots.some(scope => scope.id === requestedFolder.rootId)) throw new Error('读取期间目录访问权限已撤销，请重新授权后再连接。');
        if (openedAt !== epoch || !dialog.open) return false;
        const plan = connectionPlan(hooks.getState(), fresh.folder, { projectId: targetId, expectedFolderId, name: nameInput.value, workspace: workspaceInput.value });
        if (!plan.reused || unsavedIds.has(plan.project.id)) {
          const state = hooks.getState(); state.projects ||= [];
          const previousFolder = plan.previous?.localFolder, previousUpdatedAt = plan.previous?.updatedAt;
          if (!plan.reused) { if (plan.created) state.projects.push(plan.project); else Object.assign(plan.previous, { localFolder: plan.project.localFolder, updatedAt: plan.project.updatedAt }); }
          const installed = list(state.projects).find(project => project.id === plan.project.id), installedVersion = JSON.stringify(installed);
          try { if ((await hooks.save()) === false) throw new Error('保存没有成功，请重试。'); }
          catch (error) {
            const latest = list(hooks.getState().projects).find(project => project.id === plan.project.id);
            if (!plan.reused && plan.created && latest && JSON.stringify(latest) === installedVersion) hooks.getState().projects = hooks.getState().projects.filter(project => project !== latest);
            else if (!plan.reused && !plan.created && latest?.localFolder === plan.project.localFolder && latest.updatedAt === plan.project.updatedAt) {
              if (previousFolder === undefined) delete latest.localFolder; else latest.localFolder = previousFolder;
              if (previousUpdatedAt === undefined) delete latest.updatedAt; else latest.updatedAt = previousUpdatedAt;
            } else if (latest) unsavedIds.add(latest.id);
            throw new Error(`保存连接失败：${error.message}。尚未完成连接，可以重试。`);
          }
          unsavedIds.delete(plan.project.id);
        }
        const current = list(hooks.getState().projects).find(project => project.id === plan.project.id);
        if (!active(current)) throw new Error('项目已归档或删除，未打开其他项目。');
        if (openedAt !== epoch || !dialog.open) { hooks.renderAll?.(); return current; }
        dialog.close(); hooks.renderAll?.();
        if (startConversation && hooks.newConversation) hooks.newConversation(current.workspace, current.id); else hooks.openProject?.(current.id);
        hooks.toast?.(plan.reused ? `已打开「${current.name}」` : `已连接「${current.name}」，源文件保留在本机。`); return current;
      } catch (error) { if (openedAt === epoch) report(error.message); return false; }
      finally { committing = false; attachButton.disabled = continueButton.disabled = false; }
    }
    function mount() {
      if (dialog) return;
      dialog = element('dialog', 'local-projects-dialog'); dialog.id = 'localProjectsDialog'; dialog.dataset.accessOnly = 'false'; dialog.setAttribute('aria-labelledby', 'localProjectsTitle');
      const header = element('header', 'local-projects-header'), copy = element('div'); heading = element('h2', '', '连接本机项目'); heading.id = 'localProjectsTitle'; subtitle = element('p', '', '按名称或用途查找项目，无需先知道目录路径。'); copy.append(heading, subtitle); const dismiss = button('×', 'local-projects-close', close); dismiss.setAttribute('aria-label','关闭本机项目'); header.append(copy,dismiss);
      const body = element('div', 'local-projects-body'); scopeDetails = element('details', 'local-projects-access'); scopeDetails.append(element('summary', '', '搜索范围')); scopes = element('div'); suggestions = element('ul', 'local-projects-suggestions');
      allowButton = button('允许搜索常用目录', 'local-projects-button local-projects-primary', () => authorize({preset:'common-projects'})); allowButton.id = 'localProjectsAllow';
      const manual = element('details', 'local-projects-manual'); manual.append(element('summary','','连接其他范围')); const manualLabel = element('label'); manualLabel.append(element('span','','文件夹绝对路径')); manualPath = element('input'); manualPath.id='localProjectsPath'; manualPath.placeholder='例如 /Users/你的用户名/Projects'; manualPath.setAttribute('aria-label','其他本机文件夹路径'); manualLabel.append(manualPath); manual.append(manualLabel,button('连接此目录','local-projects-button',()=>authorize({path:manualPath.value.trim()})));
      scopeDetails.append(scopes,element('p','local-projects-muted','一键连接以下常用目录，可随时断开。对话分析会按需将代码片段提供给当前模型；预览和连接不会修改本机源文件。'),suggestions,allowButton,manual);
      searchForm=element('form','local-projects-search'); queryInput=element('input');queryInput.id='localProjectsQuery';queryInput.placeholder='例如：个人主页、论文代码、课程作业';queryInput.setAttribute('aria-label','按名称或用途查找本机项目');queryInput.maxLength=500;searchButton=element('button','local-projects-button local-projects-primary','查找项目');searchButton.type='submit';searchForm.append(queryInput,searchButton);searchForm.addEventListener('submit',search);
      candidatesBox=element('div','local-projects-candidates');previewBox=element('section','local-projects-preview');previewBox.hidden=true;
      const previewHeader=element('div','local-projects-preview-header');backButton=button('← 返回候选','local-projects-link',()=>{previewBox.hidden=true;candidatesBox.hidden=false;queryInput.focus();});refreshButton=button('重新读取','local-projects-button',()=>selected&&selectCandidate(selected));previewHeader.append(backButton,refreshButton);snapshotInfo=element('p','local-projects-snapshot-info');
      const fields=element('div','local-projects-fields');const nameLabel=element('label'),spaceLabel=element('label');nameInput=element('input');nameInput.id='localProjectsName';nameInput.maxLength=160;nameLabel.append(element('span','','工作站项目名称'),nameInput);workspaceInput=element('select');workspaceInput.id='localProjectsWorkspace';['日常','课程','科研'].forEach(value=>{const option=element('option','',`${value}空间`);option.value=value;workspaceInput.append(option);});spaceLabel.append(element('span','','所属空间'),workspaceInput);fields.append(nameLabel,spaceLabel);
      const reader=element('div','local-projects-reader');treeBox=element('nav','local-projects-tree');treeBox.setAttribute('aria-label','本机只读文件树');const source=element('div','local-projects-source');sourceTitle=element('h3');sourceBody=element('pre');sourceBody.tabIndex=0;source.append(sourceTitle,sourceBody);reader.append(treeBox,source);
      const actions=element('div','local-projects-connect-actions');attachButton=button('创建工作站项目','local-projects-button',()=>connectSelected(false));continueButton=button('连接并开始对话','local-projects-button local-projects-primary',()=>connectSelected(true));actions.append(attachButton,continueButton);previewBox.append(previewHeader,snapshotInfo,fields,reader,actions);body.append(scopeDetails,searchForm,candidatesBox,previewBox);
      status=element('p','local-projects-status');status.id='localProjectsStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');const footer=element('footer','local-projects-footer');cancelButton=button('取消','local-projects-button',close);footer.append(element('span','','只保存目录连接 · 不复制本机源码'),cancelButton);dialog.append(header,body,status,footer);doc.body.append(dialog);
      dialog.addEventListener('cancel',event=>{if(committing){event.preventDefault();report('正在保存项目连接，请稍候。');}else if(pendingAccess){event.preventDefault();finishAccess(false);}});
      dialog.addEventListener('close',()=>{epoch++;if(pendingAccess)finishAccess(false);returnFocus?.focus?.({preventScroll:true});});
    }
    async function open(projectId) {
      mount(); if(committing)return;
      const project=projectId?list(hooks.getState().projects).find(item=>item.id===projectId):null;
      if(projectId&&!active(project)){hooks.toast?.('项目已删除或归档。');return;}
      if(pendingAccess)finishAccess(false);
      targetId=projectId||null;expectedFolderId=project?.localFolder?.id||null;selected=preview=null;previewBox.hidden=true;candidatesBox.hidden=false;candidatesBox.replaceChildren();queryInput.value='';
      if(!dialog.open)returnFocus=doc.activeElement;dialog.dataset.accessOnly='false';heading.textContent=project?`本机项目 · ${project.name}`:'连接本机项目';heading.title=heading.textContent;subtitle.textContent=project?'连接后保留现有项目空间；源文件按需只读。':'按名称或用途查找项目，无需先知道目录路径。';if(!dialog.open)dialog.showModal();const current=++epoch;report('正在读取已连接范围…');
      try{await ensureAccess();if(current!==epoch||!dialog.open)return;renderScopes();scopeDetails.open=!rootsData.roots.length;if(project?.localFolder){await selectCandidate(project.localFolder);}else if(rootsData.roots.length){await search();}else report('先一键连接常用目录，再输入“个人主页”等关键词查找。');queryInput.focus();}catch(error){if(current===epoch)report(error.message);}
    }
    return {open,close,discover,snapshot,ensureAccess,requestAccess,connectSelected};
  }
  let controller;
  const api={connectionPlan,projectForFolder,createController,init(hooks){controller ||= createController(hooks);return api;}};
  ['open','discover','snapshot','ensureAccess','requestAccess'].forEach(name=>{api[name]=(...args)=>{if(!controller)throw new Error('请先初始化本机项目。');return controller[name](...args);};});
  return api;
}));
