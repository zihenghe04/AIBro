const test = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../cloud-sync-ui.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const connected = overrides => ({ connected: true, state: 'synced', serverUrl: 'https://sync.example.test', account: { username: 'researcher' }, device: { id: 'this-device', name: '我的电脑' }, autoSync: true, pending: 0, conflicts: 0, lastSyncAt: 1789000000000, remoteAppliedRevision: 0, ...overrides });

function harness(options = {}) {
  const elements = [], calls = [], applied = [], messages = []; let current = options.status || { connected: false, state: 'local' }, busy = false, flushes = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; elements.push(this); }
    set innerHTML(_) { throw new Error('HTML rendering is not permitted for cloud content'); }
    append(...children) { children.forEach(child => { child.parentNode = this; }); this.children.push(...children); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(...children) { const parent = this.parentNode; const index = parent.children.indexOf(this); children.forEach(child => { child.parentNode = parent; }); parent.children.splice(index, 1, ...children); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type) { const event = { preventDefault() {}, target: this }; for (const handler of this.listeners[type] || []) await handler(event); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire('close'); }
  }
  const host = new Element('section'), doc = { createElement: tag => new Element(tag), body: new Element('body'), visibilityState: 'visible', querySelector: selector => selector === '#settings .settings-grid' ? host : null, getElementById: id => elements.find(item => item.id === id) };
  doc.body.dataset.view = 'settings';
  const environment = { document: doc, disablePolling: true, get localStorage() { throw new Error('Cloud credentials must never enter localStorage'); } };
  const fetcher = async (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
    const result = await options.fetch?.(call); if (result) return result;
    if (url === '/__cloud/connect') current = connected();
    if (url === '/__cloud/disconnect') current = { connected: false, state: 'local', pending: 0, conflicts: 0, remoteAppliedRevision: 0 };
    if (url === '/__cloud/settings') current = { ...current, autoSync: call.body.autoSync };
    return { ok: true, json: async () => current };
  };
  const api = Cloud.createController({ fetch: fetcher, flush: async () => { flushes++; return options.flush?.() ?? true; }, applyRemote: async revision => { applied.push(revision); return options.applyRemote?.(revision) ?? true; }, isBusy: () => busy, toast: message => messages.push(message) }, environment);
  api.init();
  const el = id => elements.find(item => item.id === id);
  const fill = () => { el('cloudServerUrl').value = 'https://sync.example.test'; el('cloudUsername').value = 'researcher'; el('cloudPassword').value = 'top-secret-password'; el('cloudDeviceName').value = '我的 Mac'; el('cloudMergeConfirmed').checked = true; };
  return { api, doc, host, elements, calls, applied, messages, el, fill, setStatus: value => { current = value; }, setBusy: value => { busy = value; }, get flushes() { return flushes; } };
}

test('server addresses use TLS except explicit loopback development addresses; URL credentials and fragments are rejected', () => {
  assert.equal(Cloud.serverURL(' https://sync.example.test/ '), 'https://sync.example.test');
  assert.equal(Cloud.serverURL('http://127.0.0.1:18893'), 'http://127.0.0.1:18893');
  for (const url of ['http://external.example', 'https://user:secret@example.test', 'https://example.test/#secret', 'javascript:alert(1)', 'file:///tmp/data', 'https://example.test/?token=secret']) assert.throws(() => Cloud.serverURL(url), /HTTPS/);
});

test('pending uploads are not labelled synced and unknown quantities/times remain unknown', () => {
  assert.equal(Cloud.describe(connected({ pending: 3 })).label, '有更改待上传');
  assert.equal(Cloud.describe({}).pending, null); assert.equal(Cloud.describe({ pending: null }).pending, null);
  assert.equal(Cloud.describe({}).lastSync, '尚未成功同步');
  for (const [state, label] of [['local','纯本地'],['syncing','同步中'],['offline','离线待重试'],['paused','已暂停'],['conflict','有冲突待处理'],['auth_required','需要重新登录']]) assert.equal(Cloud.describe({ state }).label, label);
  assert.equal(Cloud.describe({ connected:true,syncing:true }).label,'同步中');
  assert.equal(Cloud.describe({ connected:true,errorCode:'HTTP_401' }).label,'需要重新登录');
  assert.equal(Cloud.describe({ connected:true,conflicts:2 }).label,'有冲突待处理');
  assert.equal(Cloud.describe({ connected:true,autoSync:false }).label,'已暂停');
});

