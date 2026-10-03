'use strict';
// Execute the production host functions. The PDF renderer is an owned mount
// boundary; file cache, access, navigation and download behavior remain real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CitationEvidence = require('../app/citation-evidence.js');
const AttachmentAnalysis = require('../app/attachment-analysis.js');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
function cut(start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `Missing production boundary: ${start}`);
  return source.slice(begin, finish);
}
const code = [
  cut('let fileDbPromise;', 'async function fileStoreDelete('),
  cut('function dataUrlToBlob(', '// The desktop shell and the browser prototype'),
  cut('let pdfPreviewVersion = 0;', 'function beforePreviewLeave('),
  cut('function previewItem(', 'function captureDocumentOrigin('),
  cut('async function openPreview(', 'function exportNoteMarkdown('),
].join('\n');
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const dataUrl = value => `data:application/pdf;base64,${Buffer.from(value).toString('base64')}`;
function fixture(options = {}) {
  const nodes = new Map(), calls = [], reads = [], mounts = [], objectURLs = [], revoked = [], requests = [];
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.attributes = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.children = []; this.textContent = ''; this.html = ''; this.open = false; this.onclick = null; this.classList = { toggle() {} }; }
    get innerHTML() { return this.html; } set innerHTML(value) { this.html = value; this.children = []; this.anchor = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    get href() { return this.getAttribute('href') || ''; } set href(value) { this.setAttribute('href', value); }
    get download() { return this.getAttribute('download') || ''; } set download(value) { this.setAttribute('download', value); }
    append(...children) { this.children.push(...children); } replaceChildren(...children) { this.html = ''; this.children = [...children]; }
    querySelector(selector) { return selector === 'summary' ? this.summary ||= new Node('summary') : selector === 'a' && /<a\s/.test(this.html) ? this.anchor ||= new Node('a') : null; }
    before() {} after() {} close() { this.open = false; }
  }
  for (const id of ['previewDialog', 'previewEyebrow', 'previewTitle', 'previewMeta', 'previewContent', 'previewExtracted', 'previewAnalysisStatus', 'previewOrganize', 'previewBack', 'previewDownload', 'editPreviewNote', 'previewDelete', 'previewVisual', 'previewSourceLinks', 'previewProvenance', 'taskDialog', 'paperDialog', 'readingPane']) nodes.set('#' + id, new Node(id === 'previewDownload' ? 'a' : 'div'));
  const item = { id: 'pdf', name: '课件.pdf', mimeType: 'application/pdf', content: 'Saved extracted text', ...options.item };
  const state = { imports: [item], notes: [], projects: [], papers: [], conversations: [], agentRuns: [], trash: [], ui: {} };
  let active = null, privateMode = false, localUnmount = true, openedDb, dbOpens = 0;
  const database = { transaction(name, mode) { assert.equal(name, 'blobs'); assert.equal(mode, 'readonly'); calls.push('idb-transaction'); return { objectStore(store) { assert.equal(store, 'blobs'); return { get(id) { const request = { result: undefined }; reads.push({ id, request }); if (!options.deferRead) queueMicrotask(() => { request.result = options.localBlob || null; request.onsuccess(); }); return request; } }; } }; } };
  const reading = {
    beforeNavigate: () => options.beforeNavigate ? options.beforeNavigate() : true,
    bookmark: () => null,
    snapshot: () => ({ tabs: [], expanded: false }),
    present(kind, id, page) { active = { kind, id }; calls.push(['present', kind, id, page]); },
    isActive: (kind, id) => active?.kind === kind && active?.id === id,
    setPage: (...args) => calls.push(['page', ...args]),
    reconcile() {},
  };
  const context = {
    state, Blob, AbortController, TextEncoder, Uint8Array, atob: value => Buffer.from(value, 'base64').toString('binary'),
    sourcePreviewGuards: new Map(), previewObjectUrl: null, CitationEvidence, AttachmentAnalysis,
    document: { body: { dataset: { view: 'agent' } }, createElement: tag => new Node(tag) },
    $: selector => nodes.get(selector) || null,
    URL: { createObjectURL(blob) { objectURLs.push(blob); return 'blob:test-' + objectURLs.length; }, revokeObjectURL(url) { revoked.push(url); } },
    fetch: async (url, init) => { requests.push({ url, init }); if (options.fetch) return options.fetch(url, init); return { ok: true, blob: async () => new Blob(['server original'], { type: 'application/octet-stream' }) }; },
    indexedDB: { open(name, version) { assert.equal(name, 'ai-workstation-files'); assert.equal(version, 1); dbOpens++; openedDb = { result: database }; if (!options.deferDb) queueMicrotask(() => openedDb.onsuccess()); return openedDb; } },
    ReadingPane: reading,
    PDFReader: { mount(container, configuration) { const handle = { ready: options.ready?.promise || Promise.resolve(true), destroy() { handle.destroyed = true; }, refresh() {} }; mounts.push({ container, configuration, handle }); return handle; } },
    ProjectFiles: { unmount: () => localUnmount, markSelected() {} },
    PrivateMode: { isOn: () => privateMode },
    captureDocumentOrigin: () => undefined,
    previewSourceAvailable: value => CitationEvidence.access(state, value).available,
    renderPreviewAnalysis() {}, showView() {}, esc: value => String(value ?? ''),
    visibleProject: value => !!value && !value.deleted && !value.archived,
    visibleImport: value => !!value && !value.deleted && !value.archived,
    visibleNote: value => !!value && !value.deleted && !value.archived,
    toast: message => calls.push(['toast', message]),
    PreviewMedia: { mount(container) { container.innerHTML = 'Other attachment preview'; return true; } },
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(code, context, { filename: 'app.js:pdf-original-host-production' });
  return { context, state, item, nodes, calls, reads, mounts, objectURLs, revoked, requests,
    dbOpens: () => dbOpens,
    resolveDb: () => openedDb.onsuccess(),
    resolveRead(value, index = reads.length - 1) { reads[index].request.result = value; reads[index].request.onsuccess(); },
    failRead(index = reads.length - 1) { reads[index].request.onerror(); },
    open: (...args) => context.openPreview('import', item.id, ...args),
    download: () => nodes.get('#previewDownload'),
    switchReader: (kind = 'import', id = 'other') => { active = { kind, id }; },
    privateMode: value => { privateMode = value; },
    refuseUnmount: () => { localUnmount = false; },
    bumpVersion: () => vm.runInContext('++pdfPreviewVersion', context),
  };
}

