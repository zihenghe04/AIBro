(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CloudSyncUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const text = value => String(value ?? '');
  const errorText = error => typeof error === 'string' ? error : error?.message || '';
  const count = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function serverURL(value) {
    try {
      const url = new URL(text(value).trim());
      if (url.username || url.password || url.search || url.hash) throw new Error();
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
      return url.href.replace(/\/$/, '');
    } catch (_) { throw new Error('请填写 HTTPS 云服务器地址；本机测试可使用 localhost。'); }
  }
  function describe(status = {}) {
    const connected = status.connected === true, pending = count(status.pending), conflicts = Array.isArray(status.conflicts) ? status.conflicts.length : count(status.conflicts);
    const labels = { sign_in_required: '待恢复登录', local: '纯本地', disconnected: '纯本地', syncing: '同步中', synced: '已同步', idle: '已连接', offline: '离线待重试', paused: '已暂停', conflict: '有冲突待处理', auth_required: '需要重新登录', error: '同步未完成', pending: '有更改待上传' };
    const inferred = status.syncing ? 'syncing' : /401|AUTH_REQUIRED|UNAUTHORIZED/.test(status.errorCode || '') ? 'auth_required' : !connected ? 'local' : conflicts > 0 ? 'conflict' : status.error ? 'offline' : status.autoSync === false ? 'paused' : pending > 0 ? 'pending' : status.lastSyncAt ? 'synced' : 'idle';
    const bound = !!text(status.target?.serverUrl).trim(), needsSignIn = bound && !connected;
    let state = needsSignIn ? 'sign_in_required' : status.syncing ? 'syncing' : /401|AUTH_REQUIRED|UNAUTHORIZED/.test(status.errorCode || '') ? 'auth_required' : conflicts > 0 && connected ? 'conflict' : status.state || inferred, label = labels[state] || (connected ? '已连接' : '纯本地');
    if (state === 'synced' && pending > 0) { label = '有更改待上传'; state = 'pending'; }
    const timestamp = status.lastSyncAt == null ? NaN : typeof status.lastSyncAt === 'number' ? status.lastSyncAt : Date.parse(status.lastSyncAt);
    return { state, label, connected, bound, needsSignIn, pending, conflicts, lastSync: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '尚未成功同步', error: errorText(status.error) };
  }
  function conflictText(value) {
    if (value == null || value?.deleted === true || value?.tombstone === true) return '此版本已删除。';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return '无法显示此版本，请重试。'; }
  }
  function conflictPreview(value) {
    if (value == null || value?.deleted === true || value?.tombstone === true || typeof value !== 'object') return conflictText(value);
    const sections = [], metadata = [], add = (label, content) => { if (typeof content === 'string' && content.trim()) metadata.push(`${label}：${content}`); };
    add('标题', value.title || value.name); add('空间', value.workspace);
    if (typeof value.archived === 'boolean') add('归档状态', value.archived ? '已归档' : '未归档');
    if (value.status) add('状态', ({todo:'待开始',in_progress:'进行中',doing:'进行中',done:'已完成',completed:'已完成',cancelled:'已取消',archived:'已归档'})[value.status] || text(value.status));
    const updated = value.updatedAt == null ? NaN : new Date(value.updatedAt).getTime();
    if (Number.isFinite(updated)) add('修改时间',new Date(updated).toLocaleString('zh-CN'));
    if (value.dueAt) add('截止时间',text(value.dueAt));
    const bodies = new Set();
    for (const [field,label] of [['content','正文'],['description','说明'],['summary','摘要'],['tldr','核心结论']]) if (typeof value[field] === 'string' && value[field].trim() && !bodies.has(value[field])) { bodies.add(value[field]); sections.push(`${label}\n${value[field]}`); }
    if (list(value.tags).length) add('标签',list(value.tags).map(text).join('、'));
    if (list(value.checklist).length) sections.push('检查清单\n'+list(value.checklist).map(item=>`${item.done?'✓':'○'} ${typeof item==='string'?item:text(item.text)}`).join('\n'));
    if (list(value.sourceAttachmentIds).length) add('关联资料',`${list(value.sourceAttachmentIds).length} 份`);
    if (list(value.messages).length) sections.push('对话\n'+list(value.messages).map(item=>`${item.role==='user'?'我':'AI'}：${typeof item.content==='string'?item.content:text(item.text)}`).join('\n\n'));
    return [...(metadata.length ? [metadata.join('\n')] : []), ...sections].join('\n\n') || '该记录包含结构化信息。展开下方全部字段查看差异。';
  }
  function createController(hooks = {}, environment = root) {
    const doc = environment.document, fetcher = hooks.fetch || environment.fetch?.bind(environment);
    let card, badge, description, message, form, server, username, password, deviceName, merge, connectButton, accountBox, accountText, syncButton, autoToggle, disconnectButton, devicesButton, conflictsButton, pendingText, lastSyncText, deferredButton, dialog, dialogBody, dialogTitle;
    let editingConnection = false, connectionOpen = false, sshTimer = null, editButton, sshButton, overview, overviewIsland, formIntro, serverHint, mergeText, connectionSSH;
    let sshConfig = null, sshHosts = [], sshMetadataError = '', sshStateRequested = false, sshMetadataLoading = false, sshConfigRevision = 0;
    let sshIsland = null, sshConnectionPaint = null, dialogEpoch = 0, sshRequestBusy = false, sshMaintenancePending = false, sshExpectedMove = null, sshJob = null;
    let accountIsland = null, accountNodes = null, accountParking = null, conflictIsland = null;
    let prefilled = false, connectionDirty = false;
    let status = {}, busy = false, generation = 0, loading = null, timer = null, destroyed = false, deferredRevision = null, lastAppliedRevision = 0, dialogKind = '', lastFocus, observer = null, feedbackKind = '';
    const node = (tag, className, value) => { const result = doc.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; };
    const button = (label, className, handler) => { const result = node('button', className, label); result.type = 'button'; result.addEventListener('click', handler); return result; };
    const hostBusy = () => !!hooks.isBusy?.();
    const report = (value, kind = 'error') => { if (message) message.textContent = value; feedbackKind = value ? kind : ''; };
    function paint() {
      if (!card) return;
      const view = describe(status), blocked = busy || sshRequestBusy || sshMaintenancePending || hostBusy();
      badge.textContent = busy ? '正在处理…' : view.label; badge.dataset.state = busy ? 'syncing' : view.state;
      description.textContent = view.connected ? '知识、笔记和任务同步到你连接的服务器；断开后本地资料仍保留。' : '当前资料保存在本机。连接自己的云服务器后，可以在多台设备间同步。';
      form.hidden = !connectionOpen && !editingConnection; accountBox.hidden = !view.connected;
      server.readOnly = !!status.target?.serverUrl;
      if (editButton) { editButton.disabled = blocked; editButton.textContent = editingConnection ? '取消修改' : '修改连接配置'; }
      if (sshButton) sshButton.disabled = busy || sshRequestBusy;
      accountText.textContent = [status.account?.username, status.serverUrl, status.device?.name].filter(Boolean).join(' · ') || '云账号已连接';
      pendingText.textContent = view.pending == null ? '待上传数量尚未确认' : `待上传 ${view.pending} 项`;
      lastSyncText.textContent = `最后同步：${view.lastSync}`;
      connectButton.disabled = blocked || !merge.checked;
      for (const field of [server,username,password,deviceName,merge]) field.disabled = busy;
      syncButton.disabled = blocked || !view.connected || view.state === 'auth_required';
      autoToggle.disabled = blocked || !view.connected; autoToggle.checked = status.autoSync === true;
      disconnectButton.disabled = busy; devicesButton.disabled = busy; conflictsButton.disabled = busy || !view.conflicts;
      conflictsButton.textContent = `处理冲突${view.conflicts == null ? '' : ` · ${view.conflicts}`}`;
      deferredButton.hidden = !deferredRevision; deferredButton.disabled = blocked;
      if (overview) {
        const props = {view, status, ssh: {config: sshConfig, hosts: sshHosts, job: sshJob, pending: sshMaintenancePending, loading: sshMetadataLoading, error: sshMetadataError, matching: matchingSSH()}, busy, blocked, deferred: !!deferredRevision, editing: editingConnection, connecting: connectionOpen, onConnect: openConnection, onSync: sync, onAuto: value => mutate('/__cloud/settings', {autoSync: value}), onDevices: devices, onConflicts: conflicts, onEdit: editConnection, onSSH: openSSHConnection, onSSHStorage: sshSettings, onDisconnect: () => mutate('/__cloud/disconnect', {}), onApply: applyDeferred};
        if (overviewIsland) overviewIsland.update(props); else overviewIsland = environment.HalaskaUI.mount(overview, 'CloudSyncOverview', props);
      }
      if (formIntro) formIntro.textContent = view.needsSignIn
        ? '保留了原服务器与账号的绑定，但当前没有可用的登录会话。请输入原云账号的用户名、密码和本机设备名称来恢复同步。'
        : view.bound ? '当前工作区沿用原服务器与账号。重新验证用户名和密码后可更新此连接的设备名称。' : '首次连接：填写同步服务器提供的账号。另一台设备使用相同服务器和账号即可连接。';
      connectButton.textContent = view.needsSignIn ? '登录并恢复同步' : view.bound ? '验证并更新连接' : '连接并合并';
      if (mergeText) mergeText.textContent = view.bound ? '我确认使用原云账号继续同步本机与云端内容；发生冲突时由我选择保留的版本。' : '我确认将当前本地知识与云端合并。资料会上传到上述服务器；发生冲突时由我选择保留的版本。';
      if (serverHint) {
        let loopback = false, matchingSSH = false;
        try { const url = new URL(status.target?.serverUrl || ''); loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname); matchingSSH = loopback && sshConfig && Number(url.port) === Number(sshConfig.localPort); } catch (_) {}
        serverHint.textContent = !view.bound ? '填写同步服务地址。云账号由该服务器提供，与 AI 模型账号分开。' : matchingSSH
          ? `这是本机 SSH 转发入口，已配置转发至 ${sshConfig.target} 的 ${sshConfig.remotePort} 端口。修改远程主机请打开“SSH 连接配置”。`
          : loopback ? '这是已保存的本机连接入口，可能经 SSH 转发到远程服务器。它不是远程主机地址；请在 SSH 与存储目录中查看主机配置。' : '服务器地址随原账号绑定保留，不能在这里换成其他同步服务。更换服务需要独立工作区，避免混合不同账号的数据。';
        serverHint.hidden = false; connectionSSH.hidden = !matchingSSH; connectionSSH.disabled = busy || sshRequestBusy || sshMaintenancePending;
      }
      paintAccount(view);
      sshConnectionPaint?.();
      card.setAttribute('aria-busy', String(busy));
      if (view.error && !busy && !['error', 'deferred'].includes(feedbackKind)) report(view.error, 'status');
    }
    async function request(route, payload) {
      if (!fetcher) throw new Error('请在桌面应用或本地服务中使用云同步。');
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), route.startsWith('/__cloud/ssh/') ? 120000 : 45000);
      try {
        const response = await fetcher(route, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: controller.signal });
        const data = await response.json();
        if (!response.ok || data.ok === false) { const error = new Error(errorText(data.error) || `云同步请求失败（${response.status}）`); error.responseStatus = response.status; error.code = data.code; throw error; }
        return data;
      } catch (error) { if (error?.name === 'AbortError') throw new Error('云同步请求超时，请检查网络后重试。'); throw error; }
      finally { clearTimeout(timeout); }
    }
    function receive(value) {
      const candidate = value?.status && typeof value.status === 'object' ? value.status : value;
      if (candidate && typeof candidate === 'object') { status = { ...status, ...candidate }; if (!Object.hasOwn(candidate,'state')) delete status.state;
        if (!prefilled && server && !connectionDirty) { server.value = status.serverUrl || status.target?.serverUrl || ''; username.value = status.account?.username || ''; deviceName.value = status.device?.name || (/Mac/i.test(environment.navigator?.platform || '') ? '我的 Mac' : '我的电脑'); prefilled = true; }
      }
    }
    function matchingSSH() {
      try { const url = new URL(status.target?.serverUrl || status.serverUrl || ''); return !!sshConfig && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && Number(url.port) === Number(sshConfig.localPort); } catch (_) { return false; }
    }
    const pendingSSHJob = job => !!job && !['completed','error'].includes(job.state);
    const matchesExpectedMove = job => !sshExpectedMove || (job?.source === sshExpectedMove.source && job?.destination === sshExpectedMove.destination && (!sshExpectedMove.previousId || (job?.id && job.id !== sshExpectedMove.previousId)));
    function adoptSSHJob(value) {
      // Missing or unrelated metadata is not a receipt for an accepted request.
      if (!matchesExpectedMove(value.job)) return false;
      if (value.job) {
        sshJob = value.job; sshMaintenancePending = pendingSSHJob(sshJob);
        if (!sshMaintenancePending) sshExpectedMove = null;
      } else if (!sshMaintenancePending) sshJob = null;
      return true;
    }
    async function loadConnectionDetails(force = false) {
      if (sshMetadataLoading || (sshStateRequested && !force)) return;
      sshStateRequested = true; sshMetadataLoading = true; sshMetadataError = ''; paint();
      try { const revision = sshConfigRevision, result = await request('/__cloud/ssh'); if (!destroyed && revision === sshConfigRevision) { sshConfig = result.config || null; sshHosts = list(result.hosts).filter(host => typeof host.target === 'string' && host.target.trim()); adoptSSHJob(result); } }
      catch (error) { if (!destroyed) sshMetadataError = error.message; }
      finally { sshMetadataLoading = false; if (!destroyed) paint(); }
    }
    function acknowledgeRevision(revision) {
      lastAppliedRevision = Math.max(lastAppliedRevision, revision);
      if (deferredRevision !== null && deferredRevision <= lastAppliedRevision) deferredRevision = null;
      if (!deferredRevision && feedbackKind === 'deferred') report('');
    }
    function readAppliedRevision() {
      // This is the host's confirmed workspace baseline, not the persistent
      // cloud marker itself. A missing/unsafe receipt must not consume updates.
      try {
        const revision = hooks.getAppliedRevision?.();
        if (Number.isSafeInteger(revision) && revision >= 0) acknowledgeRevision(revision);
      } catch (_) {}
    }
    function reconcileAppliedRevision() {
      if (destroyed) return;
      readAppliedRevision(); paint();
    }
    async function applyRevision(revision) {
      readAppliedRevision();
      revision = Number(revision);
      if (!Number.isSafeInteger(revision) || revision <= lastAppliedRevision) { paint(); return true; }
      deferredRevision = Math.max(deferredRevision || 0, revision);
      if (hostBusy()) { report('云端更新已收到。当前编辑或对话结束后，可点击“应用已收到的更新”。', 'deferred'); paint(); return false; }
      let applied = false;
      try { if (typeof hooks.applyRemote === 'function') applied = (await hooks.applyRemote(revision)) !== false; }
      catch (error) {
        readAppliedRevision();
        if (revision <= lastAppliedRevision) { paint(); return true; }
        throw error;
      }
      if (destroyed) return false;
      // Hydration or a durable merge may have adopted a newer snapshot while
      // this request waited. Its older failure must not restore a stale banner.
      readAppliedRevision();
      if (revision <= lastAppliedRevision) { paint(); return true; }
      if (!applied) { report('云端更新暂未应用。本机草稿已保留，请先处理正在进行的编辑。', 'deferred'); paint(); return false; }
      acknowledgeRevision(revision); paint(); return true;
    }
    async function remoteFrom() {
      readAppliedRevision();
      if (Number(status.remoteAppliedRevision) > lastAppliedRevision) return applyRevision(status.remoteAppliedRevision);
      return true;
    }
    function schedule() {
      clearTimeout(timer); if (destroyed || environment.disablePolling) return;
      const activePage = doc.visibilityState !== 'hidden' && (doc.body?.dataset?.view === 'settings' || doc.querySelector?.('#settings.active-view'));
      timer = setTimeout(() => refresh().catch(() => {}), activePage ? 6000 : 60000); timer.unref?.();
    }
    async function refresh() {
      if (destroyed) return status; if (loading) return loading; const version = generation;
      loading = (async () => {
        try { const result = await request('/__cloud/status'); if (version !== generation || destroyed) return status; receive(result); void loadConnectionDetails(); if (feedbackKind === 'status' && !errorText(status.error)) report(''); await remoteFrom(result); paint(); return status; }
        catch (error) { if (version === generation) { status = { ...status, state: status.connected ? 'offline' : 'local' }; report(error.message, 'status'); paint(); } return status; }
        finally { if (version === generation) loading = null; schedule(); }
      })(); return loading;
    }
    async function mutate(route, payload, needsFlush = false, options = {}) {
      if (busy || sshRequestBusy || sshMaintenancePending || destroyed) return false;
      if (needsFlush && hostBusy()) { report('当前有编辑或对话正在进行，请结束后再同步。'); paint(); return false; }
      generation++; const operation = generation; loading = null; busy = true; clearTimeout(timer); paint(); report('正在处理云同步…', 'progress');
      try {
        if (needsFlush && (await hooks.flush?.()) === false) throw new Error('本机更改尚未保存，云同步已暂停，请先保存本机草稿。');
        if (destroyed || operation !== generation || options.isCurrent && !options.isCurrent()) return false;
        if (needsFlush && hostBusy()) throw new Error('当前有新的编辑或对话，请稍后再同步。');
        const result = await request(route, payload); if (destroyed) return false; receive(result); await remoteFrom(result);
        if (!deferredRevision) report(route === '/__cloud/disconnect' ? '已断开云连接，本机资料已保留。' : route === '/__cloud/settings' ? (payload.autoSync ? '已开启自动同步。' : '已暂停自动同步，可随时手动同步。') : route === '/__cloud/connect' && payload.autoSync === false ? '连接已恢复，自动同步保持暂停。准备好后可手动同步。' : route === '/__cloud/sync' || route === '/__cloud/connect' ? '已提交同步请求，进度以上方实际状态为准。' : '操作完成，正在更新同步状态。', 'success');
        await refresh(); return true;
      } catch (error) { options.onError?.(error); report(error.message); hooks.toast?.(error.message); return false; }
      finally { busy = false; if (!destroyed) { paint(); schedule(); } }
    }
    async function connect(event) {
      event?.preventDefault(); if (busy || sshRequestBusy || sshMaintenancePending || destroyed) return false;
      if (!merge.checked) { report('请先确认将当前本地知识与云端合并。'); return false; }
      let payload;
      try {
        payload = { serverUrl: serverURL(server.value), username: username.value.trim(), password: password.value, deviceName: deviceName.value.trim(), mergeConfirmed: true };
        if (status.target?.accountId) payload.autoSync = status.autoSync === true;
        if (!payload.username) { username.focus(); throw new Error(describe(status).bound ? '请输入原云账号的用户名；它不同于 SSH 登录用户名。' : '请输入同步服务器提供的用户名。'); }
        if (!payload.password) { password.focus(); throw new Error('请输入云账号密码。'); }
        if (!payload.deviceName) { deviceName.focus(); throw new Error('请填写本机设备名称。'); }
      } catch (error) { report(error.message); return false; }
      password.value = '';
      const ok = await mutate('/__cloud/connect', payload, true);
      if (ok) { merge.checked = false; editingConnection = false; connectionOpen = false; } paint();
      if (ok && overview) { const next = doc.getElementById('cloudSyncNow'); (next && !next.disabled ? next : doc.getElementById('cloudDevices'))?.focus?.(); }
      return ok;
    }
    async function sync() { return mutate('/__cloud/sync', {}, true); }
    function openConnection() {
      if (busy || hostBusy()) return;
      connectionOpen = !connectionOpen; editingConnection = false;
      password.value = ''; merge.checked = false;
      paint(); if (connectionOpen) (server.value ? username.value ? password : username : server).focus(); else doc.getElementById('cloudStartConnect')?.focus?.();
    }
    async function applyDeferred() {
      readAppliedRevision(); paint();
      if (!deferredRevision || busy || hostBusy()) return;
      if ((await hooks.flush?.()) === false) { report('请先保存本机更改。'); return; }
      try { await applyRevision(deferredRevision); } catch(error) { report(error.message); }
    }
    function mountDialog(title, kind, opener) {
      if (!dialog) {
        dialog = node('dialog', 'cloud-sync-dialog'); dialog.id = 'cloudSyncDialog'; dialog.setAttribute('aria-labelledby', 'cloudSyncDialogTitle');
        const header = node('header', 'cloud-sync-dialog-header'); dialogTitle = node('h2'); dialogTitle.id = 'cloudSyncDialogTitle'; const close = button('×', 'cloud-sync-close', () => dialog.close()); close.setAttribute('aria-label', '关闭云同步详情'); header.append(dialogTitle, close); dialogBody = node('div', 'cloud-sync-dialog-body'); dialog.append(header, dialogBody); doc.body.append(dialog);
        dialog.addEventListener('close', () => {
          if (dialog.open) return;
          dialogEpoch++; conflictIsland?.unmount(); conflictIsland = null; dialogKind = ''; sshConnectionPaint = null; sshIsland?.unmount(); sshIsland = null; clearTimeout(sshTimer);
          const restore = lastFocus && lastFocus.isConnected !== false && !lastFocus.disabled ? lastFocus : doc.getElementById('cloudRefresh'), closedAt = dialogEpoch;
          const restoreWhenReady = () => {
            if (destroyed || dialog.open || dialogEpoch !== closedAt) return;
            const active = doc.activeElement;
            if (!active || active === doc.body || active === dialog || active === restore || dialog.contains?.(active)) restore?.focus?.({preventScroll:true});
          };
          restore?.focus?.({preventScroll:true});
          // WebKit keeps a closing native-material dialog in the top layer
          // through its discrete overlay transition; focus can be rejected until it ends.
          const settleFocus = () => {
            const animations = dialog.getAnimations?.() || [];
            if (animations.length) Promise.allSettled(animations.map(animation => animation.finished)).then(restoreWhenReady);
            else restoreWhenReady();
          };
          if (environment.requestAnimationFrame) environment.requestAnimationFrame(settleFocus); else settleFocus();
        });
      }
      dialogEpoch++; conflictIsland?.unmount(); conflictIsland = null; sshConnectionPaint = null; sshIsland?.unmount(); sshIsland = null; dialogKind = kind; dialogTitle.textContent = title; dialogBody.replaceChildren(node('p', 'cloud-sync-muted', '正在读取…'));
      if (!dialog.open) {
        const available = target => target && /^(button|input|select|textarea|a)$/i.test(target.tagName) && target.isConnected !== false && !target.disabled && !target.hidden && !target.closest?.('[hidden],[inert]') && (!card.contains || card.contains(target)) && (!target.getClientRects || target.getClientRects().length);
        const fallback = doc.getElementById(kind === 'ssh-connect' ? 'cloudSSHConnect' : kind === 'ssh' ? 'cloudSSHSettings' : kind === 'devices' ? 'cloudDevices' : 'cloudConflicts');
        lastFocus = [opener || doc.activeElement, fallback, doc.getElementById('cloudRefresh')].find(available) || null;
        // macOS mouse activation need not focus a button. Let WebKit capture
        // the actual opener as its own previously focused element, too.
        lastFocus?.focus?.({preventScroll:true});
        // WebKit can omit a top-layer dialog from accessibility when it
        // follows hidden workspace siblings. Move the retained node, not its UI.
        if (dialog.parentElement === doc.body && doc.body.firstElementChild !== dialog) doc.body.prepend(dialog);
        dialog.showModal();
      }
    }
    async function devices() {
      mountDialog('已连接的设备', 'devices');
      try {
        const result = await request('/__cloud/devices'); if (!dialog.open || dialogKind !== 'devices') return;
        dialogBody.replaceChildren(); const entries = list(result.devices || result.data);
        if (!entries.length) dialogBody.append(node('p', 'cloud-sync-muted', '暂无设备记录。'));
        for (const item of entries) {
          const row = node('div', 'cloud-sync-device'), copy = node('div'); const current = item.current || item.id === status.device?.id;
          const seen = typeof item.lastSeenAt === 'number' && item.lastSeenAt < 100000000000 ? item.lastSeenAt * 1000 : item.lastSeenAt;
          copy.append(node('strong', '', `${text(item.name || item.deviceName || '未命名设备')}${current ? ' · 当前设备' : ''}`), node('small', '', seen && Number.isFinite(new Date(seen).getTime()) ? `最近活动：${new Date(seen).toLocaleString('zh-CN')}` : '最近活动时间未知'));
          const revoke = button('撤销访问', 'cloud-sync-button cloud-sync-danger', async () => {
            const explanation = node('p', 'cloud-sync-confirm', '撤销后，这台设备需要重新登录；已下载到该设备的本地资料不会被远程删除。');
            const confirm = button('确认撤销', 'cloud-sync-button cloud-sync-danger', async () => { confirm.disabled = true; if (await mutate('/__cloud/revoke', { deviceId: item.id })) { if (dialog.open && dialogKind === 'devices') await devices(); } else { explanation.textContent = message.textContent || '撤销失败，请重试。'; confirm.disabled = false; } });
            revoke.replaceWith(explanation, confirm);
          }); revoke.disabled = busy; row.append(copy, revoke); dialogBody.append(row);
        }
      } catch (error) { if (dialog.open && dialogKind === 'devices') dialogBody.replaceChildren(node('p', 'cloud-sync-error', error.message)); }
    }
    async function conflicts() {
      mountDialog('处理同步冲突', 'conflicts');
      const epoch = dialogEpoch;
      const current = () => !destroyed && dialog.open && dialogKind === 'conflicts' && dialogEpoch === epoch;
      let entries = [], working = false, resolvingId = null, error = null, loadVersion = 0, host;
      function paintConflicts() {
        if (!current() || !host) return;
        const props = { entries, busy: working, resolvingId, error, onChoose: choose, onReload: load };
        if (conflictIsland) conflictIsland.update(props);
        else conflictIsland = environment.HalaskaUI.mount(host, 'CloudConflictReview', props);
      }
      async function load() {
        if (!current() || working) return;
        const version = ++loadVersion; working = true; error = null; paintConflicts();
        try {
          const result = await request('/__cloud/conflicts');
          if (!current() || version !== loadVersion) return;
          const preview = item => ({
            id: item.id, revision: item.revision, remoteVersion: item.remoteVersion,
            groupId: item.groupId,
            title: text(item.title || item.local?.title || item.local?.name || item.remote?.title || item.remote?.name || item.entityId || '内容冲突'),
            localPreview: conflictPreview(item.local), remotePreview: conflictPreview(item.remote),
            localFields: conflictText(item.local), remoteFields: conflictText(item.remote),
            localDeleted: item.local == null || item.local?.deleted === true || item.local?.tombstone === true,
            remoteDeleted: item.remote == null || item.remote?.deleted === true || item.remote?.tombstone === true,
          });
          entries = list(result.conflicts || result.data).map(item => ({ ...preview(item),
            groupMembers: item.groupId ? list(item.groupMembers).map(preview) : undefined,
          }));
        } catch (failure) {
          if (current() && version === loadVersion) error = { message: failure.message, staleId: '*' };
        } finally {
          if (current() && version === loadVersion) { working = false; paintConflicts(); }
        }
      }
      async function choose(id, choice, revision) {
        if (!current() || working || !['local','remote'].includes(choice)) return;
        const shown = entries.find(item => item.id === id && item.revision === revision);
        if (!shown || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || error?.staleId === '*' || error?.staleId === id) return;
        if (shown.groupId && choice !== 'remote') return;
        if (hostBusy()) { error = { message: '请先结束当前编辑，再处理冲突。' }; paintConflicts(); return; }
        working = true; resolvingId = id; error = null; paintConflicts();
        let failure;
        const ok = await mutate('/__cloud/resolve', { id, choice, revision }, true, {
          isCurrent: current, onError: value => { failure = value; },
        });
        if (!current()) return;
        working = false; resolvingId = null;
        if (ok) {
          // A choice is complete only after the backend confirms it. Reload the
          // remaining snapshots; never reuse the old revision for another attempt.
          await load();
        } else {
          error = { message: ['CONFLICT_CHANGED','CONFLICT_MISSING'].includes(failure?.code)
            ? '这条冲突的内容已变化。请重新载入并比较后再选择；本次没有覆盖任何版本。'
            : failure?.message || '此次操作未完成，请重新载入冲突以核对结果。', staleId: id };
          paintConflicts();
        }
      }
      if (!environment.HalaskaUI?.componentNames?.includes('CloudConflictReview')) {
        dialogBody.replaceChildren(node('p','cloud-sync-error','冲突审阅界面尚未加载，请重新打开最新版 AI Bro。')); return;
      }
      host = node('div', 'cloud-conflict-review-host'); dialogBody.replaceChildren(host);
      paintConflicts(); await load();
    }
    function editConnection() {
      if (busy || hostBusy()) return;
      editingConnection = !editingConnection; connectionOpen = false;
      password.value = ''; merge.checked = false;
      if (editingConnection) {
        server.value = status.serverUrl || ''; username.value = status.account?.username || '';
        deviceName.value = status.device?.name || ''; password.value = ''; merge.checked = false;
        report('可更新登录凭据与设备名称。SSH 主机和远程目录请在“SSH 与存储目录”修改；切换到其他账号仍需独立工作区。', 'info');
      }
      paint(); if (editingConnection) (server.readOnly ? password : server).focus();
    }
    async function openSSHConnection(target, opener) {
      if (busy || sshRequestBusy || sshMaintenancePending || hostBusy()) return;
      environment.SettingsWorkspace?.reveal('sync');
      mountDialog('连接 SSH 服务器', 'ssh-connect', opener);
      const epoch = dialogEpoch, current = () => !destroyed && dialog?.open && dialogKind === 'ssh-connect' && dialogEpoch === epoch;
      let draft, islandHost;
      try {
        const metadata = await request('/__cloud/ssh'); if (!current()) return;
        sshConfigRevision++; sshConfig = metadata.config || null; sshHosts = list(metadata.hosts).filter(host => typeof host.target === 'string' && host.target.trim()); adoptSSHJob(metadata); sshMetadataError = ''; paint();
        if (sshMaintenancePending) { await sshSettings({currentTarget:opener}); return; }
        const config = {...{target: '', sshPort: 0, localPort: 18787, remotePort: 8787}, ...(sshConfig || {})};
        if (typeof target === 'string') config.target = target;
        draft = {config, deviceName: status.device?.name || (/Mac/i.test(environment.navigator?.platform || '') ? '我的 Mac' : '我的电脑'), confirmed: false, accountId: '', probe: null, message: '', kind: '', busy: sshRequestBusy ? 'waiting' : ''};
        if (!environment.HalaskaUI?.componentNames?.includes('CloudSSHConnection')) throw new Error('SSH 连接界面尚未加载，请重新打开最新版 AI Bro。');
        islandHost = node('div', 'cloud-ssh-connection-host'); dialogBody.replaceChildren(islandHost);
        const boundAccountId = text(status.target?.accountId), boundServer = status.target?.serverUrl || '';
        const paintSSH = () => {
          if (!current()) return;
          const autoSync = boundAccountId ? status.autoSync === true : true;
          if (draft.autoSync !== undefined && draft.autoSync !== autoSync) draft.confirmed = false;
          draft.autoSync = autoSync;
          const props = {draft, hosts: sshHosts, boundAccountId, boundServer, onChange: change, onProbe: probe, onConnect: connectSSH};
          if (sshIsland) sshIsland.update(props); else sshIsland = environment.HalaskaUI.mount(islandHost, 'CloudSSHConnection', props);
        };
        sshConnectionPaint = paintSSH;
        function change(key, value) {
          if (!current() || sshRequestBusy || busy) return;
          if (['target','sshPort','localPort','remotePort'].includes(key)) { draft.config = {...draft.config, [key]: value}; draft.probe = null; draft.accountId = ''; draft.confirmed = false; draft.message = ''; draft.kind = ''; }
          else if (['deviceName','accountId','confirmed'].includes(key)) { draft[key] = value; if (key === 'accountId') draft.confirmed = false; }
          paintSSH();
        }
        const configKey = value => JSON.stringify(['target','sshPort','localPort','remotePort'].map(key => value[key]));
        function values() {
          const value = {target: text(draft.config.target).trim()};
          if (!value.target) throw new Error('请选择 SSH 主机，或填写主机别名 / 用户名@主机。');
          for (const key of ['sshPort','localPort','remotePort']) {
            const raw = text(draft.config[key]).trim(), port = Number(raw); if (!/^\d{1,5}$/.test(raw) || !Number.isInteger(port) || port < (key === 'sshPort' ? 0 : 1) || port > 65535) throw new Error('端口应为 1–65535；SSH 端口可用 0 沿用系统配置。'); value[key] = port;
          }
          return value;
        }
        async function probe() {
          if (!current() || sshRequestBusy || busy) return;
          let config; try { config = values(); } catch (error) { draft.message = error.message; draft.kind = 'error'; paintSSH(); return; }
          sshRequestBusy = true; draft.busy = 'probe'; draft.probe = null; draft.accountId = ''; draft.confirmed = false; draft.message = '正在通过系统 SSH 检查主机与同步服务…'; draft.kind = 'progress'; paintSSH(); paint();
          try {
            const result = await request('/__cloud/ssh/probe', {config}); if (!current()) return;
            const remote = result.remote || {}, accounts = list(remote.accounts).filter(account => typeof account.id === 'string' && account.id);
            const allowed = boundAccountId ? accounts.filter(account => account.id === boundAccountId) : accounts;
            draft.config = result.config || config;
            draft.probe = {...remote, accounts, checkedConfig: configKey(draft.config)};
            draft.accountId = allowed.length === 1 ? allowed[0].id : '';
            draft.message = !remote.active ? 'SSH 已响应，但同步服务没有运行。请先启动该服务器上的 AI Bro 同步服务。' : !allowed.length ? (boundAccountId ? '此服务器没有当前工作区绑定的远端账号。请选择原服务器，避免混合其他账号的数据。' : '服务器上没有可连接的同步账号。请先在服务器创建个人同步账号。') : '连接检查通过。请核对下方连接方式并确认。';
            draft.kind = remote.active && allowed.length ? 'success' : 'error';
          } catch (error) { if (current()) { draft.message = error.message; draft.kind = 'error'; } }
          finally { sshRequestBusy = false; if (current()) { draft.busy = ''; paintSSH(); } if (!destroyed) paint(); }
        }
        async function connectSSH() {
          if (!current() || sshRequestBusy || busy) return;
          paintSSH();
          let config; try { config = values(); } catch (error) { draft.message = error.message; draft.kind = 'error'; paintSSH(); return; }
          if (!draft.probe || !draft.probe.active || draft.probe.checkedConfig !== configKey(config)) { draft.message = '连接配置已变化，请先重新检查连接。'; draft.kind = 'error'; paintSSH(); return; }
          if (!draft.accountId || !draft.probe.accounts.some(account => account.id === draft.accountId) || (boundAccountId && draft.accountId !== boundAccountId)) { draft.message = '请选择检查结果中的远端工作区。'; draft.kind = 'error'; paintSSH(); return; }
          if (!draft.deviceName.trim() || !draft.confirmed) { draft.message = draft.autoSync ? '请填写本机设备名称，并确认合并本机与远端内容。' : '请填写本机设备名称，并确认恢复连接、保持自动同步暂停。'; draft.kind = 'error'; paintSSH(); return; }
          if (hostBusy()) { draft.message = '请先结束当前编辑或对话，再连接并同步。'; draft.kind = 'error'; paintSSH(); return; }
          // Reauthorizing the same workspace must not resume uploads that the
          // user paused. First connections keep their explicit sync consent.
          const payload = {config, accountId: draft.accountId, deviceName: draft.deviceName.trim(), mergeConfirmed: true, autoSync: draft.autoSync};
          sshRequestBusy = true; busy = true; generation++; loading = null; clearTimeout(timer); draft.busy = 'connect'; draft.message = '正在建立连接并登记本机设备…'; draft.kind = 'progress'; paintSSH(); paint();
          try {
            if ((await hooks.flush?.()) === false) throw new Error('本机更改尚未保存，请先保存本机草稿。');
            if (hostBusy()) throw new Error('当前有新的编辑或对话，请稍后再连接。');
            // A dismissed preflight must not start a new remote mutation after an asynchronous save.
            if (!current()) return;
            const result = await request('/__cloud/ssh/connect', payload);
            if (destroyed) return;
            receive(result); sshConfigRevision++; sshConfig = result.config || config; await remoteFrom(result);
            report(payload.autoSync ? 'SSH 连接已建立，同步进度以上方实际状态为准。' : 'SSH 连接已建立，自动同步保持暂停。准备好后可手动同步。', 'success');
            if (current()) dialog.close();
            await refresh();
          } catch (error) { if (current()) { draft.message = error.message; draft.kind = 'error'; } else if (!destroyed) report(error.message); }
          finally { sshRequestBusy = false; busy = false; if (current()) { draft.busy = ''; paintSSH(); } if (!destroyed) { paint(); schedule(); } }
        }
        paintSSH(); doc.getElementById('cloudSSHHost')?.focus?.();
      } catch (error) { if (current()) dialogBody.replaceChildren(node('p', 'cloud-sync-message', error.message)); }
    }
    async function sshSettings(event) {
      if (destroyed || busy || sshRequestBusy) return;
      mountDialog('SSH 与存储目录', 'ssh', event?.currentTarget); clearTimeout(sshTimer);
      const epoch = dialogEpoch, current = () => !destroyed && dialog?.open && dialogKind === 'ssh' && dialogEpoch === epoch;
      const key = c => JSON.stringify(['target','sshPort','localPort','remotePort'].map(name => c?.[name]));
      let draft, islandHost;
      const paintStorage = () => {
        if (!current() || !draft) return;
        const props = {draft, onChange:change, onInspect:inspect, onSave:save, onMove:move, onRefresh:poll, onReconcile:reconcile, onConnect:()=>openSSHConnection('')};
        if (sshIsland) sshIsland.update(props); else sshIsland = environment.HalaskaUI.mount(islandHost, 'CloudSSHStorage', props);
      };
      const operationBlocked = () => !current() || busy || sshRequestBusy || sshMaintenancePending || !!draft?.busy || pendingSSHJob(draft?.job) || !!draft?.uncertain;
      function change(name,value) {
        if (operationBlocked()) return;
        if (['target','sshPort','localPort','remotePort'].includes(name)) {
          if (name === 'localPort') return;
          draft.config = {...draft.config,[name]:value}; draft.verified = false; draft.confirmed = false; draft.remote = null;
        } else if (name === 'destination') { draft.destination = value; draft.confirmed = false; }
        else if (name === 'confirmed') draft.confirmed = value === true;
        draft.message = ''; draft.kind = ''; paintStorage();
      }
      function values() {
        const config = {target:text(draft.config?.target).trim()};
        if (!config.target) throw new Error('请填写 SSH 主机别名或 用户名@主机。');
        for (const name of ['sshPort','localPort','remotePort']) {
          const raw = text(draft.config?.[name]).trim(), port = Number(raw);
          if (!/^\d{1,5}$/.test(raw) || !Number.isInteger(port) || port < (name === 'sshPort' ? 0 : 1) || port > 65535) throw new Error('端口应为 1–65535；SSH 端口可用 0 沿用系统配置。');
          config[name] = port;
        }
        return config;
      }
      function showError(error) { if (current()) { draft.message = error.message; draft.kind = 'error'; paintStorage(); } }
      function applyJob(state, recovering = false) {
        if (!adoptSSHJob(state)) {
          draft.job = sshJob || draft.job; draft.uncertain = true; sshMaintenancePending = true; draft.verified = false; draft.confirmed = false;
          draft.message = '尚未读取到本次目标目录的迁移结果。请重新读取状态，不要重复提交。'; draft.kind = 'error'; return;
        }
        draft.job = state.job || (sshMaintenancePending ? sshJob || draft.job : ['completed','error'].includes(draft.job?.state) ? draft.job : null);
        if (state.remote) draft.remote = state.remote;
        if (pendingSSHJob(draft.job)) { draft.uncertain = !state.job || draft.job.state !== 'running'; sshMaintenancePending = true; draft.verified = false; draft.confirmed = false; }
        else if (['completed','error'].includes(draft.job?.state)) { draft.uncertain = false; sshMaintenancePending = false; sshExpectedMove = null; draft.verified = false; }
        else if (recovering && sshMaintenancePending) draft.uncertain = true;
        if (draft.job?.message) { draft.message = draft.job.message; draft.kind = draft.job.state === 'completed' ? 'success' : draft.job.state === 'error' || draft.uncertain ? 'error' : 'progress'; }
        else if (draft.uncertain) { draft.message = '尚未读取到明确的迁移结果。请继续检查状态，不要重复提交迁移。'; draft.kind = 'error'; }
      }
      async function perform(name,route,payload) {
        if (operationBlocked()) return null;
        sshRequestBusy = true; draft.busy = name; draft.message = name === 'move' ? '正在提交目录迁移…' : '正在核对服务器…'; draft.kind = 'progress'; paintStorage(); paint();
        try { return await request(route,payload); }
        catch (error) {
          const unknownMove = name === 'move' && !(error.responseStatus >= 400 && error.responseStatus < 500);
          if (name === 'move') { if (unknownMove) sshMaintenancePending = true; else sshExpectedMove = null; if (current()) { draft.uncertain = unknownMove; draft.verified = false; draft.confirmed = false; } }
          if (current()) { draft.message = unknownMove ? error.message + ' 请先重新读取迁移状态，再进行其他操作。' : error.message; draft.kind = 'error'; }
          else if (!destroyed) report(error.message);
          return null;
        } finally { sshRequestBusy = false; if (current()) { draft.busy = ''; paintStorage(); } if (!destroyed) paint(); }
      }
      async function inspect() {
        if (operationBlocked()) return;
        let config; try { config = values(); } catch (error) { showError(error); return; }
        draft.verified = false; draft.confirmed = false;
        const result = await perform('inspect','/__cloud/ssh/inspect',{config}); if (!result || !current()) return;
        draft.remote = result.remote || null;
        draft.verified = !!result.remote?.dataPath && key(config) === key(draft.savedConfig) && key(config) === key(values());
        draft.message = draft.verified ? '已核对当前账号和实际存储目录。' : '已核对该服务器。修改连接后请先保存，再迁移目录。'; draft.kind = 'success'; paintStorage();
      }
      async function save() {
        if (operationBlocked()) return;
        let config; try { config = values(); } catch (error) { showError(error); return; }
        draft.verified = false; draft.confirmed = false;
        const result = await perform('save','/__cloud/ssh/save',{config}); if (!result || destroyed) return;
        // Adopt the confirmed connection even if its dialog was dismissed while waiting.
        if (result.config) { sshConfigRevision++; sshConfig = result.config; }
        paint();
        if (!current()) return;
        draft.savedConfig = result.config || config; draft.config = {...draft.savedConfig}; draft.remote = result.remote || null;
        draft.verified = !!result.remote?.dataPath; draft.message = 'SSH 配置已保存，连接检查通过。'; draft.kind = 'success'; paintStorage();
      }
      async function poll() {
        if (!current() || sshRequestBusy || draft.busy) return;
        clearTimeout(sshTimer); draft.busy = 'poll'; paintStorage();
        try {
          const value = await request('/__cloud/ssh'); if (!current()) return;
          applyJob(value,true);
          if (value.config && key(value.config) !== key(draft.savedConfig)) {
            draft.savedConfig = value.config; draft.verified = false; draft.confirmed = false;
            draft.message = '服务器连接配置已变化。请关闭并重新打开此窗口核对配置。'; draft.kind = 'error';
          }
        } catch (_) {
          if (current()) {
            const unresolved = sshMaintenancePending || draft.uncertain || draft.job?.state === 'running';
            if (unresolved) { draft.uncertain = true; sshMaintenancePending = true; draft.verified = false; draft.confirmed = false; }
            draft.message = unresolved ? '状态读取中断，迁移可能仍在服务器进行。点击“重新读取状态”确认结果；请勿重复提交。' : '暂时无法更新状态，已确认的上次结果仍保留。请重新读取状态。'; draft.kind = 'error';
          }
        } finally {
          if (current()) { draft.busy = ''; paintStorage(); if (draft.job?.state === 'running' && !draft.uncertain) sshTimer = setTimeout(poll,1500); }
          if (!destroyed) paint();
        }
      }
      async function reconcile() {
        if (!current() || busy || sshRequestBusy || draft.busy || (!pendingSSHJob(draft.job) && !draft.uncertain) || !/^[a-f0-9]{32}$/.test(draft.job?.id || '')) return;
        clearTimeout(sshTimer); const jobId = draft.job.id;
        sshConfigRevision++; sshRequestBusy = true; draft.busy = 'reconcile';
        draft.message = '正在通过 SSH 核对这次迁移的服务器回执；不会重新执行迁移。'; draft.kind = 'progress'; paintStorage(); paint();
        try {
          const value = await request('/__cloud/ssh/reconcile', {jobId}); if (destroyed) return;
          if (value.job?.id !== jobId || value.job.source !== draft.job.source || value.job.destination !== draft.job.destination) throw new Error('服务器回执不属于这次迁移，结果仍待核对。');
          sshConfigRevision++; adoptSSHJob(value);
          if (value.cloudStatus || value.status) receive(value.cloudStatus || value.status);
          if (!current()) return;
          draft.verified = false; draft.confirmed = false; applyJob(value,true);
        } catch(error) {
          if (current()) { draft.message = error.message; draft.kind = 'error'; draft.uncertain = true; }
          if (!destroyed) sshMaintenancePending = true;
        } finally {
          sshRequestBusy = false;
          if (current()) { draft.busy = ''; paintStorage(); }
          if (!destroyed) { paint(); void refresh(); }
        }
      }
      async function move() {
        if (operationBlocked() || !draft.verified || !draft.confirmed) return;
        let config; try { config = values(); } catch (error) { showError(error); return; }
        if (key(config) !== key(draft.savedConfig)) { draft.verified = false; showError(new Error('连接配置已变化，请保存后重新读取服务器路径。')); return; }
        const destination = draft.destination.trim();
        if (!destination.startsWith('/') || destination.length > 2048) { showError(new Error('请输入服务器上的绝对目录路径。')); return; }
        if (destination === draft.remote?.dataPath) { showError(new Error('新目录与当前目录相同，请选择其他目录。')); return; }
        if (hostBusy()) { showError(new Error('请先结束当前编辑或对话，再迁移服务器目录。')); return; }
        sshConfigRevision++; sshExpectedMove = {source:draft.remote.dataPath,destination,previousId:draft.job?.id || null}; draft.job = null;
        const result = await perform('move','/__cloud/ssh/move',{expectedPath:draft.remote.dataPath,dataPath:destination,confirmed:true});
        if (!result || destroyed) return;
        sshConfigRevision++; const adopted = adoptSSHJob(result); sshMaintenancePending = !adopted || !result.job || pendingSSHJob(result.job);
        if (!current()) { paint(); return; }
        draft.confirmed = false; draft.verified = false; applyJob(result,true); paintStorage(); paint();
        if (draft.job?.state === 'running' && !draft.uncertain) sshTimer = setTimeout(poll,1500);
      }
      try {
        const state = await request('/__cloud/ssh'); if (!current()) return;
        if (!environment.HalaskaUI?.componentNames?.includes('CloudSSHStorage')) throw new Error('SSH 维护界面尚未加载，请重新打开最新版 AI Bro。');
        const restoredJob = state.job || (sshMaintenancePending ? sshJob : null);
        const displayConfig = pendingSSHJob(restoredJob) ? restoredJob.config || state.config : state.config;
        draft = {config:displayConfig ? {...displayConfig} : null, savedConfig:state.config || null, remote:state.remote || null, verified:false, destination:pendingSSHJob(restoredJob) ? restoredJob.destination || '' : '', confirmed:false, busy:'', job:null, uncertain:false, message:'', kind:''};
        sshConfigRevision++; sshConfig = state.config || null; applyJob(state,true);
        islandHost = node('div','cloud-ssh-storage-host'); dialogBody.replaceChildren(islandHost); paintStorage(); paint();
        doc.getElementById(draft.uncertain ? (/^[a-f0-9]{32}$/.test(draft.job?.id || '') ? 'cloudSSHReconcile' : 'cloudSSHRefresh') : state.config ? 'cloudSSHInspect' : 'cloudSSHStorageConnect')?.focus?.();
        if (draft.job?.state === 'running' && !draft.uncertain) sshTimer = setTimeout(poll,1500);
      } catch(error) { if(current()) dialogBody.replaceChildren(node('p','cloud-sync-message',error.message)); }
    }
    function mountAccount() {
      if (!environment.HalaskaUI?.componentNames?.includes('CloudAccountConnection')) return;
      const ids = ['cloudServerUrl','cloudUsername','cloudPassword','cloudDeviceName','cloudMergeConfirmed','cloudConnect','cloudConnectionIntro','cloudServerHint','cloudConnectionSSH'];
      accountNodes = new Map(ids.map(id => [id,doc.getElementById(id)]));
      accountParking = node('div','cloud-account-retained'); accountParking.hidden = true;
      accountParking.append(...form.childNodes); const host = node('div','cloud-account-host'); form.append(accountParking,host);
      const attach = (id,slot) => { const input = accountNodes.get(id); if (!input) return; slot.append(input); return () => { accountParking.append(input); }; };
      accountIsland = environment.HalaskaUI.mount(host,'CloudAccountConnection',{view:describe(status),controls:{},attach,onSSH:()=>openSSHConnection()});
    }
    function paintAccount(view) {
      if (!accountIsland) return;
      const controls = {};
      for (const [id,input] of accountNodes) {
        const value = {disabled:!!input.disabled,readOnly:!!input.readOnly,hidden:!!input.hidden};
        if (id === 'cloudMergeConfirmed') { value.checked = input.checked; value.label = mergeText.textContent; }
        else if (id === 'cloudConnect' || id === 'cloudConnectionSSH') value.label = input.textContent;
        else if (id !== 'cloudPassword') value.text = input.textContent;
        controls[id] = value;
      }
      accountIsland.update({view,controls});
    }
    function mount() {
      if (card) return; const host = hooks.container || doc.querySelector('#settings .settings-grid') || doc.getElementById('settings'); if (!host) return;
      card = node('article', 'card cloud-sync-card'); card.id = 'cloudSyncCard';
      const header = node('div', 'cloud-sync-heading'); header.append(node('h2', '', '连接与同步')); badge = node('span', 'cloud-sync-badge', '纯本地'); badge.setAttribute('role','status'); header.append(badge); description = node('p', 'cloud-sync-description');
      form = node('form', 'cloud-sync-connect'); form.addEventListener('submit', connect);
      const fields = node('div', 'cloud-sync-fields');
      formIntro = node('p', 'cloud-sync-form-intro'); formIntro.id = 'cloudConnectionIntro';
      const field = (label, id, type, placeholder) => { const wrapper = node('label'); const input = node('input'); input.id = id; input.type = type; input.placeholder = placeholder; input.autocomplete = type === 'password' ? 'current-password' : id === 'cloudUsername' ? 'username' : 'off'; input.addEventListener('input', () => { connectionDirty = true; }); wrapper.append(node('span', '', label), input); fields.append(wrapper); return input; };
      server = field('云服务器', 'cloudServerUrl', 'url', 'https://sync.example.com'); username = field('云账号用户名', 'cloudUsername', 'text', '你的账号'); password = field('密码', 'cloudPassword', 'password', '仅用于本次连接'); deviceName = field('本机设备名称', 'cloudDeviceName', 'text', '例如：我的 MacBook');
      serverHint = node('p', 'cloud-sync-server-hint'); serverHint.id = 'cloudServerHint'; server.setAttribute('aria-describedby', 'cloudServerHint');
      connectionSSH = button('SSH 连接配置', 'cloud-sync-button cloud-sync-subtle', openSSHConnection); connectionSSH.id = 'cloudConnectionSSH'; connectionSSH.hidden = true;
      const agreement = node('label', 'cloud-sync-agreement'); merge = node('input'); merge.type = 'checkbox'; merge.id = 'cloudMergeConfirmed'; merge.addEventListener('change', paint); mergeText = node('span'); agreement.append(merge, mergeText);
      connectButton = node('button', 'cloud-sync-button cloud-sync-primary', '连接并合并'); connectButton.id = 'cloudConnect'; connectButton.type = 'submit'; form.append(formIntro, fields, serverHint, connectionSSH, agreement, connectButton);
      accountBox = node('div', 'cloud-sync-connected'); accountText = node('p', 'cloud-sync-account'); const metrics = node('div', 'cloud-sync-metrics'); pendingText = node('span'); lastSyncText = node('span'); metrics.append(pendingText,lastSyncText);
      const autoLabel = node('label', 'cloud-sync-auto'); autoToggle = node('input'); autoToggle.type = 'checkbox'; autoToggle.id = 'cloudAutoSync'; autoToggle.addEventListener('change', () => mutate('/__cloud/settings', { autoSync: autoToggle.checked })); autoLabel.append(autoToggle,node('span','','自动同步'));
      const actions = node('div', 'cloud-sync-actions'); syncButton = button('立即同步', 'cloud-sync-button cloud-sync-primary', sync); syncButton.id = 'cloudSyncNow'; devicesButton = button('管理设备', 'cloud-sync-button', devices); devicesButton.id = 'cloudDevices'; conflictsButton = button('处理冲突', 'cloud-sync-button', conflicts); conflictsButton.id = 'cloudConflicts'; disconnectButton = button('断开连接', 'cloud-sync-button cloud-sync-subtle', () => mutate('/__cloud/disconnect', {})); disconnectButton.id = 'cloudDisconnect'; editButton = button('修改连接配置', 'cloud-sync-button', editConnection); editButton.id = 'cloudEditConnection'; sshButton = button('SSH 与存储目录', 'cloud-sync-button', sshSettings); sshButton.id = 'cloudSSHSettings'; actions.append(syncButton,editButton,sshButton,devicesButton,conflictsButton,disconnectButton); accountBox.append(accountText,metrics,autoLabel,actions);
      deferredButton = button('应用已收到的更新', 'cloud-sync-button', applyDeferred); deferredButton.id = 'cloudApplyReceived'; deferredButton.hidden = true;
      message = node('p', 'cloud-sync-message'); message.id = 'cloudSyncMessage'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); const refreshButton = button('刷新状态', 'cloud-sync-refresh', () => { void loadConnectionDetails(true); return refresh(); }); refreshButton.id = 'cloudRefresh'; if (environment.HalaskaUI?.componentNames?.includes('CloudSyncOverview')) {
        overview = node('div', 'cloud-sync-overview-host'); card.append(overview,form,message,refreshButton);
      } else card.append(header,description,form,accountBox,deferredButton,message,refreshButton);
      host.append(card); mountAccount(); paint();
    }
    function init() {
      mount(); if (card) refresh();
      if (!observer && environment.MutationObserver && doc.body) {
        observer = new environment.MutationObserver(() => { if (!busy && doc.body.dataset.view === 'settings') refresh(); else schedule(); });
        observer.observe(doc.body, { attributes: true, attributeFilter: ['data-view'] });
      }
      return api;
    }
    function destroy() { destroyed = true; generation++; dialogEpoch++; conflictIsland?.unmount(); conflictIsland = null; sshIsland?.unmount(); sshIsland = null; clearTimeout(timer); clearTimeout(sshTimer); observer?.disconnect(); overviewIsland?.unmount(); accountIsland?.unmount(); accountIsland = null; if (password) password.value = ''; dialog?.close(); }
    const api = { init, refresh, reconcileAppliedRevision, connect, sync, devices, conflicts, openSSHConnection, destroy, getStatus: () => ({ ...status }) };
    return api;
  }
  let controller;
  return { serverURL, describe, conflictText, conflictPreview, createController, init(hooks) { controller ||= createController(hooks); controller.init(); return controller; }, refresh() { return controller?.refresh(); }, reconcileAppliedRevision() { controller?.reconcileAppliedRevision(); } };
}));
