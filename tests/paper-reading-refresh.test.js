const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AttachmentAnalysis = require('../attachment-analysis');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function harness() {
  const elements = new Map();
  function element(id) {
    const node = { id, hidden: false, open: false, innerHTML: '', textContent: '', style: {}, attributes: {}, classList: { toggle() {} },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; },
      hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
      removeAttribute(key) { delete this.attributes[key]; delete this[key]; }, close() { this.open = false; }, replaceChildren() { this.innerHTML = ''; },
      querySelector() { return this.summary ||= { hidden: false, textContent: '' }; } };
    elements.set(`#${id}`, node); return node;
  }
  for (const id of ['readingPane', 'previewDialog', 'taskDialog', 'paperDialog', 'previewEyebrow', 'previewTitle', 'previewMeta',
    'previewAnalysisStatus', 'previewContent', 'previewExtracted', 'editPreviewNote', 'previewRelations', 'previewRelatedSources', 'previewVisual',
    'previewDownload', 'previewBack', 'previewOrganize', 'paperReviewed']) element(id);
  const $ = selector => elements.get(selector) || null;
  const state = { ui: { openPaperId: 'paper' }, projects: [], imports: [],
    papers: [{ id: 'paper', noteId: 'analysis', structured: { tldr: '旧分析' } }],
    notes: [{ id: 'analysis', paperId: 'paper', title: '论文分析', content: '旧分析' }, { id: 'other', title: '其他笔记', content: '其他内容' }] };
  const fields = [{ dataset: { paperField: 'tldr' }, value: '保存后的新分析' }];
  const blobs = new Map(), revoked = [], presents = [], calls = [];
  let active = null, visible = false, serial = 0;
  const reader = {
    isActive: (kind, id) => visible && active?.kind === kind && active?.id === id,
    present(kind, id) { active = { kind, id }; visible = true; $('#readingPane').hidden = false; $('#previewDialog').open = true; presents.push({ kind, id }); },
    reconcile() {},
  };
  const context = vm.createContext({NoteMarkdown:require('../note-markdown'), state, $, $$: () => fields, window: { ReadingPane: reader, AttachmentAnalysis }, AttachmentAnalysis, Blob,
    URL: { createObjectURL(blob) { const url = `blob:test-${++serial}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    Research: { sectionText: value => value || '', paperMarkdown: paper => `# 分析\n\n${paper.structured.tldr}` },
    previewObjectUrl: null, pdfPreviewVersion: 0, pdfPreviewAbort: null,
    esc: String, uiIcon: () => '', renderRichText: content => `<article>${content}</article>`,
    visibleProject: () => true, visibleImport: () => true, visibleNote: () => true,
    save: () => calls.push('save'), renderAll: () => calls.push('render'), toast: () => calls.push('toast'),
  });
  vm.runInContext(source.slice(source.indexOf('function importAnalysis('), source.indexOf('function entityImport(')) + source.slice(source.indexOf('function renderPreviewAnalysis('), source.indexOf('// Stage a focused analysis request')), context);
  vm.runInContext(source.slice(source.indexOf('let previewRequestVersion ='), source.indexOf('\nconst searchTypeLabel =')), context);
  vm.runInContext(source.slice(source.indexOf('function savePaperEdits()'), source.indexOf('\nfunction analyzePaper(')), context);
  return { state, $, context, blobs, revoked, presents, calls,
    hide() { visible = false; $('#readingPane').hidden = true; $('#previewDialog').open = false; context.suspendPreview(); },
  };
}

test('saving the active paper note refreshes real reader body and Markdown download, revoking the old URL', async () => {
  const h = harness();
  await h.context.openNote('analysis');
  assert.equal(h.$('#previewEyebrow').getAttribute('data-i18n'), '');
  assert.equal(h.$('#previewTitle').hasAttribute('data-i18n'), false);
  const oldUrl = h.$('#previewDownload').href;
  h.$('#paperDialog').open = true; h.$('#paperReviewed').checked = true;
  h.context.savePaperEdits();
  assert.equal(h.state.notes[0].content, '# 分析\n\n保存后的新分析');
  assert.match(h.$('#previewContent').innerHTML, /保存后的新分析/);
  assert.equal(h.$('#paperDialog').open, false);
  assert.equal(h.$('#previewDialog').open, true);
  assert.equal(h.$('#previewDownload').hidden, false);
  const newUrl = h.$('#previewDownload').href;
  assert.notEqual(newUrl, oldUrl);
  assert.deepEqual(h.revoked, [oldUrl]);
  assert.match(await h.blobs.get(newUrl).text(), /保存后的新分析/);
  assert.doesNotMatch(await h.blobs.get(newUrl).text(), /旧分析/);
  assert.deepEqual(h.calls, ['save', 'render', 'toast']);
});

test('saving another paper does not replace the active note or its download', async () => {
  const h = harness(); await h.context.openNote('other');
  const url = h.$('#previewDownload').href;
  h.$('#paperDialog').open = true; h.context.savePaperEdits();
  assert.match(h.state.notes[0].content, /保存后的新分析/);
  assert.equal(h.$('#previewTitle').textContent, '其他笔记');
  assert.equal(h.$('#previewContent').innerHTML, '<article>其他内容</article>');
  assert.equal(h.$('#previewDownload').href, url);
  assert.equal(h.$('#paperDialog').open, true);
  assert.equal(h.presents.length, 1);
  assert.deepEqual(h.revoked, []);
});

test('saving a paper whose note tab is hidden does not reopen the reader', async () => {
  const h = harness(); await h.context.openNote('analysis'); h.hide();
  h.$('#paperDialog').open = true; h.context.savePaperEdits();
  assert.match(h.state.notes[0].content, /保存后的新分析/);
  assert.equal(h.$('#previewDialog').open, false);
  assert.equal(h.$('#readingPane').hidden, true);
  assert.equal(h.$('#previewDownload').hidden, true);
  assert.equal(h.$('#previewDownload').href, undefined);
  assert.equal(h.$('#paperDialog').open, true);
  assert.equal(h.presents.length, 1);
});