test('connection requires explicit merge agreement and clears password after the single bounded local request', async () => {
  const h = harness(); await h.api.refresh(); h.fill(); h.el('cloudMergeConfirmed').checked = false;
  assert.equal(await h.api.connect(), false); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  h.el('cloudMergeConfirmed').checked = true; assert.equal(await h.api.connect(), true);
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/connect').body, { serverUrl: 'https://sync.example.test', username: 'researcher', password: 'top-secret-password', deviceName: '我的 Mac', mergeConfirmed: true });
  assert.equal(h.el('cloudPassword').value, ''); assert.equal(h.el('cloudMergeConfirmed').checked, false); assert.equal(h.flushes, 1);
  assert.equal(h.elements.some(item => item.textContent?.includes('top-secret-password')), false); h.api.destroy();
});

test('flush failure prevents sending credentials, and ongoing work blocks state-changing synchronization', async () => {
  const h = harness({ status: connected(), flush: () => false }); await h.api.refresh(); h.fill();
  assert.equal(await h.api.connect(), false); assert.equal(h.el('cloudPassword').value, ''); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.match(h.el('cloudSyncMessage').textContent, /尚未保存/);
  h.setBusy(true); assert.equal(await h.api.sync(), false); assert.equal(h.calls.some(call => call.url === '/__cloud/sync'), false); h.api.destroy();
});

test('in-flight cloud operation cannot be submitted twice and a failed connection does not retain password', async () => {
  let reject;
  const h = harness({ fetch: call => call.url === '/__cloud/connect' ? new Promise((_, no) => { reject = no; }) : null }); await h.api.refresh(); h.fill();
  const connecting = h.api.connect(); await tick(); assert.equal(await h.api.connect(), false); assert.equal(await h.api.sync(), false);
  assert.equal(h.calls.filter(call => call.url === '/__cloud/connect').length, 1); reject(new Error('服务器暂不可用')); assert.equal(await connecting, false);
  assert.equal(h.el('cloudPassword').value, ''); assert.match(h.el('cloudSyncMessage').textContent, /暂不可用/); h.api.destroy();
});

test('remote revision is deferred while editing, then applied through the host callback without fetching state directly', async () => {
  const h = harness(); await h.api.refresh(); h.setBusy(true); h.setStatus(connected({ remoteAppliedRevision: 8 })); await h.api.refresh();
  assert.deepEqual(h.applied, []); assert.equal(h.el('cloudApplyReceived').hidden, false); assert.equal(h.el('cloudApplyReceived').disabled, true);
  h.setBusy(false); await h.el('cloudApplyReceived').fire('click'); assert.deepEqual(h.applied, [8]); assert.equal(h.el('cloudApplyReceived').hidden, true);
  await h.api.refresh(); assert.deepEqual(h.applied, [8]); assert.equal(h.calls.some(call => call.url === '/__state'), false); h.api.destroy();
});

test('host refusing an incoming revision preserves the pending update for a later attempt', async () => {
  let accept = false; const h = harness({ status: connected({ remoteAppliedRevision: 12 }), applyRemote: () => accept }); await h.api.refresh();
  assert.equal(h.el('cloudApplyReceived').hidden, false); accept = true; await h.el('cloudApplyReceived').fire('click');
  assert.deepEqual(h.applied, [12,12]); assert.equal(h.el('cloudApplyReceived').hidden, true); h.api.destroy();
});

test('a stale status response cannot reconnect the UI after an explicit disconnect', async () => {
  let delayed = false, release;
  const h = harness({ status: connected(), fetch: call => delayed && call.url === '/__cloud/status' ? (delayed = false, new Promise(done => { release = () => done({ ok: true, json: async () => connected() }); })) : undefined }); await h.api.refresh();
  delayed = true; const old = h.api.refresh(); await tick(); await h.el('cloudDisconnect').fire('click'); release(); await old;
  assert.equal(h.api.getStatus().connected, false); assert.equal(h.api.getStatus().state, 'local'); h.api.destroy();
});

test('automatic-sync setting does not masquerade as sync success or replace form drafts on status refresh', async () => {
  const h = harness({ status: connected({ state: 'offline', pending: 2 }) }); await h.api.refresh();
  h.el('cloudAutoSync').checked = false; await h.el('cloudAutoSync').fire('change');
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/settings').body, { autoSync: false }); assert.equal(h.api.getStatus().pending, 2);
  h.el('cloudServerUrl').value = 'https://new-server.example'; await h.api.refresh(); assert.equal(h.el('cloudServerUrl').value, 'https://new-server.example'); h.api.destroy();
});