test('known PDF MIME and extension-only PDFs mount pages without IndexedDB, full-file GET or Blob URL', async () => {
  for (const item of [{ mimeType: 'application/pdf', name: 'renamed' }, { mimeType: '', name: '课件.PDF' }, { mimeType: '', name: '', originalName: 'original.pdf' }]) {
    const h = fixture({ item }); await h.open(7);
    assert.equal(h.mounts.length, 1); assert.equal(h.mounts[0].configuration.originalBlob, null); assert.equal(h.mounts[0].configuration.requestedPage, 7);
    assert.equal(h.dbOpens(), 0); assert.equal(h.reads.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.objectURLs.length, 0);
    assert.equal(h.download().href, '/__files/pdf'); assert.equal(h.download().download, item.name || item.originalName); assert.equal(h.download().hidden, false);
    assert.equal(h.nodes.get('#previewExtracted').open, false);
  }
});

test('PDF download is a same-origin native download while page metadata remains pending', async () => {
  const ready = defer(), h = fixture({ ready, item: { id: 'pdf space', name: '课件.pdf' } }), opening = h.open(); await settle();
  assert.equal(h.download().href, '/__files/pdf%20space'); assert.equal(h.download().getAttribute('download'), '课件.pdf'); assert.equal(h.mounts.length, 1);
  const event = { preventDefault() { this.prevented = true; } }; h.download().onclick(event); assert.equal(event.prevented, undefined);
  assert.equal(h.requests.length, 0); ready.resolve(true); await opening;
});

