/* Serial renderer-only acceptance. Exact production renderRichText/renderMessage,
 * real DOM, production StreamMarkdown/StreamCode and AgentProgress.patchLive.
 * Run: node_modules/.bin/electron tests/stream-code-smoke.cjs
 * No provider, user workspace, backend service or native-app claim. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.AIBRO_QA_OUTPUT || path.join(ROOT, 'test-results/stream-code-20260930/renderer');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-stream-code-'));
app.setPath('userData', path.join(TEMP, 'profile')); fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const parserStart = source.indexOf('function renderRichText('), messageStart = source.indexOf('\nfunction renderMessage(', parserStart), messageEnd = source.indexOf('\nfunction submitClarify(', messageStart);
assert.ok(parserStart >= 0 && messageStart > parserStart && messageEnd > messageStart, 'Locate actual production render functions');
const renderer = source.slice(parserStart, messageStart), renderMessageSource = source.slice(messageStart, messageEnd);
// renderMessage also calls this helper; inject the production function instead of a stub.
const dedupeStart = source.indexOf('\nfunction dedupeResultEntries('), dedupeEnd = source.indexOf('\n}\n', dedupeStart) + 3;
assert.ok(dedupeStart >= 0 && dedupeEnd > dedupeStart, 'Locate production dedupeResultEntries');
const dedupeSource = source.slice(dedupeStart, dedupeEnd);
const checks = [], failures = [], errors = [], externalRequests = [];
let win, server, origin, stopping = false;
const evaluate = value => win.webContents.executeJavaScript(typeof value === 'function' ? '(' + value.toString() + ')()' : value, true);
function report() {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ scope: 'Chromium renderer, not native WKWebView or whole application FPS/RSS', passed: checks.length, checks, failures, rendererErrors: errors, externalRequests, modelCalls: 0, userWorkspaceLoaded: false, parserSha256: sha(renderer), messageRendererSha256: sha(renderMessageSource), temporaryProfileRemoved: !fs.existsSync(TEMP) }, null, 2));
}
const watchdog = setTimeout(() => { failures.push({ name: 'watchdog', error: 'Timed out after 120 seconds' }); void finish(1); }, 120000);
app.on('window-all-closed', () => {});
app.on('quit', () => { fs.rmSync(TEMP, { recursive: true, force: true }); report(); });
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(watchdog);
  if (win && !win.isDestroyed()) { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(TEMP, { recursive: true, force: true }); report();
  console.log(JSON.stringify({ passed: checks.length, failures, rendererErrors: errors }, null, 2)); app.exit(code);
}
async function check(name, action) { try { const observation = await evaluate(action); checks.push({ name, observation }); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.stack || String(error) }); console.error('FAIL', name, error.message); } }
function initialize() {
  window.WorkstationI18n = { getLanguage: () => 'zh' };
  window.Core = window.WorkstationCore;
  window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.state = { settings: {}, notes: [{ id: 'n1', title: '合成来源一', content: 'First retained evidence', updatedAt: 1 }, { id: 'n2', title: '合成来源二', content: 'Second retained evidence', updatedAt: 1 }], imports: [], projects: [], agentRuns: [] };
  window.run = { id: 'synthetic-code-run', status: 'running' }; state.agentRuns = [run];
  window.currentConversation = () => ({ id: 'synthetic-conversation', messages: [window.message].filter(Boolean) });
  window.message = null; window.current = null;
  window.requireTrue = (value, text) => { if (!value) throw Error(text); };
  requireTrue(typeof StreamMarkdown.renderBody === 'function', 'Production StreamMarkdown.renderBody must be present');
  requireTrue(typeof StreamMarkdown.inspectBody === 'function', 'Production inspectBody must be present');
  const bodyRenderer = StreamMarkdown.renderBody, rawParser = window.renderRichText, rawHighlight = CodeHighlight.highlight;
  window.measuring = true;
  window.resetMetrics = () => { window.metrics = { parserCalls: 0, parserInputCharacters: 0, parsedCharacters: 0, highlightCalls: 0, highlightCharacters: 0, bodyHTMLWrites: 0, bodyHTMLCharacters: 0 }; };
  resetMetrics();
  window.renderRichText = function (...args) {
    if (measuring) { metrics.parserCalls++; metrics.parserInputCharacters += String(args[0] ?? '').length; }
    const html = rawParser(...args);
    if (measuring) metrics.parsedCharacters += Number.isFinite(args[2]?.parsedCharacters) ? args[2].parsedCharacters : String(args[0] ?? '').length;
    return html;
  };
  CodeHighlight.highlight = function (text, language) { if (measuring) { metrics.highlightCalls++; metrics.highlightCharacters += String(text ?? '').length; } return rawHighlight(text, language); };
  const htmlDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', { ...htmlDescriptor, set(value) {
    if (measuring && this.classList.contains('message-body')) { metrics.bodyHTMLWrites++; metrics.bodyHTMLCharacters += String(value).length; }
    return htmlDescriptor.set.call(this, value);
  } });
  window.useFast = value => { StreamMarkdown.renderBody = value ? bodyRenderer : undefined; };
  window.oracle = text => {
    const before = measuring; measuring = false;
    try { const host = document.createElement('div'); host.innerHTML = rawParser(text); CitationEvidence.decorate(host, message, run, state); return host; }
    finally { measuring = before; }
  };
  window.assertCode = text => {
    const actual = current.querySelector('.message-body .message-code code'), expected = oracle(text).querySelector('.message-code code');
    requireTrue(!!actual === !!expected, 'Code block presence differs from the full parser');
    if (expected) { requireTrue(actual.textContent === expected.textContent, 'Code text differs from the full parser'); requireTrue(actual.parentElement.getAttribute('data-language') === expected.parentElement.getAttribute('data-language'), 'Code language differs from the full parser'); }
    return actual;
  };
  window.install = (text, options = {}) => {
    if (message) StreamMarkdown.release(message);
    getSelection().removeAllRanges(); StreamMarkdown.clear();
    run.status = options.status || 'running';
    message = { id: 'synthetic-code-' + Math.random().toString(36).slice(2), role: 'agent', live: true, runId: run.id, text, ...options };
    const main = document.querySelector('main'); main.replaceChildren(); renderMessage(message, main); current = main.firstElementChild;
    return current;
  };
  window.prepare = (text, options = {}) => { Object.assign(message, options, { text }); const holder = document.createElement('div'); renderMessage(message, holder, { previous: current }); return holder.firstElementChild; };
  window.repaint = (text, options = {}) => { const next = prepare(text, options); AgentProgress.patchLive(current, next); current = document.querySelector('main > .message-wrap'); return current; };
  window.point = (host, offset) => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let text, last;
    while ((text = walker.nextNode())) { last = text; if (offset <= text.length) return [text, offset]; offset -= text.length; }
    if (last && !offset) return [last, last.length]; throw Error('Missing text offset');
  };
  window.selectOffsets = (host, start, end) => { const a = point(host, start), b = point(host, end); getSelection().setBaseAndExtent(a[0], a[1], b[0], b[1]); };
  window.selectionOffsets = host => {
    const selection = getSelection();
    const at = (node, offset) => { const range = document.createRange(); range.selectNodeContents(host); range.setEnd(node, offset); return range.toString().length; };
    return { anchor: at(selection.anchorNode, selection.anchorOffset), focus: at(selection.focusNode, selection.focusOffset), text: selection.toString(), collapsed: selection.isCollapsed };
  };
}
(async () => {
  await app.whenReady();
  const assets = ['workstation-core.js', 'stream-code.js', 'stream-markdown.js', 'code-highlight.js', 'citation-evidence.js', 'safe-preview.js', 'streaming-body.js', 'agent-progress.js'];
  const styles = ['app.css', 'safe-preview.css'].filter(file => fs.existsSync(path.join(ROOT, 'app', file)));
  for (const file of assets) assert.ok(fs.existsSync(path.join(ROOT, 'app', file)), 'Missing production asset: ' + file);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\'">'
    + styles.map(file => `<link rel="stylesheet" href="/${file}">`).join('') + '<style>body{display:block!important;overflow:auto!important;padding:20px}main{max-width:800px;margin:auto}.message-wrap{width:100%;max-width:none}.message-code{max-height:500px;overflow:auto}</style></head><body class="light-mode reduce-motion"><main></main>'
    + assets.map(file => `<script src="/${file}"></script>`).join('') + '</body></html>';
  const allowed = new Set([...assets, ...styles, 'halaska-geist.woff2', 'halaska-geist-mono.woff2']);
  server = http.createServer((request, response) => {
    const file = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    if (!file) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return; }
    if (!allowed.has(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/javascript' }); response.end(fs.readFileSync(path.join(ROOT, 'app', file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1020, height: 860, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { const external = !details.url.startsWith(origin + '/') && !details.url.startsWith('data:'); if (external) externalRequests.push(details.url); callback({ cancel: external }); });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/favicon/.test(event.message)) errors.push(event.message); });
  await win.loadURL(origin + '/'); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(renderer + '\n' + renderMessageSource + '\n' + dedupeSource + '\n(' + initialize.toString() + ')();');

  await check('info-line growth, CRLF boundaries, closer invalidation and non-append corrections match the real parser', () => {
    const phases = ['```j', '```js', '```js\r', '```js\r\n', '```js\r\nconst x = "中😀";\r', '```js\r\nconst x = "中😀";\r\n', '```js\r\nconst x = "中😀";\r\n``` ', '```js\r\nconst x = "中😀";\r\n``` x', '```js\r\nconst x = "中😀";\r\n``` x\r\nnext', '```js\r\nconst x = "中😀";\r\n``` x\r\nnext\r\n```\r\n', '```text\ncorrected <script>literal</script>\n```\n\nAfter'];
    install(phases[0]); assertCode(phases[0]);
    for (const text of phases.slice(1)) { repaint(text); assertCode(text); }
    requireTrue(!current.querySelector('script'), 'Source HTML became executable DOM');
    // An unchanged frame must preserve the pending CR state. The following LF
    // belongs to that same newline, even after multiple no-op render/commits.
    const repeatedCR = ['```js\na\r', '```js\na\r', '```js\na\r', '```js\na\r\n', '```js\na\r\nb'];
    install(repeatedCR[0]); assertCode(repeatedCR[0]);
    for (const text of repeatedCR.slice(1)) { repaint(text); assertCode(text); }
    return { phases: phases.length, repeatedCRFrames: repeatedCR.length, finalCode: assertCode(message.text).textContent, scope: 'same production parser oracle at every transition' };
  });

  await check('active code append retains body, code, both selection directions, focused stable link and old end caret', () => {
    const prefix = 'Stable [reference](https://example.com/reference).\n\n```text\n', content = '0123456789 selected phrase 中文😀\n';
    let directions = 0;
    for (const backward of [false, true]) {
      install(prefix + content); repaint(prefix + content + 'warming\n');
      const body = current.querySelector('.message-body'), code = body.querySelector('code'), link = body.querySelector('a');
      link.focus(); selectOffsets(code, backward ? 25 : 11, backward ? 11 : 25); const selected = getSelection().toString();
      for (let i = 1; i <= 12; i++) {
        const text = prefix + content + 'warming\n' + 'delta 中文😀\n'.repeat(i); repaint(text);
        requireTrue(current.querySelector('.message-body') === body && body.querySelector('code') === code, 'Active code/body was replaced');
        requireTrue(getSelection().toString() === selected && document.activeElement === link, 'Selected text or stable focus changed');
        const offsets = selectionOffsets(code); requireTrue((offsets.anchor > offsets.focus) === backward, 'Selection direction changed');
      }
      const oldEnd = code.textContent.length; selectOffsets(code, oldEnd, oldEnd); repaint(message.text + 'APPENDED');
      const caret = selectionOffsets(code); requireTrue(caret.collapsed && caret.anchor === oldEnd && caret.focus === oldEnd, 'An appended delta moved the original end caret'); directions++;
    }
    return { directions, deltasPerDirection: 12, bodyAndCodeRetained: true, oldEndCaretRetained: true };
  });

  await check('closing a code block preserves text selection through final syntax highlighting', () => {
    const source = 'Before.\n\n```javascript\nconst selected = "中文😀";\n/* multi\nline */\n';
    install(source); repaint(source + '// tail\n');
    const code = current.querySelector('.message-code code'); selectOffsets(code, 6, 14); const selected = getSelection().toString();
    repaint(message.text + '```\n\nAfter.'); const final = assertCode(message.text);
    requireTrue(getSelection().toString() === selected, 'Closing/highlighting lost code selection');
    requireTrue(final.querySelectorAll('span').length > 0, 'Recognized code was not highlighted after closing');
    return { selected, spans: final.querySelectorAll('span').length, sameVisibleCodeAsParser: true };
  });

  await check('citation chips keep identity and refresh privacy bindings while code takes the append path', () => {
    state.notes[0].private = false; run.evidenceSources = []; CitationEvidence.capture(run, { type: 'note', id: 'n1', excerpt: 'First retained evidence' }, state);
    const id = run.evidenceSources[0].sourceId, prefix = 'Claim [[cite:' + id + ']].\n\n```text\n';
    install(prefix + 'initial\n'); repaint(prefix + 'initial\nwarming\n');
    const body = current.querySelector('.message-body'), chip = body.querySelector('[data-citation-source]'); requireTrue(!!chip, 'Citation chip missing'); chip.focus();
    CitationEvidence.capture(run, { type: 'note', id: 'n2', excerpt: 'Second retained evidence' }, state); state.notes[0].private = true;
    for (let i = 1; i <= 8; i++) repaint(prefix + 'initial\nwarming\n' + 'line\n'.repeat(i));
    const target = CitationEvidence.resolveTarget(state, chip);
    requireTrue(current.querySelector('.message-body') === body && body.querySelector('[data-citation-source]') === chip && document.activeElement === chip, 'Citation node or focus lost');
    requireTrue(target?.source.private && target.source.excerpt === null && target.siblings.length === 2, 'Citation binding stayed stale or leaked a private excerpt');
    state.notes[0].private = false;
    return { chipAndFocusRetained: true, private: target.source.private, excerpt: target.source.excerpt, siblings: target.siblings.length };
  });

  await check('helper replacement and discarded prepared renders cannot commit stale active-code state', () => {
    const text = '```javascript\nconst first = 1;\n'; install(text); repaint(text + 'const second = 2;\n');
    const original = CodeHighlight.highlight; let helperCalls = 0;
    try {
      CodeHighlight.highlight = (code, language) => { helperCalls++; return original(code, language); };
      const beforeParserCharacters = metrics.parserInputCharacters;
      repaint(message.text + '// next\n');
      requireTrue(metrics.parserInputCharacters > beforeParserCharacters, 'Changed helper did not invalidate the prior rendering context');
      assertCode(message.text);
      const accepted = message.text, discarded = prepare(accepted + 'discarded candidate\n');
      requireTrue(!discarded.isConnected, 'Prepared candidate unexpectedly attached');
      repaint(accepted + 'actual committed suffix\n'); assertCode(message.text);
      requireTrue(!current.querySelector('.message-code code').textContent.includes('discarded candidate'), 'Dropped holder changed the active code revision');
      const candidate = prepare(message.text + '// prepared before helper replacement\n');
      const beforeCommitCharacters = metrics.parserInputCharacters;
      CodeHighlight.highlight = (code, language) => { helperCalls++; return original(code, language); };
      AgentProgress.patchLive(current, candidate); current = document.querySelector('main > .message-wrap');
      requireTrue(metrics.parserInputCharacters > beforeCommitCharacters, 'A prepared append committed after its helper dependency changed');
      assertCode(message.text);
      return { helperCalls, discardedHolderStayedDetached: true, finalContainsCommittedSuffix: true, helperChangedAfterPrepareReparsed: true };
    } finally { CodeHighlight.highlight = original; }
  });

  await check('same >= 2 MiB open fence avoids repeated full parsing and body HTML while preserving every character', () => {
    const prefix = '## Stable heading\n\nStable paragraph.\n\n```text\n', size = 2 * 1024 * 1024 + 127;
    const unit = 'abcdefghijklmnopqrstuvwxyz 0123456789 中文😀 <literal> & unchanged\n';
    const content = unit.repeat(Math.ceil(size / unit.length)).slice(0, size), frames = [];
    for (let end = 65536; end < content.length; end += 65536) frames.push(prefix + content.slice(0, end)); frames.push(prefix + content);
    function measure(fast) {
      useFast(fast); install(prefix + ''); resetMetrics(); let retained = 0, body = current.querySelector('.message-body'), code = body.querySelector('.message-code code');
      const started = performance.now();
      for (const text of frames) { repaint(text); const currentBody = current.querySelector('.message-body'), currentCode = currentBody.querySelector('.message-code code'); if (currentBody === body && currentCode === code) retained++; body = currentBody; code = currentCode; }
      const elapsedMs = performance.now() - started, stats = { ...metrics }, activity = StreamMarkdown.inspectBody(body);
      const expected = assertCode(frames.at(-1)); requireTrue(expected.textContent.length >= 2 * 1024 * 1024, 'Large content was shortened');
      const result = { elapsedMs, ...stats, retainedFrames: retained, codeTextCharacters: expected.textContent.length, bodyDOMNodes: body.querySelectorAll('*').length, textNodes: expected.childNodes.length, activity };
      getSelection().removeAllRanges(); return result;
    }
    const baseline = measure(false), incremental = measure(true); useFast(true);
    requireTrue(baseline.codeTextCharacters === incremental.codeTextCharacters, 'Compared pipelines produced different text');
    requireTrue(incremental.parserInputCharacters < baseline.parserInputCharacters / 3, 'Append path still repeatedly invokes the full parser');
    requireTrue(incremental.bodyHTMLWrites < baseline.bodyHTMLWrites / 3, 'Append path still recreates full body innerHTML');
    requireTrue(incremental.highlightCharacters < baseline.highlightCharacters / 3, 'Active code still repeatedly sends whole content to the highlighter');
    requireTrue(incremental.bodyDOMNodes < 100, 'Large plain-text code unexpectedly inflated into many elements');
    return { frames: frames.length, rawCharacters: frames.at(-1).length, baseline, incremental, scope: 'real renderMessage + parser/highlight + patch, synthetic Chromium; elapsed is observational, assertions use work counts and exact text' };
  });

  await check('cancelled and completed large replies release the active path and preserve full text behind SafePreview', () => {
    const prefix = '```text\n', content = 'retained source 中文😀 <literal>\n'.repeat(1200), text = prefix + content;
    const results = [];
    for (const status of ['cancelled', 'completed']) {
      install(text); repaint(text + 'FINAL_TAIL'); const full = message.text; getSelection().removeAllRanges(); run.status = status;
      repaint(full, { live: false, runStatus: status });
      const previewBody = current.querySelector('.message-body'); requireTrue(!!previewBody.querySelector('[data-safe-preview]'), 'Settled large reply did not enter SafePreview');
      requireTrue(!StreamMarkdown.inspectBody(previewBody)?.active, 'Terminal reply retained an active code writer');
      previewBody.querySelector('[data-preview-action="expand"]').click(); assertCode(full);
      requireTrue(previewBody.querySelector('.message-code code').textContent.includes('FINAL_TAIL'), 'Expanded terminal reply lost its tail');
      previewBody.querySelector('[data-preview-action="restore"]').click(); requireTrue(!!previewBody.querySelector('[data-safe-preview]'), 'Restore acted on a stale SafePreview host');
      results.push({ status, fullCharacters: full.length, previewRestored: true, tailPresentWhenExpanded: true });
    }
    return results;
  });

  await check('terminal large code preserves both selection directions and focused link, then returns to SafePreview after interaction ends', () => {
    const prefix = 'Stable [reference](https://example.com/reference).\n\n```javascript\n';
    const content = 'const selected = "中文😀";\n' + '// retained source 中文😀 <literal>\n'.repeat(600);
    const results = [];
    for (const status of ['cancelled', 'completed']) for (const backward of [false, true]) {
      install(prefix + content); repaint(message.text + '// FINAL_TAIL\n');
      const body = current.querySelector('.message-body'), link = body.querySelector('a'), code = body.querySelector('.message-code code');
      requireTrue(message.text.length > 12000, 'Terminal selection fixture must cross SafePreview threshold');
      link.focus(); selectOffsets(code, backward ? 14 : 6, backward ? 6 : 14);
      const selected = getSelection().toString(); run.status = status;
      const full = message.text + (status === 'completed' ? '```\n\nFinal summary.' : '');
      repaint(full, { live: false, runStatus: status });
      const finalBody = current.querySelector('.message-body'), finalCode = assertCode(full), selection = selectionOffsets(finalCode);
      requireTrue(!finalBody.querySelector('[data-safe-preview]'), 'Terminal preview replaced a body being read or selected');
      requireTrue(finalBody.textContent === oracle(full).textContent, 'Preserved terminal body is not the full canonical render');
      requireTrue(!StreamMarkdown.inspectBody(finalBody)?.active, 'Terminal body kept an active stream continuation');
      requireTrue(getSelection().toString() === selected && (selection.anchor > selection.focus) === backward, 'Terminal canonical render lost selection text or direction');
      requireTrue(document.activeElement === link && finalBody.querySelector('a') === link, 'Terminal canonical render lost the focused stable link');
      requireTrue(finalCode.querySelectorAll('span').length > 0, 'Terminal JavaScript still has provisional plain code');
      getSelection().removeAllRanges(); link.blur(); repaint(full);
      const previewBody = current.querySelector('.message-body');
      requireTrue(!!previewBody.querySelector('[data-safe-preview]'), 'A later unselected render did not restore SafePreview');
      previewBody.querySelector('[data-preview-action="expand"]').click(); assertCode(full);
      requireTrue(previewBody.querySelector('.message-code code').textContent.includes('FINAL_TAIL'), 'Restored preview expansion lost terminal content');
      previewBody.querySelector('[data-preview-action="restore"]').click();
      requireTrue(!!previewBody.querySelector('[data-safe-preview]'), 'Selection-to-preview transition left stale restore handlers');
      results.push({ status, backward, fullCharacters: full.length, selected, fullCanonicalWhileInteracting: true, previewAfterBlur: true });
    }
    return results;
  });
  assert.equal(externalRequests.length, 0, 'No external network allowed'); assert.equal(errors.length, 0, 'No renderer errors');
  await finish(failures.length ? 1 : 0);
})().catch(error => { failures.push({ name: 'setup or teardown', error: error.stack || String(error) }); void finish(1); });