test('device revocation requires a second explicit action and never removes local content in the UI', async () => {
  const h = harness({ status: connected(), fetch: call => call.url === '/__cloud/devices' ? { ok: true, json: async () => ({ devices: [{ id: 'other', name: '<script>device</script>', lastSeenAt: 1789000000 }] }) } : undefined }); await h.api.refresh(); await h.api.devices();
  assert.ok(h.elements.some(item=>item.tagName==='small'&&item.textContent.includes('2026')),'Unix seconds display the actual device activity year');
  await h.elements.find(item => item.textContent === '撤销访问').fire('click'); assert.equal(h.calls.some(call => call.url === '/__cloud/revoke'), false);
  await h.elements.find(item => item.textContent === '确认撤销').fire('click'); assert.deepEqual(h.calls.find(call => call.url === '/__cloud/revoke').body, { deviceId: 'other' });
  assert.equal(h.elements.some(item => item.textContent === '<script>device</script>'), true); h.api.destroy();
});

test('conflicts show both literal versions, preserve deletion meaning, and resolve only the chosen conflict', async () => {
  let unresolved = true;
  const h = harness({ status: connected({ state: 'conflict', conflicts: 1 }), fetch: call => {
    if (call.url === '/__cloud/conflicts') return { ok: true, json: async () => ({ conflicts: unresolved ? [{ id: 'c-1', title: '人工笔记', local: { content: '<img onerror="x">' }, remote: null }] : [] }) };
    if (call.url === '/__cloud/resolve') { unresolved = false; return { ok: true, json: async () => connected({ remoteAppliedRevision: 13, conflicts: 0 }) }; }
  } }); await h.api.refresh(); await h.api.conflicts();
  const versions = h.elements.filter(item => item.tagName === 'pre').map(item => item.textContent);
  assert.ok(versions.some(value => value.includes('<img onerror'))); assert.ok(versions.includes('此版本已删除。'));
  await h.elements.find(item => item.textContent === '使用云端').fire('click');
  assert.deepEqual(h.calls.find(call => call.url === '/__cloud/resolve').body, { id: 'c-1', choice: 'remote' }); assert.deepEqual(h.applied, [13]); assert.equal(h.flushes, 1); h.api.destroy();
});

test('a recovered status clears the obsolete network failure without hiding a current save failure', async () => {
  let fail = true;
  const h = harness({ status: connected(), fetch: call => { if (call.url === '/__cloud/status' && fail) throw new Error('临时网络故障'); } });
  await h.api.refresh(); assert.match(h.el('cloudSyncMessage').textContent, /临时网络故障/);
  fail = false; await h.api.refresh(); assert.equal(h.el('cloudSyncMessage').textContent, '');
  h.api.destroy();
  const blocked = harness({ status: connected({ error: '上次网络失败' }), flush: () => false }); await blocked.api.refresh();
  assert.equal(await blocked.api.sync(), false); assert.match(blocked.el('cloudSyncMessage').textContent, /本机更改尚未保存/);
  await blocked.api.refresh(); assert.match(blocked.el('cloudSyncMessage').textContent, /本机更改尚未保存/); blocked.api.destroy();
});

test('finishing an already-confirmed operation does not reopen a conflict dialog dismissed while waiting', async () => {
  let finish;
  const h = harness({ status: connected({ conflicts:1 }), fetch: call => {
    if (call.url === '/__cloud/conflicts') return { ok:true,json:async()=>({conflicts:[{id:'slow',title:'待确认笔记',local:'本机',remote:'云端'}]}) };
    if (call.url === '/__cloud/resolve') return new Promise(done=>{finish=()=>done({ok:true,json:async()=>connected()});});
  } }); await h.api.refresh(); await h.api.conflicts();
  const choosing=h.elements.find(item=>item.textContent==='使用云端').fire('click'); await tick();
  h.el('cloudSyncDialog').close(); finish(); await choosing;
  assert.equal(h.el('cloudSyncDialog').open,false); assert.equal(h.calls.filter(call=>call.url==='/__cloud/resolve').length,1); h.api.destroy();
});

test('conflict review prioritizes readable content while keeping complete record fields available', async () => {
  const value={id:'internal-id',title:'方法笔记',workspace:'科研',content:'这里是人工修订。',updatedAt:1789000000000,sourceAttachmentIds:['paper-1'],tags:['控制'],customField:'保留的完整数据'};
  const preview=Cloud.conflictPreview(value);assert.match(preview,/标题：方法笔记/);assert.match(preview,/正文\n这里是人工修订/);assert.match(preview,/关联资料：1 份/);assert.doesNotMatch(preview,/internal-id|1789000000000/);
  const h=harness({status:connected({conflicts:1}),fetch:call=>call.url==='/__cloud/conflicts'?{ok:true,json:async()=>({conflicts:[{id:'review',local:value,remote:null}]})}:undefined});await h.api.refresh();await h.api.conflicts();
  const details=h.elements.find(item=>item.tagName==='details');assert.ok(details);assert.notEqual(details.open,true);assert.match(details.children.find(item=>item.tagName==='pre').textContent,/保留的完整数据/);h.api.destroy();
});
