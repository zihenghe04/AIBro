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
    const labels = { local: '纯本地', disconnected: '纯本地', syncing: '同步中', synced: '已同步', idle: '已连接', offline: '离线待重试', paused: '已暂停', conflict: '有冲突待处理', auth_required: '需要重新登录', error: '同步未完成', pending: '有更改待上传' };
    const inferred = status.syncing ? 'syncing' : /401|AUTH_REQUIRED|UNAUTHORIZED/.test(status.errorCode || '') ? 'auth_required' : !connected ? 'local' : conflicts > 0 ? 'conflict' : status.error ? 'offline' : status.autoSync === false ? 'paused' : pending > 0 ? 'pending' : status.lastSyncAt ? 'synced' : 'idle';
    let state = status.state || inferred, label = labels[state] || (connected ? '已连接' : '纯本地');
    if (state === 'synced' && pending > 0) { label = '有更改待上传'; state = 'pending'; }
    const timestamp = status.lastSyncAt == null ? NaN : typeof status.lastSyncAt === 'number' ? status.lastSyncAt : Date.parse(status.lastSyncAt);
    return { state, label, connected, pending, conflicts, lastSync: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '尚未成功同步', error: errorText(status.error) };
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
    let status = {}, busy = false, generation = 0, loading = null, timer = null, destroyed = false, deferredRevision = null, lastAppliedRevision = 0, dialogKind = '', lastFocus, observer = null, feedbackKind = '';
    const node = (tag, className, value) => { const result = doc.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; };
    const button = (label, className, handler) => { const result = node('button', className, label); result.type = 'button'; result.addEventListener('click', handler); return result; };
    const hostBusy = () => !!hooks.isBusy?.();
    const report = (value, kind = 'error') => { if (message) message.textContent = value; feedbackKind = value ? kind : ''; };
    function paint() {
      if (!card) return;
      const view = describe(status), blocked = busy || hostBusy();
      badge.textContent = busy ? '正在处理…' : view.label; badge.dataset.state = busy ? 'syncing' : view.state;
      description.textContent = view.connected ? '知识、笔记和任务同步到你连接的服务器；断开后本地资料仍保留。' : '当前资料保存在本机。连接自己的云服务器后，可以在多台设备间同步。';
      form.hidden = view.connected && view.state !== 'auth_required'; accountBox.hidden = !view.connected;
      accountText.textContent = [status.account?.username, status.serverUrl, status.device?.name].filter(Boolean).join(' · ') || '云账号已连接';
      pendingText.textContent = view.pending == null ? '待上传数量尚未确认' : `待上传 ${view.pending} 项`;
      lastSyncText.textContent = `最后同步：${view.lastSync}`;
      connectButton.disabled = blocked || !merge.checked;
      syncButton.disabled = blocked || !view.connected || view.state === 'auth_required';
      autoToggle.disabled = blocked || !view.connected; autoToggle.checked = status.autoSync === true;
      disconnectButton.disabled = busy; devicesButton.disabled = busy; conflictsButton.disabled = busy || !view.conflicts;
      conflictsButton.textContent = `处理冲突${view.conflicts == null ? '' : ` · ${view.conflicts}`}`;
      deferredButton.hidden = !deferredRevision; deferredButton.disabled = blocked;
      if (view.error && !busy && !['error', 'deferred'].includes(feedbackKind)) report(view.error, 'status');
    }
    async function request(route, payload) {
      if (!fetcher) throw new Error('请在桌面应用或本地服务中使用云同步。');
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetcher(route, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: controller.signal });
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(errorText(data.error) || `云同步请求失败（${response.status}）`);
        return data;
      } catch (error) { if (error?.name === 'AbortError') throw new Error('云同步请求超时，请检查网络后重试。'); throw error; }
      finally { clearTimeout(timeout); }
    }
    function receive(value) {
      const candidate = value?.status && typeof value.status === 'object' ? value.status : value;
      if (candidate && typeof candidate === 'object') { status = { ...status, ...candidate }; if (!Object.hasOwn(candidate,'state')) delete status.state; }
    }
    async function applyRevision(revision) {
      revision = Number(revision);
      if (!Number.isSafeInteger(revision) || revision <= lastAppliedRevision) return true;
      deferredRevision = Math.max(deferredRevision || 0, revision);
      if (hostBusy()) { report('云端更新已收到。当前编辑或对话结束后，可点击“应用已收到的更新”。', 'deferred'); paint(); return false; }
      if (typeof hooks.applyRemote !== 'function' || (await hooks.applyRemote(revision)) === false) { report('云端更新暂未应用。本机草稿已保留，请先处理正在进行的编辑。', 'deferred'); paint(); return false; }
      lastAppliedRevision = Math.max(lastAppliedRevision, revision); if (deferredRevision <= revision) deferredRevision = null; if (!deferredRevision && feedbackKind === 'deferred') report(''); paint(); return true;
    }
    async function remoteFrom() {
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
        try { const result = await request('/__cloud/status'); if (version !== generation || destroyed) return status; receive(result); if (feedbackKind === 'status' && !errorText(status.error)) report(''); await remoteFrom(result); paint(); return status; }
        catch (error) { if (version === generation) { status = { ...status, state: status.connected ? 'offline' : 'local' }; report(error.message, 'status'); paint(); } return status; }
        finally { if (version === generation) loading = null; schedule(); }
      })(); return loading;
    }
    async function mutate(route, payload, needsFlush = false) {
      if (busy) return false;
      if (needsFlush && hostBusy()) { report('当前有编辑或对话正在进行，请结束后再同步。'); paint(); return false; }
      generation++; loading = null; busy = true; clearTimeout(timer); paint(); report('正在处理云同步…', 'progress');
      try {
        if (needsFlush && (await hooks.flush?.()) === false) throw new Error('本机更改尚未保存，云同步已暂停，请先保存本机草稿。');
        if (needsFlush && hostBusy()) throw new Error('当前有新的编辑或对话，请稍后再同步。');
        const result = await request(route, payload); receive(result); await remoteFrom(result);
        if (!deferredRevision) report(route === '/__cloud/disconnect' ? '已断开云连接，本机资料已保留。' : '操作完成，正在更新同步状态。', 'success');
        await refresh(); return true;
      } catch (error) { report(error.message); hooks.toast?.(error.message); return false; }
      finally { busy = false; paint(); schedule(); }
    }
    async function connect(event) {
      event?.preventDefault(); if (busy) return false;
      if (!merge.checked) { report('请先确认将当前本地知识与云端合并。'); return false; }
      let payload;
      try {
        payload = { serverUrl: serverURL(server.value), username: username.value.trim(), password: password.value, deviceName: deviceName.value.trim(), mergeConfirmed: true };
        if (!payload.username || !payload.password || !payload.deviceName) throw new Error('请填写用户名、密码和设备名称。');
      } catch (error) { report(error.message); return false; }
      password.value = '';
      const ok = await mutate('/__cloud/connect', payload, true);
      if (ok) merge.checked = false; paint(); return ok;
    }
    async function sync() { return mutate('/__cloud/sync', {}, true); }
    function mountDialog(title, kind) {
      if (!dialog) {
        dialog = node('dialog', 'cloud-sync-dialog'); dialog.id = 'cloudSyncDialog'; dialog.setAttribute('aria-labelledby', 'cloudSyncDialogTitle');
        const header = node('header', 'cloud-sync-dialog-header'); dialogTitle = node('h2'); dialogTitle.id = 'cloudSyncDialogTitle'; const close = button('×', 'cloud-sync-close', () => dialog.close()); close.setAttribute('aria-label', '关闭云同步详情'); header.append(dialogTitle, close); dialogBody = node('div', 'cloud-sync-dialog-body'); dialog.append(header, dialogBody); doc.body.append(dialog);
        dialog.addEventListener('close', () => { dialogKind = ''; lastFocus?.focus?.({ preventScroll: true }); });
      }
      dialogKind = kind; dialogTitle.textContent = title; dialogBody.replaceChildren(node('p', 'cloud-sync-muted', '正在读取…')); if (!dialog.open) { lastFocus = doc.activeElement; dialog.showModal(); }
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
      try {
        const result = await request('/__cloud/conflicts'); if (!dialog.open || dialogKind !== 'conflicts') return;
        dialogBody.replaceChildren(); const entries = list(result.conflicts || result.data);
        if (!entries.length) dialogBody.append(node('p', 'cloud-sync-muted', '当前没有待处理冲突。'));
        for (const item of entries) {
          const section = node('section', 'cloud-sync-conflict'); section.append(node('h3', '', text(item.title || item.local?.title || item.remote?.title || item.entityId || '内容冲突')));
          const versions = node('div', 'cloud-sync-versions');
          for (const [label, value] of [['本机版本', item.local], ['云端版本', item.remote]]) {
            const side = node('div'); side.append(node('h4', '', label), node('pre', 'cloud-sync-version-content', conflictPreview(value)));
            if (value && typeof value === 'object' && value.deleted !== true && value.tombstone !== true) {
              const details = node('details', 'cloud-sync-record-fields'); details.append(node('summary', '', '查看全部字段'), node('pre', '', conflictText(value))); side.append(details);
            }
            versions.append(side);
          }
          const actions = node('div', 'cloud-sync-conflict-actions');
          const feedback = node('p', 'cloud-sync-error'); feedback.setAttribute('role','status');
          for (const [choice, label] of [['local', '保留本机'], ['remote', '使用云端']]) actions.append(button(label, 'cloud-sync-button', async () => {
            feedback.textContent = '';
            if (hostBusy()) { feedback.textContent = '请先结束当前编辑，再处理冲突。'; return; }
            actions.querySelectorAll('button').forEach(control => { control.disabled = true; });
            if (await mutate('/__cloud/resolve', { id: item.id, choice }, true)) { if (dialog.open && dialogKind === 'conflicts') await conflicts(); } else { feedback.textContent = message.textContent || '暂未解决此冲突，请重试。'; actions.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
          }));
          section.append(versions, node('p', 'cloud-sync-muted', '选择后以该版本继续同步。请先核对两边的修改。'), feedback, actions); dialogBody.append(section);
        }
      } catch (error) { if (dialog.open && dialogKind === 'conflicts') dialogBody.replaceChildren(node('p', 'cloud-sync-error', error.message)); }
    }
    function mount() {
      if (card) return; const host = hooks.container || doc.querySelector('#settings .settings-grid') || doc.getElementById('settings'); if (!host) return;
      card = node('article', 'card cloud-sync-card'); card.id = 'cloudSyncCard';
      const header = node('div', 'cloud-sync-heading'); header.append(node('h2', '', '账号与云同步')); badge = node('span', 'cloud-sync-badge', '纯本地'); badge.setAttribute('role','status'); header.append(badge); description = node('p', 'cloud-sync-description');
      form = node('form', 'cloud-sync-connect'); form.addEventListener('submit', connect);
      const fields = node('div', 'cloud-sync-fields');
      const field = (label, id, type, placeholder) => { const wrapper = node('label'); const input = node('input'); input.id = id; input.type = type; input.placeholder = placeholder; input.autocomplete = type === 'password' ? 'current-password' : 'off'; wrapper.append(node('span', '', label), input); fields.append(wrapper); return input; };
      server = field('云服务器', 'cloudServerUrl', 'url', 'https://sync.example.com'); username = field('用户名', 'cloudUsername', 'text', '你的账号'); password = field('密码', 'cloudPassword', 'password', '仅用于本次连接'); deviceName = field('本机设备名称', 'cloudDeviceName', 'text', '例如：我的 MacBook');
      const agreement = node('label', 'cloud-sync-agreement'); merge = node('input'); merge.type = 'checkbox'; merge.id = 'cloudMergeConfirmed'; merge.addEventListener('change', paint); agreement.append(merge, node('span', '', '我确认将当前本地知识与云端合并。资料会上传到上述服务器；发生冲突时由我选择保留的版本。'));
      connectButton = node('button', 'cloud-sync-button cloud-sync-primary', '连接并合并'); connectButton.id = 'cloudConnect'; connectButton.type = 'submit'; form.append(fields, agreement, connectButton);
      accountBox = node('div', 'cloud-sync-connected'); accountText = node('p', 'cloud-sync-account'); const metrics = node('div', 'cloud-sync-metrics'); pendingText = node('span'); lastSyncText = node('span'); metrics.append(pendingText,lastSyncText);
      const autoLabel = node('label', 'cloud-sync-auto'); autoToggle = node('input'); autoToggle.type = 'checkbox'; autoToggle.id = 'cloudAutoSync'; autoToggle.addEventListener('change', () => mutate('/__cloud/settings', { autoSync: autoToggle.checked })); autoLabel.append(autoToggle,node('span','','自动同步'));
      const actions = node('div', 'cloud-sync-actions'); syncButton = button('立即同步', 'cloud-sync-button cloud-sync-primary', sync); syncButton.id = 'cloudSyncNow'; devicesButton = button('管理设备', 'cloud-sync-button', devices); devicesButton.id = 'cloudDevices'; conflictsButton = button('处理冲突', 'cloud-sync-button', conflicts); conflictsButton.id = 'cloudConflicts'; disconnectButton = button('断开连接', 'cloud-sync-button cloud-sync-subtle', () => mutate('/__cloud/disconnect', {})); disconnectButton.id = 'cloudDisconnect'; actions.append(syncButton,devicesButton,conflictsButton,disconnectButton); accountBox.append(accountText,metrics,autoLabel,actions);
      deferredButton = button('应用已收到的更新', 'cloud-sync-button', async () => { if (!deferredRevision || busy || hostBusy()) return; if ((await hooks.flush?.()) === false) { report('请先保存本机更改。'); return; } await applyRevision(deferredRevision); }); deferredButton.id = 'cloudApplyReceived'; deferredButton.hidden = true;
      message = node('p', 'cloud-sync-message'); message.id = 'cloudSyncMessage'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); const refreshButton = button('刷新状态', 'cloud-sync-refresh', () => refresh()); refreshButton.id = 'cloudRefresh'; card.append(header,description,form,accountBox,deferredButton,message,refreshButton); host.append(card); paint();
    }
    function init() {
      mount(); if (card) refresh();
      if (!observer && environment.MutationObserver && doc.body) {
        observer = new environment.MutationObserver(() => { if (!busy && doc.body.dataset.view === 'settings') refresh(); else schedule(); });
        observer.observe(doc.body, { attributes: true, attributeFilter: ['data-view'] });
      }
      return api;
    }
    function destroy() { destroyed = true; generation++; clearTimeout(timer); observer?.disconnect(); dialog?.close(); }
    const api = { init, refresh, connect, sync, devices, conflicts, destroy, getStatus: () => ({ ...status }) };
    return api;
  }
  let controller;
  return { serverURL, describe, conflictText, conflictPreview, createController, init(hooks) { controller ||= createController(hooks); controller.init(); return controller; }, refresh() { return controller?.refresh(); } };
}));