test('non-PDF imports retain the full-original loading path used by other attachments', async () => {
  const h = fixture({ item: { mimeType: 'text/plain', name: 'source.txt' } }); await h.open();
  assert.equal(h.dbOpens(), 1); assert.equal(h.reads.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/__files/pdf');
  assert.equal(h.requests[0].init.signal instanceof AbortSignal, true); assert.equal(h.objectURLs.length, 1); assert.equal(h.mounts.length, 0); assert.match(h.download().href, /^blob:/);
});

const bookmark = { id: 'bookmark', name: 'Campus reference', mimeType: 'text/html', parser: 'bookmark', url: 'https://example.org/campus', fileStored: false, content: '', pages: [] };
test('production reader opens a real bookmark without probing nonexistent originals or claiming saved body', async () => {
  for (const name of ['Campus reference', 'Reading.pdf']) {
    const h = fixture({ item: { ...bookmark, name } }); await h.open();
    assert.equal(h.dbOpens(), 0); assert.equal(h.requests.length, 0); assert.equal(h.mounts.length, 0); assert.equal(h.objectURLs.length, 0);
    assert.equal(h.nodes.get('#previewExtracted').hidden, true); assert.equal(h.nodes.get('#previewContent').textContent, '');
    assert.equal(h.download().hidden, true); assert.equal(h.download().href, '');
    const visual = h.nodes.get('#previewVisual'); assert.match(visual.innerHTML, /网址已收藏，网页内容尚未下载/); assert.match(visual.innerHTML, /href="https:\/\/example.org\/campus"/); assert.match(visual.innerHTML, /打开原网页/); assert.doesNotMatch(visual.innerHTML, /已保存网页正文/);
    const event = { preventDefault() { this.prevented = true; } }; visual.querySelector('a').onclick(event); assert.equal(event.prevented, undefined);
  }
});

test('bookmark original link rechecks access, URL identity and current reader before native navigation', async () => {
  for (const change of ['deleted', 'private', 'private-project', 'reader', 'url']) {
    const h = fixture({ item: { ...bookmark } }); if (change === 'private-project') { h.state.projects.push({ id: 'p' }); h.item.projectId = 'p'; }
    await h.open(); const click = h.nodes.get('#previewVisual').querySelector('a').onclick;
    if (change === 'deleted') h.item.deleted = true; if (change === 'private') h.item.private = true; if (change === 'private-project') h.state.projects[0].private = true;
    if (change === 'reader') h.switchReader(); if (change === 'url') h.item.url = 'https://example.org/replaced';
    const event = { preventDefault() { this.prevented = true; } }; click(event); assert.equal(event.prevented, true, change);
  }
});

test('unsafe or credential-bearing bookmark URLs have no original webpage action', async () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'https://user:secret@example.org', '']) {
    const h = fixture({ item: { ...bookmark, url } }); await h.open();
    assert.doesNotMatch(h.nodes.get('#previewVisual').innerHTML, /<a\s/); assert.match(h.nodes.get('#previewVisual').innerHTML, /原网页地址无效/); assert.equal(h.requests.length, 0);
  }
});

test('already fetched webpage body remains readable and can follow a bookmark in the same host', async () => {
  const h = fixture({ item: { ...bookmark }, fetch: async () => ({ ok: false, status: 404 }) });
  h.context.PreviewMedia.mount = () => false;
  await h.open(); assert.equal(h.nodes.get('#previewExtracted').hidden, true);
  Object.assign(h.item, { parser: 'html', content: 'Downloaded source body with evidence.', pages: [{ page: 1, text: 'Downloaded source body with evidence.' }] });
  await h.open();
  assert.equal(h.nodes.get('#previewExtracted').hidden, false); assert.match(h.nodes.get('#previewContent').textContent, /Downloaded source body/);
  assert.match(h.nodes.get('#previewVisual').innerHTML, /已保存网页正文/); assert.doesNotMatch(h.nodes.get('#previewVisual').innerHTML, /尚未下载网页/);
  assert.equal(h.requests.length, 1); assert.equal(AttachmentAnalysis.derive(h.state, h.item).status, 'pending');
});

test('fileStoreGet localOnly returns IndexedDB originals and never fetches a cache miss or cache error', async () => {
  const local = new Blob(['local'], { type: 'application/pdf' }), found = fixture({ localBlob: local }); assert.equal(await found.context.fileStoreGet('pdf', { localOnly: true }), local); assert.equal(found.requests.length, 0);
  const absent = fixture(); assert.equal(await absent.context.fileStoreGet('pdf', { localOnly: true }), null); assert.equal(absent.requests.length, 0);
  const failed = fixture({ deferRead: true }), pending = failed.context.fileStoreGet('pdf', { localOnly: true }); await settle(); failed.failRead(); assert.equal(await pending, null); assert.equal(failed.requests.length, 0);
});

test('default fileStoreGet still reads local first and falls back to the same-origin complete original', async () => {
  const local = new Blob(['local']), found = fixture({ localBlob: local }); assert.equal(await found.context.fileStoreGet('pdf'), local); assert.equal(found.requests.length, 0);
  const absent = fixture(), blob = await absent.context.fileStoreGet('id / 字'); assert.equal(await blob.text(), 'server original'); assert.equal(absent.requests[0].url, '/__files/id%20%2F%20%E5%AD%97'); assert.equal(absent.requests[0].init.cache, 'no-store');
  const offline = fixture({ fetch: async () => { throw Error('offline'); } }); assert.equal(await offline.context.fileStoreGet('pdf'), null);
});

