#!/usr/bin/env node
// Extract the hard-coded tool tables and tool protocol text from a git revision
// that predates the tool registry, so equivalence tests compare the registry's
// generated output with what the old code literally contained.
// Usage: node scripts/extract-tool-legacy.cjs <rev> > tests/fixtures/tool-registry-legacy.json
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const rev = process.argv[2];
if (!rev) { console.error('usage: extract-tool-legacy.cjs <rev>'); process.exit(2); }
const root = path.resolve(__dirname, '..');
const show = file => execFileSync('/usr/bin/git', ['-C', root, 'show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
const literal = source => Function(`"use strict";return (${source});`)();
const need = (text, re, what) => { const m = text.match(re); if (!m) throw Error('not found: ' + what); return m; };

const scheduler = show('app/tool-scheduler.js');
const knowledge = show('app/knowledge-access.js');
const context = show('app/agent-context.js');
const app = show('app/app.js');

const reads = literal(need(scheduler, /const reads=new Set\((\[[^\]]*\])\)/, 'reads')[1]);
const viewOnly = literal(need(scheduler, /const viewOnly=new Set\((\[[^\]]*\])\)/, 'viewOnly')[1]);
const labels = literal(need(scheduler, /const label=type=>\((\{[^}]*\})\)\[type\]/, 'label')[1]);
const agendaMatch = need(scheduler, /const allowed=request\.type==='agenda_list'\?(\[[^\]]*\]):(\[[^\]]*\]);/, 'agenda fields');
const agendaFields = [literal(agendaMatch[1]), literal(agendaMatch[2])];
const quickPanelFields = literal(need(scheduler, /Object\.keys\(request\)\.some\(key=>!(\['type','section','recordType','recordId'\])\.includes\(key\)\)/, 'quick panel fields')[1]);
const genericFields = literal(need(scheduler, /const out=\{\};for\(const key of (\[[^\]]*\])\)/, 'generic fields')[1]);
const chunkableReads = literal(need(knowledge, /const chunkableReads=new Set\((\[[^\]]*\])\)/, 'chunkableReads')[1]);
const batchLimit = Number(need(knowledge, /const batchLimit=(\d+);/, 'batchLimit')[1]);
const keyFields = literal(need(knowledge, /const fields=(\{agenda_list:[^;]*\});\n/, 'requestKey fields')[1]);
const liveRule = need(knowledge, /r\.type\.startsWith\('browser_'\)\|\|(\[[^\]]*\])\.includes\(r\.type\)/, 'live rule');
const offsetTypes = literal(need(knowledge, /if\((\[[^\]]*\])\.includes\(r\.type\)\)r\.offset=Number\(r\.offset\?\?0\);/, 'offset normalization')[1]);
const queryTypes = literal(need(knowledge, /if\((\[[^\]]*\])\.includes\(r\.type\)\)r\.query=String/, 'query normalization')[1]);

// Text: single-quoted JS string literals on their own concatenation lines.
const quoted = (text, re, what) => literal(need(text, re, what)[1]);
const contextBatch = quoted(context, /\n   \+('工具批次：[^\n]*')\n/, 'context batch line');
const contextCatalog = quoted(context, /\n   \+('知识库按需读取[^\n]*')\n/, 'context catalog line');
const quickPanel = quoted(context, /const instructions=('原生灵动岛[^\n]*');\n/, 'quick panel instructions');
const appBatch = quoted(app, /instruction \+= ('\\n工具批次：[^\n]*');\n/, 'app batch');
const appKnowledge = quoted(app, /instruction \+= ('\\n你可按需继续访问本地知识库[^\n]*');\n/, 'app knowledge');
const appTerminal = quoted(app, /instruction \+= ('\\n本机终端：[^\n]*');\n/, 'app terminal');
const appDelegate = quoted(app, /instruction \+= ('\\n复杂研究可把[^\n]*');\n/, 'app delegate');

// Function sources, so tests can run the old code side by side with the new.
const between = (text, start, end, what) => { const i = text.indexOf(start); const j = text.indexOf(end, i); if (i < 0 || j < 0) throw Error('not found: ' + what); return text.slice(i, j); };
const functions = {
  safeRequest: between(scheduler, '  function safeRequest(request){', '  function resultSnapshot(value){', 'safeRequest'),
  requestKey: between(knowledge, ' function requestKey(request){', ' function checkedRequestKeys(requests){', 'requestKey'),
  pageNumber: need(knowledge, /\n( (?:const|function) pageNumber[^\n]*)\n/, 'pageNumber')[1],
  pdfCursor: need(knowledge, /\n( function pdfCursor[^\n]*)\n/, 'pdfCursor')[1],
  liveKey: need(knowledge, /(\(r\.type\.startsWith\('browser_'\)\|\|\['agenda_list','agenda_read'\]\.includes\(r\.type\)\))/, 'live key')[1],
};

process.stdout.write(JSON.stringify({
  source: { rev, extractedBy: 'scripts/extract-tool-legacy.cjs' },
  scheduler: { reads, viewOnly, labels, agendaFields: { agenda_list: agendaFields[0], agenda_read: agendaFields[1] }, quickPanelFields, genericFields },
  knowledge: { chunkableReads, batchLimit, keyFields, liveTypes: literal(liveRule[1]), livePrefix: 'browser_', offsetTypes, queryTypes },
  functions,
  text: { contextBatch, contextCatalog, quickPanel, appBatch, appKnowledge, appTerminal, appDelegate },
}, null, 2) + '\n');
