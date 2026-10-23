#!/usr/bin/env node
// Local MCP server for AI Bro tools (dev / stage-2 kernels). Read-only over a
// workspace snapshot; it never writes the workspace. Transports:
//   stdio (default): newline-delimited JSON-RPC on stdin/stdout.
//   --http <port>:   POST /mcp on 127.0.0.1 only, Bearer token required.
// Usage:
//   node scripts/aibro-mcp.cjs --state <dir/workspace.json> --ledger <calls.jsonl>
//        [--project <projectId>] [--workspace 日常|课程|科研] [--http <port>]
//        [--events <dir>]   also write tool/approval events (same layout as app/event_log.py)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const app = path.join(__dirname, '..', 'app');
const Tools = require(path.join(app, 'tool-specs.js'));
const Gateway = require(path.join(app, 'tool-gateway.js'));
const Mcp = require(path.join(app, 'mcp-server.js'));
const Events = require(path.join(app, 'event-log.js'));
const ReadTools = require(path.join(app, 'read-tools.js'));
const KnowledgeAccess = require(path.join(app, 'knowledge-access.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!/^--(state|ledger|project|workspace|http|events)$/.test(key) || argv[i + 1] === undefined) throw Error('unknown or incomplete option: ' + key);
    out[key.slice(2)] = argv[++i];
  }
  if (!out.state || !out.ledger) throw Error('--state and --ledger are required');
  return out;
}

// Append-only JSONL ledger. Each record is fsynced before the call proceeds,
// so a crash after "dispatched" leaves a record that blocks re-execution.
function fileLedger(file) {
  const rows = new Map();
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const { id, ...entry } = JSON.parse(line); rows.set(id, { ...rows.get(id), ...entry }); } catch { /* torn last line */ }
  }
  const append = (id, entry) => {
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ id, ...entry }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    rows.set(id, { ...rows.get(id), ...entry });
  };
  return {
    async get(id) { return rows.get(id) || null; },
    async dispatched(id, entry) { if (rows.has(id)) throw Error('call id already dispatched'); append(id, entry); },
    async settle(id, entry) { append(id, entry); },
  };
}

// Event log on disk, the same layout and seq rule as app/event_log.py:
// <dir>/runs/<yyyy-mm>/<runId>.jsonl. A stream continues across processes
// (the last seq is read back from the file); dispatch/decision/end events are
// fsynced before emit() resolves.
function fileEvents(dir, options = {}) {
  const last = new Map(), files = new Map();
  const fileFor = (runId, ts) => {
    if (files.has(runId)) return files.get(runId);
    const runs = path.join(dir, 'runs');
    let found = null;
    try { for (const month of fs.readdirSync(runs).sort()) if (fs.existsSync(path.join(runs, month, runId + '.jsonl'))) found = path.join(runs, month, runId + '.jsonl'); } catch {}
    const file = found || path.join(runs, new Date(ts).toISOString().slice(0, 7), runId + '.jsonl');
    files.set(runId, file);
    let seq = 0;
    try { const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); seq = JSON.parse(lines[lines.length - 1]).seq || 0; } catch {}
    last.set('run:' + runId, seq);
    return file;
  };
  const sink = async batch => {
    const byFile = new Map();
    for (const event of batch) {
      if (!event.runId || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(event.runId)) continue;
      const file = fileFor(event.runId, event.ts), prev = last.get(event.stream);
      if (event.seq !== prev + 1) throw Object.assign(Error('SEQ'), { code: 'SEQ', last: { [event.stream]: prev } });
      last.set(event.stream, event.seq);
      byFile.set(file, (byFile.get(file) || '') + JSON.stringify(event) + '\n');
    }
    for (const [file, text] of byFile) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeSync(fd, text); if (batch.some(e => Events.FSYNC.has(e.type))) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return { ok: true };
  };
  return Events.create({ sink, source: { kind: options.kind || 'external-kernel', id: options.source || 'mcp' }, onError: error => process.stderr.write('event log: ' + error.message + '\n') });
}

// Snapshot reader: reloads when the file changes; never writes it.
function snapshot(file) {
  let cached = null, stamp = '';
  return () => {
    const stat = fs.statSync(file), next = stat.mtimeMs + ':' + stat.size;
    if (next !== stamp) { const data = JSON.parse(fs.readFileSync(file, 'utf8')); cached = data.state && typeof data.state === 'object' ? data.state : data; stamp = next; }
    return cached;
  };
}

function nodeExecutor({ getState, scope }) {
  const modules = {
    AgentContext: require(path.join(app, 'agent-context.js')),
    ProjectAccess: require(path.join(app, 'project-access.js')),
    TaskContext: require(path.join(app, 'task-context.js')),
  };
  // No conversation is attached: history tools are not offered on this host.
  const conversation = { id: 'mcp-node', projectId: scope.projectId || null, workspace: scope.workspace || null, messages: [] };
  return async (name, args, { signal }) => {
    const state = getState();
    const run = { id: 'mcp-node', conversationId: conversation.id, projectId: scope.projectId || null, contextWorkspace: scope.workspace || null };
    const tools = ReadTools.create({
      run, conversation, scope, signal, getState: () => state, validate: () => {},
      lookup: key => modules[key], agentContext: () => null,
      fallback: request => KnowledgeAccess.execute(state, scope, request, { getState: () => state }),
    });
    // JSON round trip drops run-local symbols (read guards) from the receipt.
    return JSON.parse(JSON.stringify(await tools.execute({ type: name, ...args })));
  };
}

function createServer(options) {
  const getState = snapshot(options.state);
  const scope = { projectId: options.project || null, workspace: options.workspace || null, allowedTaskIds: [] };
  const session = crypto.randomBytes(6).toString('hex');
  const events = options.events ? fileEvents(options.events) : null;
  const gateway = Gateway.create({ registry: Tools.registry, host: 'node', execute: nodeExecutor({ getState, scope }), ledger: fileLedger(options.ledger), events, runId: 'mcp-' + session });
  return Mcp.create({ registry: Tools.registry, gateway, host: 'node', session, version: require('../package.json').version });
}

function serveStdio(server) {
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let message; try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
        const response = await server.handle(message);
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
      });
    }
  });
}

function serveHttp(server, port) {
  const http = require('node:http');
  const token = process.env.AIBRO_MCP_TOKEN || crypto.randomBytes(24).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const httpServer = http.createServer((request, response) => {
    const auth = Buffer.from(String(request.headers.authorization || ''));
    const authorized = auth.length === expected.length && crypto.timingSafeEqual(auth, expected);
    // Reject browser-originated requests outright (DNS rebinding, drive-by pages).
    if (request.headers.origin || !authorized || request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(request.headers.origin ? 403 : authorized ? 404 : 401).end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; if (body.length > 1 << 20) request.destroy(); });
    request.on('end', async () => {
      let message; try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      const result = await server.handle(message);
      if (!result) { response.writeHead(202).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
  });
  httpServer.listen(Number(port), '127.0.0.1', () => {
    process.stderr.write(`aibro-mcp listening on http://127.0.0.1:${httpServer.address().port}/mcp\n`);
    if (!process.env.AIBRO_MCP_TOKEN) process.stderr.write(`token: ${token}\n`);
  });
  return httpServer;
}

module.exports = { createServer, fileEvents, fileLedger, nodeExecutor, parseArgs, serveHttp, serveStdio, snapshot };
if (require.main === module) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(error.message + '\n'); process.exit(2); }
  const server = createServer(options);
  if (options.http !== undefined) serveHttp(server, options.http); else serveStdio(server);
}