test('abort before or during database open prevents even the cache transaction', async () => {
  const first = fixture(), already = new AbortController(); already.abort(); await assert.rejects(first.context.fileStoreGet('pdf', { signal: already.signal }), { name: 'AbortError' }); assert.equal(first.dbOpens(), 0);
  const h = fixture({ deferDb: true }), abort = new AbortController(), pending = h.context.fileStoreGet('pdf', { signal: abort.signal }); abort.abort(); h.resolveDb();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.reads.length, 0); assert.equal(h.requests.length, 0);
});

test('an IndexedDB result arriving after cancellation is discarded, with no network fallback', async () => {
  for (const localOnly of [false, true]) {
    const h = fixture({ deferRead: true }), abort = new AbortController(), pending = h.context.fileStoreGet('pdf', { localOnly, signal: abort.signal }); await settle(); abort.abort(); h.resolveRead(new Blob(['late secret']));
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.requests.length, 0);
  }
});

test('network and response-body cancellation propagate AbortError instead of returning a late whole-file blob', async () => {
  const fetchGate = defer(), h = fixture({ fetch: () => fetchGate.promise }), abort = new AbortController(), pending = h.context.fileStoreGet('pdf', { signal: abort.signal }); await settle();
  assert.equal(h.requests[0].init.signal, abort.signal); abort.abort(); fetchGate.reject(Object.assign(Error('aborted'), { name: 'AbortError' })); await assert.rejects(pending, { name: 'AbortError' });
  const body = defer(), late = fixture({ fetch: async () => ({ ok: true, blob: () => body.promise }) }), controller = new AbortController(), reading = late.context.fileStoreGet('pdf', { signal: controller.signal }); await settle(); controller.abort(); body.resolve(new Blob(['late full PDF'])); await assert.rejects(reading, { name: 'AbortError' });
});

test('404 restoration getter is lazy and reads local IndexedDB only', async () => {
  const local = new Blob(['local original'], { type: 'application/pdf' }), h = fixture({ localBlob: local }); await h.open(); assert.equal(h.dbOpens(), 0);
  const getter = h.mounts[0].configuration.getOriginalBlob; assert.equal(await getter({ signal: new AbortController().signal }), local); assert.equal(h.dbOpens(), 1); assert.equal(h.requests.length, 0);
});

test('404 legacy dataURL recovery uses the latest authorized record after the cache await', async () => {
  const h = fixture({ deferRead: true, item: { dataUrl: dataUrl('old legacy original') } }); await h.open();
  const pending = h.mounts[0].configuration.getOriginalBlob({ signal: new AbortController().signal }); await settle(); h.state.imports[0] = { ...h.item, dataUrl: dataUrl('current legacy original') }; h.resolveRead(null);
  const result = await pending; assert.equal(result.type, 'application/pdf'); assert.equal(await result.text(), 'current legacy original'); assert.equal(h.requests.length, 0);
});

test('404 fallback is discarded after document switch, reader version change, deletion or privacy revocation', async () => {
  for (const change of ['reader', 'version', 'deleted', 'private', 'private-project', 'source-private-mode']) {
    const h = fixture({ deferRead: true, item: { dataUrl: dataUrl('must not escape') } });
    if (change === 'private-project') { h.state.projects.push({ id: 'p' }); h.item.projectId = 'p'; }
    if (change === 'source-private-mode') h.context.sourcePreviewGuards.set(JSON.stringify(['import', h.item.id]), { type: 'import', id: h.item.id });
    await h.open(); const pending = h.mounts[0].configuration.getOriginalBlob({ signal: new AbortController().signal }); await settle();
    if (change === 'reader') h.switchReader(); if (change === 'version') h.bumpVersion(); if (change === 'deleted') h.item.deleted = true; if (change === 'private') h.item.private = true; if (change === 'private-project') h.state.projects[0].private = true; if (change === 'source-private-mode') h.privateMode(true);
    h.resolveRead(new Blob(['cached old private bytes'])); assert.equal(await pending, null, change); assert.equal(h.requests.length, 0, change);
  }
});

test('revoked or aborted lazy getters do not open the cache; abort during cache wait does not decode legacy data', async () => {
  const h = fixture({ item: { dataUrl: dataUrl('legacy') } }); await h.open(); const getter = h.mounts[0].configuration.getOriginalBlob; h.item.private = true;
  assert.equal(await getter({ signal: new AbortController().signal }), null); assert.equal(h.dbOpens(), 0);
  h.item.private = false; const abort = new AbortController(); abort.abort(); assert.equal(await getter({ signal: abort.signal }), null); assert.equal(h.dbOpens(), 0);
  const late = fixture({ deferRead: true, item: { dataUrl: dataUrl('legacy') } }); await late.open(); const controller = new AbortController(), pending = late.mounts[0].configuration.getOriginalBlob({ signal: controller.signal }); await settle(); controller.abort(); late.resolveRead(null); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(late.requests.length, 0);
});

test('PDF original availability updates only its still-current reader', async () => {
  const h = fixture(); await h.open(); const configuration = h.mounts[0].configuration; configuration.onOriginalAvailability(false); assert.equal(h.download().hidden, true); assert.equal(h.nodes.get('#previewExtracted').open, true);
  configuration.onOriginalAvailability(true); assert.equal(h.download().hidden, false); h.switchReader(); configuration.onOriginalAvailability(false); assert.equal(h.download().hidden, false); assert.equal(configuration.onValid(), false);
});

test('download clicks from a no-longer-current or inaccessible PDF are prevented', async () => {
  for (const change of ['reader', 'new-open', 'deleted', 'private']) {
    const h = fixture(); await h.open(); const click = h.download().onclick;
    if (change === 'reader') h.switchReader(); if (change === 'new-open') { h.state.imports.push({ id: 'second', name: 'second.pdf' }); await h.context.openPreview('import', 'second'); } if (change === 'deleted') h.item.deleted = true; if (change === 'private') h.item.private = true;
    const event = { preventDefault() { this.prevented = true; } }; click(event); assert.equal(event.prevented, true, change);
  }
});

test('suspending a PDF destroys its reader and clears native download callbacks and attributes', async () => {
  const h = fixture(); await h.open(); const mounted = h.mounts[0]; assert.equal(h.context.suspendPreview(), true);
  assert.equal(mounted.handle.destroyed, true); assert.equal(h.download().hidden, true); assert.equal(h.download().onclick, null); assert.equal(h.download().getAttribute('href'), null); assert.equal(h.download().getAttribute('download'), null); assert.equal(h.context.state.previewRecord, null);
  assert.equal(await mounted.configuration.getOriginalBlob({ signal: new AbortController().signal }), null); assert.equal(h.dbOpens(), 0);
});

test('a refused editor unmount preserves the current PDF download instead of partially closing it', async () => {
  const h = fixture(); await h.open(); const click = h.download().onclick, href = h.download().href; h.refuseUnmount(); assert.equal(h.context.suspendPreview(), false); assert.equal(h.download().onclick, click); assert.equal(h.download().href, href); assert.notEqual(h.mounts[0].handle.destroyed, true);
});

test('legacy originals stay downloadable if restoration fails and temporary URLs are released after restore or close', async () => {
  for (const finish of ['restore', 'close']) {
    const h = fixture(); await h.open(); const configuration = h.mounts[0].configuration;
    configuration.onOriginalAvailability(false);
    const original = new Blob(['legacy PDF'], { type: 'application/pdf' });
    configuration.onOriginalAvailability(true, original);
    assert.equal(h.download().hidden, false); assert.match(h.download().href, /^blob:/); assert.equal(h.objectURLs.length, 1);
    if (finish === 'restore') { configuration.onOriginalAvailability(true); assert.equal(h.download().href, '/__files/pdf'); }
    else { h.context.suspendPreview(); assert.equal(h.download().hidden, true); }
    assert.equal(h.revoked.length, 1);
  }
});

test('missing PDF expands both saved-text containers instead of leaving the fallback behind collapsed metadata', async () => {
  const h = fixture(), metadata = { open: false }; h.nodes.set('.reader-document-details', metadata);
  h.download().setAttribute('title', 'stale editable-document export tooltip'); await h.open();
  assert.equal(h.download().getAttribute('title'), null);
  h.mounts[0].configuration.onOriginalAvailability(false);
  assert.equal(metadata.open, true); assert.equal(h.nodes.get('#previewExtracted').open, true);
});
